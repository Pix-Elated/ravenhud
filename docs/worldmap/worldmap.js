/**
 * RavenHUD Interactive World Map
 *
 * Vanilla JS + Leaflet. Loads markers from the repo's data/worldmap-markers.json
 * via raw GitHub URL (single source of truth — never duplicated).
 *
 * Discord OAuth2 PKCE for verified identity. Submissions go through
 * Corvid (Discord bot API) which proxies GitHub Issue creation.
 */

/* global L */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var DATA_URL =
  'https://raw.githubusercontent.com/Pix-Elated/ravenhud/master/data/worldmap-markers.json';

var CORVID_BAN_LIST_URL = null; // set below after CORVID_API_URL is defined
var BAN_LIST_FALLBACK_URL =
  'https://raw.githubusercontent.com/Pix-Elated/ravenhud/master/data/hall-of-shame.json';

var TILE_URL = 'https://assets.ravenquest.tools/map/{z}/{x}/{y}.png';

var MAP_CONFIG = {
  imageWidth: 8192,
  imageHeight: 4608,
  tileSize: 256,
  maxNativeZoom: 5,
  minZoom: 1,
  maxZoom: 7
};

var CORVID_API_URL =
  'https://corvid-discord.wonderfulfield-6f0ceab3.westus2.azurecontainerapps.io';
CORVID_BAN_LIST_URL = CORVID_API_URL + '/api/bans/list';
var BAN_STREAM_URL = CORVID_API_URL + '/api/bans/stream';

var DISCORD_CLIENT_ID = '1469858215125717155';
var DISCORD_REDIRECT_URI = window.location.origin + window.location.pathname;
var DISCORD_SCOPES = 'identify';

var GITHUB_REPO = 'Pix-Elated/ravenhud';

// Category metadata — uses game icon files when available, emoji as fallback
var CATEGORIES = {
  dynamic_event: { label: 'Dynamic Events', emoji: '\u26A1', icon: 'dynamic_event.webp', group: 'Events' },
  expedition: { label: 'Expeditions', emoji: '\uD83E\uDDED', icon: 'expedition.webp', group: 'Exploration' },
  creature_spawn: { label: 'Elite Spawns', emoji: '\uD83D\uDC80', icon: 'elitespawn.webp', group: 'Exploration' },
  reputation_shiny: { label: 'Reputation (Shiny)', emoji: '\u2728', icon: null, group: 'Reputation' },
  npc_reputation: { label: 'Reputation (NPC)', emoji: '\uD83D\uDC64', icon: 'npc_reputation.webp', group: 'Reputation' }
};

// Category groups for sidebar ordering
var GROUP_ORDER = ['Events', 'Exploration', 'Reputation'];

/**
 * POST to a Corvid API endpoint. Returns { ok, data } or throws.
 */
function fetchCorvidAPI(endpoint, body) {
  return fetch(CORVID_API_URL + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (res) {
    return res.json().then(function (data) {
      return { ok: res.ok, data: data };
    });
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var map;
var rc;
var clusterGroup;
var allMarkers = [];
var leafletMarkers = new Map(); // id -> L.Marker
var visibility = {};
var submitCoords = null;
var modalMode = 'submit'; // 'submit' or 'edit'
var editingMarker = null; // marker being edited
var discordUser = null; // { id, username, globalName, avatar }
var previewMarker = null; // L.Marker for position preview
var pendingScreenshot = null; // base64 webp string
var hideCollected = false; // Filter: hide collected shiny/NPC markers

// Shiny collection checklist (persisted to localStorage)
var SHINY_COLLECTED_KEY = 'rhud_shiny_collected';

function getShinyCollected() {
  try { return JSON.parse(localStorage.getItem(SHINY_COLLECTED_KEY) || '{}'); }
  catch (e) { return {}; }
}

function toggleShinyCollected(markerId) {
  var state = getShinyCollected();
  if (state[markerId]) {
    delete state[markerId];
  } else {
    state[markerId] = Date.now();
  }
  localStorage.setItem(SHINY_COLLECTED_KEY, JSON.stringify(state));
  return !!state[markerId];
}

function getRepProgress(category) {
  var state = getShinyCollected();
  var markers = allMarkers.filter(function (m) {
    return m.category === category && m.floor === 'surface';
  });
  var collected = markers.filter(function (m) { return state[m.id]; }).length;
  return { collected: collected, total: markers.length };
}

// ---------------------------------------------------------------------------
// Discord OAuth2 PKCE
// ---------------------------------------------------------------------------

function generateRandomString(length) {
  var arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  // base64url encode
  return btoa(String.fromCharCode.apply(null, arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    .slice(0, length);
}

function createCodeChallenge(verifier) {
  var encoder = new TextEncoder();
  var data = encoder.encode(verifier);
  return crypto.subtle.digest('SHA-256', data).then(function (hash) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  });
}

function startDiscordLogin() {
  var state = generateRandomString(32);
  var codeVerifier = generateRandomString(64);

  // Store PKCE params for when Discord redirects back
  sessionStorage.setItem('discord_state', state);
  sessionStorage.setItem('discord_code_verifier', codeVerifier);

  createCodeChallenge(codeVerifier).then(function (codeChallenge) {
    var url = 'https://discord.com/oauth2/authorize' +
      '?client_id=' + encodeURIComponent(DISCORD_CLIENT_ID) +
      '&redirect_uri=' + encodeURIComponent(DISCORD_REDIRECT_URI) +
      '&response_type=code' +
      '&scope=' + encodeURIComponent(DISCORD_SCOPES) +
      '&state=' + encodeURIComponent(state) +
      '&code_challenge=' + encodeURIComponent(codeChallenge) +
      '&code_challenge_method=S256';
    window.location.href = url;
  });
}

function handleOAuthCallback() {
  var params = new URLSearchParams(window.location.search);
  var code = params.get('code');
  var state = params.get('state');

  if (!code || !state) return Promise.resolve(false);

  // Clean URL
  window.history.replaceState({}, '', window.location.pathname);

  var savedState = sessionStorage.getItem('discord_state');
  var codeVerifier = sessionStorage.getItem('discord_code_verifier');
  sessionStorage.removeItem('discord_state');
  sessionStorage.removeItem('discord_code_verifier');

  if (state !== savedState || !codeVerifier) {
    console.error('Discord OAuth: state mismatch or missing verifier');
    return Promise.resolve(false);
  }

  // Exchange code for token
  return fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'client_id=' + encodeURIComponent(DISCORD_CLIENT_ID) +
      '&grant_type=authorization_code' +
      '&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(DISCORD_REDIRECT_URI) +
      '&code_verifier=' + encodeURIComponent(codeVerifier)
  })
    .then(function (res) {
      if (!res.ok) throw new Error('Token exchange failed: ' + res.status);
      return res.json();
    })
    .then(function (data) {
      return fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + data.access_token }
      });
    })
    .then(function (res) {
      if (!res.ok) throw new Error('User fetch failed: ' + res.status);
      return res.json();
    })
    .then(async function (user) {
      discordUser = {
        id: user.id,
        username: user.username,
        globalName: user.global_name || user.username,
        avatar: user.avatar
      };
      localStorage.setItem('discord_user', JSON.stringify(discordUser));

      // Log Discord login to Corvid's identity graph so /cluster can link
      // this Discord account to the fingerprint + IP + character name.
      var identity = getSavedIdentity();
      var fp = await computeFingerprint();
      fetch(CORVID_API_URL + '/api/bans/identity-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characterName: identity ? identity.characterName : undefined,
          guildTag: identity ? identity.guildTag : undefined,
          discordId: discordUser.id,
          fingerprint: fp,
          timestamp: new Date().toISOString(),
          isNewIdentity: false
        })
      }).catch(function () { /* fail-open */ });

      // Check Discord ID against ban list immediately after login
      var ban = await checkAllBans(null, null);
      if (ban) {
        showBanScreen(ban);
        return false;
      }

      updateAuthUI();
      return true;
    })
    .catch(function (err) {
      console.error('Discord OAuth error:', err);
      return false;
    });
}

