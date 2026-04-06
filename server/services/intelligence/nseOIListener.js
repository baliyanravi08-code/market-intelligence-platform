"use strict";

/**
 * nseOIListener.js
 * Place at: server/services/intelligence/nseOIListener.js
 *
 * FIXED 06 Apr 2026:
 * - Upstox /v2/option/chain needs paid F&O subscription scope → not available
 * - NSE direct API blocked on Render cloud IP → not available
 * - NEW APPROACH: Use Upstox /v2/market-quote/quotes for index spot prices
 *   + fetch option chain from NSE via a public CORS proxy as fallback
 * - If both fail, OI listener silently disables itself (no crashes, no spam)
 * - When market is closed (weekends/after hours), skips polling entirely
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

let optionChainEngine = null;
try {
  optionChainEngine = require("./optionChainEngine");
} catch (e) {
  // optionChainEngine is optional
}

const CACHE_FILE = path.join(__dirname, "../../data/optionChainCache.json");

let ioRef        = null;
let tokenGetter  = null;
let pollTimer    = null;
let disabled     = false; // set true if all sources fail repeatedly
let failCount    = 0;
const MAX_FAILS  = 5; // disable after 5 consecutive total failures

const cache = {};

const DEFAULT_UNDERLYINGS = [
  { name: "NIFTY",     upstoxKey: "NSE_INDEX|Nifty 50",  nseSymbol: "NIFTY"     },
  { name: "BANKNIFTY", upstoxKey: "NSE_INDEX|Nifty Bank", nseSymbol: "BANKNIFTY" },
];

const activeUnderlyings = [...DEFAULT_UNDERLYINGS];

function getAuthHeaders(token) {
  return { "Authorization": `Bearer ${token}`, "Accept": "application/json" };
}

function checkMarketOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = h * 60 + m;
  return mins >= 555 && mins <= 930; // 9:15–15:30
}

// ── Spot price from Upstox market quote (works with standard token) ───────────
async function fetchSpotPrice(upstoxKey, token) {
  try {
    const res = await axios.get(
      "https://api.upstox.com/v2/market-quote/quotes",
      {
        params:  { instrument_key: upstoxKey },
        headers: getAuthHeaders(token),
        timeout: 8000,
      }
    );
    const quote = res.data?.data?.[upstoxKey] || res.data?.data?.[upstoxKey.replace("|", ":")];
    return quote?.last_price || quote?.ohlc?.close || 0;
  } catch (e) {
    return 0;
  }
}

// ── Option chain from NSE via AllOrigins CORS proxy ───────────────────────────
// AllOrigins proxies any public URL — works from Render cloud IPs
async function fetchChainViaCorsProxy(nseSymbol) {
  const nseUrl = `https://www.nseindia.com/api/option-chain-indices?symbol=${nseSymbol}`;
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(nseUrl)}`;

  const res = await axios.get(proxyUrl, {
    timeout: 15000,
    headers: { "Accept": "application/json" },
  });

  const contents = res.data?.contents;
  if (!contents) throw new Error("No contents from allorigins proxy");

  const parsed = JSON.parse(contents);
  const records = parsed?.records;
  if (!records?.data?.length) throw new Error("No option chain data in proxy response");

  return {
    data:       records.data,
    expiries:   records.expiryDates || [],
    spotPrice:  records.underlyingValue || 0,
  };
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function pollAll() {
  if (disabled) return;
  if (!checkMarketOpen()) return; // skip outside market hours entirely

  const token = tokenGetter?.();
  if (!token) return;

  let anySuccess = false;

  for (const u of activeUnderlyings) {
    try {
      const success = await pollUnderlying(u, token);
      if (success) anySuccess = true;
      await sleep(1500);
    } catch (e) {
      console.warn(`⚠️ OI: poll error for ${u.name}:`, e.message);
    }
  }

  if (anySuccess) {
    failCount = 0;
    persistCache();
  } else {
    failCount++;
    if (failCount >= MAX_FAILS) {
      disabled = true;
      console.warn(`⚠️ OI: disabled after ${MAX_FAILS} consecutive failures — option chain unavailable on this deployment`);
    }
  }
}

async function pollUnderlying(underlying, token) {
  const { name, upstoxKey, nseSymbol } = underlying;

  // Get spot price from Upstox (works with standard token)
  const spotPrice = await fetchSpotPrice(upstoxKey, token);

  // Get option chain via CORS proxy → NSE
  let chainData = null;
  let expiries  = [];

  try {
    const result = await fetchChainViaCorsProxy(nseSymbol);
    chainData = result.data;
    expiries  = result.expiries;
    const spot = result.spotPrice || spotPrice;

    // Update cache
    if (!cache[name]) cache[name] = {};
    cache[name].expiries          = expiries;
    cache[name].expiriesFetchedAt = Date.now();
    cache[name].spotPrice         = spot;
    cache[name].updatedAt         = Date.now();

    // Process nearest 2 expiries
    const nearExpiries = expiries.slice(0, 2);
    if (!cache[name].chains) cache[name].chains = {};

    for (const expiry of nearExpiries) {
      const strikes = chainData.filter(r => r.expiryDate === expiry);
      if (!strikes.length) continue;

      let processed = { raw: strikes, expiry, spotPrice: spot, updatedAt: Date.now() };
      if (optionChainEngine?.processOptionChain) {
        try {
          processed = optionChainEngine.processOptionChain(name, expiry, strikes, spot);
        } catch (e) { /* use raw */ }
      }

      cache[name].chains[expiry] = processed;

      if (ioRef) {
        ioRef.emit("option-chain-update", { underlying: name, expiry, data: processed });
      }

      const pcrStr = processed.pcr != null ? `PCR=${processed.pcr}` : `${strikes.length} strikes`;
      console.log(`📊 OI: ${name} ${expiry} — ${pcrStr} Spot=₹${spot}`);
    }

    return true;
  } catch (e) {
    // Proxy failed — still emit spot price update if we have it
    if (spotPrice > 0) {
      if (!cache[name]) cache[name] = {};
      cache[name].spotPrice  = spotPrice;
      cache[name].updatedAt  = Date.now();
      if (ioRef) {
        ioRef.emit("option-spot-update", { underlying: name, spotPrice });
      }
    }
    return false;
  }
}

