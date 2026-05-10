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
    const expiryList = chainData.expiries || Object.keys(chainData.chains || {});
    const targetExpiry = expiry || expiryList[0];
    const chainExpiry = chainData.chains?.[targetExpiry];
    const strikesArr = chainExpiry?.strikes || [];

    if (!strikesArr.length) {
      return res.status(404).json({ error: "No strikes found in cache" });
    }

    const strikes = strikesArr.map(s => s.strike).sort((a, b) => a - b);
    const spotPrice2 = chainExpiry.spotPrice || spotPrice;
    const atmStrike = chainExpiry.atmStrike || findATMStrike(strikes, spotPrice2);
    const atmRow = strikesArr.find(s => s.strike === atmStrike) || strikesArr[Math.floor(strikesArr.length / 2)];

    const cePrice = atmRow?.ce?.ltp ?? 0;
    const pePrice = atmRow?.pe?.ltp ?? 0;
    const straddlePremium = cePrice + pePrice;

    const ceIV = atmRow?.ce?.iv ?? 0;
    const peIV = atmRow?.pe?.iv ?? 0;
    const atmIV = ((ceIV + peIV) / 2).toFixed(2);

    const { callStrike: scStrike, putStrike: spStrike } = getStrangleStrikes(strikes, atmStrike, 1);
    const scRow = strikesArr.find(s => s.strike === scStrike) || {};
    const spRow = strikesArr.find(s => s.strike === spStrike) || {};
    const scePrice = scRow?.ce?.ltp ?? 0;
    const spePrice = spRow?.pe?.ltp ?? 0;
    const stranglePremium = scePrice + spePrice;

    const ceOI = atmRow?.ce?.oi ?? 0;
    const peOI = atmRow?.pe?.oi ?? 0;
    const pcr = peOI && ceOI ? (peOI / ceOI).toFixed(2) : (chainExpiry?.pcr ?? null);

    const ceDelta = atmRow?.ce?.delta ?? null;
    const peDelta = atmRow?.pe?.delta ?? null;
    const ceTheta = atmRow?.ce?.theta ?? null;
    const peTheta = atmRow?.pe?.theta ?? null;
    const ceVega  = atmRow?.ce?.vega  ?? null;
    const peVega  = atmRow?.pe?.vega  ?? null;

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
    const expiryList = chainData.expiries || Object.keys(chainData.chains || {});
    const targetExpiry = expiry || expiryList[0];
    const chainExpiry = chainData.chains?.[targetExpiry];
    const strikesArr = chainExpiry?.strikes || [];

    if (!strikesArr.length) return res.status(404).json({ error: "No strikes found" });

    const strikes = strikesArr.map(s => s.strike).sort((a, b) => a - b);
    const spotPrice2 = chainExpiry?.spotPrice || spotPrice;
    const atmStrike = chainExpiry?.atmStrike || findATMStrike(strikes, spotPrice2);

    let callStrike, putStrike, callPremium, putPremium;

    if (type === "straddle") {
      callStrike = putStrike = atmStrike;
      const atmRow = strikesArr.find(s => s.strike === atmStrike) || {};
      callPremium = atmRow?.ce?.ltp ?? 0;
      putPremium  = atmRow?.pe?.ltp ?? 0;
    } else {
      const { callStrike: cs, putStrike: ps } = getStrangleStrikes(strikes, atmStrike, +steps);
      callStrike = cs;
      putStrike  = ps;
      callPremium = strikesArr.find(s => s.strike === cs)?.ce?.ltp ?? 0;
      putPremium  = strikesArr.find(s => s.strike === ps)?.pe?.ltp ?? 0;
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
      atmStrike, spotPrice: spotPrice2, lotSize,
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