function loadSavedDiscordUser() {
  try {
    var saved = localStorage.getItem('discord_user');
    if (saved) {
      discordUser = JSON.parse(saved);
    }
  } catch (e) {
    localStorage.removeItem('discord_user');
  }
}

function logoutDiscord() {
  discordUser = null;
  localStorage.removeItem('discord_user');
  updateAuthUI();
}

// ---------------------------------------------------------------------------
// Ban List & Identity
// ---------------------------------------------------------------------------

var banListCache = null;
var IDENTITY_KEY = 'rhud_identity';
var IDENTITY_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
var BAN_PERSIST_KEY = 'rhud_banned';

// ---------------------------------------------------------------------------
// Browser Fingerprint (UEBA)
// ---------------------------------------------------------------------------

// Combines stable browser/device signals into a single hash. Used by Corvid's
// submission logger to cluster evasion attempts across cleared cookies + cache.
// Each signal contributes entropy; together we get enough stability to link
// repeated visits from the same browser/machine even after identity changes.
// ~30-40 bits of entropy in aggregate. Not unique per user but discriminative
// enough for the "same person lying about their name" detection use case.
var fingerprintCache = null;

async function computeFingerprint() {
  if (fingerprintCache) return fingerprintCache;

  var signals = [];
  signals.push(navigator.userAgent || '');
  signals.push(navigator.language || '');
  signals.push(navigator.languages ? navigator.languages.join(',') : '');
  signals.push(screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || 0));
  signals.push(String(window.devicePixelRatio || 1));
  signals.push(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  signals.push(String(navigator.hardwareConcurrency || 0));
  signals.push(String(navigator.deviceMemory || 0));
  signals.push(String(new Date().getTimezoneOffset()));

  // Canvas fingerprint — text rendered to a canvas produces slightly different
  // pixels on every GPU / driver / font stack combination.
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    var ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 100, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('RavenHUD fingerprint \uD83D\uDC26', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('RavenHUD fingerprint \uD83D\uDC26', 4, 17);
    signals.push(canvas.toDataURL());
  } catch (e) { /* canvas blocked, skip */ }

  // WebGL renderer — GPU identification string, very stable
  try {
    var gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        signals.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
        signals.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '');
      }
    }
  } catch (e) { /* WebGL blocked, skip */ }

  var combined = signals.join('||');
  var buf = new TextEncoder().encode(combined);
  try {
    var hash = await crypto.subtle.digest('SHA-256', buf);
    var hex = Array.from(new Uint8Array(hash))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
    fingerprintCache = 'fp_' + hex.slice(0, 32);
  } catch (e) {
    // Fallback for browsers without SubtleCrypto (extremely old)
    fingerprintCache = 'fp_fallback_' + combined.length;
  }
  return fingerprintCache;
}

async function fetchBanList() {
  if (banListCache) return banListCache;
  // Prefer Corvid (sub-100ms, in-memory cache) so SSE invalidations are
  // authoritative. Fall back to GitHub raw if Corvid is down.
  try {
    var res = await fetch(CORVID_BAN_LIST_URL);
    if (res.ok) {
      var data = await res.json();
      banListCache = data.entries || [];
      return banListCache;
    }
  } catch (e) { /* fall through to GitHub raw */ }
  try {
    var res2 = await fetch(BAN_LIST_FALLBACK_URL);
    if (!res2.ok) return [];
    var data2 = await res2.json();
    banListCache = data2.entries || [];
    return banListCache;
  } catch (e) {
    console.warn('Failed to fetch ban list:', e);
    return [];
  }
}

async function refreshBanList() {
  // Forces a re-fetch, bypassing the in-memory cache
  banListCache = null;
  return fetchBanList();
}

function getSavedIdentity() {
  try {
    var raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    var identity = JSON.parse(raw);
    if (Date.now() - identity.timestamp > IDENTITY_TTL_MS) {
      localStorage.removeItem(IDENTITY_KEY);
      return null;
    }
    return identity;
  } catch (e) {
    localStorage.removeItem(IDENTITY_KEY);
    return null;
  }
}

function saveIdentity(characterName, guildTag) {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify({
    characterName: characterName,
    guildTag: guildTag,
    timestamp: Date.now()
  }));
}

/**
 * Check Discord ID, character name, and guild tag against the ban list.
 * Returns the matching ban entry or null.
 */
async function checkAllBans(characterName, guildTag) {
  var entries = await fetchBanList();
  var charLower = (characterName || '').trim().toLowerCase();
  var guildLower = (guildTag || '').trim().toLowerCase();

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var entryLower = entry.name.trim().toLowerCase();

    // Discord ID match
    if (entry.type === 'discord' && discordUser && entry.name.trim() === discordUser.id) {
      return entry;
    }
    // Character name match
    if (entry.type === 'character' && charLower && charLower === entryLower) {
      return entry;
    }
    // Guild tag match
    if (entry.type === 'guild' && guildLower && guildLower === entryLower) {
      return entry;
    }
  }
  return null;
}

/**
 * Show the identity prompt (blurred background). Returns a promise that
 * resolves with { characterName, guildTag } or null if cancelled.
 */
function showIdentityPrompt() {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.id = 'identity-overlay';
    overlay.innerHTML =
      '<div class="identity-modal">' +
      '<div class="identity-title">Welcome to the RavenHUD World Map</div>' +
      '<div class="identity-subtitle">Please identify yourself to continue</div>' +
      '<div class="identity-warning">' +
      '<strong>Warning:</strong> Entering random letters, intentionally misrepresenting your guild, or otherwise attempting to circumvent the integrity of this check will result in a ban.' +
      '</div>' +
      '<div class="identity-privacy">' +
      'By continuing, you acknowledge that your IP address, browser/device fingerprint, ' +
      'user-agent, character name, and guild tag are logged for ban-evasion detection and ' +
      'abuse prevention (retained up to 90 days). No third-party tracking.' +
      '</div>' +
      '<label class="identity-label">Character Name</label>' +
      '<input type="text" id="identity-char" class="identity-input" placeholder="Your in-game name" maxlength="30" />' +
      '<label class="identity-label">Guild Tag</label>' +
      '<input type="text" id="identity-guild" class="identity-input" placeholder="e.g. RH, GG, CT (leave blank if none)" maxlength="10" />' +
      '<button id="identity-submit" class="identity-btn" disabled>Enter Map</button>' +
      '</div>';

    document.body.appendChild(overlay);

    var charInput = document.getElementById('identity-char');
    var guildInput = document.getElementById('identity-guild');
    var submitBtn = document.getElementById('identity-submit');

    charInput.addEventListener('input', function () {
      submitBtn.disabled = !charInput.value.trim();
    });

    charInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && charInput.value.trim()) submitBtn.click();
    });
    guildInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && charInput.value.trim()) submitBtn.click();
    });

    submitBtn.addEventListener('click', function () {
      var name = charInput.value.trim();
      var guild = guildInput.value.trim();
      overlay.remove();
      resolve({ characterName: name, guildTag: guild });
    });

    charInput.focus();
  });
}

function reportBanTrigger(entry, identity) {
  // Fire-and-forget — report the banned user's info to Corvid for IP logging
  try {
    fetch(CORVID_API_URL + '/api/bans/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchedName: entry.name,
        matchType: entry.type,
        reason: entry.reason,
        discordId: discordUser ? discordUser.id : null,
        discordUsername: discordUser ? (discordUser.globalName || discordUser.username) : null,
        identity: identity || getSavedIdentity(),
        timestamp: new Date().toISOString()
      })
    }).catch(function () { /* silent */ });
  } catch (e) { /* silent */ }
}

