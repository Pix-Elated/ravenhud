#!/usr/bin/env node
/* eslint-disable no-underscore-dangle, no-restricted-syntax */
/**
 * Ravendawn API Data Sync Script
 *
 * Fetches data from the official Ravendawn API and updates local JSON files.
 * Run with: node scripts/sync-api-data.js [--all] [--endpoint=<name>]
 *
 * Examples:
 *   node scripts/sync-api-data.js --all           # Sync all endpoints
 *   node scripts/sync-api-data.js --endpoint=farming  # Sync only farming
 *   node scripts/sync-api-data.js --endpoint=creatures # Sync only creatures
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// =============================================================================
// Handle Ctrl+C gracefully - stop immediately
// =============================================================================
let cancelled = false;

process.on('SIGINT', () => {
  cancelled = true;
  console.log('\n\n⛔ Cancelled by user');
  process.exit(0);
});

process.on('SIGTERM', () => {
  cancelled = true;
  process.exit(0);
});

// =============================================================================
// Configuration
// =============================================================================

const API_BASE = 'https://api.ravendawn.online';
const SWAGGER_URL = `${API_BASE}/swagger/doc.json`;
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(__dirname, '..', 'data', '.api-cache');

// Endpoint mappings: API path -> local file + transform function
const ENDPOINT_CONFIG = {
  // Priority 1: Farming/Land data
  farming: {
    endpoint: '/v1/professions/farming',
    localFile: 'crops.json',
    transform: transformFarmingData,
    merge: true // Merge with existing data
  },
  herbalism: {
    endpoint: '/v1/professions/herbalism',
    localFile: 'crops.json',
    transform: transformHerbalismData,
    merge: true
  },
  husbandry: {
    endpoint: '/v1/professions/husbandry',
    localFile: 'husbandry.json',
    transform: null // Save raw
  },

  // Priority 2: Creatures & Materials
  creatures: {
    endpoint: '/v1/creatures',
    localFile: 'creatures-api.json',
    transform: transformCreaturesData
  },

  // Priority 3: Crafting professions
  cooking: {
    endpoint: '/v1/professions/cooking',
    localFile: 'cooking.json',
    transform: null
  },
  alchemy: {
    endpoint: '/v1/professions/alchemy',
    localFile: 'alchemy.json',
    transform: null
  },
  blacksmithing: {
    endpoint: '/v1/professions/blacksmithing',
    localFile: 'blacksmithing.json',
    transform: null
  },
  carpentry: {
    endpoint: '/v1/professions/carpentry',
    localFile: 'carpentry.json',
    transform: null
  },
  weaving: {
    endpoint: '/v1/professions/weaving',
    localFile: 'weaving.json',
    transform: null
  },

  // Priority 4: Gathering professions
  fishing: {
    endpoint: '/v1/professions/fishing',
    localFile: 'fishing.json',
    transform: null
  },
  mining: {
    endpoint: '/v1/professions/mining',
    localFile: 'mining.json',
    transform: null
  },
  woodcutting: {
    endpoint: '/v1/professions/woodcutting',
    localFile: 'woodcutting.json',
    transform: null
  },

  // Priority 5: Items & Consumables
  items: {
    endpoint: '/v1/items',
    localFile: 'items.json',
    transform: null
  },
  foods: {
    endpoint: '/v1/consumables/foods',
    localFile: 'foods.json',
    transform: null
  },
  potions: {
    endpoint: '/v1/consumables/potions',
    localFile: 'potions.json',
    transform: null
  },

  // Priority 6: Game data
  spells: {
    endpoint: '/v1/spells',
    localFile: 'spells.json',
    transform: null
  },
  ravencards: {
    endpoint: '/v1/ravencards',
    localFile: 'ravencards-api.json',
    transform: null
  },
  regions: {
    endpoint: '/v1/regions',
    localFile: 'regions.json',
    transform: null
  },
  archetypes: {
    endpoint: '/v1/archetypes',
    localFile: 'archetypes.json',
    transform: null
  }
};

// =============================================================================
// HTTP Utilities
// =============================================================================

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    console.log(`  Fetching: ${url}`);

    https
      .get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Failed to parse JSON from ${url}: ${err.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

// =============================================================================
// Transform Functions
// =============================================================================

/**
 * Transform farming API data to match our crops.json format
 */
function transformFarmingData(apiData) {
  return apiData.map((crop) => ({
    id: crop.id,
    name: crop.name,
    type: 'crop',
    category: categorizeCrop(crop.name),
    skillRequired: crop.skillRequired,
    growthTime: crop.growingTime, // Keep in seconds
    growthTimeHours: crop.growingTime / 3600,
    experience: crop.experience,
    yields: crop.items.map((item) => ({
      id: item.id,
      name: item.name,
      min: item.count[0],
      max: item.count[1],
      avg: (item.count[0] + item.count[1]) / 2
    })),
    // Preserve API metadata
    _apiSource: 'farming',
    _lastSync: new Date().toISOString()
  }));
}

