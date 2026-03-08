/**
 * Create Archives
 *
 * Zips bulk image directories into assets/ for distribution.
 * Individual images are gitignored — only the archives are committed.
 *
 * Usage: node scripts/create-archives.js [--images-only] [--data-only]
 *        npm run create-archives
 *
 * Each image subdirectory becomes its own zip (e.g. images-munks.zip).
 * If a zip exceeds MAX_ARCHIVE_MB (95 MB) it is split into numbered parts.
 *
 * data.zip is also managed by marker-submissions.yml. When --images-only
 * is used, the existing data.zip entry in assets-manifest.json is preserved.
 *
 * assets-manifest.json includes SHA-256 hashes so the app can detect changes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(ROOT, 'assets', 'images');
const DATA_DIR = path.join(ROOT, 'data');
const ARCHIVES_DIR = path.join(ROOT, 'assets');

// GitHub rejects files >100 MB; 95 MB gives a 5% safety margin
const MAX_ARCHIVE_MB = 95;

// Image subdirectories to archive (each becomes images-{name}.zip)
const IMAGE_DIRS = [
  'cosmetics',
  'creatures',
  'currency',
  'equipment',
  'items',
  'land',
  'materials',
  'menu',
  'moas',
  'munks',
  'ravencards',
  'ravenguardian',
  'spells',
  'tokens',
  'tradepacks',
  'trophies',
  'worldmap'
];

/**
 * Compute SHA-256 hash of a file. Returns "sha256:{hex}" string.
 */
function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  const hex = crypto.createHash('sha256').update(data).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Recursively add all files in a directory to a zip, preserving relative paths.
 */
function addDirToZip(zip, dirPath, baseDir) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      addDirToZip(zip, fullPath, baseDir);
    } else {
      zip.addLocalFile(fullPath, path.dirname(relativePath));
    }
  }
}

/**
 * Recursively collect all files in a directory with their relative paths.
 * Used by the splitting logic to enumerate files before distributing them.
 */
function collectFiles(dirPath, baseDir, out) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, out);
    } else {
      out.push({
        fullPath,
        relativePath: path.relative(baseDir, fullPath)
      });
    }
  }
}

/**
 * Create zip archive(s) for an image subdirectory.
 *
 * Returns an array of archive result objects. Usually one element, but if the
 * single zip exceeds MAX_ARCHIVE_MB it is split into numbered parts so every
 * file stays under GitHub's 100 MB limit.
 */
function createImageArchive(dirName) {
  const dirPath = path.join(IMAGES_DIR, dirName);
  if (!fs.existsSync(dirPath)) {
    console.log(`  SKIP ${dirName}/ (not found)`);
    return [];
  }

  const zip = new AdmZip();
  addDirToZip(zip, dirPath, dirPath);

  const entryCount = zip.getEntries().length;
  if (entryCount === 0) {
    console.log(`  SKIP ${dirName}/ (empty)`);
    return [];
  }

  // Remove previous archives for this category (single or split) so stale
  // files don't linger when a category transitions between single/split.
  const stalePattern = new RegExp(`^images-${dirName}(-part\\d+)?\\.zip$`);
  for (const file of fs.readdirSync(ARCHIVES_DIR)) {
    if (stalePattern.test(file)) {
      fs.unlinkSync(path.join(ARCHIVES_DIR, file));
    }
  }

  const outPath = path.join(ARCHIVES_DIR, `images-${dirName}.zip`);
  zip.writeZip(outPath);

  const sizeBytes = fs.statSync(outPath).size;
  const sizeMB = sizeBytes / (1024 * 1024);

  // Under the limit — return as a single archive
  if (sizeMB <= MAX_ARCHIVE_MB) {
    const rounded = parseFloat(sizeMB.toFixed(1));
    console.log(`  images-${dirName}.zip — ${entryCount} files, ${rounded} MB`);
    return [{ name: `images-${dirName}.zip`, files: entryCount, sizeMB: rounded }];
  }

  // Over the limit — split into parts
  console.log(
    `  images-${dirName}.zip is ${sizeMB.toFixed(1)} MB (exceeds ${MAX_ARCHIVE_MB} MB) — splitting...`
  );
  fs.unlinkSync(outPath);

  // Collect and sort files for deterministic, reproducible splits
  const allFiles = [];
  collectFiles(dirPath, dirPath, allFiles);
  allFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const numParts = Math.ceil(sizeMB / MAX_ARCHIVE_MB);
  const filesPerPart = Math.ceil(allFiles.length / numParts);
  const results = [];

  for (let part = 0; part < numParts; part++) {
    const partFiles = allFiles.slice(part * filesPerPart, (part + 1) * filesPerPart);
    if (partFiles.length === 0) continue;

    const partZip = new AdmZip();
    for (const file of partFiles) {
      partZip.addLocalFile(file.fullPath, path.dirname(file.relativePath));
    }

    const partName = `images-${dirName}-part${part + 1}.zip`;
    const partPath = path.join(ARCHIVES_DIR, partName);
    partZip.writeZip(partPath);

    const partMB = parseFloat((fs.statSync(partPath).size / (1024 * 1024)).toFixed(1));
    console.log(`  ${partName} — ${partFiles.length} files, ${partMB} MB`);
    results.push({ name: partName, files: partFiles.length, sizeMB: partMB });
  }

  return results;
}

