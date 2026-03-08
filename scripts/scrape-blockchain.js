#!/usr/bin/env node
/**
 * Blockchain Metadata Scraper
 *
 * Scrapes ALL unique NFT types and marketplace data from the Immutable zkEVM
 * blockchain for the 5 RavenQuest collections. Outputs committed JSON files
 * to data/blockchain/ for use by the image sync pipeline and the app.
 *
 * Collections:
 *   Land        — Unique (1:1), base_uri enumeration + on-chain merge
 *   RavenCards  — Stacked, deduplicate by name → ~240 unique types
 *   Cosmetics   — Stacked, deduplicate by name → ~40-70 unique types
 *   Munks       — Unique PFP, base_uri enumeration + on-chain merge
 *   Moas        — Unique PFP, base_uri enumeration + on-chain merge
 *
 * Usage:
 *   node scripts/scrape-blockchain.js                      # All collections
 *   node scripts/scrape-blockchain.js --only=ravencards     # Specific
 *   node scripts/scrape-blockchain.js --metadata-only       # Skip marketplace
 *   node scripts/scrape-blockchain.js --force               # Ignore freshness
 *   node scripts/scrape-blockchain.js --list                # Show collections
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// =============================================================================
// Handle Ctrl+C gracefully
// =============================================================================
let cancelled = false;

process.on('SIGINT', () => {
  cancelled = true;
  console.log('\n\nCancelled by user');
  process.exit(0);
});

process.on('SIGTERM', () => {
  cancelled = true;
  process.exit(0);
});

// =============================================================================
// Configuration
// =============================================================================

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'blockchain');
const CHAIN = 'imtbl-zkevm-mainnet';
const IMX_API = 'https://api.immutable.com/v1/chains';

const PAGE_SIZE = 200;
const API_DELAY_MS = 500;

// Immutable Hub publishable key — raises rate limit from 5 req/s to 50 req/s.
// Safe to commit (client-safe key, identifies the project, no write access).
const IMMUTABLE_PUBLISHABLE_KEY = 'pk_imapik-a2QXnS4pHeR9xTXN1pwY';
const FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fallback page limit for unique collections when base_uri is unavailable
const UNIQUE_FALLBACK_PAGES = 5; // 5 pages * 200 = 1000 tokens max

// base_uri enumeration: stop after this many consecutive 404s
const BASE_URI_STOP_AFTER = 10;

// base_uri enumeration: how many requests to run in parallel
const BASE_URI_CONCURRENCY = 5;

// Early-stop: if N consecutive pages produce no new unique names, stop
const STACKED_STALE_PAGE_LIMIT = 3;

/**
 * Collection registry. 'stacked' collections deduplicate by name.
 * 'unique' collections sample tokens and build attribute summaries.
 */
const COLLECTIONS = {
  ravencards: {
    name: 'RavenCards',
    contract: '0xb254d62afe0432214db60c457a4d751c655cfbde',
    type: 'stacked'
  },
  cosmetics: {
    name: 'Cosmetics',
    contract: '0x924904fbcd172b79261307063518d12310ab1bb8',
    type: 'stacked'
  },
  land: {
    name: 'Land',
    contract: '0x62f2966c417df805d2bc3b685a87c2ab3800fee9',
    type: 'unique'
  },
  munks: {
    name: 'Munks',
    contract: '0x024720ccabf02a002c279b0e84b62b572cfeeaa0',
    type: 'unique'
  },
  moas: {
    name: 'Moas',
    contract: '0xb43b3eb53a09abef18eed9d9901a7df1bd3f327a',
    type: 'unique'
  }
};

// =============================================================================
// HTTP Utility
// =============================================================================

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'RavenHUD-BlockchainScraper/1.0',
            'x-immutable-publishable-key': IMMUTABLE_PUBLISHABLE_KEY
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode === 429) {
              reject(new Error('Rate limited (HTTP 429) — try again in a minute'));
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`JSON parse error: ${err.message}`));
            }
          });
          res.on('error', reject);
        }
      )
      .on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nameToSnakeCase(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// =============================================================================
// File Helpers
// =============================================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function saveJSON(filepath, data) {
  ensureDir(path.dirname(filepath));
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function loadJSON(filepath) {
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return null;
  }
}

// =============================================================================
// Immutable API Helpers
// =============================================================================

