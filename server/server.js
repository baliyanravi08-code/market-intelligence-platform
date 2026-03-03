const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

/*
INTELLIGENCE ENGINES
*/
const analyzeResult =
require("./services/intelligence/resultEngine");

const analyzeQoQ =
require("./services/intelligence/qoqEngine");

const updateSectorStrength =
require("./services/intelligence/sectorEngine");

const app = express();
const server = http.createServer(app);

const io = new Server(server,{
 cors:{origin:"*"}
});

/*
HEALTH
*/
app.get("/health",(req,res)=>{
 res.send("OK");
});

/*
SERVE FRONTEND
*/
const distPath =
 path.join(__dirname,"../client/dist");

app.use(express.static(distPath));

app.use((req,res)=>{
 res.sendFile(
  path.join(distPath,"index.html")
 );
});

/*
MARKET DATA
*/

function generateMarketData(){

 const sectors=[
  "Bank",
  "Pharma",
  "Defense",
  "Railway",
  "Auto"
 ];

 const companies=[
  "SBIN",
  "HDFCBANK",
  "HAL",
  "BEL",
  "SUNPHARMA",
  "TITAN",
  "TCS"
 ];

 const sector =
  sectors[Math.floor(
   Math.random()*sectors.length
  )];

 const baseProfit =
  Math.floor(Math.random()*1000);

 const rawData={

  company:
   companies[Math.floor(
    Math.random()*companies.length
   )],

  sector,

  currentProfit:baseProfit,

  lastQuarterProfit:
   baseProfit +
   Math.floor(Math.random()*400-200),

  lastYearProfit:
   baseProfit +
   Math.floor(Math.random()*600-300),

  profitChange:
   Math.floor(Math.random()*40)-20,

  revenueChange:
   Math.floor(Math.random()*30),

  otherExpense:
   Math.floor(Math.random()*40),

  provisions:
   Math.floor(Math.random()*30),

  newOrders:
   Math.floor(Math.random()*100)
 };

 const resultIntel =
  analyzeResult(rawData);

 const qoqIntel =
  analyzeQoQ(rawData);

 const finalData={
  ...rawData,
  ...resultIntel,
  ...qoqIntel
 };

 const sectorData =
  updateSectorStrength(finalData);

 return{
  ...finalData,
  sectorStrength:sectorData,
  time:new Date()
   .toLocaleTimeString()
 };
}

/*
REALTIME ENGINE
*/

setInterval(()=>{

 try{

  const data =
   generateMarketData();

  console.log(
   "📡 SECTOR UPDATE",
   data.sector
  );

  io.emit("announcement",data);

 }catch(err){
  console.log("Engine Safe Error");
 }

},10000);

/*
SOCKET
*/

io.on("connection",()=>{
 console.log("👤 Dashboard Connected");
});

/*
START SERVER
*/

const PORT =
 process.env.PORT || 4000;

server.listen(PORT,"0.0.0.0",()=>{
 console.log(
  `✅ SERVER LISTENING ON PORT ${PORT}`
 );
});