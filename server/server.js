// Only load .env locally — Render injects env vars automatically
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path    = require("path");
const fs      = require("fs");
const axios   = require("axios");
const cors    = require("cors");

const startBSEListener      = require("./services/listeners/bseListener");
const startNSEDealsListener = require("./services/listeners/nseDealsListener");
const { startCoordinator }  = require("./coordinator");
const { startStreamer, stopStreamer } = require("./services/upstoxStream");
const { commoditiesRoute }  = require("./api/commodities");  // ← ADDED

const {
  getEvents,
  getRetentionHours,
  getWindowLabel
} = require("./database");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const clientPath = path.join(__dirname, "../client/dist");
app.use(express.static(clientPath));

// ── Upstox token store ───────────────────────────────────────────────────────
const UPSTOX_API_KEY      = process.env.UPSTOX_API_KEY;
const UPSTOX_API_SECRET   = process.env.UPSTOX_API_SECRET;
const UPSTOX_REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI;

const TOKEN_FILE = path.join(__dirname, "data/upstox_token.json");

let upstoxAccessToken = null;
let upstoxTokenExpiry = null;

function loadToken() {
  if (process.env.UPSTOX_ANALYTICS_TOKEN) {
    upstoxAccessToken = process.env.UPSTOX_ANALYTICS_TOKEN;
    upstoxTokenExpiry = Date.now() + 365 * 24 * 60 * 60 * 1000;
    console.log("✅ Upstox Analytics Token loaded from env");
    return;
  }
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (saved.token && saved.expiry && Date.now() < saved.expiry) {
        upstoxAccessToken = saved.token;
        upstoxTokenExpiry = saved.expiry;
        console.log("Upstox token loaded from disk, expires:", new Date(saved.expiry).toISOString());
      } else {
        console.log("Upstox saved token is expired — reconnect via /auth/upstox");
      }
    }
  } catch (e) {
    console.warn("Could not load Upstox token:", e.message);
  }
}

function saveToken(token, expiry) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expiry }), "utf8");
    console.log("Upstox token saved to disk");
  } catch (e) {
    console.warn("Could not save Upstox token:", e.message);
  }
}

function clearToken() {
  upstoxAccessToken = null;
  upstoxTokenExpiry = null;
  try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch (e) {}
}

loadToken();

if (upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0)) {
  setTimeout(() => startStreamer(upstoxAccessToken, io), 2000);
}

const UPSTOX_INSTRUMENTS = {
  "NIFTY 50":   "NSE_INDEX|Nifty 50",
  "SENSEX":     "BSE_INDEX|SENSEX",
  "BANK NIFTY": "NSE_INDEX|Nifty Bank"
};

const INDEX_NAMES = ["NIFTY 50", "SENSEX", "BANK NIFTY"];

// ── Step 1: Redirect to Upstox login ────────────────────────────────────────
app.get("/auth/upstox", (req, res) => {
  if (!UPSTOX_API_KEY || !UPSTOX_REDIRECT_URI) {
    return res.send("ERR: UPSTOX_API_KEY or UPSTOX_REDIRECT_URI not set.");
  }
  const authUrl =
    "https://api.upstox.com/v2/login/authorization/dialog" +
    "?response_type=code" +
    "&client_id=" + UPSTOX_API_KEY +
    "&redirect_uri=" + encodeURIComponent(UPSTOX_REDIRECT_URI);
  res.redirect(authUrl);
});

// ── Step 2: Handle OAuth callback ───────────────────────────────────────────
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
        grant_type:    "authorization_code"
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" } }
    );

    upstoxAccessToken = response.data.access_token;
    upstoxTokenExpiry = Date.now() + (response.data.expires_in || 86400) * 1000;
    saveToken(upstoxAccessToken, upstoxTokenExpiry);
    console.log("Upstox token saved, expires:", new Date(upstoxTokenExpiry).toISOString());

    startStreamer(upstoxAccessToken, io);

    res.send(
      "<html><body style='background:#010812;color:#00ff9c;font-family:monospace;padding:40px;text-align:center'>" +
      "<h2>Upstox Connected!</h2>" +
      "<p style='color:#b8cfe8'>Live NIFTY / SENSEX / BANK NIFTY WebSocket stream is now active.</p>" +
      "<p style='color:#4a8adf'>Token expires: " + new Date(upstoxTokenExpiry).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST</p><br>" +
      "<a href='/' style='color:#00cfff;text-decoration:none;border:1px solid #00cfff33;padding:8px 16px;border-radius:4px'>Back to Dashboard</a>" +
      "</body></html>"
    );
  } catch (e) {
    console.error("Upstox token exchange failed:", e.response?.data || e.message);
    res.send("ERR: Token exchange failed: " + (e.response?.data?.message || e.message));
  }
});

