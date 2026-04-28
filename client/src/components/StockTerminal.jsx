import { useState, useEffect, useRef, useCallback } from "react";

// ─── CSS ────────────────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700;800&display=swap');

.st-root *{margin:0;padding:0;box-sizing:border-box}
.st-root{
  --bg0:#060a0f;--bg1:#0d1117;--bg2:#161b22;--bg3:#21262d;
  --border:#30363d;--border2:#21262d;
  --text1:#e6edf3;--text2:#8b949e;--text3:#6e7681;
  --green:#26a641;--greenT:rgba(38,166,65,0.15);
  --red:#f85149;--redT:rgba(248,81,73,0.15);
  --blue:#58a6ff;--amber:#f0883e;--purple:#bc8cff;--teal:#39d353;
  --ma5:#ff6b6b;--ma9:#ffd93d;--ma21:#6bcb77;--ma50:#4ecdc4;--ma200:#a8e6cf;
  background:var(--bg0);color:var(--text1);
  font-family:'JetBrains Mono',monospace;font-size:12px;
  height:100%;display:flex;flex-direction:column;overflow:hidden;
}

.st-header{
  background:var(--bg1);border-bottom:1px solid var(--border);
  padding:8px 14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;flex-shrink:0;
}
.st-logo{font-size:18px;font-weight:800;letter-spacing:2px;color:var(--text1)}
.st-logo span{color:var(--green)}
.st-search-wrap{position:relative;display:flex;align-items:center;gap:8px}
.st-search{
  background:var(--bg2);border:1px solid var(--border);color:var(--text1);
  padding:6px 10px 6px 30px;border-radius:5px;font-size:12px;
  font-family:'JetBrains Mono',monospace;width:180px;outline:none;
  transition:border-color 0.15s;
}
.st-search:focus{border-color:var(--blue)}
.st-search-icon{position:absolute;left:9px;color:var(--text3);font-size:13px;pointer-events:none}
.st-dropdown-wrap{position:relative}
.st-dropdown{
  background:var(--bg2);border:1px solid var(--border);color:var(--text1);
  padding:6px 26px 6px 10px;border-radius:5px;font-size:12px;
  font-family:'JetBrains Mono',monospace;outline:none;cursor:pointer;
  appearance:none;-webkit-appearance:none;min-width:140px;
  transition:border-color 0.15s;
}
.st-dropdown:focus{border-color:var(--blue)}
.st-dropdown-arrow{position:absolute;right:8px;top:50%;transform:translateY(-50%);color:var(--text3);pointer-events:none;font-size:10px}
.st-autocomplete{
  position:absolute;top:calc(100% + 4px);left:0;z-index:100;
  background:var(--bg2);border:1px solid var(--border);border-radius:5px;
  width:220px;max-height:200px;overflow-y:auto;
}
.st-ac-item{
  padding:7px 12px;cursor:pointer;display:flex;justify-content:space-between;
  font-size:11px;border-bottom:1px solid var(--border2);transition:background 0.1s;
}
.st-ac-item:hover,.st-ac-item.active{background:var(--bg3)}
.st-ac-sym{color:var(--text1);font-weight:700}
.st-ac-name{color:var(--text3);font-size:10px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.st-price-block{display:flex;align-items:baseline;gap:8px}
.st-price{font-size:22px;font-weight:800;color:var(--text1)}
.st-chg-pos{color:var(--green);font-size:13px;font-weight:700}
.st-chg-neg{color:var(--red);font-size:13px;font-weight:700}
.st-stats{display:flex;gap:14px;flex-wrap:wrap;margin-left:auto}
.st-stat{text-align:center}
.st-stat-l{font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px}
.st-stat-v{font-size:11px;color:var(--text1);font-weight:700;margin-top:1px}
.st-connecting{color:var(--amber);font-size:10px;display:flex;align-items:center;gap:5px}
.st-live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:stblink 2s infinite;flex-shrink:0}
.st-live-dot.amber{background:var(--amber)}
.st-live-dot.red{background:var(--red)}
@keyframes stblink{0%,100%{opacity:1}50%{opacity:0.2}}

