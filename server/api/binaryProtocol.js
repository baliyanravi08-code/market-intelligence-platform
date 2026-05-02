"use strict";

/**
 * binaryProtocol.js — Zerodha-style binary WebSocket protocol
 *
 * WHY: JSON "{ symbol:'RELIANCE', ltp:2450.50, changePct:-0.74 }" = ~60 bytes
 *      Binary packed same data = 10 bytes → 83% smaller
 *
 * PACKET FORMAT (all values Big-Endian):
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Byte 0     │ Message type (uint8)                               │
 * │ Bytes 1-2  │ Packet length in bytes (uint16)                    │
 * │ Bytes 3+   │ Payload (type-specific)                            │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * MESSAGE TYPES:
 *   0x01  MARKET_TICK      — index prices (NIFTY/SENSEX/BANK NIFTY)
 *   0x02  LTP_TICK         — single stock LTP for chart rooms
 *   0x03  SCANNER_DIFF     — batch of changed scanner stocks
 *   0x04  SCANNER_SNAPSHOT — full scanner state on join
 *   0x05  CANDLE_TICK      — live candle update
 *   0x06  CANDLE_CLOSED    — candle boundary
 *   0x07  CIRCUIT_ALERT    — circuit hit/watchlist (JSON, rare)
 *   0x08  COMPOSITE_UPDATE — composite score update (JSON, rare)
 *   0x09  SYSTEM_EVENT     — heartbeat / status (JSON, rare)
 *   0x0A  UPSTOX_STATUS    — connection status (JSON, rare)
 *   0x0B  OPTIONS_INTEL    — option chain intelligence (JSON)
 *   0x0C  GANN_ANALYSIS    — gann analysis result (JSON)
 *   0xFF  JSON_FALLBACK    — any event not yet binary-encoded
 *
 * PRICE ENCODING:
 *   All prices stored as uint32, scaled ×100 (so 2450.50 → 245050)
 *   Max representable price: 42,949,672.95 — well above any Indian stock
 *
 * CHANGE% ENCODING:
 *   Signed int16, scaled ×100 (so -0.74% → -74, +5.32% → +532)
 *   Range: ±327.67% — covers all circuit scenarios
 *
 * SYMBOL ENCODING:
 *   1 byte length + raw ASCII bytes (max 20 chars)
 *   Indexed mode for scanner diff: 2-byte symbol index into snapshot table
 *
 * SCANNER DIFF STOCK (17 bytes fixed):
 *   uint16  symbol index  (2)
 *   uint32  ltp ×100      (4)
 *   int16   changePct ×100(2)
 *   int32   change ×100   (4)  (signed, can be negative)
 *   uint32  volume        (4)  (capped at ~4.29B — enough for any stock)
 *   int8    techScore     (1)
 *   ─────────────────────────
 *   17 bytes vs ~80 bytes JSON compressed → 79% smaller per stock
 *   500 stocks diff: 8.5KB vs 40KB
 */

// ── Message type constants ────────────────────────────────────────────────────
const MSG = {
  MARKET_TICK:      0x01,
  LTP_TICK:         0x02,
  SCANNER_DIFF:     0x03,
  SCANNER_SNAPSHOT: 0x04,
  CANDLE_TICK:      0x05,
  CANDLE_CLOSED:    0x06,
  CIRCUIT_ALERT:    0x07,
  COMPOSITE_UPDATE: 0x08,
  SYSTEM_EVENT:     0x09,
  UPSTOX_STATUS:    0x0A,
  OPTIONS_INTEL:    0x0B,
  GANN_ANALYSIS:    0x0C,
  JSON_FALLBACK:    0xFF,
};

// ── Index name → 1-byte ID ─────────────────────────────────────────────────
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

// ── Timeframe → 1-byte ID ──────────────────────────────────────────────────
const TF_ID = {
  "1min": 1, "5min": 2, "15min": 3, "30min": 4,
  "1hour": 5, "4hour": 6, "1day": 7, "1week": 8, "1month": 9,
};
const TF_ID_TO_NAME = Object.fromEntries(Object.entries(TF_ID).map(([k, v]) => [v, k]));

