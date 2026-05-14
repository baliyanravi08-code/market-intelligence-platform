"use strict";

/**
 * server/api/binaryProtocol.js
 *
 * FIX 1: writeHeader writes 5 bytes (1 type + 4 length uint32)
 * FIX 2: encodeScannerSnapshot uses uint32 for table length
 * FIX 3: all decoders start at off=5 to match header size
 * FIX 4: encodeOptionsIntelTick added (MSG 0x0D)
 *
 * FIX 5 (NEW): OPTIONS_INTEL_TICK (0x0D) frame now includes stranglePrice + ts.
 *   Was: symbol + spotPrice + straddlePrice + atmIV + score + bias  (~40B)
 *   Now: symbol + spotPrice + straddlePrice + stranglePrice + atmIV + score + bias + tsSec (~44B)
 *
 *   stranglePrice: uint32 (/100) — real OTM strangle premium, distinct from straddle.
 *   tsSec:         int32 — Unix epoch seconds from NSE cache timestamp.
 *                  0 = not available. Frontend multiplies by 1000 for Date constructor.
 *                  Lets the chart plot at the correct IST market-hours position.
 *
 * BACKWARD COMPATIBILITY:
 *   Old decoder (4 bytes shorter) will read garbage for the last 8 bytes —
 *   but since you control both ends, deploy both files together. The decoder
 *   below checks buf.length before reading optional fields so it degrades
 *   gracefully if only the encoder is updated first.
 */

const MSG = {
  MARKET_TICK:         0x01,
  LTP_TICK:            0x02,
  SCANNER_DIFF:        0x03,
  SCANNER_SNAPSHOT:    0x04,
  CANDLE_TICK:         0x05,
  CANDLE_CLOSED:       0x06,
  CIRCUIT_ALERT:       0x07,
  COMPOSITE_UPDATE:    0x08,
  SYSTEM_EVENT:        0x09,
  UPSTOX_STATUS:       0x0A,
  OPTIONS_INTEL:       0x0B,
  GANN_ANALYSIS:       0x0C,
  OPTIONS_INTEL_TICK:  0x0D,   // live spot+straddle+strangle tick, ~44B vs ~220B JSON
  JSON_FALLBACK:       0xFF,
};

const INDEX_ID = {
  "NIFTY 50":   0x01,
  "SENSEX":     0x02,
  "BANK NIFTY": 0x03,
  "BTC":        0x04,
  "GOLD":       0x05,
  "SILVER":     0x06,
  "PI":         0x07,
};
const INDEX_ID_TO_NAME = Object.fromEntries(Object.entries(INDEX_ID).map(([k, v]) => [v, k]));

const TF_ID = {
  "1min": 1, "5min": 2, "15min": 3, "30min": 4,
  "1hour": 5, "4hour": 6, "1day": 7, "1week": 8, "1month": 9,
};
const TF_ID_TO_NAME = Object.fromEntries(Object.entries(TF_ID).map(([k, v]) => [v, k]));

let _symbolTable   = [];
let _symbolToIndex = new Map();

function buildSymbolTable(stocks) {
  _symbolTable   = stocks.map(s => s.symbol || s.s).filter(Boolean);
  _symbolToIndex = new Map(_symbolTable.map((sym, i) => [sym, i]));
}

function getSymbolIndex(symbol) {
  return _symbolToIndex.get(symbol);
}

function priceToUint32(price) {
  return Math.round((price || 0) * 100) & 0xFFFFFFFF;
}

function pctToInt16(pct) {
  const v = Math.round((pct || 0) * 100);
  return Math.max(-32768, Math.min(32767, v));
}

function changeToInt32(change) {
  return Math.round((change || 0) * 100);
}

// 1 byte type + 4 bytes uint32 length = 5 bytes total
function writeHeader(buf, offset, msgType, payloadLen) {
  buf.writeUInt8(msgType, offset);
  buf.writeUInt32BE(payloadLen, offset + 1);
  return offset + 5;
}

