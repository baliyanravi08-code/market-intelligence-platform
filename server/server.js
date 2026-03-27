// Only load .env locally — Render injects env vars automatically
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const cors = require("cors");

const startBSEListener = require("./services/listeners/bseListener");
const startNSEDealsListener = require("./services/listeners/nseDealsListener");
const { startCoordinator } = require("./coordinator");

const {
  getEvents,
  getRetentionHours,
  getWindowLabel
} = require("./database");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const clientPath = path.join(__dirname, "../client/dist");
app.use(express.static(clientPath));

// ── Upstox token store (in-memory) ──────────────────────────────────────────
let upstoxAccessToken = null;
let upstoxTokenExpiry = null;

const UPSTOX_API_KEY      = process.env.UPSTOX_API_KEY;
const UPSTOX_API_SECRET   = process.env.UPSTOX_API_SECRET;
const UPSTOX_REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI;

const UPSTOX_INSTRUMENTS = {
  "NIFTY 50":   "NSE_INDEX|Nifty 50",
  "SENSEX":     "BSE_INDEX|SENSEX",
  "BANK NIFTY": "NSE_INDEX|Nifty Bank"
};

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
    console.log("Upstox token saved, expires:", new Date(upstoxTokenExpiry).toISOString());

    res.send(
      "<html><body style='background:#010812;color:#00ff9c;font-family:monospace;padding:40px;text-align:center'>" +
      "<h2>Upstox Connected!</h2>" +
      "<p style='color:#b8cfe8'>Live NIFTY / SENSEX / BANK NIFTY data is now active.</p>" +
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

// ── Fetch from Upstox ────────────────────────────────────────────────────────
async function fetchUpstoxMarket() {
  const keys = Object.values(UPSTOX_INSTRUMENTS).join(",");
  const res = await axios.get(
    "https://api.upstox.com/v2/market-quote/quotes?instrument_key=" + encodeURIComponent(keys),
    {
      headers: { "Authorization": "Bearer " + upstoxAccessToken, "Accept": "application/json" },
      timeout: 8000
    }
  );
  const data  = res.data?.data || {};
  const names = Object.keys(UPSTOX_INSTRUMENTS);
  return names.map(name => {
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

// ── Fetch from Yahoo Finance ─────────────────────────────────────────────────
async function fetchYahooMarket() {
  const symbols = ["^NSEI", "^BSESN", "^NSEBANK"];
  const names   = ["NIFTY 50", "SENSEX", "BANK NIFTY"];
  const results = await Promise.all(symbols.map(sym =>
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/" + sym + "?interval=1d&range=1d", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "application/json" },
      timeout: 8000
    }).then(r => r.data)
  ));
  return results.map((d, i) => {
    const meta = d?.chart?.result?.[0]?.meta;
    if (!meta) return { name: names[i], price: "—", change: "—", pct: "—", up: null };
    const price = meta.regularMarketPrice;
    const prev  = meta.previousClose || meta.chartPreviousClose;
    const diff  = price - prev;
    const pct   = (diff / prev) * 100;
    const up    = diff >= 0;
    return {
      name:   names[i],
      price:  price.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
      change: (up ? "+" : "") + diff.toFixed(2),
      pct:    (up ? "+" : "") + pct.toFixed(2) + "%",
      up
    };
  });
}

// ── /api/market — Upstox first, Yahoo fallback ───────────────────────────────
app.get("/api/market", async (req, res) => {
  const names = ["NIFTY 50", "SENSEX", "BANK NIFTY"];
  const upstoxReady = upstoxAccessToken && Date.now() < (upstoxTokenExpiry || 0);

  if (upstoxReady) {
    try {
      const data = await fetchUpstoxMarket();
      console.log("Market: Upstox live");
      return res.json(data);
    } catch(e) {
      console.warn("Upstox failed, falling back:", e.message);
      if (e.response?.status === 401) {
        upstoxAccessToken = null;
        upstoxTokenExpiry = null;
        console.log("Upstox token expired — visit /auth/upstox to reconnect");
      }
    }
  }

  try {
    const data = await fetchYahooMarket();
    console.log("Market: Yahoo Finance fallback");
    return res.json(data);
  } catch(e) {
    console.error("All market feeds failed:", e.message);
    return res.json(names.map(name => ({ name, price: "—", change: "—", pct: "—", up: null })));
  }
});

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
    res.json({
      bse:         getEvents("bse") || [],
      nse:         getEvents("nse") || [],
      orderBook:   stored.orderBook || [],
      sectors:     stored.sectors   || [],
      megaOrders:  stored.megaOrders || [],
      windowHours: getRetentionHours(),
      windowLabel: getWindowLabel()
    });
  } catch (e) {
    res.json({ bse: [], nse: [], orderBook: [], sectors: [], megaOrders: [], windowHours: 24, windowLabel: "24h" });
  }
});

// ── /api/mcap ────────────────────────────────────────────────────────────────
app.get("/api/mcap", (req, res) => {
  try {
    const mcapPath = path.join(__dirname, "data/marketCapDB.json");
    if (!fs.existsSync(mcapPath)) return res.json([]);
    const data = JSON.parse(fs.readFileSync(mcapPath, "utf8"));
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    console.log("MCap load failed:", e.message);
    res.json([]);
  }
});

// ── /api/company/:code ───────────────────────────────────────────────────────
app.get("/api/company/:code", async (req, res) => {
  try {
    const code   = req.params.code;
    const nseSym = req.query.nse || null;
    const { getFullScreenerData } = require("./services/data/liveMcap");
    const screener = await getFullScreenerData(code, nseSym);
    const bseEvts = (getEvents("bse") || []).filter(e => String(e.code) === String(code));
    const nseEvts = (getEvents("nse") || []).filter(e => String(e.code) === String(code));
    const filings = [...bseEvts, ...nseEvts]
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, 15);
    res.json({ ...screener, recentFilings: filings });
  } catch (e) {
    console.log("Company profile error:", e.message);
    res.json({ profile: null, financials: null, shareholding: null, recentFilings: [] });
  }
});

// ── /api/search/:query ───────────────────────────────────────────────────────
app.get("/api/search/:query", async (req, res) => {
  try {
    const q = req.params.query;
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
  } catch(e) {}
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
  } catch(e) {}
  return [];
}

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api") || req.path.startsWith("/auth")) return next();
  res.sendFile(path.join(clientPath, "index.html"));
});

startBSEListener(io);
startNSEDealsListener(io);
startCoordinator(io);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("Retention: " + getRetentionHours() + "h (" + getWindowLabel() + ")");
  if (UPSTOX_API_KEY) {
    console.log("Upstox configured — visit /auth/upstox to connect");
  } else {
    console.log("Upstox not configured — using Yahoo Finance fallback");
  }
});