// ── Symbol table for scanner (shared server+client) ───────────────────────────
// Symbol → uint16 index, built once per scanner snapshot.
// Diff packets reference symbols by index (2 bytes) not string (8-20 bytes).
let _symbolTable    = [];          // index → symbol string
let _symbolToIndex  = new Map();   // symbol → index

function buildSymbolTable(stocks) {
  _symbolTable   = stocks.map(s => s.symbol || s.s).filter(Boolean);
  _symbolToIndex = new Map(_symbolTable.map((sym, i) => [sym, i]));
}

function getSymbolIndex(symbol) {
  return _symbolToIndex.get(symbol);
}

// ── Helpers ────────────────────────────────────────────────────────────────
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

function writeHeader(buf, offset, msgType, payloadLen) {
  buf.writeUInt8(msgType, offset);
  buf.writeUInt16BE(payloadLen, offset + 1);
  return offset + 3;
}

// ── ENCODER: JS → Buffer ──────────────────────────────────────────────────

/**
 * Encode market-tick array (NIFTY, SENSEX, BANK NIFTY updates)
 * Each index: 1 byte ID + 4 bytes price + 2 bytes changePct + 1 byte up flag
 * = 8 bytes per index  (vs ~50 bytes JSON)
 *
 * Total for 3 indices: 3 + 3*8 = 27 bytes (vs ~150 bytes JSON)
 */
function encodeMarketTick(updates) {
  // Header(3) + per index: 1+4+2+1 = 8 bytes
  const count = updates.length;
  const buf   = Buffer.allocUnsafe(3 + count * 8);
  let off = writeHeader(buf, 0, MSG.MARKET_TICK, count * 8);

  for (const u of updates) {
    const id = INDEX_ID[u.name] || 0;
    buf.writeUInt8(id, off); off++;
    buf.writeUInt32BE(priceToUint32(u.raw || parseFloat(u.price?.replace(/,/g, "") || 0)), off); off += 4;
    buf.writeInt16BE(pctToInt16(parseFloat(u.pct)), off); off += 2;
    buf.writeUInt8(u.up ? 1 : 0, off); off++;
  }
  return buf;
}

/**
 * Encode single LTP tick for chart room
 * 3(header) + 1(sym_len) + N(sym) + 4(price) + 8(timestamp)
 */
function encodeLTPTick(symbol, price) {
  const symBuf = Buffer.from(symbol, "ascii");
  const len    = 1 + symBuf.length + 4 + 8;
  const buf    = Buffer.allocUnsafe(3 + len);
  let off = writeHeader(buf, 0, MSG.LTP_TICK, len);
  buf.writeUInt8(symBuf.length, off); off++;
  symBuf.copy(buf, off); off += symBuf.length;
  buf.writeUInt32BE(priceToUint32(price), off); off += 4;
  // timestamp as uint32 seconds (saves 4 bytes vs full ms uint64)
  buf.writeUInt32BE(Math.floor(Date.now() / 1000), off);
  return buf;
}

/**
 * Encode scanner diff — batch of changed stocks using symbol index
 * Each stock: 2(sym_idx) + 4(ltp) + 2(changePct) + 4(change) + 4(vol) + 1(score) = 17 bytes
 *
 * With 50 stocks changed: 3(header) + 2(count) + 50*17 = 855 bytes
 * vs JSON: 50 * ~80 bytes = 4000 bytes compressed → 79% savings
 */
