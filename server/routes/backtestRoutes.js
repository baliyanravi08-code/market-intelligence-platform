"use strict";

const express = require("express");
const router  = express.Router();
const engine  = require("../services/backtestEngine");

// GET /api/backtest/sessions
router.get("/sessions", (req, res) => {
  try { res.json(engine.getSessions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/backtest/signals?date=2026-04-22
router.get("/signals", (req, res) => {
  try { res.json(engine.getSessionSignals(req.query.date)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/backtest/analytics?days=30
router.get("/analytics", (req, res) => {
  try { res.json(engine.getAnalytics(parseInt(req.query.days) || 30)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/backtest/capture  body: { signals: [...] }
router.post("/capture", (req, res) => {
  try {
    const { signals } = req.body;
    if (!Array.isArray(signals) || !signals.length)
      return res.status(400).json({ error: "signals array required" });
    res.json(engine.captureSession(signals));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ FIX: POST /api/backtest/capture-now — frontend "Capture Now" button calls this
// Pulls latest signals directly from marketScanner (no body needed)
router.post("/capture-now", (req, res) => {
  try {
    let getScannerData;
    try {
      ({ getScannerData } = require("../services/intelligence/marketScanner"));
    } catch (e) {
      return res.status(500).json({ error: "marketScanner not available: " + e.message });
    }

    const scannerData = getScannerData();
    if (!scannerData || !scannerData.updatedAt) {
      return res.json({ success: false, error: "Scanner not ready yet — wait for first scan to complete" });
    }

    // Collect all signals from scanner output
    const signals = [];
    const seen    = new Set();

    const addSignal = (stock) => {
      const sym = (stock.symbol || stock.stock || "").toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      signals.push({
        symbol:     sym,
        signal:     stock.signal || stock.type || "BUY",
        price:      stock.ltp   || stock.price || stock.entry || 0,
        entry:      stock.ltp   || stock.price || stock.entry || 0,
        target:     stock.target    || stock.tp || 0,
        stopLoss:   stock.stopLoss  || stock.sl || 0,
        rsi:        stock.rsi       || 50,
        techScore:  stock.techScore || stock.score || stock.strength || 0,
        sector:     stock.sector    || stock.industry || "Unknown",
        macd:       stock.macd      || null,
        isSwing:    !!(stock.isSwing || (stock.signal || "").toLowerCase().includes("swing")),
      });
    };

    // Pull from all scanner buckets
    (scannerData.gainers  || []).forEach(addSignal);
    (scannerData.losers   || []).forEach(addSignal);
    Object.values(scannerData.byMcap || {}).forEach(arr => arr.forEach(addSignal));

    if (!signals.length) {
      return res.json({ success: false, error: "No signals found in scanner data right now" });
    }

    const result = engine.captureSession(signals);
    res.json({ ...result, count: result.count || signals.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/backtest/resolve  body: { signalId, result: "WIN"|"LOSS", exitPrice }
router.post("/resolve", (req, res) => {
  try {
    const { signalId, result, exitPrice } = req.body;
    if (!signalId || !result)
      return res.status(400).json({ error: "signalId and result required" });
    res.json(engine.manualResolve(signalId, result, parseFloat(exitPrice)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;