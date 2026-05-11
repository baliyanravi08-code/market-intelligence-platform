"use strict";
// server/routes/straddleRoutes.js
// Straddle & Strangle analytics route
// Uses existing optionChainCache.json + live Upstox data
// NEW: /iv-rank route for IV Percentile + IV Rank

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const CACHE_PATH   = path.join(__dirname, "../data/optionChainCache.json");
const HISTORY_PATH = path.join(__dirname, "../data/ivHistory.json"); // NEW

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch { return null; }
}

// NEW: read IV history
function readIVHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  } catch { return {}; }
}

function findATMStrike(strikes, spotPrice) {
  return strikes.reduce((prev, curr) =>
    Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
  );
}

function getStrangleStrikes(strikes, atmStrike, steps = 1) {
  const sorted = [...strikes].sort((a, b) => a - b);
  const atmIdx = sorted.indexOf(atmStrike);
  return {
    callStrike: sorted[atmIdx + steps] ?? atmStrike,
    putStrike:  sorted[atmIdx - steps] ?? atmStrike,
  };
}

function buildPayoffCurve({ callStrike, putStrike, callPremium, putPremium, type, side, lotSize = 1 }) {
  const totalPremium = callPremium + putPremium;
  const lowerBE = putStrike  - totalPremium;
  const upperBE = callStrike + totalPremium;
  const mid     = (callStrike + putStrike) / 2;
  const range   = mid * 0.3;
  const step    = range / 50;
  const points  = [];

  for (let price = mid - range; price <= mid + range; price += step) {
    let callPL, putPL;
    if (side === "buy") {
      callPL = Math.max(0, price - callStrike) - callPremium;
      putPL  = Math.max(0, putStrike - price)  - putPremium;
    } else {
      callPL = callPremium - Math.max(0, price - callStrike);
      putPL  = putPremium  - Math.max(0, putStrike - price);
    }
    points.push({
      price: Math.round(price),
      pl:    Math.round((callPL + putPL) * lotSize * 100) / 100,
    });
  }

  return {
    points,
    maxProfit:       side === "buy" ? null : Math.round(totalPremium * lotSize * 100) / 100,
    maxLoss:         side === "buy" ? Math.round(-totalPremium * lotSize * 100) / 100 : null,
    upperBreakeven:  Math.round(upperBE * 100) / 100,
    lowerBreakeven:  Math.round(lowerBE * 100) / 100,
    totalPremium:    Math.round(totalPremium * 100) / 100,
  };
}

// ─── GET /api/straddle/snapshot ───────────────────────────────────────────────

