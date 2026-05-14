"use strict";

const MSG = {
  MARKET_TICK:        0x01,
  LTP_TICK:           0x02,
  SCANNER_DIFF:       0x03,
  SCANNER_SNAPSHOT:   0x04,
  CANDLE_TICK:        0x05,
  CANDLE_CLOSED:      0x06,
  CIRCUIT_ALERT:      0x07,
  COMPOSITE_UPDATE:   0x08,
  SYSTEM_EVENT:       0x09,
  UPSTOX_STATUS:      0x0A,
  OPTIONS_INTEL:      0x0B,
  GANN_ANALYSIS:      0x0C,
  OPTIONS_INTEL_TICK: 0x0D,
  JSON_FALLBACK:      0xFF,
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
  1: "1min", 2: "5min", 3: "15min", 4: "30min",
  5: "1hour", 6: "4hour", 7: "1day", 8: "1week", 9: "1month",
};

let _symbolTable  = [];
let _symbolToIndex = new Map();

export function decode(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer ?? buffer);
  const view  = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const msgType = view.getUint8(0);
  let off = 5; // 1 type + 4 length

  switch (msgType) {

    case MSG.MARKET_TICK: {
      const updates = [];
      while (off + 8 <= bytes.length) {
        const id       = view.getUint8(off); off++;
        const rawPrice = view.getUint32(off) / 100; off += 4;
        const pct      = view.getInt16(off) / 100; off += 2;
        const up       = view.getUint8(off) === 1; off++;
        const name     = INDEX_ID_TO_NAME[id] || `IDX_${id}`;
        const diff     = parseFloat((pct * rawPrice / 100).toFixed(2));
        updates.push({
          name, raw: rawPrice,
          price:  rawPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
          pct:    (up ? "+" : "") + pct.toFixed(2) + "%",
          change: (up ? "+" : "") + diff.toFixed(2),
          up,
        });
      }
      return { type: "market-tick", data: updates };
    }

    case MSG.LTP_TICK: {
      const symLen = view.getUint8(off); off++;
      const symbol = String.fromCharCode(...bytes.slice(off, off + symLen)); off += symLen;
      const price  = view.getUint32(off) / 100; off += 4;
      const ts     = view.getUint32(off) * 1000;
      return { type: "ltp", data: { s: symbol, p: price, t: ts } };
    }

    case MSG.SCANNER_DIFF: {
      const count  = view.getUint16(off); off += 2;
      const stocks = [];
      for (let i = 0; i < count; i++) {
        const idx    = view.getUint16(off); off += 2;
        const ltp    = view.getUint32(off) / 100; off += 4;
        const cpct   = view.getInt16(off) / 100; off += 2;
        const change = view.getInt32(off) / 100; off += 4;
        const volume = view.getUint32(off); off += 4;
        const score  = view.getInt8(off); off++;
        const symbol = _symbolTable[idx] || `SYM_${idx}`;
        stocks.push({ symbol, ltp, changePct: cpct, change, volume, techScore: score });
      }
      return { type: "scanner:diff", data: stocks };
    }

    case MSG.SCANNER_SNAPSHOT: {
      const tableLen  = view.getUint32(off); off += 4;
      const tableJson = new TextDecoder().decode(bytes.slice(off, off + tableLen)); off += tableLen;
      _symbolTable    = JSON.parse(tableJson);
      _symbolToIndex  = new Map(_symbolTable.map((s, i) => [s, i]));
      const stocksLen = view.getUint32(off); off += 4;
      const stocks    = JSON.parse(new TextDecoder().decode(bytes.slice(off, off + stocksLen)));
      return { type: "scanner:snapshot", data: stocks };
    }

    case MSG.CANDLE_TICK:
    case MSG.CANDLE_CLOSED: {
      const symLen = view.getUint8(off); off++;
      const symbol = String.fromCharCode(...bytes.slice(off, off + symLen)); off += symLen;
      const tfId   = view.getUint8(off); off++;
      const tf     = TF_ID_TO_NAME[tfId] || "1min";
      const tsSec  = view.getUint32(off); off += 4;
      const tsRem  = view.getUint32(off); off += 4;
      const time   = tsSec * 1000 + tsRem;
      const open   = view.getUint32(off) / 100; off += 4;
      const high   = view.getUint32(off) / 100; off += 4;
      const low    = view.getUint32(off) / 100; off += 4;
      const close  = view.getUint32(off) / 100; off += 4;
      const volume = view.getUint32(off);
      const type   = msgType === MSG.CANDLE_TICK ? "candle:tick" : "candle:closed";
      return { type, data: { symbol, tf, candle: { time, open, high, low, close, volume } } };
    }

    case MSG.OPTIONS_INTEL: {
      const symLen        = view.getUint8(off); off++;
      const symbol        = String.fromCharCode(...bytes.slice(off, off + symLen)); off += symLen;
      const expLen        = view.getUint8(off); off++;
      const expiry        = String.fromCharCode(...bytes.slice(off, off + expLen)); off += expLen;
      const spotPrice     = view.getUint32(off) / 100; off += 4;
      const atmStrike     = view.getUint32(off) / 100; off += 4;
      const straddlePrice = view.getUint32(off) / 100; off += 4;
      const stranglePrice = view.getUint32(off) / 100; off += 4;
      const callLTP       = view.getUint32(off) / 100; off += 4;
      const putLTP        = view.getUint32(off) / 100; off += 4;
      const atmIV         = view.getUint32(off) / 100; off += 4;
      const pcr           = view.getInt16(off)  / 100; off += 2;
      const theta         = view.getInt16(off)  / 100; off += 2;
      const delta         = view.getInt16(off)  / 100; off += 2;
      const vega          = view.getInt16(off)  / 100; off += 2;
      return {
        type: "options-intelligence",
        data: {
          symbol, expiry, spotPrice,
          structure:  { atmStrike, straddlePrice, stranglePrice, callLTP, putLTP },
          volatility: { atmIV },
          oi:         { pcr },
          atmGreeks:  { theta, delta, vega },
        },
      };
    }

    case MSG.OPTIONS_INTEL_TICK: {
      // New variable-length frame: symLen+symbol+spot+straddle+strangle+atmIV+score+biasLen+bias+tsSec
      const symLen        = view.getUint8(off); off++;
      const symbol        = String.fromCharCode(...bytes.slice(off, off + symLen)); off += symLen;
      const spotPrice     = view.getUint32(off) / 100; off += 4;
      const straddlePrice = view.getUint32(off) / 100; off += 4;

      let stranglePrice = 0;
      if (off + 4 <= bytes.length) {
        stranglePrice = view.getUint32(off) / 100; off += 4;
      }

      const atmIV   = off + 4 <= bytes.length ? view.getUint32(off) / 100 : 0; off += 4;
      const score   = off + 1 <= bytes.length ? view.getUint8(off) : 50; off++;
      const biasLen = off + 1 <= bytes.length ? view.getUint8(off) : 0; off++;
      const bias    = biasLen > 0 && off + biasLen <= bytes.length
        ? String.fromCharCode(...bytes.slice(off, off + biasLen))
        : "NEUTRAL";
      off += biasLen;

      let ts = null;
      if (off + 4 <= bytes.length) {
        const tsSec = view.getInt32(off);
        if (tsSec > 0) ts = tsSec * 1000;
      }

      return {
        type: "options-intel-tick",
        data: { symbol, spotPrice, straddlePrice, stranglePrice, atmIV, score, bias, ts },
      };
    }

    case MSG.JSON_FALLBACK: {
      const nameLen   = view.getUint8(off); off++;
      const eventName = String.fromCharCode(...bytes.slice(off, off + nameLen)); off += nameLen;
      const data      = JSON.parse(new TextDecoder().decode(bytes.slice(off)));
      return { type: eventName, data };
    }

    default:
      return { type: "unknown", msgType, data: null };
  }
}

export { MSG };