/**
 * Build the NFT listing URL for a collection.
 */
function nftUrl(contract) {
  return `${IMX_API}/${CHAIN}/collections/${contract}/nfts`;
}

/**
 * Build the active listings URL for a collection.
 */
function listingsUrl(contract) {
  return `${IMX_API}/${CHAIN}/orders/listings`;
}

/**
 * Build the activities URL for a collection.
 */
function activitiesUrl() {
  return `${IMX_API}/${CHAIN}/activities`;
}

/**
 * Fetch a page of NFTs from a collection.
 * Returns { result: NFT[], page: { next_cursor } }
 */
async function fetchNFTPage(contract, cursor) {
  let url = `${nftUrl(contract)}?page_size=${PAGE_SIZE}`;
  if (cursor) url += `&page_cursor=${encodeURIComponent(cursor)}`;
  return fetchJSON(url);
}

/**
 * Fetch active listings for a collection, sorted by price ascending (cheapest first).
 * Returns { result: Order[], page: { next_cursor } }
 */
async function fetchListingsPage(contract, cursor) {
  let url = `${listingsUrl(contract)}?sell_item_contract_address=${contract}&status=ACTIVE&page_size=${PAGE_SIZE}&sort_by=buy_item_amount&direction=asc`;
  if (cursor) url += `&page_cursor=${encodeURIComponent(cursor)}`;
  return fetchJSON(url);
}

/**
 * Fetch recent sale activities for a collection.
 * Returns { result: Activity[], page: { next_cursor } }
 */
async function fetchSalesPage(contract, cursor) {
  let url = `${activitiesUrl()}?contract_address=${contract}&activity_type=sale&page_size=50`;
  if (cursor) url += `&page_cursor=${encodeURIComponent(cursor)}`;
  return fetchJSON(url);
}

// =============================================================================
// Collection Metadata + base_uri Enumeration
// =============================================================================

/**
 * Fetch the collection metadata from Immutable to get the base_uri.
 * The base_uri is the ERC721 tokenURI root — e.g. "https://ravenquest.io/nft/data/munk".
 * Individual token metadata lives at {base_uri}/{tokenId}.
 *
 * The Immutable API wraps the response in a { result: { ... } } object.
 */
async function fetchCollectionMeta(contract) {
  const url = `${IMX_API}/${CHAIN}/collections/${contract}`;
  const response = await fetchJSON(url);
  return response.result || response;
}

/**
 * Fetch a single token's metadata from the collection's base_uri.
 * Returns the parsed JSON or null if the token doesn't exist (404).
 */
async function fetchBaseUriToken(baseUri, tokenId) {
  // Ensure no double-slash between baseUri and tokenId
  const url = baseUri.replace(/\/$/, '') + '/' + tokenId;
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'RavenHUD-BlockchainScraper/1.0',
            'x-immutable-publishable-key': IMMUTABLE_PUBLISHABLE_KEY
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode === 404) {
              resolve(null);
              return;
            }
            if (res.statusCode === 429) {
              reject(new Error('Rate limited (HTTP 429) — try again in a minute'));
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error(`JSON parse error for token ${tokenId}: ${err.message}`));
            }
          });
          res.on('error', reject);
        }
      )
      .on('error', reject);
  });
}

/**
 * Enumerate all tokens from a collection's base_uri by incrementing token IDs
 * starting from 1 until BASE_URI_STOP_AFTER consecutive 404s.
 *
 * Uses a sliding-window concurrency pool to stay fast without hammering the CDN.
 * Returns an array of extracted NFT records.
 */
