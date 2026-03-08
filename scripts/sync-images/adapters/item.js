/**
 * Item Image Adapter
 *
 * Downloads item images from the Ravendawn game API (or local API cache).
 * Items include materials, trophies, tradepacks, cosmetics, and general items.
 *
 * Strategy:
 *   1. Fetch all items from https://api.ravendawn.online/v1/items
 *      (or read data/.api-cache/items.json if available and fresh)
 *   2. Load local data files to build needed-image sets per category
 *   3. Match API items to local data by normalized name
 *   4. Route downloads to the correct output directory based on category
 *      (cosmetics route to subfolders by category: house-decoration, outfit, etc.)
 *   5. Also save any unmatched items to assets/images/items/{id}.webp
 *
 * All items from the API have an `image` field with CDN URLs like:
 *   https://cdn-api.ravendawn.online/assets/{name}-{hash}.{ext}
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { downloadBuffer, sleep } = require('../download');
const { toWebP } = require('../convert');
const { nameToSnakeCase, getCategoryFolder, processQueue, logProgress } = require('../utils');
const { createLogger } = require('../logger');

const log = createLogger('[items]');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const CACHE_FILE = path.join(PROJECT_ROOT, 'data', '.api-cache', 'items.json');
const IMAGES_DIR = path.join(PROJECT_ROOT, 'assets', 'images');

const API_URL = 'https://api.ravendawn.online/v1/items';
const CONCURRENCY = 5;

// Data files that define items we care about tracking images for
const DATA_FILES = {
  materials: path.join(PROJECT_ROOT, 'data', 'materials.json'),
  trophies: path.join(PROJECT_ROOT, 'data', 'trophies.json'),
  tradepacks: path.join(PROJECT_ROOT, 'data', 'tradepacks.json'),
  cosmetics: path.join(PROJECT_ROOT, 'data', 'cosmetics.json')
};

// Where each category's images go (cosmetics use subfolders, handled separately)
const CATEGORY_DIRS = {
  materials: path.join(IMAGES_DIR, 'materials'),
  trophies: path.join(IMAGES_DIR, 'trophies', 'creature'),
  tradepacks: path.join(IMAGES_DIR, 'tradepacks'),
  items: path.join(IMAGES_DIR, 'items')
};

const COSMETICS_BASE = path.join(IMAGES_DIR, 'cosmetics');

/**
 * Fetch items from the game API.
 */
