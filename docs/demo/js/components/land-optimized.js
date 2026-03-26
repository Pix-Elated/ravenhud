/**
 * Land Optimized Layouts Component
 * Shows optimal layout patterns for different item sizes
 * Demo version - adapted for web
 */

class LandOptimized {
  constructor(container, options = {}) {
    this.container = container;
    this.currentLandType = null;
    this.landData = null;
    this.onApplyLayout = options.onApplyLayout || (() => {});

    // House state for NFT lands
    this.houseState = {
      hasHouse: false,
      housePlaced: false,
      housePosition: null,
      houseRotation: 0
    };
    this.blockedTiles = new Set();

    // Community land pre-computed layouts
    this.communityLayouts = null;
    this.isCommunityLand = false;
    this.showingAllLayouts = false;

    // NFT land pre-computed layouts
    this.nftLayouts = null;
    this.isNFTLand = false;
    this.showingMoreHousePositions = false;

    this.init();
  }

  /**
   * Initialize the panel
   */
  init() {
    this.container.innerHTML = '';
    this.showPlaceholder();
  }

  /**
   * Show placeholder when no land selected
   */
  showPlaceholder(message = 'Select a land type to see optimal layouts') {
    this.container.innerHTML = `
      <div class="optimized-panel">
        <h3 class="optimized-header">Optimal Layouts</h3>
        <div class="optimized-no-land">${message}</div>
      </div>
    `;
  }

  /**
   * Update house state and re-render if needed
   */
  setHouseState(housePosition, houseRotation) {
    this.houseState.housePosition = housePosition;
    this.houseState.houseRotation = houseRotation;
    this.houseState.housePlaced = housePosition !== null;

    if (this.landData?.hasHouse) {
      if (housePosition) {
        // Calculate blocked tiles
        this.blockedTiles = this.calculateBlockedTiles(housePosition, houseRotation);
        this.render();
      } else {
        this.blockedTiles = new Set();
        // Show optimal house positions instead of placeholder
        if (this.isNFTLand && this.nftLayouts) {
          this.renderOptimalHousePositions();
        } else {
          this.showPlaceholder('Place your house first to see optimal crop layouts');
        }
      }
    }
  }

  /**
   * Calculate which tiles are blocked by the house
   * Uses the actual irregular house shape from land data (same as land-grid.js)
   */
  calculateBlockedTiles(position, rotation) {
    const blocked = new Set();

    if (!this.landData?.hasHouse) return blocked;

    const tiles = this.getHouseTilesAtPosition(position, rotation);

    // Add all house, door, and clearance tiles to blocked set
    [...tiles.house, ...tiles.door, ...tiles.clearance].forEach((t) => {
      blocked.add(`${t.x},${t.y}`);
    });

    return blocked;
  }

  /**
   * Get house tiles at a specific position with given rotation
   * Uses the irregular house shape from land data (matches land-grid.js logic)
   */
  getHouseTilesAtPosition(position, rotation) {
    if (!this.landData?.hasHouse) return { house: [], door: [], clearance: [] };

    const { x, y } = position;

    // Get house shape from land data (from JSON via backend)
    const rawHouse = this.landData.houseTiles || [];
    const rawDoor = this.landData.houseDoorTiles || [];
    const rawClearance = this.landData.doorClearanceTiles || [];

    // If no house tiles defined, return empty
    if (rawHouse.length === 0) return { house: [], door: [], clearance: [] };

    // Combine all tiles to find bounding box
    const allTiles = [...rawHouse, ...rawDoor, ...rawClearance];
    const minX = Math.min(...allTiles.map((t) => t.x));
    const minY = Math.min(...allTiles.map((t) => t.y));
    const maxX = Math.max(...allTiles.map((t) => t.x));
    const maxY = Math.max(...allTiles.map((t) => t.y));
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;

    // Normalize tiles to be relative to (0, 0) and apply rotation
    const normalizeAndRotate = (tiles) => {
      // First normalize to (0, 0)
      const normalized = tiles.map((t) => ({
        x: t.x - minX,
        y: t.y - minY
      }));

      // Apply rotation around center of bounding box
      const centerX = (width - 1) / 2;
      const centerY = (height - 1) / 2;

      return normalized.map((t) => {
        let rx = t.x;
        let ry = t.y;

        // Apply rotation (90 degree increments)
        const rotations = rotation / 90;
        for (let r = 0; r < rotations; r++) {
          // Translate to center, rotate 90 CW, translate back
          const dx = rx - centerX;
          const dy = ry - centerY;
          // 90 degree CW rotation: (x, y) -> (y, -x)
          const newDx = dy;
          const newDy = -dx;
          rx = Math.round(newDx + centerX);
          ry = Math.round(newDy + centerY);
        }

        return { x: rx, y: ry };
      });
    };

    // Get rotated tiles and find new bounding box
    const rotatedHouse = normalizeAndRotate(rawHouse);
    const rotatedDoor = normalizeAndRotate(rawDoor);
    const rotatedClearance = normalizeAndRotate(rawClearance);

    // Find new bounding box after rotation (might have negative coords)
    const allRotated = [...rotatedHouse, ...rotatedDoor, ...rotatedClearance];
    const newMinX = Math.min(...allRotated.map((t) => t.x));
    const newMinY = Math.min(...allRotated.map((t) => t.y));

    // Offset to placement position, normalizing so min is at placement origin
    const houseTiles = rotatedHouse.map((t) => ({
      x: t.x - newMinX + x,
      y: t.y - newMinY + y
    }));
    const doorTiles = rotatedDoor.map((t) => ({
      x: t.x - newMinX + x,
      y: t.y - newMinY + y
    }));
    const clearanceTiles = rotatedClearance.map((t) => ({
      x: t.x - newMinX + x,
      y: t.y - newMinY + y
    }));

    return { house: houseTiles, door: doorTiles, clearance: clearanceTiles };
  }

  /**
   * Set land type and generate optimal layouts
   */
  async setLandType(landType) {
    this.currentLandType = landType;
    this.blockedTiles = new Set();
    this.communityLayouts = null;
    this.nftLayouts = null;
    this.isCommunityLand = false;
    this.isNFTLand = false;
    this.showingAllLayouts = false;
    this.showingMoreHousePositions = false;
    this.houseState = {
      hasHouse: false,
      housePlaced: false,
      housePosition: null,
      houseRotation: 0
    };

    if (!landType) {
      this.showPlaceholder();
      return;
    }

    // Get land type data
    const landTypes = await window.electronAPI.getLandTypes();
    this.landData = landTypes.find((l) => l.id === landType);

    if (!this.landData) {
      this.showPlaceholder();
      return;
    }

    this.houseState.hasHouse = this.landData.hasHouse || false;

    // Check if this is a community land with pre-computed layouts
    const communityLandIds = ['SMALL_COMMUNITY', 'MEDIUM_COMMUNITY', 'LARGE_COMMUNITY'];
    if (communityLandIds.includes(landType)) {
      this.isCommunityLand = true;
      try {
        const layouts = await window.electronAPI.getCommunityLayouts(landType);
        if (layouts && !layouts.error) {
          this.communityLayouts = layouts;
        }
      } catch (err) {
        console.error('[LandOptimized] Failed to load community layouts:', err);
      }
    }

    // Check if this is an NFT land with pre-computed layouts
    const nftLandIds = ['NFT_SMALL', 'NFT_MEDIUM', 'NFT_LARGE', 'NFT_STRONGHOLD', 'NFT_FORT'];
    if (nftLandIds.includes(landType)) {
      this.isNFTLand = true;
      try {
        const layouts = await window.electronAPI.getNFTLayouts(landType);
        if (layouts && !layouts.error) {
          this.nftLayouts = layouts;
        }
      } catch (err) {
        console.error('[LandOptimized] Failed to load NFT layouts:', err);
      }
    }

    // For NFT lands, show optimal house positions first (before house is placed)
    // After house is placed, setHouseState will trigger render() with crop layouts
    if (this.landData.hasHouse) {
      if (this.nftLayouts) {
        this.renderOptimalHousePositions();
      } else {
        this.showPlaceholder('Place your house first to see optimal crop layouts');
      }
      return;
    }

    this.render();
  }

