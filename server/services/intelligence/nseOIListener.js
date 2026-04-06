"use strict";

/**
 * nseOIListener.js
 * Place at: server/services/intelligence/nseOIListener.js
 *
 * REWRITTEN 07 Apr 2026 — Session 4:
 * - Switched from NSE direct API (blocked on Render) to Upstox /v2/option/chain
 * - Expiries fetched from Upstox /v2/option/contract (live, always correct)
 * - Works on Render, works on weekends (no market-hours gate on expiry fetch)
 * - Processes: PCR, max pain, support/resistance, OI signals, IV
 * - Emits: option-chain-update, option-expiries, option-oi-tick
 * - Replays cached data to newly connected clients immediately
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const CACHE_FILE = path.join(__dirname, "../../data/optionChainCache.json");

let ioRef       = null;
let tokenGetter = null;
let pollTimer   = null;
let expiryTimer = null;
let disabled    = false;
let failCount   = 0;

const MAX_FAILS          = 5;
const POLL_INTERVAL_MS   = 60_000;       // chain poll every 60s
const EXPIRY_REFRESH_MS  = 4 * 60 * 60 * 1000; // expiry list refresh every 4h

// In-memory store: { NIFTY: { expiries:[], chains:{}, spotPrice:0, updatedAt:0 } }
const cache = {};

const UNDERLYINGS = [
  { name: "NIFTY",     upstoxKey: "NSE_INDEX|Nifty 50"  },
  { name: "BANKNIFTY", upstoxKey: "NSE_INDEX|Nifty Bank" },
];

// ── Auth header ───────────────────────────────────────────────────────────────
function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// ── Fetch all expiry dates for an underlying from Upstox contracts ────────────
async function fetchExpiries(upstoxKey, token) {
  const res = await axios.get(
    "https://api.upstox.com/v2/option/contract",
    {
      params:  { instrument_key: upstoxKey },
      headers: authHeaders(token),
      timeout: 15_000,
    }
  );
  const contracts = res.data?.data || [];
  const dates = [...new Set(contracts.map(c => c.expiry))].sort();
  return dates; // ["2026-04-07","2026-04-13", ...]
}

// ── Fetch option chain for one underlying + expiry ────────────────────────────
async function fetchChain(upstoxKey, expiry, token) {
  const res = await axios.get(
    "https://api.upstox.com/v2/option/chain",
    {
      params:  { instrument_key: upstoxKey, expiry_date: expiry },
      headers: authHeaders(token),
      timeout: 15_000,
    }
  );
  return res.data?.data || []; // array of strike objects
}

// ── Process raw Upstox chain into structured format ───────────────────────────
function processChain(name, expiry, rawStrikes, spotPrice) {
  if (!rawStrikes.length) return null;

  // Sort strikes ascending
  const sorted = [...rawStrikes].sort((a, b) => a.strike_price - b.strike_price);

  let totalCEOI = 0, totalPEOI = 0;
  let maxCEOI = 0, maxPEOI = 0;
  let maxCEStrike = 0, maxPEStrike = 0;

  // First pass — totals + max OI strikes (for support/resistance)
  for (const s of sorted) {
    const ceOI = s.call_options?.market_data?.oi || 0;
    const peOI = s.put_options?.market_data?.oi  || 0;
    totalCEOI += ceOI;
    totalPEOI += peOI;
    if (ceOI > maxCEOI) { maxCEOI = ceOI; maxCEStrike = s.strike_price; }
    if (peOI > maxPEOI) { maxPEOI = peOI; maxPEStrike = s.strike_price; }
  }

  const pcr = totalCEOI > 0 ? +(totalPEOI / totalCEOI).toFixed(3) : 0;

  // Max pain — strike where combined option buyers lose the most
  let maxPainStrike = 0;
  let minPain = Infinity;
  for (const target of sorted) {
    let pain = 0;
    for (const s of sorted) {
      const ceOI = s.call_options?.market_data?.oi || 0;
      const peOI = s.put_options?.market_data?.oi  || 0;
      if (s.strike_price < target.strike_price) pain += ceOI * (target.strike_price - s.strike_price);
      if (s.strike_price > target.strike_price) pain += peOI * (s.strike_price - target.strike_price);
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = target.strike_price; }
  }

  // ATM strike — closest to spot
  const atmStrike = sorted.reduce((best, s) =>
    Math.abs(s.strike_price - spotPrice) < Math.abs(best - spotPrice)
      ? s.strike_price : best,
    sorted[0]?.strike_price || 0
  );

  // Support = highest PE OI strike below spot
  // Resistance = highest CE OI strike above spot
  const below = sorted.filter(s => s.strike_price <= spotPrice);
  const above = sorted.filter(s => s.strike_price >= spotPrice);

  const support = below.length
    ? below.reduce((best, s) =>
        (s.put_options?.market_data?.oi || 0) > (best.put_options?.market_data?.oi || 0) ? s : best
      ).strike_price
    : 0;

  const resistance = above.length
    ? above.reduce((best, s) =>
        (s.call_options?.market_data?.oi || 0) > (best.call_options?.market_data?.oi || 0) ? s : best
      ).strike_price
    : 0;

  // Build strikes array for UI
  const strikes = sorted.map(s => {
    const ceData = s.call_options?.market_data   || {};
    const peData = s.put_options?.market_data    || {};
    const ceGreeks = s.call_options?.option_greeks || {};
    const peGreeks = s.put_options?.option_greeks  || {};

    const ceOI       = ceData.oi       || 0;
    const peOI       = peData.oi       || 0;
    const cePrevOI   = ceData.prev_oi  || 0;
    const pePrevOI   = peData.prev_oi  || 0;
    const ceOIChange = ceOI - cePrevOI;
    const peOIChange = peOI - pePrevOI;

    return {
      strike:  s.strike_price,
      isATM:   s.strike_price === atmStrike,
      ce: {
        instrumentKey: s.call_options?.instrument_key || "",
        ltp:      ceData.ltp        || 0,
        oi:       ceOI,
        oiChange: ceOIChange,
        prevOI:   cePrevOI,
        volume:   ceData.volume     || 0,
        iv:       ceGreeks.iv       || 0,
        delta:    ceGreeks.delta    || 0,
        theta:    ceGreeks.theta    || 0,
        vega:     ceGreeks.vega     || 0,
        bid:      ceData.bid_price  || 0,
        ask:      ceData.ask_price  || 0,
        signal:   getSignal(ceOI, cePrevOI, ceData.ltp, ceData.close_price),
      },
      pe: {
        instrumentKey: s.put_options?.instrument_key || "",
        ltp:      peData.ltp        || 0,
        oi:       peOI,
        oiChange: peOIChange,
        prevOI:   pePrevOI,
        volume:   peData.volume     || 0,
        iv:       peGreeks.iv       || 0,
        delta:    peGreeks.delta    || 0,
        theta:    peGreeks.theta    || 0,
        vega:     peGreeks.vega     || 0,
        bid:      peData.bid_price  || 0,
        ask:      peData.ask_price  || 0,
        signal:   getSignal(peOI, pePrevOI, peData.ltp, peData.close_price),
      },
    };
  });

  // Alerts — strikes with significant OI build-up near ATM
  const alerts = strikes
    .filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.05) // within 5% of spot
    .filter(s => s.ce.signal !== "neutral" || s.pe.signal !== "neutral")
    .map(s => ({
      strike: s.strike,
      side:   s.ce.oiChange > s.pe.oiChange ? "CE" : "PE",
      signal: s.ce.oiChange > s.pe.oiChange ? s.ce.signal : s.pe.signal,
      pct:    s.isATM ? "ATM" : ((s.strike - spotPrice) / spotPrice * 100).toFixed(1) + "%",
    }))
    .slice(0, 10);

  return {
    underlying:    name,
    expiry,
    spotPrice,
    pcr,
    maxPainStrike,
    support,
    resistance,
    totalCEOI,
    totalPEOI,
    atmStrike,
    strikes,
    alerts,
    updatedAt: Date.now(),
  };
}

// ── OI signal detection ───────────────────────────────────────────────────────
function getSignal(oi, prevOI, ltp, closePrc) {
  const oiUp    = oi > prevOI * 1.02;   // OI up >2%
  const oiDown  = oi < prevOI * 0.98;   // OI down >2%
  const priceUp = ltp > (closePrc || ltp) * 1.001;
  const priceDn = ltp < (closePrc || ltp) * 0.999;

  if (oiUp   && priceUp) return "long_buildup";
  if (oiUp   && priceDn) return "short_buildup";
  if (oiDown && priceUp) return "short_covering";
  if (oiDown && priceDn) return "long_unwinding";
  return "neutral";
}

// ── Refresh expiry lists for all underlyings ──────────────────────────────────
async function refreshExpiries(token) {
  for (const u of UNDERLYINGS) {
    try {
      const expiries = await fetchExpiries(u.upstoxKey, token);
      if (!cache[u.name]) cache[u.name] = { expiries: [], chains: {}, spotPrice: 0, updatedAt: 0 };
      cache[u.name].expiries = expiries;
      console.log(`📅 OI: ${u.name} expiries — ${expiries.slice(0, 4).join(", ")}`);
      if (ioRef) ioRef.emit("option-expiries", { underlying: u.name, expiries });
    } catch (e) {
      console.warn(`⚠️ OI: could not fetch expiries for ${u.name}:`, e.message);
    }
    await sleep(1000);
  }
}

// ── Poll chains for nearest 2 expiries of each underlying ────────────────────
async function pollChains() {
  if (disabled) return;

  const token = tokenGetter?.();
  if (!token) return;

  let anySuccess = false;

  for (const u of UNDERLYINGS) {
    const expiries = cache[u.name]?.expiries || [];
    if (!expiries.length) {
      console.warn(`⚠️ OI: no expiries for ${u.name} — skipping`);
      continue;
    }

    // Poll nearest 2 expiries
    for (const expiry of expiries.slice(0, 2)) {
      try {
        const raw = await fetchChain(u.upstoxKey, expiry, token);
        if (!raw.length) continue;

        const spotPrice = raw[0]?.underlying_spot_price || cache[u.name]?.spotPrice || 0;
        const processed = processChain(u.name, expiry, raw, spotPrice);
        if (!processed) continue;

        if (!cache[u.name]) cache[u.name] = { expiries: [], chains: {}, spotPrice: 0, updatedAt: 0 };
        cache[u.name].chains[expiry] = processed;
        cache[u.name].spotPrice      = spotPrice;
        cache[u.name].updatedAt      = Date.now();

        if (ioRef) {
          ioRef.emit("option-chain-update", { underlying: u.name, expiry, data: processed });
        }

        console.log(`📊 OI: ${u.name} ${expiry} — PCR=${processed.pcr} Spot=₹${spotPrice} Strikes=${raw.length}`);
        anySuccess = true;

        await sleep(1500);
      } catch (e) {
        console.warn(`⚠️ OI: chain fetch failed ${u.name} ${expiry}:`, e.response?.data?.errors?.[0]?.message || e.message);
      }
    }
  }

  if (anySuccess) {
    failCount = 0;
    persistCache();
  } else {
    failCount++;
    if (failCount >= MAX_FAILS) {
      disabled = true;
      console.warn(`⚠️ OI: disabled after ${MAX_FAILS} consecutive failures`);
    }
  }
}

// ── WebSocket OI tick handler (from upstoxStream.js) ─────────────────────────
function handleOITick(instrumentKey, feedData) {
  const mFF = feedData?.marketFF;
  if (!mFF || !ioRef) return;
  ioRef.emit("option-oi-tick", {
    instrKey: instrumentKey,
    oi:       mFF.oi   || 0,
    ltp:      mFF.ltpc?.ltp || 0,
    ts:       Date.now(),
  });
}

// ── Public accessors ──────────────────────────────────────────────────────────
function getExpiries(underlying)       { return cache[underlying]?.expiries || []; }
function getChain(underlying, expiry)  { return cache[underlying]?.chains?.[expiry] || null; }
function getAllCached()                 { return cache; }

function addUnderlying(name, instrumentKey) {
  if (UNDERLYINGS.find(u => u.upstoxKey === instrumentKey)) return;
  UNDERLYINGS.push({ name, upstoxKey: instrumentKey });
  console.log(`➕ OI: added underlying ${name}`);
}

// ── Persist slim cache to disk ────────────────────────────────────────────────
function persistCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const slim = {};
    for (const [name, data] of Object.entries(cache)) {
      slim[name] = {
        expiries:  data.expiries  || [],
        spotPrice: data.spotPrice || 0,
        updatedAt: data.updatedAt || 0,
        chains: Object.entries(data.chains || {}).reduce((acc, [exp, chain]) => {
          acc[exp] = {
            pcr:           chain.pcr,
            maxPainStrike: chain.maxPainStrike,
            support:       chain.support,
            resistance:    chain.resistance,
            totalCEOI:     chain.totalCEOI,
            totalPEOI:     chain.totalPEOI,
            atmStrike:     chain.atmStrike,
            spotPrice:     chain.spotPrice,
            updatedAt:     chain.updatedAt,
            // store strikes for replay — slim down greeks to save space
            strikes: (chain.strikes || []).map(s => ({
              strike: s.strike, isATM: s.isATM,
              ce: { ltp: s.ce.ltp, oi: s.ce.oi, oiChange: s.ce.oiChange, volume: s.ce.volume, iv: s.ce.iv, signal: s.ce.signal, instrumentKey: s.ce.instrumentKey },
              pe: { ltp: s.pe.ltp, oi: s.pe.oi, oiChange: s.pe.oiChange, volume: s.pe.volume, iv: s.pe.iv, signal: s.pe.signal, instrumentKey: s.pe.instrumentKey },
            })),
            alerts: chain.alerts || [],
          };
          return acc;
        }, {}),
      };
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(slim), "utf8");
  } catch (e) {
    console.warn("⚠️ OI cache persist failed:", e.message);
  }
}

// ── Load cache from disk on startup ──────────────────────────────────────────
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw    = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    for (const [name, data] of Object.entries(parsed)) {
      cache[name] = {
        expiries:  data.expiries  || [],
        spotPrice: data.spotPrice || 0,
        updatedAt: data.updatedAt || 0,
        chains:    data.chains    || {},
      };
    }
    console.log(`📦 OI cache loaded: ${Object.keys(cache).join(", ")}`);
  } catch (e) {
    console.warn("⚠️ OI cache load failed:", e.message);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startNSEOIListener(io, tGetter) {
  ioRef       = io;
  tokenGetter = tGetter;

  console.log("🔭 NSE OI Listener starting (Upstox source)...");

  loadCache();

  // Replay cached data + handle live requests from clients
  io.on("connection", socket => {
    // Replay all cached chains to new client
    for (const [name, data] of Object.entries(cache)) {
      if (data.expiries?.length) {
        socket.emit("option-expiries", { underlying: name, expiries: data.expiries });
      }
      for (const [expiry, chain] of Object.entries(data.chains || {})) {
        socket.emit("option-chain-update", { underlying: name, expiry, data: chain });
      }
    }

    socket.on("request-option-chain", ({ underlying, expiry }) => {
      const chain = getChain(underlying, expiry);
      if (chain) socket.emit("option-chain-update", { underlying, expiry, data: chain });
      socket.emit("option-expiries", { underlying, expiries: getExpiries(underlying) });
    });

    socket.on("add-oi-underlying", ({ name, upstoxKey }) => {
      addUnderlying(name, upstoxKey);
    });
  });

  // Fetch expiries immediately, then every 4h
  const runExpiries = async () => {
    const token = tokenGetter?.();
    if (token) await refreshExpiries(token);
  };

  // First expiry fetch after 3s, then poll chains after 8s
  setTimeout(async () => {
    await runExpiries();
    // Start chain polling after expiries are loaded
    setTimeout(() => pollChains(), 5000);
    pollTimer  = setInterval(() => pollChains(),   POLL_INTERVAL_MS);
    expiryTimer = setInterval(() => runExpiries(), EXPIRY_REFRESH_MS);
  }, 3000);
}

function stopNSEOIListener() {
  if (pollTimer)   { clearInterval(pollTimer);   pollTimer   = null; }
  if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; }
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