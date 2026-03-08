/**
 * RavenCard Image Adapter
 *
 * Downloads creature images for RavenCards from two sources:
 *   1. Ravendawn CDN — URLs stored in data/ravencards.json `image` field
 *   2. Immutable blockchain metadata — fallback for cards without CDN URLs
 *
 * Each card image is saved as: assets/images/ravencards/{snake_name}.webp
 * This matches what portfolio-service.ts buildNftImageLookup() expects.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { downloadBuffer, sleep } = require('../download');
const { toWebP, ensureWebP } = require('../convert');
const { nameToSnakeCase, processQueue, logProgress } = require('../utils');
const { createLogger } = require('../logger');

const log = createLogger('[ravencards]');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const DATA_FILE = path.join(PROJECT_ROOT, 'data', 'ravencards.json');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'assets', 'images', 'ravencards');
const CONCURRENCY = 5;
const INTER_BATCH_DELAY_MS = 100;

// Immutable zkEVM RavenCards collection contract
const RAVENCARDS_CONTRACT = '0xb254d62afe0432214db60c457a4d751c655cfbde';
const CHAIN = 'imtbl-zkevm-mainnet';
const IMX_API_BASE = `https://api.immutable.com/v1/chains/${CHAIN}/collections/${RAVENCARDS_CONTRACT}/nfts`;
const PAGE_SIZE = 200;

/**
 * Fetch a page of NFTs from the Immutable API for the RavenCards collection.
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
 * Run the ravencard image sync.
 *
 * @param {object} options
 * @param {boolean} [options.dryRun=false] - Report gaps without downloading
 * @param {number} [options.limit=0] - Max downloads (0 = unlimited)
 * @param {boolean} [options.fixExisting=false] - Re-convert JPG-as-WebP files
 * @returns {Promise<{checked: number, downloaded: number, skipped: number, failed: number, fixed: number}>}
 */
