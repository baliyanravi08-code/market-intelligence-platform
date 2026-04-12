"use strict";

/**
 * optionsIntelligenceEngine.js
 * Location: server/services/intelligence/optionsIntelligenceEngine.js
 *
 * PURE SERVER-SIDE NODE.JS — NO JSX, NO REACT, NO FRONTEND CODE.
 *
 * FIXES applied:
 *
 * FIX 1 — IV Rank flipping 100 ↔ 0 between refreshes:
 *   Returns { ivRank: 50, ivPercentile: 50, synthetic: true } when insufficient
 *   history instead of null. Falls back to hv20/hv60 synthetic window.
 *
 * FIX 2 — Theta doubling between refreshes:
 *   Returns both callTheta and straddleTheta clearly labelled in atmGreeks.
 *
 * FIX 3 — netPremiumFlow recalculated from scratch each call:
 *   analyzeOI() accepts optional prevVolMap and computes DELTA flow since last
 *   call. Falls back to full calculation when prevVolMap not provided.
 *
 * FIX 4 — computeOptionsScore() score changing by ±10 on every refresh:
 *   PCR score adjustment uses sigmoid-style clamp instead of linear step.
 */

const SQRT_2PI           = Math.sqrt(2 * Math.PI);
const INDIA_RF           = 0.065;
const TRADING_DAYS_YEAR  = 252;
const CALENDAR_DAYS_YEAR = 365;

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────

