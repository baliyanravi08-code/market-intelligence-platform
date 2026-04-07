"use strict";

/**
 * circuitWatcher.js — UPGRADED
 *
 * Upgrades over v2:
 * ─────────────────────────────────────────────────────────────────
 * 1. Velocity score  — server-computed urgency 0–100 (replaces duplicate
 *    client-side calculation). Combines tier weight + proximity + momentum
 *    acceleration. Sent in both watchlist and alerts payloads.
 *
 * 2. Volume surge detection — rolling 5-poll average volume tracked per symbol.
 *    `volumeSurge: true` when current volume > 2× rolling avg.
 *    `volumeRatio` also sent so UI can show "3.2× avg vol".
 *
 * 3. Pre-circuit radar emit — dedicated `circuit-radar` socket event for stocks
 *    3–5% from circuit, moving toward limit, with volume. Frontend no longer
 *    needs to filter watchlist itself.
 *
 * 4. Acceleration tracking — rate-of-change of momentum across polls.
 *    Stocks accelerating toward circuit get higher velocity scores.
 *
 * 5. Tier change events — emits `circuit-tier-change` when a stock escalates
 *    (e.g. WATCH → WARNING), so frontend can animate without scanning the list.
 *
 * 6. Market open guard — skips poll outside NSE hours (09:15–15:30 IST)
 *    to avoid stale/pre-market noise. Can be disabled via config.
 *
 * Zero breaking changes to existing socket events:
 *   circuit-alerts     ← same shape, extra fields added
 *   circuit-watchlist  ← same shape, extra fields added
 *   circuit-radar      ← NEW
 *   circuit-tier-change← NEW
 */

const axios        = require("axios");
const EventEmitter = require("events");

// ─── Config ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS   = 30_000;
const COOLDOWN_MS        = 20 * 60 * 1000;   // 20 min between repeat alerts
const UPSTOX_BATCH       = 500;
const HIST_LEN           = 6;                 // polls to keep for momentum calc
const VOL_HIST_LEN       = 5;                 // polls to keep for volume avg
const VOLUME_SURGE_RATIO = 2.0;               // flag if vol > 2× rolling avg
const MARKET_HOUR_GUARD  = true;              // skip polls outside NSE hours

// Tier thresholds — % distance from circuit limit
const TIERS = {
  LOCKED:   0,
  CRITICAL: 1,
  WARNING:  3,
  WATCH:    10,
};

// Pre-circuit radar zone
const RADAR_MIN_PCT = 3;
const RADAR_MAX_PCT = 5;

const DEFAULT_BAND_PCT = 20;
const NARROW_BAND_PCT  = 10;

// ─── Sector map ───────────────────────────────────────────────────────────────
const SECTOR = {
  BANK:    ["HDFCBANK","ICICIBANK","KOTAKBANK","AXISBANK","SBIN","BANKBARODA","CANBK","PNB","UNIONBANK","FEDERALBNK","IDFCFIRSTB","RBLBANK","YESBANK","BANDHANBNK","AUBANK","INDUSINDBK"],
  NBFC:    ["BAJFINANCE","BAJAJFINSV","CHOLAFIN","MUTHOOTFIN","MANAPPURAM","RECLTD","PFC","IRFC","HUDCO","M&MFIN"],
  IT:      ["TCS","INFY","WIPRO","HCLTECH","TECHM","LTIM","NAUKRI","INDIAMART","AFFLE","TANLA"],
  AUTO:    ["MARUTI","TATAMOTORS","BAJAJ-AUTO","HEROMOTOCO","M&M","ASHOKLEY","BALKRISIND","EXIDEIND","MOTHERSON","BOSCHLTD"],
  PHARMA:  ["SUNPHARMA","DIVISLAB","CIPLA","DRREDDY","ZYDUSLIFE","LUPIN","ALKEM","TORNTPHARM","IPCALAB","LAURUSLABS","GRANULES","BIOCON","ABBOTINDIA"],
  POWER:   ["NTPC","POWERGRID","ADANIPOWER","ADANIGREEN","TATAPOWER","CESC","TORNTPOWER","JSWENERGY","SUZLON","INOXWIND","NHPC","SJVN"],
  DEFENCE: ["HAL","BEL","BHEL","COCHINSHIP","MAZDOCK","GRSE","BEML","DATAPATTNS","MTAR"],
  INFRA:   ["LT","KEC","KALPATPOWR","THERMAX","RVNL","RAILTEL","IRCTC","TITAGARH","CONCOR","GMRINFRA","APLAPOLLO"],
  REALTY:  ["OBEROIRLTY","PHOENIXLTD","DLF","GODREJPROP","PRESTIGE","BRIGADE","SOBHA"],
  FINTECH: ["ZOMATO","NYKAA","PAYTM","POLICYBZR","DELHIVERY","MCX","BSE","CDSL","CAMS","ANGELONE","MOFSL","360ONE"],
  METAL:   ["JSWSTEEL","TATASTEEL","HINDALCO","VEDL","SAIL","NMDC","MOIL","COALINDIA"],
  FMCG:    ["HINDUNILVR","NESTLEIND","TITAN","ASIANPAINT","BRITANNIA","PIDILITIND","GODREJCP","DABUR","MARICO","EMAMILTD","VBL","RADICO","MCDOWELL-N","TATACONSUM","ITC"],
};

