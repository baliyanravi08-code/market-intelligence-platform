const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");

const startBSEListener = require("./services/bseListener");
const startCoordinator = require("./coordinator");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use(cors());
app.use(express.json());

/* ------------------------------
   Health Route
------------------------------ */

app.get("/health", (req, res) => {
  res.json({
    status: "Market Intelligence Platform Running",
    time: new Date(),
  });
});

/* ------------------------------
   WebSocket
------------------------------ */

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.emit("connected", {
    message: "Connected to Market Intelligence Platform",
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

/* ------------------------------
   Start Engines
------------------------------ */

console.log("🚀 Starting Market Intelligence Engines...");

try {
  startCoordinator(io);
  console.log("✅ Coordinator started");
} catch (err) {
  console.error("❌ Coordinator failed:", err.message);
}

try {
  startBSEListener();
  console.log("✅ BSE Listener started");
} catch (err) {
  console.error("❌ BSE Listener failed:", err.message);
}

/* ------------------------------
   Serve React
------------------------------ */

const clientPath = path.join(__dirname, "../../client/dist");

app.use(express.static(clientPath));

/* Express 5 SAFE fallback */

app.use((req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

/* ------------------------------
   Start Server
------------------------------ */

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});