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
 *
 * UPDATED: 09 Apr 2026 — Session 6:
 * - Wired ingestChainData from optionsIntegration after each successful chain poll
 * - Feeds Options Intelligence Engine with live chain data automatically
 *
 * UPDATED: 10 Apr 2026 — Session 7:
 * - Two-tier unusual OI detection in processChain():
 *     Tier 1 (nearATM)  — strikes within ±8% of spot with high OI + volume spike
 *     Tier 2 (tailRisk) — far-OTM strikes with OI anomalous vs adjacent strikes
 *   Tier 2 uses relative OI (vs neighbors), not absolute threshold, so deep OTM
 *   strikes are only flagged when they genuinely stand out — not just because
 *   put writers have been accumulating all series.
 *   Both tiers are emitted separately so the frontend can render them with
 *   appropriate context labels.
 *
 * FIX: 11 Apr 2026 — Session 8:
 * - ingestChainData() was being called with a single object argument instead of
 *   5 positional arguments. optionsIntegration expects:
 *     ingestChainData(symbol, spotPrice, chainData, expiryDate, lotSize)
 *   Previously called as:
 *     ingestChainData({ symbol, spotPrice, expiryDate, lotSize, chain })
 *   This meant symbol=whole object, spotPrice=undefined, chainData=undefined —
 *   so GEX / IV / PCR / OI fields were always 0 / "—" in the dashboard.
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

// ── Options Intelligence Engine integration ───────────────────────────────────
const { ingestChainData } = require("./optionsIntegration");

const CACHE_FILE = path.join(__dirname, "../../data/optionChainCache.json");

let ioRef       = null;
let tokenGetter = null;
let pollTimer   = null;
let expiryTimer = null;
let disabled    = false;
let failCount   = 0;

const MAX_FAILS          = 5;
const POLL_INTERVAL_MS   = 60_000;
const EXPIRY_REFRESH_MS  = 4 * 60 * 60 * 1000;

const cache = {};

const UNDERLYINGS = [
  { name: "NIFTY",     upstoxKey: "NSE_INDEX|Nifty 50",   lotSize: 75 },
  { name: "BANKNIFTY", upstoxKey: "NSE_INDEX|Nifty Bank",  lotSize: 35 },
];

// ── Auth header ───────────────────────────────────────────────────────────────
function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// ── Fetch all expiry dates ────────────────────────────────────────────────────
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
  return dates;
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
  return res.data?.data || [];
}

// ── Two-tier unusual OI detection ─────────────────────────────────────────────
/**
 * Tier 1 — Near ATM (within nearPct% of spot):
 *   Flag if OI > oiThreshold AND (volume > volThreshold OR oiChange > oiChangePct%).
 *   These are actionable support/resistance levels.
 *
 * Tier 2 — Far OTM (beyond nearPct% of spot):
 *   Flag only if OI is anomalous RELATIVE TO ADJACENT STRIKES.
 *   Method: compare each strike's OI to the median OI of its ±3 neighbours.
 *   If ratio > neighborMultiple AND absolute OI > minAbsOI, it's unusual.
 *   This avoids flagging slow-accumulating OI that's just "been there all series".
 *   Practical meaning: someone is actively building a position at this strike
 *   beyond what the surrounding chain looks like — institutional hedge / tail risk.
 *
 * Returns { nearATM: [], tailRisk: [] }
 */