const symbolSector = {};
for (const [sector, syms] of Object.entries(SECTOR)) {
  for (const s of syms) symbolSector[s] = sector;
}

const NARROW_BAND_SYMBOLS = new Set(["YESBANK", "RBLBANK", "BANDHANBNK"]);

const FNO_SYMBOLS = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","SBIN","BAJFINANCE",
  "BHARTIARTL","KOTAKBANK","LT","ASIANPAINT","AXISBANK","MARUTI","TITAN",
  "SUNPHARMA","ULTRACEMCO","WIPRO","NESTLEIND","POWERGRID","NTPC","TECHM",
  "HCLTECH","ONGC","JSWSTEEL","TATASTEEL","COALINDIA","BPCL","GRASIM","DIVISLAB",
  "BRITANNIA","CIPLA","DRREDDY","EICHERMOT","APOLLOHOSP","BAJAJ-AUTO","BAJAJFINSV",
  "HEROMOTOCO","HINDALCO","INDUSINDBK","ITC","M&M","SBILIFE","HDFCLIFE",
  "TATACONSUM","ADANIENT","ADANIPORTS","LTIM","UPL","VEDL",
  "BANKBARODA","CANBK","PNB","UNIONBANK","FEDERALBNK","IDFCFIRSTB","RBLBANK",
  "YESBANK","BANDHANBNK","AUBANK","CHOLAFIN","MUTHOOTFIN","MANAPPURAM",
  "RECLTD","PFC","IRFC","HUDCO","NHPC","SJVN",
  "ADANIPOWER","ADANIGREEN","TATAPOWER","CESC","TORNTPOWER","JSWENERGY",
  "SUZLON","INOXWIND",
  "HAL","BEL","BHEL","COCHINSHIP","MAZDOCK","GRSE","BEML","DATAPATTNS",
  "MTAR","RVNL","RAILTEL","IRCTC","TITAGARH",
  "TATAMOTORS","M&MFIN","ASHOKLEY","BALKRISIND","EXIDEIND","MOTHERSON","BOSCHLTD",
  "ABB","SIEMENS","HAVELLS","POLYCAB","CGPOWER",
  "AIAENG","GRINDWELL","CARBORUNIV","SCHAEFFLER","TIMKEN","SKF",
  "PIDILITIND","ASTRAL","AARTIIND","DEEPAKNITR","GNFC","CHAMBLFERT",
  "COROMANDEL","PIIND","RALLIS","SUMICHEM",
  "ZOMATO","NYKAA","PAYTM","POLICYBZR","DELHIVERY",
  "KEC","KALPATPOWR","THERMAX","APLAPOLLO",
  "GODREJCP","DABUR","MARICO","EMAMILTD","VBL","RADICO","MCDOWELL-N",
  "ZYDUSLIFE","LUPIN","ALKEM","TORNTPHARM","IPCALAB","LAURUSLABS",
  "GRANULES","BIOCON","ABBOTINDIA",
  "OBEROIRLTY","PHOENIXLTD","DLF","GODREJPROP","PRESTIGE","BRIGADE","SOBHA",
  "MCX","BSE","CDSL","CAMS","ANGELONE","MOFSL","360ONE",
  "HDFCAMC","NIPPONLIFE","UTIAMC","ICICIGI","STARHEALTH",
  "SAIL","NMDC","MOIL","GMRINFRA","CONCOR","BLUEDART",
  "ZEEL","SUNTV","PVRINOX",
  "HFCL","STLTECH","TATACOMM","INDIAMART","NAUKRI","AFFLE","TANLA",
];

