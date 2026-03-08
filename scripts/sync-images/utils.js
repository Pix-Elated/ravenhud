/**
 * Shared utilities for the image sync pipeline.
 *
 * nameToSnakeCase — converts display names to snake_case filenames.
 * getCategoryFolder — maps cosmetic category.level1 to asset folder name.
 * processQueue — bounded-concurrency parallel execution.
 */

/**
 * Convert a display name to snake_case filename (no extension).
 * Matches the pattern used in portfolio-service.ts and scrape-card-images.js:
 *   "Skeleton Soldier" → "skeleton_soldier"
 *   "High Elf Sorcerer" → "high_elf_sorcerer"
 *   "Boro'Gorom" → "boro_gorom"
 */
function nameToSnakeCase(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Map cosmetic category.level1 values to asset folder names.
 * Mirrors the mapping in cosmetics.component.ts.
 */
const CATEGORY_TO_FOLDER = {
  'House Decoration': 'house-decoration',
  Moa: 'moa',
  Outfit: 'outfit',
  Pet: 'pet',
  Ship: 'ship',
  Teleport: 'teleport',
  Wagon: 'wagon',
  'Weapon Shine': 'weapon-shine'
};

function getCategoryFolder(level1) {
  return CATEGORY_TO_FOLDER[level1] || null;
}

/**
 * Execute an async function over an array of items with bounded concurrency.
 * Returns Promise.allSettled results (never rejects).
 *
 * @param {Array} items - Items to process
 * @param {number} concurrency - Max parallel executions
 * @param {Function} fn - Async function (item) => result
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function processQueue(items, concurrency, fn) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const p = fn(item).then(
      (value) => {
        executing.delete(p);
        return value;
      },
      (reason) => {
        executing.delete(p);
        throw reason;
      }
    );
    executing.add(p);
    results.push(p);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(results);
}

/**
 * Simple progress logger that overwrites the current line.
 */
function logProgress(adapter, current, total, extra = '') {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
  process.stdout.write(`\r  [${adapter}] ${bar} ${current}/${total} ${extra}`);
  if (current === total) {
    process.stdout.write('\n');
  }
}

module.exports = {
  nameToSnakeCase,
  getCategoryFolder,
  CATEGORY_TO_FOLDER,
  processQueue,
  logProgress
};
