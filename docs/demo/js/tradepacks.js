/**
 * Tradepack Calculator Tab
 * Displays tradepacks, calculates profits, and shows material sources
 * Demo version - adapted for web
 */

let tradepackData = null;
let selectedTradepack = null;
let userProfile = null;
let simulationModal = null;
let currentMaterialWeights = {};
let currentSimulationTradepack = null;

/**
 * Get local icon path for a tradepack
 */
function getTradepackIconUrl(tp) {
  if (tp.imagePath) {
    // imagePath is like "assets/images/tradepacks/aged-meat.webp" — use as-is
    return tp.imagePath;
  }
  // Fallback: derive from id
  return `assets/images/tradepacks/${tp.id.replace(/_/g, '-')}.webp`;
}

/**
 * Initialize the tradepack calculator tab
 */
async function initTradepacks() {
  try {
    // Initialize crop icons cache first
    if (window.CropIcons) {
      await window.CropIcons.init();
    }

    tradepackData = await window.electronAPI.getTradepackData();
    userProfile = await window.electronAPI.getProfile();

    renderTradepackList();
    setupTradepackFilters();
    createSimulationModal();
    renderLandsSummary();
    setupLandsSummaryHandlers();

    // Listen for owned lands updates from other tabs
    window.addEventListener('ownedLandsUpdated', () => {
      renderLandsSummary();
    });
  } catch (error) {
    console.error('Failed to load tradepack data:', error);
    const container = document.getElementById('tradepacksListContainer');
    if (container) {
      container.innerHTML = '<p class="error-message">Failed to load tradepack data</p>';
    }
  }
}

/**
 * Setup filter and search handlers
 */
function setupTradepackFilters() {
  const searchInput = document.getElementById('tradepackSearch');
  const sortSelect = document.getElementById('tradepackSort');

  if (searchInput) {
    searchInput.addEventListener('input', window.debounce(renderTradepackList, 200));
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', renderTradepackList);
  }
}

/**
 * Render the lands summary panel
 */
async function renderLandsSummary() {
  const container = document.getElementById('landsSummaryContent');
  if (!container) return;

  try {
    const ownedLandsData = await window.electronAPI.getOwnedLands();

    if (!ownedLandsData.totalTiles || ownedLandsData.totalTiles.total === 0) {
      container.innerHTML = `
        <div class="lands-empty-state">
          <p>No lands configured yet</p>
          <p class="empty-state-hint">Use the button below or visit the Land Simulator tab to configure your lands.</p>
        </div>
      `;
      return;
    }

    const landNames = {
      SMALL_COMMUNITY: 'Small Community',
      MEDIUM_COMMUNITY: 'Medium Community',
      LARGE_COMMUNITY: 'Large Community',
      NFT_SMALL: 'NFT Small',
      NFT_MEDIUM: 'NFT Medium',
      NFT_LARGE: 'NFT Large',
      NFT_STRONGHOLD: 'NFT Stronghold',
      NFT_FORT: 'NFT Fort'
    };

    let landsHtml = '<div class="lands-summary-section">';
    landsHtml += '<div class="lands-summary-section-title">Owned Lands</div>';

    for (const [type, count] of Object.entries(ownedLandsData.ownedLands || {})) {
      if (count > 0) {
        landsHtml += `
          <div class="land-summary-row">
            <span>${landNames[type]}</span>
            <span class="count">x${count}</span>
          </div>
        `;
      }
    }

    landsHtml += `
      <div class="land-summary-total">
        <span>Total Tiles</span>
        <span>${ownedLandsData.totalTiles.total}</span>
      </div>
    </div>`;

    container.innerHTML = landsHtml;
  } catch (error) {
    console.error('Error loading lands summary:', error);
    container.innerHTML =
      '<div class="lands-empty-state"><p>Error loading lands</p><p class="empty-state-hint">Try reloading or check the Land Simulator tab.</p></div>';
  }
}

/**
 * Setup event handlers for the lands summary panel
 */
function setupLandsSummaryHandlers() {
  const configureBtn = document.getElementById('configureLandsBtn');
  if (configureBtn) {
    configureBtn.addEventListener('click', () => {
      const landTab = document.querySelector('[data-tab="land"]');
      if (landTab) {
        landTab.click();
      }
    });
  }
}

/**
 * Render the tradepack list
 */
