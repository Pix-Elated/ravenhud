/**
 * Land Simulator Controller
 * Manages the land simulator tab functionality
 * Demo version - adapted for web
 */

/* global LandGrid, LandSidebar, LandOptimized */

let landGrid = null;
let landSidebar = null;
let landOptimized = null;
let currentLandType = null;
let landStatsPanel = null;

/**
 * Initialize the land simulator
 */
async function initLandSimulator() {
  // Initialize components
  const gridContainer = document.getElementById('landGrid');
  const sidebarContainer = document.getElementById('landSidebar');
  const optimizedContainer = document.getElementById('landOptimized');

  if (!gridContainer || !sidebarContainer) {
    console.error('[Land] Land simulator containers not found!');
    return;
  }

  // Create sidebar
  landSidebar = new LandSidebar(sidebarContainer, {
    onItemSelect: handleItemSelect,
    onLayoutLoad: handleLayoutLoad
  });

  // Create grid (no land type selected yet)
  landGrid = new LandGrid(gridContainer, {
    landType: null,
    onGridChange: handleGridChange,
    onItemDeselect: handleItemDeselect,
    onHouseStateChange: handleHouseStateChange
  });

  // Create optimized layouts panel
  if (optimizedContainer) {
    landOptimized = new LandOptimized(optimizedContainer, {
      onApplyLayout: handleApplyOptimizedLayout
    });
  }

  // Setup stats panel
  landStatsPanel = document.getElementById('landStats');
  updateStatsPanel(null, []);

  // Setup event listeners
  setupEventListeners();

  // Initialize owned lands configuration
  initOwnedLandsConfig();

  // Check if dropdown already has a value selected (browser autocomplete, etc.)
  const landTypeSelect = document.getElementById('landTypeSelect');
  if (landTypeSelect && landTypeSelect.value) {
    // Trigger the change handler to initialize the grid with the pre-selected value
    handleLandTypeChange({ target: landTypeSelect });
  }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Land type selector - single delegated listener on document
  // (removed duplicate direct listener that was causing double grid creation)
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'landTypeSelect') {
      handleLandTypeChange(e);
    }
  });

  // Clear grid button
  const clearGridBtn = document.getElementById('clearGridBtn');
  if (clearGridBtn) {
    clearGridBtn.addEventListener('click', handleClearGrid);
  }

  // Ctrl+S to copy layout JSON
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      const landTab = document.getElementById('tab-land');
      if (landTab?.classList.contains('active') && currentLandType && landGrid) {
        e.preventDefault();
        const btn = document.getElementById('copyJsonBtn');
        if (btn) btn.click();
      }
    }
  });
}

/**
 * Handle land type change
 */
async function handleLandTypeChange(e) {
  const landType = e.target.value;

  if (!landType) {
    currentLandType = null;
    if (landGrid) {
      await landGrid.setLandType(null);
    }
    if (landSidebar) {
      landSidebar.setLandType(null);
    }
    if (landOptimized) {
      landOptimized.setLandType(null);
    }
    return;
  }

  currentLandType = landType;
  cachedLandData = null; // Reset so stats bar re-fetches

  if (landGrid) {
    try {
      await landGrid.setLandType(landType);
    } catch (err) {
      console.error('[Land] landGrid.setLandType FAILED:', err);
    }
  } else {
    console.error('[Land] landGrid is null!');
  }

  if (landSidebar) {
    landSidebar.setLandType(landType);
  }

  if (landOptimized) {
    landOptimized.setLandType(landType);
  }

  // Update stats panel
  updateStatsPanel(landType, []);
}

/**
 * Handle item selection from sidebar
 */
function handleItemSelect(item) {
  if (landGrid) {
    if (item) {
      landGrid.setSelectedItem(item);
    } else {
      landGrid.selectedItem = null;
    }
  }
}

/**
 * Handle item deselection (right-click to cancel placement)
 */
function handleItemDeselect() {
  if (landSidebar) {
    landSidebar.deselectItem();
  }
}

/**
 * Handle grid changes
 */
function handleGridChange(grid) {
  if (landSidebar) {
    landSidebar.updateGrid(grid);
  }

  // Update stats panel
  updateStatsPanel(currentLandType, grid);
}

/**
 * Handle house state changes (for NFT lands)
 */
