// Only load .env locally — Render injects env vars automatically
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
}

const express = require("express");
const http    = require("http");
const path    = require("path");
const fs      = require("fs");
const axios   = require("axios");
const cors    = require("cors");

// ── WEEKEND GUARD — computed once at startup ──────────────────────────────────
const DAY_OF_WEEK = new Date().getDay(); // 0=Sun, 6=Sat
const IS_WEEKEND  = DAY_OF_WEEK === 0 || DAY_OF_WEEK === 6;
if (IS_WEEKEND) console.log("💤 Weekend mode — heavy services will be skipped to save memory");

const startBSEListener      = require("./services/listeners/bseListener");
const startNSEDealsListener = require("./services/listeners/nseDealsListener");
const { startCoordinator }  = require("./coordinator");

const {
  startStreamer, stopStreamer,
  restartWithNewToken,
  setOITickHandler, setLTPTickHandler,
  setBacktestEngine,
} = require("./services/upstoxStream");

const { commoditiesRoute }  = require("./api/commodities");
const {
  startNSEOIListener,
  handleOITick,
  getChain,
  getExpiries,
  getAllCached,
  addUnderlying,
} = require("./services/intelligence/nseOIListener");

const {
  getEvents,
  getRetentionHours,
  getWindowLabel,
} = require("./database");

const { attachSocketIO } = require("./api/websocket");
const { startIndexCandleFetcher, setToken: setICFToken, getDebugInfo } = require("./services/intelligence/indexCandleFetcher");

// ── Market Scanner ────────────────────────────────────────────────────────────
const {
  startMarketScanner,
  getScannerData,
  getTechnicalsREST,
  getTechnicalsForTimeframe,
  setInstrumentMap: setScannerInstrumentMap,
} = require("./services/intelligence/marketScanner");

// ── Backtest routes ───────────────────────────────────────────────────────────
const backtestRoutes = require("./routes/backtestRoutes");

const app    = express();
const server = http.createServer(app);
const io     = attachSocketIO(server);

app.set("io", io);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const clientPath = path.join(__dirname, "../client/dist");

// Serve Stockterminal.html explicitly BEFORE static middleware
app.get("/Stockterminal.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/public/Stockterminal.html"));
});

app.use(express.static(clientPath));
// Also serve client/public as static (catches any other public assets)
app.use(express.static(path.join(__dirname, "../client/public")));

// ── Upstox config ─────────────────────────────────────────────────────────────
const UPSTOX_API_KEY      = process.env.UPSTOX_API_KEY;
const UPSTOX_API_SECRET   = process.env.UPSTOX_API_SECRET;
const UPSTOX_REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI;

const TOKEN_FILE      = path.join(__dirname, "data/upstox_token.json");
const INSTRUMENT_FILE = path.join(__dirname, "data/upstox_instruments.json");

let upstoxAccessToken = null;
let upstoxTokenExpiry = null;

// ── MongoDB Token Schema ──────────────────────────────────────────────────────
let UpstoxTokenModel = null;
function getTokenModel() {
  if (UpstoxTokenModel) return UpstoxTokenModel;
  try {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState === 0) {
      mongoose.connect(process.env.MONGO_URI).catch(e =>
        console.warn("⚠️ MongoDB connect failed:", e.message)
      );
    }
    const schema = new mongoose.Schema({
      service:     { type: String, default: "upstox" },
      accessToken: { type: String, required: true },
      savedAt:     { type: Date, default: Date.now },
      expiresAt:   { type: Date },
    });
    UpstoxTokenModel = mongoose.models.UpstoxToken ||
                       mongoose.model("UpstoxToken", schema);
  } catch (e) {
    console.warn("⚠️ Could not init UpstoxToken model:", e.message);
  }
  return UpstoxTokenModel;
}

// Save token to MongoDB + disk
async function saveTokenEverywhere(token, expiry) {
  upstoxAccessToken = token;
  upstoxTokenExpiry = expiry || (Date.now() + 23 * 60 * 60 * 1000);

  // 1. Save to MongoDB
  try {
    const Model = getTokenModel();
    if (Model) {
      const expiresAt = new Date(upstoxTokenExpiry);
      await Model.findOneAndUpdate(
        { service: "upstox" },
        { accessToken: token, savedAt: new Date(), expiresAt },
        { upsert: true, new: true }
      );
      console.log("✅ Algo token saved to MongoDB");
    }
  } catch (e) {
    console.warn("⚠️ MongoDB token save failed:", e.message);
  }

  // 2. Save to disk as backup
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expiry: upstoxTokenExpiry }), "utf8");
    console.log("✅ Algo token saved to disk");
  } catch (e) {
    console.warn("⚠️ Disk token save failed:", e.message);
  }

  // 3. Update process env
  process.env.UPSTOX_ACCESS_TOKEN = token;
}

// ── Instrument master cache ───────────────────────────────────────────────────
const MAX_INSTRUMENT_SYMBOLS = 5000;
let instrumentMap = {};

