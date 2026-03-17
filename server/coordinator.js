const { loadDB, saveDB } = require("./database");

let ioRef = null;
let megaOrders = [];
function startCoordinator(io) {
  ioRef = io;

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  try {
    const db = loadDB();
    if (db.bse?.length)           socket.emit("bse_events",        db.bse.slice(0, 500));
    if (db.nse?.length)           socket.emit("nse_events",        db.nse.slice(0, 500));
    if (db.radar?.length)         socket.emit("radar_update",      db.radar.slice(0, 500));
    if (db.sectors?.length)       socket.emit("sector_alerts",     db.sectors);
    if (db.orderBook?.length)     socket.emit("order_book_update", db.orderBook[0]);
    if (db.opportunities?.length) socket.emit("opportunity_alert", db.opportunities[0]);

    // ✅ ADD THIS BLOCK HERE
    if (megaOrders.length) {
      socket.emit("mega_orders", megaOrders);
    }

  } catch (e) {
    console.log("⚠️ History load error:", e.message);
  }
});

  setInterval(() => {
    try {
      const db = loadDB();
      if (db.radar?.length && ioRef) ioRef.emit("radar_update", db.radar.slice(0, 500));
    } catch (e) {}
  }, 30000);

  console.log("🚀 Coordinator Running");
}

function persistRadar(radar) {
  try {
    const db = loadDB();
    db.radar = radar.slice(0, 500);
    saveDB(db);
  } catch (e) {}
}

function persistOrderBook(order) {
  try {
    const db = loadDB();
    db.orderBook = [order, ...(db.orderBook || []).filter(o => o.company !== order.company)].slice(0, 20);
    saveDB(db);
  } catch (e) {}
}

function persistSector(sector) {
  try {
    const db = loadDB();
    const filtered = (db.sectors || []).filter(s => s.sector !== sector.sector);
    db.sectors = [sector, ...filtered].slice(0, 15);
    saveDB(db);
  } catch (e) {}
}

function persistOpportunity(opp) {
  try {
    const db = loadDB();
    db.opportunities = [opp, ...(db.opportunities || [])].slice(0, 20);
    saveDB(db);
  } catch (e) {}
}

// ✅ NOW OUTSIDE
function persistMegaOrder(signal) {
  try {
    if (!signal?._orderInfo?.crores) return;

    if (signal._orderInfo.crores < 100) return;

    const order = {
      company: signal.company,
      value: signal._orderInfo.crores,
      title: signal.title,
      time: Date.now()
    };

    megaOrders.unshift(order);
    megaOrders = megaOrders.slice(0, 50);

    if (ioRef) {
      ioRef.emit("mega_orders", megaOrders);
    }

  } catch (e) {
    console.log("⚠️ Mega order error:", e.message);
  }
}
module.exports = {
  startCoordinator,
  persistRadar,
  persistOrderBook,
  persistSector,
  persistOpportunity,
  persistMegaOrder
};