"use strict";

/**
 * nseOIListener.js
 * Place at: server/services/intelligence/nseOIListener.js
 *
 * FIXES applied (Session 8 → Session 9):
 *
 * FIX 1 — OI jumping between refreshes (460L → 2691L):
 *   Root cause: totalCEOI / totalPEOI were re-summed from scratch each poll,
 *   so early polls (partial data) showed tiny OI while later polls showed full OI.
 *   Fix: persist and MERGE OI into a running strikeOIMap per expiry. Each poll
 *   only updates strikes it receives — previously unseen strikes keep their last
 *   known OI. This gives a stable, monotonically-growing OI view during the session.
 *
 * FIX 2 — Net Flow swinging wildly (-4.7K → -151.8K Cr):
 *   Root cause: netPremiumFlow was recalculated from current ltp×volume every poll.
 *   Volume accumulates all day but LTP changes tick-by-tick, so the product
 *   explodes as the session progresses.
 *   Fix: track a sessionNetFlow that is accumulated DELTA (change in vol × ltp)
 *   per poll, not a full recalculation. Reset at session open (09:15 IST).
 *
 * FIX 3 — ingestChainData() called with object instead of positional args:
 *   (Already fixed in Session 8 — preserved here.)
 *
 * FIX 4 — Stale cache replayed to new clients showing old OI:
 *   Added cache age check — only replay if updatedAt < 4h ago.
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

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
const CACHE_MAX_AGE_MS   = 4 * 60 * 60 * 1000; // FIX 4: don't replay stale cache

const cache = {};

// FIX 1: Running OI map — strikeOIMap[underlying][expiry][strike] = { ceOI, peOI }
const strikeOIMap = {};

// FIX 2: Session net flow accumulator
// sessionFlow[underlying][expiry] = { netFlow (₹L), lastVolMap: { strike_ceVol, strike_peVol } }
const sessionFlowMap  = {};
let   sessionDate     = null; // "YYYY-MM-DD" — reset flows when date changes

const UNDERLYINGS = [
  { name: "NIFTY",     upstoxKey: "NSE_INDEX|Nifty 50",   lotSize: 75 },
  { name: "BANKNIFTY", upstoxKey: "NSE_INDEX|Nifty Bank",  lotSize: 35 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns "YYYY-MM-DD" for today in IST.
 * Used to detect a new trading session and reset accumulators.
 */
function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * If the calendar date has changed since last poll, reset all session accumulators.
 * This ensures Net Flow starts at 0 each trading day.
 */
