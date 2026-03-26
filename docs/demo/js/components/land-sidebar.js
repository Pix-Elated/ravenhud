/**
 * Land Sidebar Component
 * Size palette for layout optimization (matches in-app UI)
 * Demo version - adapted for web
 */

class LandSidebar {
  constructor(container, options = {}) {
    this.container = container;
    this.onItemSelect = options.onItemSelect || (() => {});
    this.onLayoutLoad = options.onLayoutLoad || (() => {});
    this.currentLandType = null;
    this.currentGrid = [];
    this.selectedSize = null;
    this.isNftLand = false;
    this.housePosition = null;

    // Size options matching in-app palette
    this.sizeOptions = [
      { size: '1x1', label: '1x1', color: '#FBBF24', item: { id: 'generic_1x1', name: '1x1', icon: '', width: 1, height: 1, size: '1x1', silverCost: 0 } },
      { size: '2x2', label: '2x2', color: '#3B82F6', item: { id: 'generic_2x2', name: '2x2', icon: '', width: 2, height: 2, size: '2x2', silverCost: 0 } },
      { size: '3x3', label: '3x3', color: '#A855F7', item: { id: 'generic_3x3', name: '3x3', icon: '', width: 3, height: 3, size: '3x3', silverCost: 0 } },
      { size: '4x4', label: '4x4', color: '#10B981', item: { id: 'generic_4x4', name: '4x4', icon: '', width: 4, height: 4, size: '4x4', silverCost: 0 } }
    ];

    this.init();
  }

  init() {
    this.container.innerHTML = '';
    this.container.className = 'land-sidebar';
    this.render();
  }

  render() {
    this.container.innerHTML = '';

    // Size palette section
    if (this.currentLandType) {
      const section = document.createElement('div');
      section.className = 'sidebar-section';

      const header = document.createElement('h3');
      header.className = 'section-title';
      header.textContent = 'Place Items';
      section.appendChild(header);

      const palette = document.createElement('div');
      palette.className = 'size-palette';

      this.sizeOptions.forEach((opt) => {
        const btn = document.createElement('button');
        btn.className = 'size-btn';
        if (this.selectedSize === opt.size) btn.classList.add('selected');
        if (this.isNftLand && !this.housePosition) btn.classList.add('disabled');
        btn.style.setProperty('--size-color', opt.color);
        btn.innerHTML = `<span class="size-label">${opt.label}</span>`;
        btn.addEventListener('click', () => this.selectSize(opt));
        palette.appendChild(btn);
      });

      section.appendChild(palette);

      // Hint for NFT lands without house
      if (this.isNftLand && !this.housePosition) {
        const hint = document.createElement('div');
        hint.className = 'palette-hint';
        hint.textContent = 'Place your house first before placing items';
        section.appendChild(hint);
      }

      this.container.appendChild(section);
    }
  }

  selectSize(opt) {
    if (this.isNftLand && !this.housePosition) return;

    if (this.selectedSize === opt.size) {
      // Deselect
      this.selectedSize = null;
      this.onItemSelect(null);
    } else {
      this.selectedSize = opt.size;
      this.onItemSelect(opt.item);
    }
    this.render();
  }

  deselectItem() {
    this.selectedSize = null;
    this.render();
  }

  setLandType(landType) {
    this.currentLandType = landType;
    const nftIds = ['NFT_SMALL', 'NFT_MEDIUM', 'NFT_LARGE', 'NFT_STRONGHOLD', 'NFT_FORT'];
    this.isNftLand = nftIds.includes(landType);
    this.housePosition = null;
    this.render();
  }

  setHouseState(position) {
    this.housePosition = position;
    this.render();
  }

  updateGrid(grid) {
    this.currentGrid = grid;
  }
}

// Expose globally for demo
window.LandSidebar = LandSidebar;
