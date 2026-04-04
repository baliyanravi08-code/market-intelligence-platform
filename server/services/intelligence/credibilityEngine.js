/**
 * credibilityEngine.js
 * server/services/intelligence/credibilityEngine.js
 *
 * Tracks what management SAID vs what actually HAPPENED.
 * Pulls guidance from presentationParser.js (promised targets)
 * and compares against actual results from resultAnalyzer.js data.
 *
 * Credibility score (0–100) per company:
 *   - 80–100: Management consistently delivers or beats guidance
 *   - 60–79:  Generally reliable, minor misses
 *   - 40–59:  Mixed track record, moderate discount
 *   - 20–39:  Frequent misses, high discount warranted
 *   0–19:   Habitual over-promisers, guidance is noise
 *
 * Wired into:
 *   - coordinator.js: persistCredibility()
 *   - Socket: "credibility_update" event
 *   - radarEngine.js: credibilityScore added to radar entries
 */

"use strict";

const mongoose = require("mongoose");
const path     = require("path");
const fs       = require("fs");

const { getGuidanceForScrip, getAllGuidance } = require("./presentationParser");

// ── Mongoose schema for actual results (populated by resultAnalyzer.js) ───────
// We store actual quarterly results here to compare against guidance
const ActualResultSchema = new mongoose.Schema({
  scrip:      { type: String, index: true },
  company:    String,
  quarter:    { type: String, index: true },   // "Q4FY26"
  fy:         { type: String, index: true },   // "FY26"

  // Actuals — filled from result PDF parsing
  revenueCr:    Number,   // actual revenue this quarter
  ebitdaPct:    Number,   // actual EBITDA margin %
  capexCr:      Number,   // actual capex this period
  orderInflowCr: Number,  // actual order inflow
  capacityMW:   Number,   // actual capacity (if applicable)

  // Source
  pdfUrl:      String,
  filingDate:  Date,
  savedAt:     { type: Number, index: true, default: Date.now }
}, { timestamps: true, strict: false });

ActualResultSchema.index({ scrip: 1, quarter: 1 }, { unique: true });

// ── Credibility record schema ─────────────────────────────────────────────────
const CredibilitySchema = new mongoose.Schema({
  scrip:       { type: String, index: true, unique: true },
  company:     String,
  updatedAt:   { type: Number, index: true },

  // Per-metric hit rates (0–1 ratio)
  metrics: {
    revenue: {
      promises:  Number,   // count of revenue guidance items checked
      hits:      Number,   // count where actual >= 90% of target
      nearMisses: Number,  // count where actual >= 75% of target
      hitRate:   Number,   // hits / promises
      avgVariance: Number  // mean (actual - target) / target * 100
    },
    ebitda: {
      promises: Number, hits: Number, nearMisses: Number,
      hitRate: Number,  avgVariance: Number
    },
    orders: {
      promises: Number, hits: Number, nearMisses: Number,
      hitRate: Number,  avgVariance: Number
    },
    capex: {
      promises: Number, hits: Number, nearMisses: Number,
      hitRate: Number,  avgVariance: Number
    }
  },

  // Computed score
  overallScore:  { type: Number, index: true },
  label:         String,   // "HIGH CREDIBILITY" / "MODERATE" / "LOW" / "UNRELIABLE"
  color:         String,   // for UI badge: "green" / "amber" / "orange" / "red"

  // History — last 8 comparisons
  history: [{
    fy:         String,
    quarter:    String,
    metric:     String,
    promised:   Number,
    actual:     Number,
    variance:   Number,   // (actual - promised) / promised * 100
    hit:        Boolean,
    checkedAt:  Number
  }],

  // Summary for quick display
  summary: String,   // "Hit 4/5 revenue targets, avg +8% above guidance"
  totalDataPoints: Number

}, { timestamps: true });

let ActualResultModel   = null;
let CredibilityModel    = null;

function getActualModel() {
  if (ActualResultModel) return ActualResultModel;
  try   { ActualResultModel = mongoose.model("ActualResult"); }
  catch { ActualResultModel = mongoose.model("ActualResult", ActualResultSchema); }
  return ActualResultModel;
}

