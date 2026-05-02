"use strict";

/**
 * sectorEngine.js
 * server/services/intelligence/sectorEngine.js
 *
 * Replaces: sectorQueue.js + sectorBoomEngine.js + sectorRadar.js
 *
 * What's different from the old 3-file system:
 *   - Uses live scanner data (price change, volume, delivery%) for sector health
 *   - BSE filing signals add momentum ON TOP of scanner data (not instead of it)
 *   - Boom detection uses real thresholds per sector type
 *   - Daily reset at midnight IST
 *   - Emits "sector-update" socket event on boom, "sector-snapshot" on request
 */

const SECTOR_MAP = {
  // Infrastructure & Engineering
  "l&t": "Infrastructure", "larsen": "Infrastructure", "kec": "Infrastructure",
  "kalpataru": "Infrastructure", "thermax": "Infrastructure", "bhel": "Infrastructure",
  "abb": "Infrastructure", "siemens": "Infrastructure",

  // Defence
  "hal": "Defence", "bel": "Defence", "mazagon": "Defence",
  "garden reach": "Defence", "bharat forge": "Defence", "data patterns": "Defence",

  // Railway
  "irfc": "Railway", "rvnl": "Railway", "titagarh": "Railway",
  "jupiter wagon": "Railway", "texmaco": "Railway", "ircon": "Railway",

  // Renewable Energy
  "suzlon": "Renewable", "inox wind": "Renewable", "tata power": "Renewable",
  "jsw energy": "Renewable", "nhpc": "Renewable", "torrent power": "Renewable",
  "adani green": "Renewable", "greenko": "Renewable",

  // Power
  "ntpc": "Power", "power grid": "Power", "torrent": "Power",
  "cesc": "Power", "tata power": "Power",

  // Banking & Finance
  "hdfc bank": "Banking", "sbi": "Banking", "icici": "Banking",
  "axis bank": "Banking", "kotak": "Banking", "indusind": "Banking",
  "bajaj finance": "Banking", "pfc": "Banking", "recltd": "Banking",

  // IT
  "tcs": "IT", "infosys": "IT", "wipro": "IT",
  "hcl tech": "IT", "tech mahindra": "IT", "mphasis": "IT",

  // Pharma
  "sun pharma": "Pharma", "dr reddy": "Pharma", "cipla": "Pharma",
  "divi": "Pharma", "zydus": "Pharma", "aurobindo": "Pharma",

  // Auto
  "tata motors": "Auto", "maruti": "Auto", "m&m": "Auto",
  "hero": "Auto", "bajaj auto": "Auto", "eicher": "Auto",
  "motherson": "Auto", "bosch": "Auto",

  // Metals & Mining
  "tata steel": "Metals", "jsw steel": "Metals", "hindalco": "Metals",
  "vedanta": "Metals", "coal india": "Metals", "nmdc": "Metals",

  // Real Estate
  "oberoi": "RealEstate", "dlf": "RealEstate", "prestige": "RealEstate",
  "godrej properties": "RealEstate", "phoenix": "RealEstate",

  // FMCG
  "hindustan unilever": "FMCG", "itc": "FMCG", "nestle": "FMCG",
  "britannia": "FMCG", "tata consumer": "FMCG", "marico": "FMCG",
};

// Boom threshold: min BSE filing orders before declaring a sector hot
const BOOM_THRESHOLDS = {
  Infrastructure: 3, Defence: 2, Railway: 2, Renewable: 3,
  Power: 3, Banking: 5, IT: 4, Pharma: 4,
  Auto: 3, Metals: 3, RealEstate: 2, FMCG: 4,
  Other: 3,
};

const MAX_BOOM_KEYS = 200;

// Per-sector state
const sectorMap = new Map(); // sector → { orders, totalValue, companies, filingSignals, boomFired }
const boomFired = new Set();
const boomFiredLog = [];