// ── Upstox status ────────────────────────────────────────────────────────────
app.get("/auth/upstox/status", (req, res) => {
  res.json({
    connected: !!(upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0)),
    expiry: upstoxTokenExpiry
      ? new Date(upstoxTokenExpiry).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      : null
  });
});

// ── /api/market ──────────────────────────────────────────────────────────────
async function fetchUpstoxMarket() {
  const keys = Object.values(UPSTOX_INSTRUMENTS).join(",");
  const res = await axios.get(
    "https://api.upstox.com/v2/market-quote/quotes?instrument_key=" + encodeURIComponent(keys),
    {
      headers: { "Authorization": "Bearer " + upstoxAccessToken, "Accept": "application/json" },
      timeout: 8000
    }
  );
  const data = res.data?.data || {};
  return INDEX_NAMES.map(name => {
    const key   = UPSTOX_INSTRUMENTS[name];
    const quote = data[key] || data[key.replace("|", ":")] || null;
    if (!quote) return { name, price: "—", change: "—", pct: "—", up: null };
    const price     = quote.last_price || 0;
    const prevClose = quote.ohlc?.close || price;
    const diff      = price - prevClose;
    const pct       = prevClose > 0 ? (diff / prevClose) * 100 : 0;
    const up        = diff >= 0;
    return {
      name,
      price:  price.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
      change: (up ? "+" : "") + diff.toFixed(2),
      pct:    (up ? "+" : "") + pct.toFixed(2) + "%",
      up
    };
  });
}

app.get("/api/market", async (req, res) => {
  const blank = INDEX_NAMES.map(name => ({ name, price: "—", change: "—", pct: "—", up: null }));
  const upstoxReady = upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0);

  if (!upstoxReady) {
    return res.json([...blank, { _source: "disconnected" }]);
  }

  try {
    const data = await fetchUpstoxMarket();
    return res.json([...data, { _source: "upstox" }]);
  } catch (e) {
    console.error("Upstox market fetch failed:", e.message);
    if (e.response?.status === 401) {
      clearToken();
      stopStreamer();
      return res.json([...blank, { _source: "disconnected" }]);
    }
    return res.json([...blank, { _source: "error" }]);
  }
});

// ── /api/commodities ─────────────────────────────────────────────────────────
app.get("/api/commodities", commoditiesRoute);  // ← ADDED

// ── /health ──────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    upstox: (upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0)) ? "connected" : "disconnected"
  });
});

// ── /api/events ──────────────────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  try {
    const { getStored } = require("./coordinator");
    const stored = getStored();

    let mcapDb = [];
    try {
      const mcapPath = path.join(__dirname, "data/marketCapDB.json");
      if (fs.existsSync(mcapPath)) {
        const raw = JSON.parse(fs.readFileSync(mcapPath, "utf8"));
        if (Array.isArray(raw)) {
          mcapDb = raw;
        } else {
          mcapDb = Object.entries(raw).map(([code, d]) => ({
            code, company: d.name || "", mcap: d.mcap || 0
          }));
        }
      }
    } catch (e) { console.warn("mcapDb load failed:", e.message); }

    res.json({
      bse:         getEvents("bse")  || [],
      nse:         getEvents("nse")  || [],
      orderBook:   stored.orderBook  || [],
      sectors:     stored.sectors    || [],
      megaOrders:  stored.megaOrders || [],
      mcapDb,
      windowHours: getRetentionHours(),
      windowLabel: getWindowLabel()
    });
  } catch (e) {
    res.json({ bse: [], nse: [], orderBook: [], sectors: [], megaOrders: [], mcapDb: [], windowHours: 24, windowLabel: "24h" });
  }
});

// ── /api/mcap ────────────────────────────────────────────────────────────────
app.get("/api/mcap", (req, res) => {
  try {
    const mcapPath = path.join(__dirname, "data/marketCapDB.json");
    if (!fs.existsSync(mcapPath)) return res.json([]);
    const data = JSON.parse(fs.readFileSync(mcapPath, "utf8"));
    const arr = Array.isArray(data) ? data :
      Object.entries(data).map(([code, d]) => ({ code, company: d.name || "", mcap: d.mcap || 0 }));
    res.json(arr);
  } catch (e) {
    console.log("MCap load failed:", e.message);
    res.json([]);
  }
});

