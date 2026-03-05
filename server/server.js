const express = require("express");
const http = require("http");
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

app.get("/", (req, res) => {
  res.send("Market Intelligence Platform Running 🚀");
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
});

startBSEListener(io);
startNSEDealsListener(io);

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});