function detectUnusualOI(strikes, spotPrice, symbol) {
  if (!strikes?.length || !spotPrice) return { nearATM: [], tailRisk: [] };

  const isBankNifty = (symbol || "").toUpperCase().includes("BANK");

  // Config — slightly wider bounds for BANKNIFTY which is more volatile
  const nearPct         = isBankNifty ? 0.10 : 0.08;   // ±8% near ATM, ±10% for BN
  const oiThreshold     = isBankNifty ? 50_000 : 30_000; // min OI to be "notable"
  const volThreshold    = isBankNifty ? 20_000 : 10_000;
  const oiChangePct     = 0.15;  // 15% OI change = notable movement
  const neighborWindow  = 3;     // look at ±3 strikes for relative comparison
  const neighborMultiple = 3.5;  // OI must be 3.5× neighbor median to be unusual
  const minAbsOI        = isBankNifty ? 100_000 : 50_000; // min absolute OI for far-OTM flag

  const lo = spotPrice * (1 - nearPct);
  const hi = spotPrice * (1 + nearPct);

  const nearATM  = [];
  const tailRisk = [];

  // Pre-compute per-strike combined OI for neighbour comparison
  const oiByIndex = strikes.map(s => (s.ce?.oi || 0) + (s.pe?.oi || 0));

  for (let i = 0; i < strikes.length; i++) {
    const s      = strikes[i];
    const strike = s.strike;
    const ceOI   = s.ce?.oi       || 0;
    const peOI   = s.pe?.oi       || 0;
    const ceVol  = s.ce?.volume   || 0;
    const peVol  = s.pe?.volume   || 0;
    const ceChg  = s.ce?.oiChange || 0;
    const peChg  = s.pe?.oiChange || 0;

    const isCall  = ceOI > peOI;
    const side    = isCall ? "CALL" : "PUT";
    const oi      = isCall ? ceOI  : peOI;
    const vol     = isCall ? ceVol : peVol;
    const oiChg   = isCall ? ceChg : peChg;
    const ltp     = isCall ? (s.ce?.ltp || 0) : (s.pe?.ltp || 0);
    const iv      = isCall ? (s.ce?.iv  || 0) : (s.pe?.iv  || 0);
    const prevOI  = oi - oiChg;
    const oiChgPct = prevOI > 0 ? Math.abs(oiChg / prevOI) : 0;

    if (strike >= lo && strike <= hi) {
      // ── Tier 1: Near ATM ──────────────────────────────────────────────────
      if (oi >= oiThreshold && (vol >= volThreshold || oiChgPct >= oiChangePct)) {
        nearATM.push({
          strike,
          type:     side,
          oi,
          vol,
          oiChange: oiChg,
          oiChgPct: +(oiChgPct * 100).toFixed(1),
          ltp,
          iv:       +(iv * 100).toFixed(2), // normalise to %
          distPct:  +((strike - spotPrice) / spotPrice * 100).toFixed(1),
          tier:     "nearATM",
        });
      }
    } else {
      // ── Tier 2: Far OTM — relative-to-neighbors test ─────────────────────
      if (oi < minAbsOI) continue; // skip tiny absolute OI regardless

      // Gather neighbour OIs (±neighborWindow strikes, excluding self)
      const start       = Math.max(0, i - neighborWindow);
      const end         = Math.min(strikes.length - 1, i + neighborWindow);
      const neighborOIs = [];
      for (let j = start; j <= end; j++) {
        if (j !== i) neighborOIs.push(oiByIndex[j]);
      }
      if (!neighborOIs.length) continue;

      // Median of neighbours
      neighborOIs.sort((a, b) => a - b);
      const mid      = Math.floor(neighborOIs.length / 2);
      const medianOI = neighborOIs.length % 2 === 0
        ? (neighborOIs[mid - 1] + neighborOIs[mid]) / 2
        : neighborOIs[mid];

      if (medianOI <= 0) continue;

      const ratio = oi / medianOI;
      if (ratio < neighborMultiple) continue; // not anomalous enough

      // Classify what this likely means
      const distPct = (strike - spotPrice) / spotPrice * 100;
      let interpretation;
      if (side === "PUT" && distPct < -8) {
        interpretation = oiChgPct > 0.10 ? "Active crash hedge building" : "Tail risk hedge / put wall";
      } else if (side === "CALL" && distPct > 8) {
        interpretation = oiChgPct > 0.10 ? "Aggressive call writing" : "Supply wall / covered calls";
      } else {
        interpretation = "Unusual positioning";
      }

      tailRisk.push({
        strike,
        type:     side,
        oi,
        vol,
        oiChange:         oiChg,
        oiChgPct:         +(oiChgPct * 100).toFixed(1),
        neighborMedianOI: Math.round(medianOI),
        neighborRatio:    +ratio.toFixed(1),
        ltp,
        iv:       +(iv * 100).toFixed(2),
        distPct:  +distPct.toFixed(1),
        interpretation,
        tier: "tailRisk",
      });
    }
  }

  // Sort: near ATM by absolute OI desc, tail risk by neighbor ratio desc
  nearATM.sort((a, b)  => b.oi - a.oi);
  tailRisk.sort((a, b) => b.neighborRatio - a.neighborRatio);

  return {
    nearATM:  nearATM.slice(0, 6),
    tailRisk: tailRisk.slice(0, 4),
  };
}

