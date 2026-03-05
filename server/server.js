const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const startBSEListener = require("./services/listeners/bseListener");
const startNSEDealsListener = require("./services/listeners/nseDealsListener");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(express.json());

/*
SERVE REACT BUILD
*/

const clientPath = path.join(__dirname, "../client/dist");

app.use(express.static(clientPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

/*
SOCKET CONNECTION
*/

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
});

/*
START LISTENERS
*/

startBSEListener(io);
startNSEDealsListener(io);

/*
START SERVER
*/

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});