function showBanScreen(entry, identity) {
  // Report to Corvid for IP logging
  reportBanTrigger(entry, identity);

  // Persist the ban so refreshing / clearing cookies doesn't get them
  // past the ban screen. They see the ban screen immediately on every
  // future page load without ever reaching the identity prompt.
  try {
    localStorage.setItem(BAN_PERSIST_KEY, JSON.stringify({
      name: entry.name,
      reason: entry.reason,
      type: entry.type,
      ts: Date.now()
    }));
  } catch (e) { /* storage full or blocked, skip */ }

  // Remove any existing ban overlay
  var existing = document.getElementById('ban-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'ban-overlay';
  overlay.innerHTML =
    '<div class="ban-modal">' +
    '<div class="ban-raven">&#x1F426;&#x200D;&#x2B1B;</div>' +
    '<div class="ban-title">AH AH AH!</div>' +
    '<div class="ban-subtitle">You didn\'t say the magic word...</div>' +
    '<div class="ban-callout">' +
    '<div class="ban-label">BANNED USER DETECTED</div>' +
    '<div class="ban-name">' + escapeHtml(entry.name) + '</div>' +
    '<div class="ban-reason">Reason: ' + escapeHtml(entry.reason) + '</div>' +
    '</div>' +
    '<div class="ban-message">' +
    '<p class="ban-revoked">Your access to RavenHUD has been revoked.</p>' +
    '<p>You have two options:</p>' +
    '<ul>' +
    '<li>Directly apologize to the creator for what you have done, admit you are a loser with no real social skills, and promise to never do it again.</li>' +
    '<li>Close this tab &mdash; you aren\'t welcome here</li>' +
    '</ul>' +
    '<p><a href="https://discord.gg/6nNdvKV2nb" target="_blank" rel="noopener noreferrer" class="ban-discord-link">\uD83D\uDCAC Join the Discord to appeal</a></p>' +
    '</div>' +
    '<div class="ban-footer">Hall of Shame &bull; RavenHUD</div>' +
    '</div>';

  document.body.appendChild(overlay);

  // Disable all interaction behind the overlay
  logoutDiscord();

  // Bark at them. Continuously. Until they leave.
  startBanBark();
}

var banBarkAudio = null;
function startBanBark() {
  try {
    banBarkAudio = new Audio('ban-bark.mp3');
    banBarkAudio.loop = true;

    // Browsers block autoplay before user gesture. Try immediately, then
    // hook every interaction to retry on first click/tap/key.
    function tryPlay() {
      if (!banBarkAudio || !banBarkAudio.paused) return;
      banBarkAudio.play().catch(function () { /* still blocked */ });
    }
    document.addEventListener('click', tryPlay, { once: false });
    document.addEventListener('touchstart', tryPlay, { once: false });
    document.addEventListener('keydown', tryPlay, { once: false });
    tryPlay();
  } catch (e) { /* audio blocked, skip */ }
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Periodic ban re-check — kicks users banned after they entered the map.
// SSE provides ~1-2s propagation via /api/bans/stream below; this polling
// stays as a safety net for SSE disconnects and IP-ban changes that aren't
// triggered by ban-list commits (future: proxy-list refreshes).
var BAN_RECHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
var banRecheckTimer = null;
var banStreamSource = null;

/**
 * Re-fetch the ban list and re-evaluate the current identity. Kicks the
 * user to the ban screen if now banned. Shared between SSE push handler
 * and periodic safety-net poll so enforcement logic stays in one place.
 */
async function recheckBans(identity) {
  // Force-refresh ban list so new bans are picked up
  await refreshBanList();

  // Check character/guild client-side
  var ban = await checkAllBans(identity.characterName, identity.guildTag);
  if (ban) {
    stopBanWatcher();
    showBanScreen(ban, identity);
    localStorage.removeItem(IDENTITY_KEY);
    return true;
  }

  // Check IP ban via Corvid (server-side only — client can't see its own IP)
  try {
    var res = await fetch(CORVID_API_URL + '/api/bans/ip-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      var data = await res.json();
      if (data.banned) {
        stopBanWatcher();
        showBanScreen({ type: 'ip', name: data.matchedName, reason: data.reason }, identity);
        localStorage.removeItem(IDENTITY_KEY);
        return true;
      }
    }
  } catch (e) { /* fail-open */ }
  return false;
}

function startPeriodicBanCheck(identity) {
  if (banRecheckTimer) clearInterval(banRecheckTimer);
  banRecheckTimer = setInterval(function () {
    recheckBans(identity).catch(function () { /* silent */ });
  }, BAN_RECHECK_INTERVAL_MS);
}

/**
 * Open an SSE connection to Corvid and re-check bans whenever the server
 * announces a ban-list change. EventSource auto-reconnects on drops.
 * Target latency: ~1-2s from ban issue to kick.
 */
function startBanStreamSubscription(identity) {
  if (typeof EventSource === 'undefined') return; // ancient browser
  if (banStreamSource) banStreamSource.close();
  try {
    banStreamSource = new EventSource(BAN_STREAM_URL);
    banStreamSource.addEventListener('ban-list-changed', function () {
      recheckBans(identity).catch(function () { /* silent */ });
    });
    banStreamSource.addEventListener('error', function () {
      // EventSource handles reconnect automatically; nothing to do here.
      // Periodic poll still runs as a safety net.
    });
  } catch (e) { /* silent — periodic poll still covers us */ }
}

function stopBanWatcher() {
  if (banRecheckTimer) { clearInterval(banRecheckTimer); banRecheckTimer = null; }
  if (banStreamSource) { banStreamSource.close(); banStreamSource = null; }
}

function updateAuthUI() {
  var loginBtn = document.getElementById('btn-discord-login');
  var userDisplay = document.getElementById('discord-user-display');
  var userName = document.getElementById('discord-username');
  var submitBtn = document.getElementById('btn-submit');
  var editBtn = document.getElementById('btn-suggest-edit');
  var deleteBtn = document.getElementById('btn-suggest-delete');

  if (discordUser) {
    loginBtn.style.display = 'none';
    userDisplay.style.display = 'flex';
    userName.textContent = discordUser.globalName || discordUser.username;
    submitBtn.disabled = false;
    submitBtn.title = 'Submit a marker';
    if (editBtn) {
      editBtn.disabled = false;
      editBtn.title = '';
    }
    if (deleteBtn) {
      deleteBtn.disabled = false;
      deleteBtn.title = '';
    }
  } else {
    loginBtn.style.display = '';
    userDisplay.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.title = 'Login with Discord to submit';
    if (editBtn) {
      editBtn.disabled = true;
      editBtn.title = 'Login with Discord to submit';
    }
    if (deleteBtn) {
      deleteBtn.disabled = true;
      deleteBtn.title = 'Login with Discord to suggest deletion';
    }
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Check for a persisted ban BEFORE anything else. If they were previously
  // banned, show the ban screen immediately — no identity prompt, no map,
  // no second chances. Clearing cookies/localStorage won't help because
  // the server-side IP/fingerprint check will re-ban them anyway (and the
  // SSE watcher will catch the rest).
  try {
    var persistedBan = localStorage.getItem(BAN_PERSIST_KEY);
    if (persistedBan) {
      var banData = JSON.parse(persistedBan);
      showBanScreen(
        { type: banData.type || 'character', name: banData.name || 'unknown', reason: banData.reason || 'Banned' },
        null
      );
      return;
    }
  } catch (e) { /* corrupt data, let them through to server-side check */ }

  // Identity prompt FIRST — character name + guild tag (cached 7 days)
  var identity = getSavedIdentity();
  var isNewIdentity = false;
  if (!identity || !identity.characterName || !identity.characterName.trim()) {
    localStorage.removeItem(IDENTITY_KEY);
    identity = await showIdentityPrompt();
    if (!identity) return;
    saveIdentity(identity.characterName, identity.guildTag);
    isNewIdentity = true;
  }

  // Compute the browser fingerprint up-front so we can send it with the
  // identity log. Used by Corvid's /cluster admin command to detect evasion.
  var fingerprint = await computeFingerprint();

  // Log identity to Corvid — only on first visit or new identity, not every page load
  // Always check IP ban though (server-side — client can't know its own IP)
  try {
    var logRes = await fetch(CORVID_API_URL + '/api/bans/identity-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        characterName: identity.characterName,
        guildTag: identity.guildTag,
        timestamp: new Date().toISOString(),
        isNewIdentity: isNewIdentity,
        fingerprint: fingerprint,
        discordId: discordUser ? discordUser.id : undefined
      })
    });
    var logData = await logRes.json();
    if (logData.banned) {
      showBanScreen({ type: 'ip', name: logData.matchedName, reason: logData.reason }, identity);
      localStorage.removeItem(IDENTITY_KEY);
      return;
    }
  } catch (e) { /* Fail-open: if Corvid is down, continue (char/guild bans still work client-side) */ }

  // Check character name + guild tag against ban list
  var identityBan = await checkAllBans(identity.characterName, identity.guildTag);
  if (identityBan) {
    showBanScreen(identityBan, identity);
    localStorage.removeItem(IDENTITY_KEY);
    return;
  }

  // Discord login is separate — restore saved session and handle OAuth callback
  loadSavedDiscordUser();
  await handleOAuthCallback();

  // If they just connected Discord, check Discord ID ban
  if (discordUser) {
    var discordBan = await checkAllBans(null, null);
    if (discordBan) {
      showBanScreen(discordBan);
      return;
    }
  }

  initMap();
  initSidebar();
  initDetailPanel();
  initModal();
  initAuth();
  initContributions();
  updateAuthUI();

  try {
    var res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    allMarkers = await res.json();
  } catch (err) {
    console.error('Failed to load markers:', err);
    allMarkers = [];
  }

  // Default all categories visible
  for (var key of Object.keys(CATEGORIES)) {
    visibility[key] = true;
  }

  // Apply any locally-persisted edits before rendering
  applyLocalEdits();

  buildSidebar();
  renderMarkers();
  updateStats();

  startPeriodicBanCheck(identity);
  startBanStreamSubscription(identity);
}

