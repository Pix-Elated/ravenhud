/* eslint-disable global-require, no-restricted-syntax, no-unused-vars */
/**
 * Creature Data Scraper
 * Scrapes creature data and images from https://ravenquest.wiki/creatures
 * Uses Playwright in headless mode
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_PATH = path.join(__dirname, '..', 'data', 'creatures.json');
const IMAGES_PATH = path.join(__dirname, '..', 'assets', 'creatures');

/**
 * Download an image from URL to local path
 */
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(filepath)) {
      console.log(`  Skipping (exists): ${path.basename(filepath)}`);
      resolve(false);
      return;
    }

    // Handle both http and https
    const protocol = url.startsWith('https') ? https : require('http');

    const file = fs.createWriteStream(filepath);
    protocol
      .get(url, (response) => {
        if (response.statusCode === 200) {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            console.log(`  Downloaded: ${path.basename(filepath)}`);
            resolve(true);
          });
        } else if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          fs.unlinkSync(filepath);
          downloadImage(response.headers.location, filepath).then(resolve).catch(reject);
        } else {
          file.close();
          fs.unlinkSync(filepath);
          reject(new Error(`Failed to download: ${response.statusCode}`));
        }
      })
      .on('error', (err) => {
        file.close();
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        reject(err);
      });
  });
}

/**
 * Slugify a creature name to create ID
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

async function scrapeCreatures() {
  console.log('Starting creature scraper...');
  console.log('Launching browser in headless mode...');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to https://ravenquest.wiki/creatures...');
  await page.goto('https://ravenquest.wiki/creatures', { waitUntil: 'networkidle' });

  // Wait for content to load
  console.log('Waiting for page content to load...');
  await page.waitForSelector('tr[id^="creature-"]', { timeout: 30000 });

  // Extract creature data
  console.log('Extracting creature data...');
  const creatures = await page.evaluate(() => {
    const results = [];

    // Find all creature rows by their ID pattern: creature-{slug}
    const creatureRows = document.querySelectorAll('tr[id^="creature-"]');

    creatureRows.forEach((row) => {
      // Get creature name from h3
      const nameEl = row.querySelector('td:first-child h3');
      const creatureName = nameEl?.textContent?.trim();
      if (!creatureName) return;

      // Get creature image URL
      const creatureImg = row.querySelector('td:first-child img');
      const imageUrl = creatureImg?.src || '';

      // Get all drop items from the list
      const dropItems = row.querySelectorAll('td:last-child li a');
      const drops = [];

      dropItems.forEach((dropEl) => {
        // Item name
        const nameDiv = dropEl.querySelector('.text-fg-light');
        const name = nameDiv?.textContent?.trim();
        if (!name) return;

        // Category - detect by color class
        let category = 'Unknown';
        const greenEl = dropEl.querySelector('.text-green-400');
        const yellowEl = dropEl.querySelector('.text-yellow-400');
        const redEl = dropEl.querySelector('.text-red-400');
        const junkEl = dropEl.querySelector('.text-fg-dimmed div');

        if (greenEl?.textContent?.includes('Material')) category = 'Material';
        else if (yellowEl?.textContent?.includes('Cosmetic')) category = 'Cosmetic';
        else if (redEl?.textContent?.includes('Trophy')) category = 'Trophy';
        else if (junkEl?.textContent?.includes('Junk')) category = 'Junk';

        // Level - find "Level X+" text
        const levelEl = Array.from(dropEl.querySelectorAll('.text-3xs')).find((el) =>
          el.textContent?.includes('Level')
        );
        const levelMatch = levelEl?.textContent?.match(/Level\s*(\d+)/);
        const level = levelMatch ? parseInt(levelMatch[1]) : 1;

        // Rarity - in .text-fg-dimmed at bottom
        const rarityEl = dropEl.querySelector('.mt-1\\.5 .text-fg-dimmed');
        const rarity = rarityEl?.textContent?.trim() || 'Common';

        // Junk value - find silver value
        let junkValue = 0;
        const valueDiv = dropEl.querySelector('.text-2xs');
        if (valueDiv) {
          const valueText = valueDiv.textContent?.replace(/,/g, '').match(/(\d+)/);
          junkValue = valueText ? parseInt(valueText[1]) : 0;
        }

        drops.push({
          name,
          category,
          level,
          rarity,
          junkValue
        });
      });

      // Only add creatures with drops
      if (drops.length > 0) {
        results.push({
          name: creatureName,
          imageUrl,
          drops
        });
      }
    });

    return results;
  });

  console.log(`Found ${creatures.length} creatures with drops`);

  await browser.close();

  if (creatures.length === 0) {
    console.log('No creatures found!');
    return;
  }

  // Process and format data
  const formattedCreatures = creatures.map((creature) => ({
    id: slugify(creature.name),
    name: creature.name,
    category: 'creatures',
    imageUrl: creature.imageUrl,
    drops: creature.drops.map((d) => d.name), // Simple array for backwards compat
    dropsDetailed: creature.drops // Full drop info
  }));

  // Download missing images
  console.log('\nDownloading missing creature images...');
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const creature of formattedCreatures) {
    if (creature.imageUrl) {
      const imgPath = path.join(IMAGES_PATH, `${creature.id}.png`);
      try {
        const wasDownloaded = await downloadImage(creature.imageUrl, imgPath);
        if (wasDownloaded) downloaded++;
        else skipped++;
      } catch (err) {
        console.log(`  Failed ${creature.name}: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nImages: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);

  // Save data
  const output = {
    category: 'creatures',
    count: formattedCreatures.length,
    items: formattedCreatures.map(({ imageUrl, ...rest }) => rest) // Remove imageUrl from final data
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${formattedCreatures.length} creatures to ${DATA_PATH}`);
}

// Run
scrapeCreatures().catch(console.error);