  /**
   * Render optimal layouts for current land type
   */
  render() {
    // Use pre-computed layouts if available, otherwise generate dynamically
    if (this.isCommunityLand && this.communityLayouts) {
      this.renderCommunityLayouts();
    } else if (this.isNFTLand && this.nftLayouts && this.houseState.housePlaced) {
      // Filter NFT layouts to match user's house position
      this.renderNFTLayoutsForHousePosition();
    } else if (this.isNFTLand && this.nftLayouts) {
      // House not placed yet - show optimal house positions
      this.renderOptimalHousePositions();
    } else {
      this.renderDynamicLayouts();
    }
  }

  /**
   * Categorize layouts into predefined "best" categories for quick access.
   * Matches the in-app ICategorizedLayouts logic from land.service.ts.
   * If "Max X" equals "All X" (no fill room), Max is set to null to avoid duplicates.
   */
  categorizeLayouts(layouts) {
    if (!layouts || layouts.length === 0) {
      return { all1x1: null, all2x2: null, max2x2: null, all3x3: null, max3x3: null, all4x4: null, max4x4: null };
    }

    const sameLayout = (a, b) => {
      if (!a || !b) return false;
      return (
        (a.counts['4x4'] || 0) === (b.counts['4x4'] || 0) &&
        (a.counts['3x3'] || 0) === (b.counts['3x3'] || 0) &&
        (a.counts['2x2'] || 0) === (b.counts['2x2'] || 0) &&
        (a.counts['1x1'] || 0) === (b.counts['1x1'] || 0)
      );
    };

    // All 1x1: Only 1x1 crops
    const all1x1 = layouts.find(l =>
      (l.counts['4x4'] || 0) === 0 && (l.counts['3x3'] || 0) === 0 &&
      (l.counts['2x2'] || 0) === 0 && (l.counts['1x1'] || 0) > 0
    ) || null;

    // All 2x2: Only 2x2 crops
    const all2x2 = layouts.find(l =>
      (l.counts['4x4'] || 0) === 0 && (l.counts['3x3'] || 0) === 0 &&
      (l.counts['2x2'] || 0) > 0 && (l.counts['1x1'] || 0) === 0
    ) || null;

    // Max 2x2: Highest 2x2 count (with any 1x1 fill, no larger)
    const max2x2Candidate = [...layouts]
      .filter(l => (l.counts['4x4'] || 0) === 0 && (l.counts['3x3'] || 0) === 0)
      .sort((a, b) => {
        if ((b.counts['2x2'] || 0) !== (a.counts['2x2'] || 0)) return (b.counts['2x2'] || 0) - (a.counts['2x2'] || 0);
        return (b.totalTiles || 0) - (a.totalTiles || 0);
      })[0] || null;

    // All 3x3: Only 3x3 crops
    const all3x3 = layouts.find(l =>
      (l.counts['4x4'] || 0) === 0 && (l.counts['3x3'] || 0) > 0 &&
      (l.counts['2x2'] || 0) === 0 && (l.counts['1x1'] || 0) === 0
    ) || null;

    // Max 3x3: Highest 3x3 count (no 4x4)
    const max3x3Candidate = [...layouts]
      .filter(l => (l.counts['4x4'] || 0) === 0)
      .sort((a, b) => {
        if ((b.counts['3x3'] || 0) !== (a.counts['3x3'] || 0)) return (b.counts['3x3'] || 0) - (a.counts['3x3'] || 0);
        if ((b.counts['2x2'] || 0) !== (a.counts['2x2'] || 0)) return (b.counts['2x2'] || 0) - (a.counts['2x2'] || 0);
        return (b.counts['1x1'] || 0) - (a.counts['1x1'] || 0);
      })[0] || null;

    // All 4x4: Only 4x4 crops
    const all4x4 = layouts.find(l =>
      (l.counts['4x4'] || 0) > 0 && (l.counts['3x3'] || 0) === 0 &&
      (l.counts['2x2'] || 0) === 0 && (l.counts['1x1'] || 0) === 0
    ) || null;

    // Max 4x4: Highest 4x4 count
    const max4x4Candidate = [...layouts].sort((a, b) => {
      if ((b.counts['4x4'] || 0) !== (a.counts['4x4'] || 0)) return (b.counts['4x4'] || 0) - (a.counts['4x4'] || 0);
      if ((b.counts['3x3'] || 0) !== (a.counts['3x3'] || 0)) return (b.counts['3x3'] || 0) - (a.counts['3x3'] || 0);
      if ((b.counts['2x2'] || 0) !== (a.counts['2x2'] || 0)) return (b.counts['2x2'] || 0) - (a.counts['2x2'] || 0);
      return (b.counts['1x1'] || 0) - (a.counts['1x1'] || 0);
    })[0] || null;

    return {
      all1x1,
      all2x2,
      max2x2: sameLayout(all2x2, max2x2Candidate) ? null : max2x2Candidate,
      all3x3,
      max3x3: sameLayout(all3x3, max3x3Candidate) ? null : max3x3Candidate,
      all4x4,
      max4x4: sameLayout(all4x4, max4x4Candidate) ? null : max4x4Candidate
    };
  }

  /**
   * Build the list of categorized layout cards for display
   */
  buildCategoryCards(categorized, availableTiles) {
    const cardDefs = [
      { key: 'all1x1', label: 'All 1x1', sizeClass: 'size-1' },
      { key: 'all2x2', label: 'All 2x2', sizeClass: 'size-2' },
      { key: 'max2x2', label: 'Max 2x2', sizeClass: 'size-2' },
      { key: 'all3x3', label: 'All 3x3', sizeClass: 'size-3' },
      { key: 'max3x3', label: 'Max 3x3', sizeClass: 'size-3' },
      { key: 'all4x4', label: 'All 4x4', sizeClass: 'size-4' },
      { key: 'max4x4', label: 'Max 4x4', sizeClass: 'size-4' }
    ];

    return cardDefs
      .filter(def => categorized[def.key] !== null)
      .map(def => ({ ...def, layout: categorized[def.key], availableTiles }));
  }

  /**
   * Render a categorized layout card matching the in-app UI
   */
  renderCategorizedCard(card) {
    const { layout, label, sizeClass, availableTiles } = card;
    const counts = layout.counts || {};
    const color = this.getCategoryColor(sizeClass);
    const totalTiles = layout.totalTiles || 0;
    const efficiency = availableTiles > 0 ? Math.round((totalTiles / availableTiles) * 100) : 0;
    const itemCount = (counts['4x4'] || 0) + (counts['3x3'] || 0) + (counts['2x2'] || 0) + (counts['1x1'] || 0);

    const countBadges = [];
    if ((counts['4x4'] || 0) > 0) countBadges.push(`<span class="count-badge size-4">${counts['4x4']}x4x4</span>`);
    if ((counts['3x3'] || 0) > 0) countBadges.push(`<span class="count-badge size-3">${counts['3x3']}x3x3</span>`);
    if ((counts['2x2'] || 0) > 0) countBadges.push(`<span class="count-badge size-2">${counts['2x2']}x2x2</span>`);
    if ((counts['1x1'] || 0) > 0) countBadges.push(`<span class="count-badge size-1">${counts['1x1']}x1x1</span>`);

    // Render mini grid — reuse existing method with converted data
    const displayLayout = this.convertLayoutForMiniGrid(layout);
    const miniGrid = this.isCommunityLand ? this.renderMiniGrid(displayLayout) : this.renderNFTMiniGrid(displayLayout);

    return `
      <div class="optimal-layout-card" style="border-color: ${color.border}; background: ${color.bg};">
        <div class="layout-card-header">
          <div class="layout-category-label ${sizeClass}">${label}</div>
          <div class="layout-counts">${countBadges.join('')}</div>
          <div class="layout-stats-row">
            <span class="layout-stat">${itemCount} items</span>
            <span class="layout-stat">${totalTiles}/${availableTiles}</span>
            <span class="layout-stat efficiency">${efficiency}%</span>
          </div>
        </div>
        ${miniGrid}
      </div>
    `;
  }