function handleHouseStateChange(state) {
  if (landOptimized && landGrid) {
    // Pass house position and rotation to optimized panel
    const houseState = landGrid.getHouseState();
    landOptimized.setHouseState(houseState.position, houseState.rotation);
  }
  // Update sidebar house state for palette enable/disable
  if (landSidebar && landGrid) {
    const houseState = landGrid.getHouseState();
    landSidebar.setHouseState(houseState.position);
  }
  // Update stats bar with new house state
  if (landGrid) {
    updateStatsPanel(currentLandType, landGrid.getGrid ? landGrid.getGrid() : []);
  }
}

/**
 * Handle layout load
 */
function handleLayoutLoad(layout) {
  // Change land type if needed
  if (layout.landType !== currentLandType) {
    const landTypeSelect = document.getElementById('landTypeSelect');
    if (landTypeSelect) {
      landTypeSelect.value = layout.landType;
      currentLandType = layout.landType;
    }
  }

  // Load layout into grid
  if (landGrid) {
    landGrid.setLandType(layout.landType).then(() => {
      landGrid.loadLayout(layout);
    }).catch((error) => {
      console.error('[Land] Failed to load layout:', error);
    });
  }
}

/**
 * Handle clear grid
 */
function handleClearGrid() {
  if (!landGrid) return;

  if (confirm('Are you sure you want to clear the grid?')) {
    landGrid.clear();
  }
}

/**
 * Handle applying an optimized layout pattern
 * This shows the pattern visually but doesn't assign specific items
 */
function handleApplyOptimizedLayout(layout) {
  if (!landGrid || !currentLandType) return;

  // Handle house position hint (auto-place house from optimal suggestions)
  if (layout.isHousePositionHint && layout.housePosition) {
    const { x, y } = layout.housePosition;
    const rotation = layout.houseRotation || 0;

    const success = landGrid.placeHouseAt(x, y, rotation);
    if (success) {
      // Show a brief success message
      showToast(`House placed at (${x}, ${y}) with ${rotation}° rotation`, 'success');
    }
    return;
  }

  // Show info about the layout
  const message =
    `Layout: ${layout.name}\n` +
    `Items: ${layout.itemCount}\n` +
    `Tiles used: ${layout.tilesUsed}\n` +
    `Efficiency: ${layout.efficiency}%\n\n${
      layout.breakdown
        ? `Breakdown:\n${Object.entries(layout.breakdown)
            .map(([size, count]) => `  ${size}: ${count} items`)
            .join('\n')}\n\n`
        : ''
    }This shows the optimal placement positions.\n` +
    `Use the item palette to place specific crops/items.`;

  alert(message);
}

/**
 * Show a toast notification
 */
function showToast(message, type = 'info') {
  // Use UIHelpers if available
  if (window.UIHelpers?.showToast) {
    window.UIHelpers.showToast(message, type);
    return;
  }

  const toast = document.createElement('div');
  toast.className = 'land-toast';
  toast.textContent = message;
  toast.style.position = 'fixed';
  toast.style.top = '20px';
  toast.style.right = '20px';
  toast.style.padding = '12px 16px';
  toast.style.borderRadius = '4px';
  toast.style.zIndex = '10000';
  toast.style.fontSize = '14px';
  toast.style.color = '#fff';

  if (type === 'success') {
    toast.style.background = '#10B981';
  } else if (type === 'error') {
    toast.style.background = '#EF4444';
  } else {
    toast.style.background = '#3B82F6';
  }

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 2000);
}

/**
 * Get color for efficiency percentage (matches in-app thresholds)
 */
function getEfficiencyColor(efficiency) {
  if (efficiency >= 90) return '#22c55e';
  if (efficiency >= 70) return '#eab308';
  return '#ef4444';
}

// Track cached land data for stats
let cachedLandData = null;
let jsonCopied = false;

/**
 * Update the stats bar below the grid (matches in-app UI)
 */