async function loadInstrumentMaster(retryCount = 0) {
  // Check disk cache first (valid for 24h)
  try {
    if (fs.existsSync(INSTRUMENT_FILE)) {
      const cached = JSON.parse(fs.readFileSync(INSTRUMENT_FILE, "utf8"));
      if (cached._ts && Date.now() - cached._ts < 24 * 60 * 60 * 1000) {
        const fullMap = cached.map || {};
        const entries = Object.entries(fullMap);
        instrumentMap = entries.length > MAX_INSTRUMENT_SYMBOLS
          ? Object.fromEntries(entries.slice(0, MAX_INSTRUMENT_SYMBOLS))
          : fullMap;
        console.log(`✅ Instrument master loaded from cache: ${Object.keys(instrumentMap).length} symbols`);
        _pushMapToGann(instrumentMap);
        return;
      }
    }
  } catch (e) { /* rebuild below */ }

  try {
    console.log("📥 Fetching Upstox instrument master (NSE + BSE)...");
    const zlib = require("zlib");
    const map  = {};

    const exchanges = [
      { url: "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz", segment: "NSE_EQ" },
      { url: "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz", segment: "BSE_EQ" },
    ];

    for (const { url, segment } of exchanges) {
      console.log(`📥 Downloading ${url}...`);
      const res          = await axios.get(url, { timeout: 90_000, responseType: "arraybuffer" });
      console.log(`📥 Downloaded ${segment}: ${res.data.byteLength} bytes`);
      const decompressed = zlib.gunzipSync(Buffer.from(res.data));
      const instruments  = JSON.parse(decompressed.toString("utf8"));

      for (const inst of instruments) {
        if (inst.segment === segment && inst.instrument_type === "EQ") {
          if (!map[inst.trading_symbol] || segment === "NSE_EQ") {
            map[inst.trading_symbol] = inst.instrument_key;
          }
        }
      }
      console.log(`✅ ${segment} loaded`);
    }

    const entries = Object.entries(map);
    instrumentMap = entries.length > MAX_INSTRUMENT_SYMBOLS
      ? Object.fromEntries(entries.slice(0, MAX_INSTRUMENT_SYMBOLS))
      : map;

    const dir = path.dirname(INSTRUMENT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INSTRUMENT_FILE, JSON.stringify({ _ts: Date.now(), map }), "utf8");
    console.log(`✅ Instrument master: ${Object.keys(instrumentMap).length} symbols in RAM (from ${entries.length} total)`);
    _pushMapToGann(instrumentMap);
  } catch (e) {
    console.warn("⚠️ Could not fetch Upstox instrument master:", e.message);

    // Retry up to 3 times with delay before falling back
    if (retryCount < 3) {
      console.log(`🔄 Retrying instrument master download in 30s (attempt ${retryCount + 1}/3)...`);
      setTimeout(() => loadInstrumentMaster(retryCount + 1).catch(() => {}), 30_000);
    }
    instrumentMap = {
      "RELIANCE":   "NSE_EQ|INE002A01018", "TCS":        "NSE_EQ|INE467B01029",
      "HDFCBANK":   "NSE_EQ|INE040A01034", "INFY":       "NSE_EQ|INE009A01021",
      "ICICIBANK":  "NSE_EQ|INE090A01021", "SBIN":       "NSE_EQ|INE062A01020",
      "AXISBANK":   "NSE_EQ|INE238A01034", "KOTAKBANK":  "NSE_EQ|INE237A01028",
      "LT":         "NSE_EQ|INE018A01030", "WIPRO":      "NSE_EQ|INE075A01022",
      "BAJFINANCE": "NSE_EQ|INE296A01024", "BHARTIARTL": "NSE_EQ|INE397D01024",
      "HINDUNILVR": "NSE_EQ|INE030A01027", "NTPC":       "NSE_EQ|INE733E01010",
      "SUNPHARMA":  "NSE_EQ|INE044A01036", "TATAMOTORS": "NSE_EQ|INE155A01022",
      "TATASTEEL":  "NSE_EQ|INE081A01020", "MARUTI":     "NSE_EQ|INE585B01010",
      "TITAN":      "NSE_EQ|INE280A01028", "ITC":        "NSE_EQ|INE154A01025",
      "ADANIENT":   "NSE_EQ|INE423A01024", "ADANIPORTS": "NSE_EQ|INE742F01042",
      "HCLTECH":    "NSE_EQ|INE860A01027", "TECHM":      "NSE_EQ|INE669C01036",
      "ZOMATO":     "NSE_EQ|INE758T01015", "JSWSTEEL":   "NSE_EQ|INE019A01038",
      "HINDALCO":   "NSE_EQ|INE038A01020", "COALINDIA":  "NSE_EQ|INE522F01014",
      "DRREDDY":    "NSE_EQ|INE089A01023", "CIPLA":      "NSE_EQ|INE059A01026",
      "EICHERMOT":  "NSE_EQ|INE066A01021", "HEROMOTOCO": "NSE_EQ|INE158A01026",
      "BAJAJ-AUTO": "NSE_EQ|INE917I01010", "BAJAJFINSV": "NSE_EQ|INE918I01026",
      "NESTLEIND":  "NSE_EQ|INE239A01016", "ASIANPAINT": "NSE_EQ|INE021A01026",
      "ULTRACEMCO": "NSE_EQ|INE481G01011", "POWERGRID":  "NSE_EQ|INE752E01010",
      "ONGC":       "NSE_EQ|INE213A01029", "BPCL":       "NSE_EQ|INE029A01011",
      "GRASIM":     "NSE_EQ|INE047A01021", "DIVISLAB":   "NSE_EQ|INE361B01024",
      "INDUSINDBK": "NSE_EQ|INE095A01012", "HAL":        "NSE_EQ|INE066F01020",
      "BEL":        "NSE_EQ|INE263A01024", "RECLTD":     "NSE_EQ|INE020B01018",
      "PFC":        "NSE_EQ|INE134E01011", "TATACONSUM": "NSE_EQ|INE192A01025",
      "SBILIFE":    "NSE_EQ|INE123W01016", "HDFCLIFE":   "NSE_EQ|INE795G01014",
      "BRITANNIA":  "NSE_EQ|INE216A01030", "ADANIPOWER": "NSE_EQ|INE814H01011",
      "IRCTC":      "NSE_EQ|INE335Y01012", "IRFC":       "NSE_EQ|INE053F01010",
      "TRENT":      "NSE_EQ|INE849A01020", "NHPC":       "NSE_EQ|INE848E01016",
      "POLYCAB":    "NSE_EQ|INE455K01017",
      // Nifty 50 + Nifty Next 50
      "VEDL":       "NSE_EQ|INE205A01025", "SUZLON":     "NSE_EQ|INE040H01021",
      "RVNL":       "NSE_EQ|INE415G01027", "IRCON":      "NSE_EQ|INE821I01022",
      "NBCC":       "NSE_EQ|INE095N01031", "HUDCO":      "NSE_EQ|INE031A01017",
      "SJVN":       "NSE_EQ|INE002L01015", "CESC":       "NSE_EQ|INE486A01013",
      "SAIL":       "NSE_EQ|INE114A01011", "NMDC":       "NSE_EQ|INE584A01023",
      "GAIL":       "NSE_EQ|INE129A01019", "IOC":        "NSE_EQ|INE242A01010",
      "HPCL":       "NSE_EQ|INE142A01065", "BANKBARODA": "NSE_EQ|INE028A01039",
      "CANBK":      "NSE_EQ|INE476A01022", "PNB":        "NSE_EQ|INE160A01022",
      "UNIONBANK":  "NSE_EQ|INE692A01016", "IDFCFIRSTB": "NSE_EQ|INE134E01011",
      "FEDERALBNK": "NSE_EQ|INE171A01029", "RBLBANK":    "NSE_EQ|INE976G01028",
      "IDBI":       "NSE_EQ|INE008A01015", "MAHABANK":   "NSE_EQ|INE457A01014",
      "TATAPOWER":  "NSE_EQ|INE245A01021", "TORNTPOWER": "NSE_EQ|INE813H01021",
      "ADANIGREEN": "NSE_EQ|INE364U01010", "ADANITRANS": "NSE_EQ|INE931S01010",
      "INOXWIND":   "NSE_EQ|INE066P01011", "WAAREEENER": "NSE_EQ|INE080B01021",
      "CUMMINSIND": "NSE_EQ|INE298A01020", "THERMAX":    "NSE_EQ|INE152A01029",
      "ABB":        "NSE_EQ|INE117A01022", "SIEMENS":    "NSE_EQ|INE003A01024",
      "BHEL":       "NSE_EQ|INE257A01026", "BDL":        "NSE_EQ|INE171Z01018",
      "COCHINSHIP": "NSE_EQ|INE704P01017", "GRSE":       "NSE_EQ|INE382Z01011",
      "MIDHANI":    "NSE_EQ|INE249Z01012", "DATAPATTNS": "NSE_EQ|INE0IX01010",
      "MAZDOCK":    "NSE_EQ|INE249Z01012", "BEML":       "NSE_EQ|INE258A01016",
      "TITAGARH":   "NSE_EQ|INE615H01020", "TEXMACO":    "NSE_EQ|INE621A01010",
      "JUPITERWAG": "NSE_EQ|INE0C3A01013", "KECL":       "NSE_EQ|INE389H01022",
      "KALPATPOWR": "NSE_EQ|INE758T01015", "PATELENG":   "NSE_EQ|INE078B01023",
      "TECHNOE":    "NSE_EQ|INE105C01023", "WABAG":      "NSE_EQ|INE868B01028",
      "RITES":      "NSE_EQ|INE320J01015", "HFCL":       "NSE_EQ|INE548A01028",
      "RAILVIKAS":  "NSE_EQ|INE415G01027", "STERLITE":   "NSE_EQ|INE268A01031",
      "HINDCOPPER": "NSE_EQ|INE531E01026", "MOIL":       "NSE_EQ|INE490G01020",
      "NATIONALUM": "NSE_EQ|INE139A01034", "APLAPOLLO":  "NSE_EQ|INE702C01019",
      "JINDALSTEL": "NSE_EQ|INE749A01030", "JSWENERGY":  "NSE_EQ|INE121E01018",
      "TATAELXSI":  "NSE_EQ|INE670A01012", "MPHASIS":    "NSE_EQ|INE356A01018",
      "PERSISTENT": "NSE_EQ|INE262H01021", "LTTS":       "NSE_EQ|INE010V01017",
      "COFORGE":    "NSE_EQ|INE591G01017", "SONACOMS":   "NSE_EQ|INE073K01018",
      "MOTHERSON":  "NSE_EQ|INE775A01035", "BHARATFORG": "NSE_EQ|INE465A01025",
      "EXIDEIND":   "NSE_EQ|INE302A01020", "AMARARAJA":  "NSE_EQ|INE885A01032",
      "ASHOKLEY":   "NSE_EQ|INE208A01029", "TVSMOTOR":   "NSE_EQ|INE494B01023",
      "ESCORTS":    "NSE_EQ|INE042A01014", "M&MFIN":     "NSE_EQ|INE774D01024",
      "CHOLAFIN":   "NSE_EQ|INE121A01024", "MUTHOOTFIN": "NSE_EQ|INE414G01012",
      "MANAPPURAM": "NSE_EQ|INE522D01027", "ABCAPITAL":  "NSE_EQ|INE674K01013",
      "LICHSGFIN":  "NSE_EQ|INE115A01026", "CANFINHOME": "NSE_EQ|INE477A01020",
      "OBEROIRLTY": "NSE_EQ|INE093I01010", "DLF":        "NSE_EQ|INE271C01023",
      "PRESTIGE":   "NSE_EQ|INE811K01011", "GODREJPROP": "NSE_EQ|INE484J01027",
      "PHOENIXLTD": "NSE_EQ|INE792G01026", "BRIGADE":    "NSE_EQ|INE791G01019",
      "NAUKRI":     "NSE_EQ|INE663F01024", "DMART":      "NSE_EQ|INE192R01011",
      "TRENT":      "NSE_EQ|INE849A01020", "PAGEIND":    "NSE_EQ|INE761H01022",
      "VOLTAS":     "NSE_EQ|INE226A01021", "WHIRLPOOL":  "NSE_EQ|INE716A01013",
      "HAVELLS":    "NSE_EQ|INE176B01034", "CROMPTON":   "NSE_EQ|INE299U01018",
      "DIXON":      "NSE_EQ|INE935N01020", "AMBER":      "NSE_EQ|INE371P01015",
      "AFFLE":      "NSE_EQ|INE00WC01010", "ZOMATO":     "NSE_EQ|INE758T01015",
      "NYKAA":      "NSE_EQ|INE388Y01029", "POLICYBZR":  "NSE_EQ|INE417T01026",
      "PAYTM":      "NSE_EQ|INE982J01020", "DELHIVERY":  "NSE_EQ|INE152O01027",
      "CEMPRO":     "BSE_EQ|543066",
    };
    console.log(`⚠️ Using fallback instrument map: ${Object.keys(instrumentMap).length} symbols`);
    _pushMapToGann(instrumentMap);
  }
}

