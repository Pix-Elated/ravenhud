/**
 * Sharp-based WebP conversion pipeline.
 * Converts any image format (JPG, PNG, GIF, AVIF) to optimized WebP.
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Convert an image buffer to WebP and save to disk.
 *
 * @param {Buffer} inputBuffer - Raw image data (any format Sharp supports)
 * @param {string} outputPath - Where to save the .webp file
 * @param {object} [options]
 * @param {number} [options.quality=80] - WebP quality (1-100)
 * @param {number} [options.effort=4] - Compression effort (0-6, higher = slower + smaller)
 * @param {number} [options.maxWidth] - Max width (resize preserving aspect ratio)
 * @param {number} [options.maxHeight] - Max height (resize preserving aspect ratio)
 * @returns {Promise<{width: number, height: number, size: number}>} Output metadata
 */
async function toWebP(inputBuffer, outputPath, options = {}) {
  const { quality = 80, effort = 4, maxWidth, maxHeight } = options;

  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let pipeline = sharp(inputBuffer);

  // Optional resize (fit within bounds, preserve aspect ratio)
  if (maxWidth || maxHeight) {
    pipeline = pipeline.resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  // Convert to WebP
  pipeline = pipeline.webp({ quality, effort });

  // Save to disk
  const info = await pipeline.toFile(outputPath);

  return {
    width: info.width,
    height: info.height,
    size: info.size
  };
}

/**
 * Check if an existing file is actually WebP format.
 * Returns false if the file is a different format masquerading as .webp
 * (e.g., JPG saved with .webp extension).
 *
 * @param {string} filePath - Path to the image file
 * @returns {Promise<boolean>} True if the file is genuine WebP
 */
async function isRealWebP(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return metadata.format === 'webp';
  } catch {
    return false;
  }
}

/**
 * Re-convert a file to actual WebP if it's not already.
 * Returns true if conversion was needed, false if already WebP.
 *
 * @param {string} filePath - Path to the image file
 * @param {object} [options] - Same options as toWebP
 * @returns {Promise<boolean>} Whether conversion was performed
 */
async function ensureWebP(filePath, options = {}) {
  if (await isRealWebP(filePath)) {
    return false;
  }

  // Read, convert, and overwrite
  const buffer = fs.readFileSync(filePath);
  await toWebP(buffer, filePath, options);
  return true;
}

module.exports = { toWebP, isRealWebP, ensureWebP };
