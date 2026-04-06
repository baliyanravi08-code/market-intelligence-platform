"use strict";

/**
 * nseOIListener.js
 * Polls Upstox /v2/option/chain every 60s for full OI snapshots.
 * Place at: server/services/intelligence/nseOIListener.js
 *
 * FIXED 06 Apr 2026:
 * - Upstox changed expiry endpoint: /v2/option/chain/expiry-dates → /v2/option/chain/instruments
 * - fetchExpiries now uses correct endpoint
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

const cache = {};

const DEFAULT_UNDERLYINGS = [
  { name: "NIFTY",     key: "NSE_INDEX|Nifty 50" },
  { name: "BANKNIFTY", key: "NSE_INDEX|Nifty Bank" },
];

const activeUnderlyings = [...DEFAULT_UNDERLYINGS];

function getAuthHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
  };
}

// ── FIXED: correct Upstox expiry endpoint ────────────────────────────────────
async function fetchExpiries(underlying, token) {
  // Try the correct v2 instruments endpoint first
  const endpoints = [
    {
      url: "https://api.upstox.com/v2/option/chain/instruments",
      params: { instrument_key: underlying },
    },
    // Fallback: some versions use /expiry-dates with instrument_key
    {
      url: "https://api.upstox.com/v2/option/chain/expiry-dates",
      params: { instrument_key: underlying },
    },
  ];

  for (const ep of endpoints) {
    try {
      const res = await axios.get(ep.url, {
        params:  ep.params,
        headers: getAuthHeaders(token),
        timeout: 10000,
      });

      // instruments endpoint returns { data: { expiry_dates: [...] } }
      // expiry-dates endpoint returns { data: [...] }
      const d = res.data?.data;
      if (!d) continue;

      const expiries = Array.isArray(d) ? d : (d.expiry_dates || []);
      if (expiries.length > 0) {
        return expiries;
      }
    } catch (e) {
      console.warn(`⚠️ OI: expiry fetch failed for ${underlying} via ${ep.url}:`, e.message);
    }
  }

  // Last resort: try fetching the option chain directly without expiry
  // and extract expiry dates from the response
  try {
    const res = await axios.get("https://api.upstox.com/v2/option/chain", {
      params:  { instrument_key: underlying },
      headers: getAuthHeaders(token),
      timeout: 12000,
    });
    const data = res.data?.data;
    if (Array.isArray(data) && data.length > 0) {
      // Extract unique expiry dates from strike data
      const expiries = [...new Set(data.map(s => s.expiry).filter(Boolean))].sort();
      if (expiries.length > 0) {
        console.log(`📊 OI: extracted ${expiries.length} expiries from chain for ${underlying}`);
        return expiries;
      }
    }
  } catch (e) {
    console.warn(`⚠️ OI: chain-based expiry extraction also failed for ${underlying}:`, e.message);
  }

  return [];
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

function checkMarketOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = h * 60 + m;
  return mins >= 555 && mins <= 930;
}

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
      await sleep(1500);
    } catch (e) {
      console.warn(`⚠️ OI: poll failed for ${u.name}:`, e.message);
    }
  }

  persistCache();
}

async function pollUnderlying({ name, key }, token) {
  let expiries = cache[name]?.expiries;
  const expiryCacheAge = cache[name]?.expiriesFetchedAt || 0;

  if (!expiries || Date.now() - expiryCacheAge > 60 * 60 * 1000) {
    expiries = await fetchExpiries(key, token);
    if (!expiries.length) return;

    if (!cache[name]) cache[name] = {};
    cache[name].expiries          = expiries;
    cache[name].expiriesFetchedAt = Date.now();
  }

  const nearExpiries = expiries.slice(0, 2);

  for (const expiry of nearExpiries) {
    const rawStrikes = await fetchOptionChain(key, expiry, token);
    if (!rawStrikes || !rawStrikes.length) continue;

    const spotPrice = rawStrikes[0]?.underlying_spot_price || 0;
    const processed = processOptionChain(name, expiry, rawStrikes, spotPrice);

    if (!cache[name].chains) cache[name].chains = {};
    cache[name].chains[expiry] = processed;
    cache[name].spotPrice      = spotPrice;
    cache[name].updatedAt      = Date.now();

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

function handleOITick(instrumentKey, feedData) {
  const mFF = feedData?.marketFF;
  if (!mFF) return;
  const liveOI  = mFF.oi  || 0;
  const liveLTP = mFF.ltpc?.ltp || 0;
  if (ioRef) {
    ioRef.emit("option-oi-tick", {
      instrKey: instrumentKey,
      oi:       liveOI,
      ltp:      liveLTP,
      ts:       Date.now(),
    });
  }
}

function getExpiries(underlying)       { return cache[underlying]?.expiries || []; }
function getChain(underlying, expiry)  { return cache[underlying]?.chains?.[expiry] || null; }
function getAllCached()                 { return cache; }

function addUnderlying(name, instrumentKey) {
  if (activeUnderlyings.find(u => u.key === instrumentKey)) return;
  activeUnderlyings.push({ name, key: instrumentKey });
  console.log(`➕ OI: added underlying ${name}`);
}

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

function startNSEOIListener(io, tGetter) {
  ioRef       = io;
  tokenGetter = tGetter;

  console.log("🔭 NSE OI Listener starting...");

  setTimeout(() => pollAll(), 5000);
  pollTimer = setInterval(() => pollAll(), 60 * 1000);

  io.on("connection", socket => {
    socket.on("request-option-chain", ({ underlying, expiry }) => {
      const chain = getChain(underlying, expiry);
      if (chain) {
        socket.emit("option-chain-update", { underlying, expiry, data: chain });
      }
      socket.emit("option-expiries", {
        underlying,
        expiries: getExpiries(underlying),
      });
    });

    socket.on("add-oi-underlying", ({ name, instrumentKey }) => {
      addUnderlying(name, instrumentKey);
    });

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