function _pushMapToGann(map) {
  try {
    require("./services/intelligence/gannDataFetcher").setInstrumentMap(map);
  } catch (e) {
    console.warn("⚠️ Could not push instrument map to Gann fetcher:", e.message);
  }
}

function getInstrumentMap() { return instrumentMap; }

// ── getInstrumentKeyFull — also caches disk hits into RAM ────────────────────
function getInstrumentKeyFull(symbol) {
  if (instrumentMap[symbol]) return instrumentMap[symbol];
  try {
    if (fs.existsSync(INSTRUMENT_FILE)) {
      const cached  = JSON.parse(fs.readFileSync(INSTRUMENT_FILE, "utf8"));
      const fullMap = cached.map || {};
      if (fullMap[symbol]) {
        instrumentMap[symbol] = fullMap[symbol]; // cache in RAM for next call
        console.log(`📍 Symbol ${symbol} found in full disk map: ${fullMap[symbol]}`);
        return fullMap[symbol];
      }
    }
  } catch (e) {
    console.warn(`⚠️ Full instrument map lookup failed for ${symbol}:`, e.message);
  }
  return null;
}

// ── resolveInstrumentKey — 5-step resolution with full logging ───────────────
// FIX: This is the main fix for CEMPRO and other mid/small-cap stocks
// that aren't in the RAM slice but exist on Upstox.
async function resolveInstrumentKey(symbol) {
  const sym = symbol.toUpperCase().trim();

  // Step 1: RAM cache (fastest)
  if (instrumentMap[sym]) {
    console.log(`📍 [resolve] ${sym} → RAM: ${instrumentMap[sym]}`);
    return instrumentMap[sym];
  }

  // Step 2: Full disk map (catches stocks not in the 5000-cap RAM slice)
  const diskKey = getInstrumentKeyFull(sym);
  if (diskKey) {
    console.log(`📍 [resolve] ${sym} → disk: ${diskKey}`);
    return diskKey;
  }

  // Step 3: Direct NSE_EQ pattern — validate via Upstox quote API
  // Many stocks follow NSE_EQ|SYMBOL directly. Test it before using.
  if (upstoxAccessToken) {
    const nseCandidate = `NSE_EQ|${sym}`;
    try {
      const r = await axios.get("https://api.upstox.com/v2/market-quote/quotes", {
        params:  { instrument_key: nseCandidate },
        headers: { Authorization: "Bearer " + upstoxAccessToken, Accept: "application/json" },
        timeout: 5_000,
      });
      const d = r.data?.data || {};
      if (d[nseCandidate] || d[nseCandidate.replace("|", ":")]) {
        instrumentMap[sym] = nseCandidate; // cache it
        console.log(`📍 [resolve] ${sym} → NSE_EQ direct validated: ${nseCandidate}`);
        return nseCandidate;
      }
    } catch (e) {
      console.warn(`⚠️ [resolve] ${sym} NSE_EQ direct test failed:`, e.response?.status || e.message);
    }

    // Step 4: BSE_EQ fallback
    const bseCandidate = `BSE_EQ|${sym}`;
    try {
      const r = await axios.get("https://api.upstox.com/v2/market-quote/quotes", {
        params:  { instrument_key: bseCandidate },
        headers: { Authorization: "Bearer " + upstoxAccessToken, Accept: "application/json" },
        timeout: 5_000,
      });
      const d = r.data?.data || {};
      if (d[bseCandidate] || d[bseCandidate.replace("|", ":")]) {
        instrumentMap[sym] = bseCandidate;
        console.log(`📍 [resolve] ${sym} → BSE_EQ direct validated: ${bseCandidate}`);
        return bseCandidate;
      }
    } catch (e) {
      console.warn(`⚠️ [resolve] ${sym} BSE_EQ direct test failed:`, e.response?.status || e.message);
    }

    // Step 5: Live Upstox search (last resort — slower but catches anything)
    try {
      console.log(`🔍 [resolve] ${sym} → trying live Upstox search...`);
      const r = await axios.get("https://api.upstox.com/v2/market-quote/search", {
        params:  { query: sym, asset_type: "equity" },
        headers: { Authorization: "Bearer " + upstoxAccessToken, Accept: "application/json" },
        timeout: 8_000,
      });
      const items = r.data?.data || [];
      const match =
        items.find(i => i.tradingsymbol === sym && i.instrument_key?.startsWith("NSE_EQ")) ||
        items.find(i => i.tradingsymbol === sym && i.instrument_key?.startsWith("BSE_EQ")) ||
        items.find(i => i.tradingsymbol === sym);

      if (match?.instrument_key) {
        instrumentMap[sym] = match.instrument_key;
        console.log(`✅ [resolve] ${sym} → live search: ${match.instrument_key}`);
        return match.instrument_key;
      }
      console.warn(`⚠️ [resolve] ${sym} not found in Upstox search. Returned:`, items.slice(0, 3).map(i => i.tradingsymbol));
    } catch (e) {
      console.warn(`⚠️ [resolve] ${sym} live search failed:`, e.response?.status || e.message);
    }
  }

  console.error(`❌ [resolve] ${sym} — NOT FOUND in RAM(${Object.keys(instrumentMap).length}), disk, direct NSE/BSE test, or live search. Visit /api/test-search?symbol=${sym} to debug.`);
  return null;
}

// ── Last valid trading day helper ─────────────────────────────────────────────
// FIX: Upstox EOD rejects today AND weekends as toDate
function getLastTradingDay() {
  const d = new Date();
  d.setDate(d.getDate() - 1); // never use today
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1); // skip Sat(6) and Sun(0)
  }
  return d;
}

// ── Token helpers ─────────────────────────────────────────────────────────────
async function validateTokenLive(token) {
  try {
    const r = await axios.get("https://api.upstox.com/v2/user/profile", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      timeout: 6000,
    });
    return r.status === 200;
  } catch (e) {
    if (e.response?.status === 401) return false;
    console.warn("⚠️ Token live-check network error:", e.message, "— assuming token valid");
    return true;
  }
}

async function loadToken() {
  // Priority 1: MongoDB Algo Trading token
  try {
    const Model = getTokenModel();
    if (Model) {
      const doc = await Model.findOne({ service: "upstox" });
      if (doc && doc.accessToken && new Date() < doc.expiresAt) {
        console.log("🔍 MongoDB token found — validating against Upstox...");
        const alive = await validateTokenLive(doc.accessToken);
        if (alive) {
          upstoxAccessToken = doc.accessToken;
          upstoxTokenExpiry = doc.expiresAt.getTime();
          console.log("✅ Algo Trading token loaded from MongoDB (live-validated)");
          process.env.UPSTOX_ACCESS_TOKEN = upstoxAccessToken;
          return;
        } else {
          console.log("❌ MongoDB token is DEAD (Upstox rejected it) — visit /auth/upstox to refresh");
          try { await Model.deleteOne({ service: "upstox" }); } catch (_) {}
          return;
        }
      } else if (doc) {
        console.log("⚠️ MongoDB token timestamp expired — falling back");
      }
    }
  } catch (e) {
    console.warn("⚠️ MongoDB token load failed:", e.message);
  }

  // Priority 2: Analytics Token from env
  if (process.env.UPSTOX_ANALYTICS_TOKEN) {
    upstoxAccessToken = process.env.UPSTOX_ANALYTICS_TOKEN;
    upstoxTokenExpiry = Date.now() + 365 * 24 * 60 * 60 * 1000;
    console.log("✅ Analytics Token loaded from env (charts will work, live feed needs Algo token)");
    return;
  }

  // Priority 3: Disk token file
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (saved.token && saved.expiry && Date.now() < saved.expiry) {
        upstoxAccessToken = saved.token;
        upstoxTokenExpiry = saved.expiry;
        console.log("✅ Token loaded from disk, expires:", new Date(saved.expiry).toISOString());
        return;
      }
    }
  } catch (e) {
    console.warn("Could not load token from disk:", e.message);
  }

  console.log("⚠️ No valid token found — visit /auth/upstox to connect");
}

function clearToken() {
  upstoxAccessToken = null;
  upstoxTokenExpiry = null;
  try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch {}
}

// ── MEMORY FIX: marketCapDB module-level cache ────────────────────────────────
let _mcapCache   = null;
let _mcapCacheTS = 0;
const MCAP_CACHE_TTL = 10 * 60 * 1000;

