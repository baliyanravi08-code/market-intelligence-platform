/**
 * StockChart.jsx
 * Location: client/src/pages/StockChart.jsx
 *
 * FIXES vs original:
 *  1. Uses tech._candles from API response (now populated by marketScanner v2)
 *  2. Timeframe value "1hour" → "1hour" (matches server TIMEFRAME_CONFIG keys)
 *  3. Stochastic + RSI + MACD panels use correct candle field names (close/high/low)
 *  4. Loading state properly hides "no candle" message
 *  5. 4H timeframe correctly maps to "4hour" key
 *  6. Retry button works after Upstox fallback data arrives
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createChart, CrosshairMode, LineStyle } from "lightweight-charts";
import { io } from "socket.io-client";

// ── Socket singleton ──────────────────────────────────────────────────────────
let _socket = null;
function getSocket() {
  if (!_socket) _socket = io({ transports: ["websocket"] });
  return _socket;
}

// ── Timeframes — values must match server TIMEFRAME_CONFIG keys exactly ───────
const TIMEFRAMES = [
  { label: "5m",  value: "5min"  },
  { label: "15m", value: "15min" },
  { label: "1h",  value: "1hour" },
  { label: "4h",  value: "4hour" },
  { label: "1D",  value: "1day"  },
  { label: "1W",  value: "1week" },
];

// ── Theme ─────────────────────────────────────────────────────────────────────
const T = {
  bg:        "#050810",
  bgPanel:   "#080c18",
  bgCard:    "#0d1220",
  border:    "#1a2035",
  text:      "#c8d6f0",
  textDim:   "#4a5a80",
  textMuted: "#2a3550",
  green:     "#00e676",
  greenDim:  "rgba(0,230,118,0.15)",
  red:       "#ff3d57",
  redDim:    "rgba(255,61,87,0.15)",
  yellow:    "#ffc947",
  blue:      "#4fc3f7",
  purple:    "#b388ff",
  ema9:      "#ffc947",
  ema21:     "#4fc3f7",
  ema50:     "#ff7043",
  ema200:    "#b388ff",
  bbUpper:   "rgba(100,160,255,0.5)",
  bbLower:   "rgba(100,160,255,0.5)",
  bbMid:     "rgba(100,160,255,0.25)",
  vwap:      "rgba(255,201,71,0.8)",
};

const SIG_COLOR = {
  "STRONG BUY":  "#00e676",
  "BUY":         "#69f0ae",
  "HOLD":        "#ffc947",
  "SELL":        "#ff6e6e",
  "STRONG SELL": "#ff3d57",
};

const BASE_CHART = {
  layout: {
    background: { color: T.bg },
    textColor:  T.textDim,
    fontSize:   11,
    fontFamily: "'JetBrains Mono','Fira Code',monospace",
  },
  grid: {
    vertLines: { color: "rgba(26,32,53,0.8)" },
    horzLines: { color: "rgba(26,32,53,0.8)" },
  },
  crosshair: {
    mode:     CrosshairMode.Normal,
    vertLine: { color: "rgba(100,130,200,0.4)", style: LineStyle.Dashed, labelBackgroundColor: "#1a2035" },
    horzLine: { color: "rgba(100,130,200,0.4)", style: LineStyle.Dashed, labelBackgroundColor: "#1a2035" },
  },
  rightPriceScale: { borderColor: T.border, scaleMargins: { top: 0.05, bottom: 0.05 } },
  timeScale: { borderColor: T.border, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
  handleScroll: true,
  handleScale:  true,
};

// ── EMA helper ────────────────────────────────────────────────────────────────
function buildEMA(closes, times, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out.push({ time: times[i], value: +ema.toFixed(2) });
  }
  return out;
}

function buildBB(closes, times, period = 20, mult = 2) {
  const upper = [], lower = [], mid = [];
  for (let i = period; i < closes.length; i++) {
    const sl  = closes.slice(i - period, i);
    const sma = sl.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(sl.reduce((s, v) => s + (v - sma) ** 2, 0) / period);
    upper.push({ time: times[i], value: +(sma + mult * std).toFixed(2) });
    lower.push({ time: times[i], value: +(sma - mult * std).toFixed(2) });
    mid.push({   time: times[i], value: +sma.toFixed(2) });
  }
  return { upper, lower, mid };
}

function buildRSI(closes, times, period = 14) {
  const out = [];
  for (let i = period + 1; i < closes.length; i++) {
    const sl = closes.slice(i - period - 1, i);
    let g = 0, l = 0;
    for (let j = 1; j < sl.length; j++) {
      const d = sl[j] - sl[j - 1];
      if (d > 0) g += d; else l -= d;
    }
    const al = l / period;
    const rsi = al === 0 ? 100 : 100 - 100 / (1 + (g / period) / al);
    out.push({ time: times[i], value: +rsi.toFixed(2) });
  }
  return out;
}

function buildMACD(closes, times) {
  const ema = (arr, p) => {
    const k = 2 / (p + 1);
    let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    return arr.slice(p).map(v => { e = v * k + e * (1 - k); return e; });
  };
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const mv  = e12.slice(14).map((v, i) => v - e26[i]);
  const sv  = ema(mv, 9);
  const res = { macd: [], signal: [], histogram: [] };
  for (let i = 9; i < mv.length; i++) {
    const t = times[26 + i];
    if (!t) continue;
    res.macd.push({      time: t, value: +mv[i].toFixed(4) });
    res.signal.push({    time: t, value: +sv[i - 9].toFixed(4) });
    res.histogram.push({ time: t, value: +(mv[i] - sv[i - 9]).toFixed(4) });
  }
  return res;
}

function buildStoch(candles, times, period = 14) {
  const kRaw = [];
  for (let i = period - 1; i < candles.length; i++) {
    const sl  = candles.slice(i - period + 1, i + 1);
    const hi  = Math.max(...sl.map(c => c.high));
    const lo  = Math.min(...sl.map(c => c.low));
    const cl  = candles[i].close;
    const kv  = hi === lo ? 50 : ((cl - lo) / (hi - lo)) * 100;
    kRaw.push({ time: times[i], value: +kv.toFixed(2) });
  }
  const d = [];
  for (let i = 2; i < kRaw.length; i++) {
    d.push({ time: kRaw[i].time, value: +((kRaw[i].value + kRaw[i-1].value + kRaw[i-2].value) / 3).toFixed(2) });
  }
  return { k: kRaw, d };
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function StockChart() {
  const { symbol } = useParams();
  const navigate   = useNavigate();

  const [tf,      setTf]      = useState("1day");
  const [tech,    setTech]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [live,    setLive]    = useState(null);
  const [cross,   setCross]   = useState(null);
  const [inds, setInds] = useState({
    ema9: true, ema21: true, ema50: true, ema200: false,
    bb: true, vwap: true, supertrend: true,
    volume: true, rsi: true, macd: true, stoch: false,
  });

  const mainRef  = useRef(null);
  const volRef   = useRef(null);
  const rsiRef   = useRef(null);
  const macdRef  = useRef(null);
  const stochRef = useRef(null);
  const charts   = useRef({});
  const candleSr = useRef(null);
  const liveL    = useRef(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/scanner/technicals/${symbol.toUpperCase()}?timeframe=${tf}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTech(data);
      setLive(data.ltp);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [symbol, tf]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Live price socket ─────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();
    const onTick = ({ symbol: sym, price }) => {
      if (sym === symbol?.toUpperCase()) setLive(price);
    };
    const onBatch = (batch) => {
      const match = batch.find(b => b.key === `${symbol?.toUpperCase()}:${tf}`);
      if (match?.data?.ltp) setLive(match.data.ltp);
    };
    socket.on("backtest-live-tick", onTick);
    socket.on("scanner-tech-batch", onBatch);
    return () => { socket.off("backtest-live-tick", onTick); socket.off("scanner-tech-batch", onBatch); };
  }, [symbol, tf]);

  // ── Update live price line ────────────────────────────────────────────────
  useEffect(() => {
    if (!live || !liveL.current) return;
    try { liveL.current.setPrice(live); } catch {}
  }, [live]);

  // ── Build / rebuild charts when data changes ──────────────────────────────
  useEffect(() => {
    if (loading || !tech) return;

    // Destroy old charts
    Object.values(charts.current).forEach(c => { try { c.remove(); } catch {} });
    charts.current = {};
    candleSr.current = null;
    liveL.current    = null;

    // _candles is populated by marketScanner v2 — array of {time,open,high,low,close,volume}
    const candles = tech._candles || [];
    if (!candles.length || !mainRef.current) return;

    const times  = candles.map(c => c.time);
    const closes = candles.map(c => c.close);

    // ── MAIN candlestick chart ──────────────────────────────────────────────
    const mc = createChart(mainRef.current, { ...BASE_CHART, height: 420, width: mainRef.current.clientWidth });
    charts.current.main = mc;

    const cs = mc.addCandlestickSeries({
      upColor: T.green, downColor: T.red,
      borderUpColor: T.green, borderDownColor: T.red,
      wickUpColor: T.green, wickDownColor: T.red,
    });
    cs.setData(candles);
    candleSr.current = cs;

    // Live price line
    liveL.current = cs.createPriceLine({
      price: live || tech.ltp, color: T.yellow,
      lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: "LIVE",
    });

    // Entry / Target / SL lines
    if (tech.entry) cs.createPriceLine({ price: tech.entry, color: T.blue,  lineWidth: 1, lineStyle: LineStyle.Solid,  axisLabelVisible: true, title: "ENTRY" });
    if (tech.tp)    cs.createPriceLine({ price: tech.tp,    color: T.green, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: `TGT` });
    if (tech.sl)    cs.createPriceLine({ price: tech.sl,    color: T.red,   lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: `SL`  });

    // EMA overlays
    if (inds.ema9) {
      const s = mc.addLineSeries({ color: T.ema9, lineWidth: 1, title: "EMA9", priceLineVisible: false, lastValueVisible: true });
      s.setData(buildEMA(closes, times, 9));
    }
    if (inds.ema21) {
      const s = mc.addLineSeries({ color: T.ema21, lineWidth: 1, title: "EMA21", priceLineVisible: false, lastValueVisible: true });
      s.setData(buildEMA(closes, times, 21));
    }
    if (inds.ema50) {
      const s = mc.addLineSeries({ color: T.ema50, lineWidth: 1, title: "EMA50", priceLineVisible: false, lastValueVisible: true });
      s.setData(buildEMA(closes, times, 50));
    }
    if (inds.ema200) {
      const s = mc.addLineSeries({ color: T.ema200, lineWidth: 1, title: "EMA200", priceLineVisible: false, lastValueVisible: true });
      s.setData(buildEMA(closes, times, 200));
    }

    // Bollinger Bands
    if (inds.bb) {
      const bb = buildBB(closes, times);
      mc.addLineSeries({ color: T.bbUpper, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: LineStyle.Dotted }).setData(bb.upper);
      mc.addLineSeries({ color: T.bbLower, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: LineStyle.Dotted }).setData(bb.lower);
      mc.addLineSeries({ color: T.bbMid,   lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: LineStyle.Dashed  }).setData(bb.mid);
    }

    // VWAP (single value → horizontal segment on last session)
    if (inds.vwap && tech.vwap) {
      const vwapSeries = mc.addLineSeries({ color: T.vwap, lineWidth: 1, title: "VWAP", priceLineVisible: false, lastValueVisible: true });
      vwapSeries.setData(times.slice(-78).map(t => ({ time: t, value: tech.vwap })));
    }

    // Supertrend
    if (inds.supertrend && tech.supertrend?.level) {
      const stColor = tech.supertrend.trend === "BULLISH" ? T.green : T.red;
      const stS = mc.addLineSeries({ color: stColor, lineWidth: 2, title: "ST", priceLineVisible: false, lastValueVisible: true });
      stS.setData(times.slice(-60).map(t => ({ time: t, value: tech.supertrend.level })));
    }

    // Crosshair data
    mc.subscribeCrosshairMove(p => {
      if (!p.time || !p.seriesData) return;
      const bar = p.seriesData.get(cs);
      if (bar) setCross({ time: p.time, ...bar });
    });

    // ── VOLUME panel ────────────────────────────────────────────────────────
    if (inds.volume && volRef.current) {
      const vc = createChart(volRef.current, { ...BASE_CHART, height: 80, width: volRef.current.clientWidth, rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0 }, borderColor: T.border }, timeScale: { visible: false } });
      charts.current.vol = vc;
      const vs = vc.addHistogramSeries({ priceFormat: { type: "volume" } });
      vs.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } });
      vs.setData(candles.map(c => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? "rgba(0,230,118,0.4)" : "rgba(255,61,87,0.4)" })));
      mc.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) vc.timeScale().setVisibleLogicalRange(r); });
    }

    // ── RSI panel ───────────────────────────────────────────────────────────
    if (inds.rsi && rsiRef.current) {
      const rc = createChart(rsiRef.current, { ...BASE_CHART, height: 100, width: rsiRef.current.clientWidth, rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 }, borderColor: T.border }, timeScale: { visible: false } });
      charts.current.rsi = rc;
      const rsiS = rc.addLineSeries({ color: T.purple, lineWidth: 1, title: "RSI", priceLineVisible: false, lastValueVisible: true });
      rsiS.setData(buildRSI(closes, times, 14));
      const tSlice = times.slice(-120);
      rc.addLineSeries({ color: "rgba(255,61,87,0.4)",  lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false }).setData(tSlice.map(t => ({ time: t, value: 70 })));
      rc.addLineSeries({ color: "rgba(0,230,118,0.4)",  lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false }).setData(tSlice.map(t => ({ time: t, value: 30 })));
      rc.addLineSeries({ color: "rgba(100,130,200,0.3)", lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false }).setData(tSlice.map(t => ({ time: t, value: 50 })));
      mc.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) rc.timeScale().setVisibleLogicalRange(r); });
    }

    // ── MACD panel ──────────────────────────────────────────────────────────
    if (inds.macd && macdRef.current) {
      const mcc = createChart(macdRef.current, { ...BASE_CHART, height: 100, width: macdRef.current.clientWidth, rightPriceScale: { scaleMargins: { top: 0.2, bottom: 0.2 }, borderColor: T.border }, timeScale: { visible: false } });
      charts.current.macd = mcc;
      const md = buildMACD(closes, times);
      const hs = mcc.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      hs.setData(md.histogram.map(d => ({ ...d, color: d.value >= 0 ? "rgba(0,230,118,0.6)" : "rgba(255,61,87,0.6)" })));
      mcc.addLineSeries({ color: T.blue,   lineWidth: 1, title: "MACD",   priceLineVisible: false, lastValueVisible: true }).setData(md.macd);
      mcc.addLineSeries({ color: T.yellow, lineWidth: 1, title: "Signal", priceLineVisible: false, lastValueVisible: true, lineStyle: LineStyle.Dashed }).setData(md.signal);
      mc.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) mcc.timeScale().setVisibleLogicalRange(r); });
    }

    // ── STOCHASTIC panel ────────────────────────────────────────────────────
    if (inds.stoch && stochRef.current) {
      const sc = createChart(stochRef.current, { ...BASE_CHART, height: 80, width: stochRef.current.clientWidth, rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 }, borderColor: T.border }, timeScale: { visible: false } });
      charts.current.stoch = sc;
      const st = buildStoch(candles, times, 14);
      sc.addLineSeries({ color: T.blue,   lineWidth: 1, title: "%K", priceLineVisible: false, lastValueVisible: true }).setData(st.k);
      sc.addLineSeries({ color: T.yellow, lineWidth: 1, title: "%D", priceLineVisible: false, lastValueVisible: true, lineStyle: LineStyle.Dashed }).setData(st.d);
      const tSlice = times.slice(-100);
      sc.addLineSeries({ color: "rgba(255,61,87,0.3)",  lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false }).setData(tSlice.map(t => ({ time: t, value: 80 })));
      sc.addLineSeries({ color: "rgba(0,230,118,0.3)",  lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false }).setData(tSlice.map(t => ({ time: t, value: 20 })));
      mc.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) sc.timeScale().setVisibleLogicalRange(r); });
    }

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (mainRef.current)  mc.applyOptions({ width: mainRef.current.clientWidth });
      if (volRef.current   && charts.current.vol)   charts.current.vol.applyOptions({ width: volRef.current.clientWidth });
      if (rsiRef.current   && charts.current.rsi)   charts.current.rsi.applyOptions({ width: rsiRef.current.clientWidth });
      if (macdRef.current  && charts.current.macd)  charts.current.macd.applyOptions({ width: macdRef.current.clientWidth });
      if (stochRef.current && charts.current.stoch) charts.current.stoch.applyOptions({ width: stochRef.current.clientWidth });
    });
    if (mainRef.current) ro.observe(mainRef.current);

    setTimeout(() => mc.timeScale().fitContent(), 80);

    return () => ro.disconnect();
  }, [tech, loading, inds]);

  // ── Render ────────────────────────────────────────────────────────────────
  const sig      = tech?.signal || "—";
  const sigColor = SIG_COLOR[sig] || T.textDim;
  const hasData  = !!(tech?._candles?.length);

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'JetBrains Mono',monospace" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: `1px solid ${T.border}`, background: T.bgPanel, position: "sticky", top: 0, zIndex: 100, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => navigate(-1)} style={{ background: "none", border: `1px solid ${T.border}`, color: T.textDim, cursor: "pointer", padding: "4px 10px", borderRadius: 6, fontSize: 12 }}>← Back</button>
          <span style={{ fontSize: 20, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>{symbol?.toUpperCase()}</span>
          {tech && <span style={{ fontSize: 12, color: sigColor, padding: "2px 10px", background: `${sigColor}18`, borderRadius: 20, border: `1px solid ${sigColor}44` }}>{sig}</span>}
          {live && <span style={{ fontSize: 18, fontWeight: 700, color: T.yellow }}>₹{live.toLocaleString("en-IN", { maximumFractionDigits: 2 })} <span style={{ fontSize: 10, color: T.textDim }}>LIVE</span></span>}
        </div>

        {/* Timeframe switcher */}
        <div style={{ display: "flex", gap: 3, background: T.bgCard, borderRadius: 8, padding: 3, border: `1px solid ${T.border}` }}>
          {TIMEFRAMES.map(t => (
            <button key={t.value} onClick={() => setTf(t.value)} style={{
              padding: "4px 10px", fontSize: 11, fontWeight: 600,
              background: tf === t.value ? "rgba(100,130,200,0.2)" : "none",
              color:      tf === t.value ? T.blue : T.textDim,
              border:     tf === t.value ? `1px solid rgba(100,130,200,0.3)` : "1px solid transparent",
              borderRadius: 5, cursor: "pointer",
            }}>{t.label}</button>
          ))}
        </div>

        {/* Indicator toggles */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {[
            { key: "ema9",   label: "EMA9",  color: T.ema9   },
            { key: "ema21",  label: "EMA21", color: T.ema21  },
            { key: "ema50",  label: "EMA50", color: T.ema50  },
            { key: "ema200", label: "200",   color: T.ema200 },
            { key: "bb",     label: "BB",    color: T.blue   },
            { key: "vwap",   label: "VWAP",  color: T.vwap   },
            { key: "supertrend", label: "ST",color: T.green  },
            { key: "rsi",    label: "RSI",   color: T.purple },
            { key: "macd",   label: "MACD",  color: T.blue   },
            { key: "stoch",  label: "STOCH", color: T.yellow },
          ].map(ind => (
            <button key={ind.key} onClick={() => setInds(p => ({ ...p, [ind.key]: !p[ind.key] }))} style={{
              padding: "2px 7px", fontSize: 10, fontWeight: 600,
              background: inds[ind.key] ? `${ind.color}18` : "none",
              color:      inds[ind.key] ? ind.color : T.textMuted,
              border:     `1px solid ${inds[ind.key] ? ind.color + "44" : T.border}`,
              borderRadius: 4, cursor: "pointer",
            }}>{ind.label}</button>
          ))}
        </div>
      </div>

      {/* Stats bar */}
      {tech && (
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, background: T.bgPanel, overflowX: "auto" }}>
          {[
            { label: "RSI",        value: tech.rsi?.toFixed(1),                       color: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.text },
            { label: "MACD",       value: tech.macd?.crossover,                        color: tech.macd?.crossover === "BULLISH" ? T.green : T.red },
            { label: "Score",      value: tech.techScore,                               color: tech.techScore >= 60 ? T.green : tech.techScore <= 40 ? T.red : T.yellow },
            { label: "ATR",        value: tech.atr?.toFixed(2),                        color: T.text },
            { label: "VWAP",       value: tech.vwap ? `₹${tech.vwap}` : "—",          color: T.yellow },
            { label: "Entry",      value: tech.entry ? `₹${tech.entry}` : "—",        color: T.blue },
            { label: "Target",     value: tech.tp ? `₹${tech.tp}` : "—",              color: T.green },
            { label: "SL",         value: tech.sl ? `₹${tech.sl}` : "—",              color: T.red },
            { label: "Vol×",       value: tech.volRatio ? `${tech.volRatio}x` : "—",  color: tech.volRatio > 2 ? T.green : T.text },
            { label: "MA Signal",  value: tech.maSummary?.summary,                     color: SIG_COLOR[tech.maSummary?.summary] || T.text },
            { label: "Supertrend", value: tech.supertrend?.trend,                      color: tech.supertrend?.trend === "BULLISH" ? T.green : T.red },
            { label: "ADX",        value: tech.adx?.adx?.toFixed(1),                  color: tech.adx?.adx > 25 ? T.yellow : T.textDim },
            { label: "Stoch K",    value: tech.stochastic?.k?.toFixed(1),             color: tech.stochastic?.k > 80 ? T.red : tech.stochastic?.k < 20 ? T.green : T.text },
            { label: "OBV",        value: tech.obv,                                    color: (tech.obv || "").includes("Rising") ? T.green : T.red },
            { label: "MFI",        value: tech.mfi?.toFixed(1),                        color: tech.mfi > 80 ? T.red : tech.mfi < 20 ? T.green : T.text },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ padding: "7px 14px", borderRight: `1px solid ${T.border}`, minWidth: 80, flexShrink: 0 }}>
              <div style={{ fontSize: 9, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: color || T.text }}>{value ?? "—"}</div>
            </div>
          ))}
        </div>
      )}

      {/* Chart area */}
      <div style={{ padding: "0 0 24px" }}>

        {/* Loading spinner */}
        {loading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 460, gap: 12, color: T.textDim }}>
            <div style={{ width: 18, height: 18, border: `2px solid ${T.border}`, borderTopColor: T.blue, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            Loading {symbol} [{tf}]…
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 400, gap: 16, color: T.textDim }}>
            <div style={{ fontSize: 36 }}>📡</div>
            <div>No chart data for <strong>{symbol}</strong> [{tf}]</div>
            <div style={{ fontSize: 12, color: T.textMuted }}>{error}</div>
            <button onClick={fetchData} style={{ padding: "8px 20px", background: T.greenDim, color: T.green, border: `1px solid ${T.green}44`, borderRadius: 8, cursor: "pointer" }}>Retry</button>
          </div>
        )}

        {/* No candles fallback */}
        {!loading && !error && tech && !hasData && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, gap: 12, color: T.textDim }}>
            <div style={{ fontSize: 32 }}>🕯</div>
            <div>Indicators loaded — waiting for candle data</div>
            <div style={{ fontSize: 12, color: T.textMuted }}>NSE intraday fallback may need a moment. Try Retry or switch to 1D.</div>
            <button onClick={fetchData} style={{ padding: "7px 18px", background: T.greenDim, color: T.green, border: `1px solid ${T.green}44`, borderRadius: 7, cursor: "pointer" }}>Retry</button>
          </div>
        )}

        {/* Charts — always rendered (visibility controlled by CSS display) */}
        <div ref={mainRef}  style={{ width: "100%", display: loading || error || !hasData ? "none" : "block" }} />

        {inds.volume && (
          <div style={{ borderTop: `1px solid ${T.border}`, display: loading || error || !hasData ? "none" : "block" }}>
            <div style={{ fontSize: 9, color: T.textMuted, padding: "3px 8px", textTransform: "uppercase", letterSpacing: 1 }}>Volume</div>
            <div ref={volRef} style={{ width: "100%" }} />
          </div>
        )}

        {inds.rsi && (
          <div style={{ borderTop: `1px solid ${T.border}`, display: loading || error || !hasData ? "none" : "block" }}>
            <div style={{ fontSize: 9, color: T.textMuted, padding: "3px 8px", textTransform: "uppercase", letterSpacing: 1 }}>
              RSI(14) — <span style={{ color: tech?.rsi > 70 ? T.red : tech?.rsi < 30 ? T.green : T.purple }}>{tech?.rsi?.toFixed(1)}</span>
            </div>
            <div ref={rsiRef} style={{ width: "100%" }} />
          </div>
        )}

        {inds.macd && (
          <div style={{ borderTop: `1px solid ${T.border}`, display: loading || error || !hasData ? "none" : "block" }}>
            <div style={{ fontSize: 9, color: T.textMuted, padding: "3px 8px", textTransform: "uppercase", letterSpacing: 1 }}>
              MACD — <span style={{ color: tech?.macd?.crossover === "BULLISH" ? T.green : T.red }}>{tech?.macd?.crossover}</span>
              {" "}Hist: <span style={{ color: (tech?.macd?.histogram || 0) >= 0 ? T.green : T.red }}>{tech?.macd?.histogram?.toFixed(3)}</span>
            </div>
            <div ref={macdRef} style={{ width: "100%" }} />
          </div>
        )}

        {inds.stoch && (
          <div style={{ borderTop: `1px solid ${T.border}`, display: loading || error || !hasData ? "none" : "block" }}>
            <div style={{ fontSize: 9, color: T.textMuted, padding: "3px 8px", textTransform: "uppercase", letterSpacing: 1 }}>
              Stoch — K: <span style={{ color: T.blue }}>{tech?.stochastic?.k?.toFixed(1)}</span> D: <span style={{ color: T.yellow }}>{tech?.stochastic?.d?.toFixed(1)}</span>
            </div>
            <div ref={stochRef} style={{ width: "100%" }} />
          </div>
        )}

        {/* OHLCV crosshair tooltip */}
        {cross && hasData && (
          <div style={{ position: "fixed", top: 70, left: 16, background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 7, padding: "6px 12px", fontSize: 11, zIndex: 200, pointerEvents: "none" }}>
            <span style={{ marginRight: 12 }}>O: <span style={{ color: T.text }}>{cross.open?.toFixed(2)}</span></span>
            <span style={{ marginRight: 12 }}>H: <span style={{ color: T.green }}>{cross.high?.toFixed(2)}</span></span>
            <span style={{ marginRight: 12 }}>L: <span style={{ color: T.red }}>{cross.low?.toFixed(2)}</span></span>
            <span>C: <span style={{ color: cross.close >= cross.open ? T.green : T.red }}>{cross.close?.toFixed(2)}</span></span>
          </div>
        )}
      </div>
    </div>
  );
}