function initAuth() {
  document.getElementById('btn-discord-login').addEventListener('click', startDiscordLogin);
  document.getElementById('btn-discord-logout').addEventListener('click', logoutDiscord);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: MAP_CONFIG.minZoom,
    maxZoom: MAP_CONFIG.maxZoom,
    zoomControl: true,
    attributionControl: true
  });

  rc = new L.RasterCoords(map, [MAP_CONFIG.imageWidth, MAP_CONFIG.imageHeight], MAP_CONFIG.tileSize);
  var southWest = rc.unproject([0, MAP_CONFIG.imageHeight]);
  var northEast = rc.unproject([MAP_CONFIG.imageWidth, 0]);
  var bounds = new L.LatLngBounds(southWest, northEast);

  L.tileLayer(TILE_URL, {
    maxNativeZoom: MAP_CONFIG.maxNativeZoom,
    maxZoom: MAP_CONFIG.maxZoom,
    tileSize: MAP_CONFIG.tileSize,
    noWrap: true,
    bounds: bounds
  }).addTo(map);

  map.setView(
    rc.unproject([MAP_CONFIG.imageWidth / 2, MAP_CONFIG.imageHeight / 2]),
    2
  );

  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 5
  });
  map.addLayer(clusterGroup);

  map.on('click', onMapClick);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