// ─── State ────────────────────────────────────────────────────────────────────
const cooldownMap   = new Map(); // symbol → { tier, timestamp }
const lockedSymbols = new Set();
const distHistory   = new Map(); // symbol → number[]  (last N distPct)
const momHistory    = new Map(); // symbol → number[]  (last N momentum — for acceleration)
const volHistory    = new Map(); // symbol → number[]  (last N volume — for surge detection)
const prevTierMap   = new Map(); // symbol → tier      (for tier-change events)

let ioRef      = null;
let pollTimer  = null;
let isRunning  = false;
let getToken   = () => null;
let getInstMap = () => ({});

let lastPollStocks = [];
let lastAlerts     = [];
let lastWatchlist  = [];
let lastRadar      = [];

const emitter = new EventEmitter();

// ─── Market hours guard ───────────────────────────────────────────────────────
function isMarketOpen() {
  if (!MARKET_HOUR_GUARD) return true;
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = now.getHours(), m = now.getMinutes();
  const mins = h * 60 + m;
  return mins >= 555 && mins <= 930; // 09:15 → 15:30
}

// ─── Circuit limits ───────────────────────────────────────────────────────────
function getCircuitLimits(symbol, prevClose, quote) {
  const uc = parseFloat(quote?.upper_circuit_limit || quote?.uc || 0);
  const lc = parseFloat(quote?.lower_circuit_limit || quote?.lc || 0);
  if (uc > 0 && lc > 0) {
    const bandPct = +((uc - prevClose) / prevClose * 100).toFixed(1);
    return { upper: uc, lower: lc, bandPct, fromExchange: true };
  }
  const pct = NARROW_BAND_SYMBOLS.has(symbol) ? NARROW_BAND_PCT : DEFAULT_BAND_PCT;
  return {
    upper:        +(prevClose * (1 + pct / 100)).toFixed(2),
    lower:        +(prevClose * (1 - pct / 100)).toFixed(2),
    bandPct:      pct,
    fromExchange: false,
  };
}

// ─── Proximity ────────────────────────────────────────────────────────────────
function circuitProximity(ltp, upper, lower) {
  const distUpper = ((upper - ltp) / upper) * 100;
  const distLower = ((ltp - lower) / ltp) * 100;
  if (distUpper <= distLower) {
    return { side: "UPPER", distPct: +Math.max(0, distUpper).toFixed(2), limit: upper };
  }
  return { side: "LOWER", distPct: +Math.max(0, distLower).toFixed(2), limit: lower };
}

function getTier(distPct) {
  if (distPct <= TIERS.LOCKED)   return "LOCKED";
  if (distPct <= TIERS.CRITICAL) return "CRITICAL";
  if (distPct <= TIERS.WARNING)  return "WARNING";
  if (distPct <= TIERS.WATCH)    return "WATCH";
  return "SAFE";
}

function getActionTag(side, tier) {
  if (tier === "LOCKED") return side === "UPPER" ? "UPPER_CIRCUIT_LOCKED" : "LOWER_CIRCUIT_LOCKED";
  return side === "UPPER" ? "UPPER_CIRCUIT_NEAR" : "LOWER_CIRCUIT_NEAR";
}

// ─── Momentum (linear regression slope of distPct history) ───────────────────
function getMomentum(symbol, currentDist) {
  const hist = distHistory.get(symbol) || [];
  hist.push(currentDist);
  if (hist.length > HIST_LEN) hist.shift();
  distHistory.set(symbol, hist);
  if (hist.length < 2) return 0;
  const n  = hist.length;
  const xm = (n - 1) / 2;
  const ym = hist.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (hist[i] - ym);
    den += (i - xm) ** 2;
  }
  return den === 0 ? 0 : +(num / den).toFixed(3);
}

// ─── Acceleration (rate-of-change of momentum) ───────────────────────────────
// Positive acceleration toward circuit = stock speeding up — more dangerous
function getAcceleration(symbol, currentMomentum) {
  const hist = momHistory.get(symbol) || [];
  hist.push(currentMomentum);
  if (hist.length > 4) hist.shift();  // shorter window for responsiveness
  momHistory.set(symbol, hist);
  if (hist.length < 2) return 0;
  // Simple delta of last two momentum values
  return +(hist[hist.length - 1] - hist[hist.length - 2]).toFixed(4);
}

