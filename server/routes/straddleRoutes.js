// server/routes/straddleRoutes.js
// Straddle & Strangle analytics route
// Uses existing optionChainCache.json + live Upstox data

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

const CACHE_PATH = path.join(__dirname, "../data/optionChainCache.json");

// ─── Helpers ────────────────────────────────────────────────────────────────

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Find ATM strike closest to the given spot price
 */
function findATMStrike(strikes, spotPrice) {
  return strikes.reduce((prev, curr) =>
    Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
  );
}

/**
 * Get OTM strikes for strangle (n steps away from ATM)
 */
function getStrangleStrikes(strikes, atmStrike, steps = 1) {
  const sorted = [...strikes].sort((a, b) => a - b);
  const atmIdx = sorted.indexOf(atmStrike);
  const callStrike = sorted[atmIdx + steps] ?? atmStrike;
  const putStrike = sorted[atmIdx - steps] ?? atmStrike;
  return { callStrike, putStrike };
}

/**
 * Build payoff curve for straddle/strangle at expiry
 * Returns array of { price, pl } points
 */
function buildPayoffCurve({ callStrike, putStrike, callPremium, putPremium, type, side, lotSize = 1 }) {
  const totalPremium = callPremium + putPremium;
  const lowerBE = putStrike - totalPremium;
  const upperBE = callStrike + totalPremium;

  // Range: ±30% around mid strike
  const mid = (callStrike + putStrike) / 2;
  const range = mid * 0.3;
  const step = range / 50;
  const points = [];

  for (let price = mid - range; price <= mid + range; price += step) {
    let callPL, putPL;

    if (side === "buy") {
      // Long straddle/strangle: buy CE + buy PE
      callPL = Math.max(0, price - callStrike) - callPremium;
      putPL = Math.max(0, putStrike - price) - putPremium;
    } else {
      // Short straddle/strangle: sell CE + sell PE
      callPL = callPremium - Math.max(0, price - callStrike);
      putPL = putPremium - Math.max(0, putStrike - price);
    }

    points.push({
      price: Math.round(price),
      pl: Math.round((callPL + putPL) * lotSize * 100) / 100,
    });
  }

  return {
    points,
    maxProfit: side === "buy" ? null : Math.round(totalPremium * lotSize * 100) / 100,
    maxLoss: side === "buy" ? Math.round(-totalPremium * lotSize * 100) / 100 : null,
    upperBreakeven: Math.round(upperBE * 100) / 100,
    lowerBreakeven: Math.round(lowerBE * 100) / 100,
    totalPremium: Math.round(totalPremium * 100) / 100,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/straddle/snapshot
 * Returns current ATM straddle + strangle data for a symbol
 * Query: symbol (NIFTY | BANKNIFTY | FINNIFTY), expiry (optional)
 */
router.get("/snapshot", (req, res) => {
  try {
    const { symbol = "NIFTY", expiry } = req.query;
    const cache = readCache();

    if (!cache) {
      return res.status(503).json({ error: "Option chain cache not available" });
    }

    // Support both flat cache and nested by symbol
    const chainData = cache[symbol] || cache;
    if (!chainData) {
      return res.status(404).json({ error: `No data for symbol: ${symbol}` });
    }

    const spotPrice = chainData.spotPrice || chainData.underlyingValue || 0;
    const expiryList = chainData.expiries || Object.keys(chainData.data || {});
    const targetExpiry = expiry || expiryList[0];
    const optionsByStrike = chainData.data?.[targetExpiry] || chainData.options || {};

    const strikes = Object.keys(optionsByStrike).map(Number).sort((a, b) => a - b);
    if (!strikes.length) {
      return res.status(404).json({ error: "No strikes found in cache" });
    }

    const atmStrike = findATMStrike(strikes, spotPrice);
    const atmData = optionsByStrike[atmStrike] || {};

    // CE and PE premiums at ATM (last traded price)
    const cePrice = atmData.CE?.lastPrice ?? atmData.CE?.ltp ?? 0;
    const pePrice = atmData.PE?.lastPrice ?? atmData.PE?.ltp ?? 0;
    const straddlePremium = cePrice + pePrice;

    // CE and PE IV at ATM
    const ceIV = atmData.CE?.impliedVolatility ?? atmData.CE?.iv ?? 0;
    const peIV = atmData.PE?.impliedVolatility ?? atmData.PE?.iv ?? 0;
    const atmIV = ((ceIV + peIV) / 2).toFixed(2);

    // Strangle: 1 step OTM
    const { callStrike: scStrike, putStrike: spStrike } = getStrangleStrikes(strikes, atmStrike, 1);
    const scData = optionsByStrike[scStrike] || {};
    const spData = optionsByStrike[spStrike] || {};
    const scePrice = scData.CE?.lastPrice ?? scData.CE?.ltp ?? 0;
    const spePrice = spData.PE?.lastPrice ?? spData.PE?.ltp ?? 0;
    const stranglePremium = scePrice + spePrice;

    // OI data
    const ceOI = atmData.CE?.openInterest ?? atmData.CE?.oi ?? 0;
    const peOI = atmData.PE?.openInterest ?? atmData.PE?.oi ?? 0;
    const pcr = peOI && ceOI ? (peOI / ceOI).toFixed(2) : null;

    // Greeks (if available)
    const ceDelta = atmData.CE?.delta ?? null;
    const peDelta = atmData.PE?.delta ?? null;
    const ceTheta = atmData.CE?.theta ?? null;
    const peTheta = atmData.PE?.theta ?? null;
    const ceVega  = atmData.CE?.vega  ?? null;
    const peVega  = atmData.PE?.vega  ?? null;

    res.json({
      symbol,
      expiry: targetExpiry,
      spotPrice,
      atmStrike,
      timestamp: new Date().toISOString(),

      straddle: {
        callStrike: atmStrike,
        putStrike: atmStrike,
        callPremium: cePrice,
        putPremium: pePrice,
        combined: straddlePremium,
        upperBreakeven: +(atmStrike + straddlePremium).toFixed(2),
        lowerBreakeven: +(atmStrike - straddlePremium).toFixed(2),
      },

      strangle: {
        callStrike: scStrike,
        putStrike: spStrike,
        callPremium: scePrice,
        putPremium: spePrice,
        combined: stranglePremium,
        upperBreakeven: +(scStrike + stranglePremium).toFixed(2),
        lowerBreakeven: +(spStrike - stranglePremium).toFixed(2),
      },

      iv: {
        atm: +atmIV,
        ce: +ceIV,
        pe: +peIV,
      },

      greeks: {
        delta: { ce: ceDelta, pe: peDelta },
        theta: { ce: ceTheta, pe: peTheta },
        vega:  { ce: ceVega,  pe: peVega  },
      },

      oi: { ce: ceOI, pe: peOI, pcr },

      expiries: expiryList,
    });

  } catch (err) {
    console.error("[straddleRoutes] /snapshot error:", err);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

/**
 * GET /api/straddle/payoff
 * Returns payoff curve data for charting
 * Query: symbol, expiry, type (straddle|strangle), side (buy|sell), steps (strangle OTM steps)
 */
router.get("/payoff", (req, res) => {
  try {
    const { symbol = "NIFTY", expiry, type = "straddle", side = "sell", steps = 1 } = req.query;
    const cache = readCache();

    if (!cache) {
      return res.status(503).json({ error: "Option chain cache not available" });
    }

    const chainData = cache[symbol] || cache;
    const spotPrice = chainData.spotPrice || chainData.underlyingValue || 0;
    const expiryList = chainData.expiries || Object.keys(chainData.data || {});
    const targetExpiry = expiry || expiryList[0];
    const optionsByStrike = chainData.data?.[targetExpiry] || chainData.options || {};
    const strikes = Object.keys(optionsByStrike).map(Number).sort((a, b) => a - b);

    if (!strikes.length) return res.status(404).json({ error: "No strikes found" });

    const atmStrike = findATMStrike(strikes, spotPrice);

    let callStrike, putStrike, callPremium, putPremium;

    if (type === "straddle") {
      callStrike = putStrike = atmStrike;
      const atmData = optionsByStrike[atmStrike] || {};
      callPremium = atmData.CE?.lastPrice ?? atmData.CE?.ltp ?? 0;
      putPremium  = atmData.PE?.lastPrice ?? atmData.PE?.ltp ?? 0;
    } else {
      const { callStrike: cs, putStrike: ps } = getStrangleStrikes(strikes, atmStrike, +steps);
      callStrike = cs;
      putStrike  = ps;
      callPremium = (optionsByStrike[cs]?.CE?.lastPrice ?? optionsByStrike[cs]?.CE?.ltp ?? 0);
      putPremium  = (optionsByStrike[ps]?.PE?.lastPrice ?? optionsByStrike[ps]?.PE?.ltp ?? 0);
    }

    const lotSize = symbol === "BANKNIFTY" ? 35
  : symbol === "FINNIFTY"    ? 65
  : symbol === "MIDCPNIFTY"  ? 120
  : symbol === "SENSEX"      ? 20
  : 75; // NIFTY default

    const payoff = buildPayoffCurve({
      callStrike, putStrike, callPremium, putPremium, type, side, lotSize,
    });

    res.json({
      symbol, expiry: targetExpiry, type, side,
      atmStrike, spotPrice, lotSize,
      callStrike, putStrike, callPremium, putPremium,
      ...payoff,
    });

  } catch (err) {
    console.error("[straddleRoutes] /payoff error:", err);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

/**
 * GET /api/straddle/history
 * Returns intraday straddle premium history (from liveOrderBook or similar persisted data)
 * This is a stub — wire to your actual tick store if available
 */
router.get("/history", (req, res) => {
  try {
    const { symbol = "NIFTY" } = req.query;

    // Try to read from liveOrderBook data
    const liveBookPath = path.join(__dirname, "../data/liveOrderBook.json");
    if (fs.existsSync(liveBookPath)) {
      const raw = JSON.parse(fs.readFileSync(liveBookPath, "utf8"));
      const history = raw[symbol]?.straddleHistory || [];
      return res.json({ symbol, history });
    }

    // Fallback: empty history (frontend will build it live via polling)
    res.json({ symbol, history: [] });

  } catch (err) {
    console.error("[straddleRoutes] /history error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;