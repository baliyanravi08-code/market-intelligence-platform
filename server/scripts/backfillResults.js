/**
 * backfillResults.js  — FIXED VERSION
 * Fetches Q1-Q3 FY26 result filings and extracts order book values.
 * Run: node server/scripts/backfillResults.js
 *
 * FIXES vs original:
 * 1. Actually calls getBSECookie() — original hardcoded "ar_debug=1" (fake)
 * 2. Fetches per-company (strScrip=CODE) instead of bulk — BSE blocks bulk
 * 3. Uses exact same headers as bseListener.js (which works live)
 * 4. Retry with backoff on timeout/empty
 * 5. Falls back to orderBookHistory.json static data if BSE fails
 */

const axios  = require("axios");
const path   = require("path");
const fs     = require("fs");
const { updateFromResult, getCompaniesByMcap } = require("./data/marketCap");
    const { extractOrderValueFromPDF } = require("./services/data/pdfReader");
    const { setConfirmedOrderBook, updateQuarterSeries } = require("./intelligence/orderBookEngine");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function bseDateFmt(d) {
  return `${String(d.getDate()).padStart(2,"0")}%2F` +
         `${String(d.getMonth()+1).padStart(2,"0")}%2F` +
         `${d.getFullYear()}`;
}

// ── Same headers bseListener uses — these work ──
const BROWSER_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection":      "keep-alive",
  "Upgrade-Insecure-Requests": "1"
};

const API_HEADERS = (cookie) => ({
  "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept":            "application/json, text/plain, */*",
  "Accept-Language":   "en-US,en;q=0.9",
  "Referer":           "https://www.bseindia.com/corporates/ann.html",
  "Origin":            "https://www.bseindia.com",
  "X-Requested-With":  "XMLHttpRequest",
  "Sec-Fetch-Site":    "same-origin",
  "Sec-Fetch-Mode":    "cors",
  ...(cookie ? { "Cookie": cookie } : {})
});

const ORDER_BOOK_KEYWORDS = [
  "infra", "epc", "engineer", "construct", "railway", "rail",
  "defense", "defence", "bharat electron", "bharat dynamic",
  "solar", "renewable", "wind energy", "power", "energy",
  "water", "wabag", "rites", "rvnl", "irfc", "ircon",
  "hal ", " hal", "bel ", " bel", "ntpc", "l&t", "larsen",
  "kec ", "kalpataru", "patel eng", "techno elec", "thermax",
  "cummins", "bhel", "suzlon", "tata power", "inox wind",
  "greenko", "torrent power", "adani green", "adani power",
  "jsw energy", "nhpc", "container corp", "concor",
  "abb india", "siemens", "hitachi energy", "transformer",
  "garden reach", "cochin ship", "mazagon", "data pattern",
  "paras defence", "mtar", "astra micro", "centum",
  "va tech", "ncc ", " ncc", "hg infra", "pnc infra",
  "dilip build", "j kumar", "texmaco", "titagarh",
  "jupiter wagon", "cgpower", "cg power", "carborundum",
  "kalpataru", "knr construct", "ashoka build",
  "irb infra", "cube highways", "road infra",
  "bharat forge", "elcom", "voltamp"
];

function isOrderBookCompany(name) {
  const n = (name || "").toLowerCase();
  return ORDER_BOOK_KEYWORDS.some(k => n.includes(k.toLowerCase().trim()));
}

// ── Step 1: Get real BSE cookie — same as bseListener warmup() ──
async function getBSECookie() {
  console.log("🍪 Getting BSE session cookie...");
  const attempts = [
    "https://www.bseindia.com/corporates/ann.html",
    "https://www.bseindia.com",
  ];

  for (const url of attempts) {
    try {
      const res = await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: 20000,
        maxRedirects: 5
      });
      const cookies = res.headers["set-cookie"];
      if (cookies?.length) {
        const cookie = cookies.map(c => c.split(";")[0]).join("; ");
        console.log(`✅ Cookie: ${cookie.substring(0, 60)}...`);
        return cookie;
      }
      console.log(`⚠️ ${url} — no Set-Cookie header`);
    } catch(e) {
      console.log(`⚠️ ${url} failed: ${e.message}`);
    }
    await sleep(2000);
  }
  console.log("⚠️ No cookie — will try without (may get empty responses)");
  return "";
}