function createMarkerIcon(category) {
  // Collected shiny — dimmed checkmark
  if (category === '_shiny_collected') {
    return L.divIcon({
      className: '',
      html: '<span style="font-size:18px;color:#4ade80;opacity:0.7;filter:drop-shadow(0 0 3px rgba(0,0,0,0.9))">&#x2714;</span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  var cat = CATEGORIES[category];
  if (!cat) {
    return L.divIcon({
      className: '',
      html: '<span style="font-size:18px;filter:drop-shadow(0 0 2px rgba(0,0,0,0.7))">\uD83D\uDCCD</span>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  // Use actual game icon when available
  if (cat.icon) {
    return L.icon({
      iconUrl: 'markers/' + cat.icon,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  var glow = category === 'npc_reputation'
    ? 'filter:drop-shadow(0 0 4px rgba(100,180,255,0.8)) drop-shadow(0 0 2px rgba(0,0,0,0.7))'
    : 'filter:drop-shadow(0 0 2px rgba(0,0,0,0.7))';

  return L.divIcon({
    className: '',
    html: '<span style="font-size:18px;' + glow + '">' + cat.emoji + '</span>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

var iconCache = {};
function getCachedIcon(category) {
  if (!iconCache[category]) {
    iconCache[category] = createMarkerIcon(category);
  }
  return iconCache[category];
}

function renderMarkers() {
  clusterGroup.clearLayers();
  leafletMarkers.clear();

  var shinyState = getShinyCollected();
  for (var m of allMarkers) {
    if (m.floor !== 'surface') continue;
    if (!visibility[m.category]) continue;

    var latlng = rc.unproject([m.x, m.y]);
    var isTrackable = m.category === 'reputation_shiny' || m.category === 'npc_reputation';
    var isCollectedShiny = isTrackable && shinyState[m.id];
    if (hideCollected && isCollectedShiny) continue;
    var icon = isCollectedShiny
      ? getCachedIcon('_shiny_collected')
      : getCachedIcon(m.category);
    var marker = L.marker(latlng, { icon: icon });

    // Lazy tooltip
    (function (mk, mrk) {
      mrk.once('mouseover', function () {
        mrk.bindTooltip(mk.name, {
          direction: 'top',
          offset: [0, -12],
          className: 'marker-tooltip'
        }).openTooltip();
      });
      mrk.on('click', function () {
        setSelectedMarker(mrk);
        showDetail(mk);
      });
    })(m, marker);

    leafletMarkers.set(m.id, marker);
    clusterGroup.addLayer(marker);
  }
}

// ---------------------------------------------------------------------------
// Detail Panel
// ---------------------------------------------------------------------------

var currentDetailMarker = null;
var selectedLeafletMarker = null;

function setSelectedMarker(leafletMarker) {
  // Remove glow from previous selection
  if (selectedLeafletMarker) {
    var prevEl = selectedLeafletMarker.getElement();
    if (prevEl) prevEl.classList.remove('marker-selected');
  }
  selectedLeafletMarker = leafletMarker;
  if (leafletMarker) {
    var el = leafletMarker.getElement();
    if (el) el.classList.add('marker-selected');
  }
}

function showDetail(m) {
  currentDetailMarker = m;
  var panel = document.getElementById('detail-panel');
  document.getElementById('detail-name').textContent = m.name;
  document.getElementById('detail-coords').textContent = m.x + ', ' + m.y;

  var cat = CATEGORIES[m.category];
  var detailCatEl = document.getElementById('detail-category');
  if (cat && cat.icon) {
    detailCatEl.innerHTML = '<img src="markers/' + cat.icon + '" width="16" height="16" style="vertical-align:text-bottom;margin-right:4px">' + cat.label;
  } else {
    detailCatEl.textContent = cat ? cat.emoji + ' ' + cat.label : m.category;
  }

  var regionEl = document.getElementById('detail-region');
  if (m.region) {
    regionEl.textContent = m.region;
    regionEl.style.display = 'block';
  } else {
    regionEl.style.display = 'none';
  }

  var desc = document.getElementById('detail-description');
  desc.textContent = m.description || '';
  desc.style.display = m.description ? 'block' : 'none';

  var ssContainer = document.getElementById('detail-screenshot');
  ssContainer.innerHTML = '';
  if (m.screenshot) {
    var ssUrl = 'https://raw.githubusercontent.com/' + GITHUB_REPO +
      '/master/data/' + m.screenshot;
    var img = document.createElement('img');
    img.src = ssUrl;
    img.alt = m.name + ' screenshot';
    img.loading = 'lazy';
    img.style.cursor = 'pointer';
    img.title = 'Click to enlarge';
    img.addEventListener('click', function () { openLightbox(ssUrl); });
    ssContainer.appendChild(img);
  }

  var source = document.getElementById('detail-source');
  source.textContent = m.source === 'base' ? 'Community verified' : 'Source: ' + m.source;

  // Shiny collection toggle
  var shinySection = document.getElementById('detail-shiny');
  if (m.category === 'reputation_shiny' || m.category === 'npc_reputation') {
    var collected = getShinyCollected();
    var isCollected = !!collected[m.id];
    shinySection.innerHTML =
      '<label class="shiny-check-label">' +
      '<input type="checkbox" ' + (isCollected ? 'checked' : '') + ' />' +
      '<span>' + (isCollected ? 'Collected' : 'Mark as Collected') + '</span>' +
      '<span class="save-flash" style="display:none">Saved</span>' +
      '</label>';
    shinySection.querySelector('input').addEventListener('change', function () {
      var nowCollected = toggleShinyCollected(m.id);
      this.nextElementSibling.textContent = nowCollected ? 'Collected' : 'Mark as Collected';
      var flash = shinySection.querySelector('.save-flash');
      flash.style.display = '';
      setTimeout(function () { flash.style.display = 'none'; }, 1500);

      // Swap icon on the single marker instead of rebuilding all markers
      var lm = leafletMarkers.get(m.id);
      if (lm) {
        var newIcon = nowCollected
          ? getCachedIcon('_shiny_collected')
          : getCachedIcon(m.category);
        lm.setIcon(newIcon);
      }

      // Update sidebar item inline instead of rebuilding entire sidebar
      var sidebarItem = document.querySelector('.marker-item[data-marker-id="' + m.id + '"]');
      if (sidebarItem) {
        var nameSpan = sidebarItem.querySelector('.marker-item-name');
        if (nowCollected) {
          sidebarItem.classList.add('shiny-collected');
          nameSpan.textContent = '\u2713 ' + m.name;
          if (hideCollected) sidebarItem.style.display = 'none';
        } else {
          sidebarItem.classList.remove('shiny-collected');
          sidebarItem.style.display = '';
          nameSpan.textContent = m.name;
        }
      }

      // Hide marker on map when filter is active
      if (hideCollected && nowCollected && lm) {
        clusterGroup.removeLayer(lm);
        leafletMarkers.delete(m.id);
      }

      // Update the progress counter in the category row
      var progress = getRepProgress(m.category);
      var catRow = document.querySelector('input[data-category="' + m.category + '"]');
      if (catRow) {
        var countSpan = catRow.parentElement.querySelector('.cat-count');
        if (countSpan) countSpan.textContent = progress.collected + '/' + progress.total;
      }
    });
    shinySection.style.display = 'block';
  } else {
    shinySection.style.display = 'none';
  }

  panel.hidden = false;

  var latlng = rc.unproject([m.x, m.y]);
  map.panTo(latlng);
}

// ---------------------------------------------------------------------------
// Lightbox (click-to-zoom screenshots with zoom/pan)
// ---------------------------------------------------------------------------

var lbZoom = 1;
var lbPanX = 0;
var lbPanY = 0;
var lbDragging = false;
var lbDragStart = { x: 0, y: 0 };
var lbPanStart = { x: 0, y: 0 };

function openLightbox(imageUrl) {
  var overlay = document.getElementById('lightbox-overlay');
  var img = document.getElementById('lightbox-img');
  lbZoom = 1;
  lbPanX = 0;
  lbPanY = 0;
  img.style.transform = '';
  img.src = imageUrl;
  overlay.hidden = false;
}

function closeLightbox() {
  var overlay = document.getElementById('lightbox-overlay');
  overlay.hidden = true;
  document.getElementById('lightbox-img').src = '';
}

function applyLightboxTransform() {
  var img = document.getElementById('lightbox-img');
  img.style.transform = 'translate(' + lbPanX + 'px, ' + lbPanY + 'px) scale(' + lbZoom + ')';
}

function initLightbox() {
  var overlay = document.getElementById('lightbox-overlay');
  var img = document.getElementById('lightbox-img');

  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeLightbox();
  });

  // Scroll to zoom
  overlay.addEventListener('wheel', function (e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? -0.15 : 0.15;
    lbZoom = Math.max(0.5, Math.min(5, lbZoom + delta));
    if (lbZoom <= 1) { lbPanX = 0; lbPanY = 0; }
    applyLightboxTransform();
  }, { passive: false });

  // Drag to pan (when zoomed)
  img.addEventListener('mousedown', function (e) {
    if (lbZoom <= 1) return;
    e.preventDefault();
    lbDragging = true;
    lbDragStart = { x: e.clientX, y: e.clientY };
    lbPanStart = { x: lbPanX, y: lbPanY };
    img.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', function (e) {
    if (!lbDragging) return;
    lbPanX = lbPanStart.x + (e.clientX - lbDragStart.x);
    lbPanY = lbPanStart.y + (e.clientY - lbDragStart.y);
    applyLightboxTransform();
  });

  window.addEventListener('mouseup', function () {
    if (!lbDragging) return;
    lbDragging = false;
    document.getElementById('lightbox-img').style.cursor = 'grab';
  });

  // Double-click to reset zoom
  img.addEventListener('dblclick', function () {
    lbZoom = 1;
    lbPanX = 0;
    lbPanY = 0;
    applyLightboxTransform();
  });

  // Touch: pinch to zoom
  var lastTouchDist = 0;
  overlay.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist = Math.sqrt(dx * dx + dy * dy);
    } else if (e.touches.length === 1 && lbZoom > 1) {
      lbDragging = true;
      lbDragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      lbPanStart = { x: lbPanX, y: lbPanY };
    }
  }, { passive: false });

  overlay.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var scale = dist / lastTouchDist;
      lbZoom = Math.max(0.5, Math.min(5, lbZoom * scale));
      lastTouchDist = dist;
      applyLightboxTransform();
    } else if (e.touches.length === 1 && lbDragging) {
      e.preventDefault();
      lbPanX = lbPanStart.x + (e.touches[0].clientX - lbDragStart.x);
      lbPanY = lbPanStart.y + (e.touches[0].clientY - lbDragStart.y);
      applyLightboxTransform();
    }
  }, { passive: false });

  overlay.addEventListener('touchend', function () {
    lbDragging = false;
    if (lbZoom <= 1) { lbPanX = 0; lbPanY = 0; applyLightboxTransform(); }
  });
}

function initDetailPanel() {
  document.getElementById('detail-close').addEventListener('click', function () {
    document.getElementById('detail-panel').hidden = true;
    currentDetailMarker = null;
    setSelectedMarker(null);
  });

  document.getElementById('btn-suggest-edit').addEventListener('click', function () {
    if (currentDetailMarker) {
      openModalForEdit(currentDetailMarker);
    }
  });

  document.getElementById('btn-suggest-delete').addEventListener('click', function () {
    if (!currentDetailMarker) return;
    if (!discordUser) {
      startDiscordLogin();
      return;
    }
    suggestDeletion(currentDetailMarker);
  });

  initLightbox();
}

function suggestDeletion(marker) {
  var btn = document.getElementById('btn-suggest-delete');
  var originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  var body = {
    markers: [{
      id: marker.id,
      deletion: true,
      category: marker.category,
      name: marker.name,
      x: marker.x,
      y: marker.y,
      floor: marker.floor || 'surface',
      region: marker.region || '',
      description: ''
    }],
    authorName: discordUser.globalName || discordUser.username,
    authorDiscordId: discordUser.id
  };

  fetchCorvidAPI('/api/markers/submit', body)
    .then(function (result) {
      if (result.ok && result.data.success) {
        btn.textContent = 'Submitted!';
        btn.style.color = 'var(--success)';
        btn.style.borderColor = 'var(--success)';
        setTimeout(function () {
          btn.textContent = originalText;
          btn.style.color = '';
          btn.style.borderColor = '';
          btn.disabled = false;
        }, 3000);
      } else {
        throw new Error(result.data.error || 'Failed');
      }
    })
    .catch(function (err) {
      console.error('Deletion suggestion error:', err);
      btn.textContent = 'Error — try again';
      btn.style.color = 'var(--danger)';
      setTimeout(function () {
        btn.textContent = originalText;
        btn.style.color = '';
        btn.disabled = false;
      }, 3000);
    });
}

// ---------------------------------------------------------------------------
// My Contributions & Leaderboard
// ---------------------------------------------------------------------------

function initContributions() {
  document.getElementById('btn-my-contributions').addEventListener('click', showContributions);
  document.getElementById('contributions-close').addEventListener('click', function () {
    document.getElementById('contributions-modal').hidden = true;
  });
  document.getElementById('btn-leaderboard').addEventListener('click', showLeaderboard);
  document.getElementById('leaderboard-close').addEventListener('click', function () {
    document.getElementById('leaderboard-modal').hidden = true;
  });
}

function showContributions() {
  var body = document.getElementById('contributions-body');

  if (!discordUser) {
    body.innerHTML = '<p class="info-modal-empty">Login with Discord to see your contributions.</p>';
    document.getElementById('contributions-modal').hidden = false;
    return;
  }

  // Find local edits
  var edits = getLocalEdits();
  var editIds = Object.keys(edits);

  // Find markers contributed by this user (by name match or local edits)
  var userName = (discordUser.globalName || discordUser.username).toLowerCase();
  var contributions = allMarkers.filter(function (m) {
    if (editIds.indexOf(m.id) >= 0) return true;
    if (m.contributedBy && m.contributedBy.toLowerCase() === userName) return true;
    return false;
  });

  if (contributions.length === 0) {
    body.innerHTML = '<p class="info-modal-empty">No contributions yet. Submit or edit markers to see them here.</p>';
  } else {
    body.innerHTML = '';
    contributions.sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (var m of contributions) {
      var cat = CATEGORIES[m.category];
      var item = document.createElement('div');
      item.className = 'contrib-item';
      var isEdit = editIds.indexOf(m.id) >= 0;
      var catIcon = (cat && cat.icon)
        ? '<img src="markers/' + cat.icon + '" width="16" height="16" style="vertical-align:text-bottom">'
        : (cat ? cat.emoji : '');
      item.innerHTML =
        '<span class="contrib-emoji">' + catIcon + '</span>' +
        '<span class="contrib-name">' + m.name + '</span>' +
        '<span class="contrib-status ' + (isEdit ? 'pending' : 'submitted') + '">' +
        (isEdit ? 'Edited' : 'Submitted') + '</span>';
      item.dataset.markerId = m.id;
      item.dataset.x = m.x;
      item.dataset.y = m.y;
      item.addEventListener('click', function (e) {
        document.getElementById('contributions-modal').hidden = true;
        onMarkerItemClick(e);
      });
      body.appendChild(item);
    }
  }

  // Update badge
  var badge = document.getElementById('contrib-count');
  if (contributions.length > 0) {
    badge.textContent = contributions.length;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

  document.getElementById('contributions-modal').hidden = false;
}

function showLeaderboard() {
  var body = document.getElementById('leaderboard-body');

  // Count contributions by author
  var counts = {};
  for (var m of allMarkers) {
    var author = m.contributedBy || '';
    if (!author || author === 'Community') continue;
    counts[author] = (counts[author] || 0) + 1;
  }

  var sorted = Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; });

  if (sorted.length === 0) {
    body.innerHTML = '<p class="info-modal-empty">No contributors yet.</p>';
  } else {
    body.innerHTML = '';
    for (var i = 0; i < sorted.length; i++) {
      var row = document.createElement('div');
      row.className = 'leaderboard-row';
      var rank = i + 1;
      var medal = rank === 1 ? '\uD83E\uDD47' : rank === 2 ? '\uD83E\uDD48' : rank === 3 ? '\uD83E\uDD49' : '';
      row.innerHTML =
        '<span class="leaderboard-rank">' + (medal || '#' + rank) + '</span>' +
        '<span class="leaderboard-name">' + sorted[i][0] + '</span>' +
        '<span class="leaderboard-count">' + sorted[i][1] + ' marker' + (sorted[i][1] > 1 ? 's' : '') + '</span>';
      body.appendChild(row);
    }
  }

  document.getElementById('leaderboard-modal').hidden = false;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function initSidebar() {
  var toggle = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  toggle.addEventListener('click', function () {
    sidebar.classList.toggle('collapsed');
    toggle.textContent = sidebar.classList.contains('collapsed') ? '\u25B6' : '\u25C0';
    setTimeout(function () { map.invalidateSize(); }, 250);
  });

  document.getElementById('search-input').addEventListener('input', onSearch);
}

var updateSidebar = function () { buildSidebar(); };

function buildSidebar() {
  var container = document.getElementById('category-groups');
  container.innerHTML = '';

  var counts = {};
  var markersByCategory = {};
  for (var m of allMarkers) {
    if (m.floor !== 'surface') continue;
    counts[m.category] = (counts[m.category] || 0) + 1;
    if (!markersByCategory[m.category]) markersByCategory[m.category] = [];
    markersByCategory[m.category].push(m);
  }

  for (var key in markersByCategory) {
    markersByCategory[key].sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  for (var groupName of GROUP_ORDER) {
    var cats = Object.entries(CATEGORIES).filter(function (e) { return e[1].group === groupName; });
    if (cats.length === 0) continue;

    var group = document.createElement('div');
    group.className = 'category-group';

    var header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = '<span>' + groupName + '</span><span class="group-arrow">\u25BC</span>';
    group.appendChild(header);

    var body = document.createElement('div');
    body.className = 'group-body';

    for (var entry of cats) {
      var catKey = entry[0];
      var catMeta = entry[1];
      var count = counts[catKey] || 0;

      // Use div (not label) so checkbox clicks don't interfere with expand
      var row = document.createElement('div');
      row.className = 'cat-row';
      row.innerHTML =
        '<input type="checkbox" data-category="' + catKey + '" ' +
        (visibility[catKey] ? 'checked' : '') + ' />' +
        '<span class="cat-emoji">' + (catMeta.icon ? '<img src="markers/' + catMeta.icon + '" width="16" height="16" style="vertical-align:text-bottom">' : catMeta.emoji) + '</span>' +
        '<span class="cat-label">' + catMeta.label + '</span>' +
        '<span class="cat-count">' + ((catKey === 'reputation_shiny' || catKey === 'npc_reputation') ? getRepProgress(catKey).collected + '/' + count : count) + '</span>' +
        (count > 0 ? '<span class="cat-arrow">\u25B6</span>' : '');
      body.appendChild(row);

      if (count > 0) {
        var list = document.createElement('div');
        list.className = 'marker-list';
        list.id = 'list-' + catKey;
        list.style.display = 'none';

        var shinyState = (catKey === 'reputation_shiny' || catKey === 'npc_reputation') ? getShinyCollected() : {};
        for (var marker of (markersByCategory[catKey] || [])) {
          var item = document.createElement('div');
          item.className = 'marker-item';
          if (shinyState[marker.id]) {
            item.classList.add('shiny-collected');
            if (hideCollected) item.style.display = 'none';
          }
          var nameSpan = document.createElement('span');
          nameSpan.className = 'marker-item-name';
          nameSpan.textContent = (shinyState[marker.id] ? '\u2713 ' : '') + marker.name;
          item.appendChild(nameSpan);
          if (marker.region) {
            var regionSpan = document.createElement('span');
            regionSpan.className = 'marker-item-region';
            regionSpan.textContent = marker.region;
            item.appendChild(regionSpan);
          }
          item.dataset.markerId = marker.id;
          item.dataset.x = marker.x;
          item.dataset.y = marker.y;
          item.addEventListener('click', onMarkerItemClick);
          list.appendChild(item);
        }
        body.appendChild(list);

        (function (listEl, rowEl) {
          rowEl.addEventListener('click', function (e) {
            if (e.target.type === 'checkbox') return;
            var arrow = rowEl.querySelector('.cat-arrow');
            if (listEl.style.display === 'none') {
              listEl.style.display = 'block';
              if (arrow) arrow.textContent = '\u25BC';
            } else {
              listEl.style.display = 'none';
              if (arrow) arrow.textContent = '\u25B6';
            }
          });
        })(list, row);
      }
    }

    // Add "Hide collected" toggle to the Reputation group
    if (groupName === 'Reputation') {
      var filterRow = document.createElement('div');
      filterRow.className = 'cat-row hide-collected-row';
      filterRow.innerHTML =
        '<input type="checkbox" id="hide-collected-toggle" ' + (hideCollected ? 'checked' : '') + ' />' +
        '<span class="cat-label" style="font-style:italic;opacity:0.8">Hide collected</span>';
      body.appendChild(filterRow);
      filterRow.querySelector('input').addEventListener('change', function (e) {
        e.stopPropagation();
        hideCollected = this.checked;
        renderMarkers();
        // Toggle visibility of collected items in sidebar
        var items = document.querySelectorAll('.marker-item.shiny-collected');
        for (var i = 0; i < items.length; i++) {
          items[i].style.display = hideCollected ? 'none' : '';
        }
      });
    }

    group.appendChild(body);

    header.addEventListener('click', function () {
      var b = this.nextElementSibling;
      var a = this.querySelector('.group-arrow');
      if (b.style.display === 'none') {
        b.style.display = 'block';
        a.textContent = '\u25BC';
      } else {
        b.style.display = 'none';
        a.textContent = '\u25B6';
      }
    });

    container.appendChild(group);
  }

  container.addEventListener('change', function (e) {
    if (e.target.dataset.category) {
      visibility[e.target.dataset.category] = e.target.checked;
      renderMarkers();
      updateStats();
    }
  });
}

function onMarkerItemClick(e) {
  // Walk up to find the element with data attributes (handles clicks on child spans)
  var el = e.target;
  while (el && !el.dataset.markerId) el = el.parentElement;
  if (!el) return;

  var id = el.dataset.markerId;
  var x = parseInt(el.dataset.x, 10);
  var y = parseInt(el.dataset.y, 10);

  var m = allMarkers.find(function (mk) { return mk.id === id; });
  if (m) showDetail(m);

  var latlng = rc.unproject([x, y]);
  map.setView(latlng, 5);

  var lm = leafletMarkers.get(id);
  if (lm) {
    setSelectedMarker(lm);
    clusterGroup.zoomToShowLayer(lm, function () {
      lm.openTooltip();
    });
  }
}

function updateStats() {
  var visible = 0;
  var total = 0;
  for (var m of allMarkers) {
    if (m.floor !== 'surface') continue;
    total++;
    if (visibility[m.category]) visible++;
  }
  document.getElementById('sidebar-stats').textContent =
    'Showing ' + visible + ' of ' + total + ' markers';
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function onSearch(e) {
  var query = e.target.value.toLowerCase().trim();
  if (!query) {
    renderMarkers();
    document.querySelectorAll('.marker-list').forEach(function (el) { el.style.display = 'none'; });
    document.querySelectorAll('.marker-item').forEach(function (el) { el.style.display = ''; });
    return;
  }

  document.querySelectorAll('.marker-list').forEach(function (list) {
    var hasMatch = false;
    list.querySelectorAll('.marker-item').forEach(function (item) {
      if (item.textContent.toLowerCase().includes(query)) {
        item.style.display = '';
        hasMatch = true;
      } else {
        item.style.display = 'none';
      }
    });
    list.style.display = hasMatch ? 'block' : 'none';
  });

  clusterGroup.clearLayers();
  for (var m of allMarkers) {
    if (m.floor !== 'surface') continue;
    if (!visibility[m.category]) continue;
    if (!m.name.toLowerCase().includes(query)) continue;
    var lm = leafletMarkers.get(m.id);
    if (lm) clusterGroup.addLayer(lm);
  }
}

// ---------------------------------------------------------------------------
// Modal (Submit new / Suggest edit — via Corvid API)
// ---------------------------------------------------------------------------

function initModal() {
  var btnOpen = document.getElementById('btn-submit');
  var btnClose = document.getElementById('modal-close');
  var btnCancel = document.getElementById('btn-cancel');
  var btnCreate = document.getElementById('btn-create-issue');

  btnOpen.addEventListener('click', function () {
    if (!discordUser) {
      if (confirm('You need to login with Discord to submit markers. Login now?')) {
        startDiscordLogin();
      }
      return;
    }
    openModalForSubmit();
  });

  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);

  // Overlay has pointer-events:none so map clicks pass through;
  // close only via X / Cancel buttons

  var fields = ['submit-category', 'submit-name'];
  fields.forEach(function (id) {
    document.getElementById(id).addEventListener('input', validateForm);
    document.getElementById(id).addEventListener('change', validateForm);
  });

  btnCreate.addEventListener('click', submitToCorvid);

  // Screenshot paste from clipboard
  document.getElementById('btn-paste-screenshot').addEventListener('click', pasteScreenshot);
  document.getElementById('btn-remove-screenshot').addEventListener('click', function () {
    pendingScreenshot = null;
    clearScreenshotPreview();
  });
}

function openModalForSubmit() {
  modalMode = 'submit';
  editingMarker = null;

  document.getElementById('submit-category').value = '';
  document.getElementById('submit-name').value = '';
  document.getElementById('submit-description').value = '';
  document.getElementById('submit-region').value = '';
  pendingScreenshot = null;
  clearScreenshotPreview();
  submitCoords = null;
  removePreviewMarker();

  document.getElementById('submit-category').disabled = false;

  document.getElementById('modal-title').textContent = 'Submit a Marker';
  document.getElementById('modal-info').textContent =
    'Click on the map to place your marker, then fill in the details below. ' +
    'Your submission will be reviewed before being added.';
  document.getElementById('btn-create-issue').textContent = 'Submit Marker';

  // Show author as verified Discord name
  var authorEl = document.getElementById('submit-author-display');
  authorEl.textContent = discordUser ? (discordUser.globalName || discordUser.username) : '';

  updateCoordsDisplay();
  validateForm();
  document.getElementById('marker-modal').hidden = false;
}

function openModalForEdit(m) {
  if (!discordUser) {
    if (confirm('You need to login with Discord to suggest edits. Login now?')) {
      startDiscordLogin();
    }
    return;
  }

  modalMode = 'edit';
  editingMarker = m;

  document.getElementById('submit-category').value = m.category || '';
  document.getElementById('submit-name').value = m.name || '';
  document.getElementById('submit-description').value = m.description || '';
  document.getElementById('submit-region').value = m.region || '';
  pendingScreenshot = null;
  clearScreenshotPreview();
  submitCoords = { x: m.x, y: m.y };

  document.getElementById('submit-category').disabled = true;

  // Hide the original marker and show a movable preview in its place
  var originalLeaflet = leafletMarkers.get(m.id);
  if (originalLeaflet) clusterGroup.removeLayer(originalLeaflet);
  var editLatlng = rc.unproject([m.x, m.y]);
  updatePreviewMarker(editLatlng);

  document.getElementById('modal-title').textContent = 'Suggest Edit';
  document.getElementById('modal-info').textContent =
    'Modify the fields you want to change. You can click the map to update the position. ' +
    'Your suggestion will be reviewed before being applied.';
  document.getElementById('btn-create-issue').textContent = 'Submit Edit';

  var authorEl = document.getElementById('submit-author-display');
  authorEl.textContent = discordUser ? (discordUser.globalName || discordUser.username) : '';

  updateCoordsDisplay();
  validateForm();
  document.getElementById('marker-modal').hidden = false;
}

function closeModal() {
  // Restore original marker if we were editing
  if (editingMarker) {
    var originalLeaflet = leafletMarkers.get(editingMarker.id);
    if (originalLeaflet && visibility[editingMarker.category]) {
      clusterGroup.addLayer(originalLeaflet);
    }
  }

  document.getElementById('marker-modal').hidden = true;
  submitCoords = null;
  editingMarker = null;
  pendingScreenshot = null;
  document.getElementById('submit-category').disabled = false;
  removePreviewMarker();
  clearScreenshotPreview();
  var btn = document.getElementById('btn-create-issue');
  btn.classList.remove('btn-success', 'btn-error');
}

function onMapClick(e) {
  var modal = document.getElementById('marker-modal');
  if (modal.hidden) return;

  var px = rc.project(e.latlng);
  submitCoords = { x: Math.round(px.x), y: Math.round(px.y) };
  updateCoordsDisplay();
  validateForm();
  updatePreviewMarker(e.latlng);
}

function updatePreviewMarker(latlng) {
  if (previewMarker) {
    previewMarker.setLatLng(latlng);
  } else {
    var category = document.getElementById('submit-category').value;
    var icon = getCachedIcon(category || '_preview');
    previewMarker = L.marker(latlng, { icon: icon, opacity: 0.8 }).addTo(map);
  }
  // Update icon if category changed
  var category = document.getElementById('submit-category').value;
  if (category) {
    previewMarker.setIcon(getCachedIcon(category));
  }
}

function removePreviewMarker() {
  if (previewMarker) {
    map.removeLayer(previewMarker);
    previewMarker = null;
  }
}

// ---------------------------------------------------------------------------
// Screenshot (paste from clipboard)
// ---------------------------------------------------------------------------

function compressToWebP(blob) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var objectUrl = URL.createObjectURL(blob);
    img.onload = function () {
      URL.revokeObjectURL(objectUrl);
      var canvas = document.createElement('canvas');
      // Match companion app: 600px wide, quality 0.55 — keeps base64 under GitHub limit
      var maxW = 600;
      var w = img.width;
      var h = img.height;
      if (w > maxW) {
        h = Math.round(h * maxW / w);
        w = maxW;
      }
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      var dataUrl = canvas.toDataURL('image/webp', 0.55);
      resolve(dataUrl);
    };
    img.onerror = function () {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image'));
    };
    img.src = objectUrl;
  });
}

function pasteScreenshot() {
  navigator.clipboard.read().then(function (items) {
    for (var item of items) {
      // Find an image type
      var imageType = item.types.find(function (t) { return t.startsWith('image/'); });
      if (!imageType) continue;

      item.getType(imageType).then(function (blob) {
        compressToWebP(blob).then(function (dataUrl) {
          pendingScreenshot = dataUrl.split(',')[1]; // strip data:... prefix
          showScreenshotPreview(dataUrl);
        });
      });
      return;
    }
    alert('No image found in clipboard. Copy a screenshot first.');
  }).catch(function () {
    alert('Could not read clipboard. Make sure you have an image copied.');
  });
}

function showScreenshotPreview(dataUrl) {
  var preview = document.getElementById('screenshot-preview');
  document.getElementById('screenshot-preview-img').src = dataUrl;
  preview.hidden = false;
  document.getElementById('btn-paste-screenshot').textContent = 'Replace from Clipboard';
}

function clearScreenshotPreview() {
  pendingScreenshot = null;
  var preview = document.getElementById('screenshot-preview');
  preview.hidden = true;
  document.getElementById('screenshot-preview-img').src = '';
  document.getElementById('btn-paste-screenshot').textContent = 'Paste from Clipboard';
}

function updateCoordsDisplay() {
  var el = document.getElementById('submit-coords');
  if (submitCoords) {
    el.textContent = submitCoords.x + ', ' + submitCoords.y;
    el.classList.add('has-coords');
  } else {
    el.textContent = 'Click on the map to set position';
    el.classList.remove('has-coords');
  }
}

function validateForm() {
  var category = document.getElementById('submit-category').value;
  var name = document.getElementById('submit-name').value.trim();
  var valid = category && name && submitCoords && discordUser;
  document.getElementById('btn-create-issue').disabled = !valid;
}

// ---------------------------------------------------------------------------
// Local edit persistence (localStorage)
// ---------------------------------------------------------------------------

var LOCAL_EDITS_KEY = 'rhud_marker_edits';

function getLocalEdits() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_EDITS_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function saveLocalEdit(markerId, fields) {
  var edits = getLocalEdits();
  edits[markerId] = fields;
  localStorage.setItem(LOCAL_EDITS_KEY, JSON.stringify(edits));
}

function applyLocalEdits() {
  var edits = getLocalEdits();
  var keys = Object.keys(edits);
  if (keys.length === 0) return;

  for (var m of allMarkers) {
    if (edits[m.id]) {
      var e = edits[m.id];
      if (e.name) m.name = e.name;
      if (e.x != null) m.x = e.x;
      if (e.y != null) m.y = e.y;
      if (e.description != null) m.description = e.description;
      if (e.region != null) m.region = e.region;
    }
  }
}

// ---------------------------------------------------------------------------
// Submit / Edit
// ---------------------------------------------------------------------------

function submitToCorvid() {
  if (!discordUser || !submitCoords) return;

  var category = document.getElementById('submit-category').value;
  var name = document.getElementById('submit-name').value.trim();
  var description = document.getElementById('submit-description').value.trim();
  var region = document.getElementById('submit-region').value.trim();

  var btn = document.getElementById('btn-create-issue');
  var originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  var isEdit = modalMode === 'edit' && editingMarker;

  var markerPayload = {
    category: category,
    name: name,
    x: submitCoords.x,
    y: submitCoords.y,
    floor: 'surface'
  };
  if (description) markerPayload.description = description;
  if (region) markerPayload.region = region;

  // For edits: include original ID and correction flag so ingestion updates in-place
  if (isEdit) {
    markerPayload.id = editingMarker.id;
    markerPayload.correction = true;
  }

  var body = {
    markers: [markerPayload],
    authorName: discordUser.globalName || discordUser.username,
    authorDiscordId: discordUser.id
  };
  if (pendingScreenshot) body.screenshot = pendingScreenshot;

  // For edits: include original values so the issue can show what changed
  if (isEdit) {
    body.originalMarker = {
      name: editingMarker.name,
      x: editingMarker.x,
      y: editingMarker.y,
      description: editingMarker.description || '',
      region: editingMarker.region || ''
    };
  }

  fetchCorvidAPI('/api/markers/submit', body)
    .then(function (result) {
      if (result.ok && result.data.success) {
        btn.textContent = 'Submitted!';
        btn.classList.add('btn-success');

        // Persist edit locally so the user sees their change immediately
        if (isEdit) {
          saveLocalEdit(editingMarker.id, {
            name: name,
            x: submitCoords.x,
            y: submitCoords.y,
            description: description,
            region: region
          });
          // Apply to in-memory marker too
          var m = allMarkers.find(function (mk) { return mk.id === editingMarker.id; });
          if (m) {
            m.name = name;
            m.x = submitCoords.x;
            m.y = submitCoords.y;
            m.description = description;
            m.region = region;
          }
          renderMarkers();
          updateStats();
        }

        setTimeout(function () { closeModal(); }, 1500);
      } else {
        throw new Error(result.data.error || 'Submission failed');
      }
    })
    .catch(function (err) {
      console.error('Submission error:', err);
      var msg = (err && err.message) || 'Unknown error';
      btn.textContent = msg.length > 40 ? 'Error — try again' : msg;
      btn.classList.add('btn-error');
      btn.disabled = false;
      setTimeout(function () {
        btn.textContent = originalText;
        btn.classList.remove('btn-error');
        validateForm();
      }, 4000);
    });
}
