/* eslint-disable no-useless-catch, no-unused-vars, no-restricted-syntax, no-empty */
/**
 * RavenGuardian Data Scraper
 * Scrapes event data and images from https://ravenguardian.com/events
 * Uses Playwright for robust browser automation
 *
 * Run: npm run scrape
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'ravenguardian');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');
const REWARD_IMAGES_DIR = path.join(IMAGES_DIR, 'rewards');
const DATA_PATH = path.join(OUTPUT_DIR, 'events.json');

// Ensure directories exist
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
if (!fs.existsSync(REWARD_IMAGES_DIR)) fs.mkdirSync(REWARD_IMAGES_DIR, { recursive: true });

/**
 * Download an image using fetch inside browser context (handles CORS)
 */
async function downloadImageWithFetch(page, url, filepath) {
  if (fs.existsSync(filepath)) {
    return false; // Already exists
  }

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
    throw err;
  }
}

/**
 * Slugify a name to create ID
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse number from text (handles commas, ? for unknown)
 */
function parseNumber(text) {
  if (!text || text === '?' || text === '-') return null;
  const num = parseInt(text.replace(/,/g, ''), 10);
  return isNaN(num) ? null : num;
}

/**
 * Clean description text (remove extra whitespace)
 */
function cleanDescription(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

async function scrapeEvents() {
  console.log('=== RavenGuardian Events Scraper ===\n');

  // Use --headless flag for headless mode
  const headless = process.argv.includes('--headless');

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    console.log('Navigating to events page...');
    await page.goto('https://ravenguardian.com/events', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait for the table to render (React app)
    console.log('Waiting for content to render...');
    await page.waitForTimeout(5000);

    // Wait for table rows to appear
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    console.log('Table found!\n');

    // Extract event data from the table
    console.log('Extracting event data...');

    const events = await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll('table tbody tr');

      rows.forEach((row, index) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 7) return; // Skip incomplete rows

        // Cell 0: Checkbox (skip)
        // Cell 1: Event name + description
        const eventCell = cells[1];
        const spans = eventCell.querySelectorAll('span');
        const title = spans[0]?.textContent?.trim() || '';
        const description = spans[1]?.textContent?.trim() || '';

        // Cell 2: Level
        const level = cells[2]?.textContent?.trim() || '';

        // Cell 3: Area
        const area = cells[3]?.textContent?.trim() || '';

        // Cell 4: Guide (has button with video link)
        const guideCell = cells[4];
        const guideLink = guideCell?.querySelector('a')?.href || '';
        const guideButton = guideCell?.querySelector('button');
        const guideName = guideCell?.textContent?.trim() || '';

        // Cell 5: Experience
        const experience =
          cells[5]?.querySelector('span')?.textContent?.trim() ||
          cells[5]?.textContent?.trim()?.replace(/[^0-9,?-]/g, '') ||
          '';

        // Cell 6: Silver
        const silver =
          cells[6]?.querySelector('span')?.textContent?.trim() ||
          cells[6]?.textContent?.trim()?.replace(/[^0-9,?-]/g, '') ||
          '';

        // Cell 7: Rewards
        const rewardsCell = cells[7];
        const rewards = [];

        // Rewards are in list items with images and quantities
        const rewardItems = rewardsCell?.querySelectorAll('li') || [];
        rewardItems.forEach((item) => {
          const img = item.querySelector('img');
          const text = item.textContent?.trim() || '';
          const quantityMatch = text.match(/x([\d-]+)/);
          const name = img?.alt || text.replace(/^x[\d-]+\s*/, '').trim();

          if (name && name.length > 0) {
            rewards.push({
              name,
              quantity: quantityMatch ? quantityMatch[1] : '1',
              imageUrl: img?.src || ''
            });
          }
        });

        // Only add if we have a valid event name
        if (title && title.length > 2 && title !== 'Event') {
          results.push({
            name: title,
            description,
            level,
            area,
            guide: guideName,
            guideUrl: guideLink,
            hasGuide: !!guideButton || !!guideLink,
            experience,
            silver,
            rewards
          });
        }
      });

      return results;
    });

    console.log(`Found ${events.length} events\n`);

    // Process and clean up the data
    const processedEvents = events.map((event) => ({
      id: slugify(event.name),
      name: event.name,
      description: cleanDescription(event.description),
      level: parseNumber(event.level),
      area: event.area,
      guide: event.guide || null,
      hasGuide: event.hasGuide,
      experience: parseNumber(event.experience),
      silver: parseNumber(event.silver),
      rewards: event.rewards
        .filter((r) => r.name && r.name.length > 0)
        .map((r) => ({
          name: r.name,
          quantity: r.quantity,
          imageUrl: r.imageUrl
        }))
    }));

    // Collect all unique reward images
    const rewardImages = new Map();
    processedEvents.forEach((event) => {
      event.rewards.forEach((reward) => {
        if (reward.imageUrl && !rewardImages.has(reward.imageUrl)) {
          rewardImages.set(reward.imageUrl, slugify(reward.name));
        }
      });
    });

    // Download reward images using the browser context (handles CORS)
    console.log(`Downloading ${rewardImages.size} unique reward images...`);
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const [url, name] of rewardImages) {
      try {
        const ext = path.extname(new URL(url).pathname) || '.png';
        const imgPath = path.join(REWARD_IMAGES_DIR, `${name}${ext}`);
        const wasDownloaded = await downloadImageWithFetch(page, url, imgPath);
        if (wasDownloaded) {
          downloaded++;
          process.stdout.write('.');
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
      }
    }
    console.log(
      `\nReward images: ${downloaded} downloaded, ${skipped} existed, ${failed} failed\n`
    );

    // Build output
    const output = {
      scrapedAt: new Date().toISOString(),
      source: 'https://ravenguardian.com/events',
      totalEvents: processedEvents.length,
      events: processedEvents
    };

    // Save data
    fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2));
    console.log(`Saved ${processedEvents.length} events to ${DATA_PATH}`);

    // Print summary
    console.log('\n=== Event Summary ===');
    const areas = [...new Set(processedEvents.map((e) => e.area))].filter(Boolean);
    console.log(`Areas: ${areas.join(', ')}`);

    const levelRange = processedEvents.filter((e) => e.level).map((e) => e.level);
    if (levelRange.length > 0) {
      console.log(`Level range: ${Math.min(...levelRange)} - ${Math.max(...levelRange)}`);
    }

    // Count events with rewards
    const eventsWithRewards = processedEvents.filter((e) => e.rewards.length > 0).length;
    console.log(`Events with rewards: ${eventsWithRewards}/${processedEvents.length}`);

    // Take a screenshot
    await page.screenshot({
      path: path.join(OUTPUT_DIR, 'events-screenshot.png'),
      fullPage: true
    });
    console.log('\nScreenshot saved');
  } catch (err) {
    console.error('\nScraping failed:', err.message);
    console.error(err.stack);

    // Save error info
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'error.json'),
      JSON.stringify(
        {
          error: err.message,
          stack: err.stack,
          timestamp: new Date().toISOString()
        },
        null,
        2
      )
    );

    // Take error screenshot
    try {
      await page.screenshot({ path: path.join(OUTPUT_DIR, 'error-screenshot.png') });
    } catch {}
  } finally {
    await browser.close();
  }

  console.log('\n=== Scraping Complete ===');
}

// Run
scrapeEvents().catch(console.error);