function fetchItems() {
  return new Promise((resolve, reject) => {
    log.info(`Fetching from ${API_URL}...`);
    https
      .get(
        API_URL,
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
              reject(new Error(`Game API returned HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`Failed to parse API response: ${err.message}`));
            }
          });
          res.on('error', reject);
        }
      )
      .on('error', reject);
  });
}

/**
 * Load items from API cache or fetch fresh.
 * The cache format is: { timestamp, data: [...] }
 */
async function getItems() {
  // Try local cache first (less than 24h old)
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const age = Date.now() - new Date(cached.timestamp).getTime();
      const ONE_DAY = 24 * 60 * 60 * 1000;

      if (age < ONE_DAY && cached.data && cached.data.length > 0) {
        log.info(
          `Using cached data (${cached.data.length} items, ${Math.round(age / 3600000)}h old)`
        );
        return cached.data;
      }
    } catch {
      // Cache corrupt, fetch fresh
    }
  }

  // Fetch from API
  const items = await fetchItems();
  return Array.isArray(items) ? items : [];
}

/**
 * Load a data file and extract IDs.
 * Handles multiple wrapper formats:
 *   - Plain array: [{ id, name }, ...]
 *   - { items: [...] }  (materials.json, trophies.json, cosmetics.json)
 *   - { tradepacks: [...] }  (tradepacks.json)
 *   - { data: [...] }  (API cache format)
 */
function loadDataIds(filePath) {
  if (!fs.existsSync(filePath)) return new Set();

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let items;

    if (Array.isArray(raw)) {
      items = raw;
    } else {
      // Try common wrapper keys
      items = raw.items || raw.tradepacks || raw.data || [];
    }

    return new Set(items.map((item) => item.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Get existing image filenames (without extension) in a directory.
 */
function getExistingImages(dir) {
  if (!fs.existsSync(dir)) return new Set();

  return new Set(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.webp'))
      .map((f) => f.replace('.webp', ''))
  );
}

/**
 * Load cosmetics data and build a snake_name → { id, folder, outPath } map.
 * Also collects existing cosmetic image IDs across all subfolders.
 */
function loadCosmeticsMap(filePath) {
  const map = new Map(); // snake_name → { id, folder, outPath }
  const existing = new Set(); // cosmetic IDs that already have images

  if (!fs.existsSync(filePath)) return { map, existing };

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const items = Array.isArray(raw) ? raw : raw.items || [];

    for (const cosmetic of items) {
      const folder = getCategoryFolder(cosmetic.category?.level1);
      if (!folder) continue;

      const snakeName = nameToSnakeCase(cosmetic.name);
      const outDir = path.join(COSMETICS_BASE, folder);
      const outPath = path.join(outDir, `${cosmetic.id}.webp`);

      map.set(snakeName, { id: cosmetic.id, folder, outDir, outPath });

      // Check if image already exists
      if (fs.existsSync(outPath)) {
        existing.add(cosmetic.id);
      }
    }
  } catch {
    // Data file corrupt or unreadable
  }

  return { map, existing };
}

/**
 * Run the item image sync.
 *
 * @param {object} options
 * @param {boolean} [options.dryRun=false]
 * @param {number} [options.limit=0] - Max downloads per category (0 = unlimited)
 * @returns {Promise<{checked: number, downloaded: number, skipped: number, failed: number}>}
 */
async function run(options = {}) {
  const { dryRun = false, limit = 0 } = options;
  const stats = { checked: 0, downloaded: 0, skipped: 0, failed: 0 };

  // Fetch all items from the game API
  let apiItems;
  try {
    apiItems = await getItems();
  } catch (err) {
    log.error(`ERROR fetching items: ${err.message}`);
    return stats;
  }

  stats.checked = apiItems.length;
  log.info(`${apiItems.length} items from API`);

  // Load local data to know which categories we track
  const materialIdSet = loadDataIds(DATA_FILES.materials);
  const trophyIdSet = loadDataIds(DATA_FILES.trophies);
  const tradepackIdSet = loadDataIds(DATA_FILES.tradepacks);
  const { map: cosmeticsMap, existing: existingCosmeticIds } = loadCosmeticsMap(
    DATA_FILES.cosmetics
  );

  // Get existing images per category (cosmetics handled separately via cosmeticsMap)
  const existingImages = {};
  for (const [cat, dir] of Object.entries(CATEGORY_DIRS)) {
    existingImages[cat] = getExistingImages(dir);
  }

  // Classify and route each API item
  const toDownload = [];

  for (const item of apiItems) {
    if (!item.image) continue;

    const snakeName = nameToSnakeCase(item.name);
    const numericId = String(item.id);

    // Try to match to a specific category by ID or normalized name
    let category = null;
    let filename = null;
    let outPath = null;

    if (materialIdSet.has(snakeName) || materialIdSet.has(item.name)) {
      category = 'materials';
      filename = snakeName;
    } else if (trophyIdSet.has(snakeName) || trophyIdSet.has(item.name)) {
      category = 'trophies';
      filename = snakeName;
    } else if (tradepackIdSet.has(snakeName) || tradepackIdSet.has(item.name)) {
      category = 'tradepacks';
      filename = snakeName;
    } else if (cosmeticsMap.has(snakeName)) {
      // Cosmetics route to subfolders: cosmetics/{folder}/{cosmeticId}.webp
      const cosmetic = cosmeticsMap.get(snakeName);
      category = 'cosmetics';
      filename = cosmetic.id;
      outPath = cosmetic.outPath;

      // Skip if already exists
      if (existingCosmeticIds.has(cosmetic.id)) {
        stats.skipped++;
        continue;
      }
    } else {
      // General items bucket — use numeric ID
      category = 'items';
      filename = numericId;
    }

    // Skip if already exists (non-cosmetic categories)
    if (category !== 'cosmetics' && existingImages[category].has(filename)) {
      stats.skipped++;
    } else {
      if (!outPath) {
        outPath = path.join(CATEGORY_DIRS[category], `${filename}.webp`);
      }

      toDownload.push({
        name: item.name,
        id: item.id,
        category,
        filename,
        imageUrl: item.image,
        outPath
      });
    }

    // Also route to cosmetics if this item matches a cosmetic (dual-route).
    // Many items (e.g. creature trophies) exist in both trophies.json and
    // cosmetics.json as craftable house decorations — both locations need the image.
    if (category !== 'cosmetics' && cosmeticsMap.has(snakeName)) {
      const cosmetic = cosmeticsMap.get(snakeName);
      if (!existingCosmeticIds.has(cosmetic.id)) {
        toDownload.push({
          name: item.name,
          id: item.id,
          category: 'cosmetics',
          filename: cosmetic.id,
          imageUrl: item.image,
          outPath: cosmetic.outPath
        });
      }
    }
  }

  // Report per category
  const byCat = {};
  for (const item of toDownload) {
    byCat[item.category] = (byCat[item.category] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(byCat)) {
    log.info(`${cat}: ${count} missing`);
  }
  log.info(`${stats.skipped} already exist across all categories`);

  if (dryRun || toDownload.length === 0) {
    return stats;
  }

  // Apply limit (per-adapter, not per-category)
  const batch = limit > 0 ? toDownload.slice(0, limit) : toDownload;
  let completed = 0;

  log.info(`Downloading ${batch.length} images...`);

  await processQueue(batch, CONCURRENCY, async (item) => {
    try {
      // Ensure output directory exists (cosmetic subfolders may not exist yet)
      const outDir = path.dirname(item.outPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }

      const buffer = await downloadBuffer(item.imageUrl);
      await toWebP(buffer, item.outPath);
      stats.downloaded++;
    } catch (err) {
      log.error(`FAIL: ${item.name} (${item.id}) — ${err.message}`);
      stats.failed++;
    }

    completed++;
    logProgress('items', completed, batch.length);
  });

  return stats;
}

module.exports = { run };
