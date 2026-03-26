/**
 * Land Handlers - Browser-compatible version for demo
 * Ported from src/main/handlers/land-handlers.js
 */

// Cache for loaded data
let landTypesCache = null;
let landDataCache = null;
let communityLayoutsCache = null;
let nftLayoutsCache = null;
let landShapesCache = null;
let houseShapesCache = null;

// In-memory storage for layouts (session only)
let savedLayouts = [];

// Max limits
const MAX_SAVED_LAYOUTS = 50;
const MAX_LAYOUT_NAME_LENGTH = 50;

/**
 * Generate a unique ID
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Load land shapes from JSON
 */
async function loadLandShapes() {
  if (landShapesCache) return landShapesCache;

  try {
    const response = await fetch('data/land-shapes.json');
    if (response.ok) {
      landShapesCache = await response.json();
      console.log('[LandHandlers] Loaded land shapes');
      return landShapesCache;
    }
  } catch (err) {
    console.warn('[LandHandlers] Land shapes not found');
  }
  return null;
}

/**
 * Load house shapes from JSON
 */
async function loadHouseShapes() {
  if (houseShapesCache) return houseShapesCache;

  try {
    const response = await fetch('data/house-shapes.json');
    if (response.ok) {
      houseShapesCache = await response.json();
      console.log('[LandHandlers] Loaded house shapes');
      return houseShapesCache;
    }
  } catch (err) {
    console.warn('[LandHandlers] House shapes not found');
  }
  return null;
}

/**
 * Get land type definitions
 */
async function getLandTypes() {
  if (landTypesCache) return landTypesCache;

  const landShapes = await loadLandShapes();
  const houseShapes = await loadHouseShapes();

  if (!landShapes) {
    console.error('[LandHandlers] Failed to load land shapes');
    return [];
  }

  // Convert to array format expected by components
  landTypesCache = Object.keys(landShapes).map((key) => {
    const landData = landShapes[key];
    const houseData = houseShapes?.[key];

    const result = {
      id: key,
      name: landData.name,
      width: landData.width,
      height: landData.height,
      shape: landData.shape || 'rectangle',
      hasHouse: landData.hasHouse || false,
      farmMultiplier: landData.farmMultiplier || 1,
      tileCount: landData.tileCount,
      tiles: landData.tiles || []
    };

    // Add house data if this land type has a house
    // House tiles in JSON are relative to origin (0,0) — center them on the land
    // (matches in-app buildLandTypes logic in land-handlers.ts)
    if (landData.hasHouse && houseData) {
      const houseWidth = houseData.width || 0;
      const houseHeight = houseData.height || 0;
      const offsetX = Math.floor((landData.width - houseWidth) / 2);
      const offsetY = Math.floor((landData.height - houseHeight) / 2);

      result.houseTiles = (houseData.tiles?.house || []).map(t => ({ x: t.x + offsetX, y: t.y + offsetY }));
      result.houseDoorTiles = (houseData.tiles?.door || []).map(t => ({ x: t.x + offsetX, y: t.y + offsetY }));
      result.doorClearanceTiles = (houseData.tiles?.clearance || []).map(t => ({ x: t.x + offsetX, y: t.y + offsetY }));
    }

    return result;
  });

  console.log('[LandHandlers] getLandTypes:', landTypesCache.length, 'types');
  return landTypesCache;
}

/**
 * Load land data from crops.json (transformed for sidebar display)
 */
async function getLandData() {
  if (landDataCache) return landDataCache;

  try {
    const response = await fetch('data/crops.json');
    const cropsData = await response.json();

    // Transform crops.json items into category-grouped format
    const result = {
      farming: [],
      herbalism: [],
      husbandry: [],
      Woodcutting: [],
      breeding: []
    };

    cropsData.items.forEach((item) => {
      const silverCost = item.yields && item.yields[0] ? item.yields[0].unitCost : 100;

      const yieldInfo = (item.yields || []).map((y) => ({
        resource: y.resource,
        min: y.min,
        max: y.max,
        avg: y.avg
      }));

      const landItem = {
        id: item.id,
        name: item.name,
        size: item.size || '1x1',
        width: item.width || 1,
        height: item.height || 1,
        silverCost,
        icon: item.icon || '🌱',
        level: item.level,
        category: item.category,
        growthTime: item.growthTime,
        yields: yieldInfo
      };

      const category = item.category;
      if (result[category]) {
        result[category].push(landItem);
      }
    });

    // Sort each category by level
    Object.keys(result).forEach((cat) => {
      result[cat].sort((a, b) => (a.level || 0) - (b.level || 0));
    });

    landDataCache = result;
    return result;
  } catch (error) {
    console.error('Error loading land data:', error);
    throw error;
  }
}