router.get("/snapshot", (req, res) => {
  try {
    const { symbol = "NIFTY", expiry } = req.query;
    const cache = readCache();
    if (!cache) return res.status(503).json({ error: "Option chain cache not available" });

    const chainData = cache[symbol] || cache;
    if (!chainData) return res.status(404).json({ error: `No data for symbol: ${symbol}` });

    const spotPrice  = chainData.spotPrice || chainData.underlyingValue || 0;
    const expiryList = chainData.expiries  || Object.keys(chainData.chains || {});
    const targetExpiry  = expiry || expiryList[0];
    const chainExpiry   = chainData.chains?.[targetExpiry];
    const strikesArr    = chainExpiry?.strikes || [];

    if (!strikesArr.length) return res.status(404).json({ error: "No strikes found in cache" });

    const strikes    = strikesArr.map(s => s.strike).sort((a, b) => a - b);
    const spotPrice2 = chainExpiry.spotPrice || spotPrice;
    const atmStrike  = chainExpiry.atmStrike || findATMStrike(strikes, spotPrice2);
    const atmRow     = strikesArr.find(s => s.strike === atmStrike)
                    || strikesArr[Math.floor(strikesArr.length / 2)];

    const cePrice = atmRow?.ce?.ltp ?? 0;
    const pePrice = atmRow?.pe?.ltp ?? 0;
    const straddlePremium = cePrice + pePrice;

    const ceIV  = atmRow?.ce?.iv ?? 0;
    const peIV  = atmRow?.pe?.iv ?? 0;
    const atmIV = ((ceIV + peIV) / 2).toFixed(2);

    const { callStrike: scStrike, putStrike: spStrike } = getStrangleStrikes(strikes, atmStrike, 1);
    const scRow = strikesArr.find(s => s.strike === scStrike) || {};
    const spRow = strikesArr.find(s => s.strike === spStrike) || {};
    const scePrice       = scRow?.ce?.ltp ?? 0;
    const spePrice       = spRow?.pe?.ltp ?? 0;
    const stranglePremium = scePrice + spePrice;

    const ceOI = atmRow?.ce?.oi ?? 0;
    const peOI = atmRow?.pe?.oi ?? 0;
    const pcr  = peOI && ceOI ? (peOI / ceOI).toFixed(2) : (chainExpiry?.pcr ?? null);

    res.json({
      symbol, expiry: targetExpiry, spotPrice: spotPrice2, atmStrike,
      timestamp: new Date().toISOString(),
      straddle: {
        callStrike: atmStrike, putStrike: atmStrike,
        callPremium: cePrice, putPremium: pePrice, combined: straddlePremium,
        upperBreakeven: +(atmStrike + straddlePremium).toFixed(2),
        lowerBreakeven: +(atmStrike - straddlePremium).toFixed(2),
      },
      strangle: {
        callStrike: scStrike, putStrike: spStrike,
        callPremium: scePrice, putPremium: spePrice, combined: stranglePremium,
        upperBreakeven: +(scStrike + stranglePremium).toFixed(2),
        lowerBreakeven: +(spStrike - stranglePremium).toFixed(2),
      },
      iv:     { atm: +atmIV, ce: +ceIV, pe: +peIV },
      greeks: {
        delta: { ce: atmRow?.ce?.delta ?? null, pe: atmRow?.pe?.delta ?? null },
        theta: { ce: atmRow?.ce?.theta ?? null, pe: atmRow?.pe?.theta ?? null },
        vega:  { ce: atmRow?.ce?.vega  ?? null, pe: atmRow?.pe?.vega  ?? null },
      },
      oi:      { ce: ceOI, pe: peOI, pcr },
      expiries: expiryList,
    });
  } catch (err) {
    console.error("[straddleRoutes] /snapshot error:", err);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

// ─── GET /api/straddle/payoff ─────────────────────────────────────────────────

router.get("/payoff", (req, res) => {
  try {
    const { symbol = "NIFTY", expiry, type = "straddle", side = "sell", steps = 1 } = req.query;
    const cache = readCache();
    if (!cache) return res.status(503).json({ error: "Option chain cache not available" });

    const chainData  = cache[symbol] || cache;
    const spotPrice  = chainData.spotPrice || chainData.underlyingValue || 0;
    const expiryList = chainData.expiries  || Object.keys(chainData.chains || {});
    const targetExpiry  = expiry || expiryList[0];
    const chainExpiry   = chainData.chains?.[targetExpiry];
    const strikesArr    = chainExpiry?.strikes || [];

    if (!strikesArr.length) return res.status(404).json({ error: "No strikes found" });

    const strikes    = strikesArr.map(s => s.strike).sort((a, b) => a - b);
    const spotPrice2 = chainExpiry?.spotPrice || spotPrice;
    const atmStrike  = chainExpiry?.atmStrike || findATMStrike(strikes, spotPrice2);

    let callStrike, putStrike, callPremium, putPremium;

    if (type === "straddle") {
      callStrike = putStrike = atmStrike;
      const atmRow = strikesArr.find(s => s.strike === atmStrike) || {};
      callPremium = atmRow?.ce?.ltp ?? 0;
      putPremium  = atmRow?.pe?.ltp ?? 0;
    } else {
      const { callStrike: cs, putStrike: ps } = getStrangleStrikes(strikes, atmStrike, +steps);
      callStrike  = cs; putStrike = ps;
      callPremium = strikesArr.find(s => s.strike === cs)?.ce?.ltp ?? 0;
      putPremium  = strikesArr.find(s => s.strike === ps)?.pe?.ltp ?? 0;
    }

    const lotSize = symbol === "BANKNIFTY"  ? 35
                  : symbol === "FINNIFTY"   ? 65
                  : symbol === "MIDCPNIFTY" ? 120
                  : symbol === "SENSEX"     ? 20
                  : 75;

    const payoff = buildPayoffCurve({ callStrike, putStrike, callPremium, putPremium, type, side, lotSize });

    res.json({
      symbol, expiry: targetExpiry, type, side,
      atmStrike, spotPrice: spotPrice2, lotSize,
      callStrike, putStrike, callPremium, putPremium,
      ...payoff,
    });
  } catch (err) {
    console.error("[straddleRoutes] /payoff error:", err);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

// ─── GET /api/straddle/history ────────────────────────────────────────────────

router.get("/history", (req, res) => {
  try {
    const { symbol = "NIFTY" } = req.query;
    const liveBookPath = path.join(__dirname, "../data/liveOrderBook.json");
    if (fs.existsSync(liveBookPath)) {
      const raw     = JSON.parse(fs.readFileSync(liveBookPath, "utf8"));
      const history = raw[symbol]?.straddleHistory || [];
      return res.json({ symbol, history });
    }
    res.json({ symbol, history: [] });
  } catch (err) {
    console.error("[straddleRoutes] /history error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── NEW: GET /api/straddle/iv-rank ──────────────────────────────────────────
/**
 * Returns IV Rank, IV Percentile, current IV, and full history for charting.
 *
 * IV Rank      = (currentIV - 52wLow) / (52wHigh - 52wLow) × 100
 * IV Percentile = % of days in the last 252 trading days where IV was BELOW current IV
 *
 * Query params:
 *   symbol  — NIFTY | BANKNIFTY | etc  (default: NIFTY)
 *   days    — lookback window in days   (default: 252 = ~1 trading year)
 */
router.get("/iv-rank", (req, res) => {
  try {
    const { symbol = "NIFTY", days = 252 } = req.query;
    const lookback = Math.min(+days, 365);

    // ── 1. Get current live IV from option chain cache ────────────────────
    const cache = readCache();
    let currentIV = null;

    if (cache && cache[symbol]) {
      const chainData  = cache[symbol];
      const spotPrice  = chainData.spotPrice || chainData.underlyingValue || 0;
      const expiryList = chainData.expiries  || Object.keys(chainData.chains || {});
      const nearExpiry = expiryList[0];
      const chainExp   = chainData.chains?.[nearExpiry];
      const strikesArr = chainExp?.strikes || [];

      if (strikesArr.length) {
        const strikes   = strikesArr.map(s => s.strike).sort((a, b) => a - b);
        const atmStrike = chainExp.atmStrike || findATMStrike(strikes, spotPrice);
        const atmRow    = strikesArr.find(s => s.strike === atmStrike);
        if (atmRow) {
          const ceIV = atmRow?.ce?.iv ?? 0;
          const peIV = atmRow?.pe?.iv ?? 0;
          if (ceIV || peIV) currentIV = +((ceIV + peIV) / 2).toFixed(2);
        }
      }
    }

    // ── 2. Load history ───────────────────────────────────────────────────
    const allHistory  = readIVHistory();
    const symbolHist  = allHistory[symbol] || [];

    // Take the last `lookback` entries
    const window = symbolHist
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-lookback);

    // ── 3. Compute IV Rank + IV Percentile ────────────────────────────────
    let ivRank       = null;
    let ivPercentile = null;
    let high52w      = null;
    let low52w       = null;

    if (window.length >= 2) {
      const ivValues = window.map(e => e.iv);
      high52w = Math.max(...ivValues);
      low52w  = Math.min(...ivValues);

      // Use live IV if available, otherwise use the most recent historical entry
      const refIV = currentIV ?? window[window.length - 1].iv;

      if (high52w !== low52w) {
        ivRank = +((refIV - low52w) / (high52w - low52w) * 100).toFixed(1);
        ivRank = Math.min(100, Math.max(0, ivRank));
      } else {
        ivRank = 50; // only one unique value — rank is indeterminate
      }

      // IV Percentile: % of days where IV was below current
      const belowCount = ivValues.filter(v => v < refIV).length;
      ivPercentile     = +((belowCount / ivValues.length) * 100).toFixed(1);
    }

    // ── 4. Interpretation signal ──────────────────────────────────────────
    let signal = "neutral";
    let signalText = "Insufficient data";

    if (ivRank !== null) {
      if (ivRank >= 70) {
        signal     = "sell";
        signalText = `IV Rank ${ivRank} — IV is historically HIGH. Premium is expensive. Favour selling straddle/strangle.`;
      } else if (ivRank <= 30) {
        signal     = "buy";
        signalText = `IV Rank ${ivRank} — IV is historically LOW. Premium is cheap. Favour buying straddle/strangle.`;
      } else {
        signal     = "neutral";
        signalText = `IV Rank ${ivRank} — IV is in the middle of its historical range. No strong edge either way.`;
      }
    }

    // ── 5. Respond ────────────────────────────────────────────────────────
    res.json({
      symbol,
      currentIV,
      ivRank,
      ivPercentile,
      high52w,
      low52w,
      dataPoints:  window.length,
      lookbackDays: lookback,
      signal,
      signalText,
      // Full history array for the chart (date + iv pairs)
      history: window,
      // Also include today's entry if live IV differs from last recorded
      note: window.length < 30
        ? `Only ${window.length} days of data so far. IV Rank becomes meaningful after 30+ days and reliable after 90+ days.`
        : null,
    });

  } catch (err) {
    console.error("[straddleRoutes] /iv-rank error:", err);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

module.exports = router;