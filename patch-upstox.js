/**
 * patch-upstox.js
 * Patches the upstox-js-sdk Streamer.js to guard against
 * "clearSubscriptions is not a function" crash on reconnect.
 *
 * Add to package.json scripts:
 *   "postinstall": "node patch-upstox.js"
 */

const fs   = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "node_modules", "upstox-js-sdk", "dist", "feeder", "Streamer.js");

if (!fs.existsSync(filePath)) {
  console.log("patch-upstox: Streamer.js not found — skipping (SDK may not be installed yet)");
  process.exit(0);
}

let code = fs.readFileSync(filePath, "utf8");

const BAD  = "this.streamer.clearSubscriptions();";
const GOOD = "if (typeof this.streamer.clearSubscriptions === 'function') { this.streamer.clearSubscriptions(); }";

if (code.includes(GOOD)) {
  console.log("patch-upstox: already patched — nothing to do ✅");
  process.exit(0);
}

if (!code.includes(BAD)) {
  console.log("patch-upstox: target line not found — SDK version may differ, skipping");
  process.exit(0);
}

const patched = code.replaceAll(BAD, GOOD);
fs.writeFileSync(filePath, patched, "utf8");
console.log("patch-upstox: ✅ Streamer.js patched successfully");