async function enumerateBaseUri(collectionKey, baseUri) {
  const records = [];
  let consecutiveNotFound = 0;
  let tokenId = 1;

  console.log(`  [${collectionKey}] Enumerating tokens from base_uri...`);

  while (consecutiveNotFound < BASE_URI_STOP_AFTER) {
    if (cancelled) break;

    // Build a batch of IDs to fetch in parallel
    const batchIds = [];
    for (let i = 0; i < BASE_URI_CONCURRENCY; i++) {
      batchIds.push(tokenId + i);
    }

    const results = await Promise.all(
      batchIds.map(async (id) => {
        try {
          const meta = await fetchBaseUriToken(baseUri, id);
          return { id, meta };
        } catch (err) {
          // On rate limit or network error, return as null (will count as not-found)
          console.error(`  [${collectionKey}] Error fetching token ${id}: ${err.message}`);
          return { id, meta: null, error: true };
        }
      })
    );

    // Process results in order to maintain the consecutive-404 counter correctly
    for (const { id, meta, error } of results) {
      if (error) {
        // On error, don't count toward the stop condition — just skip this token
        continue;
      }

      if (!meta) {
        consecutiveNotFound++;
        if (consecutiveNotFound >= BASE_URI_STOP_AFTER) break;
        continue;
      }

      consecutiveNotFound = 0;

      const name = meta.name || null;
      const image = meta.image || null;
      const description = meta.description || null;
      const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
      const attributes = attrs
        .filter((a) => a.trait_type && a.value !== undefined && a.value !== null)
        .map((a) => ({ trait_type: String(a.trait_type), value: String(a.value) }));

      records.push({
        tokenId: String(id),
        name,
        nameNormalized: name ? nameToSnakeCase(name) : null,
        image,
        description,
        attributes
      });
    }

    tokenId += BASE_URI_CONCURRENCY;

    // Progress log every 100 tokens
    if (records.length > 0 && records.length % 100 < BASE_URI_CONCURRENCY) {
      console.log(
        `  [${collectionKey}] Enumerated ${records.length} tokens so far (ID ${tokenId - 1})...`
      );
    }

    // Small delay between batches to be polite
    await sleep(100);
  }

  console.log(
    `  [${collectionKey}] base_uri enumeration complete: ${records.length} tokens found (IDs 1-${tokenId - BASE_URI_CONCURRENCY - 1})`
  );
  return records;
}

// =============================================================================
// NFT Attribute/Metadata Extraction
// =============================================================================

/**
 * Extract normalized attributes from an NFT's metadata.
 * Handles multiple formats returned by Immutable.
 */
function extractAttributes(nft) {
  const attrs = nft.metadata?.attributes || nft.attributes || [];
  if (!Array.isArray(attrs)) return [];
  return attrs
    .filter((a) => a.trait_type && a.value !== undefined && a.value !== null)
    .map((a) => ({ trait_type: String(a.trait_type), value: String(a.value) }));
}

/**
 * Extract a clean NFT record from an API response item.
 */
function extractNFTRecord(nft) {
  const name = nft.name || nft.metadata?.name || null;
  const image = nft.image || nft.metadata?.image || null;
  const description = nft.description || nft.metadata?.description || null;
  const attributes = extractAttributes(nft);

  return {
    tokenId: nft.token_id || null,
    name,
    nameNormalized: name ? nameToSnakeCase(name) : null,
    image,
    description,
    attributes
  };
}

// =============================================================================
// Marketplace Data
// =============================================================================

/**
 * Parse price from a listing order's buy side.
 * The buy array items can be:
 *   - { type: "NATIVE", amount: "..." } — native IMX token (18 decimals)
 *   - { type: "ERC20", contract_address: "0x...", amount: "..." } — ERC20 token
 * Returns { price: number, currency: string }
 */
function parseListingPrice(order) {
  const buyItems = order.buy || [];
  const buyItem = buyItems[0];
  if (!buyItem || !buyItem.amount) return { price: 0, currency: 'UNKNOWN' };

  const rawAmount = parseFloat(buyItem.amount);

  // ERC20 contract address → currency name
  const tokenMap = {
    '0x6de8acc0d406837030ce4dd28e7c08c5a96a30d2': 'USDC',
    '0x52a6c53869ce09a731cd772f245b97a4401d3348': 'USDC',
    '0x3a0c2ba54d6cbd3121f01b96dfd20e99d1696c9d': 'IMX',
    '0x8a1e8cf52954c8d72907774d4b2b81f38dd1c5c4': 'QUEST'
  };

  let currency;
  let price;

  if (buyItem.type === 'NATIVE') {
    // Native IMX token — 18 decimals
    currency = 'IMX';
    price = rawAmount / 1e18;
  } else {
    // ERC20 — identify by contract address
    const contractAddr = (buyItem.contract_address || '').toLowerCase();
    currency = tokenMap[contractAddr] || 'ERC20';

    // USDC uses 6 decimals, everything else (IMX/QUEST) uses 18
    if (currency === 'USDC') {
      price = rawAmount / 1e6;
    } else {
      price = rawAmount / 1e18;
    }
  }

  return { price: Math.round(price * 100) / 100, currency };
}