/**
 * Get size key for an item
 */
function getItemSizeKey(item) {
  return `${item.width}x${item.height}`;
}

/**
 * Validate layout pattern (placement rules)
 */
function validateLayoutPattern(newX, newY, newWidth, newHeight, existingGrid) {
  if (existingGrid.length === 0) {
    return { valid: true };
  }

  const newSizeKey = `${newWidth}x${newHeight}`;
  const newXEnd = newX + newWidth - 1;
  const newYEnd = newY + newHeight - 1;

  for (const existing of existingGrid) {
    const exX = existing.x;
    const exY = existing.y;
    const exW = existing.item.width;
    const exH = existing.item.height;
    const exXEnd = exX + exW - 1;
    const exYEnd = exY + exH - 1;
    const exSizeKey = getItemSizeKey(existing.item);
    const sameSize = exSizeKey === newSizeKey;

    // Calculate gaps
    const xGap = newX > exXEnd ? newX - exXEnd - 1 : exX - newXEnd - 1;
    const yGap = newY > exYEnd ? newY - exYEnd - 1 : exY - newYEnd - 1;

    // Direct collision
    if (xGap < 0 && yGap < 0) {
      return { valid: false, message: 'Items overlap' };
    }

    // Check for full overlap in X (for vertical adjacency)
    const newXRange = [newX, newXEnd];
    const exXRange = [exX, exXEnd];
    const xFullOverlap =
      (newXRange[0] >= exXRange[0] && newXRange[1] <= exXRange[1]) ||
      (exXRange[0] >= newXRange[0] && exXRange[1] <= newXRange[1]);

    // Check for full overlap in Y (for horizontal adjacency)
    const newYRange = [newY, newYEnd];
    const exYRange = [exY, exYEnd];
    const yFullOverlap =
      (newYRange[0] >= exYRange[0] && newYRange[1] <= exYRange[1]) ||
      (exYRange[0] >= newYRange[0] && exYRange[1] <= newYRange[1]);

    // Vertical adjacency
    if (xFullOverlap && xGap < 0 && yGap >= 0) {
      if (sameSize && yGap < 0) {
        return { valid: false, message: 'Items overlap vertically' };
      }
      if (!sameSize && yGap < 1) {
        return { valid: false, message: 'Different sizes need 1 tile gap' };
      }
      continue;
    }

    // Horizontal adjacency
    if (yFullOverlap && yGap < 0 && xGap >= 0) {
      if (sameSize && xGap < 0) {
        return { valid: false, message: 'Items overlap horizontally' };
      }
      if (!sameSize && xGap < 1) {
        return { valid: false, message: 'Different sizes need 1 tile gap' };
      }
      continue;
    }

    // Diagonal/corner touching
    if (xGap <= 0 && yGap <= 0) {
      return { valid: false, message: 'Items must fully align in a row or column' };
    }
  }

  return { valid: true };
}

/**
 * Validate placement
 */
