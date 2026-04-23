/**
 * backtestRoutes.js
 * Location: server/routes/backtestRoutes.js   ← NEW FILE
 *
 * Mount in server.js:
 *   const backtestRoutes = require("./routes/backtestRoutes");
 *   app.use("/api/backtest", backtestRoutes);
 */

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