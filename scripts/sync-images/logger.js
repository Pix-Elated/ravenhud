/**
 * Pipeline Logger
 * File-based logging for sync-images scripts, mirroring safe-logger's format.
 * Writes to sync-images.log with session rotation (current + 2 previous).
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'sync-images.log');
const MAX_ROTATED = 2;

let stream = null;

function rotateLogs() {
  const dir = path.dirname(LOG_FILE);
  const ext = path.extname(LOG_FILE);
  const base = path.basename(LOG_FILE, ext);

  // Delete oldest
  try {
    fs.unlinkSync(path.join(dir, `${base}.${MAX_ROTATED}${ext}`));
  } catch {
    /* may not exist */
  }

  // Shift up: .1→.2, current→.1
  for (let i = MAX_ROTATED - 1; i >= 1; i--) {
    try {
      fs.renameSync(path.join(dir, `${base}.${i}${ext}`), path.join(dir, `${base}.${i + 1}${ext}`));
    } catch {
      /* may not exist */
    }
  }

  try {
    fs.renameSync(LOG_FILE, path.join(dir, `${base}.1${ext}`));
  } catch {
    /* may not exist */
  }
}

function getStream() {
  if (stream) return stream;

  rotateLogs();

  const header = [
    '================================================================================',
    '  RavenHUD Image Sync Pipeline',
    `  Timestamp: ${new Date().toISOString()}`,
    `  Node:      ${process.versions.node}`,
    `  Platform:  ${process.platform} ${process.arch}`,
    '================================================================================',
    ''
  ].join('\n');

  fs.writeFileSync(LOG_FILE, header);
  stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  return stream;
}

function formatMessage(level, prefix, args) {
  const ts = new Date().toISOString().substring(11, 23);
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  return `${ts} [${level}] ${prefix} ${msg}\n`;
}

function writeLog(level, prefix, args) {
  const s = getStream();
  const formatted = formatMessage(level, prefix, args);
  s.write(formatted);

  // Also write to stdout for CI visibility (GitHub Actions captures stdout)
  process.stdout.write(formatted);
}

function createLogger(prefix) {
  return {
    log: (...args) => writeLog('LOG', prefix, args),
    info: (...args) => writeLog('INFO', prefix, args),
    warn: (...args) => writeLog('WARN', prefix, args),
    error: (...args) => writeLog('ERROR', prefix, args)
  };
}

function flush() {
  if (stream && !stream.destroyed) {
    stream.end();
  }
  stream = null;
}

module.exports = { createLogger, flush };
