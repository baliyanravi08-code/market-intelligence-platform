"use strict";
/**
 * server/services/intelligence/ivHistoryWriter.js
 *
 * Appends today's closing ATM IV to ivHistory.json for each symbol.
 * Called once per day at market close (15:31 IST) by coordinator.js
 *
 * ivHistory.json structure:
 * {
 *   "NIFTY": [
 *     { "date": "2026-05-12", "iv": 13.45 },
 *     { "date": "2026-05-13", "iv": 14.20 },
 *     ...up to 365 entries (1 year rolling)
 *   ],
 *   "BANKNIFTY": [ ... ],
 *   ...
 * }
 */

const fs   = require("fs");
const path = require("path");

const CACHE_PATH   = path.join(__dirname, "../../data/optionChainCache.json");
const HISTORY_PATH = path.join(__dirname, "../../data/ivHistory.json");
const SYMBOLS      = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
const MAX_DAYS     = 365; // rolling 1-year window

// ─── Read helpers ────────────────────────────────────────────────────────────

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeHistory(data) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ─── Get today's date string YYYY-MM-DD in IST ────────────────────────────────

function todayIST() {
  const now   = new Date();
  const ist   = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().slice(0, 10);
}

// ─── Extract ATM IV from cache for a symbol ───────────────────────────────────

function getATMIV(cache, symbol) {
  const chainData = cache[symbol];
  if (!chainData) return null;

  const spotPrice  = chainData.spotPrice || chainData.underlyingValue || 0;
  const expiryList = chainData.expiries  || Object.keys(chainData.chains || {});
  const nearExpiry = expiryList[0];
  if (!nearExpiry) return null;

  const chainExpiry = chainData.chains?.[nearExpiry];
  const strikesArr  = chainExpiry?.strikes || [];
  if (!strikesArr.length) return null;

  // Find ATM row
  const strikes  = strikesArr.map(s => s.strike).sort((a, b) => a - b);
  const atmStrike = chainExpiry.atmStrike ||
    strikes.reduce((prev, curr) =>
      Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
    );

  const atmRow = strikesArr.find(s => s.strike === atmStrike);
  if (!atmRow) return null;

  const ceIV = atmRow?.ce?.iv ?? 0;
  const peIV = atmRow?.pe?.iv ?? 0;
  if (!ceIV && !peIV) return null;

  return +((ceIV + peIV) / 2).toFixed(2);
}

// ─── Main: write today's IV for all symbols ───────────────────────────────────

function writeDailyIV() {
  const cache = readCache();
  if (!cache) {
    console.warn("[ivHistoryWriter] Cache not available — skipping");
    return;
  }

  const history = readHistory();
  const today   = todayIST();
  let updated   = 0;

  for (const symbol of SYMBOLS) {
    const iv = getATMIV(cache, symbol);
    if (iv === null) {
      console.warn(`[ivHistoryWriter] No IV found for ${symbol} — skipping`);
      continue;
    }

    if (!history[symbol]) history[symbol] = [];

    // Avoid duplicate entry for same day
    const alreadyToday = history[symbol].some(e => e.date === today);
    if (alreadyToday) {
      // Update today's entry in case IV changed (e.g. called multiple times intraday)
      const idx = history[symbol].findIndex(e => e.date === today);
      history[symbol][idx].iv = iv;
      console.log(`[ivHistoryWriter] Updated ${symbol} IV for ${today}: ${iv}%`);
    } else {
      history[symbol].push({ date: today, iv });
      console.log(`[ivHistoryWriter] Recorded ${symbol} IV for ${today}: ${iv}%`);
    }

    // Keep only last MAX_DAYS entries (rolling window)
    history[symbol] = history[symbol]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_DAYS);

    updated++;
  }

  if (updated > 0) writeHistory(history);
  console.log(`[ivHistoryWriter] Done — ${updated} symbols updated`);
}

module.exports = { writeDailyIV, getATMIV, readHistory };