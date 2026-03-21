const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
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

/* ───────────────────────────── */
/* MIDDLEWARE */
/* ───────────────────────────── */

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ───────────────────────────── */
/* STATIC CLIENT */
/* ───────────────────────────── */

const clientPath = path.join(__dirname, "../client/dist");
app.use(express.static(clientPath));

/* ───────────────────────────── */
/* HEALTH CHECK */
/* ───────────────────────────── */

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* ───────────────────────────── */
/* REST: historical events */
/* ───────────────────────────── */

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

/* ───────────────────────────── */
/* REST: company profile */
/* ───────────────────────────── */

app.get("/api/company/:code", async (req, res) => {
  try {
    const code = req.params.code;
    const nseSym = req.query.nse || null;

    const { getFullScreenerData } = require("./services/data/liveMcap");

    const screener = await getFullScreenerData(code, nseSym);

    const bseEvts = (getEvents("bse") || []).filter(
      e => String(e.code) === String(code)
    );

    const nseEvts = (getEvents("nse") || []).filter(
      e => String(e.code) === String(code)
    );

    const filings = [...bseEvts, ...nseEvts]
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, 15);

    res.json({
      ...screener,
      recentFilings: filings
    });

  } catch (e) {

    console.log("❌ Company profile error:", e.message);

    res.json({
      profile: null,
      financials: null,
      shareholding: null,
      recentFilings: []
    });
  }
});

/* ───────────────────────────── */
/* REST: company search */
/* ───────────────────────────── */

app.get("/api/search/:query", async (req, res) => {
  try {
    const q = req.params.query;
    console.log("🔍 Search:", q);

    // Try multiple BSE search APIs
    const results = await searchBSE(q);
    res.json({ results });

  } catch (e) {
    console.log("❌ Search failed:", e.message);
    res.json({ results: [] });
  }
});

async function searchBSE(q) {
  // API 1: ListofScripData — most reliable
  try {
    const r = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&shname=${encodeURIComponent(q)}&industry=&segment=Equity&status=Active`,
      {
        headers: {
          "Referer": "https://www.bseindia.com",
          "Origin":  "https://www.bseindia.com",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json, text/plain, */*"
        },
        timeout: 8000
      }
    );

    const rows = r.data?.Table || r.data?.Table1 || r.data?.data || (Array.isArray(r.data) ? r.data : []);
    console.log(`🔍 BSE rows: ${rows.length}, keys: ${JSON.stringify(Object.keys(r.data || {}))}`);

    if (rows.length > 0) {
      return rows.slice(0, 10).map(s => ({
        code:      s.SCRIP_CD   || s.scripCd   || s.scrip_cd   || s.Scrip_Cd,
        name:      s.Scrip_Name || s.LONG_NAME  || s.scrip_name || s.CompanyName || s.longname,
        sector:    s.SECTOR     || s.sector     || s.Industry   || s.industry,
        nseSymbol: s.NSE_Symbol || s.NSESymbol  || s.nse_symbol || s.symbol || null,
      })).filter(s => s.code && s.name);
    }
  } catch(e) {
    console.log("⚠️ ListofScripData failed:", e.message);
  }

  // API 2: BSE search autocomplete fallback
  try {
    const r = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/getScripSearchData/w?strSearch=${encodeURIComponent(q)}`,
      {
        headers: {
          "Referer": "https://www.bseindia.com",
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        },
        timeout: 6000
      }
    );

    const rows = r.data?.Table || r.data?.data || (Array.isArray(r.data) ? r.data : []);
    console.log(`🔍 Autocomplete rows: ${rows.length}`);

    if (rows.length > 0) {
      return rows.slice(0, 10).map(s => ({
        code:      s.SCRIP_CD || s.scripcode || s.Scrip_Cd,
        name:      s.Scrip_Name || s.scripname || s.LONG_NAME,
        sector:    s.SECTOR || s.industry || null,
        nseSymbol: s.NSE_Symbol || s.symbol || null,
      })).filter(s => s.code && s.name);
    }
  } catch(e) {
    console.log("⚠️ Autocomplete failed:", e.message);
  }

  return [];
}

/* ───────────────────────────── */
/* SPA FALLBACK */
/* ───────────────────────────── */

app.use((req, res, next) => {

  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api")) return next();

  res.sendFile(path.join(clientPath, "index.html"));

});

/* ───────────────────────────── */
/* START SERVICES */
/* ───────────────────────────── */

startBSEListener(io);
startNSEDealsListener(io);
startCoordinator(io);

/* ───────────────────────────── */
/* START SERVER */
/* ───────────────────────────── */

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {

  console.log("🚀 Server running on port", PORT);
  console.log(`📅 Retention: ${getRetentionHours()}h (${getWindowLabel()})`);

});