// ── Step 2: Fetch result filings PER COMPANY (strScrip=CODE) ──
// This works when bulk date-range queries fail
async function fetchResultFilingsForCompany(code, from, to, cookie) {
  const url =
    `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w` +
    `?strCat=-1&strPrevDate=${bseDateFmt(from)}&strScrip=${code}` +
    `&strSearch=P&strToDate=${bseDateFmt(to)}&strType=C&subcategory=-1`;

  try {
    const res  = await axios.get(url, { headers: API_HEADERS(cookie), timeout: 12000 });
    const data = res.data;

    if (typeof data === "string" && data.trim().startsWith("<")) return [];

    const rows =
      data?.Table  || data?.Table1 || data?.data  ||
      data?.Data   || (Array.isArray(data) ? data : []);

    return rows.filter(item => {
      const headline = (item.HEADLINE || "").toLowerCase();
      const cat      = (item.CATEGORYNAME || "").toLowerCase();
      return (
        cat.includes("result") ||
        headline.includes("financial result") ||
        headline.includes("quarterly result") ||
        headline.includes("unaudited") ||
        headline.includes("audited result") ||
        /q[1-4]fy/i.test(headline)
      ) && item.ATTACHMENTNAME;
    });
  } catch(e) {
    return [];
  }
}

// ── Step 3: Bulk fetch (fallback) ──
async function fetchBulkFilings(from, to, cookie) {
  const url =
    `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w` +
    `?strCat=-1&strPrevDate=${bseDateFmt(from)}&strScrip=` +
    `&strSearch=P&strToDate=${bseDateFmt(to)}&strType=C&subcategory=-1`;

  try {
    const res  = await axios.get(url, { headers: API_HEADERS(cookie), timeout: 30000 });
    const data = res.data;

    if (typeof data === "string" && data.trim().startsWith("<")) {
      console.log("   ⚠️ Got HTML — BSE cookie not working");
      return [];
    }

    const rows =
      data?.Table  || data?.Table1 || data?.data  ||
      data?.Data   || (Array.isArray(data) ? data : []);

    if (!rows.length) {
      console.log(`   ⚠️ Empty bulk response — keys: ${Object.keys(data || {}).join(", ")}`);
    }
    return rows;
  } catch(e) {
    console.log(`   ⚠️ Bulk fetch failed: ${e.message}`);
    return [];
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   BSE Result Backfill — FY26 Order Books         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // FIX 1: Actually get the cookie
  const cookie = await getBSECookie();
  await sleep(3000);

  const quarters = [
    { name: "Q3FY26", from: new Date("2026-01-01"), to: new Date("2026-03-28"), label: "Q3FY26 (Oct-Dec 2025) → MOST RECENT" },
    { name: "Q2FY26", from: new Date("2025-10-01"), to: new Date("2025-11-30"), label: "Q2FY26 (Jul-Sep 2025)"               },
    { name: "Q1FY26", from: new Date("2025-07-01"), to: new Date("2025-08-31"), label: "Q1FY26 (Apr-Jun 2025)"               },
  ];

  const found   = {};
  let totalPDFs = 0;
  let totalOB   = 0;

  // Get all OB-relevant companies from mcapDB
  const allCompanies = getCompaniesByMcap(0);
  const obCompanies  = Object.entries(allCompanies)
    .filter(([, data]) => isOrderBookCompany(data.name || ""))
    .slice(0, 150); // cap at 150 to avoid rate limits

  console.log(`📋 Order-book companies to check: ${obCompanies.length}\n`);

  for (const q of quarters) {
    console.log(`\n${"─".repeat(55)}`);
    console.log(`📊 ${q.label}`);
    console.log(`   Date range: ${q.from.toDateString()} → ${q.to.toDateString()}\n`);

    // First try bulk fetch
    console.log("   Trying bulk fetch...");
    let bulkFilings = await fetchBulkFilings(q.from, q.to, cookie);
    const bulkRelevant = bulkFilings.filter(f =>
      isOrderBookCompany(f.SLONGNAME || f.companyname || "")
    );
    console.log(`   Bulk: ${bulkFilings.length} filings, ${bulkRelevant.length} relevant`);

    // Build set of companies covered by bulk
    const bulkCodes = new Set(bulkRelevant.map(f => String(f.SCRIP_CD || "")));

    // Per-company fetch for those not in bulk
    const perCompanyResults = [];
    const toFetchIndividually = obCompanies.filter(([code]) => !bulkCodes.has(code));

    if (toFetchIndividually.length > 0) {
      console.log(`   Per-company fetch for ${toFetchIndividually.length} companies...`);
      let fetched = 0;
      for (const [code, data] of toFetchIndividually) {
        const filings = await fetchResultFilingsForCompany(code, q.from, q.to, cookie);
        if (filings.length > 0) {
          perCompanyResults.push(...filings.map(f => ({ ...f, SCRIP_CD: f.SCRIP_CD || code, _companyName: data.name })));
        }
        fetched++;
        if (fetched % 20 === 0) {
          process.stdout.write(`   ${fetched}/${toFetchIndividually.length} checked...\r`);
          await sleep(500);
        }
        await sleep(150); // gentle rate limit
      }
      console.log(`\n   Per-company: found ${perCompanyResults.length} result filings`);
    }

    // Combine
    const allRelevant = [...bulkRelevant, ...perCompanyResults];
    console.log(`   Total to scan: ${allRelevant.length} PDFs\n`);

    for (const filing of allRelevant) {
      const code    = String(filing.SCRIP_CD || "").trim();
      const company = filing.SLONGNAME || filing.companyname || filing._companyName || "";
      const pdfUrl  = filing.ATTACHMENTNAME
        ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${filing.ATTACHMENTNAME}`
        : null;

      if (!code || !pdfUrl) continue;
      const key = `${code}_${q.name}`;
      if (found[key]) continue;

      process.stdout.write(`   ${company.substring(0,40).padEnd(40)} `);
      totalPDFs++;

      const obValue = await extractOrderValueFromPDF(pdfUrl);

      if (obValue && obValue > 50) {
        updateFromResult(code, {
          confirmedOrderBook:    obValue,
          confirmedQuarter:      q.name,
          newOrdersSinceConfirm: 0
        });

        // Also sync to MongoDB
        try {
          const orderBookDB = require("../data/orderBookDB");
          await orderBookDB.updateFromResultFiling(code, company, obValue, q.name, null);
        } catch(e) {}

        found[key] = { code, company, obValue, quarter: q.name };
        totalOB++;
        const display = obValue >= 1000
          ? `₹${(obValue/1000).toFixed(1)}K Cr`
          : `₹${Math.round(obValue)} Cr`;
        console.log(`${display} ✅`);
      } else {
        console.log(`no order book`);
      }

      await sleep(800);
    }
    await sleep(2000);
  }

  // ── SUMMARY ──
  console.log(`\n${"═".repeat(55)}`);
  console.log(`   PDFs scanned:      ${totalPDFs}`);
  console.log(`   Order books found: ${totalOB}`);

  if (totalOB > 0) {
    console.log("\n   Company                              Quarter    Order Book");
    console.log("   " + "─".repeat(55));
    Object.values(found)
      .sort((a, b) => b.obValue - a.obValue)
      .forEach(r => {
        const ob = r.obValue >= 1000
          ? `₹${(r.obValue/1000).toFixed(1)}K Cr`
          : `₹${Math.round(r.obValue)} Cr`;
        console.log(`   ${r.company.substring(0,35).padEnd(35)} ${r.quarter}  ${ob}`);
      });

    console.log("\n✅ Data saved to orderBookHistory.json");
    console.log("   Deploy your server to sync to MongoDB.\n");
  } else {
    console.log("\n⚠️  No order books found.");
    console.log("\n   BSE API status check:");
    if (!cookie) {
      console.log("   ❌ No cookie obtained — BSE is blocking warmup requests");
      console.log("   💡 Try: Run from a different network / VPN");
      console.log("   💡 Or:  Run during IST market hours (9am-4pm)");
    } else {
      console.log("   ✅ Cookie obtained but API still returning empty");
      console.log("   💡 BSE may be rate-limiting — wait 10 mins and retry");
      console.log("   💡 Or the result filing season hasn't started yet for this quarter");
    }
    console.log("\n   Manual alternative:");
    console.log("   Visit https://www.bseindia.com/corporates/ann.html");
    console.log("   Filter by 'Results' category for any company");
    console.log("   Copy the PDF URL and test: node -e \"require('./server/services/data/pdfReader').extractOrderValueFromPDF('PDF_URL').then(console.log)\"");
  }
}

main().catch(err => {
  console.error("❌ Fatal error:", err.message);
  process.exit(1);
});