function renderTradepackList() {
  const container = document.getElementById('tradepacksListContainer');
  const countEl = document.getElementById('tradepackCount');

  if (!container || !tradepackData) return;

  const searchTerm = document.getElementById('tradepackSearch')?.value.toLowerCase() || '';
  const sortBy = document.getElementById('tradepackSort')?.value || 'name';

  // Filter tradepacks
  const tradepacks = (tradepackData.tradepacks || []).filter((tp) => {
    if (!searchTerm) return true;
    if (tp.name.toLowerCase().includes(searchTerm)) return true;
    if (tp.materials?.some((m) => m.item.toLowerCase().includes(searchTerm))) return true;
    return false;
  });

  // Sort tradepacks
  tradepacks.sort((a, b) => {
    if (sortBy === 'total_cost') {
      return (b.total_cost || 0) - (a.total_cost || 0);
    }
    return a.name.localeCompare(b.name);
  });

  // Update count
  if (countEl) {
    countEl.textContent = tradepacks.length;
  }

  // Render items
  container.innerHTML = tradepacks
    .map(
      (tp) => `
    <div class="tradepack-item ${selectedTradepack?.id === tp.id ? 'selected' : ''}"
         data-id="${tp.id}">
      <div class="tradepack-header">
        <img class="tradepack-icon" src="${getTradepackIconUrl(tp)}" alt="${tp.name}" onerror="this.style.display='none'" />
        <span class="tradepack-name">${tp.name}</span>
      </div>
      <div class="tradepack-materials">
        ${tp.materials
          .slice(0, 3)
          .map((m) => `<span class="material-tag">${m.item}</span>`)
          .join('')}
        ${tp.materials.length > 3 ? `<span class="material-more">+${tp.materials.length - 3}</span>` : ''}
      </div>
      <div class="tradepack-value">
        ${tp.total_cost ? `${tp.total_cost.toLocaleString()} silver` : 'Value unknown'}
      </div>
      <button class="simulate-land-btn" data-id="${tp.id}" title="Simulate on Land">
        Simulate
      </button>
    </div>
  `
    )
    .join('');

  // Add click handlers for item selection
  container.querySelectorAll('.tradepack-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.simulate-land-btn')) return;
      selectTradepack(item.dataset.id);
    });
  });

  // Add click handlers for simulate buttons
  container.querySelectorAll('.simulate-land-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tp = tradepackData.tradepacks.find((t) => t.id === btn.dataset.id);
      if (tp) openSimulationModal(tp);
    });
  });
}

/**
 * Select a tradepack and show details
 */
