/**
 * Scrape World Map Markers
 *
 * Fetches marker data from the ravenquest.tools tRPC API and saves it
 * as structured JSON files for bundling with the app.
 *
 * Also writes the hardcoded region labels (sourced from the client code).
 *
 * Usage: node scripts/scrape-worldmap-markers.js
 *
 * Output:
 *   data/worldmap-markers.json  — array of IBaseMarker objects
 *   data/worldmap-regions.json  — array of IRegionLabel objects
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');

const API_URL =
  'https://ravenquest.tools/api/trpc/map.list?batch=1&input=' +
  encodeURIComponent(
    JSON.stringify({
      0: { json: { mapType: 'surface', coordinateTypes: ['node', 'event'] } }
    })
  );

/**
 * Region labels — hardcoded in the ravenquest.tools client with pixel coordinates
 * on the 8192×4608 source image.
 */
const REGION_LABELS = [
  { name: 'Gilead Island', x: 2276, y: 3648, floor: 'surface' },
  { name: 'Sajecho Island', x: 3193, y: 2712, floor: 'surface' },
  { name: 'Harbor Island', x: 2095, y: 2400, floor: 'surface' },
  { name: 'Glaceforde', x: 2752, y: 890, floor: 'surface' },
  { name: 'Frost Steppes', x: 4984, y: 872, floor: 'surface' },
  { name: 'Elder Coast', x: 4171, y: 1459, floor: 'surface' },
  { name: 'Rohna Woods', x: 3904, y: 2090, floor: 'surface' },
  { name: 'Glademire', x: 4482, y: 2372, floor: 'surface' },
  { name: 'Forsaken Mountains', x: 4710, y: 2004, floor: 'surface' },
  { name: 'Fields of Despair', x: 5484, y: 1470, floor: 'surface' },
  { name: 'The Blotch', x: 5900, y: 1894, floor: 'surface' },
  { name: 'Crowhollow Bog', x: 5354, y: 2162, floor: 'surface' },
  { name: 'Zephyr Vale', x: 5692, y: 2560, floor: 'surface' },
  { name: 'Hadarak Desert', x: 4816, y: 3416, floor: 'surface' },
  { name: 'Ostera', x: 7416, y: 1736, floor: 'surface' }
];

/**
 * Map API coordinate type + node/event data to a marker category.
 */
function categorize(coord) {
  if (coord.type === 'event') return 'dynamic_event';
  if (coord.type === 'node' && coord.node) {
    const name = (coord.node.name || '').toLowerCase();
    if (name.includes('crafting') || name.includes('station')) return 'crafting_station';
    if (name.includes('fish')) return 'fishpost';
    return 'material_node';
  }
  return 'poi';
}

/**
 * Determine the icon filename for a marker.
 */
function getIcon(coord) {
  if (coord.type === 'event') return 'dynamic_event.webp';
  if (coord.node?.icon) return coord.node.icon.replace(/\.[^.]+$/, '.webp');
  return 'quest.webp';
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'RavenHUD-Scraper/1.0' } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      })
      .on('error', reject);
  });
}

async function main() {
  console.log('=== World Map Marker Scraper ===\n');

  // Fetch markers from API
  console.log('Fetching from ravenquest.tools API...');
  let apiMarkers = [];

  try {
    const response = await fetch(API_URL);
    const data = response[0]?.result?.data?.json || [];
    console.log(`  Received ${data.length} coordinates from API\n`);

    apiMarkers = data.map((coord, i) => ({
      id: coord.id || `api_${i}`,
      source: 'base',
      category: categorize(coord),
      name: coord.event?.name || coord.node?.name || `Marker ${i}`,
      description: coord.event?.description || coord.node?.description || '',
      x: Math.round(coord.x),
      y: Math.round(coord.y),
      floor: coord.mapType || 'surface',
      icon: getIcon(coord),
      label: coord.event?.name || coord.node?.name || ''
    }));
  } catch (err) {
    console.warn(`  API fetch failed: ${err.message}`);
    console.warn('  Continuing with empty API data — region labels will still be saved.\n');
  }

  // Write markers
  const markersPath = path.join(DATA_DIR, 'worldmap-markers.json');
  fs.writeFileSync(markersPath, JSON.stringify(apiMarkers, null, 2));
  console.log(`Saved ${apiMarkers.length} markers → ${markersPath}`);

  // Write region labels
  const regionsPath = path.join(DATA_DIR, 'worldmap-regions.json');
  fs.writeFileSync(regionsPath, JSON.stringify(REGION_LABELS, null, 2));
  console.log(`Saved ${REGION_LABELS.length} region labels → ${regionsPath}`);

  // Stats
  const byCategory = {};
  for (const m of apiMarkers) {
    byCategory[m.category] = (byCategory[m.category] || 0) + 1;
  }
  console.log('\nMarker categories:');
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
