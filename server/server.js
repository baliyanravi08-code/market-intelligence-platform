const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");

const startBSEListener = require("./services/bseListener");
const startNSEDealsListener = require("./services/nseDealsListener");
const startCoordinator = require("./coordinator");
const { loadCompanyMaster } = require("./services/data/companyMaster");
const { getTopRadar } = require("./services/intelligence/radarEngine");

const app = express();
const server = http.createServer(app);

const io = new Server(server,{
  cors:{origin:"*"}
});

app.use(cors());
app.use(express.json());

app.get("/health",(req,res)=>{
  res.json({
    status:"Market Intelligence Platform Running",
    time:new Date()
  });
});

app.get("/radar",(req,res)=>{
  res.json(getTopRadar());
});

io.on("connection",(socket)=>{
  console.log("Client connected:",socket.id);
});

async function startSystem(){

  console.log("🚀 Starting Market Intelligence Engines...");

  await loadCompanyMaster();

  startCoordinator(io);

  startBSEListener(io);

  startNSEDealsListener(io);

}

startSystem();

const clientPath = path.join(process.cwd(),"client","dist");

app.use(express.static(clientPath));

app.get("/",(req,res)=>{
  res.sendFile(path.join(clientPath,"index.html"));
});

app.use((req,res)=>{
  res.sendFile(path.join(clientPath,"index.html"));
});

const PORT = process.env.PORT || 10000;

server.listen(PORT,()=>{
  console.log(`🚀 Server running on port ${PORT}`);
});