async function updateStatsPanel(landType, grid) {
  if (!landStatsPanel) return;

  if (!landType) {
    landStatsPanel.style.display = 'none';
    return;
  }

  landStatsPanel.style.display = 'flex';

  // Get land data (cached)
  if (!cachedLandData || cachedLandData.id !== landType) {
    try {
      const landTypes = await window.electronAPI.getLandTypes();
      cachedLandData = landTypes.find((l) => l.id === landType) || null;
    } catch (e) {
      console.error('Failed to get land data for stats:', e);
    }
  }

  const totalLandTiles = cachedLandData?.tiles?.length || 0;
  const nftIds = ['NFT_SMALL', 'NFT_MEDIUM', 'NFT_LARGE', 'NFT_STRONGHOLD', 'NFT_FORT'];
  const isNft = nftIds.includes(landType);

  // Calculate blocked tiles from house
  let blockedCount = 0;
  let housePos = null;
  let houseRot = 0;
  if (isNft && landGrid) {
    const houseState = landGrid.getHouseState();
    housePos = houseState.position;
    houseRot = houseState.rotation;
    if (housePos && landOptimized) {
      blockedCount = landOptimized.blockedTiles?.size || 0;
    }
  }

  const availableTiles = totalLandTiles - blockedCount;
  const itemCount = grid.length;
  const tilesUsed = grid.reduce((sum, placed) => sum + placed.item.width * placed.item.height, 0);
  const efficiency = availableTiles > 0 ? Math.round((tilesUsed / availableTiles) * 100) : 0;

  // Size breakdown text
  const sizeCounts = {};
  grid.forEach((placed) => {
    const size = placed.item.size || `${placed.item.width}x${placed.item.height}`;
    sizeCounts[size] = (sizeCounts[size] || 0) + 1;
  });
  const breakdownParts = [];
  ['4x4', '3x3', '2x2', '1x1'].forEach(size => {
    if (sizeCounts[size]) breakdownParts.push(`${sizeCounts[size]}x ${size}`);
  });
  const breakdownText = breakdownParts.join(' + ');

  // House position HTML (NFT only)
  const housePosHtml = isNft && housePos ? `
    <div class="stat-item house-pos-stat">
      <span class="stat-label">Position</span>
      <span class="stat-value house-pos-value">${housePos.x},${housePos.y} <span class="house-rotation-badge">${houseRot}&deg;</span></span>
    </div>
  ` : '';

  landStatsPanel.innerHTML = `
    <button class="btn-copy-json ${jsonCopied ? 'copied' : ''}" id="copyJsonBtn" title="Copy layout configuration as JSON">
      ${jsonCopied ? '&#10003; Copied!' : '&#128203; Copy JSON'}
    </button>
    ${housePosHtml}
    <div class="stat-item">
      <span class="stat-label">Items</span>
      <span class="stat-value">${itemCount}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Tiles</span>
      <span class="stat-value">${tilesUsed}/${availableTiles}</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Efficiency</span>
      <span class="stat-value" style="color: ${getEfficiencyColor(efficiency)};">${efficiency}%</span>
    </div>
    ${breakdownText ? `
      <div class="stat-item">
        <span class="stat-label">Breakdown</span>
        <span class="stat-value breakdown-text">${breakdownText}</span>
      </div>
    ` : ''}
  `;

  // Wire up copy JSON button
  const copyBtn = document.getElementById('copyJsonBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => copyLayoutJson(landType, grid, housePos, houseRot, tilesUsed, availableTiles, efficiency, breakdownText));
  }
}

/**
 * Copy layout configuration as JSON to clipboard
 */
async function copyLayoutJson(landType, grid, housePos, houseRot, tilesUsed, availableTiles, efficiency, breakdownText) {
  const payload = {
    land: {
      type: landType,
      name: cachedLandData?.name || landType,
      width: cachedLandData?.width || 0,
      height: cachedLandData?.height || 0,
      hasHouse: cachedLandData?.hasHouse || false,
      validTileCount: cachedLandData?.tiles?.length || 0
    },
    ...(housePos ? {
      house: {
        position: housePos,
        rotation: houseRot
      }
    } : {}),
    placements: grid.map(placed => ({
      x: placed.x,
      y: placed.y,
      crop: {
        id: placed.item.id || placed.item.size,
        name: placed.item.name,
        width: placed.item.width,
        height: placed.item.height,
        size: placed.item.size
      }
    })),
    stats: {
      itemCount: grid.length,
      tilesUsed,
      tilesAvailable: availableTiles,
      efficiency,
      sizeBreakdown: breakdownText
    },
    exportedAt: new Date().toISOString()
  };

  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    jsonCopied = true;
    const btn = document.getElementById('copyJsonBtn');
    if (btn) {
      btn.classList.add('copied');
      btn.innerHTML = '&#10003; Copied!';
    }
    setTimeout(() => {
      jsonCopied = false;
      const btn2 = document.getElementById('copyJsonBtn');
      if (btn2) {
        btn2.classList.remove('copied');
        btn2.innerHTML = '&#128203; Copy JSON';
      }
    }, 2000);
  } catch (e) {
    showToast('Failed to copy to clipboard', 'error');
  }
}

// ============================================
// Owned Lands Configuration
// ============================================

/**
 * Initialize owned lands configuration panel
 */