// ── Process raw Upstox chain into structured format ───────────────────────────
function processChain(name, expiry, rawStrikes, spotPrice) {
  if (!rawStrikes.length) return null;

  const sorted = [...rawStrikes].sort((a, b) => a.strike_price - b.strike_price);

  let totalCEOI = 0, totalPEOI = 0;
  let maxCEOI = 0, maxPEOI = 0;
  let maxCEStrike = 0, maxPEStrike = 0;

  for (const s of sorted) {
    const ceOI = s.call_options?.market_data?.oi || 0;
    const peOI = s.put_options?.market_data?.oi  || 0;
    totalCEOI += ceOI;
    totalPEOI += peOI;
    if (ceOI > maxCEOI) { maxCEOI = ceOI; maxCEStrike = s.strike_price; }
    if (peOI > maxPEOI) { maxPEOI = peOI; maxPEStrike = s.strike_price; }
  }

  const pcr = totalCEOI > 0 ? +(totalPEOI / totalCEOI).toFixed(3) : 0;

  // Max pain
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

  // ATM strike
  const atmStrike = sorted.reduce((best, s) =>
    Math.abs(s.strike_price - spotPrice) < Math.abs(best - spotPrice)
      ? s.strike_price : best,
    sorted[0]?.strike_price || 0
  );

  // OI-based support / resistance (max OI below / above spot)
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

  // Build strikes array
  const strikes = sorted.map(s => {
    const ceData   = s.call_options?.market_data   || {};
    const peData   = s.put_options?.market_data    || {};
    const ceGreeks = s.call_options?.option_greeks || {};
    const peGreeks = s.put_options?.option_greeks  || {};

    const ceOI       = ceData.oi      || 0;
    const peOI       = peData.oi      || 0;
    const cePrevOI   = ceData.prev_oi || 0;
    const pePrevOI   = peData.prev_oi || 0;
    const ceOIChange = ceOI - cePrevOI;
    const peOIChange = peOI - pePrevOI;

    return {
      strike: s.strike_price,
      isATM:  s.strike_price === atmStrike,
      ce: {
        instrumentKey: s.call_options?.instrument_key || "",
        ltp:      ceData.ltp       || 0,
        oi:       ceOI,
        oiChange: ceOIChange,
        prevOI:   cePrevOI,
        volume:   ceData.volume    || 0,
        iv:       ceGreeks.iv      || 0,
        delta:    ceGreeks.delta   || 0,
        theta:    ceGreeks.theta   || 0,
        vega:     ceGreeks.vega    || 0,
        bid:      ceData.bid_price || 0,
        ask:      ceData.ask_price || 0,
        signal:   getSignal(ceOI, cePrevOI, ceData.ltp, ceData.close_price),
      },
      pe: {
        instrumentKey: s.put_options?.instrument_key || "",
        ltp:      peData.ltp       || 0,
        oi:       peOI,
        oiChange: peOIChange,
        prevOI:   pePrevOI,
        volume:   peData.volume    || 0,
        iv:       peGreeks.iv      || 0,
        delta:    peGreeks.delta   || 0,
        theta:    peGreeks.theta   || 0,
        vega:     peGreeks.vega    || 0,
        bid:      peData.bid_price || 0,
        ask:      peData.ask_price || 0,
        signal:   getSignal(peOI, pePrevOI, peData.ltp, peData.close_price),
      },
    };
  });

  // Alerts — signal-based, near ATM only (within 5% of spot)
  const alerts = strikes
    .filter(s => Math.abs(s.strike - spotPrice) / spotPrice < 0.05)
    .filter(s => s.ce.signal !== "neutral" || s.pe.signal !== "neutral")
    .map(s => ({
      strike: s.strike,
      side:   s.ce.oiChange > s.pe.oiChange ? "CE" : "PE",
      signal: s.ce.oiChange > s.pe.oiChange ? s.ce.signal : s.pe.signal,
      pct:    s.isATM ? "ATM" : ((s.strike - spotPrice) / spotPrice * 100).toFixed(1) + "%",
    }))
    .slice(0, 10);

  // ── PATCH: two-tier unusual OI ────────────────────────────────────────────
  const { nearATM: unusualNearATM, tailRisk: unusualTailRisk } = detectUnusualOI(strikes, spotPrice, name);
  // ─────────────────────────────────────────────────────────────────────────

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
    // Two-tier unusual OI — both fields are arrays, both always present
    unusualOI:         unusualNearATM,   // near ATM: actionable S/R
    unusualOITailRisk: unusualTailRisk,  // far OTM: institutional / tail risk
    updatedAt: Date.now(),
  };
}

