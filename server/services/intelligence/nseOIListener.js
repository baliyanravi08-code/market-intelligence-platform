"use strict";

/**
 * nseOIListener.js
 * Polls Upstox /v2/option/chain every 60s for full OI snapshots.
 * Extends upstoxStream.js WebSocket to subscribe F&O instruments for live ticks.
 * Emits 'option-chain-update' via Socket.io.
 *
 * Place at: server/services/intelligence/nseOIListener.js
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");
const { processOptionChain } = require("./optionChainEngine");

const CACHE_FILE = path.join(__dirname, "../../data/optionChainCache.json");

let ioRef        = null;
let tokenGetter  = null;
let pollTimer    = null;
let isMarketOpen = false;

// In-memory cache: underlying → { expiries, chains }
const cache = {};

// ── Underlyings to track ──────────────────────────────────────────────────────
// These are the instrument keys for Upstox option chain API
const DEFAULT_UNDERLYINGS = [
  { name: "NIFTY",     key: "NSE_INDEX|Nifty 50" },
  { name: "BANKNIFTY", key: "NSE_INDEX|Nifty Bank" },
];

// F&O stocks can be added dynamically via addUnderlying()
const activeUnderlyings = [...DEFAULT_UNDERLYINGS];

// ── Upstox REST helpers ───────────────────────────────────────────────────────

function getAuthHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
  };
}

async function fetchExpiries(underlying, token) {
  try {
    const res = await axios.get(
      "https://api.upstox.com/v2/option/chain/expiry-dates",
      {
        params:  { instrument_key: underlying },
        headers: getAuthHeaders(token),
        timeout: 10000,
      }
    );
    return res.data?.data || [];
  } catch (e) {
    console.warn(`⚠️ OI: expiry fetch failed for ${underlying}:`, e.message);
    return [];
  }
}

async function fetchOptionChain(underlying, expiry, token) {
  try {
    const res = await axios.get(
      "https://api.upstox.com/v2/option/chain",
      {
        params:  { instrument_key: underlying, expiry_date: expiry },
        headers: getAuthHeaders(token),
        timeout: 15000,
      }
    );
    return res.data?.data || [];
  } catch (e) {
    console.warn(`⚠️ OI: chain fetch failed ${underlying} ${expiry}:`, e.response?.data?.message || e.message);
    return null;
  }
}

// ── Market hours check ────────────────────────────────────────────────────────

function checkMarketOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
  // Mon–Fri, 9:15–15:30 IST
  if (day === 0 || day === 6) return false;
  const mins = h * 60 + m;
  return mins >= 555 && mins <= 930; // 9:15 → 15:30
}

// ── Poll all underlyings ──────────────────────────────────────────────────────

async function pollAll() {
  const token = tokenGetter?.();
  if (!token) {
    console.log("⚠️ OI: no token — skipping poll");
    return;
  }

  isMarketOpen = checkMarketOpen();

  for (const u of activeUnderlyings) {
    try {
      await pollUnderlying(u, token);
      // Small delay between underlyings to avoid rate limits
      await sleep(1500);
    } catch (e) {
      console.warn(`⚠️ OI: poll failed for ${u.name}:`, e.message);
    }
  }

  persistCache();
}

async function pollUnderlying({ name, key }, token) {
  // 1. Get expiries (cache for 1h)
  let expiries = cache[name]?.expiries;
  const expiryCacheAge = cache[name]?.expiriesFetchedAt || 0;

  if (!expiries || Date.now() - expiryCacheAge > 60 * 60 * 1000) {
    expiries = await fetchExpiries(key, token);
    if (!expiries.length) return;

    if (!cache[name]) cache[name] = {};
    cache[name].expiries         = expiries;
    cache[name].expiriesFetchedAt = Date.now();
  }

  // Use nearest 2 expiries
  const nearExpiries = expiries.slice(0, 2);

  for (const expiry of nearExpiries) {
    const rawStrikes = await fetchOptionChain(key, expiry, token);
    if (!rawStrikes || !rawStrikes.length) continue;

    // Spot price from first strike's underlying_spot_price
    const spotPrice = rawStrikes[0]?.underlying_spot_price || 0;

    const processed = processOptionChain(name, expiry, rawStrikes, spotPrice);

    // Store in cache
    if (!cache[name].chains) cache[name].chains = {};
    cache[name].chains[expiry] = processed;
    cache[name].spotPrice      = spotPrice;
    cache[name].updatedAt      = Date.now();

    // Emit to all connected clients
    if (ioRef) {
      ioRef.emit("option-chain-update", {
        underlying: name,
        expiry,
        data: processed,
      });
    }

    console.log(`📊 OI: ${name} ${expiry} — PCR=${processed.pcr} MaxPain=${processed.maxPainStrike} Sup=${processed.support} Res=${processed.resistance}`);

    await sleep(800);
  }
}

// ── WebSocket OI tick handler (called from upstoxStream.js) ──────────────────

/**
 * Called by upstoxStream.js when a marketFF tick arrives for an NSE_FO instrument.
 * Updates the in-memory cache with live OI ticks and emits micro-update.
 */
