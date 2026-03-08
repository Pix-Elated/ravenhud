#!/usr/bin/env node
/**
 * Image Sync Pipeline — Main Entry Point
 *
 * Downloads missing images from their respective sources (Ravendawn CDN,
 * Immutable blockchain, game API) and converts everything to WebP via Sharp.
 *
 * Usage:
 *   node scripts/sync-images/index.js                     # Full sync (unlimited)
 *   node scripts/sync-images/index.js --only=ravencards    # Specific adapter(s)
 *   node scripts/sync-images/index.js --dry-run            # Report gaps only
 *   node scripts/sync-images/index.js --limit=100          # Cap downloads per adapter
 *   node scripts/sync-images/index.js --fix-existing       # Re-convert JPG-as-WebP files
 *
 * Adapters:
 *   ravencards     — RavenCard creature images from Ravendawn CDN
 *   cosmetics      — Cosmetic NFT images from Immutable blockchain metadata
 *   ravenguardian  — Cosmetic images from RavenGuardian CDN (scraped data)
 *   items          — Items/materials/trophies/tradepacks/cosmetics from Ravendawn game API
 */

const { createLogger, flush } = require('./logger');

const log = createLogger('[pipeline]');

// =============================================================================
// Handle Ctrl+C gracefully
// =============================================================================
process.on('SIGINT', () => {
  log.warn('Cancelled by user');
  flush();
  process.exit(0);
});

process.on('SIGTERM', () => {
  flush();
  process.exit(0);
});

// =============================================================================
// Adapter Registry
// =============================================================================

const ADAPTERS = {
  ravencards: () => require('./adapters/ravencard'),
  cosmetics: () => require('./adapters/cosmetic'),
  ravenguardian: () => require('./adapters/ravenguardian'),
  items: () => require('./adapters/item'),
  munks: () => require('./adapters/munk'),
  moas: () => require('./adapters/moa')
};

// =============================================================================
// CLI Argument Parsing
// =============================================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    dryRun: false,
    limit: 0,
    fixExisting: false,
    only: null, // null = all adapters
    help: false
  };

  for (const arg of args) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--fix-existing') {
      options.fixExisting = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1], 10) || 0;
    } else if (arg.startsWith('--only=')) {
      options.only = arg
        .split('=')[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Image Sync Pipeline — Download and convert missing images to WebP

Usage:
  node scripts/sync-images/index.js [options]

Options:
  --dry-run          Report gaps without downloading anything
  --limit=N          Max downloads per adapter (0 = unlimited, default)
  --only=a,b         Run only specific adapters (comma-separated)
  --fix-existing     Re-convert existing files that aren't real WebP
  --help, -h         Show this help

Available adapters:
  ravencards         RavenCard creature images from Ravendawn CDN
  cosmetics          Cosmetic NFT images from Immutable blockchain metadata
  ravenguardian      Cosmetic images from RavenGuardian CDN (scraped data)
  items              Items/materials/trophies/tradepacks/cosmetics from game API
  munks              Munk PFP images from Immutable blockchain metadata
  moas               Moa PFP images from Immutable blockchain metadata

Examples:
  node scripts/sync-images/index.js                          # Full sync
  node scripts/sync-images/index.js --only=ravencards        # Just ravencards
  node scripts/sync-images/index.js --dry-run                # See what's missing
  node scripts/sync-images/index.js --limit=50               # Download up to 50 per adapter
  node scripts/sync-images/index.js --fix-existing           # Fix JPG-as-WebP files
`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const options = parseArgs(process.argv);

  if (options.help) {
    printHelp();
    return;
  }

  log.info('='.repeat(55));
  log.info('RavenHUD Image Sync Pipeline');
  log.info('='.repeat(55));

  if (options.dryRun) log.info('Mode: DRY RUN (no downloads)');
  if (options.limit > 0) log.info(`Limit: ${options.limit} per adapter`);
  if (options.fixExisting) log.info('Fix existing: ON');

  const adapterNames = options.only || Object.keys(ADAPTERS);

  // Validate adapter names
  for (const name of adapterNames) {
    if (!ADAPTERS[name]) {
      log.error(`Unknown adapter: "${name}"`);
      log.error(`Available: ${Object.keys(ADAPTERS).join(', ')}`);
      process.exit(1);
    }
  }

  log.info(`Adapters: ${adapterNames.join(', ')}`);
  log.info('='.repeat(55));

  const allResults = {};
  let totalDownloaded = 0;
  let totalFailed = 0;

  for (const name of adapterNames) {
    log.info(`--- ${name} ---`);
    const adapter = ADAPTERS[name]();

    try {
      const result = await adapter.run({
        dryRun: options.dryRun,
        limit: options.limit,
        fixExisting: options.fixExisting
      });

      allResults[name] = result;
      totalDownloaded += result.downloaded || 0;
      totalFailed += result.failed || 0;
    } catch (err) {
      log.error(`[${name}] Fatal error: ${err.message}`);
      allResults[name] = { error: err.message };
      totalFailed++;
    }
  }

  // Summary
  log.info('='.repeat(55));
  log.info('Summary');
  log.info('='.repeat(55));

  for (const [name, result] of Object.entries(allResults)) {
    if (result.error) {
      log.error(`${name}: ERROR — ${result.error}`);
    } else {
      const parts = [];
      if (result.downloaded > 0) parts.push(`${result.downloaded} downloaded`);
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
      if (result.failed > 0) parts.push(`${result.failed} failed`);
      if (result.fixed > 0) parts.push(`${result.fixed} fixed`);
      if (result.deduped > 0) parts.push(`${result.deduped} deduped`);
      log.info(`${name}: ${parts.join(', ') || 'nothing to do'}`);
    }
  }

  log.info('-'.repeat(55));
  log.info(`Total: ${totalDownloaded} downloaded, ${totalFailed} failed`);
  log.info('='.repeat(55));

  // Write download count to file so CI can use it for PR titles
  const fs = require('fs');
  fs.writeFileSync(
    'sync-images-result.json',
    JSON.stringify({
      downloaded: totalDownloaded,
      failed: totalFailed,
      adapters: Object.fromEntries(
        Object.entries(allResults).map(([name, r]) => [name, r.downloaded || 0])
      )
    })
  );

  flush();

  // Exit code: 0 if at least something succeeded or nothing to do
  // 1 only if every adapter that tried to download failed completely
  if (totalFailed > 0 && totalDownloaded === 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.error('Fatal error:', err);
  flush();
  process.exit(1);
});