// ── OI signal detection ───────────────────────────────────────────────────────
function getSignal(oi, prevOI, ltp, closePrc) {
  const oiUp    = oi > prevOI * 1.02;
  const oiDown  = oi < prevOI * 0.98;
  const priceUp = ltp > (closePrc || ltp) * 1.001;
  const priceDn = ltp < (closePrc || ltp) * 0.999;

  if (oiUp   && priceUp) return "long_buildup";
  if (oiUp   && priceDn) return "short_buildup";
  if (oiDown && priceUp) return "short_covering";
  if (oiDown && priceDn) return "long_unwinding";
  return "neutral";
}

// ── Refresh expiry lists ──────────────────────────────────────────────────────
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

// ── Poll chains ───────────────────────────────────────────────────────────────
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

        // FIX: was previously called as ingestChainData({ symbol, spotPrice, ... })
        // i.e. a single object — but optionsIntegration expects 5 positional args:
        //   ingestChainData(symbol, spotPrice, chainData, expiryDate, lotSize)
        // Corrected to pass positional args so the engine actually receives the data.
        try {
          ingestChainData(
            u.name,       // symbol     — was: whole object
            spotPrice,    // spotPrice  — was: undefined
            raw.map(s => ({
              strike:  s.strike_price,
              callOI:  s.call_options?.market_data?.oi       || 0,
              putOI:   s.put_options?.market_data?.oi        || 0,
              callVol: s.call_options?.market_data?.volume   || 0,
              putVol:  s.put_options?.market_data?.volume    || 0,
              callLTP: s.call_options?.market_data?.ltp      || 0,
              putLTP:  s.put_options?.market_data?.ltp       || 0,
              callIV:  s.call_options?.option_greeks?.iv     || 0,
              putIV:   s.put_options?.option_greeks?.iv      || 0,
            })),          // chainData  — was: undefined
            expiry,       // expiryDate — was: undefined
            u.lotSize || 1, // lotSize  — was: undefined
          );
        } catch (err) {
          console.warn(`⚠️ OI Intel ingest error for ${u.name}:`, err.message);
        }

        // Log includes tail risk count so we can verify it's working
        const tailCount = processed.unusualOITailRisk?.length || 0;
        const nearCount = processed.unusualOI?.length || 0;
        console.log(
          `📊 OI: ${u.name} ${expiry} — PCR=${processed.pcr} Spot=₹${spotPrice} ` +
          `Strikes=${raw.length} | UnusualOI: ${nearCount} near-ATM, ${tailCount} tail-risk`
        );
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

// ── WebSocket OI tick handler ─────────────────────────────────────────────────
function handleOITick(instrumentKey, feedData) {
  const mFF = feedData?.marketFF;
  if (!mFF || !ioRef) return;
  ioRef.emit("option-oi-tick", {
    instrKey: instrumentKey,
    oi:       mFF.oi        || 0,
    ltp:      mFF.ltpc?.ltp || 0,
    ts:       Date.now(),
  });
}

// ── Public accessors ──────────────────────────────────────────────────────────
function getExpiries(underlying)      { return cache[underlying]?.expiries || []; }
function getChain(underlying, expiry) { return cache[underlying]?.chains?.[expiry] || null; }
function getAllCached()                { return cache; }

function addUnderlying(name, instrumentKey, lotSize) {
  if (UNDERLYINGS.find(u => u.upstoxKey === instrumentKey)) return;
  UNDERLYINGS.push({ name, upstoxKey: instrumentKey, lotSize: lotSize || 1 });
  console.log(`➕ OI: added underlying ${name}`);
}

// ── Persist slim cache ────────────────────────────────────────────────────────
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
            pcr:               chain.pcr,
            maxPainStrike:     chain.maxPainStrike,
            support:           chain.support,
            resistance:        chain.resistance,
            totalCEOI:         chain.totalCEOI,
            totalPEOI:         chain.totalPEOI,
            atmStrike:         chain.atmStrike,
            spotPrice:         chain.spotPrice,
            updatedAt:         chain.updatedAt,
            unusualOI:         chain.unusualOI         || [],
            unusualOITailRisk: chain.unusualOITailRisk || [],
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

// ── Load cache from disk ──────────────────────────────────────────────────────
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

  io.on("connection", socket => {
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

    socket.on("add-oi-underlying", ({ name, upstoxKey, lotSize }) => {
      addUnderlying(name, upstoxKey, lotSize);
    });
  });

  const runExpiries = async () => {
    const token = tokenGetter?.();
    if (token) await refreshExpiries(token);
  };

  setTimeout(async () => {
    await runExpiries();
    setTimeout(() => pollChains(), 5000);
    pollTimer   = setInterval(() => pollChains(),   POLL_INTERVAL_MS);
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