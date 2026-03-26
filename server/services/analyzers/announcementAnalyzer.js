const orderDetector  = require("../intelligence/orderDetector");
const analyzeResult  = require("./resultAnalyzer");
const { getLiveMcap } = require("../data/liveMcap");
const { getMarketCap } = require("../data/marketCap");

const NEGATIVE_PATTERNS = [
  "income tax", "tax demand", "tax notice", "demand notice",
  "assessment order", "penalty order", "show cause",
  "sebi notice", "sebi order", "enforcement notice",
  "court order", "tribunal order", "arbitration",
  "litigation", "legal notice", "contempt",
  "insolvency", "bankruptcy", "winding up", "liquidat",
  "fraud", "investigation", "probe", "raid",
  "resignation of", "cessation of", "stepping down",
  "death of", "demise of", "sad demise",
  "credit rating downgrade", "rating downgraded",
  "default", "stressed asset",
  "regulatory action", "adjudication", "compounding",
  "suspension", "debarment", "disqualification",
  "statutory notice", "demand u/s", "order u/s",
  "deputy commissioner", "commissioner of income",
  "gst notice", "gst demand", "customs notice",
  "fire at", "accident at", "plant shutdown",
  "strike", "lockout", "labour dispute",
  "corporate guarantee", "guarantee for term loan",
  "guarantee towards", "contingent liability",
  "surety for", "indemnity for",
  "pledge of shares", "encumbrance of shares",
  "issuance of guarantee", "issue of guarantee",
  "invocation of guarantee",
  "restatement", "restatement of accounts",
  "qualified opinion", "adverse opinion",
  "whistle blower", "whistleblower",
  "insider trading violation", "front running",
  "market manipulation", "price rigging",
  "embargo", "sanction imposed",
  "writ petition", "pil filed",
  "attachment order", "garnishee order",
  "search and seizure", "survey by",
  "it department", "it raid",
  "downgrade", "watch negative", "outlook negative",
  "credit watch", "rating withdrawn",
  "delay in", "delays in", "unable to",
  "postponement", "cancellation of project",
  "project cancelled", "project stalled",
  "force majeure", "natural disaster",
  "flood damage", "fire damage",
  "investor meet", "analyst meet", "investor day",
  "earnings call", "conference call scheduled",
  "schedule of meeting", "meeting with investor",
  "meeting with analyst", "investor conference",
  "non deal roadshow", "ndr ",
  "analyst briefing", "earnings webcast",
  "board meeting intimation", "board meeting on",
  "intimation of board meeting",
  "prior intimation", "closure of trading window",
  "trading window closure", "trading window open",
  "unpublished price sensitive",
  "record date intimation", "book closure",
  "agm notice", "egm notice", "postal ballot",
  "scrutinizer report", "voting results",
  "annual general meeting", "extraordinary general",
  "interaction with investor", "interaction with analyst",
  "intimation of investor", "meeting scheduled",
  "analyst call on", "investor call on",
  "cancellation of investor call", "cancellation of analyst",
  "investor call scheduled", "analyst call scheduled",
  "regulation 46", "schedule iii",
  "please refer to the attachment",
  "please find attached",
  "please find enclosed",
  "as per attached annexure",
  "as per annexure",
  "kindly refer",
  "enclosed herewith",
  "as per attached",
  "intimation under regulation",
  "newspaper publication",
  "newspaper advertisement",
  "extract of newspaper",
  "copy of newspaper",
  "outcome of board meeting",
  "proceedings of agm",
  "proceedings of egm",
  "unaudited financial results",
  "audited financial results",
  "standalone financial results",
  "consolidated financial results",
  "change in director",
  "appointment of director",
  "change in auditor",
  "appointment of auditor",
  "change in key managerial",
  "kmp change",
  "loss of share certificate",
  "duplicate share certificate",
  "transmission of shares",
  "name change",
  "change in registered office",
  "change in object clause",
  "alteration of moa",
  "alteration of aoa",
  "inter-se transfer",
  "inter se transfer",
  "by way of gift",
  "transfer by way of gift",
  "gift of shares",
  "gift to family",
  "family trust",
  "succession planning",
  "estate planning",
  "pursuant to will",
  "pursuant to gift",
  "transfer to family",
  "settlement of shares",
  "off market transfer",
  "off-market transfer",
  "intimation received from",
  "disclosure for intimation",
];