/**
 * Fetch marketplace data for a collection: active listing count + floor + recent sales.
 * Returns the marketplace section of the output JSON.
 */
async function scrapeMarketplace(collectionKey, contract) {
  const marketplace = {
    activeListings: 0,
    floorPrice: null,
    floorCurrency: null,
    recentSales: []
  };

  // --- Active Listings (first page only — enough for count + floor) ---
  try {
    console.log(`  [${collectionKey}] Fetching active listings...`);
    const response = await fetchListingsPage(contract, null);
    const listings = response.result || [];
    marketplace.activeListings = listings.length;

    // Floor = cheapest listing (already sorted asc)
    if (listings.length > 0) {
      const floor = parseListingPrice(listings[0]);
      marketplace.floorPrice = floor.price;
      marketplace.floorCurrency = floor.currency;
    }

    // If there's a next page, there are more listings than our page size
    if (response.page?.next_cursor) {
      // Approximate — we know there are at least PAGE_SIZE+1
      marketplace.activeListings = `${PAGE_SIZE}+`;
    }
  } catch (err) {
    console.error(`  [${collectionKey}] Listings error: ${err.message}`);
  }

  await sleep(API_DELAY_MS);

  // --- Recent Sales (first page, up to 50) ---
  try {
    console.log(`  [${collectionKey}] Fetching recent sales...`);
    const response = await fetchSalesPage(contract, null);
    const activities = response.result || [];

    // ERC20 contract address → currency name (same map as listings)
    const saleTokenMap = {
      '0x6de8acc0d406837030ce4dd28e7c08c5a96a30d2': 'USDC',
      '0x52a6c53869ce09a731cd772f245b97a4401d3348': 'USDC',
      '0x3a0c2ba54d6cbd3121f01b96dfd20e99d1696c9d': 'IMX',
      '0x8a1e8cf52954c8d72907774d4b2b81f38dd1c5c4': 'QUEST'
    };

    for (const activity of activities) {
      const details = activity.details || {};
      // details.asset is an array of sold items
      const assets = Array.isArray(details.asset) ? details.asset : [];
      const firstAsset = assets[0] || {};
      const payment = details.payment || {};

      const tokenId = firstAsset.token_id || null;

      // Determine currency from payment token
      const payToken = payment.token || {};
      const payAddr = (payToken.contract_address || '').toLowerCase();
      const currency =
        payToken.contract_type === 'native' ? 'IMX' : saleTokenMap[payAddr] || 'ERC20';

      // Parse price from price_excluding_fees (raw amount)
      const rawPrice = parseFloat(payment.price_excluding_fees || '0');
      let price = 0;
      if (currency === 'USDC') {
        price = Math.round((rawPrice / 1e6) * 100) / 100;
      } else if (rawPrice > 0) {
        price = Math.round((rawPrice / 1e18) * 100) / 100;
      }

      marketplace.recentSales.push({
        tokenId,
        price,
        currency,
        timestamp: activity.updated_at || activity.indexed_at || null
      });
    }
  } catch (err) {
    console.error(`  [${collectionKey}] Sales error: ${err.message}`);
  }

  // Sort for deterministic output (prevents false git diffs from API order changes)
  marketplace.recentSales.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));

  return marketplace;
}

// =============================================================================
// Stacked Collection Scraper (RavenCards, Cosmetics)
// =============================================================================

/**
 * Scrape a stacked collection — paginate all NFTs, deduplicate by normalized name.
 * Returns an array of unique type records.
 */
