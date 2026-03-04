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

const detectOrder=
require("./services/intelligence/orderDetector");

/*
DATA
*/
const getBSEAnnouncement=
require("./services/data/bseAnnouncements");

const getSimulatorData=
require("./services/data/simulator");

const getResultPDF=
require("./services/data/resultSource");

const getMarketCap=
require("./services/data/marketCap");

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
BUILD EVENT
*/
async function buildEvent(){

 let data =
  await getBSEAnnouncement();

 if(!data){

  data =
   getSimulatorData();
 }

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

/*
ORDER DETECTION
*/

 const orders =
  detectOrder(data.announcement);

 let marketCap=null;

 if(data.company){

  const cap =
   await getMarketCap(data.company);

  if(cap)
   marketCap=cap.marketCap;

 }

 const merged={
  ...data,
  ...resultIntel,
  ...qoqIntel,
  ...pdfIntel,
  orders,
  marketCap
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

  if(event.orders){

   console.log(
    "ORDER DETECTED:",
    event.orders
   );

  }

  io.emit("announcement",event);

 }catch(err){

  console.log("Safe Engine Error");

 }

},20000);

/*
SOCKET
*/
io.on("connection",()=>{
 console.log("Dashboard Connected");
});

/*
START
*/
const PORT=
 process.env.PORT||4000;

server.listen(PORT,"0.0.0.0",()=>{
 console.log(`Server running ${PORT}`);
});