function getCachedMcap(limit) {
  if (_mcapCache && Date.now() - _mcapCacheTS < MCAP_CACHE_TTL) {
    return limit ? _mcapCache.slice(0, limit) : _mcapCache;
  }
  try {
    const mcapPath = path.join(__dirname, "data/marketCapDB.json");
    if (!fs.existsSync(mcapPath)) {
      _mcapCache   = [];
      _mcapCacheTS = Date.now();
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(mcapPath, "utf8"));
    const arr = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([code, d]) => ({ code, company: d.name || "", mcap: d.mcap || 0 }));
    _mcapCache   = arr.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    _mcapCacheTS = Date.now();
    console.log(`📊 mcapDB cached: ${_mcapCache.length} companies`);
  } catch (e) {
    console.warn("mcapDb cache refresh failed:", e.message);
    _mcapCache = _mcapCache || [];
  }
  return limit ? _mcapCache.slice(0, limit) : _mcapCache;
}

// ── Startup sequence ──────────────────────────────────────────────────────────
async function startApp() {
  await loadToken();

  await loadInstrumentMaster().catch((e) => {
    console.warn("⚠️ loadInstrumentMaster threw unexpectedly:", e.message);
  });

  getCachedMcap();

  setOITickHandler(handleOITick);

  const { registerLTPTick } = require("./coordinator");
  setLTPTickHandler(registerLTPTick);

  const backtestEngine = require("./services/backtestEngine");
  backtestEngine.init(io);
  setBacktestEngine(backtestEngine);

  if (upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0)) {
    setTimeout(() => restartWithNewToken(upstoxAccessToken, io), 2000);
  } else {
    console.log("⚠️ No valid token at startup — visit /auth/upstox to connect");
  }

  if (!IS_WEEKEND) {
    console.log("📡 Weekday: starting all market services...");
    startNSEOIListener(io, () => upstoxAccessToken);
    startBSEListener(io);
    startNSEDealsListener(io);
    startCoordinator(io, () => upstoxAccessToken, () => instrumentMap);
    setScannerInstrumentMap(instrumentMap);
    startMarketScanner(io);
  } else {
    console.log("💤 Weekend: skipping NSE/BSE listeners and OI — saving ~150MB");
    startCoordinator(io, () => upstoxAccessToken, () => instrumentMap);
    setScannerInstrumentMap(instrumentMap);
    startMarketScanner(io);

    // ── Weekend: load OI cache and serve to clients on connection ──
    try {
      const { getAllCached, getExpiries } = require("./services/intelligence/nseOIListener");
      // Manually load the cache file without starting the full listener
      const fs2       = require("fs");
      const path2     = require("path");
      const cacheFile = path2.join(__dirname, "data/optionChainCache.json");
      let weekendCache = {};
      if (fs2.existsSync(cacheFile)) {
        weekendCache = JSON.parse(fs2.readFileSync(cacheFile, "utf8"));
        console.log(`📦 Weekend OI cache loaded: ${Object.keys(weekendCache).join(", ")}`);
      }
      io.on("connection", (socket) => {
        for (const [name, data] of Object.entries(weekendCache)) {
          if (data.expiries?.length) {
            socket.emit("option-expiries", { underlying: name, expiries: data.expiries });
          }
          for (const [expiry, chain] of Object.entries(data.chains || {})) {
            socket.emit("option-chain-update", { underlying: name, expiry, data: chain });
          }
        }
      });
    } catch (e) {
      console.warn("⚠️ Weekend OI cache load failed:", e.message);
    }
  }

  if (upstoxAccessToken) {
    setICFToken(upstoxAccessToken);
    console.log("✅ Index candle fetcher token set");
  }
  startIndexCandleFetcher();

  scheduleDailyTokenCheck();

  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log("Server running on port", PORT);
    console.log("Retention: " + getRetentionHours() + "h (" + getWindowLabel() + ")");
    if (UPSTOX_API_KEY) {
      console.log("✅ Upstox API configured");
      console.log("👉 Daily login: /auth/upstox");
    } else {
      console.log("WARNING: UPSTOX_API_KEY not set");
    }
  });
}

startApp().catch(e => console.error("❌ startApp failed:", e.message));

// ── Daily token check scheduler ───────────────────────────────────────────────
function scheduleDailyTokenCheck() {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(3, 30, 0, 0); // 9:00 AM IST
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  console.log(`[TokenCheck] Next check in ${Math.round(ms / 60000)} min (9:00 AM IST)`);
  setTimeout(async () => {
    const valid = upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0);
    if (!valid) {
      console.log("⚠️ [TokenCheck] TOKEN EXPIRED — Visit /auth/upstox to refresh!");
    } else {
      console.log("✅ [TokenCheck] Token valid at market open — restarting stream");
      restartWithNewToken(upstoxAccessToken, io);
    }
    scheduleDailyTokenCheck();
  }, ms);
}

// ── Backtest API ──────────────────────────────────────────────────────────────
app.use("/api/backtest", backtestRoutes);

// ── Auth routes ───────────────────────────────────────────────────────────────
const UPSTOX_INSTRUMENTS = {
  "NIFTY 50":   "NSE_INDEX|Nifty 50",
  "SENSEX":     "BSE_INDEX|SENSEX",
  "BANK NIFTY": "NSE_INDEX|Nifty Bank",
};
const INDEX_NAMES = ["NIFTY 50", "SENSEX", "BANK NIFTY"];

app.get("/auth/upstox", (req, res) => {
  if (!UPSTOX_API_KEY || !UPSTOX_REDIRECT_URI)
    return res.send("ERR: UPSTOX_API_KEY or UPSTOX_REDIRECT_URI not set.");
  const authUrl =
    "https://api.upstox.com/v2/login/authorization/dialog" +
    "?response_type=code&client_id=" + UPSTOX_API_KEY +
    "&redirect_uri=" + encodeURIComponent(UPSTOX_REDIRECT_URI);
  res.redirect(authUrl);
});

app.get("/auth/upstox/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("ERR: No auth code received.");
  try {
    const response = await axios.post(
      "https://api.upstox.com/v2/login/authorization/token",
      new URLSearchParams({
        code,
        client_id:     UPSTOX_API_KEY,
        client_secret: UPSTOX_API_SECRET,
        redirect_uri:  UPSTOX_REDIRECT_URI,
        grant_type:    "authorization_code",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" } }
    );

    const newToken  = response.data.access_token;
    const newExpiry = Date.now() + (response.data.expires_in || 86400) * 1000;

    await saveTokenEverywhere(newToken, newExpiry);
    setICFToken(newToken);
    restartWithNewToken(newToken, io);

    try {
      const scanner = require("./services/intelligence/marketScanner");
      if (typeof scanner.setToken === "function") scanner.setToken(newToken);
    } catch (_) {}

    res.send(
      "<html><body style='background:#010812;color:#00ff9c;font-family:monospace;padding:40px;text-align:center'>" +
      "<h2>✅ Upstox Connected!</h2>" +
      "<p style='color:#b8cfe8'>Algo Trading token saved. Live stream active.</p>" +
      "<p style='color:#4a8adf'>Token expires: " +
        new Date(newExpiry).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) +
      " IST</p>" +
      "<p style='color:#00ff9c'>✅ Charts (5min/15min/1hr/4hr) now active</p>" +
      "<p style='color:#00ff9c'>✅ Live prices & % change now active</p>" +
      "<p style='color:#00ff9c'>✅ Token saved to MongoDB — survives restarts</p><br>" +
      "<a href='/' style='color:#00cfff;text-decoration:none;border:1px solid #00cfff33;padding:8px 16px;border-radius:4px'>Back to Dashboard</a>" +
      "</body></html>"
    );
  } catch (e) {
    console.error("Upstox token exchange failed:", e.response?.data || e.message);
    res.send("ERR: Token exchange failed: " + (e.response?.data?.message || e.message));
  }
});

app.get("/auth/upstox/status", (req, res) => {
  const connected = !!(upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0));
  res.json({
    connected,
    expiry: upstoxTokenExpiry
      ? new Date(upstoxTokenExpiry).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      : null,
    tokenType: upstoxAccessToken
      ? (upstoxAccessToken === process.env.UPSTOX_ANALYTICS_TOKEN ? "Analytics (read-only)" : "Algo Trading (full access)")
      : "none",
    hint: connected ? null : "Visit /auth/upstox to connect",
  });
});

// ── /api/market ───────────────────────────────────────────────────────────────
const restPrevCloseCache = {};