async function scrapeStacked(collectionKey, contract) {
  const types = new Map(); // nameNormalized → record
  let cursor = null;
  let pageNum = 0;
  let stalePages = 0; // consecutive pages with no new types

  console.log(`  [${collectionKey}] Paginating NFT metadata...`);

  do {
    if (cancelled) break;

    try {
      const response = await fetchNFTPage(contract, cursor);
      const nfts = response.result || [];
      pageNum++;

      let newThisPage = 0;

      for (const nft of nfts) {
        const record = extractNFTRecord(nft);
        if (!record.name || !record.nameNormalized) continue;

        if (!types.has(record.nameNormalized)) {
          // Remove tokenId for stacked types — it's not meaningful
          const { tokenId, ...typeRecord } = record;
          types.set(record.nameNormalized, typeRecord);
          newThisPage++;
        }
      }

      console.log(
        `  [${collectionKey}] Page ${pageNum}: ${nfts.length} NFTs, ${newThisPage} new types (${types.size} total)`
      );

      // Early-stop if no new types found for N consecutive pages
      if (newThisPage === 0) {
        stalePages++;
        if (stalePages >= STACKED_STALE_PAGE_LIMIT) {
          console.log(
            `  [${collectionKey}] No new types for ${STACKED_STALE_PAGE_LIMIT} pages — stopping early`
          );
          break;
        }
      } else {
        stalePages = 0;
      }

      cursor = response.page?.next_cursor || null;
      if (cursor) await sleep(API_DELAY_MS);
    } catch (err) {
      console.error(`  [${collectionKey}] API error on page ${pageNum + 1}: ${err.message}`);
      break;
    }
  } while (cursor);

  console.log(`  [${collectionKey}] Found ${types.size} unique types across ${pageNum} pages`);
  return Array.from(types.values());
}

// =============================================================================
// Unique Collection Scraper (Land, Munks, Moas)
// =============================================================================

/**
 * Scrape a unique collection using two data sources:
 *
 *   1. base_uri enumeration — The ERC721 contract's base_uri (from Immutable
 *      collection metadata) hosts metadata for ALL tokens, including those not
 *      yet minted on-chain. We iterate token IDs 1, 2, 3, ... until we hit a
 *      run of consecutive 404s. This is the primary source.
 *
 *   2. Immutable API pagination — Fallback if base_uri is unavailable, and also
 *      used to pick up any on-chain tokens that the base_uri might miss.
 *
 * Results from both sources are merged (deduplicated by tokenId), with
 * base_uri records preferred since they're the canonical metadata source.
 *
 * Returns { sampleTokens: [], attributeSummary: {}, totalScanned: number }
 */
async function scrapeUnique(collectionKey, contract) {
  const tokenMap = new Map(); // tokenId → record (dedup key)

  // --- Phase 1: Try base_uri enumeration (gets ALL tokens, minted or not) ---
  let baseUri = null;
  try {
    console.log(`  [${collectionKey}] Fetching collection metadata for base_uri...`);
    const meta = await fetchCollectionMeta(contract);
    baseUri = meta.base_uri || null;
  } catch (err) {
    console.error(`  [${collectionKey}] Could not fetch collection metadata: ${err.message}`);
  }

  if (baseUri && !cancelled) {
    console.log(`  [${collectionKey}] base_uri: ${baseUri}`);
    const records = await enumerateBaseUri(collectionKey, baseUri);
    for (const record of records) {
      if (record.tokenId) tokenMap.set(record.tokenId, record);
    }
    console.log(`  [${collectionKey}] base_uri provided ${tokenMap.size} tokens`);
  }

  // --- Phase 2: Immutable API pagination (merge in on-chain tokens) ---
  if (!cancelled) {
    let cursor = null;
    let pageNum = 0;
    let newFromApi = 0;
    // If base_uri gave us a good result, just do a single pass to fill gaps.
    // If base_uri was unavailable, fall back to the old sampling approach.
    const maxPages = tokenMap.size > 0 ? 100 : UNIQUE_FALLBACK_PAGES;

    console.log(`  [${collectionKey}] Merging on-chain tokens from Immutable API...`);

    do {
      if (cancelled) break;
      if (pageNum >= maxPages) break;

      try {
        const response = await fetchNFTPage(contract, cursor);
        const nfts = response.result || [];
        pageNum++;

        for (const nft of nfts) {
          const record = extractNFTRecord(nft);
          if (!record.name || !record.tokenId) continue;

          // Only add if base_uri didn't already provide this token
          if (!tokenMap.has(record.tokenId)) {
            tokenMap.set(record.tokenId, record);
            newFromApi++;
          }
        }

        console.log(
          `  [${collectionKey}] API page ${pageNum}: ${nfts.length} tokens, ${newFromApi} new (${tokenMap.size} total)`
        );

        cursor = response.page?.next_cursor || null;
        if (cursor && pageNum < maxPages) await sleep(API_DELAY_MS);
      } catch (err) {
        console.error(`  [${collectionKey}] API error on page ${pageNum + 1}: ${err.message}`);
        break;
      }
    } while (cursor && pageNum < maxPages);
  }

  // --- Build final results ---
  // Sort tokens by numeric ID for stable output
  const sampleTokens = Array.from(tokenMap.values()).sort(
    (a, b) => Number(a.tokenId) - Number(b.tokenId)
  );

  // Build attribute summary
  const attributeValues = {}; // trait_type → Set of values
  for (const record of sampleTokens) {
    for (const attr of record.attributes) {
      if (!attributeValues[attr.trait_type]) {
        attributeValues[attr.trait_type] = new Set();
      }
      attributeValues[attr.trait_type].add(attr.value);
    }
  }

  const attributeSummary = {};
  for (const [trait, values] of Object.entries(attributeValues)) {
    attributeSummary[trait] = Array.from(values).sort();
  }

  console.log(
    `  [${collectionKey}] Total: ${sampleTokens.length} tokens, ${Object.keys(attributeSummary).length} trait types`
  );

  return {
    totalScanned: sampleTokens.length,
    sampleTokens,
    attributeSummary
  };
}