async function validatePlacement({ x, y, item, landType, existingGrid, enforceAdjacency = true }) {
  if (!item || !item.width || !item.height) {
    return { valid: false, message: 'Invalid item' };
  }

  const landTypes = await getLandTypes();
  const land = landTypes.find((l) => l.id === landType);
  if (!land) {
    return { valid: false, message: 'Invalid land type' };
  }

  const grid = existingGrid || [];
  const validTiles = land.tiles;

  // Check bounds
  for (let dy = 0; dy < item.height; dy++) {
    for (let dx = 0; dx < item.width; dx++) {
      const checkX = x + dx;
      const checkY = y + dy;
      if (!validTiles.some((tile) => tile.x === checkX && tile.y === checkY)) {
        return { valid: false, message: 'Placement outside land boundaries' };
      }
    }
  }

  // Check overlap
  for (let dy = 0; dy < item.height; dy++) {
    for (let dx = 0; dx < item.width; dx++) {
      const checkX = x + dx;
      const checkY = y + dy;
      if (
        grid.some((placed) => {
          const placedItem = placed.item;
          return (
            checkX >= placed.x &&
            checkX < placed.x + placedItem.width &&
            checkY >= placed.y &&
            checkY < placed.y + placedItem.height
          );
        })
      ) {
        return { valid: false, message: 'Cannot place on occupied tiles' };
      }
    }
  }

  // Check layout pattern
  if (enforceAdjacency) {
    const patternResult = validateLayoutPattern(x, y, item.width, item.height, grid);
    if (!patternResult.valid) {
      return patternResult;
    }
  }

  return { valid: true };
}

/**
 * Get saved layouts (in-memory for demo)
 */
function getLandLayouts() {
  return savedLayouts;
}

/**
 * Calculate total cost from grid
 */
function calculateTotalCost(grid) {
  return grid.reduce((total, placed) => total + (placed.item.silverCost || 0), 0);
}

/**
 * Sanitize layout name
 */
function sanitizeLayoutName(name) {
  if (typeof name !== 'string') return 'Unnamed Layout';
  return name
    .slice(0, MAX_LAYOUT_NAME_LENGTH)
    .replace(/[<>:"/\\|?*]/g, '')
    .trim() || 'Unnamed Layout';
}

/**
 * Save a layout (in-memory for demo)
 */
function saveLandLayout(layout) {
  if (!layout || typeof layout !== 'object') {
    throw new Error('Invalid layout');
  }

  const { name, landType, grid } = layout;

  if (!Array.isArray(grid)) {
    throw new Error('Invalid grid');
  }

  if (savedLayouts.length >= MAX_SAVED_LAYOUTS && !layout.id) {
    throw new Error(`Maximum of ${MAX_SAVED_LAYOUTS} layouts allowed`);
  }

  const sanitizedName = sanitizeLayoutName(name);
  const totalCost = calculateTotalCost(grid);

  const savedLayout = {
    id: layout.id || generateId(),
    name: sanitizedName,
    landType,
    grid,
    totalCost,
    lastModified: new Date().toISOString()
  };

  const existingIndex = savedLayouts.findIndex((l) => l.id === savedLayout.id);
  if (existingIndex >= 0) {
    savedLayouts[existingIndex] = savedLayout;
  } else {
    savedLayouts.push(savedLayout);
  }

  return savedLayout;
}

/**
 * Delete a layout
 */
function deleteLandLayout(layoutId) {
  const filtered = savedLayouts.filter((l) => l.id !== layoutId);
  if (filtered.length === savedLayouts.length) {
    throw new Error('Layout not found');
  }
  savedLayouts = filtered;
  return { success: true };
}

/**
 * Get community layouts
 */
async function getCommunityLayouts(landType) {
  if (!communityLayoutsCache) {
    try {
      const response = await fetch('data/community-layouts.json');
      communityLayoutsCache = await response.json();
    } catch (err) {
      console.warn('[LandHandlers] Community layouts not found');
      return { error: 'Community layouts not loaded' };
    }
  }

  if (landType) {
    return communityLayoutsCache[landType] || { error: `No layouts for ${landType}` };
  }
  return communityLayoutsCache;
}

/**
 * Get NFT layouts
 */
async function getNFTLayouts(landType) {
  if (!nftLayoutsCache) {
    try {
      const response = await fetch('data/nft-layouts.json');
      nftLayoutsCache = await response.json();
    } catch (err) {
      console.warn('[LandHandlers] NFT layouts not found');
      return { error: 'NFT layouts not loaded' };
    }
  }

  if (landType) {
    return nftLayoutsCache[landType] || { error: `No layouts for ${landType}` };
  }
  return nftLayoutsCache;
}

// Expose globally
window.LandHandlers = {
  getLandTypes,
  getLandData,
  validatePlacement,
  getLandLayouts,
  saveLandLayout,
  deleteLandLayout,
  getCommunityLayouts,
  getNFTLayouts
};
