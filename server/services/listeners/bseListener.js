const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const startBSEListener = require("./services/listeners/bseListener");
const startNSEDealsListener = require("./services/listeners/nseDealsListener");

const { getRadar } = require("./services/intelligence/radarEngine");

const app = express();

const server = http.createServer(app);

const io = new Server(server,{
  cors:{origin:"*"}
});

/* SOCKET */

io.on("connection",(socket)=>{

  console.log("Client connected:",socket.id);

});

/* API */

app.get("/api/radar",(req,res)=>{

  res.json(getRadar());

});

/* FRONTEND */

app.use(express.static(path.join(__dirname,"../client/dist")));

app.get("*",(req,res)=>{

  res.sendFile(path.join(__dirname,"../client/dist/index.html"));

});

/* START LISTENERS */

startBSEListener(io);
startNSEDealsListener(io);

/* SERVER */

const PORT = process.env.PORT || 10000;

server.listen(PORT,()=>{

  console.log("🚀 Server running on port",PORT);

});