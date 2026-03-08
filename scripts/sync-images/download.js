/**
 * HTTP download utility with retry, backoff, and redirect support.
 * Returns raw Buffer data — caller decides how to save/convert.
 */

const https = require('https');
const http = require('http');

const MAX_REDIRECTS = 5;
const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const RATE_LIMIT_WAIT_MS = 10000;

/**
 * Download a URL and return the response body as a Buffer.
 *
 * @param {string} url - URL to download
 * @param {object} [options]
 * @param {number} [options.retries=3] - Max retry attempts
 * @param {number} [options.timeout=30000] - Request timeout in ms
 * @returns {Promise<Buffer>}
 */
async function downloadBuffer(url, options = {}) {
  const { retries = DEFAULT_RETRIES, timeout = 30000 } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await _doDownload(url, timeout);
    } catch (err) {
      const isLast = attempt === retries;

      // HTTP 403/404 — don't retry, resource is permanently inaccessible
      if (err.statusCode === 403 || err.statusCode === 404) {
        throw err;
      }

      // HTTP 429 — rate limited, wait longer
      if (err.statusCode === 429 && !isLast) {
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }

      if (isLast) throw err;

      // Exponential backoff: 1s, 2s, 4s
      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
}

/**
 * Internal: perform a single download attempt with redirect following.
 */
function _doDownload(url, timeout, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      const err = new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`);
      reject(err);
      return;
    }

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent': 'RavenHUD-ImageSync/1.0'
        },
        timeout
      },
      (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // drain response
          let redirectUrl = res.headers.location;
          // Handle relative redirects
          if (redirectUrl.startsWith('/')) {
            const parsed = new URL(url);
            redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
          }
          _doDownload(redirectUrl, timeout, redirects + 1).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode} for ${url}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeout}ms for ${url}`));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { downloadBuffer, sleep };
