const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const path     = require("path");
const axios    = require("axios");

const startBSEListener      = require("./services/listeners/bseListener");
const startNSEDealsListener = require("./services/listeners/nseDealsListener");
const { startCoordinator }  = require("./coordinator");
const { getRadar }          = require("./services/intelligence/radarEngine");
const { getEvents, getRetentionHours, getWindowLabel } = require("./database");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

const clientPath = path.join(__dirname, "../client/dist");
app.use(express.static(clientPath));

/* ── REST: historical events ── */
app.get("/api/events", (req, res) => {
  try {
    res.json({
      bse:         getEvents("bse") || [],
      nse:         getEvents("nse") || [],
      windowHours: getRetentionHours(),
      windowLabel: getWindowLabel()
    });
  } catch(e) {
    res.json({ bse: [], nse: [], windowHours: 24, windowLabel: "24h" });
  }
});

/* ── REST: company profile ── */
app.get("/api/company/:code", async (req, res) => {
  try {
    const code   = req.params.code;
    const nseSym = req.query.nse || null;
    const { getFullScreenerData } = require("./services/data/liveMcap");
    const screener = await getFullScreenerData(code, nseSym);
    const bseEvts  = (getEvents("bse") || []).filter(e => String(e.code) === String(code));
    const nseEvts  = (getEvents("nse") || []).filter(e => String(e.code) === String(code));
    const filings  = [...bseEvts, ...nseEvts]
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, 15);
    res.json({ ...screener, recentFilings: filings });
  } catch(e) {
    console.log("❌ Company profile error:", e.message);
    res.json({ profile: null, financials: null, shareholding: null, recentFilings: [] });
  }
});

/* ── REST: company search ── */
app.get("/api/search/:query", async (req, res) => {
  try {
    const q = req.params.query;
    console.log(`🔍 Search: ${q}`);
    const r = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&shname=${encodeURIComponent(q)}&industry=&segment=Equity&status=Active`,
      {
        headers: {
          "Referer":    "https://www.bseindia.com",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept":     "application/json, text/plain, */*",
          "Origin":     "https://www.bseindia.com"
        },
        timeout: 8000
      }
    );

    const keys = Object.keys(r.data || {});
    console.log(`🔍 Response keys: ${JSON.stringify(keys)}`);
    console.log(`🔍 Sample: ${JSON.stringify(r.data).substring(0, 300)}`);

    const rows =
      r.data?.Table  ||
      r.data?.Table1 ||
      r.data?.data   ||
      r.data?.Data   ||
      (Array.isArray(r.data) ? r.data : []);

    console.log(`🔍 Rows: ${rows.length}`);

    const results = rows.slice(0, 10).map(s => ({
      code:      s.SCRIP_CD    || s.scripCd    || s.scrip_cd,
      name:      s.Scrip_Name  || s.LONG_NAME  || s.scrip_name || s.CompanyName,
      sector:    s.SECTOR      || s.sector     || s.Industry,
      nseSymbol: s.NSE_Symbol  || s.NSESymbol  || s.nse_symbol || null,
    })).filter(s => s.code && s.name);

    res.json({ results });
  } catch(e) {
    console.log(`❌ Search failed: ${e.message}`);
    res.json({ results: [], error: e.message });
  }
});

/* ── CATCH-ALL — must be LAST ── */
app.get("*", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

/* ── SERVICES ── */
startBSEListener(io);
startNSEDealsListener(io);
startCoordinator(io);

/* ── START ── */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log(`📅 Retention: ${getRetentionHours()}h (${getWindowLabel()})`);
});