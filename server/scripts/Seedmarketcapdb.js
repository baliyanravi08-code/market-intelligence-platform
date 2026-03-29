/**
 * seedMarketCapDB.js
 * 
 * Run this ONCE to bootstrap marketCapDB.json with all BSE codes + names.
 * After this runs successfully, bseDataSystem.js will work correctly.
 * 
 * Sources (tried in order):
 *   1. BSE ListofScripData API  → BSE codes + names directly
 *   2. NSE EQUITY_L.csv         → names + ISIN (used to enrich BSE entries)
 *   3. BSE getScripHeaderData   → live mcap per company (batched)
 * 
 * Run: node server/scripts/seedMarketCapDB.js
 */

"use strict";

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

let csvParse;
async function downloadLatestBhavCopy() {
  console.log("📥 Downloading BSE BhavCopy...");

  const datesToTry = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");

    datesToTry.push(`${yyyy}${mm}${dd}`);
  }

  for (const date of datesToTry) {
    const url = `https://www.bseindia.com/download/BhavCopy/Equity/EQ_ISINCODE_${date}.csv`;

    try {
      const res = await axios.get(url, {
        responseType: "text",
        timeout: 15000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Referer": "https://www.bseindia.com/"
        }
      });

      if (res.data && res.data.length > 1000) {
        console.log(`✅ BhavCopy loaded: ${date}`);
        return res.data;
      }

    } catch (e) {
      console.log(`   ❌ ${date} failed`);
    }
  }

  throw new Error("No BhavCopy found");
}
try { csvParse = require("csv-parse/sync").parse; }
catch { csvParse = null; }

const MCAP_FILE = path.join(__dirname, "../data/marketCapDB.json");
const DATA_DIR  = path.join(__dirname, "../data");

const sleep = ms => new Promise(r => setTimeout(r, ms));

const BSE_HEADERS = {
  "User-Agent":  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Referer":     "https://www.bseindia.com",
  "Accept":      "application/json, text/plain, */*",
  "Origin":      "https://www.bseindia.com",
  "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8",
};

const NSE_HEADERS = {
  "User-Agent":  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Referer":     "https://www.nseindia.com",
  "Accept":      "text/html,application/xhtml+xml,*/*",
  "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8",
};

function loadDB() {
  try {
    if (fs.existsSync(MCAP_FILE)) {
      const raw = fs.readFileSync(MCAP_FILE, "utf8").trim();
      if (raw) return JSON.parse(raw);
    }
  } catch { /* ok */ }
  return {};
}

function saveDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MCAP_FILE, JSON.stringify(db, null, 2), "utf8");
}

// ── Step 1: Get all BSE codes from BSE API ────────────────────────────────────
async function fetchBSEScripList() {
  try {
    const raw = await downloadLatestBhavCopy();

    const records = csvParse ? csvParse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    }) : [];

    const result = [];

    for (const row of records) {
      const code = String(row.SC_CODE || "").trim();
      const name = (row.SC_NAME || "").trim();
      const isin = (row.ISIN_CODE || "").trim();

      if (!code || !name) continue;

      result.push({
        SCRIP_CD: code,
        SCRIP_NAME: name,
        ISIN_NUMBER: isin,
        SECTOR_NAME: "",
        INDUSTRY: ""
      });
    }

    console.log(`📊 BhavCopy companies: ${result.length}`);
    return result;

  } catch (e) {
    console.log("❌ BhavCopy failed:", e.message);
    return [];
  }
}
// ── Step 2: Parse BSE API rows → { code, name, isin, sector } ─────────────────
function parseBSERows(rows) {
  const result = {};
  for (const row of rows) {
    const code = String(
      row.SCRIP_CD || row.scripCd || row.Scrip_Code || row.SC_CODE || ""
    ).trim();
    const name = (
      row.SCRIP_NAME || row.scripName || row.Scrip_Name || row.SC_NAME ||
      row.LONG_NAME  || row.CompanyName || ""
    ).trim();
    const isin = (
      row.ISIN_NUMBER || row.isin || row.ISIN || row.Isin || ""
    ).trim();
    const sector = (
      row.SECTOR_NAME || row.sector || row.Sector || row.SECTOR || ""
    ).trim();
    const industry = (
      row.INDUSTRY || row.industry || row.Industry || ""
    ).trim();

    if (!code || !name || !/^\d{4,6}$/.test(code)) continue;
    result[code] = { name, isin, sector, industry, status: "Active", updatedAt: Date.now() };
  }
  return result;
}