  /**
   * Convert a raw layout to the format expected by mini-grid renderers
   */
  convertLayoutForMiniGrid(layout) {
    const rawPlacements = layout.placements || [];
    const placements = rawPlacements.map(p => ({
      x: p.x,
      y: p.y,
      width: p.w || parseInt(p.size?.split('x')[0] || '1', 10),
      height: p.h || parseInt(p.size?.split('x')[1] || '1', 10),
      size: p.size
    }));

    return {
      ...layout,
      placements,
      housePosition: layout.housePosition || this.houseState.housePosition,
      houseRotation: layout.houseRotation != null ? layout.houseRotation : this.houseState.houseRotation
    };
  }

  /**
   * Get color for a category size class
   */
  getCategoryColor(sizeClass) {
    const colors = {
      'size-1': { bg: 'rgba(251, 191, 36, 0.1)', border: 'rgba(251, 191, 36, 0.4)' },
      'size-2': { bg: 'rgba(59, 130, 246, 0.1)', border: 'rgba(59, 130, 246, 0.4)' },
      'size-3': { bg: 'rgba(168, 85, 247, 0.1)', border: 'rgba(168, 85, 247, 0.4)' },
      'size-4': { bg: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.4)' }
    };
    return colors[sizeClass] || colors['size-1'];
  }

  /**
   * Open the layout explorer modal with all layouts
   */
  openLayoutExplorer(allLayouts, availableTiles) {
    this.allExplorerLayouts = allLayouts;
    this.explorerAvailableTiles = availableTiles;

    const modal = document.getElementById('layoutExplorerModal');
    if (!modal) return;
    modal.style.display = 'flex';

    // Wire up close button
    const closeBtn = document.getElementById('closeExplorerBtn');
    if (closeBtn) {
      closeBtn.onclick = () => this.closeLayoutExplorer();
    }

    // Wire up backdrop click
    modal.onclick = (e) => {
      if (e.target === modal) this.closeLayoutExplorer();
    };

    // Wire up filter checkboxes
    modal.querySelectorAll('.filter-checkbox input').forEach(cb => {
      cb.onchange = () => this.renderExplorerLayouts();
    });

    // Reset filters
    modal.querySelectorAll('.filter-checkbox input').forEach(cb => { cb.checked = false; });

    this.renderExplorerLayouts();
  }

  closeLayoutExplorer() {
    const modal = document.getElementById('layoutExplorerModal');
    if (modal) modal.style.display = 'none';
  }

  /**
   * Render layouts inside the explorer modal, respecting active filters
   */
  renderExplorerLayouts() {
    const container = document.getElementById('explorerLayoutsList');
    if (!container) return;

    const modal = document.getElementById('layoutExplorerModal');
    const activeFilters = [];
    modal.querySelectorAll('.filter-checkbox input:checked').forEach(cb => {
      activeFilters.push(cb.dataset.filter);
    });

    let layouts = this.allExplorerLayouts || [];

    // Apply filters — show layouts that contain ANY of the checked sizes
    if (activeFilters.length > 0) {
      layouts = layouts.filter(l => {
        return activeFilters.some(f => (l.counts[f] || 0) > 0);
      });
    }

    if (layouts.length === 0) {
      container.innerHTML = '<div class="no-results">No layouts match your filters</div>';
      return;
    }

    const availTiles = this.explorerAvailableTiles || 0;
    container.innerHTML = layouts.map(layout => {
      const counts = layout.counts || {};
      const totalTiles = layout.totalTiles || 0;
      const efficiency = availTiles > 0 ? Math.round((totalTiles / availTiles) * 100) : 0;
      const itemCount = (counts['4x4'] || 0) + (counts['3x3'] || 0) + (counts['2x2'] || 0) + (counts['1x1'] || 0);

      const countBadges = [];
      if ((counts['1x1'] || 0) > 0) countBadges.push(`<span class="count-badge size-1">${counts['1x1']}x1x1</span>`);
      if ((counts['2x2'] || 0) > 0) countBadges.push(`<span class="count-badge size-2">${counts['2x2']}x2x2</span>`);
      if ((counts['3x3'] || 0) > 0) countBadges.push(`<span class="count-badge size-3">${counts['3x3']}x3x3</span>`);
      if ((counts['4x4'] || 0) > 0) countBadges.push(`<span class="count-badge size-4">${counts['4x4']}x4x4</span>`);

      const displayLayout = this.convertLayoutForMiniGrid(layout);
      const miniGrid = this.isCommunityLand ? this.renderMiniGrid(displayLayout) : this.renderNFTMiniGrid(displayLayout);

      const primarySize = (counts['4x4'] || 0) > 0 ? 'size-4' : (counts['3x3'] || 0) > 0 ? 'size-3' : (counts['2x2'] || 0) > 0 ? 'size-2' : 'size-1';
      const color = this.getCategoryColor(primarySize);

      return `
        <div class="optimal-layout-card" style="border-color: ${color.border}; background: ${color.bg};">
          <div class="layout-counts">${countBadges.join('')}</div>
          <div class="layout-stats-row">
            <span class="layout-stat">${itemCount} items</span>
            <span class="layout-stat">${totalTiles}/${availTiles} tiles</span>
            <span class="layout-stat efficiency">${efficiency}%</span>
          </div>
          ${miniGrid}
        </div>
      `;
    }).join('');
  }

  /**
   * Render community land layouts using categorized strategy cards
   */
  renderCommunityLayouts() {
    const allLayouts = this.communityLayouts.layouts || [];
    const availableTiles = this.landData.tiles?.length || 0;

    // Categorize layouts
    const categorized = this.categorizeLayouts(allLayouts);
    const cards = this.buildCategoryCards(categorized, availableTiles);

    this.container.innerHTML = `
      <div class="optimized-panel">
        <h3 class="optimized-header">Suggested Layouts</h3>
        <div class="layouts-list">
          ${cards.map(card => this.renderCategorizedCard(card)).join('')}
        </div>
        ${allLayouts.length > 0 ? `
          <button class="explore-more-btn" id="explore-more-btn">
            Explore More Layouts (${allLayouts.length})
          </button>
        ` : ''}
      </div>
    `;

    // Wire up explore button
    const exploreBtn = this.container.querySelector('#explore-more-btn');
    if (exploreBtn) {
      exploreBtn.addEventListener('click', () => {
        this.openLayoutExplorer(allLayouts, availableTiles);
      });
    }
  }