let _lastResetDay = null;
let ioRef = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function timeIST() {
  return new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

function maybeResetDaily() {
  const today = todayIST();
  if (_lastResetDay !== today) {
    _lastResetDay = today;
    sectorMap.clear();
    boomFired.clear();
    boomFiredLog.length = 0;
    console.log(`🔄 SectorEngine: daily reset for ${today}`);
  }
}

function detectSector(company = "", title = "") {
  const text = (company + " " + title).toLowerCase();
  for (const [keyword, sector] of Object.entries(SECTOR_MAP)) {
    if (text.includes(keyword)) return sector;
  }
  // Fallback keyword scan on title
  if (text.includes("bank") || text.includes("finance") || text.includes("nbfc")) return "Banking";
  if (text.includes("pharma") || text.includes("drug") || text.includes("health")) return "Pharma";
  if (text.includes("defence") || text.includes("defense") || text.includes("missile")) return "Defence";
  if (text.includes("railway") || text.includes("rail") || text.includes("wagon")) return "Railway";
  if (text.includes("solar") || text.includes("renewable") || text.includes("wind energy")) return "Renewable";
  if (text.includes("power") || text.includes("electric")) return "Power";
  if (text.includes("road") || text.includes("highway") || text.includes("infra") || text.includes("construct")) return "Infrastructure";
  if (text.includes("auto") || text.includes("vehicle") || text.includes("motor")) return "Auto";
  if (text.includes("steel") || text.includes("metal") || text.includes("alumin")) return "Metals";
  if (text.includes("real estate") || text.includes("housing") || text.includes("realty")) return "RealEstate";
  if (text.includes("software") || text.includes("technology") || text.includes("it ")) return "IT";
  return "Other";
}

function addBoomKey(key) {
  boomFired.add(key);
  boomFiredLog.push(key);
  if (boomFired.size > MAX_BOOM_KEYS) {
    const evictCount = Math.floor(MAX_BOOM_KEYS / 2);
    for (let i = 0; i < evictCount && boomFiredLog.length > 0; i++) {
      boomFired.delete(boomFiredLog.shift());
    }
  }
}

// ── Core: ingest a BSE/NSE filing signal ─────────────────────────────────────

function ingestFilingSignal(signal) {
  maybeResetDaily();
  if (!signal?.company) return null;

  const sector = detectSector(signal.company, signal.title || "");
  if (!sectorMap.has(sector)) {
    sectorMap.set(sector, {
      sector, orders: 0, totalValue: 0,
      companies: [], lastUpdated: Date.now(),
    });
  }

  const q = sectorMap.get(sector);
  if (!q.companies.includes(signal.company)) q.companies.push(signal.company);
  q.orders++;
  const crores = signal._orderInfo?.crores || 0;
  if (crores > 0) q.totalValue += crores;
  q.lastUpdated = Date.now();

  // Check for boom
  const threshold = BOOM_THRESHOLDS[sector] || 3;
  if (q.orders >= threshold) {
    const boomKey = `${sector}:${q.orders}:${Math.floor(q.totalValue / 100)}`;
    if (!boomFired.has(boomKey)) {
      addBoomKey(boomKey);
      const boom = {
        sector, orders: q.orders, companies: q.companies,
        totalValue: q.totalValue, isBoom: true,
        boomType: q.orders >= threshold * 2 ? "SECTOR_BOOM" : "SECTOR_MOMENTUM",
        lastUpdate: timeIST(),
      };
      if (ioRef) ioRef.emit("sector-update", boom);
      console.log(`🔥 SectorEngine boom: ${sector} orders=${q.orders} value=₹${q.totalValue}Cr`);
    }
  }

  return { sector, ...q };
}

// ── Merge scanner data into sector view ───────────────────────────────────────
// Called from marketScanner.js after each scan cycle

function mergeScannerData(scannerStocks = []) {
  maybeResetDaily();

  // Group scanner stocks by sector
  const scannerBySector = {};
  for (const stock of scannerStocks) {
    const sector = detectSector(stock.company || stock.symbol || "", "");
    if (!scannerBySector[sector]) {
      scannerBySector[sector] = { advancing: 0, declining: 0, totalChange: 0, count: 0, topGainers: [], topLosers: [] };
    }
    const s = scannerBySector[sector];
    const chg = parseFloat(stock.changePercent || stock.pctChange || 0);
    s.count++;
    s.totalChange += chg;
    if (chg > 0) { s.advancing++; s.topGainers.push({ symbol: stock.symbol, change: chg }); }
    if (chg < 0) { s.declining++; s.topLosers.push({ symbol: stock.symbol, change: chg }); }
  }

  // Merge into sectorMap
  for (const [sector, scanData] of Object.entries(scannerBySector)) {
    if (!sectorMap.has(sector)) sectorMap.set(sector, { sector, orders: 0, totalValue: 0, companies: [], lastUpdated: Date.now() });
    const q = sectorMap.get(sector);
    q.scannerData = {
      advancing: scanData.advancing,
      declining:  scanData.declining,
      avgChange:  scanData.count > 0 ? +(scanData.totalChange / scanData.count).toFixed(2) : 0,
      count:      scanData.count,
      topGainers: scanData.topGainers.sort((a, b) => b.change - a.change).slice(0, 3),
      topLosers:  scanData.topLosers.sort((a, b) => a.change - b.change).slice(0, 3),
      sentiment:  scanData.advancing > scanData.declining * 1.5 ? "BULLISH"
                : scanData.declining > scanData.advancing * 1.5 ? "BEARISH" : "MIXED",
    };
  }
}

// ── Public getters ─────────────────────────────────────────────────────────────

function getSectorSnapshot() {
  maybeResetDaily();
  return Array.from(sectorMap.values())
    .filter(s => s.orders > 0 || (s.scannerData?.count > 0))
    .sort((a, b) => (b.orders + (b.scannerData?.advancing || 0)) - (a.orders + (a.scannerData?.advancing || 0)))
    .map(s => ({
      sector:     s.sector,
      orders:     s.orders,
      totalValue: s.totalValue,
      companies:  s.companies.slice(0, 5),
      isBoom:     s.orders >= (BOOM_THRESHOLDS[s.sector] || 3),
      scanner:    s.scannerData || null,
      lastUpdate: timeIST(),
    }));
}

function getTopSectors(n = 5) {
  return getSectorSnapshot().slice(0, n);
}

function startSectorEngine(io) {
  ioRef = io;
  maybeResetDaily();

  // Daily reset at midnight IST
  setInterval(maybeResetDaily, 60 * 1000);

  console.log("🏭 SectorEngine started");
}

module.exports = {
  startSectorEngine,
  ingestFilingSignal,
  mergeScannerData,
  getSectorSnapshot,
  getTopSectors,
  detectSector,
};