// ── Step 3: Download NSE CSV and build ISIN→name + ISIN→nseSymbol maps ────────
async function fetchNSEData() {
  console.log("📡 Fetching NSE equity list...");
  try {
    const res = await axios.get(
      "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
      { headers: NSE_HEADERS, responseType: "text", timeout: 30000 }
    );
    if (!res.data || res.data.length < 1000) {
      console.log("   NSE CSV too small — skipping");
      return { byIsin: {}, byName: {} };
    }
    console.log(`   ✅ NSE CSV: ${Math.round(res.data.length / 1024)}KB`);

    if (!csvParse) {
      console.log("   ⚠️  csv-parse not installed — skipping NSE enrichment");
      console.log("   Run: npm i csv-parse");
      return { byIsin: {}, byName: {} };
    }

    const records = csvParse(res.data, {
      columns: true, skip_empty_lines: true, trim: true, relax_column_count: true,
    });

    const byIsin = {}, byName = {};
    for (const row of records) {
      const name   = (row["NAME OF COMPANY"] || row.NAME || "").trim();
      const isin   = (row["ISIN NUMBER"] || row.ISIN || "").trim();
      const symbol = (row.SYMBOL || "").trim();
      if (!name || !isin) continue;
      byIsin[isin] = { name, nseSymbol: symbol };
      // Also index by normalised name for fuzzy match
      byName[name.toLowerCase().replace(/\s+/g, " ")] = { isin, nseSymbol: symbol };
    }
    console.log(`   ✅ NSE: ${Object.keys(byIsin).length} ISIN entries`);
    return { byIsin, byName };
  } catch (e) {
    console.log(`   NSE CSV failed: ${e.message}`);
    return { byIsin: {}, byName: {} };
  }
}

// ── Step 4: Enrich BSE entries with NSE data ──────────────────────────────────
function enrichWithNSE(bseDB, nse) {
  let enriched = 0;
  for (const [code, entry] of Object.entries(bseDB)) {
    // Match by ISIN first (most reliable)
    if (entry.isin && nse.byIsin[entry.isin]) {
      const n = nse.byIsin[entry.isin];
      if (n.nseSymbol) { entry.nseSymbol = n.nseSymbol; enriched++; }
      // Use NSE name only if BSE name is very short/garbled
      if (entry.name.length < 4 && n.name.length > 4) entry.name = n.name;
    }
  }
  console.log(`   ✅ Enriched ${enriched} entries with NSE symbols`);
  return bseDB;
}