const ORDER_POSITIVE = [
  "received order", "receives order", "new order",
  "work order", "epc order", "supply order",
  "contract order", "order win", "order from",
  "bagged order", "bags order", "secures order",
  "letter of award", "loa from", "loa for",
  "letter of acceptance",
  "purchase order", "export order", "bulk order",
  "intimation of receipt of order",
  "intimation of receipt",
  "receipt of purchase order",
  "intimation of order",
  "receipt of loa",
  "receipt of letter of award",
  "receipt of work order",
  "secures work order",
  "award of order",
  "award of contract",
  "receipt of contract",
  "order from ntpc", "order from nhpc",
  "order from power grid", "order from peda",
  "order from bses", "order from discoms",
  "letter of award worth", "loa worth",
  "work order worth", "contract worth rs",
  "project worth rs", "order valued at",
  "contract valued at", "turnkey order",
  "rooftop solar order", "opgw cable order",
  "solar street light", "solar led",
  "order inflow", "fresh order",
  "repeat order", "prestigious order", "major order",
  "order worth", "order of rs", "order valued",
  "awarded contract", "wins contract", "bags contract",
  "secures contract", "project award",
  "project win", "wins project", "project secured",
  "construction contract", "turnkey contract",
  "supply and installation", "epc contract",
  "supply, installation", "supply & installation",
  "o&m contract", "amc contract",
  "commissioning of", "roof top solar",
  "solar pv system", "solar project",
  "bagging of order", "bags a", "secures a",
  "power supply agreement", "long-term supply",
  "long term supply", "thermal power supply",
  "power purchase agreement", "ppa signed",
  "mw thermal", "mw solar", "mw wind",
  "mw power", "gw power", "mw capacity",
  "receipt of order", "intimation of receipt",
  "work order from", "secures work order",
  "order from peda", "order from ntpc",
  "rooftop solar", "solar street light",
  "opgw cable", "solar pv",
  "supply order from", "supply and installation order",
];

const ORDER_NEGATIVE = [
  "court order", "tax order", "assessment order",
  "income tax", "it order", "sebi order",
  "tribunal order", "demand order", "penalty order",
  "show cause order", "interim order", "stay order",
  "order u/s", "order under section", "order passed by",
  "order received from court", "nclat order", "nclt order",
  "high court order", "supreme court order",
  "compliance order", "regulatory order",
  "restraint order", "injunction order",
  "attachment order", "recovery order",
  "commissioner of customs",
  "customs order",
  "favourable order from office",
  "favorable order from office",
  "demand has been dropped",
  "demand dropped",
  "demand quashed",
  "tax demand dropped",
  "igst demand",
  "customs demand",
  "excise demand",
  "relief from tax demand",
  "contingent liability",
  "show cause notice",
  "scn"
];

const ORDER_SIZE_KEYWORDS = [
  { pattern: "'mega' order",            crores: 1000 },
  { pattern: "mega' order",             crores: 1000 },
  { pattern: "mega order",              crores: 1000 },
  { pattern: "'mega' ppp",              crores: 1000 },
  { pattern: "mega ppp",                crores: 1000 },
  { pattern: "mega contract",           crores: 1000 },
  { pattern: "mega project",            crores: 1000 },
  { pattern: "\u2018major\u2019 order", crores: 800  },
  { pattern: "'major' order",           crores: 800  },
  { pattern: "major order",             crores: 800  },
  { pattern: "large order",             crores: 400  },
  { pattern: "large contract",          crores: 400  },
];

