const orderDetector = require("../intelligence/orderDetector");

// ── NEGATIVE CONTEXT — these always override to NEWS ──
const NEGATIVE_PATTERNS = [
  // legal / regulatory trouble
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
  "default", "npa", "stressed asset",
  "loss for", "net loss", "quarterly loss",
  "regulatory action", "adjudication", "compounding",
  "suspension", "debarment", "disqualification",
  "statutory notice", "demand u/s", "order u/s",
  "deputy commissioner", "commissioner of income",
  "gst notice", "gst demand", "customs notice",
  "fire at", "accident at", "plant shutdown",
  "strike", "lockout", "labour dispute",
  // guarantees / liabilities
  "corporate guarantee", "guarantee for term loan",
  "guarantee towards", "contingent liability",
  "surety for", "indemnity for",
  "pledge of shares", "encumbrance of shares",
  "issuance of guarantee", "issue of guarantee",
  "invocation of guarantee", "revocation",
  // accounting / audit issues
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
  // project issues
  "delay in", "delays in", "unable to",
  "postponement", "cancellation of project",
  "project cancelled", "project stalled",
  "force majeure", "natural disaster",
  "flood damage", "fire damage",
  // routine investor / meeting notices
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
  // boilerplate / no info filings
  "please refer to the attachment",
  "please find attached",
  "please find enclosed",
  "as per attached annexure",
  "as per annexure",
  "kindly refer",
  "enclosed herewith",
  "as per attached",
  "pursuant to regulation 30",
  "disclosure under regulation 30",
  "reg 30 disclosure",
  "regulation 30 disclosure",
  "intimation under regulation",
  "newspaper publication",
  "newspaper advertisement",
  "extract of newspaper",
  "copy of newspaper",
  "outcome of board meeting",
  "proceedings of agm",
  "proceedings of egm",
  "financial results for",
  "unaudited financial results",
  "audited financial results",
  "standalone financial results",
  "consolidated financial results",
  "quarterly results",
  "half yearly results",
  "annual results",
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
  "alteration of aoa"
];

// ── ORDER — only real business orders ──
const ORDER_POSITIVE = [
  "received order", "receives order", "new order",
  "work order", "epc order", "supply order",
  "contract order", "order win", "order from",
  "bagged order", "bags order", "secures order",
  "letter of award", "loa from", "loa for",
  "purchase order", "export order", "bulk order",
  "order inflow", "fresh order",
  "repeat order", "prestigious order", "major order",
  "order worth", "order of rs", "order valued",
  "awarded contract", "wins contract", "bags contract",
  "secures contract", "project award",
  "project win", "wins project", "project secured",
  "construction contract", "turnkey contract",
  "supply and installation", "epc contract",
  "o&m contract", "amc contract"
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
  "attachment order", "recovery order"
];

// ── MERGER — only real M&A ──
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
  "pursuant to amalgamation", "post amalgamation"
];

// ── CAPEX ──
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

// ── INSIDER BUY ──
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
  "promoter stake sale"
];

// ── PARTNERSHIP ──
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

// ── CORPORATE ACTION ──
const CORPORATE_ACTION_POSITIVE = [
  "dividend of rs", "interim dividend",
  "final dividend", "special dividend",
  "bonus issue of", "stock split",
  "rights issue of", "buyback of shares",
  "share buyback", "record date for dividend",
  "ex-dividend date", "sub-division of shares",
  "consolidation of shares", "face value change"
];

// ── SMART MONEY ──
const SMART_MONEY_POSITIVE = [
  "fii buying", "dii buying", "institutional buying",
  "mutual fund buying", "bulk deal",
  "block deal", "qib subscription",
  "anchor investor", "foreign investor buys",
  "portfolio investment increases",
  "fpi increases stake", "institutional stake increase"
];

// ── FUNDRAISE ──
const FUNDRAISE_POSITIVE = [
  "qip of", "ipo of", "ncd issue",
  "rights issue proceeds", "fpo of",
  "fundraise of", "raises rs", "fund raise",
  "board approves fundraising", "approves ncd",
  "approves qip", "preferential issue of",
  "private placement of"
];