function encodeScannerDiff(stocks) {
  const count  = stocks.length;
  const payload = 2 + count * 17; // 2 bytes count, 17 per stock
  const buf    = Buffer.allocUnsafe(3 + payload);
  let off = writeHeader(buf, 0, MSG.SCANNER_DIFF, payload);
  buf.writeUInt16BE(count, off); off += 2;

  for (const s of stocks) {
    const sym  = s.symbol || s.s || "";
    const idx  = _symbolToIndex.get(sym) ?? 0xFFFF;
    const ltp  = s.ltp ?? s.l ?? 0;
    const cpct = s.changePct ?? s.c ?? 0;
    const chng = s.change ?? s.ch ?? 0;
    const vol  = Math.min(s.volume ?? s.v ?? 0, 0xFFFFFFFF);
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

/**
 * Encode scanner snapshot — sends symbol table + full data as JSON (one time on join)
 * Symbol table is a compact JSON array: ["RELIANCE","TCS",...] — needed to decode diffs.
 * Full stock data piggy-backs as JSON since snapshot is one-time, not streaming.
 *
 * Format: 3(header) + 2(table_len) + N(symbol table JSON) + M(stocks JSON)
 */
function encodeScannerSnapshot(stocks) {
  // Build symbol table from this snapshot
  buildSymbolTable(stocks);

  const tableJson  = JSON.stringify(_symbolTable);
  const stocksJson = JSON.stringify(stocks);      // full objects, one time only
  const tableBuf   = Buffer.from(tableJson, "utf8");
  const stocksBuf  = Buffer.from(stocksJson, "utf8");
  const payload    = 2 + tableBuf.length + 4 + stocksBuf.length;
  const buf        = Buffer.allocUnsafe(3 + payload);
  let off = writeHeader(buf, 0, MSG.SCANNER_SNAPSHOT, payload);
  buf.writeUInt16BE(tableBuf.length, off); off += 2;
  tableBuf.copy(buf, off); off += tableBuf.length;
  buf.writeUInt32BE(stocksBuf.length, off); off += 4;
  stocksBuf.copy(buf, off);
  return buf;
}

/**
 * Encode candle tick/closed
 * 3(header) + 1(sym_len) + N(sym) + 1(tf_id) + 8(time) + 4(open) + 4(high) + 4(low) + 4(close) + 4(vol)
 */
function encodeCandle(msgType, symbol, tf, candle) {
  const symBuf = Buffer.from(symbol, "ascii");
  const len    = 1 + symBuf.length + 1 + 8 + 4 + 4 + 4 + 4 + 4;
  const buf    = Buffer.allocUnsafe(3 + len);
  let off = writeHeader(buf, 0, msgType, len);
  buf.writeUInt8(symBuf.length, off); off++;
  symBuf.copy(buf, off); off += symBuf.length;
  buf.writeUInt8(TF_ID[tf] || 0, off); off++;
  // timestamp: write as two uint32 (ms doesn't fit uint32, use seconds + ms_remainder)
  const tsMs   = candle.time || Date.now();
  const tsSec  = Math.floor(tsMs / 1000);
  const tsMs16 = tsMs % 1000;
  buf.writeUInt32BE(tsSec, off); off += 4;
  buf.writeUInt32BE(tsMs16, off); off += 4;
  buf.writeUInt32BE(priceToUint32(candle.open),  off); off += 4;
  buf.writeUInt32BE(priceToUint32(candle.high),  off); off += 4;
  buf.writeUInt32BE(priceToUint32(candle.low),   off); off += 4;
  buf.writeUInt32BE(priceToUint32(candle.close), off); off += 4;
  buf.writeUInt32BE(Math.min(candle.volume || 0, 0xFFFFFFFF) >>> 0, off);
  return buf;
}

/**
 * JSON fallback — for rare/complex events (circuit alerts, gann, etc.)
 * 3(header) + 1(event_name_len) + N(event_name) + M(json_payload)
 */
function encodeJSON(eventName, data) {
  const nameBuf    = Buffer.from(eventName, "ascii");
  const payloadBuf = Buffer.from(JSON.stringify(data), "utf8");
  const len        = 1 + nameBuf.length + payloadBuf.length;
  const buf        = Buffer.allocUnsafe(3 + len);
  let off = writeHeader(buf, 0, MSG.JSON_FALLBACK, len);
  buf.writeUInt8(nameBuf.length, off); off++;
  nameBuf.copy(buf, off); off += nameBuf.length;
  payloadBuf.copy(buf, off);
  return buf;
}

// ── DECODER: Buffer → JS (for client-side use reference) ────────────────────
function decode(buffer) {
  const buf     = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const msgType = buf.readUInt8(0);
  // const len  = buf.readUInt16BE(1); // payload length — available if needed
  let off = 3;

  switch (msgType) {
    case MSG.MARKET_TICK: {
      const updates = [];
      while (off < buf.length) {
        const id        = buf.readUInt8(off); off++;
        const rawPrice  = buf.readUInt32BE(off) / 100; off += 4;
        const pct       = buf.readInt16BE(off) / 100; off += 2;
        const up        = buf.readUInt8(off) === 1; off++;
        const name      = INDEX_ID_TO_NAME[id] || `IDX_${id}`;
        const diff      = parseFloat((pct * rawPrice / 100).toFixed(2));
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
      const ts     = buf.readUInt32BE(off) * 1000; // back to ms
      return { type: "ltp", data: { s: symbol, p: price, t: ts } };
    }

    case MSG.SCANNER_DIFF: {
      const count  = buf.readUInt16BE(off); off += 2;
      const stocks = [];
      for (let i = 0; i < count; i++) {
        const idx     = buf.readUInt16BE(off); off += 2;
        const ltp     = buf.readUInt32BE(off) / 100; off += 4;
        const cpct    = buf.readInt16BE(off) / 100; off += 2;
        const change  = buf.readInt32BE(off) / 100; off += 4;
        const volume  = buf.readUInt32BE(off); off += 4;
        const score   = buf.readInt8(off); off++;
        const symbol  = _symbolTable[idx] || `SYM_${idx}`;
        stocks.push({ symbol, ltp, changePct: cpct, change, volume, techScore: score });
      }
      return { type: "scanner:diff", data: stocks };
    }

    case MSG.SCANNER_SNAPSHOT: {
      const tableLen  = buf.readUInt16BE(off); off += 2;
      const tableJson = buf.slice(off, off + tableLen).toString("utf8"); off += tableLen;
      _symbolTable    = JSON.parse(tableJson);
      _symbolToIndex  = new Map(_symbolTable.map((s, i) => [s, i]));
      const stocksLen = buf.readUInt32BE(off); off += 4;
      const stocks    = JSON.parse(buf.slice(off, off + stocksLen).toString("utf8"));
      return { type: "scanner:snapshot", data: stocks };
    }

    case MSG.CANDLE_TICK:
    case MSG.CANDLE_CLOSED: {
      const symLen  = buf.readUInt8(off); off++;
      const symbol  = buf.slice(off, off + symLen).toString("ascii"); off += symLen;
      const tfId    = buf.readUInt8(off); off++;
      const tf      = TF_ID_TO_NAME[tfId] || "1min";
      const tsSec   = buf.readUInt32BE(off); off += 4;
      const tsMs16  = buf.readUInt32BE(off); off += 4;
      const time    = tsSec * 1000 + tsMs16;
      const open    = buf.readUInt32BE(off) / 100; off += 4;
      const high    = buf.readUInt32BE(off) / 100; off += 4;
      const low     = buf.readUInt32BE(off) / 100; off += 4;
      const close   = buf.readUInt32BE(off) / 100; off += 4;
      const volume  = buf.readUInt32BE(off);
      const type    = msgType === MSG.CANDLE_TICK ? "candle:tick" : "candle:closed";
      return { type, data: { symbol, tf, candle: { time, open, high, low, close, volume } } };
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

// ── SIZE STATS (for logging/debugging) ────────────────────────────────────────
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
  // Encoders (server-side)
  encodeMarketTick,
  encodeLTPTick,
  encodeScannerDiff,
  encodeScannerSnapshot,
  encodeCandle,
  encodeJSON,
  // Decoder (shared server+client)
  decode,
  // Symbol table
  buildSymbolTable,
  getSymbolIndex,
  // Debug
  stats,
};