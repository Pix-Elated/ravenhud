/**
 * Moa Image Adapter
 *
 * Downloads Moa PFP images from the Immutable zkEVM blockchain metadata.
 * Many moa tokens share the same visual image despite having unique names.
 *
 * Strategy:
 *   1. Load pre-scraped metadata from data/blockchain/moas.json (if available)
 *   2. Fall back to paginating the Immutable API for any missing tokens
 *   3. Download and convert all unique images to WebP
 *   4. Content-hash dedup: keep one canonical file per unique image,
 *      map all duplicate names via _dedup-map.json
 *
 * Output:
 *   assets/images/moas/{name_normalized}.webp  — canonical images (one per unique visual)
 *   assets/images/moas/_dedup-map.json          — alias → canonical name mapping
 *
 * portfolio-service.ts buildNftImageLookup() reads _dedup-map.json to resolve
 * any moa token name to its canonical image file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { downloadBuffer, sleep } = require('../download');
const { toWebP } = require('../convert');
const { nameToSnakeCase, processQueue, logProgress } = require('../utils');
const { createLogger } = require('../logger');

const log = createLogger('[moas]');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const BLOCKCHAIN_FILE = path.join(PROJECT_ROOT, 'data', 'blockchain', 'moas.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'assets', 'images', 'moas');
const DEDUP_MAP_FILE = path.join(OUTPUT_DIR, '_dedup-map.json');
const CONCURRENCY = 3;

// Immutable zkEVM Moas collection contract
const MOAS_CONTRACT = '0xb43b3eb53a09abef18eed9d9901a7df1bd3f327a';
const CHAIN = 'imtbl-zkevm-mainnet';
const IMX_API_BASE = `https://api.immutable.com/v1/chains/${CHAIN}/collections/${MOAS_CONTRACT}/nfts`;
const PAGE_SIZE = 200;

/**
 * MD5 hash a buffer and return hex string.
 * MD5 is fine here — this is content dedup, not security.
 */
