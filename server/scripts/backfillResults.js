/**
 * backfillResults.js
 * Fetches Q1-Q3 FY26 result filings and extracts order book values.
 * Run: node server/scripts/backfillResults.js
 */

const axios = require("axios");
const { updateFromResult } = require("../services/data/marketCap");
const { extractOrderValueFromPDF } = require("../services/data/pdfReader");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function bseDateFmt(d) {
  return `${String(d.getDate()).padStart(2,"0")}%2F${String(d.getMonth()+1).padStart(2,"0")}%2F${d.getFullYear()}`;
}

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
  "jupiter wagon", "cgpower", "cg power", "carborundum"
];

function isOrderBookCompany(name) {
  const n = (name || "").toLowerCase();
  return ORDER_BOOK_KEYWORDS.some(k => n.includes(k.toLowerCase().trim()));
}

// ── Step 1: Get BSE cookie by visiting homepage ──
async function getBSECookie() {
  console.log("🍪 Getting BSE session cookie...");
  const attempts = [
    "https://www.bseindia.com/corporates/ann.html",
    "https://www.bseindia.com",
    "https://www.bseindia.com/markets/equity/EQReports/StockReach_new.aspx"
  ];

  for (const url of attempts) {
    try {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
        },
        timeout: 20000,
        maxRedirects: 5
      });
      const cookies = res.headers["set-cookie"];
      if (cookies?.length) {
        const cookie = cookies.map(c => c.split(";")[0]).join("; ");
        console.log(`✅ Cookie obtained from ${url}`);
        return cookie;
      }
    } catch(e) {
      console.log(`⚠️ ${url} failed: ${e.message}`);
    }
    await sleep(1000);
  }
  console.log("⚠️ No cookie obtained — will try without cookie");
  return "";
}

// ── Step 2: Fetch result filings ──
async function fetchFilings(from, to, cookie) {
  const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.bseindia.com/corporates/ann.html",
    "Origin": "https://www.bseindia.com",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
  };
  if (cookie) BROWSER_HEADERS["Cookie"] = cookie;

  // Try multiple category codes — BSE uses different codes
  const urls = [
    // strCat=-1 = ALL categories (includes results)
    `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?strCat=-1&strPrevDate=${bseDateFmt(from)}&strScrip=&strSearch=P&strToDate=${bseDateFmt(to)}&strType=C&subcategory=-1`,
    // strCat=10 = Financial Results only
    `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?strCat=10&strPrevDate=${bseDateFmt(from)}&strScrip=&strSearch=P&strToDate=${bseDateFmt(to)}&strType=C&subcategory=-1`,
    // Alternative results endpoint
    `https://api.bseindia.com/BseIndiaAPI/api/AnnGetData/w?strCat=Result&strPrevDate=${bseDateFmt(from)}&strScrip=&strSearch=P&strToDate=${bseDateFmt(to)}&strType=C`,
  ];

  for (const url of urls) {
    try {
      console.log(`   Trying: ${url.substring(50, 120)}...`);
      const res  = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 30000 });
      const data = res.data;

      if (typeof data === "string" && data.includes("<")) {
        console.log("   ⚠️ Got HTML — BSE blocking, need cookie");
        continue;
      }

      const rows = data?.Table || data?.Table1 || data?.data ||
                   data?.Data  || (Array.isArray(data) ? data : []);

      if (rows.length > 0) {
        console.log(`   ✅ Got ${rows.length} filings`);
        return rows;
      } else {
        console.log(`   ⚠️ Empty — keys: ${Object.keys(data || {}).join(", ")}`);
      }
    } catch(e) {
      console.log(`   ❌ ${e.message}`);
    }
    await sleep(1500);
  }
  return [];
}

// ── Filter to result filings only ──
function isResultFiling(filing) {
  const headline = (filing.HEADLINE || filing.headline || "").toLowerCase();
  const category = (filing.CATEGORYNAME || filing.categoryname || "").toLowerCase();
  return category.includes("result") ||
    headline.includes("financial result") ||
    headline.includes("quarterly result") ||
    headline.includes("q1fy") || headline.includes("q2fy") ||
    headline.includes("q3fy") || headline.includes("q4fy") ||
    headline.includes("unaudited result") ||
    headline.includes("audited result") ||
    headline.includes("results for the quarter");
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   BSE Result Backfill — FY26 Order Books         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const cookie = "ar_debug=1";

  const quarters = [
    {
      name:  "Q1FY26",
      from:  new Date("2025-07-01"),
      to:    new Date("2025-08-31"),
      label: "Q1FY26 (Apr-Jun 2025) → filed Jul-Aug 2025"
    },
    {
      name:  "Q2FY26",
      from:  new Date("2025-10-01"),
      to:    new Date("2025-11-30"),
      label: "Q2FY26 (Jul-Sep 2025) → filed Oct-Nov 2025"
    },
    {
      name:  "Q3FY26",
      from:  new Date("2026-01-01"),
      to:    new Date("2026-03-22"),
      label: "Q3FY26 (Oct-Dec 2025) → filed Jan-Mar 2026 ← MOST IMPORTANT"
    }
  ];

  const found   = {};
  let totalPDFs = 0;
  let totalOB   = 0;

  for (const q of quarters) {
    console.log(`\n${"─".repeat(55)}`);
    console.log(`📊 ${q.label}`);

    const allFilings    = await fetchFilings(q.from, q.to, cookie);
    const resultFilings = allFilings.filter(isResultFiling);
    const relevant      = resultFilings.filter(f =>
      isOrderBookCompany(f.SLONGNAME || f.companyname || "")
    );

    console.log(`   All filings:      ${allFilings.length}`);
    console.log(`   Result filings:   ${resultFilings.length}`);
    console.log(`   Order-book cos:   ${relevant.length}`);

    if (relevant.length === 0) continue;

    for (const filing of relevant) {
      const code    = String(filing.SCRIP_CD || "").trim();
      const company = filing.SLONGNAME || filing.companyname || "";
      const pdfUrl  = filing.ATTACHMENTNAME
        ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${filing.ATTACHMENTNAME}`
        : null;

      if (!code || !pdfUrl) continue;
      const key = `${code}_${q.name}`;
      if (found[key]) continue;

      process.stdout.write(`   ${company.substring(0,38).padEnd(38)} `);
      totalPDFs++;

      const obValue = await extractOrderValueFromPDF(pdfUrl);

      if (obValue && obValue > 100) {
        updateFromResult(code, {
          confirmedOrderBook:    obValue,
          confirmedQuarter:      q.name,
          newOrdersSinceConfirm: 0
        });
        found[key] = { code, company, obValue, quarter: q.name };
        totalOB++;
        const display = obValue >= 1000 ? `₹${(obValue/1000).toFixed(1)}K Cr` : `₹${obValue} Cr`;
        console.log(`${display} ✅`);
      } else {
        console.log(`no order book in PDF`);
      }

      await sleep(1000);
    }
    await sleep(3000);
  }

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
          : `₹${r.obValue} Cr`;
        console.log(`   ${r.company.substring(0,35).padEnd(35)} ${r.quarter}  ${ob}`);
      });

    console.log("\n   git add server/data/orderBookHistory.json");
    console.log("   git commit -m \"feat: Q3FY26 order book baselines\"");
    console.log("   git push");
  } else {
    console.log("\n⚠️  No order books found.");
    console.log("   Possible reasons:");
    console.log("   1. BSE API blocked your IP — try running again in a few minutes");
    console.log("   2. pdfReader couldn't extract values — check PDF format");
    console.log("   3. BSE cookie expired — script will retry automatically next run");
  }
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});