// ── /api/orderbook ───────────────────────────────────────────────────────────
app.get("/api/orderbook", async (req, res) => {
  try {
    const orderBookDB = require("./data/orderBookDB");
    const mongoData = await orderBookDB.getAllOrderBooks();

    if (mongoData && mongoData.length > 0) {
      return res.json({ orderBook: mongoData, count: mongoData.length });
    }

    const result = [];
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
      result.push({
        code,
        company:          obData.company || mcapDB[code]?.name || code,
        mcap:             mcapDB[code]?.mcap || 0,
        confirmed:        latest.confirmedOrderBook,
        confirmedQuarter: latest.quarter,
        newOrders:        obData.newOrders || 0,
        currentOrderBook: (obData.currentOrderBook || latest.confirmedOrderBook) + (obData.newOrders || 0),
        obToRevRatio:     null,
        quarterHistory:   quarters,
      });
    }

    try {
      const { getCompaniesByMcap, getEstimatedOrderBook } = require("./data/marketCap");
      const companies = getCompaniesByMcap(0);
      for (const [code, data] of Object.entries(companies)) {
        if (result.find(r => r.code === code)) continue;
        const ob = getEstimatedOrderBook(code);
        if (!ob || !ob.confirmed) continue;
        result.push({
          code,
          company:          data.name || code,
          mcap:             data.mcap || 0,
          confirmed:        ob.confirmed,
          confirmedQuarter: ob.confirmedQuarter,
          newOrders:        ob.newOrders || 0,
          currentOrderBook: ob.currentOrderBook,
          obToRevRatio:     ob.obToRevRatio,
          quarterHistory:   ob.quarterHistory || [],
        });
      }
    } catch { /* ok */ }

    result.sort((a, b) => (b.currentOrderBook || 0) - (a.currentOrderBook || 0));
    res.json({ orderBook: result, count: result.length });

  } catch (e) {
    console.log("⚠️ /api/orderbook error:", e.message);
    res.json({ orderBook: [], count: 0 });
  }
});

