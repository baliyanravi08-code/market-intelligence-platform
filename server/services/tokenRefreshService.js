/**
 * ============================================================
 * AUTO TOKEN REFRESH SERVICE
 * Location: server/services/tokenRefreshService.js
 * ============================================================
 *
 * This works WITH your existing server.js — no rewrites needed.
 * It adds:
 *   1. /auth/upstox/refresh  → one-click daily token refresh
 *   2. Token stored in MongoDB (survives Render restarts)
 *   3. Daily 8:30 AM IST reminder log
 *   4. getLatestToken() used by server.js & upstoxStream.js
 */

const axios    = require("axios");
const mongoose = require("mongoose");
const fs       = require("fs");
const path     = require("path");

// ─── Mongoose schema ──────────────────────────────────────────────────────────
const tokenSchema = new mongoose.Schema({
  service:     { type: String, default: "upstox" },
  accessToken: { type: String, required: true },
  savedAt:     { type: Date, default: Date.now },
  expiresAt:   { type: Date },
});
const UpstoxToken = mongoose.models.UpstoxToken
  || mongoose.model("UpstoxToken", tokenSchema);

// ─── Save token to MongoDB AND to disk (double backup) ────────────────────────
async function saveToken(token) {
  // 1. Save to MongoDB
  try {
    const expiresAt = new Date();
    expiresAt.setHours(23, 59, 59, 0); // expires end of today IST
    await UpstoxToken.findOneAndUpdate(
      { service: "upstox" },
      { accessToken: token, savedAt: new Date(), expiresAt },
      { upsert: true, new: true }
    );
    console.log("[TokenRefresh] ✅ Token saved to MongoDB");
  } catch (e) {
    console.warn("[TokenRefresh] ⚠️ MongoDB save failed:", e.message);
  }

  // 2. Save to disk as backup (same path server.js uses)
  try {
    const TOKEN_FILE = path.join(__dirname, "../data/upstox_token.json");
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const expiry = Date.now() + 23 * 60 * 60 * 1000; // 23 hours
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expiry }), "utf8");
    console.log("[TokenRefresh] ✅ Token saved to disk");
  } catch (e) {
    console.warn("[TokenRefresh] ⚠️ Disk save failed:", e.message);
  }

  // 3. Update in-memory env for current process
  process.env.UPSTOX_ACCESS_TOKEN = token;
}

// ─── Load latest token (MongoDB → disk → env) ─────────────────────────────────
async function getLatestToken() {
  // 1. Try MongoDB first (most up to date)
  try {
    const doc = await UpstoxToken.findOne({ service: "upstox" });
    if (doc && doc.accessToken && new Date() < doc.expiresAt) {
      return doc.accessToken;
    }
  } catch (e) {
    console.warn("[TokenRefresh] MongoDB read failed:", e.message);
  }

  // 2. Try disk
  try {
    const TOKEN_FILE = path.join(__dirname, "../data/upstox_token.json");
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (saved.token && saved.expiry && Date.now() < saved.expiry) {
        return saved.token;
      }
    }
  } catch (e) { /* skip */ }

  // 3. Fall back to env (Analytics token — works for historical data)
  return process.env.UPSTOX_ANALYTICS_TOKEN
      || process.env.UPSTOX_ACCESS_TOKEN
      || null;
}

// ─── Exchange auth code → access token ───────────────────────────────────────
async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    code,
    client_id:     process.env.UPSTOX_API_KEY,
    client_secret: process.env.UPSTOX_API_SECRET,
    redirect_uri:  process.env.UPSTOX_REDIRECT_URI,
    grant_type:    "authorization_code",
  });

  const response = await axios.post(
    "https://api.upstox.com/v2/login/authorization/token",
    params,
    { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } }
  );

  const token = response.data.access_token;
  await saveToken(token);
  return token;
}

// ─── Express router ───────────────────────────────────────────────────────────
const express = require("express");
const router  = express.Router();

// Daily login URL — visit this each morning to refresh token
router.get("/refresh", (req, res) => {
  const authUrl =
    "https://api.upstox.com/v2/login/authorization/dialog" +
    "?response_type=code&client_id=" + process.env.UPSTOX_API_KEY +
    "&redirect_uri=" + encodeURIComponent(process.env.UPSTOX_REDIRECT_URI);
  res.redirect(authUrl);
});

// Upstox redirects here after login — auto saves token
router.get("/refresh/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("ERR: No auth code.");

  try {
    const token = await exchangeCodeForToken(code);

    // Hot-reload into running services (no restart needed)
    try {
      const stream = require("./upstoxStream");
      const io     = req.app.get("io");
      stream.startStreamer(token, io);
    } catch (e) { /* ok if stream not running */ }

    try {
      const { setToken } = require("./intelligence/indexCandleFetcher");
      setToken(token);
    } catch (e) { /* ok */ }

    res.send(`
      <html><body style="background:#010812;color:#00ff9c;font-family:monospace;padding:40px;text-align:center">
        <h2>✅ Token Refreshed!</h2>
        <p style="color:#b8cfe8">New Algo Trading token saved to MongoDB + disk.</p>
        <p style="color:#4a8adf">Live prices, charts & WebSocket now active.</p>
        <br>
        <a href="/" style="color:#00cfff;text-decoration:none;border:1px solid #00cfff33;padding:8px 16px;border-radius:4px">
          Back to Dashboard
        </a>
      </body></html>
    `);
  } catch (e) {
    console.error("[TokenRefresh] ❌ Exchange failed:", e.response?.data || e.message);
    res.send("ERR: " + (e.response?.data?.message || e.message));
  }
});

// Token status check
router.get("/token-status", async (req, res) => {
  try {
    const doc = await UpstoxToken.findOne({ service: "upstox" });
    if (!doc) return res.json({ status: "no_token", hint: "Visit /auth/upstox/refresh" });
    const expired = new Date() > doc.expiresAt;
    res.json({
      status:      expired ? "expired" : "valid",
      savedAt:     doc.savedAt,
      expiresAt:   doc.expiresAt,
      preview:     doc.accessToken.substring(0, 25) + "...",
    });
  } catch (e) {
    res.json({ status: "error", message: e.message });
  }
});

// ─── Daily scheduler — logs reminder at 8:30 AM IST (03:00 UTC) ──────────────
function scheduleDailyCheck() {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(3, 0, 0, 0); // 8:30 AM IST
  if (next <= now) next.setDate(next.getDate() + 1);

  const ms = next - now;
  console.log(`[TokenRefresh] Next daily check in ${Math.round(ms / 60000)} min`);

  setTimeout(async () => {
    const token = await getLatestToken();
    if (!token) {
      console.log("[TokenRefresh] ⚠️  NO VALID TOKEN — Visit your-app.onrender.com/auth/upstox/refresh");
    } else {
      console.log("[TokenRefresh] ✅ Token valid at market open");
    }
    scheduleDailyCheck(); // reschedule for tomorrow
  }, ms);
}

module.exports = { router, getLatestToken, saveToken, scheduleDailyCheck };