// ── WebSocket tick handler (called from upstoxStream.js) ─────────────────────
function handleOITick(instrumentKey, feedData) {
  const mFF = feedData?.marketFF;
  if (!mFF || !ioRef) return;
  ioRef.emit("option-oi-tick", {
    instrKey: instrumentKey,
    oi:       mFF.oi || 0,
    ltp:      mFF.ltpc?.ltp || 0,
    ts:       Date.now(),
  });
}

// ── Public accessors ──────────────────────────────────────────────────────────
function getExpiries(underlying)      { return cache[underlying]?.expiries || []; }
function getChain(underlying, expiry) { return cache[underlying]?.chains?.[expiry] || null; }
function getAllCached()                { return cache; }

function addUnderlying(name, upstoxKey, nseSymbol) {
  if (activeUnderlyings.find(u => u.upstoxKey === upstoxKey)) return;
  activeUnderlyings.push({ name, upstoxKey, nseSymbol: nseSymbol || name });
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

  // First poll after 8s
  setTimeout(() => pollAll(), 8000);
  pollTimer = setInterval(() => pollAll(), 60 * 1000);

  io.on("connection", socket => {
    socket.on("request-option-chain", ({ underlying, expiry }) => {
      const chain = getChain(underlying, expiry);
      if (chain) socket.emit("option-chain-update", { underlying, expiry, data: chain });
      socket.emit("option-expiries", { underlying, expiries: getExpiries(underlying) });
    });

    socket.on("add-oi-underlying", ({ name, upstoxKey, nseSymbol }) => {
      addUnderlying(name, upstoxKey, nseSymbol);
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