const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path    = require("path");

const startBSEListener      = require("./services/listeners/bseListener");
const startNSEDealsListener = require("./services/listeners/nseDealsListener");
const { startCoordinator }  = require("./coordinator");
const { getRadar }          = require("./services/intelligence/radarEngine");
const { getEvents, getRetentionHours, getWindowLabel } = require("./database");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

/* ── FRONTEND BUILD ── */
const clientPath = path.join(__dirname, "../client/dist");
app.use(express.static(clientPath));
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

/* ── REST ENDPOINT — historical events on page load ── */
// Client fetches this on connect to get stored events immediately
app.get("/api/events", (req, res) => {
  try {
    const bse  = getEvents("bse")  || [];
    const nse  = getEvents("nse")  || [];
    res.json({
      bse,
      nse,
      windowHours: getRetentionHours(),
      windowLabel: getWindowLabel()
    });
  } catch (e) {
    res.json({ bse: [], nse: [], windowHours: 24, windowLabel: "24h" });
  }
});

/* ── START SERVICES ── */
startBSEListener(io);
startNSEDealsListener(io);
startCoordinator(io);

/* ── SERVER ── */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log(`📅 Retention window: ${getRetentionHours()}h (${getWindowLabel()})`);
});