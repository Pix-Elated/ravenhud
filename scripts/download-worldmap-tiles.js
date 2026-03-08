/**
 * Download World Map Tiles
 *
 * Downloads all tiles from the ravenquest.tools CDN (Cloudflare R2)
 * for zoom levels 0-5, converts PNG → WebP via sharp, and saves them
 * to assets/images/worldmap/world/{z}/{x}/{y}.webp.
 *
 * Usage: node scripts/download-worldmap-tiles.js [--force]
 *   --force  Re-download tiles that already exist locally
 *
 * Source image: 8192 × 4608 px, tileSize = 256
 * maxNativeZoom = ceil(log2(max(8192, 4608) / 256)) = 5
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

const CDN_BASE = 'https://assets.ravenquest.tools/map';
const OUT_DIR = path.join(__dirname, '..', 'assets', 'images', 'worldmap', 'world');
const IMAGE_WIDTH = 8192;
const IMAGE_HEIGHT = 4608;
const TILE_SIZE = 256;
const MAX_NATIVE_ZOOM = 5;
const FORCE = process.argv.includes('--force');

// Concurrent download limit
const CONCURRENCY = 8;

/**
 * Calculate number of tiles at a given zoom level.
 * At zoom z, each tile covers (tileSize * 2^(maxZoom - z)) source pixels.
 */
function getTileCount(zoom) {
  const scale = Math.pow(2, MAX_NATIVE_ZOOM - zoom);
  const cols = Math.ceil(IMAGE_WIDTH / (TILE_SIZE * scale));
  const rows = Math.ceil(IMAGE_HEIGHT / (TILE_SIZE * scale));
  return { cols, rows };
}

/**
 * Download a single tile from CDN and convert to WebP.
 */
function downloadTile(z, x, y) {
  const url = `${CDN_BASE}/${z}/${x}/${y}.png`;
  const outDir = path.join(OUT_DIR, String(z), String(x));
  const outPath = path.join(outDir, `${y}.webp`);

  if (!FORCE && fs.existsSync(outPath)) {
    return Promise.resolve({ status: 'skipped', z, x, y });
  }

  fs.mkdirSync(outDir, { recursive: true });

  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain
          resolve({ status: 'missing', z, x, y, code: res.statusCode });
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          try {
            const pngBuffer = Buffer.concat(chunks);
            await sharp(pngBuffer).webp({ quality: 85 }).toFile(outPath);
            resolve({ status: 'ok', z, x, y });
          } catch (err) {
            resolve({ status: 'error', z, x, y, error: err.message });
          }
        });
      })
      .on('error', (err) => {
        resolve({ status: 'error', z, x, y, error: err.message });
      });
  });
}

/**
 * Process a queue of tasks with limited concurrency.
 */
async function processQueue(tasks, concurrency, onProgress) {
  let index = 0;
  let completed = 0;
  const results = [];

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      const result = await tasks[i]();
      results.push(result);
      completed++;
      if (onProgress) onProgress(completed, tasks.length, result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log('=== World Map Tile Downloader ===\n');
  console.log(`Source:    ${CDN_BASE}/{z}/{x}/{y}.png`);
  console.log(`Output:    ${OUT_DIR}/{z}/{x}/{y}.webp`);
  console.log(`Image:     ${IMAGE_WIDTH} × ${IMAGE_HEIGHT} px`);
  console.log(`Zoom:      0 – ${MAX_NATIVE_ZOOM}`);
  console.log(`Force:     ${FORCE}\n`);

  // Build task list
  const tasks = [];
  for (let z = 0; z <= MAX_NATIVE_ZOOM; z++) {
    const { cols, rows } = getTileCount(z);
    console.log(`  Zoom ${z}: ${cols} × ${rows} = ${cols * rows} tiles`);
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        tasks.push(() => downloadTile(z, x, y));
      }
    }
  }

  console.log(`\nTotal tiles to process: ${tasks.length}\n`);

  const stats = { ok: 0, skipped: 0, missing: 0, error: 0 };

  const results = await processQueue(tasks, CONCURRENCY, (done, total, result) => {
    stats[result.status]++;
    if (done % 50 === 0 || done === total) {
      const pct = Math.round((done / total) * 100);
      process.stdout.write(`\r  Progress: ${done}/${total} (${pct}%) — ${stats.ok} downloaded, ${stats.skipped} skipped, ${stats.missing} missing`);
    }
  });

  console.log('\n');
  console.log('=== Results ===');
  console.log(`  Downloaded: ${stats.ok}`);
  console.log(`  Skipped:    ${stats.skipped}`);
  console.log(`  Missing:    ${stats.missing}`);
  console.log(`  Errors:     ${stats.error}`);

  if (stats.error > 0) {
    console.log('\nErrors:');
    results
      .filter((r) => r.status === 'error')
      .forEach((r) => console.log(`  z=${r.z} x=${r.x} y=${r.y}: ${r.error}`));
  }

  console.log('\nDone. Run `node scripts/create-archives.js` to rebuild archives.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