// ─── Volume surge ─────────────────────────────────────────────────────────────
function getVolumeSurge(symbol, currentVol) {
  const hist = volHistory.get(symbol) || [];
  const avgVol = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;

  // Update history AFTER computing ratio (so current poll doesn't inflate its own avg)
  hist.push(currentVol);
  if (hist.length > VOL_HIST_LEN) hist.shift();
  volHistory.set(symbol, hist);

  if (!avgVol || avgVol === 0) return { volumeSurge: false, volumeRatio: null };
  const ratio = +(currentVol / avgVol).toFixed(2);
  return {
    volumeSurge: ratio >= VOLUME_SURGE_RATIO,
    volumeRatio: ratio,
  };
}

// ─── Velocity score (server-authoritative, 0–100) ─────────────────────────────
// This replaces the duplicate calculation in CircuitAlerts.jsx frontend.
// Frontend should use `stock.velocityScore` directly.
//
// Algorithm:
//   tier weight (50%) + proximity tightness (30%) + momentum strength (15%) + acceleration bonus (5%)
//   Negative momentum/acceleration = toward circuit = HIGHER score (more urgent)
function computeVelocityScore(distPct, tier, momentum, acceleration) {
  if (tier === "LOCKED") return 100;

  const tierWeight   = { SAFE: 0, WATCH: 20, WARNING: 45, CRITICAL: 70, LOCKED: 100 };
  const base         = tierWeight[tier] || 0;

  // Proximity: 0 when at WATCH boundary (10%), 100 when at 0%
  const proxScore    = Math.max(0, Math.min(100, ((10 - Math.min(distPct, 10)) / 10) * 100));

  // Momentum toward circuit (negative) = urgency, capped at 30
  const momToward    = momentum < 0 ? Math.abs(momentum) : 0;
  const momScore     = Math.min(30, momToward * 25);

  // Acceleration bonus: speeding up toward circuit = extra urgency
  const accToward    = acceleration < 0 ? Math.abs(acceleration) : 0;
  const accBonus     = Math.min(10, accToward * 30);

  return Math.min(100, Math.round(
    base         * 0.50 +
    proxScore    * 0.30 +
    momScore     * 0.15 +
    accBonus     * 0.05
  ));
}

// ─── Velocity label (matches frontend VelocityBadge) ─────────────────────────
function velocityLabel(score, toward) {
  if (!toward) return "FADING";
  if (score >= 70) return "EXPLODING";
  if (score >= 40) return "BUILDING";
  if (score >= 15) return "DRIFTING";
  return "SLOW";
}

// ─── Cooldown ─────────────────────────────────────────────────────────────────
function shouldAlert(symbol, tier) {
  const last      = cooldownMap.get(symbol);
  if (!last) return true;
  const elapsed   = Date.now() - last.timestamp;
  const ORDER     = { SAFE: 0, WATCH: 1, WARNING: 2, CRITICAL: 3, LOCKED: 4 };
  const worsened  = (ORDER[tier] || 0) > (ORDER[last.tier] || 0);
  if (worsened) return true;
  return elapsed > COOLDOWN_MS;
}

// ─── Build stock payload ──────────────────────────────────────────────────────
function buildStockPayload(symbol, quote) {
  const ltp       = parseFloat(quote.last_price || 0);
  const prevClose = parseFloat(quote.ohlc?.close || 0);
  const open      = parseFloat(quote.ohlc?.open  || 0);
  const high      = parseFloat(quote.ohlc?.high  || 0);
  const low       = parseFloat(quote.ohlc?.low   || 0);
  const volume    = parseInt(quote.volume || 0, 10);
  const avgPrice  = parseFloat(quote.average_price || 0);
  const tradedVal = +(avgPrice * volume).toFixed(0);

  if (ltp <= 0 || prevClose <= 0) return null;

  const change    = +(ltp - prevClose).toFixed(2);
  const changePct = +((change / prevClose) * 100).toFixed(2);

  const { upper, lower, bandPct, fromExchange } = getCircuitLimits(symbol, prevClose, quote);
  const { side, distPct, limit }                = circuitProximity(ltp, upper, lower);
  const momentum                                = getMomentum(symbol, distPct);
  const acceleration                            = getAcceleration(symbol, momentum);
  const { volumeSurge, volumeRatio }            = getVolumeSurge(symbol, volume);
  const tier                                    = getTier(distPct);
  const velocityScore                           = computeVelocityScore(distPct, tier, momentum, acceleration);
  const toward                                  = momentum < 0;
  const velLabel                                = velocityLabel(velocityScore, toward);
  const sector                                  = symbolSector[symbol] || "OTHER";

  return {
    symbol, sector,
    ltp, prevClose, open, high, low,
    change, changePercent: changePct,
    volume, tradedValue: tradedVal,
    circuitLimit: limit, upper, lower, bandPct, fromExchange,
    side, distPct, tier,
    momentum, acceleration,
    velocityScore, velocityLabel: velLabel,
    volumeSurge, volumeRatio,
    _ts: Date.now(),
  };
}