async function initOwnedLandsConfig() {
  try {
    const ownedLandsData = await window.electronAPI.getOwnedLands();

    // Set community land checkboxes
    const smallCommunity = document.getElementById('ownSmallCommunity');
    const mediumCommunity = document.getElementById('ownMediumCommunity');
    const largeCommunity = document.getElementById('ownLargeCommunity');

    if (smallCommunity) smallCommunity.checked = ownedLandsData.ownedLands?.SMALL_COMMUNITY > 0;
    if (mediumCommunity) mediumCommunity.checked = ownedLandsData.ownedLands?.MEDIUM_COMMUNITY > 0;
    if (largeCommunity) largeCommunity.checked = ownedLandsData.ownedLands?.LARGE_COMMUNITY > 0;

    // Set NFT land inputs
    const nftSmall = document.getElementById('ownNftSmall');
    const nftMedium = document.getElementById('ownNftMedium');
    const nftLarge = document.getElementById('ownNftLarge');
    const nftStronghold = document.getElementById('ownNftStronghold');
    const nftFort = document.getElementById('ownNftFort');

    if (nftSmall) nftSmall.value = ownedLandsData.ownedLands?.NFT_SMALL || 0;
    if (nftMedium) nftMedium.value = ownedLandsData.ownedLands?.NFT_MEDIUM || 0;
    if (nftLarge) nftLarge.value = ownedLandsData.ownedLands?.NFT_LARGE || 0;
    if (nftStronghold) nftStronghold.value = ownedLandsData.ownedLands?.NFT_STRONGHOLD || 0;
    if (nftFort) nftFort.value = ownedLandsData.ownedLands?.NFT_FORT || 0;

    updateNftLandCount();
    updateTotalOwnedTiles();
    setupOwnedLandsListeners();
    setupOwnedLandsModal();
  } catch (error) {
    console.error('Error initializing owned lands config:', error);
  }
}

/**
 * Setup owned lands modal — show on first visit, wire up open/close
 */
function setupOwnedLandsModal() {
  const modal = document.getElementById('ownedLandsModal');
  if (!modal) return;

  // Close button
  const closeBtn = document.getElementById('closeOwnedLandsBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeOwnedLandsModal);
  }

  // "Done" button
  const saveBtn = document.getElementById('saveOwnedLandsBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', closeOwnedLandsModal);
  }

  // Backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeOwnedLandsModal();
  });

  // "Configure Lands" button in controls bar
  const openBtn = document.getElementById('configureLandsOpenBtn');
  if (openBtn) {
    openBtn.addEventListener('click', openOwnedLandsModal);
  }

  // Show on first visit (check localStorage)
  const hasVisited = localStorage.getItem('rhud_demo_visited');
  if (!hasVisited) {
    openOwnedLandsModal();
  }
}

function openOwnedLandsModal() {
  const modal = document.getElementById('ownedLandsModal');
  if (modal) modal.style.display = 'flex';
}

function closeOwnedLandsModal() {
  const modal = document.getElementById('ownedLandsModal');
  if (modal) modal.style.display = 'none';
  // Mark as visited so it doesn't auto-show again
  localStorage.setItem('rhud_demo_visited', '1');
  // Save lands on close
  saveOwnedLands();
}

/**
 * Setup event listeners for owned lands inputs
 */
function setupOwnedLandsListeners() {
  const communityInputs = ['ownSmallCommunity', 'ownMediumCommunity', 'ownLargeCommunity'];
  const nftInputs = ['ownNftSmall', 'ownNftMedium', 'ownNftLarge', 'ownNftStronghold', 'ownNftFort'];

  // Community land checkboxes
  communityInputs.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        updateTotalOwnedTiles();
        saveOwnedLands();
      });
    }
  });

  // NFT land inputs - also enforce combined limit
  nftInputs.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        updateNftLandCount();
        updateTotalOwnedTiles();
      });
      el.addEventListener('change', saveOwnedLands);
    }
  });

  // Initial update of NFT count display
  updateNftLandCount();
}

/**
 * Save owned lands configuration
 */