const MERGER_POSITIVE = [
  "merger with", "merger of", "proposed merger",
  "scheme of merger", "scheme of amalgamation",
  "acquisition of", "acquires", "acquiring",
  "takeover of", "open offer", "delisting offer",
  "strategic acquisition", "majority stake acquisition",
  "controlling stake acquisition", "buyout",
  "slump sale", "business transfer", "asset acquisition",
  "100% stake", "51% stake acquisition",
  "binding agreement to acquire", "definitive agreement"
];

const MERGER_NEGATIVE = [
  "merged into", "merged w.e.f", "already merged",
  "post merger", "pursuant to merger", "earlier merger",
  "erstwhile", "formerly known", "previously merged",
  "completion of merger", "effect of merger",
  "pursuant to amalgamation", "post amalgamation",
  "inter-se transfer", "inter se transfer",
  "by way of gift", "family trust",
  "succession", "exempt under regulation 11",
  "sebi exemption order", "regulation 29"
];

const CAPEX_POSITIVE = [
  "capex of", "capital expenditure of", "invest rs",
  "investment of rs", "setting up new",
  "greenfield plant", "greenfield project",
  "brownfield expansion", "new plant at",
  "new facility at", "expand capacity",
  "capacity expansion of", "capacity addition of",
  "new manufacturing unit", "commissioning of plant",
  "inaugurates plant", "new unit at",
  "sets up manufacturing", "establish new plant",
  "capital investment of", "investing rs",
  "plans to invest", "board approves capex"
];

const CAPEX_NEGATIVE = [
  "capex guidance", "capex plan review",
  "no capex", "defer capex", "postpone capex",
  "reduce capex", "cut capex"
];

const INSIDER_BUY_POSITIVE = [
  "promoter buying", "promoter purchase",
  "creeping acquisition", "insider buying",
  "bulk deal buy", "block deal buy",
  "acquisition of shares by promoter",
  "increase in promoter shareholding",
  "promoter increases stake",
  "open market purchase by promoter",
  "esop exercise", "preferential allotment to promoter",
  "promoter acquiring", "promoter buys"
];

const INSIDER_BUY_NEGATIVE = [
  "promoter selling", "promoter sell",
  "promoter pledged", "insider selling",
  "reduction in promoter", "promoter reduces",
  "promoter offloads", "promoter divests",
  "promoter stake sale",
  "inter-se transfer", "inter se transfer",
  "by way of gift", "family trust",
  "off market transfer", "off-market transfer"
];

const PARTNERSHIP_POSITIVE = [
  "signs mou", "signed mou", "mou with",
  "joint venture with", "jv with", "forms jv",
  "partnership with", "collaboration with",
  "strategic partnership", "technology agreement with",
  "licensing agreement with", "distribution agreement with",
  "supply agreement with", "exclusive agreement with",
  "long term agreement with", "framework agreement with",
  "memorandum of understanding", "letter of intent",
  "strategic alliance", "business alliance",
  "technology transfer", "license agreement"
];

const PARTNERSHIP_NEGATIVE = [
  "terminates agreement", "cancels mou",
  "ends partnership", "discontinues agreement",
  "exits joint venture", "dissolves jv",
  "winds up jv"
];

const CORPORATE_ACTION_POSITIVE = [
  "dividend of rs", "interim dividend",
  "final dividend", "special dividend",
  "bonus issue of", "stock split",
  "rights issue of", "buyback of shares",
  "share buyback", "record date for dividend",
  "ex-dividend date", "sub-division of shares",
  "consolidation of shares", "face value change"
];

const SMART_MONEY_POSITIVE = [
  "fii buying", "dii buying", "institutional buying",
  "mutual fund buying", "bulk deal",
  "block deal", "qib subscription",
  "anchor investor", "foreign investor buys",
  "portfolio investment increases",
  "fpi increases stake", "institutional stake increase"
];

const FUNDRAISE_POSITIVE = [
  "qip of", "ipo of", "ncd issue",
  "rights issue proceeds", "fpo of",
  "fundraise of", "raises rs", "fund raise",
  "board approves fundraising", "approves ncd",
  "approves qip", "preferential issue of",
  "private placement of"
];

