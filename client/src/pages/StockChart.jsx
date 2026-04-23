/**
 * StockChart.jsx
 * Location: client/src/pages/StockChart.jsx   ← NEW FILE
 *
 * A full TradingView-style chart page using lightweight-charts.
 * Features:
 *  - Candlestick chart with EMA 9/21/50/200, Bollinger Bands, VWAP, Supertrend
 *  - Volume bars panel
 *  - RSI panel with 30/70 levels
 *  - MACD panel with histogram + signal
 *  - Stochastic panel
 *  - Entry / Target / SL horizontal lines from your signal
 *  - Live price line that updates via socket
 *  - Timeframe switcher: 5min, 15min, 1hr, 4hr, 1D, 1W
 *  - Signal badge overlay
 *
 * Setup:
 *   npm install lightweight-charts   (in client/)
 *
 * Add route in your router:
 *   <Route path="/chart/:symbol" element={<StockChart />} />
 *
 * Link from scanner row (onClick):
 *   navigate(`/chart/${stock.symbol}`)
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createChart, CrosshairMode, LineStyle, PriceScaleMode } from "lightweight-charts";
import { io } from "socket.io-client";

// ── Socket singleton ──────────────────────────────────────────────────────────
let _socket = null;
function getSocket() {
  if (!_socket) _socket = io({ transports: ["websocket"] });
  return _socket;
}

// ── Timeframes ────────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { label: "5m",  value: "5min"  },
  { label: "15m", value: "15min" },
  { label: "1h",  value: "1hour" },
  { label: "4h",  value: "4hour" },
  { label: "1D",  value: "1day"  },
  { label: "1W",  value: "1week" },
];

// ── Theme ─────────────────────────────────────────────────────────────────────
const THEME = {
  bg:         "#050810",
  bgPanel:    "#080c18",
  bgCard:     "#0d1220",
  border:     "#1a2035",
  text:       "#c8d6f0",
  textDim:    "#4a5a80",
  textMuted:  "#2a3550",
  green:      "#00e676",
  greenDim:   "rgba(0,230,118,0.15)",
  red:        "#ff3d57",
  redDim:     "rgba(255,61,87,0.15)",
  yellow:     "#ffc947",
  blue:       "#4fc3f7",
  purple:     "#b388ff",
  ema9:       "#ffc947",
  ema21:      "#4fc3f7",
  ema50:      "#ff7043",
  ema200:     "#b388ff",
  bbUpper:    "rgba(100,160,255,0.5)",
  bbLower:    "rgba(100,160,255,0.5)",
  bbMid:      "rgba(100,160,255,0.25)",
  vwap:       "rgba(255,201,71,0.8)",
  superBull:  "#00e676",
  superBear:  "#ff3d57",
};

// ── Chart config ──────────────────────────────────────────────────────────────
const CHART_OPTIONS = {
  layout: {
    background:  { color: THEME.bg },
    textColor:   THEME.textDim,
    fontSize:    11,
    fontFamily:  "'JetBrains Mono', 'Fira Code', monospace",
  },
  grid: {
    vertLines:   { color: "rgba(26,32,53,0.8)" },
    horzLines:   { color: "rgba(26,32,53,0.8)" },
  },
  crosshair: {
    mode:        CrosshairMode.Normal,
    vertLine:    { color: "rgba(100,130,200,0.4)", style: LineStyle.Dashed, labelBackgroundColor: "#1a2035" },
    horzLine:    { color: "rgba(100,130,200,0.4)", style: LineStyle.Dashed, labelBackgroundColor: "#1a2035" },
  },
  rightPriceScale: {
    borderColor: THEME.border,
    scaleMargins: { top: 0.05, bottom: 0.05 },
  },
  timeScale: {
    borderColor:        THEME.border,
    timeVisible:        true,
    secondsVisible:     false,
    fixLeftEdge:        true,
    fixRightEdge:       true,
    tickMarkFormatter:  undefined,
  },
  handleScroll:    true,
  handleScale:     true,
};

// ── Signal colors ─────────────────────────────────────────────────────────────
const SIG_COLOR = {
  "STRONG BUY":  THEME.green,
  "BUY":         "#69f0ae",
  "HOLD":        THEME.yellow,
  "SELL":        "#ff6e6e",
  "STRONG SELL": THEME.red,
};

export default function StockChart() {
  const { symbol }   = useParams();
  const navigate     = useNavigate();
  const [tf, setTf]  = useState("1day");
  const [tech, setTech]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [livePrice, setLive]  = useState(null);
  const [crosshairData, setCross] = useState(null);
  const [indicators, setIndicators] = useState({
    ema9: true, ema21: true, ema50: true, ema200: false,
    bb: true, vwap: true, supertrend: true,
    volume: true, rsi: true, macd: true, stoch: false,
  });

  // Chart container refs
  const mainRef   = useRef(null);
  const rsiRef    = useRef(null);
  const macdRef   = useRef(null);
  const stochRef  = useRef(null);
  const volRef    = useRef(null);

  // Chart instance refs
  const charts      = useRef({});
  const series      = useRef({});
  const liveLine    = useRef(null);
  const entryLines  = useRef([]);

  // ── Fetch candle data + technicals ─────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scanner/technicals/${symbol.toUpperCase()}?timeframe=${tf}`);
      if (!res.ok) throw new Error("API error");
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

  // ── Live price via socket ─────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();
    socket.on("scanner-tech-batch", (batch) => {
      const match = batch.find(b => b.key === `${symbol?.toUpperCase()}:${tf}`);
      if (match) setLive(match.data.ltp);
    });
    socket.on("market-tick", (ticks) => {
      // index ticks — not used for stock LTP here
    });
    socket.on("backtest-live-tick", ({ symbol: sym, price }) => {
      if (sym === symbol?.toUpperCase()) setLive(price);
    });
    return () => {
      socket.off("scanner-tech-batch");
      socket.off("market-tick");
      socket.off("backtest-live-tick");
    };
  }, [symbol, tf]);

  // ── Build charts when tech data arrives ──────────────────────────────────
  useEffect(() => {
    if (!tech || loading) return;

    // Clean up old charts
    Object.values(charts.current).forEach(c => { try { c.remove(); } catch {} });
    charts.current = {};
    series.current = {};
    entryLines.current = [];

    const candles = tech._candles || [];
    // If no raw candles in response, build synthetic from tech data
    // (you can add _candles to your API response — see backend note below)
    if (!candles.length) {
      // Show a "no candle data" placeholder — just show indicator panels
      renderIndicatorOnly(tech);
      return;
    }

    buildCharts(tech, candles);
  }, [tech, loading, indicators]);

  // ── Update live price line ────────────────────────────────────────────────
  useEffect(() => {
    if (!livePrice || !series.current.candle) return;
    try {
      if (liveLine.current) {
        liveLine.current.setPrice(livePrice);
      }
    } catch {}
  }, [livePrice]);

  function buildCharts(tech, candles) {
    if (!mainRef.current) return;

    // ── MAIN CHART ──────────────────────────────────────────────────────────
    const mainChart = createChart(mainRef.current, {
      ...CHART_OPTIONS,
      height: 420,
      width:  mainRef.current.clientWidth,
    });
    charts.current.main = mainChart;

    // Candlestick series
    const candleSeries = mainChart.addCandlestickSeries({
      upColor:          THEME.green,
      downColor:        THEME.red,
      borderUpColor:    THEME.green,
      borderDownColor:  THEME.red,
      wickUpColor:      THEME.green,
      wickDownColor:    THEME.red,
    });
    candleSeries.setData(candles);
    series.current.candle = candleSeries;

    // Live price line
    liveLine.current = candleSeries.createPriceLine({
      price:     tech.ltp,
      color:     THEME.yellow,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title:     "LIVE",
    });

    // Entry / Target / SL lines
    if (tech.entry) {
      entryLines.current.push(candleSeries.createPriceLine({
        price: tech.entry, color: THEME.blue,
        lineWidth: 1, lineStyle: LineStyle.Solid,
        axisLabelVisible: true, title: "ENTRY",
      }));
    }
    if (tech.tp) {
      entryLines.current.push(candleSeries.createPriceLine({
        price: tech.tp, color: THEME.green,
        lineWidth: 1, lineStyle: LineStyle.Dotted,
        axisLabelVisible: true, title: `TGT ${tech.tp}`,
      }));
    }
    if (tech.sl) {
      entryLines.current.push(candleSeries.createPriceLine({
        price: tech.sl, color: THEME.red,
        lineWidth: 1, lineStyle: LineStyle.Dotted,
        axisLabelVisible: true, title: `SL ${tech.sl}`,
      }));
    }

    // EMA lines
    const closes = candles.map(c => c.close);
    const times  = candles.map(c => c.time);

    if (indicators.ema9 && tech.emas?.ema9) {
      const ema9Data = computeEMAData(closes, times, 9);
      const s = mainChart.addLineSeries({ color: THEME.ema9, lineWidth: 1, title: "EMA9", priceLineVisible: false, lastValueVisible: true });
      s.setData(ema9Data);
      series.current.ema9 = s;
    }
    if (indicators.ema21 && tech.emas?.ema21) {
      const ema21Data = computeEMAData(closes, times, 21);
      const s = mainChart.addLineSeries({ color: THEME.ema21, lineWidth: 1, title: "EMA21", priceLineVisible: false, lastValueVisible: true });
      s.setData(ema21Data);
      series.current.ema21 = s;
    }
    if (indicators.ema50 && tech.emas?.ema50) {
      const ema50Data = computeEMAData(closes, times, 50);
      const s = mainChart.addLineSeries({ color: THEME.ema50, lineWidth: 1, title: "EMA50", priceLineVisible: false, lastValueVisible: true });
      s.setData(ema50Data);
      series.current.ema50 = s;
    }
    if (indicators.ema200 && tech.emas?.ema200) {
      const ema200Data = computeEMAData(closes, times, 200);
      const s = mainChart.addLineSeries({ color: THEME.ema200, lineWidth: 1, title: "EMA200", priceLineVisible: false, lastValueVisible: true });
      s.setData(ema200Data);
      series.current.ema200 = s;
    }

    // Bollinger Bands
    if (indicators.bb) {
      const bbData = computeBBData(closes, times, 20, 2);
      const upper = mainChart.addLineSeries({ color: THEME.bbUpper, lineWidth: 1, title: "BB+", priceLineVisible: false, lastValueVisible: false, lineStyle: LineStyle.Dotted });
      const lower = mainChart.addLineSeries({ color: THEME.bbLower, lineWidth: 1, title: "BB-", priceLineVisible: false, lastValueVisible: false, lineStyle: LineStyle.Dotted });
      const mid   = mainChart.addLineSeries({ color: THEME.bbMid,   lineWidth: 1, title: "BB~", priceLineVisible: false, lastValueVisible: false, lineStyle: LineStyle.Dashed });
      upper.setData(bbData.upper);
      lower.setData(bbData.lower);
      mid.setData(bbData.mid);
    }

    // VWAP
    if (indicators.vwap && tech.vwap) {
      const vwapLine = mainChart.addLineSeries({ color: THEME.vwap, lineWidth: 1, title: "VWAP", priceLineVisible: false, lastValueVisible: true });
      // VWAP is a single value — draw as horizontal line across last N candles
      const vwapData = times.slice(-Math.min(times.length, 78)).map(t => ({ time: t, value: tech.vwap }));
      vwapLine.setData(vwapData);
    }

    // Supertrend (simplified — colour the last bar based on trend)
    if (indicators.supertrend && tech.supertrend) {
      const stColor = tech.supertrend.trend === "BULLISH" ? THEME.superBull : THEME.superBear;
      const stLine  = mainChart.addLineSeries({ color: stColor, lineWidth: 2, title: "ST", priceLineVisible: false, lastValueVisible: true });
      const stData  = times.slice(-Math.min(times.length, 50)).map(t => ({ time: t, value: tech.supertrend.level }));
      stLine.setData(stData);
    }

    // Crosshair sync + data display
    mainChart.subscribeCrosshairMove(param => {
      if (!param.time || !param.seriesData) return;
      const bar = param.seriesData.get(candleSeries);
      if (bar) setCross({ time: param.time, ...bar });
    });

    // ── VOLUME PANEL ────────────────────────────────────────────────────────
    if (indicators.volume && volRef.current) {
      const volChart = createChart(volRef.current, {
        ...CHART_OPTIONS,
        height: 80,
        width:  volRef.current.clientWidth,
        rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0 }, borderColor: THEME.border },
        timeScale: { visible: false },
      });
      charts.current.vol = volChart;
      const volSeries = volChart.addHistogramSeries({
        color:     "rgba(100,130,200,0.4)",
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0 } });
      const volData = candles.map(c => ({
        time:  c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? "rgba(0,230,118,0.4)" : "rgba(255,61,87,0.4)",
      }));
      volSeries.setData(volData);

      // Sync time scale
      mainChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range) volChart.timeScale().setVisibleLogicalRange(range);
      });
    }

    // ── RSI PANEL ───────────────────────────────────────────────────────────
    if (indicators.rsi && rsiRef.current) {
      const rsiChart = createChart(rsiRef.current, {
        ...CHART_OPTIONS,
        height: 100,
        width:  rsiRef.current.clientWidth,
        rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 }, borderColor: THEME.border },
        timeScale: { visible: false },
      });
      charts.current.rsi = rsiChart;

      const rsiData = computeRSIData(closes, times, 14);
      const rsiSeries = rsiChart.addLineSeries({
        color: THEME.purple, lineWidth: 1, title: "RSI",
        priceLineVisible: false, lastValueVisible: true,
      });
      rsiSeries.setData(rsiData);

      // Overbought / Oversold lines
      const obLine = rsiChart.addLineSeries({ color: "rgba(255,61,87,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
      const osLine = rsiChart.addLineSeries({ color: "rgba(0,230,118,0.4)", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
      const mid50  = rsiChart.addLineSeries({ color: "rgba(100,130,200,0.3)", lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });

      obLine.setData(times.slice(-100).map(t => ({ time: t, value: 70 })));
      osLine.setData(times.slice(-100).map(t => ({ time: t, value: 30 })));
      mid50.setData(times.slice(-100).map(t => ({ time: t, value: 50 })));

      mainChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range) rsiChart.timeScale().setVisibleLogicalRange(range);
      });
    }

    // ── MACD PANEL ──────────────────────────────────────────────────────────
    if (indicators.macd && macdRef.current) {
      const macdChart = createChart(macdRef.current, {
        ...CHART_OPTIONS,
        height: 100,
        width:  macdRef.current.clientWidth,
        rightPriceScale: { scaleMargins: { top: 0.2, bottom: 0.2 }, borderColor: THEME.border },
        timeScale: { visible: false },
      });
      charts.current.macd = macdChart;

      const macdData = computeMACDData(closes, times);

      const histSeries = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      histSeries.setData(macdData.histogram.map(d => ({
        ...d,
        color: d.value >= 0 ? "rgba(0,230,118,0.6)" : "rgba(255,61,87,0.6)",
      })));

      const macdLine = macdChart.addLineSeries({ color: THEME.blue, lineWidth: 1, title: "MACD", priceLineVisible: false, lastValueVisible: true });
      const sigLine  = macdChart.addLineSeries({ color: THEME.yellow, lineWidth: 1, title: "Signal", priceLineVisible: false, lastValueVisible: true, lineStyle: LineStyle.Dashed });
      macdLine.setData(macdData.macd);
      sigLine.setData(macdData.signal);

      mainChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range) macdChart.timeScale().setVisibleLogicalRange(range);
      });
    }

    // ── STOCHASTIC PANEL ────────────────────────────────────────────────────
    if (indicators.stoch && stochRef.current && tech.stochastic) {
      const stochChart = createChart(stochRef.current, {
        ...CHART_OPTIONS,
        height: 80,
        width:  stochRef.current.clientWidth,
        rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 }, borderColor: THEME.border },
        timeScale: { visible: false },
      });
      charts.current.stoch = stochChart;
      // Stochastic lines (simplified — using last known K/D values)
      const kLine = stochChart.addLineSeries({ color: THEME.blue,   lineWidth: 1, title: "%K", priceLineVisible: false, lastValueVisible: true });
      const dLine = stochChart.addLineSeries({ color: THEME.yellow, lineWidth: 1, title: "%D", priceLineVisible: false, lastValueVisible: true, lineStyle: LineStyle.Dashed });
      const stochData = computeStochData(candles, times, 14);
      kLine.setData(stochData.k);
      dLine.setData(stochData.d);
      const ob = stochChart.addLineSeries({ color: "rgba(255,61,87,0.3)", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
      const os = stochChart.addLineSeries({ color: "rgba(0,230,118,0.3)", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
      ob.setData(times.slice(-100).map(t => ({ time: t, value: 80 })));
      os.setData(times.slice(-100).map(t => ({ time: t, value: 20 })));

      mainChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range) stochChart.timeScale().setVisibleLogicalRange(range);
      });
    }

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (mainRef.current)  mainChart.applyOptions({ width: mainRef.current.clientWidth });
      if (volRef.current && charts.current.vol)   charts.current.vol.applyOptions({ width: volRef.current.clientWidth });
      if (rsiRef.current && charts.current.rsi)   charts.current.rsi.applyOptions({ width: rsiRef.current.clientWidth });
      if (macdRef.current && charts.current.macd) charts.current.macd.applyOptions({ width: macdRef.current.clientWidth });
    });
    if (mainRef.current) ro.observe(mainRef.current);

    // Fit content
    setTimeout(() => mainChart.timeScale().fitContent(), 100);
  }

  function renderIndicatorOnly(tech) {
    // No candle data — show a "connect Upstox" message
  }

  // ── Indicator computations ─────────────────────────────────────────────────
  function computeEMAData(closes, times, period) {
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result = [];
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      result.push({ time: times[i], value: +ema.toFixed(2) });
    }
    return result;
  }

  function computeBBData(closes, times, period, mult) {
    const upper = [], lower = [], mid = [];
    for (let i = period; i < closes.length; i++) {
      const slice = closes.slice(i - period, i);
      const sma   = slice.reduce((a, b) => a + b, 0) / period;
      const std   = Math.sqrt(slice.reduce((s, v) => s + (v - sma) ** 2, 0) / period);
      upper.push({ time: times[i], value: +(sma + mult * std).toFixed(2) });
      lower.push({ time: times[i], value: +(sma - mult * std).toFixed(2) });
      mid.push({   time: times[i], value: +sma.toFixed(2) });
    }
    return { upper, lower, mid };
  }

  function computeRSIData(closes, times, period) {
    const result = [];
    for (let i = period + 1; i < closes.length; i++) {
      const slice = closes.slice(i - period - 1, i);
      let gains = 0, losses = 0;
      for (let j = 1; j < slice.length; j++) {
        const d = slice[j] - slice[j - 1];
        if (d > 0) gains += d; else losses -= d;
      }
      const avgLoss = losses / period;
      const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + (gains / period) / avgLoss);
      result.push({ time: times[i], value: +rsi.toFixed(2) });
    }
    return result;
  }

  function computeMACDData(closes, times) {
    const ema = (arr, p) => {
      const k = 2 / (p + 1);
      let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
      return arr.slice(p).map(v => { e = v * k + e * (1 - k); return e; });
    };
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const startIdx = 26;
    const macdVals = ema12.slice(startIdx - 12).map((v, i) => v - ema26[i]);
    const sigVals  = ema(macdVals, 9);
    const sigStart = 9;
    const result = { macd: [], signal: [], histogram: [] };
    for (let i = sigStart; i < macdVals.length; i++) {
      const t = times[startIdx + i];
      if (!t) continue;
      result.macd.push({      time: t, value: +macdVals[i].toFixed(4) });
      result.signal.push({    time: t, value: +sigVals[i - sigStart].toFixed(4) });
      result.histogram.push({ time: t, value: +(macdVals[i] - sigVals[i - sigStart]).toFixed(4) });
    }
    return result;
  }

  function computeStochData(candles, times, period) {
    const k = [], d = [];
    const kRaw = [];
    for (let i = period - 1; i < candles.length; i++) {
      const slice = candles.slice(i - period + 1, i + 1);
      const high  = Math.max(...slice.map(c => c.high));
      const low   = Math.min(...slice.map(c => c.low));
      const close = candles[i].close;
      const kv    = high === low ? 50 : ((close - low) / (high - low)) * 100;
      kRaw.push({ time: times[i], value: +kv.toFixed(2) });
      k.push({ time: times[i], value: +kv.toFixed(2) });
    }
    // D = 3-period SMA of K
    for (let i = 2; i < kRaw.length; i++) {
      const dv = (kRaw[i].value + kRaw[i-1].value + kRaw[i-2].value) / 3;
      d.push({ time: kRaw[i].time, value: +dv.toFixed(2) });
    }
    return { k, d };
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const sig     = tech?.signal || "—";
  const sigColor = SIG_COLOR[sig] || THEME.textDim;

  return (
    <div style={{ minHeight: "100vh", background: THEME.bg, color: THEME.text, fontFamily: "'JetBrains Mono', monospace" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: `1px solid ${THEME.border}`, background: THEME.bgPanel, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button onClick={() => navigate(-1)} style={{ background: "none", border: `1px solid ${THEME.border}`, color: THEME.textDim, cursor: "pointer", padding: "4px 10px", borderRadius: 6, fontSize: 13 }}>← Back</button>
          <div>
            <span style={{ fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>{symbol?.toUpperCase()}</span>
            {tech && <span style={{ marginLeft: 12, fontSize: 14, color: sigColor, padding: "2px 10px", background: `${sigColor}18`, borderRadius: 20, border: `1px solid ${sigColor}44` }}>{sig}</span>}
          </div>
          {livePrice && (
            <div style={{ fontSize: 20, fontWeight: 700, color: THEME.yellow }}>
              ₹{livePrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              <span style={{ fontSize: 11, color: THEME.textDim, marginLeft: 6 }}>LIVE</span>
            </div>
          )}
        </div>

        {/* Timeframe switcher */}
        <div style={{ display: "flex", gap: 4, background: THEME.bgCard, borderRadius: 8, padding: 3, border: `1px solid ${THEME.border}` }}>
          {TIMEFRAMES.map(t => (
            <button key={t.value} onClick={() => setTf(t.value)} style={{
              padding: "5px 12px", fontSize: 12, fontWeight: 600,
              background: tf === t.value ? "rgba(100,130,200,0.2)" : "none",
              color:      tf === t.value ? THEME.blue : THEME.textDim,
              border:     tf === t.value ? `1px solid rgba(100,130,200,0.3)` : "1px solid transparent",
              borderRadius: 6, cursor: "pointer", transition: "all 0.15s",
            }}>{t.label}</button>
          ))}
        </div>

        {/* Indicator toggles */}
        <div style={{ display: "flex", gap: 6 }}>
          {[
            { key: "ema9",       label: "EMA9",  color: THEME.ema9 },
            { key: "ema21",      label: "EMA21", color: THEME.ema21 },
            { key: "ema50",      label: "EMA50", color: THEME.ema50 },
            { key: "ema200",     label: "EMA200",color: THEME.ema200 },
            { key: "bb",         label: "BB",    color: THEME.blue },
            { key: "vwap",       label: "VWAP",  color: THEME.vwap },
            { key: "supertrend", label: "ST",    color: THEME.green },
            { key: "rsi",        label: "RSI",   color: THEME.purple },
            { key: "macd",       label: "MACD",  color: THEME.blue },
            { key: "stoch",      label: "STOCH", color: THEME.yellow },
          ].map(ind => (
            <button key={ind.key} onClick={() => setIndicators(p => ({ ...p, [ind.key]: !p[ind.key] }))} style={{
              padding: "3px 8px", fontSize: 10, fontWeight: 600,
              background: indicators[ind.key] ? `${ind.color}18` : "none",
              color:      indicators[ind.key] ? ind.color : THEME.textMuted,
              border:     `1px solid ${indicators[ind.key] ? ind.color + "44" : THEME.border}`,
              borderRadius: 4, cursor: "pointer",
            }}>{ind.label}</button>
          ))}
        </div>
      </div>

      {/* ── Stats bar ──────────────────────────────────────────────────────── */}
      {tech && (
        <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${THEME.border}`, background: THEME.bgPanel, overflowX: "auto" }}>
          {[
            { label: "RSI",       value: tech.rsi?.toFixed(1),          color: tech.rsi > 70 ? THEME.red : tech.rsi < 30 ? THEME.green : THEME.text },
            { label: "MACD",      value: tech.macd?.crossover,           color: tech.macd?.crossover === "BULLISH" ? THEME.green : THEME.red },
            { label: "Tech Score",value: tech.techScore,                  color: tech.techScore >= 60 ? THEME.green : tech.techScore <= 40 ? THEME.red : THEME.yellow },
            { label: "ATR",       value: tech.atr?.toFixed(2),           color: THEME.text },
            { label: "VWAP",      value: tech.vwap ? `₹${tech.vwap}` : "—", color: THEME.vwap },
            { label: "Entry",     value: tech.entry ? `₹${tech.entry}` : "—", color: THEME.blue },
            { label: "Target",    value: tech.tp    ? `₹${tech.tp}`    : "—", color: THEME.green },
            { label: "SL",        value: tech.sl    ? `₹${tech.sl}`    : "—", color: THEME.red },
            { label: "Vol Ratio", value: tech.volRatio ? `${tech.volRatio}x` : "—", color: tech.volRatio > 2 ? THEME.green : THEME.text },
            { label: "MA Signal", value: tech.maSummary?.summary,        color: SIG_COLOR[tech.maSummary?.summary] || THEME.text },
            { label: "Supertrend",value: tech.supertrend?.trend,          color: tech.supertrend?.trend === "BULLISH" ? THEME.green : THEME.red },
            { label: "ADX",       value: tech.adx?.adx?.toFixed(1),      color: tech.adx?.adx > 25 ? THEME.yellow : THEME.textDim },
            { label: "Stoch K",   value: tech.stochastic?.k?.toFixed(1), color: tech.stochastic?.k > 80 ? THEME.red : tech.stochastic?.k < 20 ? THEME.green : THEME.text },
            { label: "OBV",       value: tech.obv,                        color: (tech.obv || "").includes("Rising") ? THEME.green : THEME.red },
            { label: "MFI",       value: tech.mfi?.toFixed(1),            color: tech.mfi > 80 ? THEME.red : tech.mfi < 20 ? THEME.green : THEME.text },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ padding: "8px 16px", borderRight: `1px solid ${THEME.border}`, minWidth: 90, flexShrink: 0 }}>
              <div style={{ fontSize: 9, color: THEME.textMuted, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: color || THEME.text }}>{value ?? "—"}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Chart area ─────────────────────────────────────────────────────── */}
      <div style={{ padding: "0 0 16px" }}>

        {loading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 500, gap: 12, color: THEME.textDim }}>
            <div style={{ width: 20, height: 20, border: `2px solid ${THEME.border}`, borderTopColor: THEME.blue, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            Loading {symbol} [{tf}]...
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {error && !loading && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 400, gap: 16, color: THEME.textDim }}>
            <div style={{ fontSize: 40 }}>📡</div>
            <div style={{ fontSize: 14 }}>No chart data for {symbol} [{tf}]</div>
            <div style={{ fontSize: 12, color: THEME.textMuted }}>Make sure Upstox is connected and the symbol is valid</div>
            <button onClick={fetchData} style={{ padding: "8px 20px", background: THEME.greenDim, color: THEME.green, border: `1px solid ${THEME.green}44`, borderRadius: 8, cursor: "pointer" }}>Retry</button>
          </div>
        )}

        {!loading && !error && tech && !tech._candles?.length && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, gap: 16, color: THEME.textDim }}>
            <div style={{ fontSize: 36 }}>🕯</div>
            <div style={{ fontSize: 14 }}>Indicators loaded — candle data needs backend update</div>
            <div style={{ fontSize: 12, color: THEME.textMuted, maxWidth: 480, textAlign: "center" }}>
              Add <code style={{ color: THEME.yellow, background: THEME.bgCard, padding: "2px 6px", borderRadius: 4 }}>_candles</code> array to your <code style={{ color: THEME.yellow, background: THEME.bgCard, padding: "2px 6px", borderRadius: 4 }}>/api/scanner/technicals</code> response. See backend note below.
            </div>
          </div>
        )}

        {/* Main candlestick chart */}
        <div ref={mainRef} style={{ width: "100%", display: loading || error ? "none" : "block" }} />

        {/* Volume panel */}
        {indicators.volume && (
          <div style={{ borderTop: `1px solid ${THEME.border}` }}>
            <div style={{ fontSize: 9, color: THEME.textMuted, padding: "4px 8px", textTransform: "uppercase", letterSpacing: 1 }}>Volume</div>
            <div ref={volRef} style={{ width: "100%", display: loading || error ? "none" : "block" }} />
          </div>
        )}

        {/* RSI panel */}
        {indicators.rsi && (
          <div style={{ borderTop: `1px solid ${THEME.border}` }}>
            <div style={{ fontSize: 9, color: THEME.textMuted, padding: "4px 8px", textTransform: "uppercase", letterSpacing: 1 }}>
              RSI (14) — Current: <span style={{ color: tech?.rsi > 70 ? THEME.red : tech?.rsi < 30 ? THEME.green : THEME.purple }}>{tech?.rsi?.toFixed(1)}</span>
            </div>
            <div ref={rsiRef} style={{ width: "100%", display: loading || error ? "none" : "block" }} />
          </div>
        )}

        {/* MACD panel */}
        {indicators.macd && (
          <div style={{ borderTop: `1px solid ${THEME.border}` }}>
            <div style={{ fontSize: 9, color: THEME.textMuted, padding: "4px 8px", textTransform: "uppercase", letterSpacing: 1 }}>
              MACD (12,26,9) — <span style={{ color: tech?.macd?.crossover === "BULLISH" ? THEME.green : THEME.red }}>{tech?.macd?.crossover}</span>
              {" "} Hist: <span style={{ color: (tech?.macd?.histogram || 0) >= 0 ? THEME.green : THEME.red }}>{tech?.macd?.histogram?.toFixed(2)}</span>
            </div>
            <div ref={macdRef} style={{ width: "100%", display: loading || error ? "none" : "block" }} />
          </div>
        )}

        {/* Stochastic panel */}
        {indicators.stoch && (
          <div style={{ borderTop: `1px solid ${THEME.border}` }}>
            <div style={{ fontSize: 9, color: THEME.textMuted, padding: "4px 8px", textTransform: "uppercase", letterSpacing: 1 }}>
              Stochastic — K: <span style={{ color: THEME.blue }}>{tech?.stochastic?.k?.toFixed(1)}</span> D: <span style={{ color: THEME.yellow }}>{tech?.stochastic?.d?.toFixed(1)}</span>
            </div>
            <div ref={stochRef} style={{ width: "100%", display: loading || error ? "none" : "block" }} />
          </div>
        )}

        {/* Crosshair OHLCV tooltip */}
        {crosshairData && (
          <div style={{ position: "fixed", top: 80, left: 20, background: THEME.bgCard, border: `1px solid ${THEME.border}`, borderRadius: 8, padding: "8px 14px", fontSize: 12, zIndex: 200, pointerEvents: "none" }}>
            <div style={{ display: "flex", gap: 16 }}>
              <span>O: <span style={{ color: THEME.text }}>{crosshairData.open?.toFixed(2)}</span></span>
              <span>H: <span style={{ color: THEME.green }}>{crosshairData.high?.toFixed(2)}</span></span>
              <span>L: <span style={{ color: THEME.red }}>{crosshairData.low?.toFixed(2)}</span></span>
              <span>C: <span style={{ color: crosshairData.close >= crosshairData.open ? THEME.green : THEME.red }}>{crosshairData.close?.toFixed(2)}</span></span>
            </div>
          </div>
        )}
      </div>

      {/* ── Backend note ────────────────────────────────────────────────────── */}
      <div style={{ margin: "0 16px 24px", padding: 16, background: THEME.bgCard, border: `1px solid ${THEME.border}`, borderRadius: 10, fontSize: 12, color: THEME.textDim }}>
        <div style={{ color: THEME.yellow, fontWeight: 700, marginBottom: 8 }}>📝 Backend: Add candle data to API response</div>
        <div style={{ marginBottom: 6 }}>In <code style={{ color: THEME.blue }}>marketScanner.js → getTechnicalsForTimeframe()</code>, after <code style={{ color: THEME.blue }}>computeTechnicals()</code>, add:</div>
        <pre style={{ background: THEME.bg, padding: 12, borderRadius: 6, overflow: "auto", color: THEME.text, fontSize: 11 }}>{`// After: const result = computeTechnicals(symbol, candles);
if (result) {
  // Add raw candles for chart rendering (OHLCV)
  result._candles = candles.slice(-300).map((c, i) => ({
    time:   Math.floor(Date.now()/1000) - (candles.length - 1 - i) * getTFSeconds(timeframe),
    open:   c.o, high: c.h, low: c.l, close: c.c, volume: c.v || 0,
  }));
  result.timeframe = timeframe;
  techCache.set(cacheKey, result);
}

// Add this helper:
function getTFSeconds(tf) {
  const map = { "5min":300, "15min":900, "1hour":3600, "4hour":14400, "1day":86400, "1week":604800 };
  return map[tf] || 86400;
}`}</pre>
      </div>
    </div>
  );
}
