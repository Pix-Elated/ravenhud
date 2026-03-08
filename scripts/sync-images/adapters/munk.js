/**
 * Munk Image Adapter
 *
 * Downloads Munk PFP images from the Immutable zkEVM blockchain metadata.
 * Munks are unique 1:1 NFTs — every token has a different image.
 *
 * Strategy:
 *   1. Load pre-scraped metadata from data/blockchain/munks.json (if available)
 *   2. Fall back to paginating the Immutable API for any missing tokens
 *   3. Download and convert all unique images to WebP
 *
 * Output: assets/images/munks/{name_normalized}.webp
 * This matches what portfolio-service.ts buildNftImageLookup() expects.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { downloadBuffer, sleep } = require('../download');
const { toWebP } = require('../convert');
const { nameToSnakeCase, processQueue, logProgress } = require('../utils');
const { createLogger } = require('../logger');

const log = createLogger('[munks]');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const BLOCKCHAIN_FILE = path.join(PROJECT_ROOT, 'data', 'blockchain', 'munks.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'assets', 'images', 'munks');
const DEDUP_MAP_FILE = path.join(OUTPUT_DIR, '_dedup-map.json');
const CONCURRENCY = 3;

/**
 * MD5 hash a buffer and return hex string.
 * MD5 is fine here — this is content dedup, not security.
 */
function hashBuffer(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// Immutable zkEVM Munks collection contract
const MUNKS_CONTRACT = '0x024720ccabf02a002c279b0e84b62b572cfeeaa0';
const CHAIN = 'imtbl-zkevm-mainnet';
const IMX_API_BASE = `https://api.immutable.com/v1/chains/${CHAIN}/collections/${MUNKS_CONTRACT}/nfts`;
const PAGE_SIZE = 200;

/**
 * Fetch a page of NFTs from the Immutable API for the Munks collection.
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
 * Run the munk image sync.
 *
 * @param {object} options
 * @param {boolean} [options.dryRun=false] - Report gaps without downloading
 * @param {number} [options.limit=0] - Max downloads (0 = unlimited)
 * @returns {Promise<{checked: number, downloaded: number, skipped: number, failed: number}>}
 */
async function run(options = {}) {
  const { dryRun = false, limit = 0 } = options;
  const stats = { checked: 0, downloaded: 0, skipped: 0, failed: 0 };

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Get existing images to skip
  const existing = new Set(
    fs.existsSync(OUTPUT_DIR)
      ? fs
          .readdirSync(OUTPUT_DIR)
          .filter((f) => f.endsWith('.webp'))
          .map((f) => f.replace('.webp', ''))
      : []
  );

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
  // Munks are unique PFPs — we want ALL tokens, not just a sample
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

        // Skip if already in cache batch or already on disk
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

  if (dryRun || toDownload.length === 0) {
    return stats;
  }

  // Phase 3: Download
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
    logProgress('munks', completed, batch.length);
  });

  // Phase 4: Content-hash dedup across ALL files on disk
  // Hash every .webp file, group by hash, keep one canonical per group,
  // delete duplicates, and write _dedup-map.json for portfolio-service.
  log.info('Running content-hash dedup...');

  // Load existing dedup map (preserves aliases from previous runs for files
  // that may no longer be on disk)
  const dedupMap = {};

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
