const fs   = require("fs");
const path = require("path");

const DB_FILE   = path.join(__dirname, "data.json");
const MAX_EVENTS = 500;

// ── Smart retention window based on Indian market calendar ──
// Weekday: 24 hours
// Friday after 3:30 PM → Monday 9:15 AM: keep 96 hours (full weekend)
// Saturday/Sunday: keep 96 hours so Monday morning shows everything

function getRetentionHours() {
  // Use IST timezone
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  const day  = ist.getDay();  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const hour = ist.getHours();
  const min  = ist.getMinutes();

  // Saturday — always keep 96h (Friday orders still fresh)
  if (day === 6) return 96;

  // Sunday — always keep 96h
  if (day === 0) return 96;

  // Monday before 9:15 AM — keep 96h so weekend orders visible
  if (day === 1 && (hour < 9 || (hour === 9 && min < 15))) return 96;

  // Friday after 3:30 PM — market closed, extend to 96h
  if (day === 5 && (hour > 15 || (hour === 15 && min >= 30))) return 96;

  // Normal weekday market hours — 24h
  return 24;
}

function getWindowLabel() {
  const h = getRetentionHours();
  if (h > 24) return `${h}h (weekend)`;
  return "24h";
}

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
  const hours  = getRetentionHours();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
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
  const db        = loadDB();
  const exchangeTs = parseExchangeTs(event.time);
  const entry      = { ...event, savedAt: exchangeTs || Date.now() };
  db[type]         = pruneOld([entry, ...(db[type] || [])]).slice(0, MAX_EVENTS);
  saveDB(db);
}

function getEvents(type) {
  const db = loadDB();
  return pruneOld(db[type] || []);
}

function saveResult(signal) {
  saveEvent("bse", signal);
}

module.exports = {
  saveResult,
  saveEvent,
  getEvents,
  loadDB,
  saveDB,
  getRetentionHours,
  getWindowLabel
};