function matchesAny(text, patterns) {
  return patterns.some(p => text.includes(p));
}

function isNegativeContext(text) {
  return matchesAny(text, NEGATIVE_PATTERNS);
}

function insiderScoreBySize(title) {
  const text = title.toLowerCase();
  const pctMatch = text.match(/(\d+\.?\d*)\s*%/);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    if (pct >= 2)   return 50;
    if (pct >= 1)   return 40;
    if (pct >= 0.5) return 30;
    if (pct >= 0.1) return 20;
    return 15;
  }
  const crMatch = text.match(/rs\.?\s*(\d+\.?\d*)\s*(cr|crore|lakh|lac)/);
  if (crMatch) {
    const unit  = crMatch[2];
    const val   = parseFloat(crMatch[1]);
    const crVal = unit.startsWith("l") ? val / 100 : val;
    if (crVal >= 100) return 50;
    if (crVal >= 50)  return 40;
    if (crVal >= 10)  return 30;
    if (crVal >= 1)   return 20;
    return 15;
  }
  return 25;
}

// ── MCap-relative scoring ──
function scoreFromMcapRatio(crores, mcap) {
  const pct = (crores / mcap) * 100;
  if      (pct >= 50)  return 98;
  else if (pct >= 25)  return 95;
  else if (pct >= 15)  return 92;
  else if (pct >= 10)  return 88;
  else if (pct >= 5)   return 82;
  else if (pct >= 2)   return 72;
  else if (pct >= 1)   return 62;
  else if (pct >= 0.5) return 52;
  else if (pct >= 0.1) return 42;
  else                 return 28;
}

// ── Absolute size scoring (fallback when no MCap) ──
function scoreFromAbsoluteSize(crores) {
  if      (crores >= 50000) return 98;
  else if (crores >= 20000) return 95;
  else if (crores >= 10000) return 93;
  else if (crores >= 5000)  return 90;
  else if (crores >= 2000)  return 87;
  else if (crores >= 1000)  return 85;
  else if (crores >= 500)   return 78;
  else if (crores >= 200)   return 70;
  else if (crores >= 100)   return 62;
  else if (crores >= 50)    return 55;
  else if (crores >= 20)    return 47;
  else if (crores >= 10)    return 40;
  else                      return 32;
}

// ── FIXED: Enhanced order value extraction ──
// Catches Indian number formats that orderDetector misses
function extractOrderValue(title) {
  if (!title) return null;

  // First try orderDetector
  try {
    const detected = orderDetector(title);
    if (detected?.crores && detected.crores > 0) return detected;
  } catch(e) {}

  const t = title;
  const patterns = [
    // Rs. 123.45 Crore/Crores
    { re: /rs\.?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\b/i,  isLakh: false },
    // ₹123 Cr
    { re: /₹\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\b/i,      isLakh: false },
    // INR 123 Cr
    { re: /inr\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\b/i,    isLakh: false },
    // 123 Crore (number directly before crore)
    { re: /\b([\d,]+(?:\.\d+)?)\s*(?:crore|crores)\b/i,           isLakh: false },
    // Rs. 123 Lakh → convert to crores
    { re: /rs\.?\s*([\d,]+(?:\.\d+)?)\s*(?:lakh|lakhs|lac)\b/i,   isLakh: true  },
    // ₹123 Lakh
    { re: /₹\s*([\d,]+(?:\.\d+)?)\s*(?:lakh|lakhs|lac)\b/i,       isLakh: true  },
    // 123 lakh
    { re: /\b([\d,]+(?:\.\d+)?)\s*(?:lakh|lakhs|lac)\b/i,         isLakh: true  },
  ];

  for (const { re, isLakh } of patterns) {
    const match = t.match(re);
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(val) && val > 0) {
        const crores = isLakh ? val / 100 : val;
        return { crores, years: null, periodLabel: null, annualCrores: null, mw: null, isMWBased: false };
      }
    }
  }

  return null;
}

