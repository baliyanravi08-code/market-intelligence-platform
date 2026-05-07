/**
 * client/src/utils/binaryProtocol.js
 *
 * FIX 1: header is now 5 bytes (1 type + 4 length uint32) — off starts at 5
 * FIX 2: SCANNER_SNAPSHOT table length is uint32 (was uint16 — overflows 500+ stocks)
 */

export const MSG = {
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

const INDEX_ID_TO_NAME = {
  0x01: "NIFTY 50",
  0x02: "SENSEX",
  0x03: "BANK NIFTY",
  0x04: "BTC",
  0x05: "GOLD",
  0x06: "SILVER",
  0x07: "PI",
};

const TF_ID_TO_NAME = {
  1: "1min",  2: "5min",  3: "15min", 4: "30min",
  5: "1hour", 6: "4hour", 7: "1day",  8: "1week", 9: "1month",
};

let _symbolTable = [];

function readUInt8(dv, off)  { return dv.getUint8(off); }
function readUInt16(dv, off) { return dv.getUint16(off, false); }
function readUInt32(dv, off) { return dv.getUint32(off, false); }
function readInt16(dv, off)  { return dv.getInt16(off, false); }
function readInt32(dv, off)  { return dv.getInt32(off, false); }
function readInt8(dv, off)   { return dv.getInt8(off); }

function readAscii(dv, off, len) {
  let str = "";
  for (let i = 0; i < len; i++) str += String.fromCharCode(dv.getUint8(off + i));
  return str;
}

function readUtf8(buffer, off, len) {
  const slice = buffer.slice(off, off + len);
  return new TextDecoder("utf-8").decode(new Uint8Array(slice));
}

export function decode(arrayBuffer) {
  const dv      = new DataView(arrayBuffer);
  const msgType = readUInt8(dv, 0);
  // header = 1 byte type + 4 bytes uint32 length = 5 bytes total
  let off = 5; // ✅ FIX: was 3 (old uint16 header)

  switch (msgType) {

    case MSG.MARKET_TICK: {
      const updates = [];
      while (off < arrayBuffer.byteLength) {
        const id    = readUInt8(dv, off); off++;
        const price = readUInt32(dv, off) / 100; off += 4;
        const pct   = readInt16(dv, off) / 100; off += 2;
        const up    = readUInt8(dv, off) === 1; off++;
        const name  = INDEX_ID_TO_NAME[id] || `IDX_${id}`;
        const diff  = parseFloat((pct * price / 100).toFixed(2));
        updates.push({
          name,
          raw:    price,
          price:  price.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
          pct:    (up ? "+" : "") + pct.toFixed(2) + "%",
          change: (up ? "+" : "") + diff.toFixed(2),
          up,
          _ts:    Date.now(),
        });
      }
      return { type: "market-tick", data: updates };
    }

    case MSG.LTP_TICK: {
      const symLen = readUInt8(dv, off); off++;
      const symbol = readAscii(dv, off, symLen); off += symLen;
      const price  = readUInt32(dv, off) / 100; off += 4;
      const ts     = readUInt32(dv, off) * 1000;
      return { type: "ltp", data: { s: symbol, p: price, t: ts } };
    }

    case MSG.SCANNER_DIFF: {
      const count  = readUInt16(dv, off); off += 2;
      const stocks = [];
      for (let i = 0; i < count; i++) {
        const idx       = readUInt16(dv, off); off += 2;
        const ltp       = readUInt32(dv, off) / 100; off += 4;
        const changePct = readInt16(dv, off) / 100; off += 2;
        const change    = readInt32(dv, off) / 100; off += 4;
        const volume    = readUInt32(dv, off); off += 4;
        const score     = readInt8(dv, off); off++;
        const symbol    = _symbolTable[idx] || `SYM_${idx}`;
        stocks.push({ symbol, ltp, changePct, change, volume, techScore: score });
      }
      return { type: "scanner:diff", data: stocks };
    }

    case MSG.SCANNER_SNAPSHOT: {
      const tableLen  = readUInt32(dv, off); off += 4; // ✅ FIX: was readUInt16 + 2
      const tableJson = readUtf8(arrayBuffer, off, tableLen); off += tableLen;
      _symbolTable    = JSON.parse(tableJson);
      const stocksLen = readUInt32(dv, off); off += 4;
      const stocks    = JSON.parse(readUtf8(arrayBuffer, off, stocksLen));
      return { type: "scanner:snapshot", data: stocks };
    }

    case MSG.CANDLE_TICK:
    case MSG.CANDLE_CLOSED: {
      const symLen = readUInt8(dv, off); off++;
      const symbol = readAscii(dv, off, symLen); off += symLen;
      const tfId   = readUInt8(dv, off); off++;
      const tf     = TF_ID_TO_NAME[tfId] || "1min";
      const tsSec  = readUInt32(dv, off); off += 4;
      const tsRem  = readUInt32(dv, off); off += 4;
      const time   = tsSec * 1000 + tsRem;
      const open   = readUInt32(dv, off) / 100; off += 4;
      const high   = readUInt32(dv, off) / 100; off += 4;
      const low    = readUInt32(dv, off) / 100; off += 4;
      const close  = readUInt32(dv, off) / 100; off += 4;
      const volume = readUInt32(dv, off);
      const type   = msgType === MSG.CANDLE_TICK ? "candle:tick" : "candle:closed";
      return { type, data: { symbol, tf, candle: { time, open, high, low, close, volume } } };
    }

    case MSG.JSON_FALLBACK: {
      const nameLen   = readUInt8(dv, off); off++;
      const eventName = readAscii(dv, off, nameLen); off += nameLen;
      const json      = readUtf8(arrayBuffer, off, arrayBuffer.byteLength - off);
      return { type: eventName, data: JSON.parse(json) };
    }

    default:
      return { type: "unknown", msgType, data: null };
  }
}

import { useEffect, useRef } from "react";
import { io } from "socket.io-client";

let _sharedSocket   = null;
let _socketRefCount = 0;

function getSharedSocket() {
  if (!_sharedSocket || _sharedSocket.disconnected) {
    _sharedSocket = io({ transports: ["websocket", "polling"] });
  }
  return _sharedSocket;
}

export function useBinarySocket(handlers = {}, options = {}) {
  const socketRef   = useRef(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const socket = options.shared ? getSharedSocket() : io({ transports: ["websocket", "polling"] });
    socketRef.current = socket;
    _socketRefCount++;

    socket.emit("use-binary", { version: 1 });
    socket.on("connect", () => {
      socket.emit("use-binary", { version: 1 });
    });

    function onBinary(data) {
      const buf = data instanceof ArrayBuffer ? data
        : data?.buffer instanceof ArrayBuffer ? data.buffer
        : null;
      if (!buf) return;
      try {
        const msg     = decode(buf);
        const handler = handlersRef.current[msg.type];
        if (handler) handler(msg.data);
      } catch (e) {
        console.warn("[binary] decode error:", e.message);
      }
    }
    socket.on("binary", onBinary);

    const jsonEvents = [
      "market-tick", "ltp", "scanner:diff", "scanner:snapshot",
      "candle:tick", "candle:closed", "option-chain-update",
      "option-expiries", "options-intelligence", "gann-analysis",
      "backtest-live-tick", "circuit-alerts", "delivery-spikes",
      "composite-scores", "composite-update",
      "upstox-status", "system_event", "pong",
    ];

    const jsonListeners = {};
    for (const event of jsonEvents) {
      const handler = handlers[event];
      if (handler) {
        const wrapper = (data) => handler(data);
        jsonListeners[event] = wrapper;
        socket.on(event, wrapper);
      }
    }

    return () => {
      socket.off("binary", onBinary);
      for (const [event, fn] of Object.entries(jsonListeners)) {
        socket.off(event, fn);
      }
      _socketRefCount--;
      if (!options.shared) {
        socket.disconnect();
      } else if (_socketRefCount <= 0) {
        _socketRefCount = 0;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return socketRef.current;
}

export function expandDiff(c) {
  if (c.symbol) return c;
  return {
    symbol:         c.s,
    ltp:            c.l,
    changePct:      c.c,
    change:         c.ch,
    volume:         c.v,
    techScore:      c.sc,
    signal:         c.sg,
    rsi:            c.rs,
    macd:           c.mc,
    bollingerBands: c.bb,
    maSummary:      c.ms,
    mcapBucket:     c.mb,
    mcapLabel:      c.ml,
    name:           c.nm,
    exchange:       c.ex,
    sector:         c.sk,
    prevClose:      c.pc,
    entry:          c.en,
    sl:             c.sl,
    tp:             c.tp,
    entryType:      c.et,
    gapPct:         c.gp,
  };
}

export default { decode, useBinarySocket, expandDiff, MSG };