// ── MARKET TICK ───────────────────────────────────────────────────────────────
function encodeMarketTick(updates) {
  const count = updates.length;
  const buf   = Buffer.allocUnsafe(5 + count * 8);
  let off = writeHeader(buf, 0, MSG.MARKET_TICK, count * 8);

  for (const u of updates) {
    const id    = INDEX_ID[u.name] || 0;
    const price = u.raw || parseFloat((u.price || "0").toString().replace(/,/g, "")) || 0;
    const pct   = parseFloat((u.pct || "0").toString().replace(/[+%]/g, "")) || 0;
    buf.writeUInt8(id, off); off++;
    buf.writeUInt32BE(priceToUint32(price), off); off += 4;
    buf.writeInt16BE(pctToInt16(pct), off); off += 2;
    buf.writeUInt8(u.up ? 1 : 0, off); off++;
  }
  return buf;
}

// ── LTP TICK ──────────────────────────────────────────────────────────────────
function encodeLTPTick(symbol, price) {
  const symBuf = Buffer.from(symbol, "ascii");
  const len    = 1 + symBuf.length + 4 + 4;
  const buf    = Buffer.allocUnsafe(5 + len);
  let off = writeHeader(buf, 0, MSG.LTP_TICK, len);
  buf.writeUInt8(symBuf.length, off); off++;
  symBuf.copy(buf, off); off += symBuf.length;
  buf.writeUInt32BE(priceToUint32(price), off); off += 4;
  buf.writeUInt32BE(Math.floor(Date.now() / 1000), off);
  return buf;
}

// ── SCANNER DIFF ──────────────────────────────────────────────────────────────
function encodeScannerDiff(stocks) {
  const count   = stocks.length;
  const payload = 2 + count * 17;
  const buf     = Buffer.allocUnsafe(5 + payload);
  let off = writeHeader(buf, 0, MSG.SCANNER_DIFF, payload);
  buf.writeUInt16BE(count, off); off += 2;

  for (const s of stocks) {
    const sym  = s.symbol || s.s || "";
    const idx  = _symbolToIndex.get(sym) ?? 0xFFFF;
    const ltp  = s.ltp  ?? s.l  ?? 0;
    const cpct = s.changePct ?? s.c  ?? 0;
    const chng = s.change    ?? s.ch ?? 0;
    const vol  = Math.min(s.volume   ?? s.v  ?? 0, 0xFFFFFFFF);
    const sc   = Math.max(-128, Math.min(127, s.techScore ?? s.sc ?? 0));

    buf.writeUInt16BE(idx, off); off += 2;
    buf.writeUInt32BE(priceToUint32(ltp), off); off += 4;
    buf.writeInt16BE(pctToInt16(cpct), off); off += 2;
    buf.writeInt32BE(changeToInt32(chng), off); off += 4;
    buf.writeUInt32BE(vol >>> 0, off); off += 4;
    buf.writeInt8(sc, off); off++;
  }
  return buf;
}

// ── SCANNER SNAPSHOT ──────────────────────────────────────────────────────────
function encodeScannerSnapshot(stocks) {
  buildSymbolTable(stocks);

  const tableJson  = JSON.stringify(_symbolTable);
  const stocksJson = JSON.stringify(stocks);
  const tableBuf   = Buffer.from(tableJson,  "utf8");
  const stocksBuf  = Buffer.from(stocksJson, "utf8");

  const payload = 4 + tableBuf.length + 4 + stocksBuf.length;
  const buf     = Buffer.allocUnsafe(5 + payload);
  let off = writeHeader(buf, 0, MSG.SCANNER_SNAPSHOT, payload);

  buf.writeUInt32BE(tableBuf.length, off); off += 4;
  tableBuf.copy(buf, off); off += tableBuf.length;
  buf.writeUInt32BE(stocksBuf.length, off); off += 4;
  stocksBuf.copy(buf, off);
  return buf;
}

