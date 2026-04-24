#!/usr/bin/env node
/**
 * fix-upstox-sdk.js
 * Location: server/patches/fix-upstox-sdk.js
 *
 * Patches the upstox-js-sdk Streamer.js to add a no-op clearSubscriptions()
 * on the internal WebSocket object before attemptReconnect calls it.
 *
 * Run via package.json postinstall:
 *   "postinstall": "node server/patches/fix-upstox-sdk.js"
 */

const fs   = require("fs");
const path = require("path");

const streamerPath = path.join(
  __dirname, "../../node_modules/upstox-js-sdk/dist/feeder/Streamer.js"
);

if (!fs.existsSync(streamerPath)) {
  console.log("⚠️  patch: Streamer.js not found, skipping");
  process.exit(0);
}

let src = fs.readFileSync(streamerPath, "utf8");

// Check if already patched
if (src.includes("__patched_clearSubscriptions__")) {
  console.log("✅ patch: Streamer.js already patched");
  process.exit(0);
}

// The crash line is:  this.streamer.clearSubscriptions();
// We replace it with a safe call
const crashLine = "this.streamer.clearSubscriptions();";
const safeLine  = "if (typeof this.streamer.clearSubscriptions === 'function') { this.streamer.clearSubscriptions(); } // __patched_clearSubscriptions__";

if (!src.includes(crashLine)) {
  console.log("⚠️  patch: crash line not found — SDK version may differ, trying broader patch...");

  // Try to find attemptReconnect and wrap the whole function body safely
  const reconnectMatch = src.match(/attemptReconnect\s*\([^)]*\)\s*\{[\s\S]*?\}/);
  if (reconnectMatch) {
    const original = reconnectMatch[0];
    const patched  = original.replace(
      /this\.streamer\.clearSubscriptions\(\)/g,
      "if (typeof this.streamer.clearSubscriptions === 'function') { this.streamer.clearSubscriptions(); } // __patched_clearSubscriptions__"
    );
    src = src.replace(original, patched);
    fs.writeFileSync(streamerPath, src, "utf8");
    console.log("✅ patch: Streamer.js patched via broad match");
  } else {
    console.log("❌ patch: could not find attemptReconnect — manual fix needed");
  }
  process.exit(0);
}

src = src.replace(crashLine, safeLine);
fs.writeFileSync(streamerPath, src, "utf8");
console.log("✅ patch: Streamer.js patched — clearSubscriptions crash fixed");