// ─── Poll ─────────────────────────────────────────────────────────────────────
async function runPoll() {
  if (!isMarketOpen()) {
    console.log("⏸  Circuit watcher: outside market hours — skipping poll");
    return;
  }

  const token   = getToken();
  const instMap = getInstMap();

  if (!token) {
    console.warn("⚠️ Circuit watcher: no Upstox token — skipping poll");
    return;
  }
  if (!instMap || Object.keys(instMap).length === 0) {
    console.warn("⚠️ Circuit watcher: instrument map not ready — skipping poll");
    return;
  }

  const symbolToKey = {};
  for (const sym of FNO_SYMBOLS) {
    const key = instMap[sym];
    if (key) symbolToKey[sym] = key;
  }

  const instrumentKeys = Object.values(symbolToKey);
  if (!instrumentKeys.length) return;

  const keyToSymbol = {};
  for (const [sym, key] of Object.entries(symbolToKey)) keyToSymbol[key] = sym;

  // Batch fetch
  const chunks   = [];
  for (let i = 0; i < instrumentKeys.length; i += UPSTOX_BATCH) {
    chunks.push(instrumentKeys.slice(i, i + UPSTOX_BATCH));
  }

  const rawQuotes = {};
  for (const chunk of chunks) {
    try {
      const res = await axios.get("https://api.upstox.com/v2/market-quote/quotes", {
        params:  { instrument_key: chunk.join(",") },
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        timeout: 15_000,
      });
      Object.assign(rawQuotes, res.data?.data || {});
    } catch (err) {
      if (err.response?.status === 401) {
        console.error("❌ Circuit watcher: Upstox token expired");
        return;
      }
      console.error("❌ Circuit watcher poll chunk error:", err.message);
    }
  }

  // Build stocks
  const stocks = [];
  for (const [key, quote] of Object.entries(rawQuotes)) {
    const symbol = keyToSymbol[key] || key.split(/[|:]/).pop();
    const stock  = buildStockPayload(symbol, quote);
    if (stock) stocks.push(stock);
  }

  console.log(`🔔 Circuit watcher: checked ${stocks.length} stocks`);
  lastPollStocks = stocks;

  // ── Tier change detection ─────────────────────────────────────────────────
  const tierChanges = [];
  const ORDER = { SAFE: 0, WATCH: 1, WARNING: 2, CRITICAL: 3, LOCKED: 4 };
  for (const s of stocks) {
    const prev = prevTierMap.get(s.symbol);
    if (prev && prev !== s.tier && (ORDER[s.tier] || 0) > (ORDER[prev] || 0)) {
      tierChanges.push({ symbol: s.symbol, from: prev, to: s.tier, velocityScore: s.velocityScore, timestamp: new Date().toISOString() });
    }
    prevTierMap.set(s.symbol, s.tier);
  }
  if (tierChanges.length) {
    if (ioRef) ioRef.emit("circuit-tier-change", tierChanges);
    emitter.emit("circuit-tier-change", tierChanges);
    console.log(`📈 Tier escalations: ${tierChanges.map(t => `${t.symbol} ${t.from}→${t.to}`).join(", ")}`);
  }

  // ── Watchlist — full snapshot sorted by velocityScore DESC ───────────────
  const WATCHLIST_FIELDS = [
    "symbol","sector","ltp","prevClose","change","changePercent",
    "volume","tradedValue","circuitLimit","upper","lower","bandPct",
    "side","distPct","tier","momentum","acceleration",
    "velocityScore","velocityLabel","volumeSurge","volumeRatio",
    "fromExchange","_ts",
  ];

  const watchlist = [...stocks]
    .sort((a, b) => b.velocityScore - a.velocityScore)
    .map(s => Object.fromEntries(WATCHLIST_FIELDS.map(f => [f, s[f]])));

  lastWatchlist = watchlist;
  if (ioRef) ioRef.emit("circuit-watchlist", watchlist);
  emitter.emit("circuit-watchlist", watchlist);

  // ── Radar — pre-circuit zone 3–5%, toward circuit, has volume ────────────
  const radar = stocks
    .filter(s => {
      const inZone = s.distPct >= RADAR_MIN_PCT && s.distPct <= RADAR_MAX_PCT;
      const toward = s.momentum < 0;
      const hasVol = s.volume > 0;
      return inZone && toward && hasVol;
    })
    .sort((a, b) => b.velocityScore - a.velocityScore)
    .map(s => Object.fromEntries(WATCHLIST_FIELDS.map(f => [f, s[f]])));

  lastRadar = radar;
  if (radar.length) {
    if (ioRef) ioRef.emit("circuit-radar", radar);
    emitter.emit("circuit-radar", radar);
    console.log(`⚡ Radar: ${radar.length} stocks in pre-circuit zone`);
  }

  // ── Alerts — threshold breaches with smart cooldown ──────────────────────
  const ALERT_FIELDS = [
    ...WATCHLIST_FIELDS,
    "open","high","low","action","timestamp",
  ];

  const alerts = [];
  for (const s of stocks) {
    if (s.tier === "SAFE") {
      const cd = cooldownMap.get(s.symbol);
      if (cd && cd.tier !== "SAFE") {
        cooldownMap.set(s.symbol, { tier: "SAFE", timestamp: Date.now() });
      }
      lockedSymbols.delete(s.symbol);
      continue;
    }

    if (!shouldAlert(s.symbol, s.tier)) continue;
    if (s.tier === "LOCKED" && lockedSymbols.has(s.symbol)) continue;

    const alert = {
      ...Object.fromEntries(WATCHLIST_FIELDS.map(f => [f, s[f]])),
      open:      s.open,
      high:      s.high,
      low:       s.low,
      action:    getActionTag(s.side, s.tier),
      timestamp: new Date().toISOString(),
    };

    alerts.push(alert);
    cooldownMap.set(s.symbol, { tier: s.tier, timestamp: Date.now() });
    if (s.tier === "LOCKED") lockedSymbols.add(s.symbol);
    else lockedSymbols.delete(s.symbol);
  }

  if (alerts.length) {
    console.log(`⚡ ${alerts.length} circuit alert(s): ${alerts.map(a => a.symbol).join(", ")}`);
    lastAlerts = alerts;
    if (ioRef) ioRef.emit("circuit-alerts", alerts);
    emitter.emit("circuit-alerts", alerts);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startCircuitWatcher(io, tokenGetter, instrumentMapGetter) {
  if (isRunning) return;
  isRunning = true;
  ioRef     = io;
  if (tokenGetter)         getToken   = tokenGetter;
  if (instrumentMapGetter) getInstMap = instrumentMapGetter;
  console.log("🔔 Circuit watcher started — polling Upstox every 30s");
  runPoll();
  pollTimer = setInterval(runPoll, POLL_INTERVAL_MS);
}

function stopCircuitWatcher() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  isRunning = false;
  console.log("🔕 Circuit watcher stopped");
}

// Event subscriptions
function onCircuitAlert(cb)      { emitter.on("circuit-alerts",      cb); }
function onCircuitWatchlist(cb)  { emitter.on("circuit-watchlist",   cb); }
function onCircuitRadar(cb)      { emitter.on("circuit-radar",       cb); }
function onCircuitTierChange(cb) { emitter.on("circuit-tier-change", cb); }

// Getters for on-connect hydration (send last known state to new socket clients)
function getLastAlerts()    { return lastAlerts; }
function getLastWatchlist() { return lastWatchlist; }
function getLastRadar()     { return lastRadar; }
function getLastStocks()    { return lastPollStocks; }

// Config helpers
function registerNarrowBandSymbols(syms) { syms.forEach(s => NARROW_BAND_SYMBOLS.add(s)); }

module.exports = {
  startCircuitWatcher,
  stopCircuitWatcher,
  onCircuitAlert,
  onCircuitWatchlist,
  onCircuitRadar,
  onCircuitTierChange,
  getLastAlerts,
  getLastWatchlist,
  getLastRadar,
  getLastStocks,
  registerNarrowBandSymbols,
};