// ── CANDLE ────────────────────────────────────────────────────────────────────
function encodeCandle(msgType, symbol, tf, candle) {
  const symBuf = Buffer.from(symbol, "ascii");
  const len    = 1 + symBuf.length + 1 + 8 + 4 + 4 + 4 + 4 + 4;
  const buf    = Buffer.allocUnsafe(5 + len);
  let off = writeHeader(buf, 0, msgType, len);
  buf.writeUInt8(symBuf.length, off); off++;
  symBuf.copy(buf, off); off += symBuf.length;
  buf.writeUInt8(TF_ID[tf] || 0, off); off++;
  const tsMs  = candle.time || Date.now();
  const tsSec = Math.floor(tsMs / 1000);
  const tsRem = tsMs % 1000;
  buf.writeUInt32BE(tsSec, off); off += 4;
  buf.writeUInt32BE(tsRem, off); off += 4;
  buf.writeUInt32BE(priceToUint32(candle.open),  off); off += 4;
  buf.writeUInt32BE(priceToUint32(candle.high),  off); off += 4;
  buf.writeUInt32BE(priceToUint32(candle.low),   off); off += 4;
  buf.writeUInt32BE(priceToUint32(candle.close), off); off += 4;
  buf.writeUInt32BE(Math.min(candle.volume || 0, 0xFFFFFFFF) >>> 0, off);
  return buf;
}

