/* eslint-disable no-unused-vars, no-restricted-syntax, no-return-await, no-nested-ternary */
/**
 * RavenGuardian Comprehensive Site Scraper
 * Scrapes all data pages from https://ravenguardian.com
 *
 * Pages scraped:
 * - Events: Dynamic world events with rewards
 * - Tradepacks: Trade routes, costs, profits
 * - Archetypes: Character classes/skill trees
 * - Cosmetics: Cosmetic items (outfits, mounts, etc.)
 * - Quests: Quest information and guides
 * - Crafting: Crafting recipes (alchemy, cooking, etc.)
 * - World Map: Map locations and POIs
 *
 * Run: node scripts/scrape-ravenguardian-full.js [--headless] [--page=<page>]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Configuration
const BASE_URL = 'https://ravenguardian.com';
const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'ravenguardian');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');

// Ensure directories exist
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

ensureDir(OUTPUT_DIR);
ensureDir(IMAGES_DIR);

// Helper functions
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseNumber(text) {
  if (!text || text === '?' || text === '-' || text === '') return null;
  const num = parseInt(text.replace(/,/g, '').replace(/[^0-9-]/g, ''), 10);
  return isNaN(num) ? null : num;
}

function cleanText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

async function downloadImage(page, url, filepath) {
  if (fs.existsSync(filepath)) return false;
  try {
    const buffer = await page.evaluate(async (imageUrl) => {
      const response = await fetch(imageUrl, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      return Array.from(new Uint8Array(arrayBuffer));
    }, url);
    fs.writeFileSync(filepath, Buffer.from(buffer));
    return true;
  } catch (err) {
    return false;
  }
}

// ============================================
// PAGE SCRAPERS
// ============================================

/**
 * Scrape Events page
 */
async function scrapeEvents(page) {
  console.log('\n📅 Scraping Events...');
  await page.goto(`${BASE_URL}/events`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

  const events = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 7) return;

      const eventCell = cells[1];
      const spans = eventCell.querySelectorAll('span');
      const title = spans[0]?.textContent?.trim() || '';
      const description = spans[1]?.textContent?.trim() || '';

      if (!title || title.length < 2 || title === 'Event') return;

      const rewards = [];
      const rewardItems = cells[7]?.querySelectorAll('li') || [];
      rewardItems.forEach((item) => {
        const img = item.querySelector('img');
        const text = item.textContent?.trim() || '';
        const quantityMatch = text.match(/x([\d-]+)/);
        const name = img?.alt || text.replace(/^x[\d-]+\s*/, '').trim();
        if (name) {
          rewards.push({
            name,
            quantity: quantityMatch ? quantityMatch[1] : '1',
            imageUrl: img?.src || ''
          });
        }
      });

      results.push({
        name: title,
        description,
        level: cells[2]?.textContent?.trim() || '',
        area: cells[3]?.textContent?.trim() || '',
        guide: cells[4]?.textContent?.trim() || '',
        experience: cells[5]?.querySelector('span')?.textContent?.trim() || '',
        silver: cells[6]?.querySelector('span')?.textContent?.trim() || '',
        rewards
      });
    });
    return results;
  });

  const processed = events.map((e) => ({
    id: slugify(e.name),
    name: e.name,
    description: cleanText(e.description),
    level: parseNumber(e.level),
    area: e.area,
    guide: e.guide || null,
    experience: parseNumber(e.experience),
    silver: parseNumber(e.silver),
    rewards: e.rewards
  }));

  console.log(`  ✓ Found ${processed.length} events`);
  return processed;
}

/**
 * Scrape Tradepacks page
 */