// Directories/patterns to exclude from data.zip (dev-only, not used at runtime)
const DATA_EXCLUDE = ['.api-cache', 'temp', 'scripts', 'blockchain', 'scraped'];
const DATA_EXCLUDE_PREFIXES = ['ULTIMATE'];

/**
 * Check if a directory entry should be excluded from data.zip.
 */
function isDataExcluded(name) {
  if (DATA_EXCLUDE.includes(name)) return true;
  if (DATA_EXCLUDE_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (name.endsWith('.html')) return true;
  return false;
}

function createDataArchive() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('  SKIP data/ (not found)');
    return null;
  }

  const zip = new AdmZip();

  // Recursively add all data files, excluding caches and temp dirs
  const allFiles = [];
  collectDataFiles(DATA_DIR, DATA_DIR, allFiles);

  if (allFiles.length === 0) {
    console.log('  SKIP data/ (no files)');
    return null;
  }

  for (const file of allFiles) {
    zip.addLocalFile(file.fullPath, path.dirname(file.relativePath) || undefined);
  }

  const outPath = path.join(ARCHIVES_DIR, 'data.zip');
  zip.writeZip(outPath);

  const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
  console.log(`  data.zip — ${allFiles.length} files, ${sizeMB} MB`);

  return { name: 'data.zip', files: allFiles.length, sizeMB: parseFloat(sizeMB) };
}

/**
 * Recursively collect files from the data directory, respecting exclusions.
 */
function collectDataFiles(dirPath, baseDir, out) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (isDataExcluded(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectDataFiles(fullPath, baseDir, out);
    } else {
      out.push({
        fullPath,
        relativePath: path.relative(baseDir, fullPath)
      });
    }
  }
}

/**
 * Create/update assets-manifest.json with SHA-256 hashes.
 * When updating only images, preserves the existing data.zip entry.
 * When updating only data, preserves existing image entries.
 */
function createAssetsManifest(newArchives, preserveTypes) {
  console.log('\nUpdating assets-manifest.json...');

  const manifestPath = path.join(ARCHIVES_DIR, 'assets-manifest.json');

  // Load existing manifest to preserve entries we're not rebuilding
  let preserved = [];
  if (preserveTypes.length > 0 && fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    preserved = existing.archives.filter((a) =>
      preserveTypes.some((type) => type === 'data' ? a.name === 'data.zip' : a.name.startsWith('images-'))
    );
    for (const p of preserved) {
      console.log(`  ${p.name} → preserved (${p.hash.slice(0, 20)}...)`);
    }
  }

  // Hash newly built archives
  const newEntries = [];
  for (const archive of newArchives) {
    const zipPath = path.join(ARCHIVES_DIR, archive.name);
    const hash = hashFile(zipPath);
    newEntries.push({
      name: archive.name,
      hash,
      files: archive.files,
      sizeMB: archive.sizeMB
    });
    console.log(`  ${archive.name} → ${hash.slice(0, 20)}...`);
  }

  const allEntries = [...newEntries, ...preserved];
  const manifest = {
    generatedAt: new Date().toISOString(),
    archives: allEntries
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`assets-manifest.json written (${allEntries.length} archives)`);

  return manifest;
}

function main() {
  const imagesOnly = process.argv.includes('--images-only');
  const dataOnly = process.argv.includes('--data-only');

  if (imagesOnly) {
    console.log('Rebuilding image archives only (preserving data.zip)...\n');
  } else if (dataOnly) {
    console.log('Rebuilding data archive only (preserving image archives)...\n');
  } else {
    console.log('Creating all archives...\n');
  }

  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });

  const imageArchives = [];

  if (!dataOnly) {
    for (const dirName of IMAGE_DIRS) {
      const results = createImageArchive(dirName);
      imageArchives.push(...results);
    }
  }

  let dataResult = null;
  if (!imagesOnly) {
    dataResult = createDataArchive();
  }

  // Determine which archive types to preserve from existing manifest
  const preserveTypes = [];
  if (imagesOnly) preserveTypes.push('data');
  if (dataOnly) preserveTypes.push('images');

  // Build manifest entries for newly created archives
  const newArchives = [...imageArchives];
  if (dataResult) newArchives.push(dataResult);

  createAssetsManifest(newArchives, preserveTypes);

  const totalCount = newArchives.length;
  const totalFiles = newArchives.reduce((sum, a) => sum + a.files, 0);
  const totalMB = newArchives.reduce((sum, a) => sum + a.sizeMB, 0).toFixed(1);

  console.log(`\nDone: ${totalCount} archives rebuilt, ${totalFiles} files, ${totalMB} MB`);
}

main();