function getCredModel() {
  if (CredibilityModel) return CredibilityModel;
  try   { CredibilityModel = mongoose.model("Credibility"); }
  catch { CredibilityModel = mongoose.model("Credibility", CredibilitySchema); }
  return CredibilityModel;
}

// ── In-memory credibility cache ───────────────────────────────────────────────
const credMap = new Map();   // scrip → credibility doc

// ── HIT threshold: actual must be >= HIT_THRESHOLD * target to count as a hit ─
const HIT_THRESHOLD      = 0.90;   // 90% of target = hit
const NEAR_MISS_THRESHOLD = 0.75;  // 75% of target = near miss

// ── FY helpers ────────────────────────────────────────────────────────────────

function fyToYear(fy) {
  // "FY26" → 2026
  const m = String(fy).match(/FY(\d{2,4})/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  return n < 100 ? 2000 + n : n;
}

function getCurrentFY() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const fy    = month >= 4 ? year + 1 : year;
  return `FY${String(fy).slice(-2)}`;
}

// ── Save actual result (called from resultAnalyzer integration) ───────────────
async function saveActualResult(scrip, company, quarter, actuals) {
  if (!scrip || !quarter) return;

  const fyMatch = quarter.match(/FY(\d{2,4})/i);
  const fy      = fyMatch ? `FY${fyMatch[1]}` : getCurrentFY();

  const doc = {
    scrip:         String(scrip),
    company:       company || "",
    quarter,
    fy,
    revenueCr:     actuals.revenueCr     || null,
    ebitdaPct:     actuals.ebitdaPct     || null,
    capexCr:       actuals.capexCr       || null,
    orderInflowCr: actuals.orderInflowCr || null,
    capacityMW:    actuals.capacityMW    || null,
    pdfUrl:        actuals.pdfUrl        || null,
    filingDate:    actuals.filingDate    ? new Date(actuals.filingDate) : new Date(),
    savedAt:       Date.now()
  };

  try {
    const Model = getActualModel();
    await Model.findOneAndUpdate(
      { scrip: String(scrip), quarter },
      { $set: doc },
      { upsert: true, new: true }
    );
    console.log(`📊 Actual saved: ${company} ${quarter} rev:${actuals.revenueCr || "?"} ebitda:${actuals.ebitdaPct || "?"}%`);
  } catch (err) {
    if (!err.message.includes("duplicate")) {
      console.log(`⚠️ Actual save failed: ${err.message}`);
    }
  }
}

// ── Extract actuals from result PDF text ──────────────────────────────────────
// Called from bseListener.js enrichResultWithPDF — extracts revenue/EBITDA
// from the same PDF text we already fetch for OB extraction

