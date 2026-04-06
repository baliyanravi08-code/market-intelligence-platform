"use strict";

/**
 * optionChainEngine.js
 * Processes Upstox option chain snapshots into:
 *   - OI heatmap data (strike × CE/PE)
 *   - Max pain strike
 *   - PCR (Put-Call Ratio)
 *   - Support / Resistance from OI concentrations
 *   - OI buildup / unwinding signals
 * Place at: server/services/intelligence/optionChainEngine.js
 */

// In-memory previous snapshot for delta computation
const prevSnapshot = {}; // key: `${underlying}_${expiry}` → { strikes: Map }

/**
 * Main processor. Accepts raw Upstox /v2/option/chain response data array.
 * Returns enriched heatmap payload ready for Socket.io emit.
 */
function processOptionChain(underlying, expiry, rawStrikes, spotPrice) {
  const key = `${underlying}_${expiry}`;
  const prev = prevSnapshot[key] || null;

  // ── Build strike table ────────────────────────────────────────────────────
  const strikes = rawStrikes.map(s => {
    const ce = s.call_options?.market_data || {};
    const pe = s.put_options?.market_data  || {};
    const ceGreeks = s.call_options?.option_greeks || {};
    const peGreeks = s.put_options?.option_greeks  || {};

    const ceOI     = ce.oi      || 0;
    const peOI     = pe.oi      || 0;
    const cePrevOI = ce.prev_oi || ceOI;
    const pePrevOI = pe.prev_oi || peOI;

    // OI change from prev_oi field (Upstox provides this)
    const ceOIChange = ceOI - cePrevOI;
    const peOIChange = peOI - pePrevOI;

    // Buildup / unwinding classification
    const ceSignal = classifyOIMove(ceOI, cePrevOI, ce.ltp, 0);
    const peSignal = classifyOIMove(peOI, pePrevOI, pe.ltp, 0);

    return {
      strike:       s.strike_price,
      pcr:          s.pcr || (ceOI > 0 ? peOI / ceOI : 0),

      ce: {
        oi:         ceOI,
        oiChange:   ceOIChange,
        oiChangePct: cePrevOI > 0 ? ((ceOIChange / cePrevOI) * 100) : 0,
        ltp:        ce.ltp      || 0,
        iv:         ceGreeks.iv || 0,
        delta:      ceGreeks.delta || 0,
        volume:     ce.volume   || 0,
        signal:     ceSignal,
        instrKey:   s.call_options?.instrument_key || null,
      },
      pe: {
        oi:         peOI,
        oiChange:   peOIChange,
        oiChangePct: pePrevOI > 0 ? ((peOIChange / pePrevOI) * 100) : 0,
        ltp:        pe.ltp      || 0,
        iv:         peGreeks.iv || 0,
        delta:      peGreeks.delta || 0,
        volume:     pe.volume   || 0,
        signal:     peSignal,
        instrKey:   s.put_options?.instrument_key || null,
      },

      // Distance from spot (for ATM detection)
      distFromSpot: spotPrice > 0 ? Math.abs(s.strike_price - spotPrice) : null,
      isATM:        false, // set below
    };
  });

  // Mark ATM
  if (spotPrice > 0 && strikes.length) {
    const atm = strikes.reduce((a, b) =>
      (a.distFromSpot <= b.distFromSpot ? a : b)
    );
    atm.isATM = true;
  }

  // ── Max Pain ──────────────────────────────────────────────────────────────
  const maxPainStrike = calcMaxPain(strikes);

  // ── PCR overall ──────────────────────────────────────────────────────────
  const totalCEOI = strikes.reduce((s, r) => s + r.ce.oi, 0);
  const totalPEOI = strikes.reduce((s, r) => s + r.pe.oi, 0);
  const pcr = totalCEOI > 0 ? parseFloat((totalPEOI / totalCEOI).toFixed(3)) : 0;

  // ── Support / Resistance from OI concentration ────────────────────────────
  // Resistance = high CE OI (writers defending) → ceiling
  // Support    = high PE OI (writers defending) → floor
  const sorted = [...strikes].sort((a, b) => b.ce.oi - a.ce.oi);
  const topCE  = sorted.slice(0, 3).map(s => s.strike);
  const topPE  = [...strikes].sort((a, b) => b.pe.oi - a.pe.oi).slice(0, 3).map(s => s.strike);

  const resistance = topCE[0] || null;
  const support    = topPE[0] || null;

  // ── Significant OI buildup alerts ─────────────────────────────────────────
  const alerts = [];
  for (const row of strikes) {
    if (Math.abs(row.ce.oiChangePct) > 20 && row.ce.oi > 100000) {
      alerts.push({
        strike:    row.strike,
        side:      "CE",
        signal:    row.ce.signal,
        oiChange:  row.ce.oiChange,
        pct:       row.ce.oiChangePct.toFixed(1),
        ltp:       row.ce.ltp,
      });
    }
    if (Math.abs(row.pe.oiChangePct) > 20 && row.pe.oi > 100000) {
      alerts.push({
        strike:    row.strike,
        side:      "PE",
        signal:    row.pe.signal,
        oiChange:  row.pe.oiChange,
        pct:       row.pe.oiChangePct.toFixed(1),
        ltp:       row.pe.ltp,
      });
    }
  }

  // Save snapshot for next delta
  prevSnapshot[key] = { strikes: new Map(strikes.map(s => [s.strike, s])) };

  return {
    underlying,
    expiry,
    spotPrice,
    pcr,
    maxPainStrike,
    resistance,
    support,
    totalCEOI,
    totalPEOI,
    strikes,
    alerts,
    updatedAt: Date.now(),
  };
}

/**
 * Classify OI move:
 *  CE OI ↑ price ↑ → Long Buildup
 *  CE OI ↑ price ↓ → Short Buildup
 *  CE OI ↓ price ↑ → Short Covering
 *  CE OI ↓ price ↓ → Long Unwinding
 *  (same logic for PE)
 */
function classifyOIMove(oi, prevOI, ltp, prevLtp) {
  if (!prevOI || prevOI === oi) return "neutral";
  const oiUp    = oi > prevOI;
  // Price direction: use ltp vs prevLtp if available; otherwise neutral
  const priceUp = prevLtp > 0 ? ltp > prevLtp : null;

  if (oiUp  && priceUp === true)  return "long_buildup";
  if (oiUp  && priceUp === false) return "short_buildup";
  if (!oiUp && priceUp === true)  return "short_covering";
  if (!oiUp && priceUp === false) return "long_unwinding";
  return oiUp ? "buildup" : "unwinding";
}

/**
 * Max pain: strike where total option buyers lose the most
 * = minimize total payout to buyers
 */
function calcMaxPain(strikes) {
  if (!strikes.length) return null;

  let minLoss  = Infinity;
  let maxPain  = strikes[0].strike;

  for (const target of strikes) {
    let totalPayout = 0;
    for (const s of strikes) {
      // CE loss at target: max(target - strike, 0) × CE OI
      if (target.strike > s.strike) {
        totalPayout += (target.strike - s.strike) * s.ce.oi;
      }
      // PE loss at target: max(strike - target, 0) × PE OI
      if (target.strike < s.strike) {
        totalPayout += (s.strike - target.strike) * s.pe.oi;
      }
    }
    if (totalPayout < minLoss) {
      minLoss = totalPayout;
      maxPain = target.strike;
    }
  }

  return maxPain;
}

module.exports = { processOptionChain, classifyOIMove, calcMaxPain };