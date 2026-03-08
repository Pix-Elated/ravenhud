/**
 * RavenGuardian Cosmetics Image Adapter
 *
 * Downloads cosmetic images from RavenGuardian's CDN via Playwright.
 * The CDN requires browser context (cookies/CORS) — direct HTTP won't work.
 *
 * Strategy:
 *   1. Load local cosmetics from data/cosmetics.json → build name → (id, folder) map
 *   2. Check which cosmetics are already on disk → skip them
 *   3. Load known-missing list (_known-missing.json) → skip CDN-absent items
 *   4. Launch headless browser, visit ravenguardian.com for cookies
 *   5. Scrape <img> elements that actually loaded (naturalWidth > 0, not fallback.gif)
 *   6. Supplement with pre-scraped JSON URLs for items not visible on page
 *   7. Download via browser fetch, convert to WebP, content-hash dedup
 *   8. Record failed items to _known-missing.json so future runs skip them
 *
 * Output: assets/images/cosmetics/{folder}/{cosmetic_id}.webp
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toWebP } = require('../convert');
const { nameToSnakeCase, getCategoryFolder, logProgress } = require('../utils');
const { createLogger } = require('../logger');

const log = createLogger('[ravenguardian]');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const COSMETICS_FILE = path.join(PROJECT_ROOT, 'data', 'cosmetics.json');
const SCRAPED_FILE = path.join(PROJECT_ROOT, 'assets', 'ravenguardian', 'cosmetics.json');
const OUTPUT_BASE = path.join(PROJECT_ROOT, 'assets', 'images', 'cosmetics');
const KNOWN_MISSING_FILE = path.join(OUTPUT_BASE, '_known-missing.json');

const DOWNLOAD_DELAY_MS = 300; // Polite delay between requests
const PAGE_LOAD_WAIT_MS = 6000;

function hashBuffer(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Load the known-missing set — cosmetic snake_names confirmed absent from CDN.
 */
