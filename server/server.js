const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

/*
==============================
SERVICES
==============================
*/

const {
 fetchAnnouncements,
 getNewAnnouncement
} = require("./services/bseListener");

const {
 classifyAnnouncement
} = require("./services/announcementClassifier");

const {
 readPDF,
 analyzeResult
} = require("./services/resultAnalyzer");

const {
 analyzeOrder
} = require("./services/orderAnalyzer");

const {
 extractCompany
} = require("./services/companyExtractor");

const {
 updateOrderBook,
 getOrderBook
} = require("./data/orderStore");

const {
 calculateStrength
} = require("./services/strengthEngine");

const {
 getSector,
 updateSectorStrength,
 getSectorStrength
} = require("./services/sectorEngine");

const {
 updateMarketDirection,
 getMarketStatus
} = require("./services/marketEngine");

/*
==============================
APP INIT
==============================
*/

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
 cors: { origin: "*" }
});

/*
==============================
SERVE FRONTEND BUILD
(RENDER SAFE)
==============================
*/

const distPath =
 path.join(__dirname, "../client/dist");

app.use(express.static(distPath));

app.use((req, res) => {
 res.sendFile(
  path.join(distPath, "index.html")
 );
});

/*
==============================
DATA STORE
==============================
*/

const announcements = [];

/*
==============================
LIVE BSE LISTENER
==============================
*/

async function startListener() {

 console.log("✅ LIVE BSE ENGINE STARTED");

 setInterval(async () => {

  try {

   const list =
    await fetchAnnouncements();

   const event =
    getNewAnnouncement(list);

   if (!event) return;

   const type =
    classifyAnnouncement(event.title);

   let analysis = null;
   let company = null;

/*
==============================
RESULT ANALYSIS
==============================
*/

   if (type === "RESULT") {

    company =
     extractCompany(event.title);

    const text =
     await readPDF(event.link);

    analysis =
     analyzeResult(text);
   }

/*
==============================
ORDER ANALYSIS
==============================
*/

   if (type === "ORDER") {

    const text =
     await readPDF(event.link);

    const order =
     analyzeOrder(text);

    if (order) {

     company =
      extractCompany(event.title);

     const book =
      updateOrderBook(
       company,
       parseFloat(order.orderValue)
      );

     analysis = {
      ...order,
      company,
      totalOrders: book.orders,
      totalOrderValue:
       book.totalOrderValue + " Cr"
     };
    }
   }

   if (!analysis) return;

/*
==============================
STRENGTH ENGINE
==============================
*/

   const strength =
    calculateStrength(type, analysis);

   const sector =
    getSector(company);

   const sectorData =
    updateSectorStrength(
     sector,
     strength
    );

   const marketStatus =
    updateMarketDirection(
     sectorData
    );

   const data = {
    title: event.title,
    company,
    sector,
    strengthScore: strength,
    marketStatus,
    analysis,
    time: new Date().toLocaleTimeString()
   };

   announcements.unshift(data);

   console.log("🚨 LIVE EVENT:", company);

   io.emit("announcement", data);

  } catch (err) {

   console.log(
    "Listener Error:",
    err.message
   );
  }

 }, 30000);
}

/*
==============================
APIs
==============================
*/

app.get("/history", (req, res) =>
 res.json(announcements)
);

app.get("/orders", (req, res) =>
 res.json(getOrderBook())
);

app.get("/sectors", (req, res) =>
 res.json(getSectorStrength())
);

app.get("/market", (req, res) =>
 res.json({
  status: getMarketStatus()
 })
);

/*
==============================
SOCKET CONNECTION
==============================
*/

io.on("connection", () => {
 console.log("👤 Dashboard Connected");
});

/*
==============================
START SERVER
==============================
*/

const PORT =
 process.env.PORT || 4000;

server.listen(PORT, () => {

 console.log(
  "🚀 MARKET INTELLIGENCE LIVE"
 );

 startListener();
});