function extractActualsFromResultText(rawText) {
  if (!rawText || rawText.length < 50) return null;
  const t = rawText.toLowerCase().replace(/,/g, "");

  const result = {};

  // ── Revenue ───────────────────────────────────────────────────────────────
  const revPatterns = [
    /(?:total\s+)?(?:revenue|turnover|net\s+sales|income\s+from\s+operations?)\s+(?:of|at|is|was|stood\s+at)?\s*(?:rs\.?|₹|inr)?\s*([\d]+(?:\.\d+)?)\s*(?:crore|crores|cr)\b/i,
    /(?:rs\.?|₹)\s*([\d]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:revenue|turnover|sales)/i,
    /revenue\s+grew\s+(?:to|by)\s+(?:rs\.?|₹)?\s*([\d]+(?:\.\d+)?)\s*(?:crore|crores|cr)/i,
  ];
  for (const p of revPatterns) {
    const m = t.match(p);
    if (m) {
      const v = parseFloat(m[1]);
      if (v > 1 && v < 10000000) { result.revenueCr = Math.round(v); break; }
    }
  }

  // ── EBITDA margin ─────────────────────────────────────────────────────────
  const ebPatterns = [
    /ebitda\s+margin\s+(?:of|at|is|was|stood\s+at)\s+([\d]+(?:\.\d+)?)\s*%/i,
    /ebitda\s+(?:of|at|is)\s+(?:rs\.?|₹)?\s*([\d]+(?:\.\d+)?)\s*(?:crore|cr)[^%]{0,40}([\d]+(?:\.\d+)?)\s*%/i,
    /operating\s+(?:profit|margin)\s+(?:of|at)\s+([\d]+(?:\.\d+)?)\s*%/i,
  ];
  for (const p of ebPatterns) {
    const m = t.match(p);
    if (m) {
      // Take the percentage group — might be m[1] or m[2]
      const pctStr = m[2] || m[1];
      const v      = parseFloat(pctStr);
      if (v > 0 && v < 100) { result.ebitdaPct = Math.round(v * 10) / 10; break; }
    }
  }

  // ── Order inflow (actual, not book) ───────────────────────────────────────
  const oiPatterns = [
    /order\s+(?:inflow|intake|addition)\s+(?:of|at|was|stood\s+at)\s*(?:rs\.?|₹)?\s*([\d]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
    /(?:fresh|new)\s+order\s+(?:inflow|intake)\s+of\s*(?:rs\.?|₹)?\s*([\d]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  ];
  for (const p of oiPatterns) {
    const m = t.match(p);
    if (m) {
      const v = parseFloat(m[1]);
      if (v > 1 && v < 10000000) { result.orderInflowCr = Math.round(v); break; }
    }
  }

  // ── Capex (actual spend this period) ─────────────────────────────────────
  const cxPatterns = [
    /capex\s+(?:of|spent|incurred|was)\s*(?:rs\.?|₹)?\s*([\d]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
    /capital\s+expenditure\s+(?:of|was|incurred)\s*(?:rs\.?|₹)?\s*([\d]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  ];
  for (const p of cxPatterns) {
    const m = t.match(p);
    if (m) {
      const v = parseFloat(m[1]);
      if (v > 0 && v < 100000) { result.capexCr = Math.round(v); break; }
    }
  }

  const hasActuals = !!(result.revenueCr || result.ebitdaPct || result.orderInflowCr || result.capexCr);
  return hasActuals ? result : null;
}

// ── Core credibility computation ──────────────────────────────────────────────

function computeMetricScore(metric) {
  if (!metric || metric.promises === 0) return null;
  const hitRate = metric.hitRate || 0;

  // Weight: hit rate is primary, average variance is secondary
  const variance = metric.avgVariance || 0;  // positive = beat guidance
  const bonus    = Math.min(10, Math.max(-10, variance / 5));

  return Math.min(100, Math.max(0, hitRate * 100 + bonus));
}

function computeOverallScore(metrics) {
  const weights = {
    revenue: 0.35,
    ebitda:  0.25,
    orders:  0.25,
    capex:   0.15
  };

  let totalWeight = 0;
  let weightedSum = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const score = computeMetricScore(metrics[key]);
    if (score !== null) {
      weightedSum  += score * weight;
      totalWeight  += weight;
    }
  }

  if (totalWeight === 0) return null;
  return Math.round(weightedSum / totalWeight);
}

function scoreToLabel(score) {
  if (score === null) return { label: "INSUFFICIENT DATA", color: "gray" };
  if (score >= 80) return { label: "HIGH CREDIBILITY",     color: "green"  };
  if (score >= 60) return { label: "MODERATE",             color: "teal"   };
  if (score >= 40) return { label: "MIXED TRACK RECORD",   color: "amber"  };
  if (score >= 20) return { label: "LOW CREDIBILITY",      color: "orange" };
  return                  { label: "UNRELIABLE",           color: "red"    };
}

function buildSummary(metrics, overallScore) {
  const parts = [];

  if (metrics.revenue?.promises > 0) {
    const pct = Math.round(metrics.revenue.hitRate * 100);
    const dir = metrics.revenue.avgVariance >= 0 ? "above" : "below";
    parts.push(`Revenue: ${metrics.revenue.hits}/${metrics.revenue.promises} targets hit, avg ${Math.abs(Math.round(metrics.revenue.avgVariance))}% ${dir} guidance`);
  }
  if (metrics.ebitda?.promises > 0) {
    const pct = Math.round(metrics.ebitda.hitRate * 100);
    parts.push(`EBITDA margin: ${pct}% hit rate`);
  }
  if (metrics.orders?.promises > 0) {
    const pct = Math.round(metrics.orders.hitRate * 100);
    parts.push(`Order inflow: ${pct}% hit rate`);
  }

  if (!parts.length) return "Insufficient data to assess";
  return parts.join(" | ");
}

// ── Recompute credibility for a single scrip ──────────────────────────────────

async function recomputeCredibility(scrip, company) {
  const guidance = getGuidanceForScrip(scrip);
  if (!guidance || !guidance.hasData) return null;

  let actuals = [];
  try {
    const Model = getActualModel();
    actuals = await Model.find({ scrip: String(scrip) }).lean();
  } catch(err) {
    console.log(`⚠️ Actuals fetch failed for ${scrip}: ${err.message}`);
    return null;
  }

  if (!actuals.length) return null;

  // Build actuals lookup: fy → actuals
  const actualsByFY = {};
  for (const a of actuals) {
    actualsByFY[a.fy] = a;
  }

  const metrics = {
    revenue: { promises: 0, hits: 0, nearMisses: 0, variances: [] },
    ebitda:  { promises: 0, hits: 0, nearMisses: 0, variances: [] },
    orders:  { promises: 0, hits: 0, nearMisses: 0, variances: [] },
    capex:   { promises: 0, hits: 0, nearMisses: 0, variances: [] },
  };

  const history = [];

  // ── Revenue comparisons ───────────────────────────────────────────────────
  for (const rev of (guidance.guidance?.revenue || [])) {
    const actual = actualsByFY[rev.year];
    if (!actual?.revenueCr || !rev.targetCr) continue;

    metrics.revenue.promises++;
    const variance = (actual.revenueCr - rev.targetCr) / rev.targetCr * 100;
    metrics.revenue.variances.push(variance);

    const hit      = actual.revenueCr >= rev.targetCr * HIT_THRESHOLD;
    const nearMiss = actual.revenueCr >= rev.targetCr * NEAR_MISS_THRESHOLD;
    if (hit)      metrics.revenue.hits++;
    if (nearMiss && !hit) metrics.revenue.nearMisses++;

    history.push({
      fy: rev.year, quarter: actual.quarter || rev.year, metric: "revenue",
      promised: rev.targetCr, actual: actual.revenueCr,
      variance: Math.round(variance * 10) / 10,
      hit, checkedAt: Date.now()
    });
  }

  // ── EBITDA comparisons ────────────────────────────────────────────────────
  for (const eb of (guidance.guidance?.ebitda || [])) {
    const actual = actualsByFY[eb.year];
    if (!actual?.ebitdaPct || !eb.targetPct) continue;

    metrics.ebitda.promises++;
    const variance = actual.ebitdaPct - eb.targetPct;  // absolute diff in %pts
    metrics.ebitda.variances.push(variance);

    const hit      = actual.ebitdaPct >= eb.targetPct * HIT_THRESHOLD;
    const nearMiss = actual.ebitdaPct >= eb.targetPct * NEAR_MISS_THRESHOLD;
    if (hit)      metrics.ebitda.hits++;
    if (nearMiss && !hit) metrics.ebitda.nearMisses++;

    history.push({
      fy: eb.year, quarter: actual.quarter || eb.year, metric: "ebitda",
      promised: eb.targetPct, actual: actual.ebitdaPct,
      variance: Math.round(variance * 10) / 10,
      hit, checkedAt: Date.now()
    });
  }

  // ── Order inflow comparisons ──────────────────────────────────────────────
  for (const ord of (guidance.guidance?.orders || [])) {
    const actual = actualsByFY[ord.year];
    if (!actual?.orderInflowCr || !ord.targetCr) continue;

    metrics.orders.promises++;
    const variance = (actual.orderInflowCr - ord.targetCr) / ord.targetCr * 100;
    metrics.orders.variances.push(variance);

    const hit      = actual.orderInflowCr >= ord.targetCr * HIT_THRESHOLD;
    const nearMiss = actual.orderInflowCr >= ord.targetCr * NEAR_MISS_THRESHOLD;
    if (hit)      metrics.orders.hits++;
    if (nearMiss && !hit) metrics.orders.nearMisses++;

    history.push({
      fy: ord.year, quarter: actual.quarter || ord.year, metric: "orders",
      promised: ord.targetCr, actual: actual.orderInflowCr,
      variance: Math.round(variance * 10) / 10,
      hit, checkedAt: Date.now()
    });
  }

  // ── Capex comparisons ─────────────────────────────────────────────────────
  for (const cx of (guidance.guidance?.capex || [])) {
    const actual = actualsByFY[cx.year];
    if (!actual?.capexCr || !cx.targetCr) continue;

    metrics.capex.promises++;
    const variance = (actual.capexCr - cx.targetCr) / cx.targetCr * 100;
    metrics.capex.variances.push(variance);

    // Capex: management hits if they spend >= 80% (underspend is also a miss)
    const hit      = actual.capexCr >= cx.targetCr * 0.80 && actual.capexCr <= cx.targetCr * 1.30;
    const nearMiss = actual.capexCr >= cx.targetCr * 0.65;
    if (hit)      metrics.capex.hits++;
    if (nearMiss && !hit) metrics.capex.nearMisses++;

    history.push({
      fy: cx.year, quarter: actual.quarter || cx.year, metric: "capex",
      promised: cx.targetCr, actual: actual.capexCr,
      variance: Math.round(variance * 10) / 10,
      hit, checkedAt: Date.now()
    });
  }

  // ── Finalize metric stats ─────────────────────────────────────────────────
  const finalMetrics = {};
  for (const [key, m] of Object.entries(metrics)) {
    finalMetrics[key] = {
      promises:    m.promises,
      hits:        m.hits,
      nearMisses:  m.nearMisses,
      hitRate:     m.promises > 0 ? Math.round(m.hits / m.promises * 1000) / 1000 : 0,
      avgVariance: m.variances.length > 0
        ? Math.round(m.variances.reduce((a, b) => a + b, 0) / m.variances.length * 10) / 10
        : 0
    };
  }

  const totalDataPoints = Object.values(finalMetrics).reduce((s, m) => s + m.promises, 0);
  if (totalDataPoints === 0) return null;

  const overallScore = computeOverallScore(finalMetrics);
  const { label, color } = scoreToLabel(overallScore);
  const summary = buildSummary(finalMetrics, overallScore);

  const credDoc = {
    scrip:      String(scrip),
    company:    company || guidance.company,
    updatedAt:  Date.now(),
    metrics:    finalMetrics,
    overallScore,
    label,
    color,
    history:    history.slice(-20),   // keep last 20 comparisons
    summary,
    totalDataPoints
  };

  // ── Persist ───────────────────────────────────────────────────────────────
  try {
    const Model = getCredModel();
    await Model.findOneAndUpdate(
      { scrip: String(scrip) },
      { $set: credDoc },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.log(`⚠️ Credibility save failed: ${err.message}`);
  }

  // ── Update presentation doc with credibility score ────────────────────────
  const { getModel: getParsedModel } = require("./presentationParser");
  try {
    const PModel = getParsedModel ? getParsedModel() : null;
    if (PModel) {
      await PModel.updateMany(
        { scrip: String(scrip) },
        { $set: {
          "credibility.revenueHitRate": finalMetrics.revenue.hitRate,
          "credibility.ebitdaHitRate":  finalMetrics.ebitda.hitRate,
          "credibility.orderHitRate":   finalMetrics.orders.hitRate,
          "credibility.overallScore":   overallScore,
          "credibility.checkedAt":      Date.now()
        }}
      );
    }
  } catch(e) {
    // presentationParser model may not expose getModel — fine, skip
  }

  credMap.set(String(scrip), credDoc);
  console.log(`✅ Credibility: ${credDoc.company} score=${overallScore} (${label}) [${totalDataPoints} data pts]`);

  return credDoc;
}

// ── Batch recompute all companies that have guidance ─────────────────────────

async function batchRecompute(ioRef = null) {
  const allGuidance = getAllGuidance();
  console.log(`📊 Credibility recompute: ${allGuidance.length} companies`);

  const results = [];
  for (const g of allGuidance) {
    try {
      const doc = await recomputeCredibility(g.scrip, g.company);
      if (doc) {
        results.push(doc);
        if (ioRef) ioRef.emit("credibility_update", formatForClient(doc));
      }
      await new Promise(r => setTimeout(r, 100)); // light throttle
    } catch(err) {
      console.log(`⚠️ Credibility error ${g.company}: ${err.message}`);
    }
  }

  console.log(`✅ Credibility recompute done: ${results.length} companies scored`);
  return results;
}

// ── Load from Mongo on startup ────────────────────────────────────────────────

async function loadCacheFromMongo() {
  try {
    const Model = getCredModel();
    const docs  = await Model.find({}).sort({ updatedAt: -1 }).limit(500).lean();
    docs.forEach(d => credMap.set(String(d.scrip), d));
    console.log(`📊 Credibility cache loaded: ${docs.length} companies`);
  } catch (err) {
    console.log(`⚠️ Credibility cache load: ${err.message}`);
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

function getCredibilityForScrip(scrip) {
  return credMap.get(String(scrip)) || null;
}

function getAllCredibility() {
  return Array.from(credMap.values())
    .filter(c => c.overallScore !== null)
    .sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0));
}

function getTopCredible(limit = 20) {
  return getAllCredibility().slice(0, limit);
}

function getUnreliable(threshold = 40) {
  return getAllCredibility().filter(c => c.overallScore < threshold);
}

// ── Format for client ─────────────────────────────────────────────────────────
function formatForClient(doc) {
  if (!doc) return null;
  return {
    scrip:           doc.scrip,
    company:         doc.company,
    overallScore:    doc.overallScore,
    label:           doc.label,
    color:           doc.color,
    summary:         doc.summary,
    totalDataPoints: doc.totalDataPoints,
    updatedAt:       doc.updatedAt,
    metrics: {
      revenue: {
        hitRate:     doc.metrics?.revenue?.hitRate || 0,
        hits:        doc.metrics?.revenue?.hits || 0,
        promises:    doc.metrics?.revenue?.promises || 0,
        avgVariance: doc.metrics?.revenue?.avgVariance || 0
      },
      ebitda: {
        hitRate:     doc.metrics?.ebitda?.hitRate || 0,
        hits:        doc.metrics?.ebitda?.hits || 0,
        promises:    doc.metrics?.ebitda?.promises || 0,
        avgVariance: doc.metrics?.ebitda?.avgVariance || 0
      },
      orders: {
        hitRate:     doc.metrics?.orders?.hitRate || 0,
        hits:        doc.metrics?.orders?.hits || 0,
        promises:    doc.metrics?.orders?.promises || 0,
        avgVariance: doc.metrics?.orders?.avgVariance || 0
      },
      capex: {
        hitRate:     doc.metrics?.capex?.hitRate || 0,
        hits:        doc.metrics?.capex?.hits || 0,
        promises:    doc.metrics?.capex?.promises || 0,
        avgVariance: doc.metrics?.capex?.avgVariance || 0
      }
    },
    history: (doc.history || []).slice(-8)
  };
}

module.exports = {
  // Live hooks
  saveActualResult,
  extractActualsFromResultText,
  recomputeCredibility,

  // Batch
  batchRecompute,
  loadCacheFromMongo,

  // Queries
  getCredibilityForScrip,
  getAllCredibility,
  getTopCredible,
  getUnreliable,
  formatForClient,
};