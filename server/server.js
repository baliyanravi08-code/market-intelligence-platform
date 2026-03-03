const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

/*
==============================
INTELLIGENCE ENGINE
==============================
*/
const analyzeResult =
require("./services/intelligence/resultEngine");

const app = express();
const server = http.createServer(app);

const io = new Server(server,{
 cors:{origin:"*"}
});

/*
==============================
HEALTH CHECK
==============================
*/
app.get("/health",(req,res)=>{
 res.send("OK");
});

/*
==============================
SERVE FRONTEND
==============================
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
==============================
MARKET DATA GENERATOR
==============================
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

 const rawData={

  company:
   companies[Math.floor(
    Math.random()*companies.length
   )],

  sector,

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

 const intelligence =
  analyzeResult(rawData);

 return{
  ...rawData,
  ...intelligence,
  time:new Date().toLocaleTimeString()
 };
}

/*
==============================
REALTIME ENGINE
==============================
*/

setInterval(()=>{

 try{

  const data =
   generateMarketData();

  console.log(
   "📡 INTELLIGENCE EVENT",
   data.company,
   data.verdict
  );

  io.emit("announcement",data);

 }catch(err){
  console.log("Engine Safe Error");
 }

},10000);

/*
==============================
SOCKET CONNECTION
==============================
*/

io.on("connection",()=>{
 console.log("👤 Dashboard Connected");
});

/*
==============================
START SERVER
==============================
*/

const PORT =
 process.env.PORT || 4000;

server.listen(PORT,"0.0.0.0",()=>{
 console.log(
  `✅ SERVER LISTENING ON PORT ${PORT}`
 );
});