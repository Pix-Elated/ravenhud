/**
 * Cosmetic Image Adapter — Immutable Blockchain
 *
 * Downloads cosmetic NFT images from the Immutable zkEVM blockchain metadata API.
 * Covers: ships, moas, wagons, and some house decorations (~75 NFT types).
 *
 * Other cosmetic sources are separate adapters:
 *   - ravenguardian.js — outfits, pets, house decorations from RavenGuardian CDN
 *   - item.js — dual-routes game API items that also match cosmetics
 *
 * Output: assets/images/cosmetics/{folder}/{cosmetic_id}.webp
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { downloadBuffer, sleep } = require('../download');
const { toWebP } = require('../convert');
const { nameToSnakeCase, getCategoryFolder, processQueue, logProgress } = require('../utils');
const { createLogger } = require('../logger');

const log = createLogger('[cosmetics]');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const COSMETICS_FILE = path.join(PROJECT_ROOT, 'data', 'cosmetics.json');
const OUTPUT_BASE = path.join(PROJECT_ROOT, 'assets', 'images', 'cosmetics');

// Immutable zkEVM cosmetics collection contract
const COSMETICS_CONTRACT = '0x924904fbcd172b79261307063518d12310ab1bb8';
const CHAIN = 'imtbl-zkevm-mainnet';

// Immutable API endpoint for listing NFTs in a collection
// We use the list-nfts endpoint with pagination to get unique metadata
const API_BASE = `https://api.immutable.com/v1/chains/${CHAIN}/collections/${COSMETICS_CONTRACT}/nfts`;

const DOWNLOAD_CONCURRENCY = 3;
const PAGE_SIZE = 200;
const INTER_PAGE_DELAY_MS = 500;

// Immutable Hub publishable key — raises rate limit from 5 req/s to 50 req/s
const IMMUTABLE_PUBLISHABLE_KEY = 'pk_imapik-a2QXnS4pHeR9xTXN1pwY';

/**
 * Manual overrides for blockchain names that don't normalize cleanly.
 * Add entries here when NFT names on Immutable don't match cosmetics.json IDs.
 * Format: 'normalized_blockchain_name': 'cosmetics_json_id'
 */
const NAME_OVERRIDES = {};

/**
 * Fetch a page of NFTs from the Immutable API.
 * Returns { result: [...], page: { next_cursor } }
 */