  /**
   * Convert a community layout from brute-force format to display format
   */
  convertCommunityLayout(layout, idx) {
    const counts = layout.counts;
    const rawPlacements = layout.placements || [];

    // Convert placements to the format expected by renderMiniGrid
    // Brute-force uses {x, y, w, h, size}, renderMiniGrid expects {x, y, width, height, size}
    const placements = rawPlacements.map((p) => ({
      x: p.x,
      y: p.y,
      width: p.w || parseInt(p.size?.split('x')[0] || '1', 10),
      height: p.h || parseInt(p.size?.split('x')[1] || '1', 10),
      size: p.size
    }));

    // Determine the "size" for color scheme - use the largest component
    let size = 'mixed';
    if ((counts['4x4'] || 0) > 0 && counts['3x3'] === 0 && counts['2x2'] === 0 && counts['1x1'] === 0) size = '4x4';
    else if (counts['3x3'] > 0 && (counts['4x4'] || 0) === 0 && counts['2x2'] === 0 && counts['1x1'] === 0) size = '3x3';
    else if (counts['2x2'] > 0 && (counts['4x4'] || 0) === 0 && counts['3x3'] === 0 && counts['1x1'] === 0) size = '2x2';
    else if (counts['1x1'] > 0 && (counts['4x4'] || 0) === 0 && counts['3x3'] === 0 && counts['2x2'] === 0) size = '1x1';

    // Build name from counts
    const parts = [];
    if ((counts['4x4'] || 0) > 0) parts.push(`${counts['4x4']}× 4×4`);
    if (counts['3x3'] > 0) parts.push(`${counts['3x3']}× 3×3`);
    if (counts['2x2'] > 0) parts.push(`${counts['2x2']}× 2×2`);
    if (counts['1x1'] > 0) parts.push(`${counts['1x1']}× 1×1`);
    const name = parts.join(' + ');

    const totalItems = (counts['4x4'] || 0) + (counts['3x3'] || 0) + (counts['2x2'] || 0) + (counts['1x1'] || 0);
    const tilesUsed = layout.totalTiles || this.landData.tiles.length;
    const totalTiles = this.landData.tiles.length;

    return {
      id: `community-${idx}`,
      idx,
      name,
      size,
      counts,
      placements,
      itemCount: totalItems,
      tilesUsed,
      totalTiles,
      efficiency: Math.round((tilesUsed / totalTiles) * 100)
    };
  }

  /**
   * Render a community layout card with counts display and mini grid
   */
  renderCommunityLayoutCard(layout) {
    const color = this.getLayoutColor(layout.size);
    const { counts } = layout;

    // Build a simple visual representation of the layout mix
    const countDisplay = [];
    if ((counts['4x4'] || 0) > 0)
      countDisplay.push(`<span style="color: #10B981;">${counts['4x4']}× 4×4</span>`);
    if (counts['3x3'] > 0)
      countDisplay.push(`<span style="color: #A855F7;">${counts['3x3']}× 3×3</span>`);
    if (counts['2x2'] > 0)
      countDisplay.push(`<span style="color: #3B82F6;">${counts['2x2']}× 2×2</span>`);
    if (counts['1x1'] > 0)
      countDisplay.push(`<span style="color: #FBBF24;">${counts['1x1']}× 1×1</span>`);

    // Render mini grid preview
    const miniGrid = this.renderMiniGrid(layout);

    return `
      <div class="optimized-layout-card community-layout-card" data-layout-idx="${layout.idx}" style="background: ${color.bg}; border: 2px solid ${color.border};">
        <div class="optimized-layout-counts">${countDisplay.join(' + ')}</div>
        <div class="optimized-layout-stats">
          <span class="optimized-stat">${layout.itemCount} items</span>
          <span class="optimized-stat">${layout.tilesUsed} tiles</span>
          <span class="optimized-stat" style="color: ${color.accent}; font-weight: bold;">${layout.efficiency}%</span>
        </div>
        ${miniGrid}
      </div>
    `;
  }

  /**
   * Extract optimal house positions.
   * Uses pre-computed bestPositions from index.json.gz when available (matches in-app).
   * Falls back to scanning all layouts if index is missing.
   */
  extractOptimalHousePositions() {
    // Prefer index bestPositions (authoritative, matches in-app exactly)
    const bp = this.nftLayouts?.bestPositions;
    if (bp) {
      const bestFor = { '1x1': null, '2x2': null, '3x3': null, '4x4': null, maxTiles: null, balanced: null };
      const convert = (entry) => entry ? {
        counts: entry.counts,
        totalTiles: entry.totalTiles || 0,
        housePosition: { x: entry.x, y: entry.y },
        houseRotation: entry.rotation || 0,
        houseTiles: entry.houseTiles || []
      } : null;
      bestFor['1x1'] = convert(bp.best1x1);
      bestFor['2x2'] = convert(bp.best2x2);
      bestFor['3x3'] = convert(bp.best3x3);
      bestFor['4x4'] = convert(bp.best4x4);
      bestFor.maxTiles = convert(bp.bestTiles || bp.bestTotal);
      return bestFor;
    }

    // Fallback: scan layouts
    const layouts = this.nftLayouts?.layouts || [];
    if (layouts.length === 0) return null;

    const bestFor = { '1x1': null, '2x2': null, '3x3': null, '4x4': null, maxTiles: null, balanced: null };

    layouts.forEach((layout) => {
      const counts = layout.counts || {};
      const pos = layout.housePosition;
      const rot = layout.houseRotation;
      const totalTiles = layout.totalTiles || 0;

      if ((!bestFor['1x1'] || (counts['1x1']||0) > (bestFor['1x1'].counts['1x1']||0)) && (counts['1x1']||0) > 0)
        bestFor['1x1'] = { ...layout, housePosition: pos, houseRotation: rot };
      if ((!bestFor['2x2'] || (counts['2x2']||0) > (bestFor['2x2'].counts['2x2']||0)) && (counts['2x2']||0) > 0)
        bestFor['2x2'] = { ...layout, housePosition: pos, houseRotation: rot };
      if ((!bestFor['3x3'] || (counts['3x3']||0) > (bestFor['3x3'].counts['3x3']||0)) && (counts['3x3']||0) > 0)
        bestFor['3x3'] = { ...layout, housePosition: pos, houseRotation: rot };
      if ((!bestFor['4x4'] || (counts['4x4']||0) > (bestFor['4x4'].counts['4x4']||0)) && (counts['4x4']||0) > 0)
        bestFor['4x4'] = { ...layout, housePosition: pos, houseRotation: rot };
      if (!bestFor.maxTiles || totalTiles > bestFor.maxTiles.totalTiles)
        bestFor.maxTiles = { ...layout, housePosition: pos, houseRotation: rot };
    });

    return bestFor;
  }