function normCDF(x) {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function normPDF(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// ─────────────────────────────────────────────────────────────────────────────
// Black-Scholes
// ─────────────────────────────────────────────────────────────────────────────

function bsPrice({ S, K, T, r, sigma, type, useBlack76 = false }) {
  if (T <= 0) {
    const intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, d1: 0, d2: 0 };
  }
  const sqrtT = Math.sqrt(T);
  let d1, d2;
  if (useBlack76) {
    d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
    d2 = d1 - sigma * sqrtT;
    const discount = Math.exp(-r * T);
    const price = type === 'call'
      ? discount * (S * normCDF(d1) - K * normCDF(d2))
      : discount * (K * normCDF(-d2) - S * normCDF(-d1));
    return { price, d1, d2 };
  }
  d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  d2 = d1 - sigma * sqrtT;
  const price = type === 'call'
    ? S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
    : K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
  return { price, d1, d2 };
}

function computeGreeks({ S, K, T, r, sigma, type, useBlack76 = false }) {
  if (T <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, lambda: 0 };
  const { d1, d2 } = bsPrice({ S, K, T, r, sigma, type, useBlack76 });
  const sqrtT  = Math.sqrt(T);
  const pdf_d1 = normPDF(d1);
  const disc   = Math.exp(-r * T);
  let delta;
  if (useBlack76) {
    delta = type === 'call' ? disc * normCDF(d1) : disc * (normCDF(d1) - 1);
  } else {
    delta = type === 'call' ? normCDF(d1) : normCDF(d1) - 1;
  }
  const gamma = (useBlack76 ? disc : 1) * pdf_d1 / (S * sigma * sqrtT);
  let theta;
  if (useBlack76) {
    theta = (-S * pdf_d1 * sigma * disc / (2 * sqrtT)
             - r * disc * (type === 'call'
               ? (S * normCDF(d1) - K * normCDF(d2))
               : (K * normCDF(-d2) - S * normCDF(-d1)))) / CALENDAR_DAYS_YEAR;
  } else {
    theta = type === 'call'
      ? (-(S * pdf_d1 * sigma) / (2 * sqrtT) - r * K * disc * normCDF(d2))  / CALENDAR_DAYS_YEAR
      : (-(S * pdf_d1 * sigma) / (2 * sqrtT) + r * K * disc * normCDF(-d2)) / CALENDAR_DAYS_YEAR;
  }
  const vega   = S * sqrtT * pdf_d1 * (useBlack76 ? disc : 1) / 100;
  const rho    = type === 'call'
    ?  K * T * disc * normCDF(d2)  / 100
    : -K * T * disc * normCDF(-d2) / 100;
  const { price } = bsPrice({ S, K, T, r, sigma, type, useBlack76 });
  const lambda = price > 0.01 ? delta * S / price : 0;
  return { delta, gamma, theta, vega, rho, lambda };
}

// ─────────────────────────────────────────────────────────────────────────────
// IV solver
// ─────────────────────────────────────────────────────────────────────────────

function solveIV(marketPrice, params) {
  const { S, K, T, r, type, useBlack76 = false } = params;
  if (T <= 0 || marketPrice <= 0) return null;
  const intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (marketPrice < intrinsic * 0.99) return null;
  let sigma = Math.sqrt(Math.abs(2 * Math.PI / T) * (marketPrice / S));
  if (sigma < 0.01) sigma = 0.20;
  if (sigma > 5.0)  sigma = 5.0;
  const MAX_ITER = 100;
  const TOL      = 1e-6;
  for (let i = 0; i < MAX_ITER; i++) {
    const { price } = bsPrice({ S, K, T, r, sigma, type, useBlack76 });
    const { vega }  = computeGreeks({ S, K, T, r, sigma, type, useBlack76 });
    const vegaActual = vega * 100;
    if (Math.abs(vegaActual) < 1e-10) break;
    const diff   = price - marketPrice;
    const newSig = sigma - diff / vegaActual;
    if (newSig <= 0) { sigma = sigma / 2; continue; }
    sigma = newSig;
    if (Math.abs(diff) < TOL) return sigma;
  }
  return sigma > 0.001 && sigma < 5.0 ? sigma : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Historical volatility
// ─────────────────────────────────────────────────────────────────────────────

function historicalVolatility(closes, window) {
  if (!closes || closes.length < window + 1) return null;
  const relevant   = closes.slice(-(window + 1));
  const logReturns = [];
  for (let i = 1; i < relevant.length; i++) {
    if (relevant[i - 1] > 0 && relevant[i] > 0) {
      logReturns.push(Math.log(relevant[i] / relevant[i - 1]));
    }
  }
  if (logReturns.length < 2) return null;
  const mean     = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance * TRADING_DAYS_YEAR);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — IV Rank: never return null
// ─────────────────────────────────────────────────────────────────────────────

function ivRankAndPercentile(currentIV, historicalIVs, hv20 = null, hv60 = null) {
  let ivs = Array.isArray(historicalIVs) ? historicalIVs.filter(v => v > 0) : [];

  if (ivs.length < 10 && (hv20 || hv60)) {
    const base  = hv20 || hv60;
    const synth = [];
    for (let i = 0; i < 12; i++) synth.push(base * (0.7 + i * 0.05));
    ivs = [...synth, ...ivs];
  }

  if (ivs.length < 5) return { ivRank: 50, ivPercentile: 50, synthetic: true };

  const iv     = currentIV || (hv20 || hv60 || 0.20);
  const ivHigh = Math.max(...ivs);
  const ivLow  = Math.min(...ivs);

  const ivRank = ivHigh > ivLow
    ? ((iv - ivLow) / (ivHigh - ivLow)) * 100
    : 50;

  const below        = ivs.filter(v => v < iv).length;
  const ivPercentile = (below / ivs.length) * 100;

  return {
    ivRank:       Math.round(Math.min(100, Math.max(0, ivRank))),
    ivPercentile: Math.round(Math.min(100, Math.max(0, ivPercentile))),
    synthetic:    false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GEX
// ─────────────────────────────────────────────────────────────────────────────

function computeGEX(chain, spot, T, r, lotSize = 1) {
  if (!chain || chain.length === 0) return null;
  let netGEX = 0, callGEX = 0, putGEX = 0;
  const strikeGEX = [];
  for (const row of chain) {
    const { strike, callOI = 0, putOI = 0, callIV, putIV } = row;
    if (!strike || strike <= 0) continue;
    const civSafe    = callIV || 0.20;
    const pivSafe    = putIV  || 0.20;
    const callGreeks = computeGreeks({ S: spot, K: strike, T, r, sigma: civSafe, type: 'call' });
    const putGreeks  = computeGreeks({ S: spot, K: strike, T, r, sigma: pivSafe, type: 'put'  });
    const cgex = callGreeks.gamma * callOI * lotSize * spot * spot;
    const pgex = putGreeks.gamma  * putOI  * lotSize * spot * spot;
    callGEX += cgex;
    putGEX  += pgex;
    netGEX  += cgex - pgex;
    strikeGEX.push({ strike, callGEX: cgex, putGEX: pgex, netGEX: cgex - pgex });
  }
  const sorted   = [...strikeGEX].sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX));
  const callWall = strikeGEX.filter(s => s.strike > spot && s.callGEX > 0).sort((a, b) => b.callGEX - a.callGEX)[0]?.strike || null;
  const putWall  = strikeGEX.filter(s => s.strike < spot && s.putGEX  > 0).sort((a, b) => b.putGEX  - a.putGEX )[0]?.strike || null;
  const gammaFlip = (() => {
    const aboveSpot = strikeGEX.filter(s => s.strike >= spot).sort((a, b) => a.strike - b.strike);
    for (let i = 1; i < aboveSpot.length; i++) {
      if (aboveSpot[i-1].netGEX >= 0 && aboveSpot[i].netGEX < 0) return aboveSpot[i].strike;
      if (aboveSpot[i-1].netGEX <  0 && aboveSpot[i].netGEX > 0) return aboveSpot[i].strike;
    }
    return null;
  })();
  const regime = netGEX > 0 ? 'MEAN_REVERTING' : 'TREND_AMPLIFYING';
  return {
    netGEX:    Math.round(netGEX  / 1e7) / 10,
    callGEX:   Math.round(callGEX / 1e7) / 10,
    putGEX:    Math.round(putGEX  / 1e7) / 10,
    callWall, putWall, gammaFlip, regime,
    topStrikes: sorted.slice(0, 5).map(s => ({ strike: s.strike, netGEX: Math.round(s.netGEX / 1e7) / 10 })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dealer exposures
// ─────────────────────────────────────────────────────────────────────────────

function computeDealerExposures(chain, spot, T, r, lotSize = 1) {
  let dex = 0, vex = 0, chex = 0;
  for (const row of chain) {
    const { strike, callOI = 0, putOI = 0, callIV, putIV } = row;
    if (!strike) continue;
    const civSafe = callIV || 0.20;
    const pivSafe = putIV  || 0.20;
    const cDelta  = computeGreeks({ S: spot, K: strike, T, r, sigma: civSafe, type: 'call' }).delta;
    const pDelta  = computeGreeks({ S: spot, K: strike, T, r, sigma: pivSafe, type: 'put'  }).delta;
    dex += (cDelta * callOI - pDelta * putOI) * lotSize * spot;
    const { d1: cd1, d2: cd2 } = bsPrice({ S: spot, K: strike, T, r, sigma: civSafe, type: 'call' });
    const { d1: pd1, d2: pd2 } = bsPrice({ S: spot, K: strike, T, r, sigma: pivSafe, type: 'put'  });
    const cVanna = -normPDF(cd1) * cd2 / civSafe;
    const pVanna = -normPDF(pd1) * pd2 / pivSafe;
    vex += (cVanna * callOI - pVanna * putOI) * lotSize;
    const sqrtT  = Math.sqrt(T);
    const cCharm = normPDF(cd1) * (2 * r * T - cd2 * civSafe * sqrtT) / (2 * T * civSafe * sqrtT);
    const pCharm = normPDF(pd1) * (2 * r * T - pd2 * pivSafe * sqrtT) / (2 * T * pivSafe * sqrtT);
    chex += (cCharm * callOI - pCharm * putOI) * lotSize;
  }
  return {
    dex:  Math.round(dex  / 1e7) / 10,
    vex:  Math.round(vex  / 1e5) / 10,
    chex: Math.round(chex / 1e5) / 10,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3 — OI analysis: delta-based net flow
// ─────────────────────────────────────────────────────────────────────────────

function analyzeOI(chain, spot, prevVolMap = null) {
  if (!chain || chain.length === 0) return null;
  let totalCallOI = 0, totalPutOI = 0, totalCallVol = 0, totalPutVol = 0;
  let netPremiumFlow = 0;
  const unusualOI = [];

  for (const row of chain) {
    totalCallOI  += row.callOI  || 0;
    totalPutOI   += row.putOI   || 0;
    totalCallVol += row.callVol || 0;
    totalPutVol  += row.putVol  || 0;

    if (prevVolMap) {
      const prevCeVol = prevVolMap[`${row.strike}_ce`] || 0;
      const prevPeVol = prevVolMap[`${row.strike}_pe`] || 0;
      const dCeVol    = Math.max(0, (row.callVol || 0) - prevCeVol);
      const dPeVol    = Math.max(0, (row.putVol  || 0) - prevPeVol);
      netPremiumFlow += (dPeVol * (row.putLTP  || 0)) - (dCeVol * (row.callLTP || 0));
    } else {
      netPremiumFlow += ((row.putLTP || 0) * (row.putVol || 0)) - ((row.callLTP || 0) * (row.callVol || 0));
    }

    const callRatio = row.callVol > 100 ? row.callOI / row.callVol : null;
    const putRatio  = row.putVol  > 100 ? row.putOI  / row.putVol  : null;
    if (callRatio !== null && callRatio < 0.5 && row.callVol > 1000)
      unusualOI.push({ strike: row.strike, type: 'call', oi: row.callOI, vol: row.callVol, note: 'Unusual call activity — fresh positioning likely' });
    if (putRatio  !== null && putRatio  < 0.5 && row.putVol  > 1000)
      unusualOI.push({ strike: row.strike, type: 'put',  oi: row.putOI,  vol: row.putVol,  note: 'Unusual put activity — institutional hedge/bet likely' });
  }

  const pcr    = totalCallOI  > 0 ? totalPutOI  / totalCallOI  : null;
  const pcrVol = totalCallVol > 0 ? totalPutVol / totalCallVol : null;
  const maxPain = computeMaxPain(chain);
  const oiAbove = chain.filter(r => r.strike >  spot).reduce((s, r) => s + (r.callOI || 0) + (r.putOI || 0), 0);
  const oiBelow = chain.filter(r => r.strike <= spot).reduce((s, r) => s + (r.callOI || 0) + (r.putOI || 0), 0);
  const oiSkew  = oiAbove + oiBelow > 0 ? (oiBelow - oiAbove) / (oiAbove + oiBelow) : 0;

  let pcrSentiment = 'NEUTRAL';
  if (pcr !== null) {
    if      (pcr > 1.5) pcrSentiment = 'STRONGLY_BEARISH';
    else if (pcr > 1.2) pcrSentiment = 'BEARISH';
    else if (pcr < 0.6) pcrSentiment = 'STRONGLY_BULLISH';
    else if (pcr < 0.8) pcrSentiment = 'BULLISH';
  }

  return {
    pcr:           pcr    !== null ? Math.round(pcr    * 100) / 100 : null,
    pcrVol:        pcrVol !== null ? Math.round(pcrVol * 100) / 100 : null,
    pcrSentiment, totalCallOI, totalPutOI, maxPain,
    netPremiumFlow: Math.round(netPremiumFlow / 1e5) / 10,
    premiumBias:    netPremiumFlow > 0 ? 'PUT_DOMINATED' : 'CALL_DOMINATED',
    oiSkew:         Math.round(oiSkew * 100) / 100,
    unusualOI:      unusualOI.slice(0, 10),
    unusualCount:   unusualOI.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Max pain
// ─────────────────────────────────────────────────────────────────────────────

function computeMaxPain(chain) {
  if (!chain || chain.length === 0) return null;
  let minPain = Infinity, maxPainStrike = null;
  for (const target of chain) {
    const k = target.strike;
    let totalPain = 0;
    for (const row of chain) {
      totalPain += (row.callOI || 0) * Math.max(k - row.strike, 0);
      totalPain += (row.putOI  || 0) * Math.max(row.strike - k, 0);
    }
    if (totalPain < minPain) { minPain = totalPain; maxPainStrike = k; }
  }
  return maxPainStrike;
}

// ─────────────────────────────────────────────────────────────────────────────
// Volatility surface
// ─────────────────────────────────────────────────────────────────────────────

function computeVolatilitySurface(chain, spot, T, r) {
  if (!chain || chain.length === 0) return null;
  const atm   = chain.reduce((best, row) => Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best);
  const atmIV = atm.callIV || atm.putIV || null;
  const callIVs = chain.filter(r => r.callIV > 0.01 && r.callIV < 3).map(r => ({ strike: r.strike, iv: r.callIV, moneyness: Math.log(r.strike / spot) }));
  const sigma = atmIV || 0.20;
  const sqrtT = Math.sqrt(T);
  const k25call = spot * Math.exp((0.674 * sigma * sqrtT) + (r - 0.5 * sigma * sigma) * T);
  const k25put  = spot * Math.exp((-0.674 * sigma * sqrtT) + (r - 0.5 * sigma * sigma) * T);
  const nearest = (target, arr) => arr.reduce((b, x) => Math.abs(x.strike - target) < Math.abs(b.strike - target) ? x : b);
  const callsWithIV = chain.filter(r => r.callIV > 0);
  const putsWithIV  = chain.filter(r => r.putIV  > 0);
  const call25      = callsWithIV.length > 0 ? nearest(k25call, callsWithIV) : null;
  const put25       = putsWithIV.length  > 0 ? nearest(k25put,  putsWithIV)  : null;
  const iv25call    = call25?.callIV || null;
  const iv25put     = put25?.putIV   || null;
  const skew25      = iv25call && iv25put ? Math.round((iv25put - iv25call) * 100 * 100) / 100 : null;
  let skewSentiment = 'NEUTRAL';
  if (skew25 !== null) {
    if      (skew25 > 5)  skewSentiment = 'BEARISH_HEAVY';
    else if (skew25 > 2)  skewSentiment = 'BEARISH';
    else if (skew25 < -2) skewSentiment = 'BULLISH';
    else if (skew25 < -5) skewSentiment = 'BULLISH_HEAVY';
  }
  const ivRange = callIVs.length > 2
    ? { min: Math.min(...callIVs.map(x => x.iv)), max: Math.max(...callIVs.map(x => x.iv)) }
    : null;
  return {
    atmIV:    atmIV ? Math.round(atmIV * 10000) / 100 : null,
    skew25, skewSentiment,
    iv25call: iv25call ? Math.round(iv25call * 10000) / 100 : null,
    iv25put:  iv25put  ? Math.round(iv25put  * 10000) / 100 : null,
    ivRange:  ivRange  ? { min: Math.round(ivRange.min * 10000) / 100, max: Math.round(ivRange.max * 10000) / 100 } : null,
    smilePoints: callIVs.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Market structure
// ─────────────────────────────────────────────────────────────────────────────

function computeMarketStructure({ chain, spot, T, atmIV, hv20, historicalIVs }) {
  const atm             = chain.reduce((best, row) => Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best);
  const straddlePrice   = (atm.callLTP || 0) + (atm.putLTP || 0);
  const expectedMoveAbs = straddlePrice * 0.84;
  const expectedMovePct = expectedMoveAbs / spot * 100;
  let vrp = null;
  if (atmIV && hv20) vrp = (atmIV - hv20) * 100;
  let ivEnvironment = 'NORMAL';
  if (vrp !== null) {
    if      (vrp >  8) ivEnvironment = 'RICH_SELL_PREMIUM';
    else if (vrp >  4) ivEnvironment = 'ELEVATED';
    else if (vrp < -4) ivEnvironment = 'CHEAP_BUY_OPTIONS';
    else if (vrp < -8) ivEnvironment = 'VERY_CHEAP';
  }
  let eventRiskScore = 0;
  if (atmIV && historicalIVs && historicalIVs.length > 10) {
    const avgIV = historicalIVs.reduce((a, b) => a + b, 0) / historicalIVs.length;
    eventRiskScore = Math.min(100, Math.max(0, ((atmIV - avgIV) / avgIV) * 100));
  }
  return {
    straddlePrice:    Math.round(straddlePrice   * 100) / 100,
    expectedMoveAbs:  Math.round(expectedMoveAbs * 100) / 100,
    expectedMovePct:  Math.round(expectedMovePct * 100) / 100,
    vrp:              vrp !== null ? Math.round(vrp * 100) / 100 : null,
    ivEnvironment,
    eventRiskScore:   Math.round(eventRiskScore),
    supportFromOI:    null,
    resistanceFromOI: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy radar
// ─────────────────────────────────────────────────────────────────────────────

function computeStrategyRadar({ ivRank, ivPercentile, vrp, skew25, pcr, gex, ivEnvironment, oi }) {
  const signals = [];
  if (ivRank > 70 || ivEnvironment === 'RICH_SELL_PREMIUM')
    signals.push({ strategy: 'SELL_PREMIUM', confidence: Math.min(100, ivRank || 70), note: `IV rank ${ivRank}% — options expensive. Consider credit spreads, iron condors.`, direction: 'NEUTRAL' });
  if (ivRank < 30 || ivEnvironment === 'CHEAP_BUY_OPTIONS')
    signals.push({ strategy: 'BUY_OPTIONS', confidence: Math.min(100, 100 - (ivRank || 50)), note: `IV rank ${ivRank}% — options cheap. Consider straddles before events.`, direction: 'NEUTRAL' });
  if (skew25 !== null && skew25 > 6)
    signals.push({ strategy: 'SKEW_TRADE', confidence: Math.min(100, skew25 * 10), note: `25-delta skew ${skew25}% — puts very expensive. Bull risk reversal has edge.`, direction: 'BULLISH' });
  if (pcr !== null && pcr > 1.4 && gex && gex.regime === 'TREND_AMPLIFYING')
    signals.push({ strategy: 'DEFENSIVE', confidence: 80, note: `PCR ${pcr} + negative GEX — dealer hedging amplifies downside. Hedge longs.`, direction: 'BEARISH' });
  if (gex && gex.gammaFlip && gex.gammaFlip > 0)
    signals.push({ strategy: 'GAMMA_WALL', confidence: 70, note: `Gamma flip at ₹${gex.gammaFlip} — expect pin or rejection near this strike.`, direction: 'NEUTRAL' });
  if (oi && oi.unusualCount > 3)
    signals.push({ strategy: 'UNUSUAL_ACTIVITY', confidence: 75, note: `${oi.unusualCount} unusual OI alerts — institutional positioning detected.`, direction: 'WATCH' });
  return signals.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4 — Options score: smoother PCR adjustment
// ─────────────────────────────────────────────────────────────────────────────

function computeOptionsScore({ oi, gex, volatility, structure, strategy }) {
  let score = 50;
  const factors = [];

  if (oi && oi.pcr !== null) {
    const pcrDev = oi.pcr - 1.0;
    const pcrAdj = -15 * (2 / (1 + Math.exp(-2 * pcrDev)) - 1);
    score += Math.round(pcrAdj);
    factors.push(`PCR ${oi.pcr} → ${oi.pcrSentiment.replace(/_/g,' ').toLowerCase()}`);
  }

  if (gex) {
    if (gex.regime === 'MEAN_REVERTING') { score += 5; factors.push('GEX positive — mean-reverting regime'); }
    else { score -= 8; factors.push('GEX negative — trend-amplifying, higher vol expected'); }
    if (gex.netGEX < -50) { score -= 5; factors.push(`Large negative GEX ₹${gex.netGEX}Cr`); }
  }

  if (volatility && volatility.ivRank !== null) {
    if      (volatility.ivRank > 75) { score -= 5; factors.push(`IV rank ${volatility.ivRank}% — elevated`); }
    else if (volatility.ivRank < 25) { score += 3; factors.push(`IV rank ${volatility.ivRank}% — cheap options`); }
  }

  if (volatility && volatility.skewSentiment) {
    if      (volatility.skewSentiment === 'BEARISH_HEAVY') { score -= 10; factors.push('Put skew extreme'); }
    else if (volatility.skewSentiment === 'BEARISH')       { score -= 5;  factors.push('Bearish IV skew'); }
    else if (volatility.skewSentiment === 'BULLISH')       { score += 5;  factors.push('Bullish IV skew'); }
  }

  if (oi && oi.premiumBias === 'PUT_DOMINATED')    { score -= 5; factors.push(`Net premium: puts dominating ₹${oi.netPremiumFlow}L`); }
  else if (oi && oi.premiumBias === 'CALL_DOMINATED') { score += 5; factors.push('Net premium: calls dominating'); }

  if (oi && oi.unusualCount > 2) factors.push(`${oi.unusualCount} unusual OI spikes`);
  if (structure && structure.eventRiskScore > 60) { score -= 5; factors.push(`Event risk ${structure.eventRiskScore}/100`); }

  const topStrategy = strategy && strategy[0];
  if (topStrategy) factors.push(`Top signal: ${topStrategy.strategy.replace(/_/g,' ').toLowerCase()}`);

  score = Math.round(Math.max(0, Math.min(100, score)));
  const bias       = score >= 60 ? 'BULLISH' : score <= 40 ? 'BEARISH' : 'NEUTRAL';
  const confidence = Math.round(Math.abs(score - 50) * 2);
  return { score, bias, confidence, factors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

function analyzeOptionsChain({
  symbol, spotPrice, chain, expiryDate,
  historicalIVs = [], closes = [], lotSize = 1, riskFreeRate = INDIA_RF,
  prevVolMap = null,
}) {
  if (!chain || chain.length === 0 || !spotPrice)
    return { symbol, error: 'Insufficient data', score: null, bias: null };

  const expiry = new Date(expiryDate);
  const now    = new Date();
  const T      = Math.max(0, (expiry - now) / (1000 * 60 * 60 * 24 * CALENDAR_DAYS_YEAR));

  const enrichedChain = chain.map(row => {
    const out = { ...row };
    if (!out.callIV && out.callLTP > 0.01)
      out.callIV = solveIV(out.callLTP, { S: spotPrice, K: row.strike, T, r: riskFreeRate, type: 'call' });
    if (!out.putIV && out.putLTP > 0.01)
      out.putIV  = solveIV(out.putLTP,  { S: spotPrice, K: row.strike, T, r: riskFreeRate, type: 'put'  });
    return out;
  });

  const atmRow = enrichedChain.reduce((best, row) =>
    Math.abs(row.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? row : best);
  const atmIV  = atmRow.callIV || atmRow.putIV;
  const hv20   = historicalVolatility(closes, 20);
  const hv60   = historicalVolatility(closes, 60);

  const { ivRank, ivPercentile, synthetic: ivSynthetic } = ivRankAndPercentile(atmIV, historicalIVs, hv20, hv60);

  const gex        = computeGEX(enrichedChain, spotPrice, T, riskFreeRate, lotSize);
  const dealerExp  = computeDealerExposures(enrichedChain, spotPrice, T, riskFreeRate, lotSize);
  const oi         = analyzeOI(enrichedChain, spotPrice, prevVolMap);
  const volSurface = computeVolatilitySurface(enrichedChain, spotPrice, T, riskFreeRate);
  const vrp        = atmIV && hv20 ? (atmIV - hv20) * 100 : null;
  const structure  = computeMarketStructure({ chain: enrichedChain, spot: spotPrice, T, atmIV, hv20, historicalIVs });
  if (gex) { structure.supportFromOI = gex.putWall; structure.resistanceFromOI = gex.callWall; }

  const strategy   = computeStrategyRadar({ ivRank, ivPercentile, vrp, skew25: volSurface?.skew25 || null, pcr: oi?.pcr || null, gex, ivEnvironment: structure?.ivEnvironment, oi });

  const volatility = {
    atmIV:         atmIV ? Math.round(atmIV * 10000) / 100 : null,
    hv20:          hv20  ? Math.round(hv20  * 10000) / 100 : null,
    hv60:          hv60  ? Math.round(hv60  * 10000) / 100 : null,
    vrp:           vrp   ? Math.round(vrp   * 100)   / 100 : null,
    ivRank, ivPercentile, ivSynthetic,
    ivEnvironment: structure.ivEnvironment,
    skewSentiment: volSurface?.skewSentiment || null,
    skew25:        volSurface?.skew25        || null,
  };

  const { score, bias, confidence, factors } = computeOptionsScore({ oi, gex, volatility, structure, strategy });

  // FIX 2: compute both call theta and straddle theta
  const atmCallGreeks = computeGreeks({ S: spotPrice, K: atmRow.strike, T, r: riskFreeRate, sigma: atmIV || 0.20, type: 'call' });
  const atmPutGreeks  = computeGreeks({ S: spotPrice, K: atmRow.strike, T, r: riskFreeRate, sigma: atmIV || 0.20, type: 'put' });

  return {
    symbol, spotPrice, expiryDate,
    T:         Math.round(T * 365),
    updatedAt: new Date().toISOString(),
    score, bias, confidence, factors,
    volatility, volSurface, gex, dealerExposures: dealerExp, oi, structure, strategy,
    atmStrike: atmRow.strike,
    atmGreeks: {
      delta:         Math.round(atmCallGreeks.delta * 1000) / 1000,
      gamma:         Math.round(atmCallGreeks.gamma * 10000) / 10000,
      thetaCall:     Math.round(atmCallGreeks.theta * 100) / 100,
      thetaPut:      Math.round(atmPutGreeks.theta  * 100) / 100,
      thetaStraddle: Math.round((atmCallGreeks.theta + atmPutGreeks.theta) * 100) / 100,
      theta:         Math.round(atmCallGreeks.theta * 100) / 100, // legacy compat
      vega:          Math.round(atmCallGreeks.vega  * 100) / 100,
      rho:           Math.round(atmCallGreeks.rho   * 100) / 100,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ingestChainData shim — forwards to optionsIntegration
// ─────────────────────────────────────────────────────────────────────────────

function ingestChainData(symbol, spotPrice, chainData, expiryDate, lotSize) {
  try {
    const { ingestChainData: real } = require("./optionsIntegration");
    real(symbol, spotPrice, chainData, expiryDate, lotSize);
  } catch (e) {
    // non-critical
  }
}

module.exports = {
  analyzeOptionsChain,
  ingestChainData,
  bsPrice,
  computeGreeks,
  solveIV,
  historicalVolatility,
  ivRankAndPercentile,
  computeGEX,
  computeDealerExposures,
  analyzeOI,
  computeMaxPain,
  computeVolatilitySurface,
  computeMarketStructure,
  computeStrategyRadar,
  computeOptionsScore,
  normCDF,
  normPDF,
};