async function analyzeAnnouncement(data) {
  if (!data || !data.title) return null;

  const text = data.title.toLowerCase();

  // ── STEP 1: Negative context always wins ──
  if (isNegativeContext(text)) {
    return { ...data, type: "NEWS", value: 5, _orderInfo: null, ago: data.ago || "just now" };
  }

  let type       = null;
  let value      = 10;
  let _orderInfo = null;

  // ── STEP 2: ORDER ALERT ──
  if (
    matchesAny(text, ORDER_POSITIVE) &&
    !matchesAny(text, ORDER_NEGATIVE) &&
    !isNegativeContext(text)
  ) {
    type = "ORDER_ALERT";

    let keywordCrores = null;
    for (const k of ORDER_SIZE_KEYWORDS) {
      if (text.includes(k.pattern)) { keywordCrores = k.crores; break; }
    }

    // ── FIXED: Use enhanced extraction that handles Indian formats ──
    const orderInfo = extractOrderValue(data.title);
    const crores    = keywordCrores || orderInfo?.crores || null;

    if (crores) {
      // Fetch live MCap, fall back to static
      const mcap = (await getLiveMcap(data.code)) || getMarketCap(data.code) || null;

      if (mcap && mcap > 0) {
        value = scoreFromMcapRatio(crores, mcap);
        const pct = (crores / mcap * 100).toFixed(2);
        console.log(`📦 ORDER: ${data.company} ₹${crores}Cr = ${pct}% of MCap₹${mcap}Cr → score ${value}`);
      } else {
        value = scoreFromAbsoluteSize(crores);
        console.log(`📦 ORDER: ${data.company} ₹${crores}Cr (no MCap) → score ${value}`);
      }

      _orderInfo = {
        crores,
        years:        orderInfo?.years        || null,
        periodLabel:  orderInfo?.periodLabel  || null,
        annualCrores: orderInfo?.annualCrores || null,
        mw:           orderInfo?.mw           || null,
        isMWBased:    orderInfo?.isMWBased    || false,
        mcap:         mcap || null
      };

    } else {
      value = 30;
    }

  // ── STEP 3: MERGER ──
  } else if (matchesAny(text, MERGER_POSITIVE) && !matchesAny(text, MERGER_NEGATIVE)) {
    type = "MERGER"; value = 80;

  // ── STEP 4: CAPEX ──
  } else if (matchesAny(text, CAPEX_POSITIVE) && !matchesAny(text, CAPEX_NEGATIVE)) {
    type = "CAPEX"; value = 60;

  // ── STEP 5: INSIDER BUY ──
  } else if (matchesAny(text, INSIDER_BUY_POSITIVE) && !matchesAny(text, INSIDER_BUY_NEGATIVE)) {
    type = "INSIDER_BUY"; value = insiderScoreBySize(data.title);

  // ── STEP 6: PARTNERSHIP ──
  } else if (matchesAny(text, PARTNERSHIP_POSITIVE) && !matchesAny(text, PARTNERSHIP_NEGATIVE)) {
    type = "PARTNERSHIP"; value = 40;

  // ── STEP 7: SMART MONEY ──
  } else if (matchesAny(text, SMART_MONEY_POSITIVE)) {
    type = "SMART_MONEY"; value = 35;

  // ── STEP 8: FUNDRAISE ──
  } else if (matchesAny(text, FUNDRAISE_POSITIVE)) {
    type = "CORPORATE_ACTION"; value = 25;

  // ── STEP 9: CORPORATE ACTION ──
  } else if (matchesAny(text, CORPORATE_ACTION_POSITIVE)) {
    type = "CORPORATE_ACTION"; value = 30;

  // ── STEP 10: RESULT FILING ──
  } else {
    const resultData = analyzeResult(data);
    if (resultData) return resultData;
    type = "NEWS"; value = 5;
  }

  return { ...data, type, value, _orderInfo, ago: data.ago || "just now" };
}

module.exports = analyzeAnnouncement;
module.exports.scoreFromMcapRatio    = scoreFromMcapRatio;
module.exports.scoreFromAbsoluteSize = scoreFromAbsoluteSize;