  /**
   * Render optimal house positions panel (before house is placed)
   */
  renderOptimalHousePositions() {
    const bestPositions = this.extractOptimalHousePositions();

    if (!bestPositions) {
      this.showPlaceholder('No optimal positions found. Place your house anywhere.');
      return;
    }

    // Build cards for primary positions (shown by default)
    const primaryCards = [];

    if (bestPositions['1x1']) {
      primaryCards.push(
        this.renderHousePositionCard('1x1', bestPositions['1x1'], {
          label: 'Best for 1×1 Crops',
          color: '#FBBF24',
          description: `Max ${bestPositions['1x1'].counts['1x1']} small crops`
        })
      );
    }

    if (bestPositions['2x2']) {
      primaryCards.push(
        this.renderHousePositionCard('2x2', bestPositions['2x2'], {
          label: 'Best for 2×2 Crops',
          color: '#3B82F6',
          description: `Max ${bestPositions['2x2'].counts['2x2']} medium crops`
        })
      );
    }

    if (bestPositions['3x3']) {
      primaryCards.push(
        this.renderHousePositionCard('3x3', bestPositions['3x3'], {
          label: 'Best for 3×3 Crops',
          color: '#A855F7',
          description: `Max ${bestPositions['3x3'].counts['3x3']} large crops`
        })
      );
    }

    if (bestPositions['4x4']) {
      primaryCards.push(
        this.renderHousePositionCard('4x4', bestPositions['4x4'], {
          label: 'Best for 4×4 Crops',
          color: '#10B981',
          description: `Max ${bestPositions['4x4'].counts['4x4']} extra-large crops`
        })
      );
    }

    // Build cards for additional positions (shown when "More" is clicked)
    const additionalCards = [];

    if (bestPositions.maxTiles) {
      const counts = bestPositions.maxTiles.counts;
      const breakdown = [];
      if (counts['4x4'] > 0) breakdown.push(`${counts['4x4']}×4×4`);
      if (counts['3x3'] > 0) breakdown.push(`${counts['3x3']}×3×3`);
      if (counts['2x2'] > 0) breakdown.push(`${counts['2x2']}×2×2`);
      if (counts['1x1'] > 0) breakdown.push(`${counts['1x1']}×1×1`);
      additionalCards.push(
        this.renderHousePositionCard('maxTiles', bestPositions.maxTiles, {
          label: 'Max Total Tiles',
          color: '#6366F1',
          description: `${bestPositions.maxTiles.totalTiles} tiles (${breakdown.join(' + ')})`
        })
      );
    }

    if (bestPositions.balanced) {
      const counts = bestPositions.balanced.counts;
      additionalCards.push(
        this.renderHousePositionCard('balanced', bestPositions.balanced, {
          label: 'Balanced Mix',
          color: '#F59E0B',
          description: `${counts['4x4'] || 0}×4×4 + ${counts['3x3']}×3×3 + ${counts['2x2']}×2×2 + ${counts['1x1']}×1×1`
        })
      );
    }

    // Determine if we have additional positions to show
    const hasMore = additionalCards.length > 0;
    const showingMore = this.showingMoreHousePositions;

    this.container.innerHTML = `
      <div class="optimized-panel">
        <h3 class="optimized-header">Optimal House Positions</h3>
        <p class="optimized-desc">
          Click a position to place your house for maximum crop efficiency.
          <br><small style="color: #888;">Different positions optimize for different crop sizes.</small>
        </p>
        <div class="optimized-layouts-list">
          ${primaryCards.join('')}
          ${showingMore ? additionalCards.join('') : ''}
        </div>
        ${
          hasMore && !showingMore
            ? `
          <button class="optimized-explore-btn" id="more-positions-btn">
            More Positions
          </button>
        `
            : ''
        }
        ${
          showingMore
            ? `
          <button class="optimized-explore-btn optimized-collapse-btn" id="less-positions-btn">
            Show Less
          </button>
        `
            : ''
        }
      </div>
    `;

    // Add click handlers for house position cards
    this.container.querySelectorAll('.house-position-card').forEach((card) => {
      card.addEventListener('click', () => {
        const x = parseInt(card.dataset.houseX, 10);
        const y = parseInt(card.dataset.houseY, 10);
        const rotation = parseInt(card.dataset.houseRotation, 10);

        // Trigger callback to place house on grid
        if (this.onApplyLayout) {
          this.onApplyLayout({
            isHousePositionHint: true,
            housePosition: { x, y },
            houseRotation: rotation
          });
        }
      });
    });

    // Add "More Positions" button handler
    const moreBtn = this.container.querySelector('#more-positions-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        this.showingMoreHousePositions = true;
        this.renderOptimalHousePositions();
      });
    }

    // Add "Show Less" button handler
    const lessBtn = this.container.querySelector('#less-positions-btn');
    if (lessBtn) {
      lessBtn.addEventListener('click', () => {
        this.showingMoreHousePositions = false;
        this.renderOptimalHousePositions();
      });
    }
  }

  /**
   * Render a house position card
   */
  renderHousePositionCard(sizeKey, layout, options) {
    const { label, color, description } = options;
    const pos = layout.housePosition;
    const rot = layout.houseRotation;

    // Render mini grid showing house position
    const miniGrid = this.renderHousePositionMiniGrid(layout);

    return `
      <div class="optimized-layout-card house-position-card"
           data-house-x="${pos.x}"
           data-house-y="${pos.y}"
           data-house-rotation="${rot}"
           style="background: rgba(${LandOptimized.hexToRgb(color)}, 0.15); border: 2px solid ${color};">
        <div class="optimized-layout-counts" style="color: ${color}; font-weight: bold;">
          ${label}
        </div>
        <div class="optimized-layout-house" style="font-size: 11px; color: #888; margin: 4px 0;">
          🏠 Position (${pos.x}, ${pos.y}) rotation ${rot}°
        </div>
        <div class="optimized-layout-stats">
          <span class="optimized-stat">${description}</span>
        </div>
        ${miniGrid}
      </div>
    `;
  }

  /**
   * Convert hex color to RGB values
   */
  static hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
    }
    return '128, 128, 128';
  }

  /**
   * Render mini grid showing house position (without crops)
   */
  renderHousePositionMiniGrid(layout) {
    const { width, height, tiles } = this.landData;
    const tileSet = new Set(tiles.map((t) => `${t.x},${t.y}`));
    const maxGridWidth = 200;
    const cellSize = Math.max(14, Math.min(20, Math.floor(maxGridWidth / width)));

    // Use pre-computed houseTiles from index if available (already positioned+rotated)
    const houseTilesSet = new Set();
    const doorTilesSet = new Set();
    if (layout.houseTiles && layout.houseTiles.length > 0) {
      layout.houseTiles.forEach((t) => houseTilesSet.add(`${t.x},${t.y}`));
    } else {
      const houseTiles = this.getHouseTilesAtPosition(layout.housePosition, layout.houseRotation);
      houseTiles.house.forEach((t) => houseTilesSet.add(`${t.x},${t.y}`));
      houseTiles.door.forEach((t) => doorTilesSet.add(`${t.x},${t.y}`));
      houseTiles.clearance.forEach((t) => houseTilesSet.add(`${t.x},${t.y}`));
    }

    const gridWidth = width * cellSize;
    const gridHeight = height * cellSize;

    // Build base grid cells
    let cells = '';
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const key = `${x},${y}`;
        const isValid = tileSet.has(key);
        const isHouse = houseTilesSet.has(key);
        const isDoor = doorTilesSet.has(key);

        let cellStyle = 'border: 1px solid rgba(255, 255, 255, 0.08);';
        if (!isValid) {
          cellStyle += ' background: transparent;';
        } else if (isDoor) {
          cellStyle += ' background: #B45309;'; // Door - amber
        } else if (isHouse) {
          cellStyle += ' background: #6B7280;'; // House - gray
        } else {
          cellStyle += ' background: #5C4A3D;'; // Available land
        }

        cells += `<div class="optimized-mini-cell" style="${cellStyle}"></div>`;
      }
    }

    return `
      <div class="optimized-mini-grid" style="
        display: grid;
        position: relative;
        width: ${gridWidth}px;
        height: ${gridHeight}px;
        grid-template-columns: repeat(${width}, ${cellSize}px);
        grid-template-rows: repeat(${height}, ${cellSize}px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 4px;
        margin-top: 8px;
        overflow: hidden;
      ">
        ${cells}
      </div>
    `;
  }

  /**
   * Render NFT layouts filtered to match user's actual house position,
   * using categorized strategy cards matching the in-app UI
   */
  renderNFTLayoutsForHousePosition() {
    const allLayouts = this.nftLayouts?.layouts || [];
    const userPos = this.houseState.housePosition;
    const userRot = this.houseState.houseRotation;

    if (!userPos) {
      this.renderOptimalHousePositions();
      return;
    }

    // Filter layouts to only those matching user's house position
    const matchingLayouts = allLayouts.filter((layout) => {
      const pos = layout.housePosition;
      const rot = layout.houseRotation;
      return pos.x === userPos.x && pos.y === userPos.y && rot === userRot;
    });

    if (matchingLayouts.length === 0) {
      this.container.innerHTML = `
        <div class="optimized-panel">
          <h3 class="optimized-header">Suggested Layouts</h3>
          <p class="optimized-desc" style="color: #F59E0B;">
            No pre-computed layouts for this position. Generating...
          </p>
        </div>
      `;
      this.renderDynamicLayouts();
      return;
    }

    // Calculate available tiles (total - house)
    const totalLandTiles = this.landData.tiles?.length || 0;
    const blockedCount = this.blockedTiles.size;
    const availableTiles = totalLandTiles - blockedCount;

    // Categorize and render
    const categorized = this.categorizeLayouts(matchingLayouts);
    const cards = this.buildCategoryCards(categorized, availableTiles);

    this.container.innerHTML = `
      <div class="optimized-panel">
        <h3 class="optimized-header">Suggested Layouts</h3>
        <div class="layouts-list">
          ${cards.map(card => this.renderCategorizedCard(card)).join('')}
        </div>
        ${matchingLayouts.length > 0 ? `
          <button class="explore-more-btn" id="explore-more-btn">
            Explore More Layouts (${matchingLayouts.length})
          </button>
        ` : ''}
      </div>
    `;

    // Wire up explore button
    const exploreBtn = this.container.querySelector('#explore-more-btn');
    if (exploreBtn) {
      exploreBtn.addEventListener('click', () => {
        this.openLayoutExplorer(matchingLayouts, availableTiles);
      });
    }
  }

  /**
   * Render a crop layout card (for after house is placed)
   */
  renderCropLayoutCard(layout) {
    const color = this.getLayoutColor(layout.size);
    const { counts } = layout;

    // Build crop count display
    const countDisplay = [];
    if ((counts['4x4'] || 0) > 0)
      countDisplay.push(`<span style="color: #10B981;">${counts['4x4']}× 4×4</span>`);
    if (counts['3x3'] > 0)
      countDisplay.push(`<span style="color: #A855F7;">${counts['3x3']}× 3×3</span>`);
    if (counts['2x2'] > 0)
      countDisplay.push(`<span style="color: #3B82F6;">${counts['2x2']}× 2×2</span>`);
    if (counts['1x1'] > 0)
      countDisplay.push(`<span style="color: #FBBF24;">${counts['1x1']}× 1×1</span>`);

    // Render mini grid preview
    const miniGrid = this.renderNFTMiniGrid(layout);

    return `
      <div class="optimized-layout-card crop-layout-card" data-layout-idx="${layout.idx}" style="background: ${color.bg}; border: 2px solid ${color.border};">
        <div class="optimized-layout-counts">${countDisplay.join(' + ')}</div>
        <div class="optimized-layout-stats">
          <span class="optimized-stat">${layout.itemCount} items</span>
          <span class="optimized-stat">${layout.tilesUsed}/${layout.availableTiles}</span>
          <span class="optimized-stat" style="color: ${color.accent}; font-weight: bold;">${layout.efficiency}%</span>
        </div>
        ${miniGrid}
      </div>
    `;
  }

  /**
   * Convert an NFT layout from brute-force format to display format
   */
  convertNFTLayout(layout, idx) {
    const counts = layout.counts;
    const rawPlacements = layout.placements || [];

    // Convert placements to the format expected by renderMiniGrid
    const placements = rawPlacements.map((p) => ({
      x: p.x,
      y: p.y,
      width: p.w || parseInt(p.size?.split('x')[0] || '1', 10),
      height: p.h || parseInt(p.size?.split('x')[1] || '1', 10),
      size: p.size
    }));

    // Determine the "size" for color scheme
    let size = 'mixed';
    if ((counts['4x4'] || 0) > 0 && counts['3x3'] === 0 && counts['2x2'] === 0 && counts['1x1'] === 0) size = '4x4';
    else if (counts['3x3'] > 0 && (counts['4x4'] || 0) === 0 && counts['2x2'] === 0 && counts['1x1'] === 0) size = '3x3';
    else if (counts['2x2'] > 0 && (counts['4x4'] || 0) === 0 && counts['3x3'] === 0 && counts['1x1'] === 0) size = '2x2';
    else if (counts['1x1'] > 0 && (counts['4x4'] || 0) === 0 && counts['3x3'] === 0 && counts['2x2'] === 0) size = '1x1';

    // Build name from counts
    const parts = [];
    if ((counts['4x4'] || 0) > 0) parts.push(`${counts['4x4']}× 4×4`);
    if (counts['3x3'] > 0) parts.push(`${counts['3x3']}× 3×3`);
    if (counts['2x2'] > 0) parts.push(`${counts['2x2']}× 2×2`);
    if (counts['1x1'] > 0) parts.push(`${counts['1x1']}× 1×1`);
    const name = parts.join(' + ');

    const totalItems = (counts['4x4'] || 0) + (counts['3x3'] || 0) + (counts['2x2'] || 0) + (counts['1x1'] || 0);
    const tilesUsed = layout.totalTiles || 0;
    const availableTiles = layout.availableTiles || this.landData.tiles.length;

    return {
      id: `nft-${idx}`,
      idx,
      name,
      size,
      counts,
      placements,
      itemCount: totalItems,
      tilesUsed,
      availableTiles,
      totalTiles: this.landData.tiles.length,
      efficiency: availableTiles > 0 ? Math.round((tilesUsed / availableTiles) * 100) : 0,
      // House placement info
      housePosition: layout.housePosition || { x: 0, y: 0 },
      houseRotation: layout.houseRotation || 0,
      // Store for use when applying layout
      isNFTLayout: true
    };
  }

  /**
   * Render mini grid preview for NFT layout (with house from the layout)
   */
  renderNFTMiniGrid(layout) {
    const { width, height, tiles } = this.landData;
    const tileSet = new Set(tiles.map((t) => `${t.x},${t.y}`));
    const maxGridWidth = 200;
    const cellSize = Math.max(14, Math.min(20, Math.floor(maxGridWidth / width)));

    // Colorblind-safe colors
    const sizeColors = {
      1: { bg: '#FBBF24', border: '#D97706', text: '#000000' },
      2: { bg: '#3B82F6', border: '#2563EB', text: '#FFFFFF' },
      3: { bg: '#A855F7', border: '#7C3AED', text: '#FFFFFF' },
      4: { bg: '#10B981', border: '#059669', text: '#FFFFFF' }
    };

    // Get house tiles at the layout's house position
    const houseTilesSet = new Set();
    const doorTilesSet = new Set();
    const houseTiles = this.getHouseTilesAtPosition(layout.housePosition, layout.houseRotation);
    houseTiles.house.forEach((t) => houseTilesSet.add(`${t.x},${t.y}`));
    houseTiles.door.forEach((t) => doorTilesSet.add(`${t.x},${t.y}`));
    houseTiles.clearance.forEach((t) => houseTilesSet.add(`${t.x},${t.y}`));

    const gridWidth = width * cellSize;
    const gridHeight = height * cellSize;

    // Build base grid cells
    let cells = '';
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const key = `${x},${y}`;
        const isValid = tileSet.has(key);
        const isHouse = houseTilesSet.has(key);
        const isDoor = doorTilesSet.has(key);

        let bgColor = 'transparent';
        if (isValid) {
          if (isDoor) {
            bgColor = '#B45309';
          } else if (isHouse) {
            bgColor = '#6B7280';
          } else {
            bgColor = '#5C4A3D';
          }
        }
        const cellStyle = `background: ${bgColor}; border: none;`;

        cells += `<div class="optimized-mini-cell" style="${cellStyle}"></div>`;
      }
    }

    // Build item silhouettes
    let items = '';
    if (layout.placements) {
      layout.placements.forEach((p) => {
        const size = p.width || parseInt(p.size?.split('x')[0] || '1', 10);
        const colors = sizeColors[size] || sizeColors[1];

        const left = p.x * cellSize;
        const top = p.y * cellSize;
        const w = size * cellSize;
        const h = size * cellSize;

        const baseFontSize = Math.max(6, cellSize - 2);
        const fontSizeMultiplier = { 1: 1, 2: 1.5, 3: 2, 4: 2.5 };
        const fontSize = baseFontSize * (fontSizeMultiplier[size] || 1);

        items += `
          <div style="
            position: absolute;
            left: ${left}px;
            top: ${top}px;
            width: ${w}px;
            height: ${h}px;
            background: ${colors.bg};
            border: 1px solid ${colors.border};
            border-radius: 1px;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: ${fontSize}px;
            font-weight: bold;
            color: ${colors.text};
            text-shadow: ${size === 1 ? 'none' : '0 0 1px rgba(0,0,0,0.8)'};
            pointer-events: none;
          ">${size}</div>
        `;
      });
    }

    return `
      <div class="optimized-mini-grid" style="
        display: grid;
        position: relative;
        width: ${gridWidth}px;
        height: ${gridHeight}px;
        grid-template-columns: repeat(${width}, 1fr);
        grid-template-rows: repeat(${height}, 1fr);
        gap: 0;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 4px;
        margin-top: 8px;
        overflow: hidden;
      ">
        ${cells}
        ${items}
      </div>
    `;
  }

  /**
   * Render dynamic layouts (for NFT lands or when community data unavailable)
   */
  renderDynamicLayouts() {
    const layouts = this.generateOptimalLayouts();

    this.container.innerHTML = `
      <div class="optimized-panel">
        <h3 class="optimized-header">Optimal Layouts</h3>
        <p class="optimized-desc">Optimal placement patterns by item size.</p>
        <div class="optimized-layouts-list">
          ${layouts.map((layout) => this.renderLayoutCard(layout)).join('')}
        </div>
      </div>
    `;

    // Layout cards are display-only (not clickable)
    // Only house position cards are clickable
  }

  /**
   * Get color scheme for layout size
   * Colorblind-safe palette: Amber (1x1), Blue (2x2), Purple (3x3), Emerald (4x4)
   */
  // eslint-disable-next-line class-methods-use-this
  getLayoutColor(size) {
    const colors = {
      '1x1': { bg: 'rgba(251, 191, 36, 0.15)', border: '#FBBF24', accent: '#FBBF24' }, // Amber
      '2x2': { bg: 'rgba(59, 130, 246, 0.15)', border: '#3B82F6', accent: '#3B82F6' }, // Blue
      '3x3': { bg: 'rgba(168, 85, 247, 0.15)', border: '#A855F7', accent: '#A855F7' }, // Purple
      '4x4': { bg: 'rgba(16, 185, 129, 0.15)', border: '#10B981', accent: '#10B981' }, // Emerald
      mixed: { bg: 'rgba(236, 72, 153, 0.15)', border: '#EC4899', accent: '#EC4899' } // Pink
    };
    return colors[size] || colors.mixed;
  }

  /**
   * Render a single layout card with mini preview
   */
  renderLayoutCard(layout) {
    const miniGrid = this.renderMiniGrid(layout);
    const totalTiles = layout.totalTiles || this.landData.tiles.length;
    const color = this.getLayoutColor(layout.size);

    return `
      <div class="optimized-layout-card" data-layout-id="${layout.id}" style="background: ${color.bg}; border: 2px solid ${color.border};">
        <div class="optimized-layout-name" style="color: ${color.accent};">${layout.name}</div>
        <div class="optimized-layout-stats">
          <span class="optimized-stat">${layout.itemCount} items</span>
          <span class="optimized-stat">${layout.tilesUsed}/${totalTiles} tiles</span>
          <span class="optimized-stat" style="color: ${color.accent}; font-weight: bold;">${layout.efficiency}%</span>
        </div>
        ${miniGrid}
      </div>
    `;
  }

  /**
   * Render mini grid preview with silhouetted items
   * Each item shows its size (1, 2, or 3) to group them visually
   * Colorblind-safe palette: Amber (1x1), Blue (2x2), Purple (3x3)
   */
  renderMiniGrid(layout) {
    const { width, height, tiles } = this.landData;
    const tileSet = new Set(tiles.map((t) => `${t.x},${t.y}`));
    // Dynamic cell size based on land dimensions - fit within ~280px max width
    const maxGridWidth = 280;
    const cellSize = Math.min(12, Math.floor(maxGridWidth / width));

    // Colorblind-safe colors for each size
    // Amber, Blue, Purple, Emerald are distinguishable across all colorblindness types
    const sizeColors = {
      1: { bg: '#FBBF24', border: '#D97706', text: '#000000' }, // Amber - black text
      2: { bg: '#3B82F6', border: '#2563EB', text: '#FFFFFF' }, // Blue - white text
      3: { bg: '#A855F7', border: '#7C3AED', text: '#FFFFFF' }, // Purple - white text
      4: { bg: '#10B981', border: '#059669', text: '#FFFFFF' } // Emerald - white text
    };

    // Get house tiles for display
    const houseTilesSet = new Set();
    const doorTilesSet = new Set();
    if (this.landData.hasHouse && this.houseState.housePosition) {
      const houseTiles = this.getHouseTilesAtPosition(
        this.houseState.housePosition,
        this.houseState.houseRotation
      );
      houseTiles.house.forEach((t) => houseTilesSet.add(`${t.x},${t.y}`));
      houseTiles.door.forEach((t) => doorTilesSet.add(`${t.x},${t.y}`));
      houseTiles.clearance.forEach((t) => houseTilesSet.add(`${t.x},${t.y}`));
    }

    // Calculate grid dimensions
    const gridWidth = width * cellSize;
    const gridHeight = height * cellSize;

    // Build base grid cells (land, house, empty farmland)
    // Improved visibility with better contrast colors
    let cells = '';
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const key = `${x},${y}`;
        const isValid = tileSet.has(key);
        const isHouse = houseTilesSet.has(key);
        const isDoor = doorTilesSet.has(key);

        let bgColor = 'transparent';
        if (isValid) {
          if (isDoor) {
            bgColor = '#B45309'; // Dark amber - distinct from farmland
          } else if (isHouse) {
            bgColor = '#6B7280'; // Cool gray - better distinction
          } else {
            bgColor = '#5C4A3D'; // Warm taupe - better visibility
          }
        }
        const cellStyle = `background: ${bgColor}; border: none;`;

        cells += `<div class="optimized-mini-cell" style="${cellStyle}"></div>`;
      }
    }

    // Build item silhouettes with size labels
    let items = '';
    if (layout.placements) {
      layout.placements.forEach((p) => {
        const size = p.width || parseInt(p.size?.split('x')[0] || '1', 10);
        const colors = sizeColors[size] || sizeColors[1];

        // Position in pixels
        const left = p.x * cellSize;
        const top = p.y * cellSize;
        const w = size * cellSize;
        const h = size * cellSize;

        // Font size scales with item size and cell size
        const baseFontSize = Math.max(6, cellSize - 2);
        const fontSizeMultiplier = { 1: 1, 2: 1.5, 3: 2, 4: 2.5 };
        const fontSize = baseFontSize * (fontSizeMultiplier[size] || 1);

        items += `
          <div style="
            position: absolute;
            left: ${left}px;
            top: ${top}px;
            width: ${w}px;
            height: ${h}px;
            background: ${colors.bg};
            border: 1px solid ${colors.border};
            border-radius: 1px;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: ${fontSize}px;
            font-weight: bold;
            color: ${colors.text};
            text-shadow: ${size === 1 ? 'none' : '0 0 1px rgba(0,0,0,0.8)'};
            pointer-events: none;
          ">${size}</div>
        `;
      });
    }

    return `
      <div class="optimized-mini-grid" style="
        display: grid;
        position: relative;
        width: ${gridWidth}px;
        height: ${gridHeight}px;
        grid-template-columns: repeat(${width}, 1fr);
        grid-template-rows: repeat(${height}, 1fr);
        gap: 0;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 4px;
        margin-top: 8px;
        overflow: hidden;
      ">
        ${cells}
        ${items}
      </div>
    `;
  }

  /**
   * Generate optimal layouts for the current land type
   */
  generateOptimalLayouts() {
    const layouts = [];
    const tiles = this.landData.tiles;

    // Create tile set excluding blocked tiles (house area)
    const tileSet = new Set();
    tiles.forEach((t) => {
      const key = `${t.x},${t.y}`;
      if (!this.blockedTiles.has(key)) {
        tileSet.add(key);
      }
    });

    const availableTileCount = tileSet.size;

    // All 1x1 layout (maximum items)
    const all1x1 = this.calculateOptimalPlacement(1, 1, tileSet);
    layouts.push({
      id: 'all-1x1',
      name: 'All 1×1 Items',
      size: '1x1',
      placements: all1x1.placements,
      filledTiles: all1x1.filledTiles,
      itemCount: all1x1.placements.length,
      tilesUsed: all1x1.filledTiles.length,
      totalTiles: availableTileCount,
      efficiency: Math.round((all1x1.filledTiles.length / availableTileCount) * 100)
    });

    // All 2x2 layout
    const all2x2 = this.calculateOptimalPlacement(2, 2, tileSet);
    layouts.push({
      id: 'all-2x2',
      name: 'All 2×2 Items',
      size: '2x2',
      placements: all2x2.placements,
      filledTiles: all2x2.filledTiles,
      itemCount: all2x2.placements.length,
      tilesUsed: all2x2.filledTiles.length,
      totalTiles: availableTileCount,
      efficiency: Math.round((all2x2.filledTiles.length / availableTileCount) * 100)
    });

    // Mixed: Max 2x2 then fill with 1x1
    const mixed2x2Then1x1 = this.calculateMixedPlacement([2, 1], tileSet);
    layouts.push({
      id: 'mixed-2x2-1x1',
      name: 'Max 2×2, Fill 1×1',
      size: 'mixed',
      placements: mixed2x2Then1x1.placements,
      filledTiles: mixed2x2Then1x1.filledTiles,
      itemCount: mixed2x2Then1x1.placements.length,
      tilesUsed: mixed2x2Then1x1.filledTiles.length,
      totalTiles: availableTileCount,
      efficiency: Math.round((mixed2x2Then1x1.filledTiles.length / availableTileCount) * 100),
      breakdown: mixed2x2Then1x1.breakdown
    });

    // All 3x3 layout
    const all3x3 = this.calculateOptimalPlacement(3, 3, tileSet);
    layouts.push({
      id: 'all-3x3',
      name: 'All 3×3 Items',
      size: '3x3',
      placements: all3x3.placements,
      filledTiles: all3x3.filledTiles,
      itemCount: all3x3.placements.length,
      tilesUsed: all3x3.filledTiles.length,
      totalTiles: availableTileCount,
      efficiency: Math.round((all3x3.filledTiles.length / availableTileCount) * 100)
    });

    // Mixed: Max 3x3 then fill with 1x1
    const mixedLargeSmall = this.calculateMixedPlacement([3, 1], tileSet);
    layouts.push({
      id: 'mixed-3x3-1x1',
      name: 'Max 3×3, Fill 1×1',
      size: 'mixed',
      placements: mixedLargeSmall.placements,
      filledTiles: mixedLargeSmall.filledTiles,
      itemCount: mixedLargeSmall.placements.length,
      tilesUsed: mixedLargeSmall.filledTiles.length,
      totalTiles: availableTileCount,
      efficiency: Math.round((mixedLargeSmall.filledTiles.length / availableTileCount) * 100),
      breakdown: mixedLargeSmall.breakdown
    });

    return layouts;
  }

  /**
   * Calculate optimal placement for a single size using stride-based algorithm
   */
  // eslint-disable-next-line class-methods-use-this
  calculateOptimalPlacement(width, height, tileSet) {
    // Get bounds from available tiles
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    Array.from(tileSet).forEach((key) => {
      const [tx, ty] = key.split(',').map(Number);
      minX = Math.min(minX, tx);
      maxX = Math.max(maxX, tx);
      minY = Math.min(minY, ty);
      maxY = Math.max(maxY, ty);
    });

    const landWidth = maxX - minX + 1;
    const landHeight = maxY - minY + 1;
    const size = Math.max(width, height);
    const stride = size + 1; // Gap of 1 between chains (matches game rules)

    // Helper to check if a position is valid
    const canPlaceAt = (x, y) => {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          if (!tileSet.has(`${x + dx},${y + dy}`)) {
            return false;
          }
        }
      }
      return true;
    };

    // Strategy 1: All rows (horizontal chains with vertical gaps)
    const rowPositions = [];
    for (let y = minY; y + height <= minY + landHeight; y += stride) {
      for (let x = minX; x + width <= minX + landWidth; x += width) {
        if (canPlaceAt(x, y)) {
          rowPositions.push({ x, y });
        }
      }
    }

    // Strategy 2: All columns (vertical chains with horizontal gaps)
    const colPositions = [];
    for (let x = minX; x + width <= minX + landWidth; x += stride) {
      for (let y = minY; y + height <= minY + landHeight; y += height) {
        if (canPlaceAt(x, y)) {
          colPositions.push({ x, y });
        }
      }
    }

    // Select best strategy
    let bestPositions = rowPositions.length >= colPositions.length ? rowPositions : colPositions;

    // Convert positions to placements and filled tiles
    const placements = [];
    const filledTiles = [];
    bestPositions.forEach((pos) => {
      placements.push({ x: pos.x, y: pos.y, width, height });
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          filledTiles.push({ x: pos.x + dx, y: pos.y + dy });
        }
      }
    });

    return { placements, filledTiles };
  }

  /**
   * Calculate mixed placement with multiple sizes (prioritized largest first)
   */
  // eslint-disable-next-line class-methods-use-this
  calculateMixedPlacement(sizes, tileSet) {
    const placements = [];
    const filledTiles = [];
    const usedTiles = new Set();
    const blockedTiles = new Set();
    const breakdown = {};

    // Get bounds
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    Array.from(tileSet).forEach((key) => {
      const [tx, ty] = key.split(',').map(Number);
      minX = Math.min(minX, tx);
      maxX = Math.max(maxX, tx);
      minY = Math.min(minY, ty);
      maxY = Math.max(maxY, ty);
    });

    const landWidth = maxX - minX + 1;
    const landHeight = maxY - minY + 1;

    // Helper to check if a position is valid
    const canPlaceAt = (x, y, size) => {
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const key = `${x + dx},${y + dy}`;
          if (!tileSet.has(key) || usedTiles.has(key) || blockedTiles.has(key)) {
            return false;
          }
        }
      }
      return true;
    };

    // Helper to block 1-tile perimeter around an item
    const blockPerimeter = (x, y, size) => {
      for (let dy = -1; dy <= size; dy++) {
        for (let dx = -1; dx <= size; dx++) {
          if (dx >= 0 && dx < size && dy >= 0 && dy < size) continue;
          blockedTiles.add(`${x + dx},${y + dy}`);
        }
      }
    };

    // Process each size in order (largest first)
    sizes.forEach((size) => {
      if (size === 1) {
        // For 1x1, fill remaining valid tiles
        let count = 0;
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            if (canPlaceAt(x, y, 1)) {
              placements.push({ x, y, width: 1, height: 1, size: '1x1' });
              usedTiles.add(`${x},${y}`);
              filledTiles.push({ x, y });
              count += 1;
            }
          }
        }
        breakdown['1x1'] = count;
      } else {
        // For larger sizes, use stride-based placement
        const stride = size + 1;
        let count = 0;

        for (let y = minY; y + size <= minY + landHeight; y += stride) {
          for (let x = minX; x + size <= minX + landWidth; x += size) {
            if (canPlaceAt(x, y, size)) {
              placements.push({ x, y, width: size, height: size, size: `${size}x${size}` });
              for (let dy = 0; dy < size; dy++) {
                for (let dx = 0; dx < size; dx++) {
                  usedTiles.add(`${x + dx},${y + dy}`);
                  filledTiles.push({ x: x + dx, y: y + dy });
                }
              }
              blockPerimeter(x, y, size);
              count += 1;
            }
          }
        }
        breakdown[`${size}x${size}`] = count;
      }
    });

    return { placements, filledTiles, breakdown };
  }
}

// Expose globally for demo
window.LandOptimized = LandOptimized;
