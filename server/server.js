const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

/*
=================================
APP INIT
=================================
*/

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

/*
=================================
HEALTH ROUTE (RENDER NEEDS THIS)
=================================
*/

app.get("/health", (req, res) => {
  res.send("OK");
});

/*
=================================
SERVE FRONTEND BUILD
=================================
*/

const distPath = path.join(__dirname, "../client/dist");

app.use(express.static(distPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

/*
=================================
SOCKET CONNECTION
=================================
*/

io.on("connection", () => {
  console.log("👤 Dashboard Connected");
});

/*
=================================
RENDER PORT SAFE START
=================================
IMPORTANT:
Render provides PORT dynamically
Must bind 0.0.0.0
=================================
*/

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SERVER RUNNING ON PORT ${PORT}`);
});