// =============================================================================
// Collection Scraper Orchestrator
// =============================================================================

/**
 * Scrape a single collection and save the result.
 *
 * @param {string} key - Collection key (e.g. 'ravencards')
 * @param {object} options
 * @param {boolean} options.metadataOnly - Skip marketplace data
 * @param {boolean} options.force - Ignore freshness check
 * @returns {Promise<{types?: number, samples?: number, marketplace: boolean}>}
 */
async function scrapeCollection(key, options = {}) {
  const { metadataOnly = false, force = false } = options;
  const collection = COLLECTIONS[key];
  const outputPath = path.join(OUTPUT_DIR, `${key}.json`);
  const result = { marketplace: false };

  // Freshness check — skip if recently scraped (read timestamp from manifest)
  if (!force) {
    const manifest = loadJSON(path.join(OUTPUT_DIR, 'manifest.json'));
    const lastScraped = manifest?.collections?.[key]?.lastScraped;
    if (lastScraped) {
      const age = Date.now() - new Date(lastScraped).getTime();
      if (age < FRESHNESS_TTL_MS) {
        const hours = Math.round(age / 3600000);
        console.log(`  [${key}] Skipping — scraped ${hours}h ago (use --force to override)`);
        return null;
      }
    }
  }

  // Build the output object
  const output = {
    collection: {
      name: collection.name,
      contract: collection.contract,
      chain: CHAIN,
      type: collection.type
    }
  };

  // Scrape NFT metadata based on collection type
  if (collection.type === 'stacked') {
    const types = await scrapeStacked(key, collection.contract);
    output.types = types;
    result.types = types.length;
  } else {
    const unique = await scrapeUnique(key, collection.contract);
    output.totalScanned = unique.totalScanned;
    output.sampleTokens = unique.sampleTokens;
    output.attributeSummary = unique.attributeSummary;
    result.samples = unique.sampleTokens.length;
  }

  if (cancelled) return result;

  // Scrape marketplace data (unless --metadata-only)
  if (!metadataOnly) {
    await sleep(API_DELAY_MS);
    output.marketplace = await scrapeMarketplace(key, collection.contract);
    result.marketplace = true;
  }

  // Save to disk
  saveJSON(outputPath, output);
  console.log(`  [${key}] Saved to data/blockchain/${key}.json`);

  return result;
}

// =============================================================================
// Manifest
// =============================================================================

/**
 * Update the manifest file with scrape timestamps and stats.
 */