/**
 * Transform herbalism API data to match our crops.json format
 */
function transformHerbalismData(apiData) {
  return apiData.map((herb) => ({
    id: herb.id,
    name: herb.name,
    type:
      herb.name.toLowerCase().includes('mushroom') ||
      herb.name.toLowerCase().includes('shroom') ||
      herb.name.toLowerCase().includes('cap')
        ? 'mushroom'
        : 'herb',
    category: 'herbalism',
    skillRequired: herb.skillRequired,
    growthTime: herb.growingTime,
    growthTimeHours: herb.growingTime / 3600,
    experience: herb.experience,
    yields: herb.items.map((item) => ({
      id: item.id,
      name: item.name,
      min: item.count[0],
      max: item.count[1],
      avg: (item.count[0] + item.count[1]) / 2
    })),
    _apiSource: 'herbalism',
    _lastSync: new Date().toISOString()
  }));
}

/**
 * Transform creatures API data - dedupe and organize
 */
function transformCreaturesData(apiData) {
  // Deduplicate by outfitId + name combo
  const seen = new Map();

  apiData.forEach((creature) => {
    const key = `${creature.outfitId}-${creature.name}`;
    if (!seen.has(key) || creature.items.length > seen.get(key).items.length) {
      seen.set(key, creature);
    }
  });

  return Array.from(seen.values())
    .map((creature) => ({
      outfitId: creature.outfitId,
      name: creature.name,
      image: creature.image,
      drops: creature.items.map((item) => ({
        name: item.name,
        rarity: item.chance_text,
        minLevel: item.minLevel || null
      })),
      dropCount: creature.items.length,
      _lastSync: new Date().toISOString()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Categorize crops by name patterns
 */
function categorizeCrop(name) {
  const lowerName = name.toLowerCase();

  if (['wheat', 'barley', 'oat', 'rye', 'corn', 'rice'].some((g) => lowerName.includes(g))) {
    return 'grain';
  }
  if (
    ['potato', 'carrot', 'onion', 'turnip', 'beet', 'radish', 'garlic'].some((v) =>
      lowerName.includes(v)
    )
  ) {
    return 'vegetable';
  }
  if (
    ['berry', 'grape', 'apple', 'melon', 'pumpkin', 'tomato'].some((f) => lowerName.includes(f))
  ) {
    return 'fruit';
  }
  if (['cotton', 'flax', 'hemp'].some((f) => lowerName.includes(f))) {
    return 'fiber';
  }
  if (['flower', 'rose', 'lily', 'poppy'].some((f) => lowerName.includes(f))) {
    return 'flower';
  }

  return 'other';
}

// =============================================================================
// File Operations
// =============================================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveJSON(filepath, data) {
  ensureDir(path.dirname(filepath));
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`  ✓ Saved: ${filepath}`);
}

function loadJSON(filepath) {
  if (fs.existsSync(filepath)) {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }
  return null;
}

function saveCache(name, data) {
  ensureDir(CACHE_DIR);
  const cachePath = path.join(CACHE_DIR, `${name}.json`);
  saveJSON(cachePath, {
    timestamp: new Date().toISOString(),
    data
  });
}

// =============================================================================
// Sync Logic
// =============================================================================

async function syncEndpoint(name) {
  const config = ENDPOINT_CONFIG[name];
  if (!config) {
    console.error(`Unknown endpoint: ${name}`);
    return false;
  }

  console.log(`\n📥 Syncing: ${name}`);

  try {
    // Fetch from API
    const apiData = await fetchJSON(`${API_BASE}${config.endpoint}`);

    // Save raw cache
    saveCache(name, apiData);

    // Transform if needed
    let processedData = config.transform ? config.transform(apiData) : apiData;

    // Handle merge mode (for crops.json which has multiple sources)
    const localPath = path.join(DATA_DIR, config.localFile);

    if (config.merge && fs.existsSync(localPath)) {
      const existing = loadJSON(localPath);

      // Handle wrapped structure with metadata/items (our format)
      if (existing && existing.items && Array.isArray(existing.items)) {
        console.log(`  Merging into existing structure (${existing.items.length} items)...`);

        // Build a map of existing items by ID for quick lookup
        const existingById = new Map(existing.items.map((item) => [item.id, item]));

        // Merge new items - update existing or add new with defaults
        let added = 0;
        let updated = 0;
        processedData.forEach((newItem) => {
          const existingItem = existingById.get(newItem.id);
          if (existingItem) {
            // Update existing item but preserve local fields the API doesn't provide
            Object.assign(existingItem, {
              ...newItem,
              // Preserve these local-only fields if they exist
              width: existingItem.width ?? newItem.width ?? 2,
              height: existingItem.height ?? newItem.height ?? 2,
              size: existingItem.size ?? newItem.size ?? 'small',
              icon: existingItem.icon ?? newItem.icon ?? null,
              level: existingItem.level ?? newItem.skillRequired ?? 1,
              category: existingItem.category ?? newItem.category ?? 'farming'
            });
            updated++;
          } else {
            // Add new item with defaults for missing fields
            existing.items.push({
              ...newItem,
              width: newItem.width ?? 2,
              height: newItem.height ?? 2,
              size: newItem.size ?? 'small',
              icon: newItem.icon ?? null,
              level: newItem.skillRequired ?? 1,
              category: newItem.category ?? 'farming'
            });
            added++;
          }
        });

        // Update metadata
        existing.metadata = existing.metadata || {};
        existing.metadata.itemCount = existing.items.length;
        existing.metadata.lastUpdated = new Date().toISOString().split('T')[0];
        existing.metadata.lastApiSync = new Date().toISOString();

        console.log(`  ✓ Merged: ${added} added, ${updated} updated`);
        processedData = existing;
      } else if (Array.isArray(existing) && Array.isArray(processedData)) {
        // Fallback for plain array files (legacy behavior)
        const filtered = existing.filter((item) => item._apiSource !== name);
        processedData = [...filtered, ...processedData];
      }
    }

    // Save processed data
    saveJSON(localPath, processedData);

    console.log(`  ✓ ${name}: ${Array.isArray(apiData) ? apiData.length : 'N/A'} items`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    return false;
  }
}

async function syncAll() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Ravendawn API Data Sync');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Base URL: ${API_BASE}`);
  console.log(`  Data Dir: ${DATA_DIR}`);
  console.log('═══════════════════════════════════════════════════════════════');

  const results = {
    success: [],
    failed: []
  };

  for (const name of Object.keys(ENDPOINT_CONFIG)) {
    if (cancelled) break;

    const success = await syncEndpoint(name);
    if (success) {
      results.success.push(name);
    } else {
      results.failed.push(name);
    }
  }

  if (cancelled) return results;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✓ Success: ${results.success.length}/${Object.keys(ENDPOINT_CONFIG).length}`);
  if (results.failed.length > 0) {
    console.log(`  ✗ Failed: ${results.failed.join(', ')}`);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  return results;
}

async function fetchSwaggerSpec() {
  console.log('Fetching OpenAPI specification...');
  const spec = await fetchJSON(SWAGGER_URL);
  saveJSON(path.join(CACHE_DIR, 'swagger-spec.json'), spec);

  console.log('\nAvailable endpoints:');
  Object.keys(spec.paths).forEach((p) => console.log(`  ${p}`));

  return spec;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Ravendawn API Data Sync

Usage:
  node sync-api-data.js [options]

Options:
  --all                 Sync all configured endpoints
  --endpoint=<name>     Sync specific endpoint (can be used multiple times)
  --list                List all available endpoints
  --swagger             Fetch and display the OpenAPI spec
  --help, -h            Show this help

Available endpoints:
  ${Object.keys(ENDPOINT_CONFIG).join(', ')}

Examples:
  node sync-api-data.js --all
  node sync-api-data.js --endpoint=farming --endpoint=creatures
  node sync-api-data.js --swagger
`);
    return;
  }

  if (args.includes('--list')) {
    console.log('Available endpoints:');
    Object.entries(ENDPOINT_CONFIG).forEach(([name, config]) => {
      console.log(`  ${name.padEnd(15)} -> ${config.localFile} (${config.endpoint})`);
    });
    return;
  }

  if (args.includes('--swagger')) {
    await fetchSwaggerSpec();
    return;
  }

  if (args.includes('--all')) {
    await syncAll();
    return;
  }

  // Handle specific endpoints
  const endpoints = args.filter((a) => a.startsWith('--endpoint=')).map((a) => a.split('=')[1]);

  if (endpoints.length > 0) {
    for (const endpoint of endpoints) {
      await syncEndpoint(endpoint);
    }
    return;
  }

  // Default: show help
  console.log('No action specified. Use --help for usage information.');
  console.log('Quick start: node sync-api-data.js --all');
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

// Export for use as module
module.exports = {
  syncEndpoint,
  syncAll,
  fetchSwaggerSpec,
  ENDPOINT_CONFIG
};