// ── HELPERS ──
function matchesAny(text, patterns) {
  return patterns.some(p => text.includes(p));
}

function isNegativeContext(text) {
  return matchesAny(text, NEGATIVE_PATTERNS);
}

// ── INSIDER SIZE DETECTOR — score by % acquired ──
function insiderScoreBySize(title) {
  const text = title.toLowerCase();

  // look for percentage pattern like "2.5%" or "0.09%"
  const pctMatch = text.match(/(\d+\.?\d*)\s*%/);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    if (pct >= 2)    return 50;
    if (pct >= 1)    return 40;
    if (pct >= 0.5)  return 30;
    if (pct >= 0.1)  return 20;
    return 15; // below 0.1% — very small buy
  }

  // look for crore value pattern like "rs. 50 crore" or "50cr"
  const crMatch = text.match(/rs\.?\s*(\d+\.?\d*)\s*(cr|crore|lakh|lac)/);
  if (crMatch) {
    const unit = crMatch[2];
    const val  = parseFloat(crMatch[1]);
    const crVal = unit.startsWith("l") ? val / 100 : val;
    if (crVal >= 100) return 50;
    if (crVal >= 50)  return 40;
    if (crVal >= 10)  return 30;
    if (crVal >= 1)   return 20;
    return 15;
  }

  return 25; // default if no size info found
}

function analyzeAnnouncement(data) {
  if (!data || !data.title) return null;

  const text = data.title.toLowerCase();

  // ── STEP 1: Negative context always wins ──
  if (isNegativeContext(text)) {
    return {
      ...data,
      type: "NEWS",
      value: 5,
      ago: data.ago || "just now"
    };
  }

  let type = null;
  let value = 10;

  // ── STEP 2: ORDER ALERT ──
  if (matchesAny(text, ORDER_POSITIVE) && !matchesAny(text, ORDER_NEGATIVE)) {
    type = "ORDER_ALERT";
    value = orderDetector(data.title) || 50;
  }

  // ── STEP 3: MERGER ──
  else if (matchesAny(text, MERGER_POSITIVE) && !matchesAny(text, MERGER_NEGATIVE)) {
    type = "MERGER";
    value = 80;
  }

  // ── STEP 4: CAPEX ──
  else if (matchesAny(text, CAPEX_POSITIVE) && !matchesAny(text, CAPEX_NEGATIVE)) {
    type = "CAPEX";
    value = 60;
  }

  // ── STEP 5: INSIDER BUY — size-aware scoring ──
  else if (matchesAny(text, INSIDER_BUY_POSITIVE) && !matchesAny(text, INSIDER_BUY_NEGATIVE)) {
    type = "INSIDER_BUY";
    value = insiderScoreBySize(data.title);
  }

  // ── STEP 6: PARTNERSHIP ──
  else if (matchesAny(text, PARTNERSHIP_POSITIVE) && !matchesAny(text, PARTNERSHIP_NEGATIVE)) {
    type = "PARTNERSHIP";
    value = 40;
  }

  // ── STEP 7: SMART MONEY ──
  else if (matchesAny(text, SMART_MONEY_POSITIVE)) {
    type = "SMART_MONEY";
    value = 35;
  }

  // ── STEP 8: FUNDRAISE ──
  else if (matchesAny(text, FUNDRAISE_POSITIVE)) {
    type = "CORPORATE_ACTION";
    value = 25;
  }

  // ── STEP 9: CORPORATE ACTION ──
  else if (matchesAny(text, CORPORATE_ACTION_POSITIVE)) {
    type = "CORPORATE_ACTION";
    value = 30;
  }

  // ── STEP 10: FALLBACK ──
  else {
    type = "NEWS";
    value = 5;
  }

  return {
    ...data,
    type,
    value,
    ago: data.ago || "just now"
  };
}

module.exports = analyzeAnnouncement;