async function saveOwnedLands() {
  const ownedLands = {
    SMALL_COMMUNITY: document.getElementById('ownSmallCommunity')?.checked ? 1 : 0,
    MEDIUM_COMMUNITY: document.getElementById('ownMediumCommunity')?.checked ? 1 : 0,
    LARGE_COMMUNITY: document.getElementById('ownLargeCommunity')?.checked ? 1 : 0,
    NFT_SMALL: parseInt(document.getElementById('ownNftSmall')?.value, 10) || 0,
    NFT_MEDIUM: parseInt(document.getElementById('ownNftMedium')?.value, 10) || 0,
    NFT_LARGE: parseInt(document.getElementById('ownNftLarge')?.value, 10) || 0,
    NFT_STRONGHOLD: parseInt(document.getElementById('ownNftStronghold')?.value, 10) || 0,
    NFT_FORT: parseInt(document.getElementById('ownNftFort')?.value, 10) || 0
  };

  try {
    await window.electronAPI.updateOwnedLands(ownedLands);
    updateTotalOwnedTiles();
  } catch (error) {
    console.error('Error saving owned lands:', error);
  }
}

/**
 * Maximum total NFT lands allowed (combined across all sizes)
 */
const MAX_NFT_LANDS = 7;

/**
 * Get total NFT lands currently configured
 */
function getTotalNftLands() {
  const small = parseInt(document.getElementById('ownNftSmall')?.value, 10) || 0;
  const medium = parseInt(document.getElementById('ownNftMedium')?.value, 10) || 0;
  const large = parseInt(document.getElementById('ownNftLarge')?.value, 10) || 0;
  const stronghold = parseInt(document.getElementById('ownNftStronghold')?.value, 10) || 0;
  const fort = parseInt(document.getElementById('ownNftFort')?.value, 10) || 0;
  return small + medium + large + stronghold + fort;
}

/**
 * Update NFT land count display and enforce combined limit
 */
function updateNftLandCount() {
  const total = getTotalNftLands();
  const countEl = document.getElementById('nftLandCount');
  if (countEl) {
    countEl.textContent = total;
  }

  // Update max values on each input based on remaining slots
  const small = parseInt(document.getElementById('ownNftSmall')?.value, 10) || 0;
  const medium = parseInt(document.getElementById('ownNftMedium')?.value, 10) || 0;
  const large = parseInt(document.getElementById('ownNftLarge')?.value, 10) || 0;
  const stronghold = parseInt(document.getElementById('ownNftStronghold')?.value, 10) || 0;
  const fort = parseInt(document.getElementById('ownNftFort')?.value, 10) || 0;

  const smallEl = document.getElementById('ownNftSmall');
  const mediumEl = document.getElementById('ownNftMedium');
  const largeEl = document.getElementById('ownNftLarge');
  const strongholdEl = document.getElementById('ownNftStronghold');
  const fortEl = document.getElementById('ownNftFort');

  // Each input's max = current value + remaining slots
  const remaining = MAX_NFT_LANDS - total;
  if (smallEl) smallEl.max = small + remaining;
  if (mediumEl) mediumEl.max = medium + remaining;
  if (largeEl) largeEl.max = large + remaining;
  if (strongholdEl) strongholdEl.max = stronghold + remaining;
  if (fortEl) fortEl.max = fort + remaining;
}

/**
 * Update total tiles display
 */
function updateTotalOwnedTiles() {
  const tiles = {
    SMALL_COMMUNITY: 56,
    MEDIUM_COMMUNITY: 91,
    LARGE_COMMUNITY: 130,
    NFT_SMALL: 100,
    NFT_MEDIUM: 144,
    NFT_LARGE: 225,
    NFT_STRONGHOLD: 484,
    NFT_FORT: 900
  };

  let total = 0;
  total += document.getElementById('ownSmallCommunity')?.checked ? tiles.SMALL_COMMUNITY : 0;
  total += document.getElementById('ownMediumCommunity')?.checked ? tiles.MEDIUM_COMMUNITY : 0;
  total += document.getElementById('ownLargeCommunity')?.checked ? tiles.LARGE_COMMUNITY : 0;
  total += (parseInt(document.getElementById('ownNftSmall')?.value, 10) || 0) * tiles.NFT_SMALL;
  total += (parseInt(document.getElementById('ownNftMedium')?.value, 10) || 0) * tiles.NFT_MEDIUM;
  total += (parseInt(document.getElementById('ownNftLarge')?.value, 10) || 0) * tiles.NFT_LARGE;
  total += (parseInt(document.getElementById('ownNftStronghold')?.value, 10) || 0) * tiles.NFT_STRONGHOLD;
  total += (parseInt(document.getElementById('ownNftFort')?.value, 10) || 0) * tiles.NFT_FORT;

  const totalEl = document.getElementById('totalOwnedTiles');
  if (totalEl) {
    totalEl.textContent = `${total} tiles`;
  }
}

// Initialize when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLandSimulator);
} else {
  initLandSimulator();
}