function loadKnownMissing() {
  if (!fs.existsSync(KNOWN_MISSING_FILE)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(KNOWN_MISSING_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

/**
 * Persist the known-missing set for future runs.
 */
function saveKnownMissing(set) {
  const sorted = [...set].sort();
  fs.writeFileSync(KNOWN_MISSING_FILE, JSON.stringify(sorted, null, 2));
}

/**
 * Download an image through Playwright's browser context.
 * Returns { buffer } on success, { error } on failure.
 */
async function browserDownload(page, url) {
  try {
    const result = await page.evaluate(async (imageUrl) => {
      const res = await fetch(imageUrl, { credentials: 'include' });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const buf = await res.arrayBuffer();
      return { bytes: Array.from(new Uint8Array(buf)) };
    }, url);
    if (result.error) {
      return { error: result.error };
    }
    return { buffer: Buffer.from(result.bytes) };
  } catch (err) {
    return { error: (err.message || 'unknown').split('\n')[0] };
  }
}

/**
 * Build the download list from live page scrape and pre-scraped JSON.
 * Page images (actually loaded) are preferred; JSON fills gaps for unseen items.
 */
function buildDownloadList(needed, scrapedItems, pageImages) {
  const toDownload = [];
  const matched = new Set();

  // Phase 1: Page images first — these are confirmed-loadable by the browser
  for (const img of pageImages) {
    const snake = nameToSnakeCase(img.name);
    if (matched.has(snake)) continue;
    const cos = needed.get(snake);
    if (!cos) continue;

    matched.add(snake);
    toDownload.push({ name: img.name, url: img.url, ...cos });
  }

  // Phase 2: Scraped JSON fills gaps for items not visible on the page
  for (const item of scrapedItems) {
    if (!item.name || !item.imageUrl) continue;
    const snake = nameToSnakeCase(item.name);
    if (matched.has(snake)) continue;
    const cos = needed.get(snake);
    if (!cos) continue;

    matched.add(snake);
    toDownload.push({ name: item.name, url: item.imageUrl, ...cos });
  }

  return toDownload;
}

/**
 * Run the RavenGuardian cosmetics image sync.
 */
async function run(options = {}) {
  const { dryRun = false, limit = 0 } = options;
  const stats = { checked: 0, downloaded: 0, skipped: 0, failed: 0, deduped: 0 };

  if (!fs.existsSync(COSMETICS_FILE)) {
    log.error('data/cosmetics.json not found');
    return stats;
  }

  // Load local cosmetics → build name lookup
  const cosRaw = JSON.parse(fs.readFileSync(COSMETICS_FILE, 'utf8'));
  const cosmetics = Array.isArray(cosRaw) ? cosRaw : cosRaw.items || [];

  const nameToCosmetic = new Map();
  for (const c of cosmetics) {
    const folder = getCategoryFolder(c.category?.level1);
    if (!folder) continue;
    nameToCosmetic.set(nameToSnakeCase(c.name), { id: c.id, folder });
  }

  // Load known-missing items (previously failed, CDN doesn't have them)
  const knownMissing = loadKnownMissing();

  // Build set of needed cosmetics (not on disk, not known-missing)
  const needed = new Map(); // snake_name → { id, folder, outPath }
  let knownMissingCount = 0;
  for (const [snake, cos] of nameToCosmetic) {
    const outPath = path.join(OUTPUT_BASE, cos.folder, `${cos.id}.webp`);
    if (fs.existsSync(outPath)) {
      stats.skipped++;
    } else if (knownMissing.has(snake)) {
      stats.skipped++;
      knownMissingCount++;
    } else {
      needed.set(snake, { ...cos, outPath });
    }
  }

  stats.checked = nameToCosmetic.size;
  log.info(
    `${nameToCosmetic.size} cosmetics total, ${needed.size} to try, ${stats.skipped} on disk/known-missing`
  );
  if (knownMissingCount > 0) {
    log.info(`${knownMissingCount} skipped (known absent from CDN)`);
  }

  if (dryRun || needed.size === 0) {
    return stats;
  }

  // Load pre-scraped JSON for CDN URLs (supplement for items not on page)
  let scrapedItems = [];
  if (fs.existsSync(SCRAPED_FILE)) {
    try {
      const scraped = JSON.parse(fs.readFileSync(SCRAPED_FILE, 'utf8'));
      scrapedItems = scraped.data || [];
      log.info(`Scraped JSON: ${scrapedItems.length} items with CDN URLs`);
    } catch (err) {
      log.error(`Failed to read scraped JSON: ${err.message}`);
    }
  }

  // Launch Playwright
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch {
    log.error('Playwright not installed — run: npm install playwright');
    return stats;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    log.error(`Browser launch failed: ${err.message}`);
    log.warn('Run: npx playwright install chromium');
    return stats;
  }

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // Navigate to establish browser cookies (required for CDN access)
    log.info('Loading ravenguardian.com/cosmetics for cookies...');
    await page.goto('https://ravenguardian.com/cosmetics', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(PAGE_LOAD_WAIT_MS);

    // Scrape visible page images — only those that actually loaded (not fallback.gif)
    const pageImages = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('img').forEach((img) => {
        if (!img.src || !img.alt || img.alt.length < 2) return;
        if (!img.src.includes('/cdn/')) return;
        if (img.naturalWidth === 0) return; // Broken/unloaded image

        const key = img.alt;
        if (seen.has(key)) return;
        seen.add(key);

        results.push({ name: img.alt, url: img.src });
      });
      return results;
    });

    log.info(`Live page: ${pageImages.length} loaded images`);

    // Build download list (page images preferred, JSON fills gaps)
    const toDownload = buildDownloadList(needed, scrapedItems, pageImages);

    log.info(`${toDownload.length} matched to ${needed.size} needed cosmetics`);

    if (toDownload.length === 0) {
      return stats;
    }

    const batch = limit > 0 ? toDownload.slice(0, limit) : toDownload;
    const hashes = new Set();
    const newMissing = [];
    let completed = 0;

    log.info(`Downloading ${batch.length} images via browser...`);

    // Sequential download — polite delay between each request
    for (const item of batch) {
      const result = await browserDownload(page, item.url);

      if (result.error) {
        stats.failed++;
        newMissing.push(nameToSnakeCase(item.name));
      } else {
        const hash = hashBuffer(result.buffer);
        if (hashes.has(hash)) {
          stats.deduped++;
        } else {
          hashes.add(hash);
          await toWebP(result.buffer, item.outPath);
          stats.downloaded++;
        }
      }

      completed++;
      logProgress('ravenguardian', completed, batch.length);

      if (completed < batch.length) {
        await sleep(DOWNLOAD_DELAY_MS);
      }
    }

    // Persist newly discovered missing items so future runs skip them
    if (newMissing.length > 0) {
      for (const name of newMissing) knownMissing.add(name);
      saveKnownMissing(knownMissing);
      log.info(`${newMissing.length} items added to known-missing (CDN absent)`);
    }

    if (stats.deduped > 0) {
      log.info(`Deduped ${stats.deduped} identical images`);
    }
  } finally {
    await browser.close();
  }

  return stats;
}

module.exports = { run };