async function scrapeTradepacks(page) {
  console.log('\n📦 Scraping Tradepacks...');
  await page.goto(`${BASE_URL}/tradepacks`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  await page.waitForSelector('table', { timeout: 15000 });

  const tradepacks = await page.evaluate(() => {
    const results = [];

    // Main tradepacks table (usually the second table with actual data)
    const tables = document.querySelectorAll('table');
    let mainTable = null;

    for (const table of tables) {
      const headers = [...table.querySelectorAll('th')].map((th) => th.textContent.trim());
      if (headers.includes('Tradepack') && headers.includes('Cost')) {
        mainTable = table;
        break;
      }
    }

    if (!mainTable) return results;

    mainTable.querySelectorAll('tbody tr').forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) return;

      // First cell has image and name
      const firstCell = cells[0];
      const img = firstCell.querySelector('img');
      const nameSpan = firstCell.querySelector('span');
      const name = nameSpan?.textContent?.trim() || img?.alt || '';

      if (!name || name.length < 2) return;

      // Cost cell
      const costCell = cells[1];
      const costText = costCell?.textContent?.trim() || '';

      // Profit cell
      const profitCell = cells[2];
      const profitText = profitCell?.textContent?.trim() || '';

      // Destinations
      const destCell = cells[3];
      const destinations = [];
      destCell?.querySelectorAll('span, div').forEach((el) => {
        const text = el.textContent?.trim();
        if (text && text.length > 2 && !destinations.includes(text)) {
          destinations.push(text);
        }
      });

      results.push({
        name,
        imageUrl: img?.src || '',
        cost: costText,
        topProfit: profitText,
        destinations: destinations.slice(0, 10)
      });
    });

    return results;
  });

  const processed = tradepacks.map((t) => ({
    id: slugify(t.name),
    name: t.name,
    imageUrl: t.imageUrl,
    cost: parseNumber(t.cost),
    topProfit: parseNumber(t.topProfit),
    destinations: t.destinations
  }));

  console.log(`  ✓ Found ${processed.length} tradepacks`);
  return processed;
}

/**
 * Scrape Archetypes page
 */
async function scrapeArchetypes(page) {
  console.log('\n⚔️ Scraping Archetypes...');
  await page.goto(`${BASE_URL}/archetypes`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const archetypes = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Get archetypes from images with archetype in src
    document.querySelectorAll('img[src*="archetypes/"]').forEach((img) => {
      const name = img.alt || '';
      // Skip menu icons and already seen
      if (!name || seen.has(name) || name === 'Archetypes') return;
      seen.add(name);

      results.push({
        name,
        imageUrl: img.src.replace('_disabled', ''),
        imageUrlDisabled: img.src
      });
    });

    return results;
  });

  console.log(`  ✓ Found ${archetypes.length} archetypes`);
  return archetypes.map((a) => ({
    id: slugify(a.name),
    ...a
  }));
}

/**
 * Scrape Cosmetics page
 */
async function scrapeCosmetics(page) {
  console.log('\n👗 Scraping Cosmetics...');
  await page.goto(`${BASE_URL}/cosmetics`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // First, get all available categories/tabs
  const categories = await page.evaluate(() => {
    const tabs = [];
    document.querySelectorAll('[class*="tab"], [role="tab"], button').forEach((el) => {
      const text = el.textContent?.trim();
      if (text && text.length > 1 && text.length < 30) {
        tabs.push(text);
      }
    });
    return [...new Set(tabs)];
  });

  console.log(`  Categories found: ${categories.slice(0, 10).join(', ')}`);

  const cosmetics = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Look for cosmetic items - they often have images and names
    document.querySelectorAll('img').forEach((img) => {
      if (
        !img.src ||
        img.src.includes('menu') ||
        img.src.includes('cdn/silver') ||
        img.src.includes('cdn/experience')
      )
        return;

      const name = img.alt || '';
      const parent = img.closest('[class*="card"], [class*="item"], tr, li, div');
      const category =
        parent
          ?.closest('[class*="category"], [class*="section"]')
          ?.querySelector('h2, h3')
          ?.textContent?.trim() || '';

      if (name && name.length > 1 && !seen.has(name + img.src)) {
        seen.add(name + img.src);
        results.push({
          name,
          imageUrl: img.src,
          category
        });
      }
    });

    return results;
  });

  // Filter out menu/UI images
  const filtered = cosmetics.filter(
    (c) => c.name && !c.imageUrl.includes('/menu/') && !c.imageUrl.includes('ravenguardian.webp')
  );

  console.log(`  ✓ Found ${filtered.length} cosmetic items`);
  return filtered;
}