.st-controls{
  background:var(--bg1);border-bottom:1px solid var(--border);
  padding:5px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;
}
.st-tf-group{display:flex;gap:2px}
.st-tf{
  background:transparent;border:1px solid transparent;color:var(--text2);
  padding:4px 9px;border-radius:4px;cursor:pointer;font-size:11px;
  font-family:'JetBrains Mono',monospace;transition:all 0.12s;
}
.st-tf:hover{color:var(--text1);background:var(--bg3)}
.st-tf.on{background:var(--blue);color:#fff;border-color:var(--blue);font-weight:700}
.st-sep{width:1px;height:20px;background:var(--border);margin:0 4px;flex-shrink:0}
.st-tog-group{display:flex;gap:3px;flex-wrap:wrap}
.st-tog{
  background:var(--bg3);border:1px solid var(--border);color:var(--text3);
  padding:3px 8px;border-radius:3px;cursor:pointer;font-size:10px;
  font-family:'JetBrains Mono',monospace;transition:all 0.12s;
}
.st-tog:hover{color:var(--text1)}
.st-tv-btn{
  margin-left:auto;background:var(--bg3);border:1px solid var(--border);
  color:var(--blue);padding:5px 12px;border-radius:5px;cursor:pointer;
  font-size:11px;font-family:'JetBrains Mono',monospace;
  display:flex;align-items:center;gap:5px;transition:all 0.12s;
}
.st-tv-btn:hover{background:rgba(88,166,255,0.1);border-color:var(--blue)}

.st-main{display:flex;flex:1;overflow:hidden;min-height:0}
.st-chart-col{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.st-side{width:196px;background:var(--bg1);border-left:1px solid var(--border);overflow-y:auto;flex-shrink:0}

.st-pane{position:relative;background:var(--bg0);border-bottom:1px solid var(--border2);overflow:hidden}
.st-pane canvas{display:block}
.st-pane-lbl{position:absolute;top:5px;left:10px;font-size:9px;color:var(--text3);letter-spacing:1px;text-transform:uppercase;pointer-events:none;z-index:2}

.st-sig-sec{padding:10px;border-bottom:1px solid var(--border2)}
.st-sec-title{font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px}
.st-sig-badge{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.st-sig-circle{
  width:40px;height:40px;border-radius:50%;border:2px solid var(--green);
  display:flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:800;color:var(--green);flex-shrink:0;
}
.st-sig-circle.red{border-color:var(--red);color:var(--red)}
.st-sig-circle.amber{border-color:var(--amber);color:var(--amber)}
.st-sig-label{font-size:13px;font-weight:900;color:var(--green)}
.st-sig-label.red{color:var(--red)}
.st-sig-label.amber{color:var(--amber)}
.st-sig-sub{font-size:10px;color:var(--text3);margin-top:1px}
.st-sig-bar{height:3px;background:var(--bg3);border-radius:2px;margin-top:5px;overflow:hidden}
.st-sig-fill{height:100%;border-radius:2px;transition:width 0.5s}
.st-metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:5px}
.st-mcard{background:var(--bg2);border-radius:3px;padding:5px 7px}
.st-mcard.full{grid-column:span 2}
.st-mc-l{font-size:9px;color:var(--text3);text-transform:uppercase}
.st-mc-v{font-size:12px;font-weight:700;color:var(--text1);margin-top:1px}
.st-mc-v.green{color:var(--green)}.st-mc-v.red{color:var(--red)}

.st-ind-sec{padding:8px 10px;border-bottom:1px solid var(--border2)}
.st-ind-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.st-ind-name{font-size:10px;color:var(--text2)}
.st-ind-val{font-size:11px;font-weight:700}
.st-badge{font-size:9px;padding:1px 5px;border-radius:2px;font-weight:700}
.st-badge.buy{background:rgba(38,166,65,0.2);color:var(--green)}
.st-badge.sell{background:rgba(248,81,73,0.2);color:var(--red)}
.st-badge.neu{background:rgba(139,148,158,0.15);color:var(--text2)}
.st-bar-mini{height:3px;background:var(--bg3);border-radius:2px;margin-top:2px;overflow:hidden}
.st-bar-fill{height:100%;border-radius:2px}

.st-ma-sec{padding:8px 10px}
.st-ma-row{display:flex;align-items:center;margin-bottom:3px}
.st-ma-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.st-ma-name{font-size:10px;color:var(--text2);margin-left:5px;flex:1}
.st-ma-val{font-size:10px;font-weight:700;color:var(--text1)}
.st-ma-rel{font-size:9px;margin-left:4px;width:8px}

.st-error{display:flex;align-items:center;justify-content:center;height:100%;color:var(--red);font-size:13px;gap:8px}
.st-loading{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text3);font-size:12px;gap:8px}
.spinner{width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.st-side::-webkit-scrollbar{width:4px}
.st-side::-webkit-scrollbar-track{background:var(--bg1)}
.st-side::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.st-autocomplete::-webkit-scrollbar{width:3px}
.st-autocomplete::-webkit-scrollbar-thumb{background:var(--border)}
`;

const POPULAR_STOCKS = [
  { sym: "RELIANCE", name: "Reliance Industries" },
  { sym: "TCS", name: "Tata Consultancy Services" },
  { sym: "INFY", name: "Infosys" },
  { sym: "HDFCBANK", name: "HDFC Bank" },
  { sym: "ICICIBANK", name: "ICICI Bank" },
  { sym: "SBIN", name: "State Bank of India" },
  { sym: "WIPRO", name: "Wipro" },
  { sym: "AXISBANK", name: "Axis Bank" },
  { sym: "KOTAKBANK", name: "Kotak Mahindra Bank" },
  { sym: "LT", name: "Larsen & Toubro" },
  { sym: "BAJFINANCE", name: "Bajaj Finance" },
  { sym: "MARUTI", name: "Maruti Suzuki" },
  { sym: "TATAMOTORS", name: "Tata Motors" },
  { sym: "ADANIENT", name: "Adani Enterprises" },
  { sym: "ONGC", name: "ONGC" },
  { sym: "POWERGRID", name: "Power Grid Corp" },
  { sym: "NTPC", name: "NTPC" },
  { sym: "SUNPHARMA", name: "Sun Pharmaceutical" },
  { sym: "DRREDDY", name: "Dr. Reddy's Labs" },
  { sym: "HINDUNILVR", name: "Hindustan Unilever" },
  { sym: "ITC", name: "ITC" },
  { sym: "BHARTIARTL", name: "Bharti Airtel" },
  { sym: "VBL", name: "Varun Beverages" },
  { sym: "NESTLEIND", name: "Nestle India" },
  { sym: "TITAN", name: "Titan Company" },
  { sym: "ULTRACEMCO", name: "UltraTech Cement" },
  { sym: "TECHM", name: "Tech Mahindra" },
  { sym: "HCLTECH", name: "HCL Technologies" },
  { sym: "ASIANPAINT", name: "Asian Paints" },
  { sym: "BAJAJFINSV", name: "Bajaj Finserv" },
];

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────
function seed(s) { let x = Math.sin(s) * 10000; return x - Math.floor(x); }

function genCandles(n, startPrice, trend, volatility, s) {
  const candles = []; let p = startPrice;
  for (let i = 0; i < n; i++) {
    const r = seed(s + i * 7.3), r2 = seed(s + i * 13.7);
    const r3 = seed(s + i * 3.1), r4 = seed(s + i * 17.9);
    const body = (r - 0.5) * volatility * 2;
    const o = p, c = p + body + trend * volatility * 0.3;
    const high = Math.max(o, c) + r2 * volatility * 0.8;
    const low = Math.min(o, c) - r3 * volatility * 0.8;
    candles.push({ o: +o.toFixed(2), h: +high.toFixed(2), l: +Math.max(low, 1).toFixed(2), c: +c.toFixed(2), v: Math.floor(300000 + r4 * 2000000) });
    p = c;
  }
  return candles;
}

function calcMA(data, period) {
  const cl = data.map(d => d.c), ma = [];
  for (let i = 0; i < cl.length; i++) {
    if (i < period - 1) { ma.push(null); continue; }
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += cl[j];
    ma.push(+(s / period).toFixed(2));
  }
  return ma;
}
function calcEMA(data, period) {
  const cl = data.map(d => d.c), k = 2 / (period + 1), ema = []; let prev = null;
  for (let i = 0; i < cl.length; i++) {
    if (i < period - 1) { ema.push(null); continue; }
    if (prev === null) { let s = 0; for (let j = 0; j < period; j++) s += cl[j]; prev = s / period; ema.push(+prev.toFixed(2)); }
    else { prev = cl[i] * k + prev * (1 - k); ema.push(+prev.toFixed(2)); }
  }
  return ema;
}
function calcRSI(data, period = 14) {
  const cl = data.map(d => d.c), rsi = [];
  for (let i = 0; i < cl.length; i++) {
    if (i < period) { rsi.push(null); continue; }
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) { const d = cl[j] - cl[j - 1]; if (d > 0) g += d; else l += Math.abs(d); }
    const rs = l === 0 ? 100 : (g / period) / (l / period);
    rsi.push(+(100 - 100 / (1 + rs)).toFixed(2));
  }
  return rsi;
}
function calcMACD(data) {
  const e12 = calcEMA(data, 12), e26 = calcEMA(data, 26);
  const macdLine = e12.map((v, i) => v === null || e26[i] === null ? null : +(v - e26[i]).toFixed(2));
  const k = 2 / 10; let prev = null; let idx = 0; const sig = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) { sig.push(null); continue; }
    if (idx < 8) { idx++; sig.push(null); continue; }
    if (prev === null) { prev = macdLine[i]; sig.push(+prev.toFixed(2)); }
    else { prev = macdLine[i] * k + prev * (1 - k); sig.push(+prev.toFixed(2)); }
    idx++;
  }
  return { macd: macdLine, signal: sig, hist: macdLine.map((v, i) => v === null || sig[i] === null ? null : +(v - sig[i]).toFixed(2)) };
}
function calcBB(data, p = 20, m = 2) {
  const cl = data.map(d => d.c), upper = [], mid = [], lower = [];
  for (let i = 0; i < cl.length; i++) {
    if (i < p - 1) { upper.push(null); mid.push(null); lower.push(null); continue; }
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += cl[j]; const mn = s / p;
    let sq = 0; for (let j = i - p + 1; j <= i; j++) sq += (cl[j] - mn) ** 2;
    const sd = Math.sqrt(sq / p);
    upper.push(+(mn + m * sd).toFixed(2)); mid.push(+mn.toFixed(2)); lower.push(+(mn - m * sd).toFixed(2));
  }
  return { upper, mid, lower };
}
function calcATR(data, p = 14) {
  const atr = [];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { atr.push(null); continue; }
    const tr = Math.max(data[i].h - data[i].l, Math.abs(data[i].h - data[i - 1].c), Math.abs(data[i].l - data[i - 1].c));
    if (i < p) { atr.push(null); continue; }
    if (atr[i - 1] === null) { let s = 0; for (let j = 1; j <= p; j++) s += Math.max(data[j].h - data[j].l, Math.abs(data[j].h - data[j - 1].c), Math.abs(data[j].l - data[j - 1].c)); atr.push(+(s / p).toFixed(2)); }
    else atr.push(+(((atr[i - 1] * (p - 1)) + tr) / p).toFixed(2));
  }
  return atr;
}
function calcADX(data, p = 14) {
  const pdm = [], ndm = [], tr = [];
  for (let i = 1; i < data.length; i++) {
    const up = data[i].h - data[i - 1].h, dn = data[i - 1].l - data[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(data[i].h - data[i].l, Math.abs(data[i].h - data[i - 1].c), Math.abs(data[i].l - data[i - 1].c)));
  }
  const adx = [], pdi = [], ndi = [];
  for (let i = 0; i < pdm.length; i++) {
    if (i < p) { adx.push(null); pdi.push(null); ndi.push(null); continue; }
    let sp = 0, sn = 0, st = 0;
    for (let j = i - p + 1; j <= i; j++) { sp += pdm[j]; sn += ndm[j]; st += tr[j]; }
    const pp = +(100 * sp / st).toFixed(2), np = +(100 * sn / st).toFixed(2);
    pdi.push(pp); ndi.push(np); adx.push(+((Math.abs(pp - np) / (pp + np)) * 100).toFixed(2));
  }
  return { adx, pdi, ndi };
}
function calcStoch(data, p = 14, dp = 3) {
  const k = [], d = [];
  for (let i = 0; i < data.length; i++) {
    if (i < p - 1) { k.push(null); d.push(null); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { hi = Math.max(hi, data[j].h); lo = Math.min(lo, data[j].l); }
    k.push(hi === lo ? 50 : +((data[i].c - lo) / (hi - lo) * 100).toFixed(2));
    if (i >= p - 1 + dp - 1) { let s = 0, c = 0; for (let j = i - dp + 1; j <= i; j++) if (k[j] !== null) { s += k[j]; c++; } d.push(c > 0 ? +(s / c).toFixed(2) : null); }
    else d.push(null);
  }
  return { k, d };
}
function calcOBV(data) {
  const obv = [0];
  for (let i = 1; i < data.length; i++) {
    if (data[i].c > data[i - 1].c) obv.push(obv[i - 1] + data[i].v);
    else if (data[i].c < data[i - 1].c) obv.push(obv[i - 1] - data[i].v);
    else obv.push(obv[i - 1]);
  }
  return obv;
}
function calcVWAP(data) {
  const vwap = []; let cpv = 0, cv = 0;
  for (let i = 0; i < data.length; i++) {
    const tp = (data[i].h + data[i].l + data[i].c) / 3;
    cpv += tp * data[i].v; cv += data[i].v;
    vwap.push(+(cpv / cv).toFixed(2));
  }
  return vwap;
}
function calcSuperTrend(data, p = 10, m = 3) {
  const atr = calcATR(data, p), st = [], dir = [];
  let pU = null, pL = null, pD = 1;
  for (let i = 0; i < data.length; i++) {
    if (atr[i] === null) { st.push(null); dir.push(null); continue; }
    const tp = (data[i].h + data[i].l) / 2;
    let upper = tp + m * atr[i], lower = tp - m * atr[i];
    if (pU !== null) {
      if (upper < pU || data[i - 1].c > pU) upper = upper; else upper = pU;
      if (lower > pL || data[i - 1].c < pL) lower = lower; else lower = pL;
    }
    let d = pD === 1 ? (data[i].c <= lower ? -1 : 1) : (data[i].c >= upper ? 1 : -1);
    st.push(+(d === 1 ? lower : upper).toFixed(2)); dir.push(d);
    pU = upper; pL = lower; pD = d;
  }
  return { st, dir };
}

function computeSignal(indicators, lastCandle, ltp) {
  const { rsi, macd, adx, stoch, supertrend, vwap, ma5, ma9, ma21 } = indicators;
  const last = rsi.length - 1;
  let score = 50;
  const r = rsi[last]; if (r !== null) { if (r > 60 && r < 75) score += 10; else if (r > 75) score += 5; else if (r < 40) score -= 10; }
  const h = macd.hist[last]; if (h !== null) score += h > 0 ? 8 : -8;
  const adxV = adx.adx[last], pdi = adx.pdi[last], ndi = adx.ndi[last];
  if (adxV !== null && pdi !== null && ndi !== null) { if (adxV > 25 && pdi > ndi) score += 10; else if (adxV > 25 && ndi > pdi) score -= 10; }
  const stDir = supertrend.dir[last]; if (stDir !== null) score += stDir === 1 ? 8 : -8;
  if (vwap[last] !== null) score += ltp > vwap[last] ? 5 : -5;
  if (ma5[last] && ma9[last] && ma21[last]) { if (ma5[last] > ma9[last] && ma9[last] > ma21[last]) score += 7; }
  if (stoch.k[last] !== null) { const sk = stoch.k[last]; if (sk > 80) score -= 3; else if (sk < 20) score += 3; }
  score = Math.min(100, Math.max(0, Math.round(score)));
  const label = score >= 75 ? "STRONG BUY" : score >= 60 ? "BUY" : score >= 45 ? "HOLD" : score >= 30 ? "SELL" : "STRONG SELL";
  const color = score >= 60 ? "green" : score >= 40 ? "amber" : "red";
  return { score, label, color };
}

function drawGrid(ctx, w, h, rows = 4, cols = 8) {
  ctx.strokeStyle = "rgba(48,54,61,0.5)"; ctx.lineWidth = 0.5;
  for (let i = 1; i < rows; i++) { const y = h * i / rows; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  for (let i = 1; i < cols; i++) { const x = w * i / cols; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
}
function toY(val, min, max, h, pad = 18) { return pad + (h - 2 * pad) * (1 - (val - min) / (max - min)); }
function drawLine(ctx, data, indices, min, max, h, color, lw = 1, pad = 18) {
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); let started = false;
  indices.forEach((x, i) => {
    const v = data[i]; if (v === null || isNaN(v)) return;
    const y = toY(v, min, max, h, pad);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
export default function StockTerminal({ initialSymbol }) {
  // ── initialSymbol prop: if provided (from scanner Full Chart), use it.
  // Fallback to sessionStorage, then "VBL".
  const [symbol, setSymbol] = useState(
  initialSymbol || sessionStorage.getItem("terminal_symbol") || "VBL"
);

// Force symbol update when initialSymbol prop arrives
useEffect(() => {
  if (initialSymbol) {
    setSymbol(initialSymbol);
    setLiveData(null);
  }
}, [initialSymbol]);

  const [search, setSearch] = useState("");
  const [acList, setAcList] = useState([]);
  const [acIdx, setAcIdx] = useState(-1);
  const [showAc, setShowAc] = useState(false);
  const [tf, setTf] = useState("1D");
  const [liveData, setLiveData] = useState(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [indicators, setIndicators] = useState(null);
  const [signal, setSignal] = useState(null);
  const [maToggles, setMaToggles] = useState({ ma5: true, ma9: true, ma21: true, ma50: true, ma200: true });
  const [overlays, setOverlays] = useState({ supertrend: true, vwap: true, bollinger: true });

  const wsRef = useRef(null);
  const chartColRef = useRef(null);
  const searchRef = useRef(null);

  const candleRef = useRef(null);
  const macdRef = useRef(null);
  const rsiRef = useRef(null);
  const volRef = useRef(null);
  const adxRef = useRef(null);

  // ── When initialSymbol prop changes (scanner selects a new stock), update ──
  useEffect(() => {
    if (initialSymbol && initialSymbol !== symbol) {
      setSymbol(initialSymbol);
      setLiveData(null);
    }
  }, [initialSymbol]); // eslint-disable-line

  // ── Listen for open-terminal events (fired by scanner Full Chart buttons) ──
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.symbol) {
        setSymbol(e.detail.symbol);
        setLiveData(null);
        sessionStorage.setItem("terminal_symbol", e.detail.symbol);
      }
    };
    window.addEventListener("open-terminal", handler);
    return () => window.removeEventListener("open-terminal", handler);
  }, []);

  const TF_CONFIG = {
    "5m":  { n: 80, trend: 0.01, vol: 0.8 },
    "15m": { n: 80, trend: 0.02, vol: 1.2 },
    "1H":  { n: 80, trend: 0.03, vol: 2.0 },
    "4H":  { n: 80, trend: 0.04, vol: 3.5 },
    "1D":  { n: 120, trend: 0.02, vol: 5.0 },
    "1W":  { n: 60, trend: 0.08, vol: 9.0 },
    "1M":  { n: 36, trend: 0.18, vol: 14.0 },
  };

  function symHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff; return h; }

  // ── Connect to Socket.io ──────────────────────────────────────────────────
  useEffect(() => {
    setWsStatus("connecting");
    setLiveData(null);

    if (wsRef.current) {
      wsRef.current.disconnect?.();
      wsRef.current = null;
    }

    import("socket.io-client").then(({ io }) => {
      const sock = io({ transports: ["websocket", "polling"] });
      wsRef.current = sock;

      sock.on("connect", () => {
        setWsStatus("live");
      });

      sock.on("ltp-tick", (msg) => {
        if (!msg || !msg.symbol) return;
        const sym = msg.symbol.replace("NSE_EQ|", "").replace("BSE_EQ|", "");
        if (sym !== symbol) return;
        setLiveData({
          ltp:       msg.ltp ?? msg.last_price,
          open:      msg.open ?? msg.ohlc?.open,
          high:      msg.high ?? msg.ohlc?.high,
          low:       msg.low  ?? msg.ohlc?.low,
          close:     msg.ltp,
          volume:    msg.volume ?? msg.vol,
          change:    msg.change,
          changePct: msg.changePct ?? msg.percentChange,
        });
        setWsStatus("live");
      });

      sock.on("disconnect", () => setWsStatus("error"));
      sock.on("connect_error", () => setWsStatus("error"));
    }).catch(() => setWsStatus("error"));

    return () => {
      if (wsRef.current) wsRef.current.disconnect?.();
    };
  }, [symbol]);

  // ── Generate candles + indicators ─────────────────────────────────────────
  useEffect(() => {
    const cfg = TF_CONFIG[tf] || TF_CONFIG["1D"];
    const h = symHash(symbol);
    const basePrice = liveData?.ltp ?? (100 + (h % 1400));
    const candles = genCandles(cfg.n, basePrice * 0.88, cfg.trend, cfg.vol * (basePrice / 500), h + tf.charCodeAt(0) * 97);

    if (liveData?.ltp) {
      const last = candles[candles.length - 1];
      last.c = liveData.ltp;
      last.o = liveData.open ?? last.o;
      last.h = Math.max(liveData.high ?? last.h, liveData.ltp);
      last.l = Math.min(liveData.low ?? last.l, liveData.ltp);
      last.v = liveData.volume ?? last.v;
    }

    const ma5 = calcMA(candles, 5), ma9 = calcMA(candles, 9);
    const ma21 = calcMA(candles, 21), ma50 = calcMA(candles, 50), ma200 = calcMA(candles, 200);
    const rsi = calcRSI(candles, 14);
    const macd = calcMACD(candles);
    const bb = calcBB(candles, 20, 2);
    const atr = calcATR(candles, 14);
    const adx = calcADX(candles, 14);
    const stoch = calcStoch(candles, 14, 3);
    const obv = calcOBV(candles);
    const vwap = calcVWAP(candles);
    const supertrend = calcSuperTrend(candles, 10, 3);

    const ind = { candles, ma5, ma9, ma21, ma50, ma200, rsi, macd, bb, atr, adx, stoch, obv, vwap, supertrend };
    setIndicators(ind);

    const lastCandle = candles[candles.length - 1];
    const ltp = liveData?.ltp ?? lastCandle.c;
    setSignal(computeSignal(ind, lastCandle, ltp));
  }, [symbol, tf, liveData?.ltp]);

  // ── Draw canvases ─────────────────────────────────────────────────────────
  const drawAll = useCallback(() => {
    if (!indicators || !chartColRef.current) return;
    const col = chartColRef.current;
    const W = col.clientWidth;
    const H = col.clientHeight;
    const PANE_HEIGHTS = [0.42, 0.155, 0.155, 0.135, 0.135];
    const refs = [candleRef, macdRef, rsiRef, volRef, adxRef];
    refs.forEach((r, i) => {
      if (!r.current) return;
      r.current.width = W;
      r.current.height = Math.floor(H * PANE_HEIGHTS[i]);
    });
    drawCandlePane(indicators, W, Math.floor(H * PANE_HEIGHTS[0]));
    drawMACDPane(indicators, W, Math.floor(H * PANE_HEIGHTS[1]));
    drawRSIPane(indicators, W, Math.floor(H * PANE_HEIGHTS[2]));
    drawVolPane(indicators, W, Math.floor(H * PANE_HEIGHTS[3]));
    drawADXPane(indicators, W, Math.floor(H * PANE_HEIGHTS[4]));
  }, [indicators, maToggles, overlays]);

  useEffect(() => { drawAll(); }, [drawAll]);
  useEffect(() => {
    const ro = new ResizeObserver(() => drawAll());
    if (chartColRef.current) ro.observe(chartColRef.current);
    return () => ro.disconnect();
  }, [drawAll]);

  function drawCandlePane(d, w, h) {
    const cv = candleRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#060a0f"; ctx.fillRect(0, 0, w, h);
    drawGrid(ctx, w, h, 6, 10);
    const n = d.candles.length, pad = 48;
    const cw = Math.max(2, (w - pad * 2) / n);
    const gap = Math.max(0.5, cw * 0.15), bw = Math.max(1, cw - gap * 2);
    let minP = Infinity, maxP = -Infinity;
    d.candles.forEach(c => { minP = Math.min(minP, c.l); maxP = Math.max(maxP, c.h); });
    [d.ma5, d.ma9, d.ma21, d.ma50, d.ma200, d.bb.upper, d.bb.lower].forEach(arr => arr.forEach(v => { if (v) { minP = Math.min(minP, v); maxP = Math.max(maxP, v); } }));
    const rng = (maxP - minP) * 0.08; minP -= rng; maxP += rng;
    const xOf = i => pad + i * cw + bw / 2;
    const indices = d.candles.map((_, i) => xOf(i));
    if (overlays.bollinger) {
      ctx.fillStyle = "rgba(88,166,255,0.05)"; ctx.beginPath(); let s2 = true;
      for (let i = 0; i < n; i++) { if (!d.bb.upper[i]) continue; const x = xOf(i), y = toY(d.bb.upper[i], minP, maxP, h); s2 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); s2 = false; }
      for (let i = n - 1; i >= 0; i--) { if (!d.bb.lower[i]) continue; ctx.lineTo(xOf(i), toY(d.bb.lower[i], minP, maxP, h)); }
      ctx.closePath(); ctx.fill();
      drawLine(ctx, d.bb.upper, indices, minP, maxP, h, "rgba(88,166,255,0.45)", 0.8);
      drawLine(ctx, d.bb.lower, indices, minP, maxP, h, "rgba(88,166,255,0.45)", 0.8);
      drawLine(ctx, d.bb.mid, indices, minP, maxP, h, "rgba(88,166,255,0.25)", 0.6);
    }
    if (overlays.supertrend) {
      for (let i = 1; i < n; i++) {
        if (!d.supertrend.st[i]) continue;
        ctx.strokeStyle = d.supertrend.dir[i] === 1 ? "rgba(38,166,65,0.75)" : "rgba(248,81,73,0.75)";
        ctx.lineWidth = 1.5; ctx.beginPath();
        ctx.moveTo(xOf(i - 1), toY(d.supertrend.st[i - 1] ?? d.supertrend.st[i], minP, maxP, h));
        ctx.lineTo(xOf(i), toY(d.supertrend.st[i], minP, maxP, h)); ctx.stroke();
      }
    }
    if (overlays.vwap) drawLine(ctx, d.vwap, indices, minP, maxP, h, "rgba(240,136,62,0.8)", 1.5);
    const maConf = [
      { key: "ma5", data: d.ma5, color: "#ff6b6b" }, { key: "ma9", data: d.ma9, color: "#ffd93d" },
      { key: "ma21", data: d.ma21, color: "#6bcb77" }, { key: "ma50", data: d.ma50, color: "#4ecdc4" },
      { key: "ma200", data: d.ma200, color: "#a8e6cf" },
    ];
    maConf.forEach(m => { if (!maToggles[m.key]) return; drawLine(ctx, m.data, indices, minP, maxP, h, m.color, m.key === "ma200" ? 1.8 : 1.2); });
    d.candles.forEach((c, i) => {
      const x = xOf(i), bull = c.c >= c.o, col = bull ? "#26a641" : "#f85149";
      const bodyT = toY(Math.max(c.o, c.c), minP, maxP, h), bodyB = toY(Math.min(c.o, c.c), minP, maxP, h);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, toY(c.h, minP, maxP, h)); ctx.lineTo(x, toY(c.l, minP, maxP, h)); ctx.stroke();
      ctx.fillStyle = col; ctx.fillRect(x - bw / 2, bodyT, bw, Math.max(1, bodyB - bodyT));
    });
    ctx.fillStyle = "#6e7681"; ctx.font = "9px JetBrains Mono";
    for (let i = 0; i <= 5; i++) { const v = minP + (maxP - minP) * i / 5; ctx.fillText("₹" + v.toFixed(1), 2, toY(v, minP, maxP, h) + 3); }
    const lc = d.candles[n - 1];
    const ly = toY(lc.c, minP, maxP, h);
    ctx.strokeStyle = "rgba(88,166,255,0.5)"; ctx.lineWidth = 0.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#1f6feb"; ctx.fillRect(w - 54, ly - 8, 54, 16);
    ctx.fillStyle = "#fff"; ctx.font = "10px JetBrains Mono"; ctx.fillText("₹" + lc.c.toFixed(1), w - 50, ly + 4);
  }

  function drawMACDPane(d, w, h) {
    const cv = macdRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#060a0f"; ctx.fillRect(0, 0, w, h); drawGrid(ctx, w, h, 3, 10);
    const n = d.candles.length, pad = 30, cw = (w - pad * 2) / n;
    const allV = [...d.macd.macd, ...d.macd.signal, ...d.macd.hist].filter(v => v !== null);
    if (!allV.length) return;
    const minV = Math.min(...allV), maxV = Math.max(...allV);
    const xOf = i => pad + i * cw + cw / 2, indices = d.candles.map((_, i) => xOf(i));
    const zero = toY(0, minV, maxV, h, 12);
    ctx.strokeStyle = "rgba(48,54,61,0.8)"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, zero); ctx.lineTo(w, zero); ctx.stroke();
    d.macd.hist.forEach((v, i) => {
      if (v === null) return;
      const x = xOf(i), bw2 = Math.max(1, cw * 0.6), y1 = toY(v, minV, maxV, h, 12);
      ctx.fillStyle = v >= 0 ? "rgba(38,166,65,0.7)" : "rgba(248,81,73,0.7)";
      ctx.fillRect(x - bw2 / 2, Math.min(y1, zero), bw2, Math.abs(y1 - zero));
    });
    drawLine(ctx, d.macd.macd, indices, minV, maxV, h, "#58a6ff", 1.2, 12);
    drawLine(ctx, d.macd.signal, indices, minV, maxV, h, "#f0883e", 1.2, 12);
  }

  function drawRSIPane(d, w, h) {
    const cv = rsiRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#060a0f"; ctx.fillRect(0, 0, w, h); drawGrid(ctx, w, h, 3, 10);
    const n = d.candles.length, pad = 30, p2 = 10, cw = (w - pad * 2) / n;
    const xOf = i => pad + i * cw + cw / 2, indices = d.candles.map((_, i) => xOf(i));
    ctx.fillStyle = "rgba(248,81,73,0.07)"; ctx.fillRect(0, toY(80, 0, 100, h, p2), w, toY(70, 0, 100, h, p2) - toY(80, 0, 100, h, p2));
    ctx.fillStyle = "rgba(38,166,65,0.07)"; ctx.fillRect(0, toY(30, 0, 100, h, p2), w, toY(20, 0, 100, h, p2) - toY(30, 0, 100, h, p2));
    [70, 50, 30].forEach(v => {
      ctx.strokeStyle = "rgba(48,54,61,0.8)"; ctx.lineWidth = 0.5; ctx.setLineDash(v === 50 ? [] : [3, 3]);
      ctx.beginPath(); ctx.moveTo(0, toY(v, 0, 100, h, p2)); ctx.lineTo(w, toY(v, 0, 100, h, p2)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#6e7681"; ctx.font = "9px JetBrains Mono"; ctx.fillText(v, 2, toY(v, 0, 100, h, p2) + 3);
    });
    drawLine(ctx, d.rsi, indices, 0, 100, h, "#f0883e", 1.3, p2);
    drawLine(ctx, d.stoch.k, indices, 0, 100, h, "rgba(188,140,255,0.8)", 1, p2);
    drawLine(ctx, d.stoch.d, indices, 0, 100, h, "rgba(88,166,255,0.7)", 0.8, p2);
  }

  function drawVolPane(d, w, h) {
    const cv = volRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#060a0f"; ctx.fillRect(0, 0, w, h); drawGrid(ctx, w, h, 3, 10);
    const n = d.candles.length, pad = 30, p2 = 8, cw = (w - pad * 2) / n;
    const maxV = Math.max(...d.candles.map(c => c.v));
    const xOf = i => pad + i * cw + cw / 2, indices = d.candles.map((_, i) => xOf(i));
    d.candles.forEach((c, i) => {
      const x = xOf(i), bw2 = Math.max(1, cw * 0.6), barH = (c.v / maxV) * (h - p2 * 2);
      ctx.fillStyle = c.c >= c.o ? "rgba(38,166,65,0.55)" : "rgba(248,81,73,0.55)";
      ctx.fillRect(x - bw2 / 2, h - p2 - barH, bw2, barH);
    });
    const obv = d.obv, minO = Math.min(...obv), maxO = Math.max(...obv);
    drawLine(ctx, obv, indices, minO, maxO, h, "rgba(57,211,83,0.7)", 1.2, p2);
  }

  function drawADXPane(d, w, h) {
    const cv = adxRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#060a0f"; ctx.fillRect(0, 0, w, h); drawGrid(ctx, w, h, 3, 10);
    const n = d.candles.length, pad = 30, p2 = 10, cw = (w - pad * 2) / n;
    const xOf = i => pad + i * cw + cw / 2, indices = d.candles.map((_, i) => xOf(i));
    ctx.strokeStyle = "rgba(240,136,62,0.4)"; ctx.lineWidth = 0.5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, toY(25, 0, 80, h, p2)); ctx.lineTo(w, toY(25, 0, 80, h, p2)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#6e7681"; ctx.font = "9px JetBrains Mono"; ctx.fillText("25", 2, toY(25, 0, 80, h, p2) + 3);
    drawLine(ctx, d.adx.adx, indices, 0, 80, h, "#f0883e", 1.5, p2);
    drawLine(ctx, d.adx.pdi, indices, 0, 80, h, "rgba(38,166,65,0.7)", 1, p2);
    drawLine(ctx, d.adx.ndi, indices, 0, 80, h, "rgba(248,81,73,0.7)", 1, p2);
  }

  // ── Autocomplete ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!search.trim()) { setAcList([]); setShowAc(false); return; }
    const q = search.toUpperCase();
    const filtered = POPULAR_STOCKS.filter(s => s.sym.includes(q) || s.name.toUpperCase().includes(q)).slice(0, 8);
    setAcList(filtered); setShowAc(true); setAcIdx(-1);
  }, [search]);

  function selectSymbol(sym) { setSymbol(sym); setSearch(""); setShowAc(false); setLiveData(null); }

  function onSearchKey(e) {
    if (!showAc) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setAcIdx(i => Math.min(i + 1, acList.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAcIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { if (acIdx >= 0 && acList[acIdx]) { selectSymbol(acList[acIdx].sym); } else if (search.trim()) { selectSymbol(search.trim().toUpperCase()); } }
    else if (e.key === "Escape") { setShowAc(false); }
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const last = indicators?.candles?.length - 1 ?? 0;
  const lastC = indicators?.candles?.[last];
  const ltp = liveData?.ltp ?? lastC?.c ?? 0;
  const open = liveData?.open ?? lastC?.o ?? 0;
  const high = liveData?.high ?? lastC?.h ?? 0;
  const low = liveData?.low ?? lastC?.l ?? 0;
  const vol = liveData?.volume ?? lastC?.v ?? 0;
  const diff = ltp - open;
  const pct = open ? (diff / open * 100) : 0;
  const isPos = diff >= 0;

  const rsiV = indicators?.rsi?.[last];
  const macdV = indicators?.macd?.macd?.[last];
  const sigV = indicators?.macd?.signal?.[last];
  const histV = indicators?.macd?.hist?.[last];
  const prevHistV = indicators?.macd?.hist?.[last - 1];
  const adxV = indicators?.adx?.adx?.[last];
  const pdiV = indicators?.adx?.pdi?.[last];
  const ndiV = indicators?.adx?.ndi?.[last];
  const stDir = indicators?.supertrend?.dir?.[last];
  const vwapV = indicators?.vwap?.[last];
  const atrV = indicators?.atr?.[last];
  const bbu = indicators?.bb?.upper?.[last];
  const bbm = indicators?.bb?.mid?.[last];
  const bbl = indicators?.bb?.lower?.[last];
  const sk = indicators?.stoch?.k?.[last];
  const sd = indicators?.stoch?.d?.[last];
  const obv = indicators?.obv;
  const obvTrend = obv && obv.length > 5 ? (obv[last] > obv[last - 5] ? "↑ Rising" : "↓ Falling") : "--";
  const avgVol = indicators?.candles?.slice(Math.max(0, last - 19), last + 1).reduce((a, c) => a + c.v, 0) / Math.min(20, last + 1);
  const ma5V = indicators?.ma5?.[last], ma9V = indicators?.ma9?.[last];
  const ma21V = indicators?.ma21?.[last], ma50V = indicators?.ma50?.[last], ma200V = indicators?.ma200?.[last];
  const bullStack = [ma5V, ma9V, ma21V, ma50V, ma200V].every((v, i, a) => i === 0 || !v || !a[i - 1] || a[i - 1] > v);
  const rsiSig = rsiV > 70 ? "OBOUGHT" : rsiV < 30 ? "OVERSOLD" : "NEUTRAL";
  const cross = histV !== null && prevHistV !== null ? (histV > 0 && prevHistV <= 0 ? "BULL CROSS" : histV < 0 && prevHistV >= 0 ? "BEAR CROSS" : histV > 0 ? "BULLISH" : "BEARISH") : "--";
  const atrVal = atrV ? atrV : 0;
  const stopLoss = (ltp - 1.8 * atrVal).toFixed(2);
  const target = (ltp + 3.8 * atrVal).toFixed(2);
  const rr = atrVal > 0 ? `1:${(3.8 / 1.8).toFixed(1)}` : "--";
  const fmtVol = v => v > 1e6 ? (v / 1e6).toFixed(2) + "M" : v > 1e3 ? (v / 1e3).toFixed(0) + "K" : v;
  const statusDot = wsStatus === "live" ? "" : wsStatus === "connecting" ? "amber" : "red";
  const statusText = wsStatus === "live" ? "LIVE" : wsStatus === "connecting" ? "CONNECTING..." : "DISCONNECTED";

  return (
    <>
      <style>{css}</style>
      <div className="st-root">
        <div className="st-header">
          <div className="st-logo">MKT<span>▲</span></div>
          <div className="st-search-wrap" style={{ position: "relative" }}>
            <span className="st-search-icon">⌕</span>
            <input
              ref={searchRef}
              className="st-search"
              placeholder="Search symbol…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={onSearchKey}
              onBlur={() => setTimeout(() => setShowAc(false), 150)}
              onFocus={() => search && setShowAc(true)}
            />
            {showAc && acList.length > 0 && (
              <div className="st-autocomplete">
                {acList.map((s, i) => (
                  <div key={s.sym} className={`st-ac-item${i === acIdx ? " active" : ""}`} onMouseDown={() => selectSymbol(s.sym)}>
                    <span className="st-ac-sym">{s.sym}</span>
                    <span className="st-ac-name">{s.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="st-dropdown-wrap">
            <select className="st-dropdown" value={symbol} onChange={e => selectSymbol(e.target.value)}>
              {POPULAR_STOCKS.map(s => <option key={s.sym} value={s.sym}>{s.sym} — {s.name}</option>)}
            </select>
            <span className="st-dropdown-arrow">▾</span>
          </div>
          <div className="st-price-block">
            <span className="st-price">₹{ltp.toFixed(2)}</span>
            <span className={isPos ? "st-chg-pos" : "st-chg-neg"}>
              {isPos ? "+" : ""}{diff.toFixed(2)} ({isPos ? "+" : ""}{pct.toFixed(2)}%)
            </span>
          </div>
          <div className="st-stats">
            <div className="st-stat"><div className="st-stat-l">Open</div><div className="st-stat-v">₹{open.toFixed(2)}</div></div>
            <div className="st-stat"><div className="st-stat-l">High</div><div className="st-stat-v" style={{ color: "var(--green)" }}>₹{high.toFixed(2)}</div></div>
            <div className="st-stat"><div className="st-stat-l">Low</div><div className="st-stat-v" style={{ color: "var(--red)" }}>₹{low.toFixed(2)}</div></div>
            <div className="st-stat"><div className="st-stat-l">Volume</div><div className="st-stat-v">{fmtVol(vol)}</div></div>
          </div>
          <div className="st-connecting">
            <span className={`st-live-dot ${statusDot}`}></span>
            {statusText} · {symbol}
          </div>
        </div>

        <div className="st-controls">
          <div className="st-tf-group">
            {["5m", "15m", "1H", "4H", "1D", "1W", "1M"].map(t => (
              <button key={t} className={`st-tf${tf === t ? " on" : ""}`} onClick={() => setTf(t)}>{t}</button>
            ))}
          </div>
          <div className="st-sep" />
          <div className="st-tog-group">
            {[
              { key: "ma5", label: "MA5", color: "var(--ma5)", bg: "rgba(255,107,107,0.1)" },
              { key: "ma9", label: "MA9", color: "var(--ma9)", bg: "rgba(255,217,61,0.1)" },
              { key: "ma21", label: "MA21", color: "var(--ma21)", bg: "rgba(107,203,119,0.1)" },
              { key: "ma50", label: "MA50", color: "var(--ma50)", bg: "rgba(78,205,196,0.1)" },
              { key: "ma200", label: "MA200", color: "var(--ma200)", bg: "rgba(168,230,207,0.1)" },
            ].map(m => (
              <button key={m.key} className="st-tog" onClick={() => setMaToggles(p => ({ ...p, [m.key]: !p[m.key] }))}
                style={maToggles[m.key] ? { color: m.color, borderColor: m.color, background: m.bg } : {}}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="st-sep" />
          <div className="st-tog-group">
            {[
              { key: "supertrend", label: "SuperTrend", color: "var(--purple)", bg: "rgba(188,140,255,0.1)" },
              { key: "vwap", label: "VWAP", color: "var(--amber)", bg: "rgba(240,136,62,0.1)" },
              { key: "bollinger", label: "BB", color: "var(--blue)", bg: "rgba(88,166,255,0.1)" },
            ].map(o => (
              <button key={o.key} className="st-tog" onClick={() => setOverlays(p => ({ ...p, [o.key]: !p[o.key] }))}
                style={overlays[o.key] ? { color: o.color, borderColor: o.color, background: o.bg } : {}}>
                {o.label}
              </button>
            ))}
          </div>
          <button className="st-tv-btn" onClick={() => {
            const TV_MAP = { "NIFTY": "NSE:NIFTY50", "BANKNIFTY": "NSE:BANKNIFTY", "SENSEX": "BSE:SENSEX" };
            const tvSym = TV_MAP[symbol.toUpperCase()] || `NSE:${symbol}`;
            window.open(`https://www.tradingview.com/chart/?symbol=${tvSym}`, "_blank");
          }}>↗ TradingView</button>
        </div>

        <div className="st-main">
          <div className="st-chart-col" ref={chartColRef}>
            <div className="st-pane" style={{ flex: "0 0 42%" }}>
              <div className="st-pane-lbl"><span className="st-live-dot"></span> PRICE · {tf}</div>
              <canvas ref={candleRef} />
            </div>
            <div className="st-pane" style={{ flex: "0 0 15.5%" }}>
              <div className="st-pane-lbl">MACD (12,26,9)</div>
              <canvas ref={macdRef} />
            </div>
            <div className="st-pane" style={{ flex: "0 0 15.5%" }}>
              <div className="st-pane-lbl">RSI (14) · Stochastic</div>
              <canvas ref={rsiRef} />
            </div>
            <div className="st-pane" style={{ flex: "0 0 13.5%" }}>
              <div className="st-pane-lbl">Volume · OBV</div>
              <canvas ref={volRef} />
            </div>
            <div className="st-pane" style={{ flex: "0 0 13.5%" }}>
              <div className="st-pane-lbl">ADX · +DMI · -DMI</div>
              <canvas ref={adxRef} />
            </div>
          </div>

          <div className="st-side">
            {signal && (
              <div className="st-sig-sec">
                <div className="st-sec-title"><span className="st-live-dot"></span> Signal · {tf}</div>
                <div className="st-sig-badge">
                  <div className={`st-sig-circle ${signal.color}`}>{signal.score}</div>
                  <div>
                    <div className={`st-sig-label ${signal.color}`}>{signal.label}</div>
                    <div className="st-sig-sub">{signal.score}/100</div>
                    <div className="st-sig-bar">
                      <div className="st-sig-fill" style={{ width: signal.score + "%", background: signal.color === "green" ? "var(--green)" : signal.color === "red" ? "var(--red)" : "var(--amber)" }} />
                    </div>
                  </div>
                </div>
                <div className="st-metric-grid">
                  <div className="st-mcard"><div className="st-mc-l">Entry</div><div className="st-mc-v green">₹{ltp.toFixed(2)}</div></div>
                  <div className="st-mcard"><div className="st-mc-l">Stop Loss</div><div className="st-mc-v red">₹{stopLoss}</div></div>
                  <div className="st-mcard full"><div className="st-mc-l">Target</div><div className="st-mc-v green">₹{target}</div></div>
                  <div className="st-mcard"><div className="st-mc-l">Risk/Reward</div><div className="st-mc-v">{rr}</div></div>
                  <div className="st-mcard"><div className="st-mc-l">ATR(14)</div><div className="st-mc-v">₹{atrV?.toFixed(1) ?? "--"}</div></div>
                </div>
              </div>
            )}

            <div className="st-ind-sec">
              <div className="st-sec-title">Trend</div>
              <div className="st-ind-row">
                <span className="st-ind-name">SuperTrend</span>
                <span className="st-ind-val" style={{ color: stDir === 1 ? "var(--green)" : "var(--red)" }}>{stDir === 1 ? "BULL ▲" : stDir === -1 ? "BEAR ▼" : "--"}</span>
              </div>
              <div className="st-ind-row">
                <span className="st-ind-name">ADX</span>
                <span className="st-ind-val" style={{ color: "var(--amber)" }}>{adxV?.toFixed(1) ?? "--"}</span>
                <span className={`st-badge ${adxV > 25 ? "buy" : "neu"}`}>{adxV > 40 ? "V.STRONG" : adxV > 25 ? "STRONG" : adxV ? "WEAK" : "--"}</span>
              </div>
              <div className="st-ind-row"><span className="st-ind-name">+DMI</span><span className="st-ind-val" style={{ color: "var(--green)" }}>{pdiV?.toFixed(1) ?? "--"}</span></div>
              <div className="st-ind-row"><span className="st-ind-name">-DMI</span><span className="st-ind-val" style={{ color: "var(--red)" }}>{ndiV?.toFixed(1) ?? "--"}</span></div>
              <div className="st-ind-row">
                <span className="st-ind-name">VWAP</span>
                <span className="st-ind-val" style={{ color: "var(--amber)" }}>{vwapV ? "₹" + vwapV.toFixed(1) : "--"}</span>
                <span className={`st-badge ${ltp > vwapV ? "buy" : "sell"}`}>{ltp > vwapV ? "ABOVE" : "BELOW"}</span>
              </div>
            </div>

            <div className="st-ind-sec">
              <div className="st-sec-title">Momentum</div>
              <div className="st-ind-row">
                <span className="st-ind-name">RSI(14)</span>
                <span className="st-ind-val" style={{ color: rsiV > 70 ? "var(--red)" : rsiV < 30 ? "var(--green)" : "var(--amber)" }}>{rsiV?.toFixed(1) ?? "--"}</span>
                <span className={`st-badge ${rsiV > 70 ? "sell" : rsiV < 30 ? "buy" : "neu"}`}>{rsiSig}</span>
              </div>
              <div className="st-bar-mini"><div className="st-bar-fill" style={{ width: (rsiV ?? 50) + "%", background: "var(--amber)" }} /></div>
              <div style={{ marginTop: 5 }} />
              <div className="st-ind-row"><span className="st-ind-name">Stoch %K</span><span className="st-ind-val" style={{ color: "var(--purple)" }}>{sk?.toFixed(1) ?? "--"}</span></div>
              <div className="st-ind-row"><span className="st-ind-name">Stoch %D</span><span className="st-ind-val" style={{ color: "var(--blue)" }}>{sd?.toFixed(1) ?? "--"}</span></div>
              <div style={{ marginTop: 5 }} />
              <div className="st-ind-row">
                <span className="st-ind-name">MACD</span>
                <span className="st-ind-val" style={{ color: macdV > 0 ? "var(--green)" : "var(--red)" }}>{macdV !== null ? (macdV > 0 ? "+" : "") + macdV?.toFixed(2) : "--"}</span>
              </div>
              <div className="st-ind-row"><span className="st-ind-name">Signal</span><span className="st-ind-val" style={{ color: "var(--text2)" }}>{sigV !== null ? (sigV > 0 ? "+" : "") + sigV?.toFixed(2) : "--"}</span></div>
              <div className="st-ind-row">
                <span className="st-ind-name">Hist</span>
                <span className="st-ind-val" style={{ color: histV > 0 ? "var(--green)" : "var(--red)" }}>{histV !== null ? (histV > 0 ? "+" : "") + histV?.toFixed(2) : "--"}</span>
                <span className={`st-badge ${cross.includes("BULL") ? "buy" : "sell"}`}>{cross}</span>
              </div>
            </div>

            <div className="st-ind-sec">
              <div className="st-sec-title">Volatility</div>
              <div className="st-ind-row"><span className="st-ind-name">BB Upper</span><span className="st-ind-val" style={{ color: "var(--text2)" }}>{bbu ? "₹" + bbu.toFixed(1) : "--"}</span></div>
              <div className="st-ind-row"><span className="st-ind-name">BB Mid</span><span className="st-ind-val" style={{ color: "var(--text2)" }}>{bbm ? "₹" + bbm.toFixed(1) : "--"}</span></div>
              <div className="st-ind-row"><span className="st-ind-name">BB Lower</span><span className="st-ind-val" style={{ color: "var(--text2)" }}>{bbl ? "₹" + bbl.toFixed(1) : "--"}</span></div>
              <div className="st-ind-row"><span className="st-ind-name">BB Width</span><span className="st-ind-val" style={{ color: "var(--blue)" }}>{bbu && bbl && bbm ? ((bbu - bbl) / bbm * 100).toFixed(1) + "%" : "--"}</span></div>
            </div>

            <div className="st-ind-sec">
              <div className="st-sec-title">Volume</div>
              <div className="st-ind-row"><span className="st-ind-name">Volume</span><span className="st-ind-val" style={{ color: "var(--green)" }}>{fmtVol(vol)}</span></div>
              <div className="st-ind-row"><span className="st-ind-name">Avg(20)</span><span className="st-ind-val" style={{ color: "var(--text2)" }}>{fmtVol(Math.round(avgVol))}</span></div>
              <div className="st-ind-row">
                <span className="st-ind-name">OBV</span>
                <span className="st-ind-val" style={{ color: obvTrend.includes("↑") ? "var(--green)" : "var(--red)" }}>{obvTrend}</span>
              </div>
              <div className="st-ind-row">
                <span className="st-ind-name">Vol/Avg</span>
                <span className="st-ind-val" style={{ color: vol > avgVol ? "var(--green)" : "var(--red)" }}>
                  {avgVol ? ((vol / avgVol - 1) * 100 > 0 ? "+" : "") + ((vol / avgVol - 1) * 100).toFixed(0) + "%" : "--"}
                </span>
              </div>
            </div>

            <div className="st-ma-sec">
              <div className="st-sec-title">Moving Averages</div>
              {[
                { key: "ma5", val: ma5V, color: "var(--ma5)" }, { key: "ma9", val: ma9V, color: "var(--ma9)" },
                { key: "ma21", val: ma21V, color: "var(--ma21)" }, { key: "ma50", val: ma50V, color: "var(--ma50)" },
                { key: "ma200", val: ma200V, color: "var(--ma200)" },
              ].map(m => (
                <div key={m.key} className="st-ma-row">
                  <div className="st-ma-dot" style={{ background: m.color }} />
                  <span className="st-ma-name">{m.key.toUpperCase()}</span>
                  <span className="st-ma-val">{m.val ? "₹" + m.val.toFixed(1) : "N/A"}</span>
                  <span className="st-ma-rel" style={{ color: m.val ? (ltp > m.val ? "var(--green)" : "var(--red)") : "var(--text3)" }}>
                    {m.val ? (ltp > m.val ? "▲" : "▼") : ""}
                  </span>
                </div>
              ))}
              <div style={{ borderTop: "1px solid var(--border2)", margin: "7px 0 5px" }} />
              <div className="st-ind-row">
                <span className="st-ind-name">Golden Cross</span>
                <span className={`st-badge ${ma50V > ma200V ? "buy" : "sell"}`}>{ma50V && ma200V ? (ma50V > ma200V ? "50 > 200 ✓" : "50 < 200 ✗") : "N/A"}</span>
              </div>
              <div className="st-ind-row" style={{ marginTop: 3 }}>
                <span className="st-ind-name">Alignment</span>
                <span className={`st-badge ${bullStack ? "buy" : "neu"}`}>{bullStack ? "BULL STACK" : "MIXED"}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