function updateManifest(results) {
  const manifestPath = path.join(OUTPUT_DIR, 'manifest.json');
  const existing = loadJSON(manifestPath) || { collections: {} };

  let scraped = 0;
  for (const [key, result] of Object.entries(results)) {
    if (!result) continue; // skipped
    existing.collections[key] = {
      lastScraped: new Date().toISOString(),
      ...result
    };
    scraped++;
  }

  // Only update lastRun if something was actually scraped
  if (scraped > 0) existing.lastRun = new Date().toISOString();
  saveJSON(manifestPath, existing);
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    only: null,
    metadataOnly: false,
    force: false,
    list: false,
    help: false
  };

  for (const arg of args) {
    if (arg === '--metadata-only') {
      options.metadataOnly = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
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
Blockchain Metadata Scraper — Scrape RavenQuest NFT metadata + marketplace data

Usage:
  node scripts/scrape-blockchain.js [options]

Options:
  --only=a,b         Scrape only specific collections (comma-separated)
  --metadata-only    Skip marketplace data (listings + sales)
  --force            Ignore 24h freshness check, always re-scrape
  --list             Show available collections
  --help, -h         Show this help

Available collections:
  ravencards         RavenCards — stacked, ~240 unique types
  cosmetics          Cosmetics — stacked, ~40-70 unique types
  land               Land — unique (1:1), base_uri enumeration + on-chain merge
  munks              Munks — unique PFP, base_uri enumeration + on-chain merge
  moas               Moas — unique PFP, base_uri enumeration + on-chain merge

Examples:
  node scripts/scrape-blockchain.js                          # All collections
  node scripts/scrape-blockchain.js --only=ravencards        # Just ravencards
  node scripts/scrape-blockchain.js --only=ravencards,cosmetics --metadata-only
  node scripts/scrape-blockchain.js --force                  # Re-scrape everything
`);
}

function printList() {
  console.log('Available collections:');
  for (const [key, config] of Object.entries(COLLECTIONS)) {
    const type =
      config.type === 'stacked' ? 'stacked (dedup by name)' : 'unique (base_uri + on-chain)';
    console.log(`  ${key.padEnd(14)} ${config.name.padEnd(12)} ${config.contract}  [${type}]`);
  }
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

  if (options.list) {
    printList();
    return;
  }

  console.log('='.repeat(65));
  console.log('  RavenHUD Blockchain Metadata Scraper');
  console.log('='.repeat(65));

  if (options.metadataOnly) console.log('  Mode: Metadata only (skipping marketplace)');
  if (options.force) console.log('  Force: Ignoring freshness check');

  const collectionKeys = options.only || Object.keys(COLLECTIONS);

  // Validate collection names
  for (const key of collectionKeys) {
    if (!COLLECTIONS[key]) {
      console.error(`\nUnknown collection: "${key}"`);
      console.error(`Available: ${Object.keys(COLLECTIONS).join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`  Collections: ${collectionKeys.join(', ')}`);
  console.log('='.repeat(65));

  const results = {};
  let totalTypes = 0;
  let totalSamples = 0;

  for (const key of collectionKeys) {
    if (cancelled) break;

    console.log(`\n--- ${key} (${COLLECTIONS[key].name}) ---`);

    try {
      const result = await scrapeCollection(key, {
        metadataOnly: options.metadataOnly,
        force: options.force
      });

      results[key] = result;

      if (result) {
        if (result.types) totalTypes += result.types;
        if (result.samples) totalSamples += result.samples;
      }
    } catch (err) {
      console.error(`  [${key}] Fatal error: ${err.message}`);
      results[key] = { error: err.message };
    }

    // Delay between collections to be nice to the API
    if (collectionKeys.indexOf(key) < collectionKeys.length - 1) {
      await sleep(1000);
    }
  }

  if (cancelled) return;

  // Update manifest
  updateManifest(results);

  // Summary
  console.log('\n' + '='.repeat(65));
  console.log('  Summary');
  console.log('='.repeat(65));

  for (const [key, result] of Object.entries(results)) {
    if (!result) {
      console.log(`  ${key}: skipped (fresh)`);
    } else if (result.error) {
      console.log(`  ${key}: ERROR — ${result.error}`);
    } else {
      const parts = [];
      if (result.types) parts.push(`${result.types} unique types`);
      if (result.samples) parts.push(`${result.samples} tokens sampled`);
      parts.push(result.marketplace ? 'marketplace: yes' : 'marketplace: skipped');
      console.log(`  ${key}: ${parts.join(', ')}`);
    }
  }

  console.log('-'.repeat(65));
  if (totalTypes > 0) console.log(`  Total unique types: ${totalTypes}`);
  if (totalSamples > 0) console.log(`  Total tokens sampled: ${totalSamples}`);
  console.log(`  Output: data/blockchain/`);
  console.log('='.repeat(65));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