// ── /api/orderbook/:code ─────────────────────────────────────────────────────
app.get("/api/orderbook/:code", (req, res) => {
  try {
    const { getEstimatedOrderBook, getCompanyData } = require("./data/marketCap");
    const code = req.params.code;
    const ob   = getEstimatedOrderBook(code);
    const data = getCompanyData(code);
    if (!ob) return res.json({ error: "No order book data for this company" });
    res.json({ code, company: data.name || code, mcap: data.mcap || 0, ...ob });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── /api/company/:code ───────────────────────────────────────────────────────
app.get("/api/company/:code", async (req, res) => {
  try {
    const code   = req.params.code;
    const nseSym = req.query.nse || null;

    const mcapPath = path.join(__dirname, "data/marketCapDB.json");
    const obPath   = path.join(__dirname, "data/orderBookHistory.json");

    let localCompany = null, localOB = null;
    try {
      if (fs.existsSync(mcapPath)) {
        const db = JSON.parse(fs.readFileSync(mcapPath, "utf8").trim() || "{}");
        if (db[code]) localCompany = db[code];
      }
    } catch { /* ok */ }
    try {
      if (fs.existsSync(obPath)) {
        const ob = JSON.parse(fs.readFileSync(obPath, "utf8").trim() || "{}");
        if (ob[code]) localOB = ob[code];
      }
    } catch { /* ok */ }

    let obSummary = null;
    try {
      const orderBookDB = require("./data/orderBookDB");
      const mongoOB = await orderBookDB.getOrderBook(code);
      if (mongoOB) {
        obSummary = {
          confirmed:        mongoOB.confirmed || 0,
          confirmedQuarter: mongoOB.confirmedQuarter || null,
          currentOrderBook: mongoOB.currentOrderBook || 0,
          newOrders:        mongoOB.newOrders || 0,
          quarterHistory:   mongoOB.quarterHistory || [],
          obToRevRatio:     mongoOB.obToRevRatio || null,
          lastOrderTitle:   mongoOB.lastOrderTitle || null,
        };
      }
    } catch { /* ok */ }

    if (!obSummary && localOB) {
      const quarters = localOB.quarters || [];
      const latest   = [...quarters].sort((a, b) => (b.quarter || "").localeCompare(a.quarter || ""))[0] || null;
      obSummary = {
        confirmed:        latest?.confirmedOrderBook || 0,
        confirmedQuarter: latest?.quarter || null,
        currentOrderBook: localOB.currentOrderBook || latest?.confirmedOrderBook || 0,
        newOrders:        0,
        quarterHistory:   quarters,
        obToRevRatio:     null,
      };
    }

    const { getFullScreenerData } = require("./services/data/liveMcap");
    const screener = await getFullScreenerData(code, nseSym);

    const profile = {
      ...(screener?.profile || {}),
      name:   screener?.profile?.name   || localCompany?.name   || code,
      sector: screener?.profile?.sector || localCompany?.sector || localCompany?.industry || "",
      mcap:   screener?.profile?.mcap   || localCompany?.mcap   || null,
      price:  screener?.profile?.price  || localCompany?.lastPrice || null,
    };

    const bseEvts = (getEvents("bse") || []).filter(e => String(e.code) === String(code));
    const nseEvts = (getEvents("nse") || []).filter(e => String(e.code) === String(code));
    const filings = [...bseEvts, ...nseEvts]
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, 15);

    res.json({ profile, financials: screener?.financials || {}, shareholding: screener?.shareholding || null, orderBook: obSummary, recentFilings: filings });
  } catch (e) {
    console.log("Company profile error:", e.message);
    res.json({ profile: null, financials: null, shareholding: null, orderBook: null, recentFilings: [] });
  }
});

// ── /api/search/:query ───────────────────────────────────────────────────────
app.get("/api/search/:query", async (req, res) => {
  try {
    const q = req.params.query.toLowerCase().trim();
    const mcapPath = path.join(__dirname, "data/marketCapDB.json");
    let localResults = [];
    if (fs.existsSync(mcapPath)) {
      const raw = fs.readFileSync(mcapPath, "utf8").trim();
      if (raw) {
        const db = JSON.parse(raw);
        localResults = Object.entries(db)
          .filter(([code, d]) =>
            (d.name || "").toLowerCase().includes(q) ||
            code.includes(q) ||
            (d.symbol || "").toLowerCase().includes(q)
          )
          .slice(0, 10)
          .map(([code, d]) => ({
            code,
            name:      d.name     || code,
            sector:    d.sector   || d.industry || "",
            nseSymbol: d.symbol   || d.nseSymbol || null,
            mcap:      d.mcap     || null,
          }));
      }
    }
    if (localResults.length > 0) return res.json({ results: localResults });
    const results = await searchBSE(q);
    res.json({ results });
  } catch (e) {
    res.json({ results: [] });
  }
});

async function searchBSE(q) {
  const BSE_HEADERS = {
    "Referer": "https://www.bseindia.com", "Origin": "https://www.bseindia.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*"
  };
  try {
    const r = await axios.get(
      "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&shname=" + encodeURIComponent(q) + "&industry=&segment=Equity&status=Active",
      { headers: BSE_HEADERS, timeout: 8000 }
    );
    const rows = r.data?.Table || r.data?.Table1 || r.data?.data || (Array.isArray(r.data) ? r.data : []);
    if (rows.length > 0) return rows.slice(0, 10).map(s => ({
      code: s.SCRIP_CD || s.scripCd || s.Scrip_Cd,
      name: s.Scrip_Name || s.LONG_NAME || s.CompanyName,
      sector: s.SECTOR || s.sector || null,
      nseSymbol: s.NSE_Symbol || s.NSESymbol || null,
    })).filter(s => s.code && s.name);
  } catch { /* ok */ }
  try {
    const r = await axios.get(
      "https://api.bseindia.com/BseIndiaAPI/api/getScripSearchData/w?strSearch=" + encodeURIComponent(q),
      { headers: { "Referer": "https://www.bseindia.com", "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, timeout: 6000 }
    );
    const rows = r.data?.Table || r.data?.data || (Array.isArray(r.data) ? r.data : []);
    if (rows.length > 0) return rows.slice(0, 10).map(s => ({
      code: s.SCRIP_CD || s.scripcode,
      name: s.Scrip_Name || s.scripname || s.LONG_NAME,
      sector: s.SECTOR || null,
      nseSymbol: s.NSE_Symbol || s.symbol || null,
    })).filter(s => s.code && s.name);
  } catch { /* ok */ }
  return [];
}

// ── /api/admin/backfill ──────────────────────────────────────────────────────
app.get("/api/admin/backfill", async (req, res) => {
  const secret = process.env.ADMIN_SECRET || "backfill2026";
  if (req.query.token !== secret) {
    return res.status(401).json({ error: "Unauthorized — pass ?token=YOUR_ADMIN_SECRET" });
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");

  const log = (msg) => { console.log(msg); res.write(msg + "\n"); };

  log("=== BSE ORDER BOOK BACKFILL ===");
  log("Started: " + new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST");

  try {
    const { updateFromResult, getCompaniesByMcap } = require("./data/marketCap");
    const { extractOrderValueFromPDF } = require("./services/data/pdfReader");
    const { setConfirmedOrderBook, updateQuarterSeries } = require("./intelligence/orderBookEngine");

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const fmt   = d => String(d.getDate()).padStart(2,"0") + "%2F" +
                       String(d.getMonth()+1).padStart(2,"0") + "%2F" + d.getFullYear();

    log("\n[1] Getting BSE cookie...");
    let bseCookie = "";
    try {
      const w = await axios.get("https://www.bseindia.com/corporates/ann.html", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", "Connection": "keep-alive" },
        timeout: 20000, maxRedirects: 5
      });
      const ck = w.headers["set-cookie"];
      if (ck?.length) {
        bseCookie = ck.map(c => c.split(";")[0]).join("; ");
        log("Cookie: " + bseCookie.substring(0, 60) + "...");
      } else { log("No Set-Cookie header — continuing without"); }
    } catch(e) { log("Warmup failed: " + e.message); }

    const apiH = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", "Accept": "application/json, text/plain, */*", "Referer": "https://www.bseindia.com/corporates/ann.html", "Origin": "https://www.bseindia.com", "X-Requested-With": "XMLHttpRequest", ...(bseCookie ? { "Cookie": bseCookie } : {}) };

    const OB_KW = ["infra","epc","engineer","construct","railway","defense","defence","solar","renewable","power","water","wabag","rites","rvnl","irfc","hal ","bel ","ntpc","l&t","larsen","kec ","kalpataru","thermax","bhel","suzlon","tata power","inox wind","jsw energy","nhpc","abb india","siemens","garden reach","cochin ship","mazagon","data pattern","mtar","ncc ","hg infra","pnc infra","dilip","j kumar","titagarh","jupiter wagon","cg power","va tech"];
    const isOB = n => OB_KW.some(k => (n||"").toLowerCase().includes(k.trim()));

    const quarters = [
      { name: "Q3FY26", from: new Date("2026-01-01"), to: new Date("2026-03-28") },
      { name: "Q2FY26", from: new Date("2025-10-01"), to: new Date("2025-11-30") },
      { name: "Q1FY26", from: new Date("2025-07-01"), to: new Date("2025-08-31") },
    ];

    const cos = Object.entries(getCompaniesByMcap(0)).filter(([,d]) => isOB(d.name)).slice(0,120);
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
          const rows = d && d.Table || d && d.Table1 || d && d.data || (Array.isArray(d) ? d : []);
          const rf = rows.filter(f => { const h = (f.HEADLINE||"").toLowerCase(), c2 = (f.CATEGORYNAME||"").toLowerCase(); return (c2.includes("result")||h.includes("financial result")||h.includes("quarterly result")||h.includes("unaudited")||/q[1-4]fy/i.test(h)) && f.ATTACHMENTNAME; });
          if (!rf.length) continue;
          const pdfUrl = "https://www.bseindia.com/xml-data/corpfiling/AttachLive/" + rf[0].ATTACHMENTNAME;
          totalPDFs++;
          const obValue = await extractOrderValueFromPDF(pdfUrl);
          if (obValue && obValue > 50) {
            const company = data.name || code;
            updateFromResult(code, { confirmedOrderBook: obValue, confirmedQuarter: q.name, newOrdersSinceConfirm: 0 });
            try { setConfirmedOrderBook(code, company, q.name, obValue); updateQuarterSeries(code, company, q.name, obValue); } catch { /* ok */ }
            try { const ob = require("./data/orderBookDB"); await ob.updateFromResultFiling(code, company, obValue, q.name, null); } catch { /* ok */ }
            const disp = obValue >= 1000 ? "Rs." + (obValue/1000).toFixed(1) + "K Cr" : "Rs." + Math.round(obValue) + " Cr";
            log("OK " + company.substring(0,35).padEnd(35) + " " + q.name + "  " + disp);
            totalFound++;
          }
          await sleep(600);
        } catch { /* skip */ }
      }
      await sleep(2000);
    }

    log("\n=== DONE: scanned=" + totalPDFs + " found=" + totalFound + " ===");
    if (totalFound === 0) { log("BSE may be rate-limiting. Try again in 30 mins."); }
    res.end();
  } catch(e) {
    log("FATAL: " + e.message);
    res.end();
  }
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api") || req.path.startsWith("/auth")) return next();
  res.sendFile(path.join(clientPath, "index.html"));
});

startBSEListener(io);
startNSEDealsListener(io);
startCoordinator(io, () => upstoxAccessToken);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("Retention: " + getRetentionHours() + "h (" + getWindowLabel() + ")");
  if (UPSTOX_API_KEY) {
    console.log("Upstox configured — visit /auth/upstox to connect");
  } else {
    console.log("WARNING: UPSTOX_API_KEY not set");
  }
});