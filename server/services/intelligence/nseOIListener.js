"use strict";

/**
 * nseOIListener.js
 * Place at: server/services/intelligence/nseOIListener.js
 *
 * ══════════════════════════════════════════════════════════════
 * FIXES APPLIED (this session):
 *
 * FIX-LOT-1 — accumulateNetFlow() missing lotSize:
 *   Upstox volume = number of CONTRACTS (lots).
 *   Notional value = volume × lotSize × LTP.
 *   Previous code: deltaFlow += (peVolDelta * peLTP) - (ceVolDelta * ceLTP)
 *   → Missing × lotSize → values were 75x too small for NIFTY.
 *   Fix: pass lotSize into accumulateNetFlow, multiply deltaFlow by lotSize.
 *   Divide by 1e7 (not 1e5) to get CRORES (matching optionsIntelligenceEngine).
 *
 * FIX-LOT-2 — mergeOI() OI field name:
 *   Upstox /v2/option/chain market_data may return open_interest OR oi.
 *   Fix: read both, prefer whichever is non-zero.
 *
 * FIX-LOT-3 — processChain() netFlow label:
 *   netFlow is now in CRORES (÷ 1e7) not Lakhs (÷ 1e5).
 *   Console log updated to show "Cr" unit.
 *
 * FIX-LOT-4 — buildNormalisedRows() OI field name:
 *   Same dual-field read (open_interest || oi) for consistency.
 *
 * Previously fixed (preserved):
 *   FIX 1 — buildNormalisedRows() used strikeOIMap[null]
 *   FIX 2 — closes array (spotHistory) passed to ingestChainData
 *   FIX 3 — ingestChainData signature extended to accept closes[]
 *   FIX A — double-emit causing flash of absurd values
 *   FIX B — OI jumping between refreshes (merged strikeOIMap)
 *   FIX C — net flow swinging wildly (delta accumulator)
 *   FIX D — stale cache replay blocked
 *   FIX E — clean normalised rows passed to optionsIntegration
 * ══════════════════════════════════════════════════════════════
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
const CACHE_MAX_AGE_MS   = 4 * 60 * 60 * 1000;

const cache = {};

// FIX B: Running merged OI map — keyed by [name][expiry][strike]
const strikeOIMap = {};

// FIX C: Session net flow accumulator
const sessionFlowMap = {};
let   sessionDate    = null;

// Rolling spot price history for HV calculation — keyed by name
const spotHistory = {};

const UNDERLYINGS = [
  { name: "NIFTY",     upstoxKey: "NSE_INDEX|Nifty 50",  lotSize: 75 },
  { name: "BANKNIFTY", upstoxKey: "NSE_INDEX|Nifty Bank", lotSize: 35 },
];

// ─────────────────────────────────────────────────────────────────────────────
// IST / session helpers
// ─────────────────────────────────────────────────────────────────────────────

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function maybeResetSession() {
  const today = todayIST();
  if (sessionDate !== today) {
    sessionDate = today;
    for (const key of Object.keys(sessionFlowMap)) delete sessionFlowMap[key];
    console.log(`🔄 OI: new session ${today} — net flow accumulators reset`);
  }
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spot history for HV calculation
// ─────────────────────────────────────────────────────────────────────────────

function appendSpotHistory(name, spotPrice) {
  if (!spotPrice || spotPrice <= 0) return;
  if (!spotHistory[name]) spotHistory[name] = [];
  spotHistory[name].push(spotPrice);
  if (spotHistory[name].length > 252) {
    spotHistory[name] = spotHistory[name].slice(-252);
  }
}

function getSpotHistory(name) {
  return spotHistory[name] || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchExpiries(upstoxKey, token) {
  const res = await axios.get(
    "https://api.upstox.com/v2/option/contract",
    { params: { instrument_key: upstoxKey }, headers: authHeaders(token), timeout: 15_000 }
  );
  const contracts = res.data?.data || [];
  const dates = [...new Set(contracts.map(c => c.expiry))].sort();
  return dates;
}

async function fetchChain(upstoxKey, expiry, token) {
  const res = await axios.get(
    "https://api.upstox.com/v2/option/chain",
    { params: { instrument_key: upstoxKey, expiry_date: expiry }, headers: authHeaders(token), timeout: 15_000 }
  );
  return res.data?.data || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX-LOT-2: Safe OI reader — Upstox may return open_interest OR oi
// ─────────────────────────────────────────────────────────────────────────────

function readOI(marketData) {
  if (!marketData) return 0;
  // Prefer open_interest (official Upstox v2 field name), fallback to oi
  const v = marketData.open_interest ?? marketData.oi ?? 0;
  return Number(v) || 0;
}

function readPrevOI(marketData) {
  if (!marketData) return 0;
  const v = marketData.prev_oi ?? marketData.prev_open_interest ?? 0;
  return Number(v) || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX B: Merge OI into stable running map
// ─────────────────────────────────────────────────────────────────────────────

function mergeOI(name, expiry, rawStrikes) {
  if (!strikeOIMap[name])         strikeOIMap[name] = {};
  if (!strikeOIMap[name][expiry]) strikeOIMap[name][expiry] = {};
  const map = strikeOIMap[name][expiry];

  for (const s of rawStrikes) {
    const k    = s.strike_price;
    // FIX-LOT-2: use readOI() to handle both field names
    const ceOI = readOI(s.call_options?.market_data);
    const peOI = readOI(s.put_options?.market_data);
    if (!map[k]) map[k] = { ceOI: 0, peOI: 0 };
    if (ceOI > 0) map[k].ceOI = ceOI;
    if (peOI > 0) map[k].peOI = peOI;
  }

  let totalCEOI = 0, totalPEOI = 0;
  for (const v of Object.values(map)) {
    totalCEOI += v.ceOI;
    totalPEOI += v.peOI;
  }
  return { totalCEOI, totalPEOI };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX-LOT-1 + FIX C: Session net flow accumulator (delta-based, lotSize-aware)
//
// Upstox volume = number of CONTRACTS (each contract = 1 lot).
// Notional rupee value = contracts × lotSize × LTP.
// Divide by 1e7 to get CRORES (same unit as optionsIntelligenceEngine FIX A).
//
// Previous: deltaFlow / 1e5 → Lakhs, missing × lotSize → 75x too small.
// Fixed:    deltaFlow × lotSize / 1e7 → Crores, correct notional.
// ─────────────────────────────────────────────────────────────────────────────

function accumulateNetFlow(name, expiry, rawStrikes, lotSize) {
  const key = `${name}__${expiry}`;
  if (!sessionFlowMap[key]) sessionFlowMap[key] = { netFlow: 0, lastVolMap: {} };
  const state   = sessionFlowMap[key];
  const lotSz   = lotSize || 1;   // FIX-LOT-1: use real lot size

  let deltaFlow = 0;
  for (const s of rawStrikes) {
    const k     = s.strike_price;
    const ceLTP = s.call_options?.market_data?.ltp    || 0;
    const peLTP = s.put_options?.market_data?.ltp     || 0;
    const ceVol = s.call_options?.market_data?.volume || 0;
    const peVol = s.put_options?.market_data?.volume  || 0;

    const prevCeVol = state.lastVolMap[`${k}_ce`] || 0;
    const prevPeVol = state.lastVolMap[`${k}_pe`] || 0;

    // Only count NEW volume since last poll
    const ceVolDelta = Math.max(0, ceVol - prevCeVol);
    const peVolDelta = Math.max(0, peVol - prevPeVol);

    // FIX-LOT-1: multiply by lotSize to get actual notional rupees
    deltaFlow += (peVolDelta * peLTP - ceVolDelta * ceLTP) * lotSz;

    state.lastVolMap[`${k}_ce`] = ceVol;
    state.lastVolMap[`${k}_pe`] = peVol;
  }

  // FIX-LOT-1: divide by 1e7 → CRORES (was 1e5 → Lakhs, also missing lotSize)
  state.netFlow += deltaFlow / 1e7;
  return Math.round(state.netFlow * 10) / 10;
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
// Unusual OI detection (two-tier)
// ─────────────────────────────────────────────────────────────────────────────

function detectUnusualOI(strikes, spotPrice, symbol) {
  if (!strikes?.length || !spotPrice) return { nearATM: [], tailRisk: [] };

  const isBankNifty    = (symbol || "").toUpperCase().includes("BANK");
  const nearPct        = isBankNifty ? 0.10 : 0.08;
  const oiThreshold    = isBankNifty ? 50_000 : 30_000;
  const volThreshold   = isBankNifty ? 20_000 : 10_000;
  const oiChangePct    = 0.15;
  const neighborWindow = 3;
  const neighborMult   = 3.5;
  const minAbsOI       = isBankNifty ? 100_000 : 50_000;

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
    const isCall = ceOI > peOI;
    const side   = isCall ? "CALL" : "PUT";
    const oi     = isCall ? ceOI  : peOI;
    const vol    = isCall ? ceVol : peVol;
    const oiChg  = isCall ? ceChg : peChg;
    const ltp    = isCall ? (s.ce?.ltp || 0) : (s.pe?.ltp || 0);
    const iv     = isCall ? (s.ce?.iv  || 0) : (s.pe?.iv  || 0);
    const prevOI = oi - oiChg;
    const oiChgPct = prevOI > 0 ? Math.abs(oiChg / prevOI) : 0;

    if (strike >= lo && strike <= hi) {
      if (oi >= oiThreshold && (vol >= volThreshold || oiChgPct >= oiChangePct)) {
        nearATM.push({
          strike, type: side, oi, vol, oiChange: oiChg,
          oiChgPct: +(oiChgPct * 100).toFixed(1),
          ltp, iv: +(iv * 100).toFixed(2),
          distPct: +((strike - spotPrice) / spotPrice * 100).toFixed(1),
          tier: "nearATM",
        });
      }
    } else {
      if (oi < minAbsOI) continue;
      const start = Math.max(0, i - neighborWindow);
      const end   = Math.min(strikes.length - 1, i + neighborWindow);
      const neighborOIs = [];
      for (let j = start; j <= end; j++) if (j !== i) neighborOIs.push(oiByIndex[j]);
      if (!neighborOIs.length) continue;
      neighborOIs.sort((a, b) => a - b);
      const mid      = Math.floor(neighborOIs.length / 2);
      const medianOI = neighborOIs.length % 2 === 0
        ? (neighborOIs[mid-1] + neighborOIs[mid]) / 2
        : neighborOIs[mid];
      if (medianOI <= 0) continue;
      const ratio = oi / medianOI;
      if (ratio < neighborMult) continue;
      const distPct = (strike - spotPrice) / spotPrice * 100;
      let interpretation;
      if (side === "PUT"  && distPct < -8) interpretation = oiChgPct > 0.10 ? "Active crash hedge building" : "Tail risk hedge / put wall";
      else if (side === "CALL" && distPct > 8) interpretation = oiChgPct > 0.10 ? "Aggressive call writing" : "Supply wall / covered calls";
      else interpretation = "Unusual positioning";
      tailRisk.push({
        strike, type: side, oi, vol, oiChange: oiChg,
        oiChgPct: +(oiChgPct * 100).toFixed(1),
        neighborMedianOI: Math.round(medianOI), neighborRatio: +ratio.toFixed(1),
        ltp, iv: +(iv * 100).toFixed(2),
        distPct: +distPct.toFixed(1), interpretation, tier: "tailRisk",
      });
    }
  }

  nearATM.sort((a, b)  => b.oi - a.oi);
  tailRisk.sort((a, b) => b.neighborRatio - a.neighborRatio);
  return { nearATM: nearATM.slice(0, 6), tailRisk: tailRisk.slice(0, 4) };
}

// ─────────────────────────────────────────────────────────────────────────────
// processChain — builds structured chain for option-chain-update socket event
// ─────────────────────────────────────────────────────────────────────────────

function processChain(name, expiry, rawStrikes, spotPrice, lotSize) {
  if (!rawStrikes.length) return null;

  const sorted = [...rawStrikes].sort((a, b) => a.strike_price - b.strike_price);
  const lotSz  = lotSize || 1;

  // FIX B: use merged stable OI totals (FIX-LOT-2: readOI used inside mergeOI)
  const { totalCEOI, totalPEOI } = mergeOI(name, expiry, rawStrikes);

  // FIX-LOT-1: pass lotSize so net flow is in Crores
  const sessionNetFlow = accumulateNetFlow(name, expiry, rawStrikes, lotSz);

  const mergedMap = strikeOIMap[name]?.[expiry] || {};

  // Max pain from merged map
  let maxPainStrike = 0, minPain = Infinity;
  const mergedEntries = Object.entries(mergedMap).map(([k, v]) => ({ strike: Number(k), ...v }));
  for (const target of mergedEntries) {
    let pain = 0;
    for (const s of mergedEntries) {
      if (s.strike < target.strike) pain += s.ceOI * (target.strike - s.strike);
      if (s.strike > target.strike) pain += s.peOI * (s.strike - target.strike);
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = target.strike; }
  }

  const pcr      = totalCEOI > 0 ? +(totalPEOI / totalCEOI).toFixed(3) : 0;
  const atmStrike = sorted.reduce(
    (best, s) => Math.abs(s.strike_price - spotPrice) < Math.abs(best - spotPrice) ? s.strike_price : best,
    sorted[0]?.strike_price || 0
  );

  const below      = sorted.filter(s => s.strike_price <= spotPrice);
  const above      = sorted.filter(s => s.strike_price >= spotPrice);
  const support    = below.length ? below.reduce((b, s) => readOI(s.put_options?.market_data) > readOI(b.put_options?.market_data) ? s : b).strike_price : 0;
  const resistance = above.length ? above.reduce((b, s) => readOI(s.call_options?.market_data) > readOI(b.call_options?.market_data) ? s : b).strike_price : 0;

  const strikes = sorted.map(s => {
    const ceData   = s.call_options?.market_data   || {};
    const peData   = s.put_options?.market_data    || {};
    const ceGreeks = s.call_options?.option_greeks || {};
    const peGreeks = s.put_options?.option_greeks  || {};
    const mergedStrike = mergedMap[s.strike_price] || {};
    // FIX-LOT-2: use readOI for consistent field access
    const ceOI         = mergedStrike.ceOI > 0 ? mergedStrike.ceOI : readOI(ceData);
    const peOI         = mergedStrike.peOI > 0 ? mergedStrike.peOI : readOI(peData);
    const cePrevOI     = readPrevOI(ceData);
    const pePrevOI     = readPrevOI(peData);

    return {
      strike: s.strike_price,
      isATM:  s.strike_price === atmStrike,
      ce: {
        instrumentKey: s.call_options?.instrument_key || "",
        ltp:      ceData.ltp      || 0,
        oi:       ceOI,
        oiChange: ceOI - cePrevOI,
        prevOI:   cePrevOI,
        volume:   ceData.volume   || 0,
        iv:       ceGreeks.iv     || 0,
        delta:    ceGreeks.delta  || 0,
        theta:    ceGreeks.theta  || 0,
        vega:     ceGreeks.vega   || 0,
        bid:      ceData.bid_price || 0,
        ask:      ceData.ask_price || 0,
        signal:   getSignal(ceOI, cePrevOI, ceData.ltp, ceData.close_price),
      },
      pe: {
        instrumentKey: s.put_options?.instrument_key || "",
        ltp:      peData.ltp      || 0,
        oi:       peOI,
        oiChange: peOI - pePrevOI,
        prevOI:   pePrevOI,
        volume:   peData.volume   || 0,
        iv:       peGreeks.iv     || 0,
        delta:    peGreeks.delta  || 0,
        theta:    peGreeks.theta  || 0,
        vega:     peGreeks.vega   || 0,
        bid:      peData.bid_price || 0,
        ask:      peData.ask_price || 0,
        signal:   getSignal(peOI, pePrevOI, peData.ltp, peData.close_price),
      },
    };
  });

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
    underlying: name, expiry, spotPrice, pcr, maxPainStrike, support, resistance,
    totalCEOI, totalPEOI,
    netFlow: sessionNetFlow,   // FIX-LOT-1: now in CRORES
    atmStrike, strikes, alerts,
    unusualOI:         unusualNearATM,
    unusualOITailRisk: unusualTailRisk,
    updatedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 + FIX-LOT-2: buildNormalisedRows
// ─────────────────────────────────────────────────────────────────────────────

function buildNormalisedRows(name, expiry, rawStrikes) {
  const mergedMap = strikeOIMap[name]?.[expiry] || {};

  return rawStrikes.map(s => {
    const strike = s.strike_price;
    const merged = mergedMap[strike] || {};

    // FIX-LOT-2: use readOI() for both field names
    const rawCeOI = readOI(s.call_options?.market_data);
    const rawPeOI = readOI(s.put_options?.market_data);

    const callOI = (merged.ceOI > 0 ? merged.ceOI : null) ?? rawCeOI;
    const putOI  = (merged.peOI > 0 ? merged.peOI  : null) ?? rawPeOI;

    return {
      strike,
      callOI,
      putOI,
      callVol: s.call_options?.market_data?.volume   || 0,
      putVol:  s.put_options?.market_data?.volume    || 0,
      callLTP: s.call_options?.market_data?.ltp      || 0,
      putLTP:  s.put_options?.market_data?.ltp       || 0,
      callIV:  s.call_options?.option_greeks?.iv     || 0,
      putIV:   s.put_options?.option_greeks?.iv      || 0,
    };
  }).filter(r => r.strike > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Expiry refresh
// ─────────────────────────────────────────────────────────────────────────────

async function refreshExpiries(token) {
  for (const u of UNDERLYINGS) {
    try {
      const expiries = await fetchExpiries(u.upstoxKey, token);
      if (!cache[u.name]) cache[u.name] = { expiries: [], chains: {}, spotPrice: 0, updatedAt: 0 };
      cache[u.name].expiries = expiries;
      console.log(`📅 OI: ${u.name} expiries — ${expiries.slice(0,4).join(", ")}`);
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

        appendSpotHistory(u.name, spotPrice);

        // ── 1. Build structured chain for option-chain-update ──
        // FIX-LOT-1: pass lotSize to processChain
        const processed = processChain(u.name, expiry, raw, spotPrice, u.lotSize);
        if (!processed) continue;

        if (!cache[u.name]) cache[u.name] = { expiries: [], chains: {}, spotPrice: 0, updatedAt: 0 };
        cache[u.name].chains[expiry] = processed;
        cache[u.name].spotPrice      = spotPrice;
        cache[u.name].updatedAt      = Date.now();

        if (ioRef) {
          ioRef.emit("option-chain-update", { underlying: u.name, expiry, data: processed });
        }

        // ── 2. Pass CLEAN normalised rows + closes to optionsIntegration ──
        try {
          const normalisedRows = buildNormalisedRows(u.name, expiry, raw);
          const closes         = getSpotHistory(u.name);

          ingestChainData(
            u.name,
            spotPrice,
            normalisedRows,
            expiry,
            u.lotSize || 1,
            closes,
          );
        } catch (err) {
          console.warn(`⚠️ OI Intel ingest error for ${u.name}:`, err.message);
        }

        const tailCount = processed.unusualOITailRisk?.length || 0;
        const nearCount = processed.unusualOI?.length         || 0;
        const totalOI   = processed.totalCEOI + processed.totalPEOI;

        // FIX-LOT-3: log shows Cr for netFlow
        console.log(
          `📊 OI: ${u.name} ${expiry} — PCR=${processed.pcr} Spot=₹${spotPrice} ` +
          `TotalOI=${totalOI.toLocaleString("en-IN")} contracts ` +
          `NetFlow=₹${processed.netFlow} Cr | ` +
          `UnusualOI: ${nearCount} near-ATM, ${tailCount} tail-risk`
        );
        anySuccess = true;

        await sleep(1500);
      } catch (e) {
        console.warn(
          `⚠️ OI: chain fetch failed ${u.name} ${expiry}:`,
          e.response?.data?.errors?.[0]?.message || e.message
        );
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
// Cache persistence
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
            pcr: chain.pcr, maxPainStrike: chain.maxPainStrike,
            support: chain.support, resistance: chain.resistance,
            totalCEOI: chain.totalCEOI, totalPEOI: chain.totalPEOI,
            netFlow: chain.netFlow,
            atmStrike: chain.atmStrike, spotPrice: chain.spotPrice, updatedAt: chain.updatedAt,
            unusualOI: chain.unusualOI || [], unusualOITailRisk: chain.unusualOITailRisk || [],
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
  maybeResetSession();

  io.on("connection", socket => {
    for (const [name, data] of Object.entries(cache)) {
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