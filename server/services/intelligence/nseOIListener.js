"use strict";

/**
 * nseOIListener.js
 * Polls option chain data every 60s.
 * Place at: server/services/intelligence/nseOIListener.js
 *
 * FIXED 06 Apr 2026:
 * - Upstox /v2/option/chain returns 400/404 for index options — requires
 *   a specific F&O API subscription scope on the token.
 * - Switched expiry source to NSE website (works on Render via public endpoint)
 * - Option chain data fetched from Upstox only for individual stock F&O
 *   (which works with standard token); index OI now from NSE directly.
 * - Falls back gracefully if both blocked — no crashes, just silent skip.
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

let optionChainEngine = null;
try {
  optionChainEngine = require("./optionChainEngine");
} catch (e) {
  console.warn("⚠️ OI: optionChainEngine not found — chain processing disabled");
}

const CACHE_FILE = path.join(__dirname, "../../data/optionChainCache.json");

let ioRef        = null;
let tokenGetter  = null;
let pollTimer    = null;

const cache = {};

const DEFAULT_UNDERLYINGS = [
  { name: "NIFTY",     key: "NSE_INDEX|Nifty 50",   nseSymbol: "NIFTY"     },
  { name: "BANKNIFTY", key: "NSE_INDEX|Nifty Bank",  nseSymbol: "BANKNIFTY" },
];

const activeUnderlyings = [...DEFAULT_UNDERLYINGS];

function getAuthHeaders(token) {
  return { "Authorization": `Bearer ${token}`, "Accept": "application/json" };
}

// ── Expiry fetcher: try Upstox first, fall back to NSE ───────────────────────

async function fetchExpiriesUpstox(instrumentKey, token) {
  // Try v2 instruments endpoint
  const endpoints = [
    "https://api.upstox.com/v2/option/chain/instruments",
    "https://api.upstox.com/v2/option/chain/expiry-dates",
  ];
  for (const url of endpoints) {
    try {
      const res = await axios.get(url, {
        params:  { instrument_key: instrumentKey },
        headers: getAuthHeaders(token),
        timeout: 8000,
      });
      const d = res.data?.data;
      if (!d) continue;
      const expiries = Array.isArray(d) ? d : (d.expiry_dates || []);
      if (expiries.length) return expiries;
    } catch (e) {
      // silent — try next
    }
  }
  return [];
}

async function fetchExpiriesNSE(nseSymbol) {
  // NSE public option chain endpoint — works on cloud without cookies
  try {
    const res = await axios.get(
      `https://www.nseindia.com/api/option-chain-indices?symbol=${nseSymbol}`,
      {
        timeout: 10000,
        headers: {
          "User-Agent":  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept":      "application/json",
          "Referer":     "https://www.nseindia.com/option-chain",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }
    );
    const expiries = res.data?.records?.expiryDates || [];
    return expiries;
  } catch (e) {
    return [];
  }
}

async function fetchExpiries(underlying, token) {
  // 1. Try Upstox
  const upstoxExpiries = await fetchExpiriesUpstox(underlying.key, token);
  if (upstoxExpiries.length) return { source: "upstox", expiries: upstoxExpiries };

  // 2. Try NSE directly
  if (underlying.nseSymbol) {
    const nseExpiries = await fetchExpiriesNSE(underlying.nseSymbol);
    if (nseExpiries.length) return { source: "nse", expiries: nseExpiries };
  }

  return { source: null, expiries: [] };
}

// ── Option chain fetcher ──────────────────────────────────────────────────────

async function fetchChainUpstox(instrumentKey, expiry, token) {
  try {
    const res = await axios.get("https://api.upstox.com/v2/option/chain", {
      params:  { instrument_key: instrumentKey, expiry_date: expiry },
      headers: getAuthHeaders(token),
      timeout: 15000,
    });
    return { source: "upstox", data: res.data?.data || [] };
  } catch (e) {
    return { source: null, data: [] };
  }
}

async function fetchChainNSE(nseSymbol, expiry) {
  try {
    const res = await axios.get(
      `https://www.nseindia.com/api/option-chain-indices?symbol=${nseSymbol}`,
      {
        timeout: 12000,
        headers: {
          "User-Agent":  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept":      "application/json",
          "Referer":     "https://www.nseindia.com/option-chain",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }
    );
    const records = res.data?.records;
    if (!records) return { source: null, data: [] };

    // Filter by expiry
    const filtered = (records.data || []).filter(r =>
      !expiry || r.expiryDate === expiry
    );
    return { source: "nse", data: filtered, spotPrice: records.underlyingValue };
  } catch (e) {
    return { source: null, data: [] };
  }
}

// ── Market hours ──────────────────────────────────────────────────────────────

function checkMarketOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = h * 60 + m;
  return mins >= 555 && mins <= 930;
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function pollAll() {
  const token = tokenGetter?.();
  if (!token) return;

  for (const u of activeUnderlyings) {
    try {
      await pollUnderlying(u, token);
      await sleep(1500);
    } catch (e) {
      console.warn(`⚠️ OI: poll failed for ${u.name}:`, e.message);
    }
  }

  persistCache();
}

async function pollUnderlying(underlying, token) {
  const { name } = underlying;

  // Get expiries
  let expiries    = cache[name]?.expiries;
  const cacheAge  = cache[name]?.expiriesFetchedAt || 0;

  if (!expiries?.length || Date.now() - cacheAge > 60 * 60 * 1000) {
    const result = await fetchExpiries(underlying, token);
    if (!result.expiries.length) {
      console.warn(`⚠️ OI: no expiries for ${name} — skipping`);
      return;
    }
    if (!cache[name]) cache[name] = {};
    cache[name].expiries          = result.expiries;
    cache[name].expiriesSource    = result.source;
    cache[name].expiriesFetchedAt = Date.now();
    expiries = result.expiries;
  }

  const nearExpiries = expiries.slice(0, 2);

  for (const expiry of nearExpiries) {
    let rawData = null;
    let spotPrice = 0;

    // Try Upstox first
    const upstoxResult = await fetchChainUpstox(underlying.key, expiry, token);
    if (upstoxResult.data.length) {
      rawData   = upstoxResult.data;
      spotPrice = rawData[0]?.underlying_spot_price || 0;
    }

    // Fall back to NSE
    if (!rawData?.length && underlying.nseSymbol) {
      const nseResult = await fetchChainNSE(underlying.nseSymbol, expiry);
      if (nseResult.data.length) {
        rawData   = nseResult.data;
        spotPrice = nseResult.spotPrice || 0;
      }
    }

    if (!rawData?.length) {
      console.warn(`⚠️ OI: no chain data for ${name} ${expiry}`);
      continue;
    }

    // Process if engine available
    let processed = { raw: rawData, expiry, spotPrice, updatedAt: Date.now() };
    if (optionChainEngine?.processOptionChain) {
      try {
        processed = optionChainEngine.processOptionChain(name, expiry, rawData, spotPrice);
      } catch (e) {
        console.warn(`⚠️ OI: processOptionChain failed for ${name}:`, e.message);
      }
    }

    if (!cache[name].chains) cache[name].chains = {};
    cache[name].chains[expiry] = processed;
    cache[name].spotPrice      = spotPrice;
    cache[name].updatedAt      = Date.now();

    if (ioRef) {
      ioRef.emit("option-chain-update", { underlying: name, expiry, data: processed });
    }

    const pcrStr = processed.pcr ? `PCR=${processed.pcr}` : `${rawData.length} strikes`;
    console.log(`📊 OI: ${name} ${expiry} — ${pcrStr} Spot=${spotPrice}`);

    await sleep(800);
  }
}

// ── WebSocket tick handler ────────────────────────────────────────────────────

function handleOITick(instrumentKey, feedData) {
  const mFF = feedData?.marketFF;
  if (!mFF || !ioRef) return;
  ioRef.emit("option-oi-tick", {
    instrKey: instrumentKey,
    oi:       mFF.oi  || 0,
    ltp:      mFF.ltpc?.ltp || 0,
    ts:       Date.now(),
  });
}

// ── Public accessors ──────────────────────────────────────────────────────────

function getExpiries(underlying)      { return cache[underlying]?.expiries || []; }
function getChain(underlying, expiry) { return cache[underlying]?.chains?.[expiry] || null; }
function getAllCached()                { return cache; }

function addUnderlying(name, instrumentKey, nseSymbol) {
  if (activeUnderlyings.find(u => u.key === instrumentKey)) return;
  activeUnderlyings.push({ name, key: instrumentKey, nseSymbol: nseSymbol || name });
  console.log(`➕ OI: added underlying ${name}`);
}

// ── Persist ───────────────────────────────────────────────────────────────────

function persistCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const slim = {};
    for (const [name, data] of Object.entries(cache)) {
      slim[name] = {
        expiries:          data.expiries || [],
        spotPrice:         data.spotPrice || 0,
        updatedAt:         data.updatedAt || 0,
        expiriesFetchedAt: data.expiriesFetchedAt || 0,
        expiriesSource:    data.expiriesSource || null,
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

  setTimeout(() => pollAll(), 5000);
  pollTimer = setInterval(() => pollAll(), 60 * 1000);

  io.on("connection", socket => {
    socket.on("request-option-chain", ({ underlying, expiry }) => {
      const chain = getChain(underlying, expiry);
      if (chain) socket.emit("option-chain-update", { underlying, expiry, data: chain });
      socket.emit("option-expiries", { underlying, expiries: getExpiries(underlying) });
    });

    socket.on("add-oi-underlying", ({ name, instrumentKey, nseSymbol }) => {
      addUnderlying(name, instrumentKey, nseSymbol);
    });

    for (const name of Object.keys(cache)) {
      socket.emit("option-expiries", { underlying: name, expiries: getExpiries(name) });
    }
  });
}

function stopNSEOIListener() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  startNSEOIListener,
  stopNSEOIListener,
  handleOITick,
  getExpiries,
  getChain,
  getAllCached,
  addUnderlying,
};