/**
 * Scrape Quests page
 */
async function scrapeQuests(page) {
  console.log('\n📜 Scraping Quests...');
  await page.goto(`${BASE_URL}/quests`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

  const quests = await page.evaluate(() => {
    const results = [];

    document.querySelectorAll('table tbody tr').forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) return;

      // Cell structure: checkbox, quest name, level, guide, experience
      const nameCell = cells[1];
      const name =
        nameCell?.querySelector('span')?.textContent?.trim() || nameCell?.textContent?.trim() || '';

      if (!name || name.length < 2 || name === 'Quest') return;

      const img = nameCell?.querySelector('img');

      results.push({
        name,
        imageUrl: img?.src || '',
        level: cells[2]?.textContent?.trim() || '',
        guide: cells[3]?.textContent?.trim() || '',
        experience:
          cells[4]?.querySelector('span')?.textContent?.trim() ||
          cells[4]?.textContent?.trim() ||
          ''
      });
    });

    return results;
  });

  const processed = quests.map((q) => ({
    id: slugify(q.name),
    name: q.name,
    imageUrl: q.imageUrl,
    level: parseNumber(q.level),
    guide: q.guide || null,
    experience: parseNumber(q.experience)
  }));

  console.log(`  ✓ Found ${processed.length} quests`);
  return processed;
}

/**
 * Scrape Crafting page (all professions)
 */
async function scrapeCrafting(page) {
  console.log('\n🔨 Scraping Crafting...');

  // Professions available based on site images
  const professions = [
    { name: 'alchemy', alt: 'Alchemy' },
    { name: 'blacksmithing', alt: 'Blacksmithing' },
    { name: 'carpentry', alt: 'Carpentry' },
    { name: 'cooking', alt: 'Cooking' },
    { name: 'weaving', alt: 'Weaving' }
  ];
  const allRecipes = {};

  await page.goto(`${BASE_URL}/crafting`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Scrape the current table
  const scrapeCurrentTable = async () =>
    await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('table tbody tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return;

        // Cell 1 has image and name
        const img = cells[1]?.querySelector('img');
        const name = img?.alt || cells[1]?.textContent?.trim() || '';

        if (!name || name.length < 2) return;

        results.push({
          name,
          imageUrl: img?.src || '',
          amount: cells[2]?.textContent?.trim() || '',
          level: cells[3]?.textContent?.trim() || '',
          experience: cells[4]?.textContent?.trim() || '',
          cost: cells[5]?.textContent?.trim() || ''
        });
      });
      return results;
    });

  const processRecipes = (recipes) =>
    recipes.map((r) => ({
      id: slugify(r.name),
      name: r.name,
      imageUrl: r.imageUrl,
      amount: parseNumber(r.amount?.replace('x', '')),
      level: parseNumber(r.level),
      experience: parseNumber(r.experience),
      cost: parseNumber(r.cost)
    }));

  // Click on each profession icon to switch and scrape
  for (const prof of professions) {
    try {
      // Find and click the profession icon
      const iconSelector = `img[src*="professions/${prof.name}"]`;
      const icon = await page.$(iconSelector);

      if (icon) {
        await icon.click();
        await page.waitForTimeout(2000);

        // Verify we switched
        const h1 = await page.evaluate(() =>
          document.querySelector('h1')?.textContent?.trim()?.toLowerCase()
        );

        if (h1 === prof.name) {
          const recipes = await scrapeCurrentTable();
          if (recipes.length > 0) {
            allRecipes[prof.name] = processRecipes(recipes);
            console.log(`  ✓ ${prof.name}: ${recipes.length} recipes`);
          }
        }
      }
    } catch (err) {
      console.log(`  ✗ ${prof.name}: ${err.message.substring(0, 50)}`);
    }
  }

  return allRecipes;
}