function maybeResetSession() {
  const today = todayIST();
  if (sessionDate !== today) {
    sessionDate = today;
    for (const key of Object.keys(sessionFlowMap)) delete sessionFlowMap[key];
    console.log(`🔄 OI: new session ${today} — net flow accumulators reset`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth header
// ─────────────────────────────────────────────────────────────────────────────
function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch expiry dates
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Fetch option chain for one underlying + expiry
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: Merge incoming OI into the running strikeOIMap
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Merges newly polled OI values into the persistent strikeOIMap.
 * Strikes not present in this poll retain their previous OI values.
 * Returns merged { ceOI, peOI } totals across all strikes.
 */
function mergeOI(name, expiry, rawStrikes) {
  if (!strikeOIMap[name])          strikeOIMap[name] = {};
  if (!strikeOIMap[name][expiry])  strikeOIMap[name][expiry] = {};

  const map = strikeOIMap[name][expiry];

  for (const s of rawStrikes) {
    const k    = s.strike_price;
    const ceOI = s.call_options?.market_data?.oi || 0;
    const peOI = s.put_options?.market_data?.oi  || 0;

    // Only update if new value > 0 (exchange sometimes sends 0 mid-session for a strike)
    if (!map[k]) map[k] = { ceOI: 0, peOI: 0 };
    if (ceOI > 0) map[k].ceOI = ceOI;
    if (peOI > 0) map[k].peOI = peOI;
  }

  // Return stable totals from the merged map
  let totalCEOI = 0, totalPEOI = 0;
  for (const v of Object.values(map)) {
    totalCEOI += v.ceOI;
    totalPEOI += v.peOI;
  }
  return { totalCEOI, totalPEOI };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: Session net flow accumulator
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Computes the delta net premium flow since the last poll, and adds it to the
 * running session total.
 *
 * netPremiumFlow = Σ (putVol × putLTP) - Σ (callVol × callLTP)
 *
 * Instead of recalculating from scratch (which explodes as volume builds),
 * we compute the CHANGE in volume since last poll, multiply by current LTP,
 * and add that delta to the session total.
 *
 * Returns the cumulative session net flow in ₹ Lakh (L).
 */
function accumulateNetFlow(name, expiry, rawStrikes) {
  const key = `${name}__${expiry}`;
  if (!sessionFlowMap[key]) {
    sessionFlowMap[key] = { netFlow: 0, lastVolMap: {} };
  }
  const state = sessionFlowMap[key];

  let deltaFlow = 0;

  for (const s of rawStrikes) {
    const k       = s.strike_price;
    const ceLTP   = s.call_options?.market_data?.ltp    || 0;
    const peLTP   = s.put_options?.market_data?.ltp     || 0;
    const ceVol   = s.call_options?.market_data?.volume || 0;
    const peVol   = s.put_options?.market_data?.volume  || 0;

    const prevCeVol = state.lastVolMap[`${k}_ce`] || 0;
    const prevPeVol = state.lastVolMap[`${k}_pe`] || 0;

    const ceVolDelta = Math.max(0, ceVol - prevCeVol); // volume only goes up
    const peVolDelta = Math.max(0, peVol - prevPeVol);

    // Net flow: put premium traded minus call premium traded (₹)
    deltaFlow += (peVolDelta * peLTP) - (ceVolDelta * ceLTP);

    state.lastVolMap[`${k}_ce`] = ceVol;
    state.lastVolMap[`${k}_pe`] = peVol;
  }

  // Accumulate into session total (convert ₹ → ₹L = divide by 1e5)
  state.netFlow += deltaFlow / 1e5;

  return Math.round(state.netFlow * 10) / 10; // round to 1 decimal ₹L
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-tier unusual OI detection (unchanged from Session 8)
// ─────────────────────────────────────────────────────────────────────────────
function detectUnusualOI(strikes, spotPrice, symbol) {
  if (!strikes?.length || !spotPrice) return { nearATM: [], tailRisk: [] };

  const isBankNifty      = (symbol || "").toUpperCase().includes("BANK");
  const nearPct          = isBankNifty ? 0.10 : 0.08;
  const oiThreshold      = isBankNifty ? 50_000 : 30_000;
  const volThreshold     = isBankNifty ? 20_000 : 10_000;
  const oiChangePct      = 0.15;
  const neighborWindow   = 3;
  const neighborMultiple = 3.5;
  const minAbsOI         = isBankNifty ? 100_000 : 50_000;

  const lo = spotPrice * (1 - nearPct);
  const hi = spotPrice * (1 + nearPct);

  const nearATM  = [];
  const tailRisk = [];

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

    const isCall   = ceOI > peOI;
    const side     = isCall ? "CALL" : "PUT";
    const oi       = isCall ? ceOI  : peOI;
    const vol      = isCall ? ceVol : peVol;
    const oiChg    = isCall ? ceChg : peChg;
    const ltp      = isCall ? (s.ce?.ltp || 0) : (s.pe?.ltp || 0);
    const iv       = isCall ? (s.ce?.iv  || 0) : (s.pe?.iv  || 0);
    const prevOI   = oi - oiChg;
    const oiChgPct = prevOI > 0 ? Math.abs(oiChg / prevOI) : 0;

    if (strike >= lo && strike <= hi) {
      if (oi >= oiThreshold && (vol >= volThreshold || oiChgPct >= oiChangePct)) {
        nearATM.push({
          strike,
          type: side, oi, vol, oiChange: oiChg,
          oiChgPct: +(oiChgPct * 100).toFixed(1),
          ltp, iv: +(iv * 100).toFixed(2),
          distPct: +((strike - spotPrice) / spotPrice * 100).toFixed(1),
          tier: "nearATM",
        });
      }
    } else {
      if (oi < minAbsOI) continue;

      const start       = Math.max(0, i - neighborWindow);
      const end         = Math.min(strikes.length - 1, i + neighborWindow);
      const neighborOIs = [];
      for (let j = start; j <= end; j++) {
        if (j !== i) neighborOIs.push(oiByIndex[j]);
      }
      if (!neighborOIs.length) continue;

      neighborOIs.sort((a, b) => a - b);
      const mid      = Math.floor(neighborOIs.length / 2);
      const medianOI = neighborOIs.length % 2 === 0
        ? (neighborOIs[mid - 1] + neighborOIs[mid]) / 2
        : neighborOIs[mid];

      if (medianOI <= 0) continue;
      const ratio = oi / medianOI;
      if (ratio < neighborMultiple) continue;

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
        strike, type: side, oi, vol, oiChange: oiChg,
        oiChgPct: +(oiChgPct * 100).toFixed(1),
        neighborMedianOI: Math.round(medianOI),
        neighborRatio: +ratio.toFixed(1),
        ltp, iv: +(iv * 100).toFixed(2),
        distPct: +distPct.toFixed(1),
        interpretation,
        tier: "tailRisk",
      });
    }
  }

  nearATM.sort((a, b)  => b.oi - a.oi);
  tailRisk.sort((a, b) => b.neighborRatio - a.neighborRatio);

  return {
    nearATM:  nearATM.slice(0, 6),
    tailRisk: tailRisk.slice(0, 4),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Process raw Upstox chain into structured format
// ─────────────────────────────────────────────────────────────────────────────
function processChain(name, expiry, rawStrikes, spotPrice) {
  if (!rawStrikes.length) return null;

  const sorted = [...rawStrikes].sort((a, b) => a.strike_price - b.strike_price);

  // FIX 1: use merged stable OI totals instead of recalculating from scratch
  const { totalCEOI, totalPEOI } = mergeOI(name, expiry, rawStrikes);

  // FIX 2: accumulate session net flow as delta, not full recalc
  const sessionNetFlow = accumulateNetFlow(name, expiry, rawStrikes);

  // Max CE/PE OI strikes (from stable merged map)
  const mergedMap = strikeOIMap[name]?.[expiry] || {};
  let maxCEOI = 0, maxPEOI = 0, maxCEStrike = 0, maxPEStrike = 0;
  for (const [k, v] of Object.entries(mergedMap)) {
    if (v.ceOI > maxCEOI) { maxCEOI = v.ceOI; maxCEStrike = Number(k); }
    if (v.peOI > maxPEOI) { maxPEOI = v.peOI; maxPEStrike = Number(k); }
  }

  const pcr = totalCEOI > 0 ? +(totalPEOI / totalCEOI).toFixed(3) : 0;

  // Max pain — computed from merged OI for stability
  let maxPainStrike = 0;
  let minPain = Infinity;
  const mergedEntries = Object.entries(mergedMap).map(([k, v]) => ({ strike: Number(k), ...v }));
  for (const target of mergedEntries) {
    let pain = 0;
    for (const s of mergedEntries) {
      if (s.strike < target.strike) pain += s.ceOI * (target.strike - s.strike);
      if (s.strike > target.strike) pain += s.peOI * (s.strike - target.strike);
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = target.strike; }
  }

  // ATM strike
  const atmStrike = sorted.reduce(
    (best, s) => Math.abs(s.strike_price - spotPrice) < Math.abs(best - spotPrice)
      ? s.strike_price : best,
    sorted[0]?.strike_price || 0
  );

  // OI-based support / resistance
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

    // FIX 1: Use merged stable OI, fall back to live if merged not yet available
    const mergedStrike = mergedMap[s.strike_price] || {};
    const ceOI         = mergedStrike.ceOI ?? (ceData.oi || 0);
    const peOI         = mergedStrike.peOI ?? (peData.oi || 0);

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

  // Alerts — signal-based, near ATM only
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

  const { nearATM: unusualNearATM, tailRisk: unusualTailRisk } = detectUnusualOI(strikes, spotPrice, name);

  return {
    underlying:    name,
    expiry,
    spotPrice,
    pcr,
    maxPainStrike,
    support,
    resistance,
    totalCEOI,   // FIX 1: stable merged total
    totalPEOI,   // FIX 1: stable merged total
    netFlow:     sessionNetFlow, // FIX 2: session-accumulated delta flow
    atmStrike,
    strikes,
    alerts,
    unusualOI:         unusualNearATM,
    unusualOITailRisk: unusualTailRisk,
    updatedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OI signal detection
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Refresh expiry lists
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Poll chains
// ─────────────────────────────────────────────────────────────────────────────
async function pollChains() {
  if (disabled) return;

  const token = tokenGetter?.();
  if (!token) return;

  // FIX 2: check for new session before polling
  maybeResetSession();

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

        // FIX 3: positional args (was: single object — fixed in Session 8, preserved)
        try {
          ingestChainData(
            u.name,
            spotPrice,
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
            })),
            expiry,
            u.lotSize || 1,
          );
        } catch (err) {
          console.warn(`⚠️ OI Intel ingest error for ${u.name}:`, err.message);
        }

        const tailCount = processed.unusualOITailRisk?.length || 0;
        const nearCount = processed.unusualOI?.length || 0;
        console.log(
          `📊 OI: ${u.name} ${expiry} — PCR=${processed.pcr} Spot=₹${spotPrice} ` +
          `TotalOI=${((processed.totalCEOI + processed.totalPEOI) / 1e5).toFixed(1)}L ` +
          `NetFlow=₹${processed.netFlow}L | ` +
          `UnusualOI: ${nearCount} near-ATM, ${tailCount} tail-risk`
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

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket OI tick handler
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Public accessors
// ─────────────────────────────────────────────────────────────────────────────
function getExpiries(underlying)      { return cache[underlying]?.expiries || []; }
function getChain(underlying, expiry) { return cache[underlying]?.chains?.[expiry] || null; }
function getAllCached()                { return cache; }

function addUnderlying(name, instrumentKey, lotSize) {
  if (UNDERLYINGS.find(u => u.upstoxKey === instrumentKey)) return;
  UNDERLYINGS.push({ name, upstoxKey: instrumentKey, lotSize: lotSize || 1 });
  console.log(`➕ OI: added underlying ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Persist slim cache
// ─────────────────────────────────────────────────────────────────────────────
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
            netFlow:           chain.netFlow,       // FIX 2: persist session flow
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

// ─────────────────────────────────────────────────────────────────────────────
// Load cache from disk
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
function startNSEOIListener(io, tGetter) {
  ioRef       = io;
  tokenGetter = tGetter;

  console.log("🔭 NSE OI Listener starting (Upstox source)...");

  loadCache();
  maybeResetSession(); // FIX 2: initialise session date on startup

  io.on("connection", socket => {
    for (const [name, data] of Object.entries(cache)) {
      // FIX 4: don't replay stale cache to new clients
      const age = Date.now() - (data.updatedAt || 0);
      if (age > CACHE_MAX_AGE_MS) continue;

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