async function selectTradepack(tradepackId) {
  const tp = tradepackData.tradepacks.find((t) => t.id === tradepackId);
  if (!tp) return;

  selectedTradepack = tp;

  // Update selection UI
  document.querySelectorAll('.tradepack-item').forEach((item) => {
    item.classList.toggle('selected', item.dataset.id === tradepackId);
  });

  // Show details panel
  const detailPanel = document.getElementById('tradepackDetailPanel');
  if (!detailPanel) return;

  // Calculate profit
  let profitData = null;
  try {
    profitData = await window.electronAPI.calculateTradepackProfit({
      tradepack: tp,
      demandMultiplier: 1.0
    });
  } catch (error) {
    console.error('Failed to calculate profit:', error);
  }

  detailPanel.innerHTML = `
    <div class="tradepack-detail">
      <h3>${tp.name}</h3>

      <div class="detail-section">
        <h4>Materials Required</h4>
        <div class="materials-list">
          ${tp.materials
            .map(
              (m) => `
            <div class="material-row">
              <span class="material-name">${m.item}</span>
              <span class="material-qty">x${m.quantity}</span>
              ${profitData ? renderMaterialCost(m, profitData.materials) : ''}
            </div>
          `
            )
            .join('')}
        </div>
      </div>

      <div class="detail-section">
        <h4>Value & Profit</h4>
        <div class="profit-breakdown">
          <div class="profit-row">
            <span class="profit-label">Base Value:</span>
            <span class="profit-value">${tp.total_cost ? `${tp.total_cost.toLocaleString()} silver` : 'Unknown'}</span>
          </div>
          ${
            profitData
              ? `
            <div class="profit-row">
              <span class="profit-label">Material Cost:</span>
              <span class="profit-value cost">${profitData.totalMaterialCost.toLocaleString()} silver</span>
            </div>
            <div class="profit-row profit-total">
              <span class="profit-label">Estimated Profit:</span>
              <span class="profit-value ${profitData.profit >= 0 ? 'positive' : 'negative'}">
                ${profitData.profit >= 0 ? '+' : ''}${profitData.profit.toLocaleString()} silver
              </span>
            </div>
          `
              : '<p class="placeholder-text">Could not calculate profit - missing crop data</p>'
          }
        </div>
      </div>

      <div class="detail-section">
        <h4>Demand Simulator</h4>
        <div class="demand-slider">
          <label for="demandMultiplier">Demand Level:</label>
          <input type="range" id="demandMultiplier" min="50" max="150" value="100" />
          <span id="demandValue">100%</span>
        </div>
        <p class="demand-note">Adjust to simulate different demand levels at tradeposts</p>
      </div>

      <div class="detail-section simulation-section">
        <h4>Land Simulation</h4>
        <p class="simulation-desc">Calculate optimal crop placement across your lands</p>
        <button class="simulate-btn" id="simulateOnLandBtn">
          <span class="btn-icon">🌾</span>
          Simulate on Land
        </button>
      </div>
    </div>
  `;

  // Setup demand slider
  const demandSlider = document.getElementById('demandMultiplier');
  const demandValue = document.getElementById('demandValue');

  if (demandSlider && demandValue) {
    demandSlider.addEventListener('input', async () => {
      const multiplier = parseInt(demandSlider.value, 10) / 100;
      demandValue.textContent = `${demandSlider.value}%`;

      try {
        const newProfitData = await window.electronAPI.calculateTradepackProfit({
          tradepack: tp,
          demandMultiplier: multiplier
        });

        const profitTotalEl = detailPanel.querySelector('.profit-total .profit-value');
        if (profitTotalEl) {
          profitTotalEl.textContent = `${newProfitData.profit >= 0 ? '+' : ''}${newProfitData.profit.toLocaleString()} silver`;
          profitTotalEl.className = `profit-value ${newProfitData.profit >= 0 ? 'positive' : 'negative'}`;
        }
      } catch (error) {
        console.error('Failed to recalculate:', error);
      }
    });
  }

  // Setup simulate button
  const simulateBtn = document.getElementById('simulateOnLandBtn');
  if (simulateBtn) {
    simulateBtn.addEventListener('click', () => openSimulationModal(tp));
  }
}

/**
 * Render material cost info
 */
function renderMaterialCost(material, profitMaterials) {
  const matData = profitMaterials?.find((m) => m.item === material.item);
  if (!matData || !matData.totalCost) {
    return '<span class="material-cost unknown">Cost unknown</span>';
  }

  return `
    <span class="material-cost">${matData.totalCost.toLocaleString()} silver</span>
    <span class="material-source">(${matData.source || 'N/A'})</span>
  `;
}

/**
 * Create the simulation modal
 */
function createSimulationModal() {
  if (simulationModal) return;

  simulationModal = document.createElement('div');
  simulationModal.id = 'simulationModal';
  simulationModal.className = 'modal-overlay hidden';
  simulationModal.setAttribute('role', 'dialog');
  simulationModal.setAttribute('aria-modal', 'true');
  simulationModal.setAttribute('aria-labelledby', 'simulationModalTitle');
  simulationModal.innerHTML = `
    <div class="modal-content simulation-modal">
      <div class="modal-header">
        <h2 id="simulationModalTitle">Land Simulation</h2>
        <button class="modal-close" id="closeSimulationModal" aria-label="Close modal">&times;</button>
      </div>
      <div class="modal-body" id="simulationModalBody">
        <div class="loading-spinner">Calculating optimal layouts...</div>
      </div>
    </div>
  `;

  document.body.appendChild(simulationModal);

  document.getElementById('closeSimulationModal')?.addEventListener('click', closeSimulationModal);
  simulationModal.addEventListener('click', (e) => {
    if (e.target === simulationModal) closeSimulationModal();
  });
}

/**
 * Open simulation modal
 */
