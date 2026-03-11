const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "data.json");
const MAX_EVENTS = 500;
const MAX_AGE_HOURS = 48;

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.log("⚠️ DB load error:", e.message);
  }
  return { bse: [], nse: [], radar: [], orderBook: [], sectors: [], opportunities: [] };
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db), "utf8");
  } catch (e) {
    console.log("⚠️ DB save error:", e.message);
  }
}

function pruneOld(arr) {
  const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
  return arr.filter(e => (e.savedAt || 0) > cutoff);
}

function parseExchangeTs(timeStr) {
  if (!timeStr) return null;
  try {
    const d = new Date(timeStr);
    if (!isNaN(d)) return d.getTime();
  } catch {}
  return null;
}

function saveEvent(type, event) {
  const db = loadDB();
  // preserve exchange time as savedAt — fall back to server time only if unparseable
  const exchangeTs = parseExchangeTs(event.time);
  const entry = { ...event, savedAt: exchangeTs || Date.now() };
  db[type] = pruneOld([entry, ...(db[type] || [])]).slice(0, MAX_EVENTS);
  saveDB(db);
}

function getEvents(type) {
  const db = loadDB();
  return pruneOld(db[type] || []);
}

function saveResult(signal) {
  saveEvent("bse", signal);
}

module.exports = { saveResult, saveEvent, getEvents, loadDB, saveDB };