async function fetchUpstoxMarket() {
  const keys = Object.values(UPSTOX_INSTRUMENTS).join(",");
  const res  = await axios.get(
    "https://api.upstox.com/v2/market-quote/quotes?instrument_key=" + encodeURIComponent(keys),
    { headers: { Authorization: "Bearer " + upstoxAccessToken, Accept: "application/json" }, timeout: 8000 }
  );
  const data = res.data?.data || {};
  return INDEX_NAMES.map(name => {
    const key   = UPSTOX_INSTRUMENTS[name];
    const quote = data[key] || data[key.replace("|", ":")] || null;
    if (!quote) return { name, price: "—", change: "—", pct: "—", up: null };
    const price = quote.last_price || 0;

    let prevClose = 0;
    if (quote.net_change != null && price > 0) {
      prevClose = price - quote.net_change;
    } else {
      const ohlcClose = quote.ohlc?.close || 0;
      if (ohlcClose > 0) {
        restPrevCloseCache[name] = ohlcClose;
        prevClose = ohlcClose;
      } else {
        prevClose = restPrevCloseCache[name] || price;
      }
    }

    const diff = price - prevClose;
    const pct  = prevClose > 0 ? (diff / prevClose) * 100 : 0;
    const up   = diff >= 0;
    return {
      name,
      price:  price.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
      change: (up ? "+" : "") + diff.toFixed(2),
      pct:    (up ? "+" : "") + pct.toFixed(2) + "%",
      up,
    };
  });
}

app.get("/api/market", async (req, res) => {
  const blank       = INDEX_NAMES.map(name => ({ name, price: "—", change: "—", pct: "—", up: null }));
  const upstoxReady = upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0);
  if (!upstoxReady) return res.json([...blank, { _source: "disconnected" }]);
  try {
    return res.json([...await fetchUpstoxMarket(), { _source: "upstox" }]);
  } catch (e) {
    console.error("Upstox market fetch failed:", e.message);
    if (e.response?.status === 401) { clearToken(); stopStreamer(); return res.json([...blank, { _source: "disconnected" }]); }
    return res.json([...blank, { _source: "error" }]);
  }
});

// ── /api/commodities ──────────────────────────────────────────────────────────
app.get("/api/commodities", commoditiesRoute);

// ── /health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status:        "ok",
    weekend:       IS_WEEKEND,
    upstox:        (upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0)) ? "connected" : "disconnected",
    tokenType:     upstoxAccessToken === process.env.UPSTOX_ANALYTICS_TOKEN ? "analytics" : "algo",
    instrumentMap: Object.keys(instrumentMap).length,
    mcapCached:    _mcapCache ? _mcapCache.length : 0,
    memory: {
      rss:       Math.round(mem.rss       / 1024 / 1024) + " MB",
      heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024) + " MB",
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + " MB",
      external:  Math.round(mem.external  / 1024 / 1024) + " MB",
    },
  });
});

// ── /api/debug/hv ─────────────────────────────────────────────────────────────
app.get("/api/debug/hv", (req, res) => {
  try { res.json(getDebugInfo()); }
  catch (e) { res.json({ error: e.message }); }
});

// ── /api/debug/candles ────────────────────────────────────────────────────────
app.get("/api/debug/candles", async (req, res) => {
  const symbol = (req.query.symbol || "RELIANCE").toUpperCase();
  const tf     = req.query.tf || "1day";
  try {
    const result = await getTechnicalsForTimeframe(symbol, tf);
    if (!result) {
      return res.json({
        ok: false, symbol, tf,
        message: "No data returned — check server logs",
        debug: {
          tokenPresent:           !!(upstoxAccessToken),
          tokenType:              upstoxAccessToken === process.env.UPSTOX_ANALYTICS_TOKEN ? "analytics" : "algo",
          instrumentMapSize:      Object.keys(getInstrumentMap()).length,
          instrumentKeyForSymbol: getInstrumentKeyFull(symbol),
        },
      });
    }
    res.json({
      ok: true, symbol, tf,
      ltp:        result.ltp,
      techScore:  result.techScore,
      signal:     result.signal,
      rsi:        result.rsi,
      macd:       result.macd?.crossover,
      computedAt: new Date(result.computedAt).toISOString(),
    });
  } catch (e) {
    res.json({ ok: false, symbol, tf, error: e.message });
  }
});