async function openSimulationModal(tradepack) {
  if (!simulationModal) createSimulationModal();

  currentSimulationTradepack = tradepack;
  simulationModal.classList.remove('hidden');
  const modalBody = document.getElementById('simulationModalBody');
  modalBody.innerHTML = '<div class="loading-spinner">Calculating optimal layouts...</div>';

  simulationModal.querySelector('.modal-header h2').textContent =
    `Land Simulation: ${tradepack.name}`;

  try {
    const ownedLandsData = await window.electronAPI.getOwnedLands();
    const hasOwnedLands = Object.values(ownedLandsData.ownedLands || {}).some((count) => count > 0);

    if (!hasOwnedLands) {
      modalBody.innerHTML = `
        <div class="owned-lands-prompt">
          <h3>Configure Your Lands</h3>
          <p>Set up your land ownership in the Land Simulator tab to see a personalized farming simulation for this tradepack.</p>
          <button class="configure-lands-btn" id="configureModalLandsBtn">Configure Lands</button>
        </div>
      `;

      document.getElementById('configureModalLandsBtn')?.addEventListener('click', () => {
        closeSimulationModal();
        const landTab = document.querySelector('[data-tab="land"]');
        if (landTab) landTab.click();
      });
      return;
    }

    // Run simulation
    const results = await window.electronAPI.compareAllLandTypes({
      tradepack,
      timeWindowHours: userProfile?.simulationTimeWindow || 48
    });

    renderSimulationResults(results, tradepack, ownedLandsData);
  } catch (error) {
    console.error('Simulation failed:', error);
    modalBody.innerHTML = `
      <div class="error-message">
        <p>Failed to run simulation: ${error.message}</p>
        <p class="error-hint">This tradepack may not have farmable materials.</p>
        <p class="demo-note">Note: Full simulation with crop optimization is available in the desktop app.</p>
      </div>
    `;
  }
}

/**
 * Close simulation modal
 */
function closeSimulationModal() {
  if (simulationModal) {
    simulationModal.classList.add('hidden');
  }
}

/**
 * Render simulation results
 */
function renderSimulationResults(results, tradepack, ownedLandsData) {
  const modalBody = document.getElementById('simulationModalBody');
  const timeWindow = userProfile?.simulationTimeWindow || 48;

  // Build land cards
  const landCardsHtml = (results || [])
    .map((landResult) => `
      <div class="sim-land-card">
        <div class="sim-land-header">
          <span class="sim-land-name">${landResult.landName || landResult.landType}</span>
          <span class="sim-land-util-badge">
            ${landResult.farmableTiles || 0} tiles
          </span>
        </div>
        <div class="sim-land-assignment">
          ${landResult.hasHouse ? '🏠 Has house' : '🌾 Farmable'}
        </div>
        <div class="sim-land-profit">
          <span>Profit: </span>
          <span class="${landResult.profit >= 0 ? 'positive' : 'negative'}">
            ${landResult.profit >= 0 ? '+' : ''}${(landResult.profit || 0).toLocaleString()} silver
          </span>
        </div>
      </div>
    `)
    .join('');

  modalBody.innerHTML = `
    <div class="simulation-results owned-lands-section redesigned">
      <div class="demo-banner">
        <strong>Demo Mode:</strong> Full tradepack simulation with optimal crop placement is available in the desktop app.
      </div>

      <div class="sim-hero">
        <div class="sim-hero-header">
          <div class="sim-hero-tradepack">
            <div class="sim-hero-info">
              <span class="sim-hero-name">${tradepack.name}</span>
              <div class="sim-hero-count-inline">
                <span class="count">${tradepack.total_cost?.toLocaleString() || '?'}</span>
                <span class="label">silver value</span>
              </div>
            </div>
          </div>
          <div class="sim-hero-controls">
            <div class="sim-hero-controls-time">
              <span class="label">Time Window:</span>
              <span class="time-value">${timeWindow}h</span>
            </div>
          </div>
        </div>
        <div class="sim-hero-row">
          <div class="sim-hero-badges">
            <span class="sim-hero-badge materials">${tradepack.materials?.length || 0} materials</span>
          </div>
        </div>
        <div class="sim-hero-materials">
          ${(tradepack.materials || [])
            .map((m) => {
              const emoji = window.CropIcons?.getIcon?.(m.item.toLowerCase().replace(/\\s+/g, '_')) || '📦';
              return `<span class="sim-hero-pill">${emoji} ${m.item}: x${m.quantity}</span>`;
            })
            .join('')}
        </div>
      </div>

      <div class="sim-lands-section">
        <div class="sim-lands-header">
          <span class="sim-lands-title">Land Comparison (${results?.length || 0})</span>
        </div>
        <div class="sim-lands-grid">
          ${landCardsHtml || '<div class="no-lands">No land comparisons available</div>'}
        </div>
      </div>
    </div>
  `;
}

/**
 * Get crop emoji using shared utility
 */
function getCropEmoji(cropIdOrName) {
  if (window.CropIcons) {
    return window.CropIcons.getIcon(cropIdOrName);
  }
  return '🌱';
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTradepacks);
} else {
  initTradepacks();
}