/**
 * Scrape World Map locations
 */
async function scrapeWorldMap(page) {
  console.log('\n🗺️ Scraping World Map...');
  await page.goto(`${BASE_URL}/world`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const mapData = await page.evaluate(() => {
    const result = {
      regions: [],
      markers: [],
      images: []
    };

    // Look for map markers/points of interest
    document
      .querySelectorAll('[class*="marker"], [class*="poi"], [class*="location"]')
      .forEach((el) => {
        const name = el.getAttribute('data-name') || el.textContent?.trim() || '';
        const x = el.getAttribute('data-x') || el.style?.left || '';
        const y = el.getAttribute('data-y') || el.style?.top || '';

        if (name) {
          result.markers.push({ name, x, y });
        }
      });

    // Get region images
    document.querySelectorAll('img').forEach((img) => {
      if (img.src && img.src.includes('map')) {
        result.images.push({
          alt: img.alt || '',
          src: img.src
        });
      }
    });

    // Look for clickable regions
    document.querySelectorAll('area, [class*="region"]').forEach((el) => {
      const name =
        el.getAttribute('alt') || el.getAttribute('data-region') || el.textContent?.trim();
      if (name) {
        result.regions.push(name);
      }
    });

    return result;
  });

  console.log(`  ✓ Found ${mapData.markers.length} markers, ${mapData.regions.length} regions`);
  return mapData;
}

// ============================================
// MAIN SCRAPER
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const headless = args.includes('--headless');
  const specificPage = args.find((a) => a.startsWith('--page='))?.split('=')[1];

  console.log('═══════════════════════════════════════════════════');
  console.log('  RavenGuardian Comprehensive Scraper');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Mode: ${headless ? 'Headless' : 'Visible browser'}`);
  if (specificPage) console.log(`Scraping only: ${specificPage}`);
  console.log('');

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  const allData = {
    scrapedAt: new Date().toISOString(),
    source: BASE_URL
  };

  try {
    const scrapers = {
      events: scrapeEvents,
      tradepacks: scrapeTradepacks,
      archetypes: scrapeArchetypes,
      cosmetics: scrapeCosmetics,
      quests: scrapeQuests,
      crafting: scrapeCrafting,
      worldmap: scrapeWorldMap
    };

    const pagesToScrape = specificPage ? [specificPage] : Object.keys(scrapers);

    for (const pageName of pagesToScrape) {
      if (scrapers[pageName]) {
        try {
          allData[pageName] = await scrapers[pageName](page);
        } catch (err) {
          console.log(`  ✗ Error scraping ${pageName}: ${err.message}`);
          allData[pageName] = { error: err.message };
        }
      }
    }

    // Save all data
    fs.writeFileSync(path.join(OUTPUT_DIR, 'full-data.json'), JSON.stringify(allData, null, 2));

    // Also save individual files
    for (const [key, data] of Object.entries(allData)) {
      if (key !== 'scrapedAt' && key !== 'source' && !data.error) {
        fs.writeFileSync(
          path.join(OUTPUT_DIR, `${key}.json`),
          JSON.stringify(
            {
              scrapedAt: allData.scrapedAt,
              source: `${BASE_URL}/${key === 'news' ? '' : key}`,
              data
            },
            null,
            2
          )
        );
      }
    }

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  SCRAPING COMPLETE');
    console.log('═══════════════════════════════════════════════════');
    console.log(`Output: ${OUTPUT_DIR}`);
    console.log('\nData collected:');
    for (const [key, data] of Object.entries(allData)) {
      if (key !== 'scrapedAt' && key !== 'source') {
        const count = Array.isArray(data)
          ? data.length
          : typeof data === 'object' && !data.error
            ? Object.keys(data).length
            : 'error';
        console.log(`  - ${key}: ${count}`);
      }
    }
  } catch (err) {
    console.error('\n❌ Scraping failed:', err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