// ── OPTIONS INTEL (full analysis, 60s cycle) ──────────────────────────────────
function encodeOptionsIntel(data) {
  const sym    = Buffer.from((data.symbol || "NIFTY"), "ascii");
  const expiry = Buffer.from((data.expiry  || ""), "ascii");
  const s      = data.structure || {};
  const g      = data.atmGreeks || {};
  const v      = data.volatility || {};
  const oi     = data.oi || {};

  // Added 8 bytes for totalCallOI + totalPutOI (2 × uint32)
  const len = 1 + sym.length + 1 + expiry.length + (4 * 9) + (2 * 4);
  const buf = Buffer.allocUnsafe(5 + len);
  let off = writeHeader(buf, 0, MSG.OPTIONS_INTEL, len);

  buf.writeUInt8(sym.length, off); off++;
  sym.copy(buf, off); off += sym.length;
  buf.writeUInt8(expiry.length, off); off++;
  expiry.copy(buf, off); off += expiry.length;

  buf.writeUInt32BE(priceToUint32(data.spotPrice                    || 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(s.atmStrike                       || 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(s.straddlePrice                   || 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(s.stranglePrice || s.straddlePrice|| 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(s.callLTP                         || 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(s.putLTP                          || 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(v.atmIV                           || 0), off); off += 4;
  // NEW: totalCallOI + totalPutOI encoded as uint32 (OI in lots, max ~42M fits)
  buf.writeUInt32BE(Math.min(oi.totalCallOI || 0, 0xFFFFFFFF) >>> 0, off); off += 4;
  buf.writeUInt32BE(Math.min(oi.totalPutOI  || 0, 0xFFFFFFFF) >>> 0, off); off += 4;
  buf.writeInt16BE(Math.round((oi.pcr                               || 0) * 100), off); off += 2;
  buf.writeInt16BE(pctToInt16(g.theta                               || 0), off); off += 2;
  buf.writeInt16BE(pctToInt16(g.delta                               || 0), off); off += 2;
  buf.writeInt16BE(pctToInt16(g.vega                                || 0), off); off += 2;

  return buf;
}

// ── OPTIONS INTEL TICK (live spot+straddle update, ~1s, ~44B) ────────────────
//
// FIX 5: Frame now includes stranglePrice (uint32) and tsSec (int32).
//
// Frame layout (after 5-byte header):
//   1B  symLen
//   NB  symbol (ascii)
//   4B  spotPrice     (uint32, /100)
//   4B  straddlePrice (uint32, /100)
//   4B  stranglePrice (uint32, /100)  ← NEW (was missing, straddle=strangle bug)
//   4B  atmIV         (uint32, /100)
//   1B  score         (uint8, 0-100)
//   1B  biasLen
//   NB  bias          (ascii, e.g. "BULLISH", max 12 chars)
//   4B  tsSec         (int32, Unix epoch seconds, 0=unavailable) ← NEW (chart X axis)
//
// Total for NIFTY: 5 + 1+5 + 4+4+4+4 + 1+1+7 + 4 = ~44B vs ~220B JSON = 80% saving
function encodeOptionsIntelTick(symbol, spotPrice, straddlePrice, atmIV, score, bias, stranglePrice, ts, totalCallOI, totalPutOI, pcr) {
  const symBuf  = Buffer.from((symbol || "NIFTY").slice(0, 20), "ascii");
  const biasBuf = Buffer.from((bias   || "NEUTRAL").slice(0, 12), "ascii");

  // +10 bytes: totalCallOI(4) + totalPutOI(4) + pcr(2)
  const len = 1 + symBuf.length + 4 + 4 + 4 + 4 + 1 + 1 + biasBuf.length + 4 + 4 + 4 + 2;
  const buf = Buffer.allocUnsafe(5 + len);
  let off = writeHeader(buf, 0, MSG.OPTIONS_INTEL_TICK, len);

  buf.writeUInt8(symBuf.length, off); off++;
  symBuf.copy(buf, off); off += symBuf.length;

  buf.writeUInt32BE(priceToUint32(spotPrice     || 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(straddlePrice || 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(stranglePrice || 0), off); off += 4;
  buf.writeUInt32BE(priceToUint32(atmIV         || 0), off); off += 4;

  buf.writeUInt8(Math.max(0, Math.min(100, Math.round(score || 50))), off); off++;
  buf.writeUInt8(biasBuf.length, off); off++;
  biasBuf.copy(buf, off); off += biasBuf.length;

  const tsSec = ts
    ? (typeof ts === "number" ? Math.floor(ts / 1000) : Math.floor(new Date(ts).getTime() / 1000))
    : 0;
  buf.writeUInt32BE(tsSec > 0 ? tsSec : 0, off); off += 4;

  // Live OI fields — 1s update frequency
  buf.writeUInt32BE(Math.min(totalCallOI || 0, 0xFFFFFFFF) >>> 0, off); off += 4;
  buf.writeUInt32BE(Math.min(totalPutOI  || 0, 0xFFFFFFFF) >>> 0, off); off += 4;
  buf.writeInt16BE(Math.round((pcr ?? 0) * 100), off);

  return buf;
}

// ── JSON FALLBACK ─────────────────────────────────────────────────────────────
function encodeJSON(eventName, data) {
  const nameBuf    = Buffer.from(eventName, "ascii");
  const payloadBuf = Buffer.from(JSON.stringify(data), "utf8");
  const len        = 1 + nameBuf.length + payloadBuf.length;
  const buf        = Buffer.allocUnsafe(5 + len);
  let off = writeHeader(buf, 0, MSG.JSON_FALLBACK, len);
  buf.writeUInt8(nameBuf.length, off); off++;
  nameBuf.copy(buf, off); off += nameBuf.length;
  payloadBuf.copy(buf, off);
  return buf;
}

// ── DECODER ───────────────────────────────────────────────────────────────────
function decode(buffer) {
  const buf     = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const msgType = buf.readUInt8(0);
  let off = 5; // 1 type + 4 length

  switch (msgType) {
    case MSG.MARKET_TICK: {
      const updates = [];
      while (off + 8 <= buf.length) {
        const id       = buf.readUInt8(off); off++;
        const rawPrice = buf.readUInt32BE(off) / 100; off += 4;
        const pct      = buf.readInt16BE(off) / 100; off += 2;
        const up       = buf.readUInt8(off) === 1; off++;
        const name     = INDEX_ID_TO_NAME[id] || `IDX_${id}`;
        const diff     = parseFloat((pct * rawPrice / 100).toFixed(2));
        updates.push({
          name,
          raw:    rawPrice,
          price:  rawPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
          pct:    (up ? "+" : "") + pct.toFixed(2) + "%",
          change: (up ? "+" : "") + diff.toFixed(2),
          up,
        });
      }
      return { type: "market-tick", data: updates };
    }

    case MSG.LTP_TICK: {
      const symLen = buf.readUInt8(off); off++;
      const symbol = buf.slice(off, off + symLen).toString("ascii"); off += symLen;
      const price  = buf.readUInt32BE(off) / 100; off += 4;
      const ts     = buf.readUInt32BE(off) * 1000;
      return { type: "ltp", data: { s: symbol, p: price, t: ts } };
    }

    case MSG.SCANNER_DIFF: {
      const count  = buf.readUInt16BE(off); off += 2;
      const stocks = [];
      for (let i = 0; i < count; i++) {
        const idx    = buf.readUInt16BE(off); off += 2;
        const ltp    = buf.readUInt32BE(off) / 100; off += 4;
        const cpct   = buf.readInt16BE(off) / 100; off += 2;
        const change = buf.readInt32BE(off) / 100; off += 4;
        const volume = buf.readUInt32BE(off); off += 4;
        const score  = buf.readInt8(off); off++;
        const symbol = _symbolTable[idx] || `SYM_${idx}`;
        stocks.push({ symbol, ltp, changePct: cpct, change, volume, techScore: score });
      }
      return { type: "scanner:diff", data: stocks };
    }

    case MSG.SCANNER_SNAPSHOT: {
      const tableLen  = buf.readUInt32BE(off); off += 4;
      const tableJson = buf.slice(off, off + tableLen).toString("utf8"); off += tableLen;
      _symbolTable    = JSON.parse(tableJson);
      _symbolToIndex  = new Map(_symbolTable.map((s, i) => [s, i]));
      const stocksLen = buf.readUInt32BE(off); off += 4;
      const stocks    = JSON.parse(buf.slice(off, off + stocksLen).toString("utf8"));
      return { type: "scanner:snapshot", data: stocks };
    }

    case MSG.CANDLE_TICK:
    case MSG.CANDLE_CLOSED: {
      const symLen = buf.readUInt8(off); off++;
      const symbol = buf.slice(off, off + symLen).toString("ascii"); off += symLen;
      const tfId   = buf.readUInt8(off); off++;
      const tf     = TF_ID_TO_NAME[tfId] || "1min";
      const tsSec  = buf.readUInt32BE(off); off += 4;
      const tsRem  = buf.readUInt32BE(off); off += 4;
      const time   = tsSec * 1000 + tsRem;
      const open   = buf.readUInt32BE(off) / 100; off += 4;
      const high   = buf.readUInt32BE(off) / 100; off += 4;
      const low    = buf.readUInt32BE(off) / 100; off += 4;
      const close  = buf.readUInt32BE(off) / 100; off += 4;
      const volume = buf.readUInt32BE(off);
      const type   = msgType === MSG.CANDLE_TICK ? "candle:tick" : "candle:closed";
      return { type, data: { symbol, tf, candle: { time, open, high, low, close, volume } } };
    }

    case MSG.OPTIONS_INTEL: {
      const symLen        = buf.readUInt8(off); off++;
      const symbol        = buf.slice(off, off + symLen).toString("ascii"); off += symLen;
      const expLen        = buf.readUInt8(off); off++;
      const expiry        = buf.slice(off, off + expLen).toString("ascii"); off += expLen;
      const spotPrice     = buf.readUInt32BE(off) / 100; off += 4;
      const atmStrike     = buf.readUInt32BE(off) / 100; off += 4;
      const straddlePrice = buf.readUInt32BE(off) / 100; off += 4;
      const stranglePrice = buf.readUInt32BE(off) / 100; off += 4;
      const callLTP       = buf.readUInt32BE(off) / 100; off += 4;
      const putLTP        = buf.readUInt32BE(off) / 100; off += 4;
      const atmIV         = buf.readUInt32BE(off) / 100; off += 4;
      const totalCallOI   = buf.readUInt32BE(off); off += 4;
      const totalPutOI    = buf.readUInt32BE(off); off += 4;
      const pcr           = buf.readInt16BE(off)  / 100; off += 2;
      const theta         = buf.readInt16BE(off)  / 100; off += 2;
      const delta         = buf.readInt16BE(off)  / 100; off += 2;
      const vega          = buf.readInt16BE(off)  / 100; off += 2;
      return {
        type: "options-intelligence",
        data: {
          symbol, expiry, spotPrice,
          structure:  { atmStrike, straddlePrice, stranglePrice, callLTP, putLTP },
          volatility: { atmIV },
          oi:         { pcr, totalCallOI, totalPutOI },
          atmGreeks:  { theta, delta, vega },
        },
      };
    }

    // FIX 5: decode OPTIONS_INTEL_TICK (0x0D) with stranglePrice + ts
    case MSG.OPTIONS_INTEL_TICK: {
      const symLen        = buf.readUInt8(off); off++;
      const symbol        = buf.slice(off, off + symLen).toString("ascii"); off += symLen;
      const spotPrice     = buf.readUInt32BE(off) / 100; off += 4;
      const straddlePrice = buf.readUInt32BE(off) / 100; off += 4;

      // FIX 5: read stranglePrice (NEW field — check length for backward compat)
      let stranglePrice = 0;
      if (off + 4 <= buf.length) {
        stranglePrice = buf.readUInt32BE(off) / 100; off += 4;
      }

      const atmIV   = off + 4 <= buf.length ? buf.readUInt32BE(off) / 100 : 0; off += 4;
      const score   = off + 1 <= buf.length ? buf.readUInt8(off) : 50; off++;
      const biasLen = off + 1 <= buf.length ? buf.readUInt8(off) : 0; off++;
      const bias    = biasLen > 0 && off + biasLen <= buf.length
        ? buf.slice(off, off + biasLen).toString("ascii")
        : "NEUTRAL";
      off += biasLen;

      let ts = null;
      if (off + 4 <= buf.length) {
        const tsSec = buf.readUInt32BE(off);
        if (tsSec > 0) ts = tsSec * 1000;
        off += 4;
      }

      const totalCallOI = off + 4 <= buf.length ? buf.readUInt32BE(off) : 0; off += 4;
      const totalPutOI  = off + 4 <= buf.length ? buf.readUInt32BE(off) : 0; off += 4;
      const pcr         = off + 2 <= buf.length ? buf.readInt16BE(off) / 100 : null;

      return {
        type: "options-intel-tick",
        data: { symbol, spotPrice, straddlePrice, stranglePrice, atmIV, score, bias, ts, totalCallOI, totalPutOI, pcr },
      };
    }

    case MSG.JSON_FALLBACK: {
      const nameLen   = buf.readUInt8(off); off++;
      const eventName = buf.slice(off, off + nameLen).toString("ascii"); off += nameLen;
      const data      = JSON.parse(buf.slice(off).toString("utf8"));
      return { type: eventName, data };
    }

    default:
      return { type: "unknown", msgType, data: null };
  }
}

function stats(label, jsonObj, binaryBuf) {
  const jsonSize   = Buffer.byteLength(JSON.stringify(jsonObj), "utf8");
  const binarySize = binaryBuf.length;
  const savings    = (((jsonSize - binarySize) / jsonSize) * 100).toFixed(1);
  console.log(`📦 [binary] ${label}: JSON=${jsonSize}B Binary=${binarySize}B Savings=${savings}%`);
}

module.exports = {
  MSG,
  INDEX_ID,
  TF_ID,
  encodeMarketTick,
  encodeLTPTick,
  encodeScannerDiff,
  encodeScannerSnapshot,
  encodeCandle,
  encodeJSON,
  encodeOptionsIntel,
  encodeOptionsIntelTick,
  decode,
  buildSymbolTable,
  getSymbolIndex,
  stats,
};