async function run(options = {}) {
  const { dryRun = false, limit = 0, fixExisting = false } = options;
  const stats = { checked: 0, downloaded: 0, skipped: 0, failed: 0, fixed: 0 };

  // Load card data
  if (!fs.existsSync(DATA_FILE)) {
    log.error('data/ravencards.json not found');
    log.error('Run the app first to populate ravencards data.');
    return stats;
  }

  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const cards = raw.data || [];
  stats.checked = cards.length;

  log.info(`${cards.length} cards in data`);

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Phase 1: Fix existing mis-converted files (JPG saved as .webp)
  if (fixExisting && !dryRun) {
    log.info('Checking existing files for format issues...');
    const existing = fs.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith('.webp'));

    let fixCount = 0;
    for (const file of existing) {
      const filePath = path.join(OUTPUT_DIR, file);
      const converted = await ensureWebP(filePath);
      if (converted) fixCount++;
    }

    stats.fixed = fixCount;
    if (fixCount > 0) {
      log.info(`Fixed ${fixCount} files (JPG -> real WebP)`);
    } else {
      log.info(`All ${existing.length} existing files are already WebP`);
    }
  }

  // Phase 2: Find missing cards — separate CDN-available from no-URL
  const missingWithUrl = [];
  const missingNoUrl = [];

  for (const card of cards) {
    const snakeName = nameToSnakeCase(card.name);
    const outPath = path.join(OUTPUT_DIR, `${snakeName}.webp`);

    if (fs.existsSync(outPath)) {
      stats.skipped++;
      continue;
    }

    if (card.image) {
      missingWithUrl.push({ name: card.name, snakeName, imageUrl: card.image, outPath });
    } else {
      missingNoUrl.push({ name: card.name, snakeName, outPath });
    }
  }

  const totalMissing = missingWithUrl.length + missingNoUrl.length;
  log.info(
    `${totalMissing} missing (${missingWithUrl.length} with CDN URL, ${missingNoUrl.length} need Immutable), ${stats.skipped} already exist`
  );

  if (dryRun || totalMissing === 0) {
    return stats;
  }

  // Phase 3: Download cards that have CDN URLs
  if (missingWithUrl.length > 0) {
    const batch = limit > 0 ? missingWithUrl.slice(0, limit) : missingWithUrl;
    let completed = 0;

    log.info(`Downloading ${batch.length} from CDN...`);

    await processQueue(batch, CONCURRENCY, async (card) => {
      try {
        const buffer = await downloadBuffer(card.imageUrl);
        await toWebP(buffer, card.outPath);
        stats.downloaded++;
      } catch (err) {
        log.error(`FAIL (CDN): ${card.name} — ${err.message}`);
        stats.failed++;
      }

      completed++;
      logProgress('ravencards', completed, batch.length, '(CDN)');
      await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
    });
  }

  // Phase 4: Try Immutable blockchain metadata for cards without CDN URLs
  if (missingNoUrl.length > 0) {
    log.info(`Fetching ${missingNoUrl.length} card images from Immutable API...`);

    // Build a set of snake_names we still need
    const neededNames = new Map();
    for (const card of missingNoUrl) {
      // Check if it wasn't already downloaded in Phase 3 or already exists
      if (!fs.existsSync(card.outPath)) {
        neededNames.set(card.snakeName, card);
      }
    }

    if (neededNames.size > 0) {
      // Try reading from pre-scraped blockchain metadata first (instant)
      const blockchainFile = path.join(PROJECT_ROOT, 'data', 'blockchain', 'ravencards.json');
      const toDownload = [];
      let usedCache = false;

      if (fs.existsSync(blockchainFile)) {
        try {
          const cached = JSON.parse(fs.readFileSync(blockchainFile, 'utf8'));
          const types = cached.types || [];

          if (types.length > 0) {
            log.info(`Using blockchain cache (${types.length} types)`);

            for (const type of types) {
              if (!type.nameNormalized || !type.image) continue;

              const card = neededNames.get(type.nameNormalized);
              if (card) {
                toDownload.push({ ...card, imageUrl: type.image });
                neededNames.delete(type.nameNormalized);
              }
            }

            usedCache = true;
            log.info(
              `Matched ${toDownload.length} from cache, ${neededNames.size} still unresolved`
            );
          }
        } catch (err) {
          log.error(`Failed to read blockchain cache: ${err.message}`);
        }
      }

      // Fallback: paginate the Immutable API directly if no cache
      if (!usedCache) {
        const seenNames = new Set();
        let cursor = null;
        let pageNum = 0;

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

              // Skip duplicates (stacked collection)
              if (seenNames.has(normalized)) continue;
              seenNames.add(normalized);

              // Check if this is one we need
              const card = neededNames.get(normalized);
              if (card) {
                toDownload.push({ ...card, imageUrl });
                neededNames.delete(normalized);
              }
            }

            cursor = response.page?.next_cursor || null;

            // Stop if we found everything
            if (neededNames.size === 0) break;

            if (cursor) await sleep(500);
          } catch (err) {
            log.error(`Immutable API error on page ${pageNum + 1}: ${err.message}`);
            break;
          }
        } while (cursor);
      }

      // Download what we found
      if (toDownload.length > 0) {
        const remaining = limit > 0 ? limit - stats.downloaded : Infinity;
        const batch = toDownload.slice(0, Math.max(0, remaining));
        let completed = 0;

        log.info(`Downloading ${batch.length} from Immutable...`);

        await processQueue(batch, CONCURRENCY, async (card) => {
          try {
            const buffer = await downloadBuffer(card.imageUrl);
            await toWebP(buffer, card.outPath);
            stats.downloaded++;
          } catch (err) {
            log.error(`FAIL (Immutable): ${card.name} — ${err.message}`);
            stats.failed++;
          }

          completed++;
          logProgress('ravencards', completed, batch.length, '(Immutable)');
          await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
        });
      }

      // Report any still-missing
      if (neededNames.size > 0) {
        log.info(`${neededNames.size} cards not found on Immutable either`);
      }
    }
  }

  return stats;
}

module.exports = { run };