function handleOITick(instrumentKey, feedData) {
  const mFF = feedData?.marketFF;
  if (!mFF) return;

  const liveOI  = mFF.oi  || 0;
  const liveLTP = mFF.ltpc?.ltp || 0;

  // Broadcast lightweight tick (full chain is emitted on REST poll)
  if (ioRef) {
    ioRef.emit("option-oi-tick", {
      instrKey: instrumentKey,
      oi:       liveOI,
      ltp:      liveLTP,
      ts:       Date.now(),
    });
  }
}

// ── Expiry list API ───────────────────────────────────────────────────────────

function getExpiries(underlying) {
  return cache[underlying]?.expiries || [];
}

function getChain(underlying, expiry) {
  return cache[underlying]?.chains?.[expiry] || null;
}

function getAllCached() {
  return cache;
}

// ── Add F&O stock underlying dynamically ─────────────────────────────────────

function addUnderlying(name, instrumentKey) {
  if (activeUnderlyings.find(u => u.key === instrumentKey)) return;
  activeUnderlyings.push({ name, key: instrumentKey });
  console.log(`➕ OI: added underlying ${name}`);
}

// ── Persist / load cache ──────────────────────────────────────────────────────

function persistCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Don't persist strikes array (too large) — just metadata
    const slim = {};
    for (const [name, data] of Object.entries(cache)) {
      slim[name] = {
        expiries:          data.expiries || [],
        spotPrice:         data.spotPrice || 0,
        updatedAt:         data.updatedAt || 0,
        expiriesFetchedAt: data.expiriesFetchedAt || 0,
        // Store latest chain summary only
        chainSummary: Object.entries(data.chains || {}).reduce((acc, [exp, chain]) => {
          acc[exp] = {
            pcr:           chain.pcr,
            maxPainStrike: chain.maxPainStrike,
            support:       chain.support,
            resistance:    chain.resistance,
            totalCEOI:     chain.totalCEOI,
            totalPEOI:     chain.totalPEOI,
            updatedAt:     chain.updatedAt,
          };
          return acc;
        }, {}),
      };
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(slim, null, 2), "utf8");
  } catch (e) {
    console.warn("⚠️ OI cache persist failed:", e.message);
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────

function startNSEOIListener(io, tGetter) {
  ioRef       = io;
  tokenGetter = tGetter;

  console.log("🔭 NSE OI Listener starting...");

  // First poll after 5s (let instrument master load)
  setTimeout(() => pollAll(), 5000);

  // Then poll every 60s
  pollTimer = setInterval(() => pollAll(), 60 * 1000);

  // Handle client requesting specific underlying on demand
  io.on("connection", socket => {
    // Send cached data to new client
    socket.on("request-option-chain", ({ underlying, expiry }) => {
      const chain = getChain(underlying, expiry);
      if (chain) {
        socket.emit("option-chain-update", { underlying, expiry, data: chain });
      }
      // Also send expiry list
      socket.emit("option-expiries", {
        underlying,
        expiries: getExpiries(underlying),
      });
    });

    // Add a stock underlying on demand
    socket.on("add-oi-underlying", ({ name, instrumentKey }) => {
      addUnderlying(name, instrumentKey);
    });

    // Send all cached expiries on connect
    for (const name of Object.keys(cache)) {
      socket.emit("option-expiries", {
        underlying: name,
        expiries:   getExpiries(name),
      });
    }
  });
}

function stopNSEOIListener() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  startNSEOIListener,
  stopNSEOIListener,
  handleOITick,
  getExpiries,
  getChain,
  getAllCached,
  addUnderlying,
};