// ── /api/test-circuit ─────────────────────────────────────────────────────────
app.get("/api/test-circuit", async (req, res) => {
  const symbol = req.query.symbol || "RELIANCE";
  const ikey   = getInstrumentKeyFull(symbol);
  if (!ikey) return res.json({ error: `Symbol ${symbol} not in instrument map`, mapSize: Object.keys(instrumentMap).length });
  try {
    const r = await axios.get("https://api.upstox.com/v2/market-quote/quotes", {
      params:  { instrument_key: ikey },
      headers: { Authorization: "Bearer " + upstoxAccessToken, Accept: "application/json" },
      timeout: 10_000,
    });
    res.json({ symbol, instrument_key: ikey, response: r.data });
  } catch (e) {
    res.json({ symbol, instrument_key: ikey, error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

// ── /api/candles/:symbol ──────────────────────────────────────────────────────
// FIX 1: Robust 5-step instrument resolution — catches CEMPRO and all mid/small-caps
// FIX 2: EOD toDate always skips weekends via getLastTradingDay()
// FIX 3: NSE fail → auto-retry with BSE instrument key
// FIX 4: Full error logging with HTTP status codes so you can see exact Upstox errors in Render logs
app.get("/api/candles/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const tf     = req.query.tf || "1day";
  const days   = parseInt(req.query.days || "30");

  if (!upstoxAccessToken) {
    return res.json({ ok: false, error: "No token — visit /auth/upstox", symbol });
  }

  // ── Resolve instrument key (5-step) ───────────────────────────────────────
  const instrKey = await resolveInstrumentKey(symbol);
  if (!instrKey) {
    return res.json({
      ok:    false,
      error: `Symbol ${symbol} not found. Try /api/test-search?symbol=${symbol} to debug.`,
      symbol,
      debug: {
        ramSize: Object.keys(instrumentMap).length,
        hint:    "Symbol may be listed differently on Upstox (e.g. CEMPRO vs CEMBIOSYS)",
      },
    });
  }

  // ── v3 API timeframe config ───────────────────────────────────────────────
  const TF_MAP_V3 = {
    "1min":   { unit: "minutes", minutes: 1,    eod: false },
    "5min":   { unit: "minutes", minutes: 5,    eod: false },
    "15min":  { unit: "minutes", minutes: 15,   eod: false },
    "30min":  { unit: "minutes", minutes: 30,   eod: false },
    "1hour":  { unit: "minutes", minutes: 60,   eod: false },
    "4hour":  { unit: "minutes", minutes: 240,  eod: false },
    "1day":   { unit: "day",     minutes: null, eod: true  },
    "1week":  { unit: "week",    minutes: null, eod: true  },
    "1month": { unit: "month",   minutes: null, eod: true  },
  };

  const tfCfg      = TF_MAP_V3[tf] || TF_MAP_V3["1day"];
  const isIntraday = !tfCfg.eod;
  const fmt        = d => d.toISOString().split("T")[0];
  const headers    = { Authorization: "Bearer " + upstoxAccessToken, Accept: "application/json" };
  const encodedKey = encodeURIComponent(instrKey);

  const buildHistUrl = (instrKeyEncoded, toDate, fromDate) => {
    const unitSegment = isIntraday
      ? `${tfCfg.unit}/${tfCfg.minutes}`
      : tfCfg.unit;
    return `https://api.upstox.com/v3/historical-candle/${instrKeyEncoded}/${unitSegment}/${fmt(toDate)}/${fmt(fromDate)}`;
  };

  const buildIntradayUrl = (instrKeyEncoded) =>
    `https://api.upstox.com/v3/historical-candle/intraday/${instrKeyEncoded}/minutes/${tfCfg.minutes}`;

  // v3 candle format: [timestamp, open, high, low, close, volume, oi]
  // v3 returns newest-first — reverse for chronological order
  const parseCandles = (raw) =>
    (raw || [])
      .map(c => ({
        time:   new Date(c[0]).getTime(),
        open:   c[1],
        high:   c[2],
        low:    c[3],
        close:  c[4],
        volume: c[5],
      }))
      .reverse();

  // ── Helper: try fetching candles with a given instrument key ─────────────
  async function fetchEODCandles(iKey, toDate, fromDate) {
    const enc = encodeURIComponent(iKey);
    const url = buildHistUrl(enc, toDate, fromDate);
    console.log(`🔍 [candles] EOD → ${url}`);
    const r = await axios.get(url, { headers, timeout: 15_000 });
    return parseCandles(r.data?.data?.candles);
  }

  try {
    let allCandles = [];

    if (isIntraday) {
      // ── Step 1: Today's live intraday candles ─────────────────────────────
      try {
        const url = buildIntradayUrl(encodedKey);
        const r   = await axios.get(url, { headers, timeout: 15_000 });
        const todayCandles = parseCandles(r.data?.data?.candles);
        allCandles = todayCandles;
        console.log(`✅ v3 intraday [${symbol}/${tf}]: ${todayCandles.length} candles today`);
      } catch (e) {
        console.warn(`⚠️ v3 intraday [${symbol}/${tf}]: HTTP ${e.response?.status} —`, e.response?.data?.message || e.message);
      }

      // ── Step 2: Historical intraday candles (yesterday and back) ──────────
      const toDate   = new Date();
      toDate.setDate(toDate.getDate() - 1);
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - Math.min(days, 30));

      try {
        const url = buildHistUrl(encodedKey, toDate, fromDate);
        const r   = await axios.get(url, { headers, timeout: 15_000 });
        const histCandles = parseCandles(r.data?.data?.candles);
        allCandles = [...histCandles, ...allCandles];
        console.log(`✅ v3 historical intraday [${symbol}/${tf}]: ${histCandles.length} candles`);
      } catch (e) {
        console.warn(`⚠️ v3 historical intraday [${symbol}/${tf}]: HTTP ${e.response?.status} —`, e.response?.data?.message || e.message);
      }

    } else {
      // ── EOD candles (1D / 1W / 1M) ───────────────────────────────────────
      // FIX: toDate = last trading day; fromDate = toDate - days (not today - days)
      const toDate   = getLastTradingDay();
      const fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - Math.min(days, 365));

      console.log(`📅 [candles] EOD toDate=${fmt(toDate)} (${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][toDate.getDay()]})`);

      try {
        allCandles = await fetchEODCandles(instrKey, toDate, fromDate);
        console.log(`✅ v3 EOD [${symbol}/${tf}]: ${allCandles.length} candles`);
      } catch (e) {
        const status = e.response?.status;
        const msg    = e.response?.data?.message || e.message;
        console.error(`❌ v3 EOD [${symbol}/${tf}]: HTTP ${status} — ${msg}`);

        // FIX: If NSE_EQ failed, auto-retry with BSE_EQ instrument key
        if (instrKey.startsWith("NSE_EQ|") && status === 400) {
          const bseFallback = `BSE_EQ|${symbol}`;
          console.log(`🔄 [candles] NSE failed (400) → retrying with BSE fallback: ${bseFallback}`);
          try {
            allCandles = await fetchEODCandles(bseFallback, toDate, fromDate);
            console.log(`✅ v3 EOD BSE fallback [${symbol}/${tf}]: ${allCandles.length} candles`);
            // Cache the BSE key so future requests skip the NSE attempt
            if (allCandles.length > 0) instrumentMap[symbol] = bseFallback;
          } catch (e2) {
            console.error(`❌ v3 EOD BSE fallback also failed [${symbol}]: HTTP ${e2.response?.status} — ${e2.response?.data?.message || e2.message}`);
          }
        }
      }

      // ── For 1D: append live today candle using intraday 1min data ────────
      // This gives a live "today" bar even during/after trading hours
      if (tf === "1day") {
        try {
          const todayUrl = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/minutes/1`;
          const r2       = await axios.get(todayUrl, { headers, timeout: 10_000 });
          const ticks    = r2.data?.data?.candles || [];
          if (ticks.length) {
            const todayCandle = {
              time:   new Date(new Date().toISOString().split("T")[0] + "T00:00:00.000Z").getTime(),
              open:   ticks[ticks.length - 1][1],  // oldest tick = day open
              high:   Math.max(...ticks.map(c => c[2])),
              low:    Math.min(...ticks.map(c => c[3])),
              close:  ticks[0][4],                  // newest tick = live price
              volume: ticks.reduce((a, c) => a + c[5], 0),
            };
            const todayStr = new Date().toISOString().split("T")[0];
            const lastHist = allCandles[allCandles.length - 1];
            const lastStr  = lastHist ? new Date(lastHist.time).toISOString().split("T")[0] : "";
            if (todayStr !== lastStr) {
              allCandles.push(todayCandle);
              console.log(`✅ v3 today-candle appended [${symbol}]: close=${todayCandle.close}`);
            } else {
              // Update last historical bar with live data
              lastHist.high   = Math.max(lastHist.high, todayCandle.high);
              lastHist.low    = Math.min(lastHist.low,  todayCandle.low);
              lastHist.close  = todayCandle.close;
              lastHist.volume = todayCandle.volume;
              console.log(`✅ v3 today-candle updated [${symbol}]: close=${todayCandle.close}`);
            }
          }
        } catch (e) {
          // Non-fatal — market may be closed, weekend etc.
          console.warn(`⚠️ v3 today-candle [${symbol}]: ${e.response?.status || e.message}`);
        }
      }
    }

    if (!allCandles.length) {
      return res.json({
        ok:    false,
        symbol,
        tf,
        error: "No candles returned from Upstox",
        debug: {
          instrKey,
          toDate: fmt(getLastTradingDay()),
          hint:   "Check Render logs for exact HTTP error code. If 400: symbol may be delisted or BSE-only.",
        },
      });
    }

    // Deduplicate by timestamp
    const seen = new Set();
    allCandles = allCandles.filter(c => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

    res.json({
      ok:       true,
      symbol,
      tf,
      instrKey,
      interval: isIntraday ? `${tfCfg.unit}/${tfCfg.minutes}` : tfCfg.unit,
      count:    allCandles.length,
      candles:  allCandles,
    });

  } catch (e) {
    console.error(`❌ Candle fetch failed [${symbol}/${tf}]:`, e.response?.data || e.message);
    res.json({
      ok:     false,
      symbol,
      tf,
      error:  e.response?.data?.message || e.message,
      status: e.response?.status,
    });
  }
});

// ── /api/test-instrument-map ──────────────────────────────────────────────────
app.get("/api/test-instrument-map", (req, res) => {
  res.json({ total: Object.keys(instrumentMap).length, sample: Object.entries(instrumentMap).slice(0, 10) });
});

// ── /api/test-search ──────────────────────────────────────────────────────────
app.get("/api/test-search", async (req, res) => {
  const symbol = (req.query.symbol || "SCHNEIDER").toUpperCase();
  try {
    const fromCache = getInstrumentKeyFull(symbol);
    if (fromCache) {
      return res.json({ ok: true, symbol, instrument_key: fromCache, source: "cache", note: "Already in RAM/disk — no search needed" });
    }
    if (!upstoxAccessToken) {
      return res.json({ ok: false, symbol, error: "No token" });
    }
    const r = await axios.get("https://api.upstox.com/v2/market-quote/search", {
      params:  { query: symbol, asset_type: "equity" },
      headers: { Authorization: "Bearer " + upstoxAccessToken, Accept: "application/json" },
      timeout: 8_000,
    });
    const items = r.data?.data || [];
    const match =
      items.find(i => i.tradingsymbol === symbol && i.instrument_key?.startsWith("NSE_EQ")) ||
      items.find(i => i.tradingsymbol === symbol && i.instrument_key?.startsWith("BSE_EQ")) ||
      items.find(i => i.tradingsymbol === symbol);

    if (match) {
      return res.json({
        ok:             true,
        symbol,
        instrument_key: match.instrument_key,
        tradingsymbol:  match.tradingsymbol,
        exchange:       match.exchange || match.instrument_key?.split("|")[0],
        source:         "live_search",
        all_matches:    items.slice(0, 5).map(i => ({ sym: i.tradingsymbol, key: i.instrument_key })),
      });
    }
    return res.json({
      ok:       false,
      symbol,
      error:    "No exact match found in Upstox search results",
      returned: items.slice(0, 10).map(i => ({ sym: i.tradingsymbol, key: i.instrument_key })),
      hint:     "Check 'returned' — symbol may be listed under a different name on Upstox",
    });
  } catch (e) {
    return res.json({
      ok:     false,
      symbol,
      error:  e.response?.data?.message || e.message,
      status: e.response?.status,
      hint:   e.response?.status === 404 ? "Search API not available on this Upstox plan" :
              e.response?.status === 401 ? "Token rejected" : "Network/API error",
    });
  }
});

// ── /api/option-chain ─────────────────────────────────────────────────────────
app.get("/api/option-chain/expiries", (req, res) => {
  const underlying = req.query.underlying || "NIFTY";
  res.json({ underlying, expiries: getExpiries(underlying) });
});

app.get("/api/option-chain", (req, res) => {
  const underlying = req.query.underlying || "NIFTY";
  const expiry     = req.query.expiry;
  if (!expiry) {
    const expiries = getExpiries(underlying);
    if (!expiries.length) return res.json({ error: "No expiry data yet" });
    return res.json({ underlying, expiries });
  }
  const chain = getChain(underlying, expiry);
  if (!chain) return res.json({ error: "No data for this expiry yet" });
  res.json(chain);
});

app.get("/api/option-chain/all", (req, res) => {
  const all     = getAllCached();
  const summary = {};
  for (const [name, data] of Object.entries(all)) {
    summary[name] = {
      spotPrice: data.spotPrice || 0,
      updatedAt: data.updatedAt || 0,
      expiries:  (data.expiries || []).slice(0, 4),
      chains:    Object.entries(data.chains || {}).reduce((acc, [exp, chain]) => {
        acc[exp] = { pcr: chain.pcr, maxPainStrike: chain.maxPainStrike, support: chain.support, resistance: chain.resistance, totalCEOI: chain.totalCEOI, totalPEOI: chain.totalPEOI };
        return acc;
      }, {}),
    };
  }
  res.json(summary);
});

app.post("/api/option-chain/subscribe", (req, res) => {
  const { name, instrumentKey } = req.body;
  if (!name || !instrumentKey) return res.status(400).json({ error: "name and instrumentKey required" });
  addUnderlying(name, instrumentKey);
  res.json({ ok: true, message: `Added ${name} to OI tracking` });
});

// ── /api/events ───────────────────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  try {
    const { getStored } = require("./coordinator");
    const stored = getStored();
    const mcapDb = getCachedMcap(200);
    res.json({
      bse:        getEvents("bse") || [],
      nse:        getEvents("nse") || [],
      orderBook:  stored.orderBook || [],
      sectors:    stored.sectors   || [],
      megaOrders: stored.megaOrders || [],
      mcapDb,
      windowHours: getRetentionHours(),
      windowLabel: getWindowLabel(),
    });
  } catch (e) {
    res.json({ bse: [], nse: [], orderBook: [], sectors: [], megaOrders: [], mcapDb: [], windowHours: 24, windowLabel: "24h" });
  }
});

// ── /api/mcap ─────────────────────────────────────────────────────────────────
app.get("/api/mcap", (req, res) => {
  try {
    res.json(getCachedMcap(300));
  } catch {
    res.json([]);
  }
});

// ── /api/orderbook ────────────────────────────────────────────────────────────
app.get("/api/orderbook", async (req, res) => {
  try {
    const orderBookDB = require("./data/orderBookDB");
    const mongoData   = await orderBookDB.getAllOrderBooks();
    if (mongoData && mongoData.length > 0) return res.json({ orderBook: mongoData, count: mongoData.length });
    const result   = [];
    const mcapPath = path.join(__dirname, "data/marketCapDB.json");
    const obPath   = path.join(__dirname, "data/orderBookHistory.json");
    let mcapDB = {}, obHistory = {};
    try { mcapDB    = JSON.parse(fs.readFileSync(mcapPath, "utf8").trim()); } catch { /* ok */ }
    try { obHistory = JSON.parse(fs.readFileSync(obPath,   "utf8").trim()); } catch { /* ok */ }
    for (const [code, obData] of Object.entries(obHistory)) {
      const quarters = obData.quarters || [];
      if (!quarters.length) continue;
      const sorted = [...quarters].sort((a, b) => (b.quarter || "").localeCompare(a.quarter || ""));
      const latest = sorted[0];
      if (!latest?.confirmedOrderBook) continue;
      result.push({ code, company: obData.company || mcapDB[code]?.name || code, mcap: mcapDB[code]?.mcap || 0, confirmed: latest.confirmedOrderBook, confirmedQuarter: latest.quarter, newOrders: obData.newOrders || 0, currentOrderBook: (obData.currentOrderBook || latest.confirmedOrderBook) + (obData.newOrders || 0), obToRevRatio: null, quarterHistory: quarters });
    }
    try {
      const { getCompaniesByMcap, getEstimatedOrderBook } = require("./data/marketCap");
      const companies = getCompaniesByMcap(0);
      for (const [code, data] of Object.entries(companies)) {
        if (result.find(r => r.code === code)) continue;
        const ob = getEstimatedOrderBook(code);
        if (!ob || !ob.confirmed) continue;
        result.push({ code, company: data.name || code, mcap: data.mcap || 0, confirmed: ob.confirmed, confirmedQuarter: ob.confirmedQuarter, newOrders: ob.newOrders || 0, currentOrderBook: ob.currentOrderBook, obToRevRatio: ob.obToRevRatio, quarterHistory: ob.quarterHistory || [] });
      }
    } catch { /* ok */ }
    result.sort((a, b) => (b.currentOrderBook || 0) - (a.currentOrderBook || 0));
    res.json({ orderBook: result, count: result.length });
  } catch (e) {
    console.log("⚠️ /api/orderbook error:", e.message);
    res.json({ orderBook: [], count: 0 });
  }
});

app.get("/api/orderbook/:code", (req, res) => {
  try {
    const { getEstimatedOrderBook, getCompanyData } = require("./data/marketCap");
    const code = req.params.code;
    const ob   = getEstimatedOrderBook(code);
    const data = getCompanyData(code);
    if (!ob) return res.json({ error: "No order book data for this company" });
    res.json({ code, company: data.name || code, mcap: data.mcap || 0, ...ob });
  } catch (e) { res.json({ error: e.message }); }
});

// ── /api/company/:code ────────────────────────────────────────────────────────
app.get("/api/company/:code", async (req, res) => {
  try {
    const code     = req.params.code;
    const nsySym   = req.query.nse || null;
    const mcapPath = path.join(__dirname, "data/marketCapDB.json");
    const obPath   = path.join(__dirname, "data/orderBookHistory.json");
    let localCompany = null, localOB = null;
    try { if (fs.existsSync(mcapPath)) { const db = JSON.parse(fs.readFileSync(mcapPath, "utf8").trim() || "{}"); if (db[code]) localCompany = db[code]; } } catch { /* ok */ }
    try { if (fs.existsSync(obPath))   { const ob = JSON.parse(fs.readFileSync(obPath,   "utf8").trim() || "{}"); if (ob[code]) localOB = ob[code]; } } catch { /* ok */ }
    let obSummary = null;
    try {
      const orderBookDB = require("./data/orderBookDB");
      const mongoOB     = await orderBookDB.getOrderBook(code);
      if (mongoOB) obSummary = { confirmed: mongoOB.confirmed || 0, confirmedQuarter: mongoOB.confirmedQuarter || null, currentOrderBook: mongoOB.currentOrderBook || 0, newOrders: mongoOB.newOrders || 0, quarterHistory: mongoOB.quarterHistory || [], obToRevRatio: mongoOB.obToRevRatio || null, lastOrderTitle: mongoOB.lastOrderTitle || null };
    } catch { /* ok */ }
    if (!obSummary && localOB) {
      const quarters = localOB.quarters || [];
      const latest   = [...quarters].sort((a, b) => (b.quarter || "").localeCompare(a.quarter || ""))[0] || null;
      obSummary = { confirmed: latest?.confirmedOrderBook || 0, confirmedQuarter: latest?.quarter || null, currentOrderBook: localOB.currentOrderBook || latest?.confirmedOrderBook || 0, newOrders: 0, quarterHistory: quarters, obToRevRatio: null };
    }
    const { getFullScreenerData } = require("./services/data/liveMcap");
    const screener = await getFullScreenerData(code, nsySym);
    const profile  = { ...(screener?.profile || {}), name: screener?.profile?.name || localCompany?.name || code, sector: screener?.profile?.sector || localCompany?.sector || localCompany?.industry || "", mcap: screener?.profile?.mcap || localCompany?.mcap || null, price: screener?.profile?.price || localCompany?.lastPrice || null };
    const bseEvts  = (getEvents("bse") || []).filter(e => String(e.code) === String(code));
    const nseEvts  = (getEvents("nse") || []).filter(e => String(e.code) === String(code));
    const filings  = [...bseEvts, ...nseEvts].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 15);
    res.json({ profile, financials: screener?.financials || {}, shareholding: screener?.shareholding || null, orderBook: obSummary, recentFilings: filings });
  } catch (e) {
    console.log("Company profile error:", e.message);
    res.json({ profile: null, financials: null, shareholding: null, orderBook: null, recentFilings: [] });
  }
});

// ── /api/search/:query ────────────────────────────────────────────────────────
app.get("/api/search/:query", async (req, res) => {
  try {
    const q = req.params.query.toLowerCase().trim();
    const cachedArr = getCachedMcap(0);
    if (cachedArr.length > 0) {
      const localResults = cachedArr
        .filter(d => (d.company || "").toLowerCase().includes(q) || (d.code || "").toLowerCase().includes(q))
        .slice(0, 10)
        .map(d => ({ code: d.code, name: d.company || d.code, sector: d.sector || "", nseSymbol: d.nseSymbol || null, mcap: d.mcap || null }));
      if (localResults.length > 0) return res.json({ results: localResults });
    }
    const mcapPath = path.join(__dirname, "data/marketCapDB.json");
    if (fs.existsSync(mcapPath)) {
      const raw = fs.readFileSync(mcapPath, "utf8").trim();
      if (raw) {
        const db = JSON.parse(raw);
        const localResults = Object.entries(db)
          .filter(([code, d]) => (d.name || "").toLowerCase().includes(q) || code.toLowerCase().includes(q) || (d.symbol || "").toLowerCase().includes(q))
          .slice(0, 10)
          .map(([code, d]) => ({ code, name: d.name || code, sector: d.sector || d.industry || "", nseSymbol: d.symbol || d.nseSymbol || null, mcap: d.mcap || null }));
        if (localResults.length > 0) return res.json({ results: localResults });
      }
    }
    res.json({ results: await searchBSE(q) });
  } catch { res.json({ results: [] }); }
});

async function searchBSE(q) {
  const BSE_HEADERS = { "Referer": "https://www.bseindia.com", "Origin": "https://www.bseindia.com", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json, text/plain, */*" };
  try {
    const r = await axios.get("https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&shname=" + encodeURIComponent(q) + "&industry=&segment=Equity&status=Active", { headers: BSE_HEADERS, timeout: 8000 });
    const rows = r.data?.Table || r.data?.Table1 || r.data?.data || (Array.isArray(r.data) ? r.data : []);
    if (rows.length > 0) return rows.slice(0, 10).map(s => ({ code: s.SCRIP_CD || s.scripCd || s.Scrip_Cd, name: s.Scrip_Name || s.LONG_NAME || s.CompanyName, sector: s.SECTOR || s.sector || null, nseSymbol: s.NSE_Symbol || s.NSESymbol || null })).filter(s => s.code && s.name);
  } catch { /* ok */ }
  try {
    const r = await axios.get("https://api.bseindia.com/BseIndiaAPI/api/getScripSearchData/w?strSearch=" + encodeURIComponent(q), { headers: { "Referer": "https://www.bseindia.com", "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, timeout: 6000 });
    const rows = r.data?.Table || r.data?.data || (Array.isArray(r.data) ? r.data : []);
    if (rows.length > 0) return rows.slice(0, 10).map(s => ({ code: s.SCRIP_CD || s.scripcode, name: s.Scrip_Name || s.scripname || s.LONG_NAME, sector: s.SECTOR || null, nseSymbol: s.NSE_Symbol || s.symbol || null })).filter(s => s.code && s.name);
  } catch { /* ok */ }
  return [];
}

// ── /api/scanner ──────────────────────────────────────────────────────────────
app.get("/api/scanner", (req, res) => {
  const d = getScannerData();
  if (IS_WEEKEND && (!d || !d.updatedAt)) {
    return res.json({ error: "No cached data available yet", weekend: true });
  }
  if (!d.updatedAt) return res.json({ error: "Scanner not yet ready" });
  res.json({
    gainers:  d.gainers  || [],
    losers:   d.losers   || [],
    byMcap:   d.byMcap   || {},
    bySector: d.bySector || [],
    market: { advancing: d.advancing || 0, declining: d.declining || 0, unchanged: d.unchanged || 0, total: d.totalCount || 0 },
    updatedAt: d.updatedAt,
  });
});

app.get("/api/scanner/technicals/:symbol", async (req, res) => {
  try {
    const symbol    = req.params.symbol.toUpperCase();
    const timeframe = req.query.timeframe || "1day";
    const validTFs  = ["5min", "15min", "1hour", "4hour", "1day", "1week", "1month"];
    const tf        = validTFs.includes(timeframe) ? timeframe : "1day";
    const result = await getTechnicalsForTimeframe(symbol, tf);
    if (!result) return res.json({
      error: `No data for ${symbol} [${tf}]`,
      debug: {
        tokenPresent:       !!(upstoxAccessToken),
        instrumentKeyFound: !!(getInstrumentKeyFull(symbol)),
      }
    });
    res.json(result);
  } catch (e) { res.json({ error: e.message }); }
});

// ── /api/admin/backfill ───────────────────────────────────────────────────────
app.get("/api/admin/backfill", async (req, res) => {
  const secret = process.env.ADMIN_SECRET || "backfill2026";
  if (req.query.token !== secret) return res.status(401).json({ error: "Unauthorized" });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  const log = (msg) => { console.log(msg); res.write(msg + "\n"); };
  log("=== BSE ORDER BOOK BACKFILL ===");
  log("Started: " + new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST");
  try {
    const { updateFromResult, getCompaniesByMcap } = require("./data/marketCap");
    const { extractOrderValueFromPDF }             = require("./services/data/pdfReader");
    const { setConfirmedOrderBook, updateQuarterSeries } = require("./intelligence/orderBookEngine");
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const fmt   = d => String(d.getDate()).padStart(2, "0") + "%2F" + String(d.getMonth() + 1).padStart(2, "0") + "%2F" + d.getFullYear();
    log("\n[1] Getting BSE cookie...");
    let bseCookie = "";
    try {
      const w = await axios.get("https://www.bseindia.com/corporates/ann.html", { headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }, timeout: 20000, maxRedirects: 5 });
      const ck = w.headers["set-cookie"];
      if (ck?.length) { bseCookie = ck.map(c => c.split(";")[0]).join("; "); log("Cookie obtained"); }
    } catch (e) { log("Warmup failed: " + e.message); }
    const apiH = { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://www.bseindia.com", "Origin": "https://www.bseindia.com", ...(bseCookie ? { Cookie: bseCookie } : {}) };
    const OB_KW = ["infra","epc","engineer","construct","railway","defense","solar","renewable","power","water","rites","rvnl","irfc","hal ","bel ","ntpc","l&t","larsen","kec ","kalpataru","thermax","bhel","suzlon","tata power","inox wind","jsw energy","nhpc","abb","siemens","mazagon","titagarh","jupiter wagon"];
    const isOB = n => OB_KW.some(k => (n || "").toLowerCase().includes(k.trim()));
    const quarters = [
      { name: "Q3FY26", from: new Date("2026-01-01"), to: new Date("2026-03-28") },
      { name: "Q2FY26", from: new Date("2025-10-01"), to: new Date("2025-11-30") },
      { name: "Q1FY26", from: new Date("2025-07-01"), to: new Date("2025-08-31") },
    ];
    const cos = Object.entries(getCompaniesByMcap(0)).filter(([, d]) => isOB(d.name)).slice(0, 120);
    log("\n[2] Companies: " + cos.length);
    let totalPDFs = 0, totalFound = 0;
    for (const q of quarters) {
      log("\n--- " + q.name + " ---");
      await sleep(1000);
      for (const [code, data] of cos) {
        const url = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?strCat=-1&strPrevDate=" + fmt(q.from) + "&strScrip=" + code + "&strSearch=P&strToDate=" + fmt(q.to) + "&strType=C&subcategory=-1";
        try {
          const r = await axios.get(url, { headers: apiH, timeout: 10000 });
          const d = r.data;
          if (typeof d === "string" && d.includes("<")) continue;
          const rows = d?.Table || d?.Table1 || d?.data || (Array.isArray(d) ? d : []);
          const rf   = rows.filter(f => { const h = (f.HEADLINE || "").toLowerCase(), c2 = (f.CATEGORYNAME || "").toLowerCase(); return (c2.includes("result") || h.includes("financial result") || h.includes("quarterly result") || /q[1-4]fy/i.test(h)) && f.ATTACHMENTNAME; });
          if (!rf.length) continue;
          const pdfUrl  = "https://www.bseindia.com/xml-data/corpfiling/AttachLive/" + rf[0].ATTACHMENTNAME;
          totalPDFs++;
          const obValue = await extractOrderValueFromPDF(pdfUrl);
          if (obValue && obValue > 50) {
            const company = data.name || code;
            updateFromResult(code, { confirmedOrderBook: obValue, confirmedQuarter: q.name, newOrdersSinceConfirm: 0 });
            try { setConfirmedOrderBook(code, company, q.name, obValue); updateQuarterSeries(code, company, q.name, obValue); } catch { /* ok */ }
            try { const ob = require("./data/orderBookDB"); await ob.updateFromResultFiling(code, company, obValue, q.name, null); } catch { /* ok */ }
            const disp = obValue >= 1000 ? "Rs." + (obValue / 1000).toFixed(1) + "K Cr" : "Rs." + Math.round(obValue) + " Cr";
            log("OK " + company.substring(0, 35).padEnd(35) + " " + q.name + "  " + disp);
            totalFound++;
          }
          await sleep(600);
        } catch { /* skip */ }
      }
      await sleep(2000);
    }
    log("\n=== DONE: scanned=" + totalPDFs + " found=" + totalFound + " ===");
    res.end();
  } catch (e) { log("FATAL: " + e.message); res.end(); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api") || req.path.startsWith("/auth")) return next();
  res.sendFile(path.join(clientPath, "index.html"));
});

module.exports = { getInstrumentMap };