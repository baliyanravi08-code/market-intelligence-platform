const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const startBSEListener = require("./services/listeners/bseListener");
const startNSEDealsListener = require("./services/listeners/nseDealsListener");
const { startCoordinator } = require("./coordinator");
const { getRadar } = require("./services/intelligence/radarEngine");
const { getEvents } = require("./database");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

/* FRONTEND BUILD */
const clientPath = path.join(__dirname, "../client/dist");
app.use(express.static(clientPath));
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

/* START SERVICES */
startBSEListener(io);
startNSEDealsListener(io);
startCoordinator(io);

/* SERVER */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});