function fetchNFTPage(cursor) {
  return new Promise((resolve, reject) => {
    let url = `${API_BASE}?page_size=${PAGE_SIZE}`;
    if (cursor) url += `&page_cursor=${encodeURIComponent(cursor)}`;

    https
      .get(
        url,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'RavenHUD-ImageSync/1.0',
            'x-immutable-publishable-key': IMMUTABLE_PUBLISHABLE_KEY
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
 * Run the cosmetic image sync.
 *
 * @param {object} options
 * @param {boolean} [options.dryRun=false]
 * @param {number} [options.limit=0] - Max downloads (0 = unlimited)
 * @returns {Promise<{checked: number, downloaded: number, skipped: number, failed: number, unmatched: string[]}>}
 */
async function run(options = {}) {
  const { dryRun = false, limit = 0 } = options;
  const stats = { checked: 0, downloaded: 0, skipped: 0, failed: 0, unmatched: [] };

  // Load cosmetics data
  if (!fs.existsSync(COSMETICS_FILE)) {
    log.error('data/cosmetics.json not found');
    return stats;
  }

  const raw = JSON.parse(fs.readFileSync(COSMETICS_FILE, 'utf8'));
  // Handle both { items: [...] } wrapper and plain array formats
  const cosmetics = Array.isArray(raw) ? raw : raw.items || [];
  stats.checked = cosmetics.length;
  log.info(`${cosmetics.length} cosmetics in data`);

  // Build lookup maps
  // nameToId: normalized name → cosmetic ID
  // idToFolder: cosmetic ID → asset folder name
  const nameToId = new Map();
  const idToFolder = new Map();
  const neededIds = new Set();

  for (const cosmetic of cosmetics) {
    const normalized = nameToSnakeCase(cosmetic.name);
    nameToId.set(normalized, cosmetic.id);

    const folder = getCategoryFolder(cosmetic.category?.level1);
    if (folder) {
      idToFolder.set(cosmetic.id, folder);
    }

    // Check if we already have this image
    if (folder) {
      const imgPath = path.join(OUTPUT_BASE, folder, `${cosmetic.id}.webp`);
      if (fs.existsSync(imgPath)) {
        stats.skipped++;
      } else {
        neededIds.add(cosmetic.id);
      }
    }
  }

  log.info(`${neededIds.size} missing, ${stats.skipped} already exist`);

  if (dryRun || neededIds.size === 0) {
    return stats;
  }

  // Collect images to download — try blockchain cache first, then fall back to API
  const toDownload = [];

  // Try reading from pre-scraped blockchain metadata (instant, no API calls)
  const blockchainFile = path.join(PROJECT_ROOT, 'data', 'blockchain', 'cosmetics.json');
  let usedCache = false;

  if (fs.existsSync(blockchainFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(blockchainFile, 'utf8'));
      const types = cached.types || [];

      if (types.length > 0) {
        log.info(`Using blockchain cache (${types.length} types)`);

        for (const type of types) {
          if (!type.nameNormalized || !type.image) continue;

          const cosmeticId =
            NAME_OVERRIDES[type.nameNormalized] || nameToId.get(type.nameNormalized);
          if (!cosmeticId || !neededIds.has(cosmeticId)) continue;

          const folder = idToFolder.get(cosmeticId);
          if (!folder) continue;

          const outPath = path.join(OUTPUT_BASE, folder, `${cosmeticId}.webp`);
          toDownload.push({ name: type.name, cosmeticId, imageUrl: type.image, outPath });
          neededIds.delete(cosmeticId);
        }

        usedCache = true;
        log.info(`Matched ${toDownload.length} from cache, ${neededIds.size} still unresolved`);
      }
    } catch (err) {
      log.error(`Failed to read blockchain cache: ${err.message}`);
    }
  }

  // Fallback: paginate the Immutable API directly if cache missed items
  if (!usedCache || neededIds.size > 0) {
    const seenNames = new Set();
    let cursor = null;
    let pageNum = 0;

    log.info('Fetching NFT metadata from Immutable...');

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

          // Skip duplicates (stacked collection = many tokens with same name)
          if (seenNames.has(normalized)) continue;
          seenNames.add(normalized);

          // Match to local cosmetic ID
          const cosmeticId = NAME_OVERRIDES[normalized] || nameToId.get(normalized);
          if (!cosmeticId) {
            stats.unmatched.push(name);
            continue;
          }

          // Skip if we don't need this one
          if (!neededIds.has(cosmeticId)) continue;

          const folder = idToFolder.get(cosmeticId);
          if (!folder) continue;

          const outPath = path.join(OUTPUT_BASE, folder, `${cosmeticId}.webp`);
          toDownload.push({ name, cosmeticId, imageUrl, outPath });
          neededIds.delete(cosmeticId);
        }

        log.info(
          `Page ${pageNum}: ${nfts.length} NFTs, ${toDownload.length} to download, ${neededIds.size} still needed`
        );

        cursor = response.page?.next_cursor || null;

        if (neededIds.size === 0) {
          log.info('All needed images found!');
          break;
        }

        if (cursor) await sleep(INTER_PAGE_DELAY_MS);
      } catch (err) {
        log.error(`API error on page ${pageNum + 1}: ${err.message}`);
        break;
      }
    } while (cursor);
  }

  if (toDownload.length === 0) {
    log.info('No new images from blockchain');
    if (neededIds.size > 0) {
      log.info(`${neededIds.size} cosmetics not on blockchain (handled by other adapters)`);
    }
    return stats;
  }

  // Apply limit
  const batch = limit > 0 ? toDownload.slice(0, limit) : toDownload;
  let completed = 0;

  log.info(`Downloading ${batch.length} images...`);

  await processQueue(batch, DOWNLOAD_CONCURRENCY, async (item) => {
    try {
      const buffer = await downloadBuffer(item.imageUrl);
      await toWebP(buffer, item.outPath);
      stats.downloaded++;
    } catch (err) {
      log.error(`FAIL: ${item.name} — ${err.message}`);
      stats.failed++;
    }

    completed++;
    logProgress('cosmetics', completed, batch.length);
  });

  // Report unmatched NFT names
  if (stats.unmatched.length > 0 && stats.unmatched.length <= 20) {
    log.info(`Unmatched NFT names (${stats.unmatched.length}):`);
    for (const name of stats.unmatched) {
      log.info(`  - "${name}"`);
    }
  } else if (stats.unmatched.length > 20) {
    log.info(`${stats.unmatched.length} unmatched NFT names (showing first 10):`);
    for (const name of stats.unmatched.slice(0, 10)) {
      log.info(`  - "${name}"`);
    }
  }

  // Report cosmetics still missing
  if (neededIds.size > 0) {
    log.info(`${neededIds.size} cosmetics not found on Immutable`);
  }

  return stats;
}

module.exports = { run };
