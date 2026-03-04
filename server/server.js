const express=require("express");
const http=require("http");
const path=require("path");
const {Server}=require("socket.io");

/*
INTELLIGENCE
*/
const analyzeResult=
require("./services/intelligence/resultEngine");

const analyzeQoQ=
require("./services/intelligence/qoqEngine");

const updateSectorStrength=
require("./services/intelligence/sectorEngine");

const updateMarketDirection=
require("./services/intelligence/marketDirection");

const analyzeResultPDF=
require("./services/intelligence/pdfEngine");

/*
DATA
*/
const getSimulatorData=
require("./services/data/simulator");

const getResultPDF=
require("./services/data/resultSource");

const app=express();
const server=http.createServer(app);

const io=new Server(server,{
 cors:{origin:"*"}
});

/*
HEALTH
*/
app.get("/health",(req,res)=>{
 res.send("OK");
});

/*
FRONTEND
*/
const distPath=
 path.join(__dirname,"../client/dist");

app.use(express.static(distPath));

app.use((req,res)=>{
 res.sendFile(
  path.join(distPath,"index.html")
 );
});

/*
ENGINE
*/

async function buildEvent(){

 const data=getSimulatorData();

 const baseProfit=
  Math.floor(Math.random()*1000);

 data.currentProfit=baseProfit;
 data.lastQuarterProfit=
  baseProfit+
  Math.floor(Math.random()*200-100);

 data.lastYearProfit=
  baseProfit+
  Math.floor(Math.random()*400-200);

 const resultIntel=
  analyzeResult(data);

 const qoqIntel=
  analyzeQoQ(data);

 const pdfUrl=
  getResultPDF();

 const pdfIntel=
  await analyzeResultPDF(pdfUrl);

 const merged={
  ...data,
  ...resultIntel,
  ...qoqIntel,
  ...pdfIntel
 };

 const sectorStrength=
  updateSectorStrength(merged);

 const market=
  updateMarketDirection(
   sectorStrength
  );

 return{
  ...merged,
  sectorStrength,
  ...market,
  time:new Date()
   .toLocaleTimeString()
 };
}

/*
LOOP
*/

setInterval(async()=>{

 try{

  const event=
   await buildEvent();

  console.log(
   "📄 RESULT ANALYZED",
   event.company
  );

  io.emit("announcement",event);

 }catch(e){
  console.log("Safe Engine Error");
 }

},15000);

/*
SOCKET
*/
io.on("connection",()=>{
 console.log("👤 Dashboard Connected");
});

/*
START
*/
const PORT=
 process.env.PORT||4000;

server.listen(PORT,"0.0.0.0",()=>{
 console.log(
  `✅ SERVER LISTENING ON PORT ${PORT}`
 );
});