// ── Step 5: Fetch mcap for a batch of codes ───────────────────────────────────
async function fetchMcapBatch(codes) {
  const results = {};
  const PARALLEL = 8;
  const DELAY    = 400;

  for (let i = 0; i < codes.length; i += PARALLEL) {
    const batch = codes.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(batch.map(async code => {
      try {
        const res = await axios.get(
          `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Scrip_Cd=${code}`,
          { headers: BSE_HEADERS, timeout: 6000 }
        );
        const d = res.data;
        const raw = d?.MarketCapCr || d?.Mktcap || d?.mktcap || d?.MktCap || d?.MKTCAP || null;
        if (!raw) return { code, mcap: null };
        const val = parseFloat(String(raw).replace(/,/g, ""));
        // BSE sometimes returns in lakhs — detect by magnitude
        const mcap = val > 50000 ? parseFloat((val / 100).toFixed(2)) : val;
        return { code, mcap: mcap > 0 ? mcap : null };
      } catch {
        return { code, mcap: null };
      }
    }));

    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.mcap) {
        results[s.value.code] = s.value.mcap;
      }
    }

    if (i % 200 === 0 && i > 0) {
      const pct = Math.round(i / codes.length * 100);
      process.stdout.write(`   mcap: ${pct}% (${i}/${codes.length})\r`);
    }
    await sleep(DELAY);
  }
  return results;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const args      = process.argv.slice(2);
  const skipMcap  = args.includes("--skip-mcap");
  const mcapOnly  = args.includes("--mcap-only");

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   marketCapDB Seeder — builds fresh DB from BSE + NSE   ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // mcap-only mode — just refresh prices for existing DB
  if (mcapOnly) {
    const db    = loadDB();
    const codes = Object.keys(db);
    console.log(`📈 mcap-only: refreshing ${codes.length} companies...`);
    const mcapMap = await fetchMcapBatch(codes);
    let updated = 0;
    for (const [code, mcap] of Object.entries(mcapMap)) {
      if (db[code]) { db[code].mcap = mcap; db[code].lastMcapAt = Date.now(); updated++; }
    }
    saveDB(db);
    console.log(`\n✅ mcap updated for ${updated}/${codes.length} companies`);
    return;
  }

  // ── Phase 1: Get BSE codes ─────────────────────────────────────────────────
  const bseRows = await fetchBSEScripList();
  let db = {};

  if (bseRows.length > 0) {
    db = parseBSERows(bseRows);
    console.log(`📊 BSE codes parsed: ${Object.keys(db).length}`);
  } else {
    // BSE API blocked — load existing DB and just update it
    db = loadDB();
    console.log(`⚠️  BSE API blocked — using existing DB (${Object.keys(db).length} entries)`);
    if (Object.keys(db).length === 0) {
      console.log("❌ No existing DB and BSE API blocked. Cannot seed.");
      console.log("   Try again later or manually download BSE scrips list.");
      process.exit(1);
    }
  }

  await sleep(2000);

  // ── Phase 2: Enrich with NSE data ─────────────────────────────────────────
  const nse = await fetchNSEData();

for (const [code, entry] of Object.entries(db)) {
  if (entry.isin && nse.byIsin[entry.isin]) {
    const n = nse.byIsin[entry.isin];

    entry.nseSymbol = n.nseSymbol;

    // optional improvement
    if (entry.name.length < 4) {
      entry.name = n.name;
    }
  }
}

console.log(`📊 NSE enriched: ${Object.keys(db).length} companies`);
console.log(`📊 Built DB from NSE: ${Object.keys(db).length} companies`);
  // Save after phase 2 — even without mcap, names+codes are valuable
  saveDB(db);
  console.log(`\n💾 Saved ${Object.keys(db).length} companies to marketCapDB.json`);

  // ── Phase 3: Fetch live mcap ───────────────────────────────────────────────
  if (!skipMcap) {
    console.log(`\n📈 Fetching live mcap for ${Object.keys(db).length} companies...`);
    console.log("   (takes ~5-8 min for 5000+ companies)\n");

    const codes   = Object.keys(db);
    const mcapMap = await fetchMcapBatch(codes);
    let   updated = 0;

    for (const [code, mcap] of Object.entries(mcapMap)) {
      if (db[code]) {
        db[code].mcap       = mcap;
        db[code].lastMcapAt = Date.now();
        updated++;
      }
    }

    saveDB(db);
    console.log(`\n✅ mcap fetched for ${updated}/${codes.length} companies`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const total     = Object.keys(db).length;
  const withMcap  = Object.values(db).filter(d => d.mcap > 0).length;
  const withISIN  = Object.values(db).filter(d => d.isin).length;
  const withNSE   = Object.values(db).filter(d => d.nseSymbol).length;

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Total companies:  ${total}`);
  console.log(`  With mcap:        ${withMcap}`);
  console.log(`  With ISIN:        ${withISIN}`);
  console.log(`  With NSE symbol:  ${withNSE}`);
  console.log(`\n✅ marketCapDB.json ready.`);
  console.log(`   Next step: node server/scripts/backfillResults_v3.js\n`);
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});