function hashBuffer(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * Load dedup map from disk. Returns {} if file doesn't exist.
 */
function loadDedupMap() {
  try {
    if (fs.existsSync(DEDUP_MAP_FILE)) {
      return JSON.parse(fs.readFileSync(DEDUP_MAP_FILE, 'utf8'));
    }
  } catch {
    /* corrupted map — start fresh */
  }
  return {};
}

/**
 * Fetch a page of NFTs from the Immutable API for the Moas collection.
 */
function fetchNFTPage(cursor) {
  return new Promise((resolve, reject) => {
    let url = `${IMX_API_BASE}?page_size=${PAGE_SIZE}`;
    if (cursor) url += `&page_cursor=${encodeURIComponent(cursor)}`;

    https
      .get(
        url,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'RavenHUD-ImageSync/1.0'
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(
                new Error(`Immutable API returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`)
              );
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Failed to parse Immutable API response: ${err.message}`));
            }
          });
          res.on('error', reject);
        }
      )
      .on('error', reject);
  });
}

/**
 * Run the moa image sync with content-hash deduplication.
 *
 * @param {object} options
 * @param {boolean} [options.dryRun=false] - Report gaps without downloading
 * @param {number} [options.limit=0] - Max downloads (0 = unlimited)
 * @returns {Promise<{checked: number, downloaded: number, skipped: number, failed: number, deduped: number}>}
 */
async function run(options = {}) {
  const { dryRun = false, limit = 0 } = options;
  const stats = { checked: 0, downloaded: 0, skipped: 0, failed: 0, deduped: 0 };

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Load existing dedup map — alias names count as "existing" (no re-download needed)
  const dedupMap = loadDedupMap();

  // Build "existing" set: names with actual files on disk OR in the dedup map
  const filesOnDisk = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('.webp'))
    .map((f) => f.replace('.webp', ''));

  // Validate dedup map: remove entries whose canonical file no longer exists
  const fileSet = new Set(filesOnDisk);
  let staleEntries = 0;
  for (const [alias, canonical] of Object.entries(dedupMap)) {
    if (!fileSet.has(canonical)) {
      delete dedupMap[alias];
      staleEntries++;
    }
  }
  if (staleEntries > 0) {
    log.info(`Cleaned ${staleEntries} stale dedup entries`);
  }

  const existing = new Set([...filesOnDisk, ...Object.keys(dedupMap)]);

  // Collect tokens to download: { nameNormalized, imageUrl, outPath }
  const toDownload = [];

  // Phase 1: Try pre-scraped blockchain metadata (instant, no API calls)
  if (fs.existsSync(BLOCKCHAIN_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(BLOCKCHAIN_FILE, 'utf8'));
      const tokens = cached.sampleTokens || [];
      log.info(`Blockchain cache: ${tokens.length} tokens`);

      for (const token of tokens) {
        if (!token.nameNormalized || !token.image) continue;
        stats.checked++;

        if (existing.has(token.nameNormalized)) {
          stats.skipped++;
          continue;
        }

        toDownload.push({
          nameNormalized: token.nameNormalized,
          imageUrl: token.image,
          outPath: path.join(OUTPUT_DIR, `${token.nameNormalized}.webp`)
        });
      }

      log.info(`From cache: ${toDownload.length} to download, ${stats.skipped} already exist`);
    } catch (err) {
      log.error(`Failed to read blockchain cache: ${err.message}`);
    }
  } else {
    log.info('No blockchain cache — will fetch from Immutable API');
  }

  // Phase 2: Paginate the Immutable API for tokens not covered by cache
  const cachedNames = new Set(toDownload.map((t) => t.nameNormalized));
  let cursor = null;
  let pageNum = 0;
  let apiNewCount = 0;

  log.info('Fetching ALL tokens from Immutable API...');

  do {
    try {
      const response = await fetchNFTPage(cursor);
      const nfts = response.result || [];
      pageNum++;

      for (const nft of nfts) {
        const name = nft.name || nft.metadata?.name;
        const imageUrl = nft.image || nft.metadata?.image;
        if (!name || !imageUrl) continue;

        const normalized = nameToSnakeCase(name);
        stats.checked++;

        // Skip if already in cache batch or already on disk/dedup map
        if (cachedNames.has(normalized) || existing.has(normalized)) {
          if (existing.has(normalized) && !cachedNames.has(normalized)) {
            stats.skipped++;
          }
          continue;
        }

        cachedNames.add(normalized);
        toDownload.push({
          nameNormalized: normalized,
          imageUrl,
          outPath: path.join(OUTPUT_DIR, `${normalized}.webp`)
        });
        apiNewCount++;
      }

      log.info(`Page ${pageNum}: ${nfts.length} tokens, ${apiNewCount} new from API`);

      cursor = response.page?.next_cursor || null;
      if (cursor) await sleep(500);
    } catch (err) {
      log.error(`API error on page ${pageNum + 1}: ${err.message}`);
      break;
    }
  } while (cursor);

  log.info(`Total: ${toDownload.length} to download, ${stats.skipped} already exist`);

  if (dryRun) {
    return stats;
  }

  // Phase 3: Download new images
  if (toDownload.length > 0) {
    const batch = limit > 0 ? toDownload.slice(0, limit) : toDownload;
    let completed = 0;

    log.info(`Downloading ${batch.length} images...`);

    await processQueue(batch, CONCURRENCY, async (item) => {
      try {
        const buffer = await downloadBuffer(item.imageUrl);
        await toWebP(buffer, item.outPath);
        stats.downloaded++;
      } catch (err) {
        log.error(`FAIL: ${item.nameNormalized} — ${err.message}`);
        stats.failed++;
      }

      completed++;
      logProgress('moas', completed, batch.length);
    });
  }

  // Phase 4: Content-hash dedup across ALL files on disk
  // Hash every .webp file, group by hash, keep one canonical per group,
  // delete duplicates, and write _dedup-map.json for portfolio-service.
  log.info('Running content-hash dedup...');

  const allFiles = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('.webp'))
    .map((f) => f.replace('.webp', ''));

  // Hash all files → group by content hash
  const hashGroups = new Map(); // hash → [name, name, ...]
  for (const name of allFiles) {
    const filePath = path.join(OUTPUT_DIR, `${name}.webp`);
    const buffer = fs.readFileSync(filePath);
    const hash = hashBuffer(buffer);
    if (!hashGroups.has(hash)) {
      hashGroups.set(hash, []);
    }
    hashGroups.get(hash).push(name);
  }

  // For each group with >1 file: keep first alphabetically, delete rest
  let removedCount = 0;
  for (const [, names] of hashGroups) {
    if (names.length <= 1) continue;
    names.sort();
    const canonical = names[0];
    for (let i = 1; i < names.length; i++) {
      dedupMap[names[i]] = canonical;
      fs.unlinkSync(path.join(OUTPUT_DIR, `${names[i]}.webp`));
      removedCount++;
    }
  }

  stats.deduped = removedCount;

  // Write dedup map (even if empty — signals that dedup has run)
  fs.writeFileSync(DEDUP_MAP_FILE, JSON.stringify(dedupMap, null, 2));

  const uniqueCount = hashGroups.size;
  const aliasCount = Object.keys(dedupMap).length;
  log.info(
    `Dedup: ${uniqueCount} unique images, ${aliasCount} aliases, ${removedCount} files removed`
  );

  return stats;
}

module.exports = { run };
