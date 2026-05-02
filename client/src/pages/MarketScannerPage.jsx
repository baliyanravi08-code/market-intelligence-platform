import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { io } from "socket.io-client";

// ── Inline StockChart ─────────────────────────────────────────────────────────
const TF_CHART_OPTIONS = [
  { label: "5m",  value: "5min"  },
  { label: "15m", value: "15min" },
  { label: "1H",  value: "1hour" },
  { label: "4H",  value: "4hour" },
  { label: "1D",  value: "1day"  },
  { label: "1W",  value: "1week" },
];

const CHART_COLORS = {
  bg:    "#060a10",
  grid:  "#0d1f35",
  text:  "#3a6a9f",
  up:    "#4ade80",
  down:  "#f87171",
  label: "#94a3b8",
};

function StockChart({ symbol, defaultTf }) {
  const canvasRef         = useRef(null);
  const [tf, setTf]       = useState(defaultTf || "1day");
  const [candles, setCandles]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [crosshair, setCrosshair] = useState(null);

  const fetchCandles = useCallback(async (sym, timeframe) => {
    if (!sym) return;
    setLoading(true);
    setError(null);
    try {
      const days = ["5min","15min","1hour"].includes(timeframe) ? 10
                 : timeframe === "4hour" ? 30
                 : timeframe === "1week" ? 365 : 180;
      const res  = await fetch(`/api/candles/${sym}?tf=${timeframe}&days=${days}`);
      const data = await res.json();
      if (!data.ok) { setError(data.error || "No data"); setCandles([]); return; }
      if (!data.candles?.length) { setError("No candle data"); setCandles([]); return; }
      setCandles(data.candles);
    } catch (e) {
      setError("Fetch failed: " + e.message);
      setCandles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (symbol) {
      sessionStorage.removeItem("terminal_ltp");
      fetchCandles(symbol, tf);
    }
  }, [symbol, tf, fetchCandles]);

  useEffect(() => { if (defaultTf && defaultTf !== tf) setTf(defaultTf); }, [defaultTf]); // eslint-disable-line

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !candles.length) return;
    const ctx    = canvas.getContext("2d");
    const W      = canvas.width;
    const H      = canvas.height;
    const PAD    = { top: 16, right: 56, bottom: 48, left: 8 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top  - PAD.bottom;
    const volH   = Math.floor(chartH * 0.18);
    const priceH = chartH - volH - 8;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = CHART_COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const data    = candles;
    const n       = data.length;
    const candleW = Math.max(1, Math.floor(chartW / n) - 1);
    const gap     = Math.max(1, Math.floor(chartW / n));
    const maxP    = Math.max(...data.map(c => c.high));
    const minP    = Math.min(...data.map(c => c.low));
    const rangeP  = maxP - minP || 1;
    const maxVol  = Math.max(...data.map(c => c.volume)) || 1;

    const px = price => PAD.top + priceH - ((price - minP) / rangeP) * priceH;
    const vx = vol   => PAD.top + priceH + 8 + volH - (vol / maxVol) * volH;
    const cx = i     => PAD.left + i * gap + gap / 2;

    ctx.strokeStyle = CHART_COLORS.grid;
    ctx.lineWidth   = 0.5;
    for (let g = 0; g <= 4; g++) {
      const y = PAD.top + (priceH / 4) * g;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
      ctx.fillStyle = CHART_COLORS.text;
      ctx.font      = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText((maxP - (rangeP / 4) * g).toFixed(0), W - PAD.right + 3, y + 4);
    }

    data.forEach((c, i) => {
      const x    = cx(i);
      const isUp = c.close >= c.open;
      const col  = isUp ? CHART_COLORS.up : CHART_COLORS.down;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, px(c.high)); ctx.lineTo(x, px(c.low)); ctx.stroke();
      const bodyTop = px(Math.max(c.open, c.close));
      const bodyBot = px(Math.min(c.open, c.close));
      ctx.fillStyle = col;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, Math.max(1, bodyBot - bodyTop));
      ctx.fillStyle = col + "66";
      const vTop = vx(c.volume);
      ctx.fillRect(x - candleW / 2, vTop, candleW, PAD.top + priceH + 8 + volH - vTop);
    });

    ctx.fillStyle = CHART_COLORS.label;
    ctx.font      = "9px monospace";
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(n / 7));
    for (let i = 0; i < n; i += step) {
      const d   = new Date(data[i].time);
      const lbl = ["5min","15min","1hour","4hour"].includes(tf)
        ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
      ctx.fillText(lbl, cx(i), H - 8);
    }

    canvas._layout = { PAD, gap, n, minP, maxP, rangeP, data, px, cx };
  }, [candles, tf]);

  const handleMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas?._layout || !candles.length) return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const { PAD, gap, n, data, cx } = canvas._layout;
    const i = Math.round((mouseX - PAD.left) / gap - 0.5);
    if (i < 0 || i >= n) { setCrosshair(null); return; }
    setCrosshair({ x: cx(i), candle: data[i], i });
  };

  const last   = candles[candles.length - 1];
  const first  = candles[0];
  const chg    = last && first ? last.close - first.open : 0;
  const chgPct = first?.open > 0 ? (chg / first.open) * 100 : 0;
  const isUp   = chg >= 0;

  return (
    <div style={{ background: CHART_COLORS.bg, border: "1px solid #1e2a3a", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid #0d1f35" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#60a5fa", fontFamily: "monospace", fontWeight: 800, fontSize: 12 }}>{symbol}</span>
          {last && (
            <>
              <span style={{ color: "#f0f6ff", fontFamily: "monospace", fontSize: 12, fontWeight: 700 }}>
                ₹{last.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </span>
              <span style={{ color: isUp ? CHART_COLORS.up : CHART_COLORS.down, fontFamily: "monospace", fontSize: 11, fontWeight: 700 }}>
                {isUp ? "+" : ""}{chg.toFixed(2)} ({isUp ? "+" : ""}{chgPct.toFixed(2)}%)
              </span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {TF_CHART_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setTf(opt.value)} style={{
              padding: "2px 7px", borderRadius: 3, fontSize: 9, fontWeight: 700,
              cursor: "pointer", fontFamily: "monospace",
              border: `1px solid ${tf === opt.value ? "#60a5fa" : "#1e2a3a"}`,
              background: tf === opt.value ? "#60a5fa22" : "transparent",
              color: tf === opt.value ? "#60a5fa" : "#4a6080",
            }}>{opt.label}</button>
          ))}
        </div>
      </div>

      {crosshair && (
        <div style={{ display: "flex", gap: 12, padding: "3px 10px", background: "#0d1520", fontFamily: "monospace", fontSize: 10, color: "#94a3b8" }}>
          <span>O: <b style={{ color: "#f0f6ff" }}>{crosshair.candle.open.toFixed(2)}</b></span>
          <span>H: <b style={{ color: CHART_COLORS.up }}>{crosshair.candle.high.toFixed(2)}</b></span>
          <span>L: <b style={{ color: CHART_COLORS.down }}>{crosshair.candle.low.toFixed(2)}</b></span>
          <span>C: <b style={{ color: "#f0f6ff" }}>{crosshair.candle.close.toFixed(2)}</b></span>
          <span>V: <b style={{ color: "#60a5fa" }}>{(crosshair.candle.volume / 1e5).toFixed(2)}L</b></span>
          <span style={{ color: "#3a5a7f", marginLeft: "auto" }}>
            {new Date(crosshair.candle.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
          </span>
        </div>
      )}

      <div style={{ position: "relative" }}>
        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#060a10cc", zIndex: 5 }}>
            <span style={{ color: "#60a5fa", fontFamily: "monospace", fontSize: 12 }}>Loading {tf} candles…</span>
          </div>
        )}
        {error && !loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#060a10cc", zIndex: 5, gap: 8 }}>
            <span style={{ color: "#f87171", fontFamily: "monospace", fontSize: 12 }}>⚠ {error}</span>
            <button onClick={() => fetchCandles(symbol, tf)} style={{ color: "#60a5fa", background: "transparent", border: "1px solid #60a5fa44", padding: "4px 12px", borderRadius: 4, fontFamily: "monospace", cursor: "pointer", fontSize: 11 }}>Retry</button>
          </div>
        )}
        <canvas
          ref={canvasRef}
          width={700}
          height={320}
          style={{ width: "100%", height: "auto", display: "block", cursor: "crosshair" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setCrosshair(null)}
        />
      </div>

      {candles.length > 0 && (
        <div style={{ padding: "2px 10px", fontFamily: "monospace", fontSize: 9, color: "#1e3a5a", textAlign: "right", borderTop: "1px solid #0d1f35" }}>
          {candles.length} candles · {tf}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

let _socket = null;
function getSocket() {
  if (!_socket) _socket = io({ transports: ["websocket"] });
  return _socket;
}

function expandDiffStock(d) {
  return {
    symbol:         d.s,
    ltp:            d.l,
    changePct:      d.c,
    change:         d.ch,
    volume:         d.v,
    techScore:      d.sc,
    signal:         d.sg,
    rsi:            d.rs,
    macd:           d.mc,
    bollingerBands: d.bb,
    maSummary:      d.ms,
    mcapBucket:     d.mb,
    mcapLabel:      d.ml,
    name:           d.nm,
    exchange:       d.ex,
    sector:         d.sk,
    prevClose:      d.pc,
    entry:          d.en,
    sl:             d.sl,
    tp:             d.tp,
    entryType:      d.et,
    gapPct:         d.gp,
  };
}

const fmt   = (n, d = 2) => n == null ? "—" : Number(n).toFixed(d);
const fmtK  = (n) => {
  if (!n) return "—";
  if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(2) + " L";
  return n.toLocaleString("en-IN");
};
const clr   = (v) => v > 0 ? "#4ade80" : v < 0 ? "#f87171" : "#9ca3af";
const arrow = (v) => v > 0 ? "▲" : v < 0 ? "▼" : "—";
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

const ACCESS_PIN  = "MARKET2024";
const SESSION_KEY = "mscanner_auth";

function AccessGate({ onAuth }) {
  const [pin, setPin]     = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);

  const handleSubmit = () => {
    if (pin.toUpperCase() === ACCESS_PIN) {
      sessionStorage.setItem(SESSION_KEY, "1");
      onAuth();
    } else {
      setError("Incorrect access code");
      setShake(true);
      setTimeout(() => setShake(false), 600);
      setPin("");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#060a10", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono','Fira Code',monospace" }}>
      <div style={{ background: "#0a0f16", border: "1px solid #1e2a3a", borderRadius: 12, padding: "40px 48px", textAlign: "center", maxWidth: 380, width: "100%", animation: shake ? "shake 0.5s" : "none" }}>
        <style>{`@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}`}</style>
        <div style={{ fontSize: 32, marginBottom: 16 }}>🔐</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#e2eaf4", marginBottom: 6 }}>Market Scanner</div>
        <div style={{ fontSize: 12, color: "#7a8fa6", marginBottom: 28 }}>Enter your access code to continue</div>
        <input
          type="password"
          placeholder="Access code…"
          value={pin}
          onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSubmit()}
          autoFocus
          style={{ width: "100%", background: "#111620", border: "1px solid #1e2a3a", borderRadius: 8, padding: "12px 16px", color: "#e2eaf4", fontSize: 14, fontFamily: "inherit", outline: "none", marginBottom: 12, letterSpacing: 3, textAlign: "center", boxSizing: "border-box" }}
        />
        {error && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 12 }}>{error}</div>}
        <button type="button" onClick={handleSubmit} style={{ width: "100%", background: "#3b82f6", border: "none", borderRadius: 8, padding: "12px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Access Scanner →
        </button>
        <div style={{ fontSize: 10, color: "#3d5068", marginTop: 20 }}>Unauthorized access is prohibited</div>
      </div>
    </div>
  );
}

const T = {
  bg: "#060a10", bgPanel: "#0a0f16", bgCard: "#0d1117", bgItem: "#111620",
  border: "#1e2a3a", borderSub: "#192130",
  textPri: "#f0f6ff", textSec: "#94a3b8", textDim: "#4a6080",
  green: "#4ade80", red: "#f87171", yellow: "#fbbf24", blue: "#60a5fa",
  purple: "#c4b5fd", indigo: "#a5b4fc", orange: "#fb923c", price: "#ffffff",
};

const TIMEFRAMES = [
  { id: "5min",   label: "5m"  },
  { id: "15min",  label: "15m" },
  { id: "1hour",  label: "1H"  },
  { id: "4hour",  label: "4H"  },
  { id: "1day",   label: "1D"  },
  { id: "1week",  label: "1W"  },
  { id: "1month", label: "1M"  },
];

function MiniBar({ value, max = 100, color = T.blue }) {
  const pct = clamp((value / max) * 100, 0, 100);
  return (
    <div style={{ height: 4, background: "#1a2030", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2 }} />
    </div>
  );
}

function SigBadge({ signal }) {
  const map = {
    "STRONG BUY":  { bg: "#14532d", color: "#4ade80" },
    "BUY":         { bg: "#052e16", color: "#86efac" },
    "HOLD":        { bg: "#431407", color: "#fbbf24" },
    "NEUTRAL":     { bg: "#1a2030", color: "#94a3b8" },
    "SELL":        { bg: "#450a0a", color: "#fca5a5" },
    "STRONG SELL": { bg: "#3b0a0a", color: "#f87171" },
    "N/A":         { bg: "#1a2030", color: "#4a6080" },
  };
  const s = map[signal] || map["N/A"];
  return (
    <span style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}55`, fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, letterSpacing: "0.5px", whiteSpace: "nowrap" }}>
      {signal || "N/A"}
    </span>
  );
}

function ExBadge({ exchange }) {
  const isBSE = exchange === "BSE";
  return (
    <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 2, background: isBSE ? "#1a1a40" : "#0a2010", color: isBSE ? "#a5b4fc" : "#86efac", border: `1px solid ${isBSE ? "#a5b4fc44" : "#86efac44"}`, marginLeft: 3 }}>
      {exchange || "NSE"}
    </span>
  );
}

function McapBadge({ bucket, label }) {
  const styles = {
    largecap: { bg: "#1e2060", color: T.indigo },
    midcap:   { bg: "#0e3020", color: T.green  },
    smallcap: { bg: "#2a1060", color: T.purple },
    microcap: { bg: "#1a1a2a", color: T.textSec },
  };
  const s = styles[bucket] || styles.microcap;
  return (
    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, fontWeight: 600, background: s.bg, color: s.color }}>
      {label || "—"}
    </span>
  );
}

function StockRow({ stock, rank, onSelect, selected, tech, livePrice }) {
  let prevClose = stock.prevClose || 0;
  if (prevClose <= 0 && stock.changePct !== 0 && stock.ltp > 0) {
    prevClose = Math.round((stock.ltp / (1 + stock.changePct / 100)) * 100) / 100;
  }
  if (prevClose <= 0) prevClose = stock.ltp;

  const ltp    = livePrice ?? stock.ltp;
  const change = livePrice != null ? Math.round((livePrice - prevClose) * 100) / 100 : stock.change;
  const pct    = livePrice != null && prevClose > 0
    ? Math.round(((livePrice - prevClose) / prevClose) * 10000) / 100
    : stock.changePct;
  const isLive = livePrice != null;

  return (
    <tr
      onClick={() => onSelect(stock.symbol)}
      style={{ cursor: "pointer", background: selected ? "#0f2a1a" : "transparent", borderBottom: `1px solid ${T.borderSub}`, transition: "background 0.12s" }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "#0d1520"; }}
      onMouseLeave={e => { e.currentTarget.style.background = selected ? "#0f2a1a" : "transparent"; }}
    >
      <td style={{ padding: "7px 8px", color: T.textDim, fontSize: 10, width: 28 }}>{rank}</td>
      <td style={{ padding: "7px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontWeight: 800, fontSize: 13, color: "#ffffff" }}>{stock.symbol}</span>
          <ExBadge exchange={stock.exchange} />
          {isLive && <span style={{ fontSize: 7, color: "#4ade80", background: "#052e16", border: "1px solid #4ade8033", borderRadius: 2, padding: "0 3px" }}>●LIVE</span>}
        </div>
        <div style={{ fontSize: 10, color: "#6b8aad", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stock.name}</div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right" }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: "#ffffff" }}>₹{fmt(ltp)}</div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right" }}>
        <div style={{ color: clr(pct), fontWeight: 700, fontSize: 12 }}>{arrow(pct)} {fmt(Math.abs(pct))}%</div>
        <div style={{ color: clr(change), fontSize: 10 }}>{change > 0 ? "+" : ""}{fmt(change)}</div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right", color: "#94a3b8", fontSize: 11 }}>{fmtK(stock.volume)}</td>
      <td style={{ padding: "7px 8px" }}><McapBadge bucket={stock.mcapBucket} label={stock.mcapLabel} /></td>
      <td style={{ padding: "7px 8px" }}>
        {tech ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 46, height: 4, background: "#1a2030", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${tech.rsi || 0}%`, height: "100%", borderRadius: 2, background: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow }} />
            </div>
            <span style={{ color: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow, fontSize: 12, fontWeight: 700 }}>{fmt(tech.rsi, 1)}</span>
          </div>
        ) : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
      <td style={{ padding: "7px 8px" }}>
        {tech?.macd ? (
          <span style={{ color: tech.macd.crossover === "BULLISH" ? T.green : T.red, fontSize: 11, fontWeight: 700 }}>
            {tech.macd.crossover === "BULLISH" ? "▲" : "▼"} {fmt(tech.macd.macd)}
          </span>
        ) : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
      <td style={{ padding: "7px 8px" }}>
        {tech?.bollingerBands ? (
          <span style={{ fontSize: 11, fontWeight: 600, color:
            tech.bollingerBands.position === "ABOVE_UPPER" ? T.red   :
            tech.bollingerBands.position === "BELOW_LOWER" ? T.green :
            tech.bollingerBands.position === "NEAR_UPPER"  ? T.orange :
            tech.bollingerBands.position === "NEAR_LOWER"  ? "#38bdf8" : T.textSec
          }}>
            {{ ABOVE_UPPER: "Above BB", NEAR_UPPER: "Near Up", MIDDLE: "Mid BB", NEAR_LOWER: "Near Lo", BELOW_LOWER: "Below BB" }[tech.bollingerBands.position] || tech.bollingerBands.position}
          </span>
        ) : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
      <td style={{ padding: "7px 8px" }}>
        {tech?.maSummary ? <SigBadge signal={tech.maSummary.summary} /> : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
    </tr>
  );
}

// ── TechPanel ─────────────────────────────────────────────────────────────────
function TechPanel({ symbol, tech, loading, timeframe, livePrice, onTimeframeChange, onClose }) {
  if (!symbol) return null;

  const scoreColor = tech
    ? tech.techScore >= 60 ? T.green : tech.techScore <= 40 ? T.red : T.yellow
    : T.textSec;
  const sigBg = tech
    ? tech.signal?.includes("BUY") ? "#14532d" : tech.signal?.includes("SELL") ? "#3b0a0a" : "#431407"
    : "#1a2030";

  const Card = ({ title, children }) => (
    <div style={{ background: T.bgItem, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, letterSpacing: "0.9px", marginBottom: 10, textTransform: "uppercase" }}>{title}</div>
      {children}
    </div>
  );

  const Row = ({ label, value, color = T.textPri, badge }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${T.borderSub}` }}>
      <span style={{ fontSize: 11, color: T.textSec }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {value != null && <span style={{ fontSize: 12, fontWeight: 600, color }}>{value}</span>}
        {badge}
      </div>
    </div>
  );

  const handleFullChart = () => {
    const ltp = livePrice ?? tech?.ltp ?? tech?.entry ?? null;
    sessionStorage.setItem("terminal_symbol", symbol);
    if (ltp) sessionStorage.setItem("terminal_ltp", String(ltp));
    const url = new URL("/Stockterminal.html", window.location.origin);
    url.searchParams.set("symbol", symbol);
    if (ltp) url.searchParams.set("ltp", String(ltp));
    window.open(url.toString(), "_blank", "noopener");
  };

  const entryTypeMeta = tech?.entryType
    ? tech.entryType === "MARKET_OPEN"
      ? { label: "⚡ LIVE OPEN", color: T.green, bg: "#052e16", border: "#4ade8033" }
      : tech.entryType === "DAY_OPEN"
      ? { label: "✓ DAY OPEN",  color: T.blue,  bg: "#0a1a2e", border: "#60a5fa33" }
      : { label: "⏸ PRE-MARKET", color: T.textDim, bg: "#1a2030", border: "#1e2a3a" }
    : null;

  return (
    <div style={{
      position: "fixed", right: 0, top: 0,
      width: 420, height: "100vh",
      background: T.bgCard,
      borderLeft: `1px solid ${T.border}`,
      overflowY: "auto", zIndex: 100,
      padding: "16px 14px",
      boxShadow: "-12px 0 48px rgba(0,0,0,0.7)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.textPri, letterSpacing: "0.5px" }}>{symbol}</div>
          <div style={{ fontSize: 11, color: T.textSec }}>Technical Analysis · Multi-timeframe</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" onClick={handleFullChart}
            style={{ background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.5)", color: "#60a5fa", padding: "5px 11px", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(96,165,250,0.22)"}
            onMouseLeave={e => e.currentTarget.style.background = "rgba(96,165,250,0.12)"}
          >↗ Full Chart</button>
          <button type="button" onClick={e => { e.preventDefault(); onClose(); }}
            style={{ background: T.bgItem, border: `1px solid ${T.border}`, color: T.textSec, width: 28, height: 28, borderRadius: 5, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}
          >✕</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 2, marginBottom: 12, background: "#080d14", padding: 3, borderRadius: 7, border: `1px solid ${T.border}` }}>
        {TIMEFRAMES.map(tf => (
          <button type="button" key={tf.id} onClick={e => { e.preventDefault(); onTimeframeChange(tf.id); }}
            style={{ flex: 1, padding: "5px 0", fontSize: 10, fontWeight: 700, borderRadius: 5, cursor: "pointer", border: "none", background: timeframe === tf.id ? T.indigo : "transparent", color: timeframe === tf.id ? "#fff" : T.textDim, transition: "all 0.15s" }}
          >{tf.label}</button>
        ))}
      </div>

      <div style={{ marginBottom: 12 }}>
        <StockChart symbol={symbol} defaultTf={timeframe} />
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: "30px 0", color: T.textSec }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>⏳</div>
          <div style={{ fontSize: 13 }}>Loading {timeframe} indicators…</div>
        </div>
      )}
      {!loading && !tech && (
        <div style={{ textAlign: "center", padding: "30px 0", color: T.textSec }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>📭</div>
          <div style={{ fontSize: 13 }}>No indicator data for {timeframe}</div>
        </div>
      )}

      {!loading && tech && (
        <>
          <div style={{ background: sigBg, border: `1px solid ${tech.signal?.includes("BUY") ? "#4ade8044" : tech.signal?.includes("SELL") ? "#f8717144" : "#fbbf2444"}`, borderRadius: 10, padding: "14px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: T.textSec, fontWeight: 700, letterSpacing: "0.8px", marginBottom: 10 }}>LIVE SIGNAL · {timeframe.toUpperCase()}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <svg viewBox="0 0 56 56" width="56" height="56" style={{ flexShrink: 0 }}>
                <circle cx="28" cy="28" r="22" fill="none" stroke="#1a2030" strokeWidth="4"/>
                <circle cx="28" cy="28" r="22" fill="none" stroke={scoreColor} strokeWidth="4"
                  strokeDasharray={`${Math.round(2 * Math.PI * 22 * tech.techScore / 100)} ${Math.round(2 * Math.PI * 22)}`}
                  strokeDashoffset={Math.round(2 * Math.PI * 22 * 0.25)} strokeLinecap="round"/>
                <text x="28" y="33" textAnchor="middle" fontSize="13" fontWeight="700" fill={scoreColor}>{tech.techScore}</text>
              </svg>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: scoreColor, marginBottom: 3 }}>{tech.signal}</div>
                <div style={{ height: 6, background: "#1a2030", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${tech.strength || tech.techScore}%`, height: "100%", background: scoreColor, borderRadius: 3 }} />
                </div>
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 4 }}>
                  {(tech.strength || tech.techScore)}/100 · {(tech.strength || tech.techScore) >= 65 ? "Strong" : (tech.strength || tech.techScore) >= 50 ? "Moderate" : "Weak"}
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {[
                { label: "Entry",     value: tech.entry, color: T.blue  },
                { label: "Stop Loss", value: tech.sl,    color: T.red   },
                { label: "Target",    value: tech.tp,    color: T.green },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: "#0d1117", border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 8px", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: T.textSec, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color }}>₹{fmt(value)}</div>
                </div>
              ))}
            </div>

            {entryTypeMeta && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: "5px 10px", borderRadius: 5, background: entryTypeMeta.bg, border: `1px solid ${entryTypeMeta.border}` }}>
                <span style={{ fontSize: 9, color: entryTypeMeta.color, fontWeight: 700, letterSpacing: "0.5px" }}>
                  {entryTypeMeta.label}
                </span>
                {tech.gapPct != null && Math.abs(tech.gapPct) >= 0.1 && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: tech.gapPct > 0 ? T.green : T.red }}>
                    GAP {tech.gapPct > 0 ? "▲" : "▼"} {Math.abs(tech.gapPct).toFixed(2)}%
                  </span>
                )}
                {tech.gapPct != null && Math.abs(tech.gapPct) < 0.1 && (
                  <span style={{ fontSize: 9, color: T.textDim }}>FLAT OPEN</span>
                )}
              </div>
            )}
          </div>

          <Card title="Momentum">
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: T.textSec }}>RSI (14)</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow }}>{fmt(tech.rsi, 1)}</span>
              </div>
              <MiniBar value={tech.rsi || 0} color={tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow} />
              <div style={{ fontSize: 11, color: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.textSec, marginTop: 4 }}>
                {tech.rsi > 70 ? "⚠️ Overbought" : tech.rsi < 30 ? "✅ Oversold" : "RSI neutral zone"}
              </div>
            </div>
            {tech.stochastic && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ fontSize: 11, color: T.textSec, marginBottom: 5 }}>Stochastic %K / %D</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {[["K", tech.stochastic.k], ["D", tech.stochastic.d]].map(([label, val]) => (
                    <div key={label} style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                        <span style={{ fontSize: 9, color: T.textDim }}>%{label}</span>
                        <span style={{ fontSize: 11, color: T.textPri, fontWeight: 600 }}>{fmt(val, 1)}</span>
                      </div>
                      <MiniBar value={val} color={val > 80 ? T.red : val < 20 ? T.green : T.yellow} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <Card title="Trend">
            {tech.macd && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: T.textSec, marginBottom: 6 }}>MACD (12, 26, 9)</div>
                <Row label="MACD Line" value={fmt(tech.macd.macd)}      color={tech.macd.macd > 0 ? T.green : T.red} />
                <Row label="Signal"    value={fmt(tech.macd.signal)} />
                <Row label="Histogram" value={fmt(tech.macd.histogram)}  color={tech.macd.histogram > 0 ? T.green : T.red} />
                <div style={{ marginTop: 8, padding: "5px 10px", borderRadius: 5, textAlign: "center", background: tech.macd.crossover === "BULLISH" ? "#052e16" : "#3b0a0a", color: tech.macd.crossover === "BULLISH" ? T.green : T.red, fontSize: 12, fontWeight: 700, border: `1px solid ${tech.macd.crossover === "BULLISH" ? "#4ade8044" : "#f8717144"}` }}>
                  {tech.macd.crossover === "BULLISH" ? "▲ Bullish Crossover" : "▼ Bearish Crossover"}
                </div>
              </div>
            )}
            {tech.adx && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>ADX + DMI</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tech.adx.adx > 40 ? T.green : tech.adx.adx > 25 ? T.yellow : T.textSec }}>{fmt(tech.adx.adx, 1)}</span>
                </div>
                <MiniBar value={clamp(tech.adx.adx * 2, 0, 100)} color={tech.adx.adx > 40 ? T.green : tech.adx.adx > 25 ? T.yellow : T.textSec} />
                <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                  <span style={{ fontSize: 12, color: T.green, fontWeight: 600 }}>+DI {fmt(tech.adx.diPlus, 1)}</span>
                  <span style={{ fontSize: 12, color: T.red,   fontWeight: 600 }}>−DI {fmt(tech.adx.diMinus, 1)}</span>
                </div>
              </div>
            )}
            {tech.supertrend && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>Supertrend</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tech.supertrend.trend === "BULLISH" ? T.green : tech.supertrend.trend === "BEARISH" ? T.red : T.yellow }}>
                    {tech.supertrend.trend}
                  </span>
                </div>
              </div>
            )}
          </Card>

          <Card title="Volatility">
            {tech.bollingerBands && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {[
                    { label: "Upper", value: tech.bollingerBands.upper,  color: T.red     },
                    { label: "Mid",   value: tech.bollingerBands.middle, color: T.textSec },
                    { label: "Lower", value: tech.bollingerBands.lower,  color: T.green   },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ flex: 1, background: "#0d1117", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color, marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T.textPri }}>₹{fmt(value)}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: T.textSec, marginBottom: 3 }}>%B ({tech.bollingerBands.percentB}%)</div>
                <MiniBar value={tech.bollingerBands.percentB} color={T.blue} />
              </div>
            )}
            {tech.atr != null && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <Row label="ATR" value={`₹${fmt(tech.atr, 1)}`} />
              </div>
            )}
          </Card>

          <Card title="Volume">
            {tech.obv && <Row label="OBV Trend" value={tech.obv} color={(tech.obv || "").includes("Rising") ? T.green : T.red} />}
            {tech.vwap != null && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <Row label="VWAP" value={`₹${fmt(tech.vwap)}`} color={tech.vwapDiff > 0 ? T.green : T.red} />
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 4 }}>
                  {tech.vwapDiff > 0 ? "+" : ""}{fmt(tech.vwapDiff, 2)}% · {tech.vwapDiff > 0 ? "Above VWAP" : "Below VWAP"}
                </div>
              </div>
            )}
          </Card>

          <Card title="Moving Average Summary">
            {tech.maSummary && (
              <>
                <div style={{ textAlign: "center", padding: "10px", borderRadius: 7, marginBottom: 10, background: tech.maSummary.summary?.includes("BUY") ? "#052e16" : tech.maSummary.summary?.includes("SELL") ? "#3b0a0a" : "#431407" }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: tech.maSummary.summary?.includes("BUY") ? T.green : tech.maSummary.summary?.includes("SELL") ? T.red : T.yellow }}>
                    {tech.maSummary.summary}
                  </div>
                  <div style={{ fontSize: 11, color: T.textSec }}>{tech.maSummary.buy}B · {tech.maSummary.sell}S · {tech.maSummary.neutral}N</div>
                </div>
                {[["EMA 5", tech.emas?.ema5], ["EMA 21", tech.emas?.ema21], ["EMA 50", tech.emas?.ema50], ["EMA 200", tech.emas?.ema200]].map(([label, val]) => {
                  const sig = !val ? "N/A" : tech.ltp > val * 1.001 ? "BUY" : tech.ltp < val * 0.999 ? "SELL" : "NEUTRAL";
                  return (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${T.borderSub}` }}>
                      <span style={{ fontSize: 11, color: T.textSec }}>{label}</span>
                      <span style={{ fontSize: 11, color: T.textPri }}>₹{fmt(val)}</span>
                      <SigBadge signal={sig} />
                    </div>
                  );
                })}
              </>
            )}
          </Card>

          <div style={{ fontSize: 10, color: T.textDim, textAlign: "center", paddingBottom: 20 }}>
            Updated {new Date(tech.computedAt).toLocaleTimeString("en-IN")} · {timeframe}
          </div>
        </>
      )}
    </div>
  );
}

// ── GainLossCard ──────────────────────────────────────────────────────────────
function GainLossCard({ title, stocks, onSelect, accent, onViewAll, livePriceMap }) {
  return (
    <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", flex: 1 }}>
      <div style={{ padding: "9px 14px", borderBottom: `1px solid ${T.borderSub}`, background: `linear-gradient(90deg, ${accent}12, transparent)`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 800, fontSize: 11, color: accent, letterSpacing: "0.8px" }}>{title}</span>
        <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); onViewAll(); }}
          style={{ fontSize: 9, color: accent, background: `${accent}18`, border: `1px solid ${accent}44`, borderRadius: 3, padding: "2px 7px", cursor: "pointer", fontWeight: 700 }}
        >VIEW ALL ↓</button>
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {(stocks || []).slice(0, 15).map(s => {
          const livePrice = livePriceMap?.[s.symbol];
          let prevClose = s.prevClose || 0;
          if (prevClose <= 0 && s.ltp > 0) prevClose = Math.round((s.ltp / (1 + (s.changePct || 0.001) / 100)) * 100) / 100;
          if (prevClose <= 0) prevClose = s.ltp;
          const ltp    = livePrice ?? s.ltp;
          const pct    = s._livePct != null
            ? s._livePct
            : livePrice != null && prevClose > 0
              ? Math.round(((livePrice - prevClose) / prevClose) * 10000) / 100
              : s.changePct;
          const isLive = livePrice != null;
          return (
            <div key={s.symbol} onClick={() => onSelect(s.symbol)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 14px", borderBottom: `1px solid ${T.borderSub}`, cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = "#0d1520"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: "#ffffff" }}>{s.symbol}</span>
                  <ExBadge exchange={s.exchange} />
                  {isLive && <span style={{ fontSize: 7, color: "#4ade80", background: "#052e16", border: "1px solid #4ade8033", borderRadius: 2, padding: "0 3px" }}>●</span>}
                </div>
                <div style={{ fontSize: 10, color: "#6b8aad" }}>₹{fmt(ltp)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: accent, fontWeight: 800, fontSize: 13 }}>{pct > 0 ? "+" : ""}{fmt(pct)}%</div>
                <div style={{ fontSize: 10, color: T.textDim }}>Vol: {fmtK(s.volume)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectorBar({ sector }) {
  const bull  = sector.avgChange >= 0;
  const width = Math.min(Math.abs(sector.avgChange) * 15, 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px solid ${T.borderSub}` }}>
      <div style={{ width: 140, fontSize: 11, color: T.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sector.sector}</div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 80, height: 4, background: "#1a2030", borderRadius: 2 }}>
          <div style={{ width: `${width}%`, height: "100%", borderRadius: 2, background: bull ? T.green : T.red }} />
        </div>
        <span style={{ color: clr(sector.avgChange), fontWeight: 700, fontSize: 12, width: 52, textAlign: "right" }}>{sector.avgChange > 0 ? "+" : ""}{fmt(sector.avgChange)}%</span>
      </div>
      <span style={{ fontSize: 10, color: T.textDim, width: 54, textAlign: "right" }}>{sector.advancing}↑ {sector.declining}↓</span>
    </div>
  );
}

function BreadthBar({ advancing, declining, unchanged, total }) {
  if (!total) return null;
  const advPct = Math.round((advancing / total) * 100);
  const decPct = Math.round((declining / total) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, maxWidth: 300 }}>
      <div style={{ flex: 1, height: 6, background: "#1a2030", borderRadius: 3, overflow: "hidden", display: "flex" }}>
        <div style={{ width: `${advPct}%`, background: T.green, transition: "width 0.5s" }} />
        <div style={{ width: `${100 - advPct - (unchanged / total * 100)}%`, background: T.red, transition: "width 0.5s" }} />
      </div>
      <span style={{ fontSize: 10, color: T.textDim, whiteSpace: "nowrap" }}>{advPct}% adv · {decPct}% dec</span>
    </div>
  );
}

// ── Backtest helpers ──────────────────────────────────────────────────────────
const BT_KEY = "mscanner_backtest_v2";

function btLoad() { try { return JSON.parse(localStorage.getItem(BT_KEY) || "{}"); } catch { return {}; } }
function btSave(db) {
  try { localStorage.setItem(BT_KEY, JSON.stringify(db)); } catch {
    const keys = Object.keys(db).sort(); const trimmed = {};
    keys.slice(-30).forEach(k => { trimmed[k] = db[k]; });
    localStorage.setItem(BT_KEY, JSON.stringify(trimmed));
  }
}
function todayKey() { return new Date().toISOString().slice(0, 10); }

function autoCapture(techCacheRef) {
  const db = btLoad(); const key = todayKey();
  if (db[key]) return { count: 0, alreadyDone: true };
  const signals = []; const now = Date.now();
  for (const [cacheKey, data] of Object.entries(techCacheRef.current)) {
    if (!cacheKey.endsWith(":1day")) continue;
    const sym = cacheKey.replace(":1day", "");
    signals.push({ id: `${sym}_${now}`, symbol: sym, signal: data.signal, techScore: data.techScore, ltp: data.ltp, entry: data.entry, entryType: data.entryType || "PREV_OPEN", gapPct: data.gapPct || 0, sl: data.sl, tp: data.tp, rsi: data.rsi, macdCross: data.macd?.crossover, bias: data.bias, volRatio: data.volRatio, outcome: null, exitPrice: null, notes: "" });
  }
  if (!signals.length) return { count: 0, alreadyDone: false };
  db[key] = { signals, capturedAt: now, date: key }; btSave(db);
  return { count: signals.length, alreadyDone: false };
}

function manualCapture(techCacheRef) {
  const db = btLoad(); const key = todayKey(); const now = Date.now();
  const existing = db[key]?.signals || []; const existingSyms = new Set(existing.map(s => s.symbol));
  const newSignals = [];
  for (const [cacheKey, data] of Object.entries(techCacheRef.current)) {
    if (!cacheKey.endsWith(":1day")) continue;
    const sym = cacheKey.replace(":1day", "");
    if (existingSyms.has(sym)) continue;
    newSignals.push({ id: `${sym}_${now}`, symbol: sym, signal: data.signal, techScore: data.techScore, ltp: data.ltp, entry: data.entry, entryType: data.entryType || "PREV_OPEN", gapPct: data.gapPct || 0, sl: data.sl, tp: data.tp, rsi: data.rsi, macdCross: data.macd?.crossover, bias: data.bias, volRatio: data.volRatio, outcome: null, exitPrice: null, notes: "" });
  }
  if (!db[key]) db[key] = { signals: [], capturedAt: now, date: key };
  db[key].signals = [...existing, ...newSignals]; btSave(db);
  return newSignals.length;
}

function updateSignal(date, id, patch) {
  const db = btLoad(); if (!db[date]) return;
  db[date].signals = db[date].signals.map(s => s.id === id ? { ...s, ...patch } : s); btSave(db);
}
function deleteSignalFromDB(date, id) {
  const db = btLoad(); if (!db[date]) return;
  db[date].signals = db[date].signals.filter(s => s.id !== id); btSave(db);
}

function computeAnalytics(db) {
  const allSignals = Object.values(db).flatMap(d => d.signals || []);
  const resolved   = allSignals.filter(s => s.outcome === "WIN" || s.outcome === "LOSS");
  const wins       = resolved.filter(s => s.outcome === "WIN");
  const overallAcc = resolved.length > 0 ? (wins.length / resolved.length * 100).toFixed(1) : null;
  const bySignal   = {};
  for (const s of resolved) { if (!bySignal[s.signal]) bySignal[s.signal] = { wins: 0, total: 0 }; bySignal[s.signal].total++; if (s.outcome === "WIN") bySignal[s.signal].wins++; }
  const rsiBuckets = { "<30": { wins: 0, total: 0 }, "30-50": { wins: 0, total: 0 }, "50-60": { wins: 0, total: 0 }, "60-70": { wins: 0, total: 0 }, ">70": { wins: 0, total: 0 } };
  for (const s of resolved) { const r = s.rsi; const b = r < 30 ? "<30" : r < 50 ? "30-50" : r < 60 ? "50-60" : r < 70 ? "60-70" : ">70"; rsiBuckets[b].total++; if (s.outcome === "WIN") rsiBuckets[b].wins++; }
  const byMacd = { BULLISH: { wins: 0, total: 0 }, BEARISH: { wins: 0, total: 0 } };
  for (const s of resolved) { const m = s.macdCross || "BEARISH"; if (!byMacd[m]) byMacd[m] = { wins: 0, total: 0 }; byMacd[m].total++; if (s.outcome === "WIN") byMacd[m].wins++; }
  const byScore = { "<40": { wins: 0, total: 0 }, "40-60": { wins: 0, total: 0 }, "60-75": { wins: 0, total: 0 }, ">75": { wins: 0, total: 0 } };
  for (const s of resolved) { const sc = s.techScore; const b = sc < 40 ? "<40" : sc < 60 ? "40-60" : sc < 75 ? "60-75" : ">75"; byScore[b].total++; if (s.outcome === "WIN") byScore[b].wins++; }
  const days = Object.keys(db).sort().slice(-14);
  const dailyTrend = days.map(d => { const r = (db[d].signals || []).filter(s => s.outcome === "WIN" || s.outcome === "LOSS"); const w = r.filter(s => s.outcome === "WIN").length; return { date: d, accuracy: r.length > 0 ? (w / r.length * 100).toFixed(1) : null, total: r.length, wins: w }; });
  const withPL = resolved.filter(s => s.exitPrice && s.entry);
  const pls    = withPL.map(s => ((s.exitPrice - s.entry) / s.entry * 100));
  const avgPL  = pls.length > 0 ? (pls.reduce((a, b) => a + b, 0) / pls.length).toFixed(2) : null;
  return { overallAcc, resolved: resolved.length, wins: wins.length, total: allSignals.length, pending: allSignals.filter(s => !s.outcome).length, bySignal, rsiBuckets, byMacd, byScore, dailyTrend, avgPL, bestTrade: pls.length > 0 ? Math.max(...pls).toFixed(2) : null, worstTrade: pls.length > 0 ? Math.min(...pls).toFixed(2) : null };
}

function BacktestPanel({ onClose, techCacheRef }) {
  const [db, setDb]                       = useState(btLoad);
  const [activeDate, setActiveDate]       = useState(todayKey());
  const [btTab, setBtTab]                 = useState("tracker");
  const [filterSig, setFilterSig]         = useState("ALL");
  const [filterOutcome, setFilterOutcome] = useState("ALL");
  const [captureMsg, setCaptureMsg]       = useState("");
  const [search, setSearch]               = useState("");

  const refresh         = () => setDb(btLoad());
  const handleCapture   = () => { const r = manualCapture(techCacheRef); refresh(); setCaptureMsg(r > 0 ? `✅ Captured ${r} new signals` : "⚠️ All already captured"); setTimeout(() => setCaptureMsg(""), 3000); };
  const handleOutcome   = (date, id, outcome)    => { updateSignal(date, id, { outcome }); refresh(); };
  const handleExitPrice = (date, id, exitPrice)  => { updateSignal(date, id, { exitPrice: parseFloat(exitPrice) || null }); refresh(); };
  const handleDelete    = (date, id)             => { deleteSignalFromDB(date, id); refresh(); };

  const downloadCSV = () => {
    const allSignals = Object.entries(db).flatMap(([date, d]) => (d.signals || []).map(s => ({ ...s, date })));
    const headers    = ["Date","Symbol","Signal","TechScore","LTP","Entry","EntryType","GapPct%","SL","Target","RSI","MACD","Outcome","ExitPrice","PL%"];
    const rows       = allSignals.map(s => { const pl = s.exitPrice && s.entry ? ((s.exitPrice - s.entry) / s.entry * 100).toFixed(2) : ""; return [s.date, s.symbol, s.signal, s.techScore, s.ltp, s.entry, s.entryType || "PREV_OPEN", s.gapPct || 0, s.sl, s.tp, s.rsi?.toFixed(1) || "", s.macdCross || "", s.outcome || "PENDING", s.exitPrice || "", pl].join(","); });
    const csv  = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `backtest_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const analytics = computeAnalytics(db);
  const dates     = Object.keys(db).sort().reverse();
  let signals     = db[activeDate]?.signals || [];
  if (filterSig !== "ALL")     signals = signals.filter(s => s.signal === filterSig);
  if (filterOutcome !== "ALL") signals = signals.filter(s => filterOutcome === "PENDING" ? !s.outcome : s.outcome === filterOutcome);
  if (search)                  signals = signals.filter(s => s.symbol.includes(search.toUpperCase()));

  const AccBar = ({ label, wins, total, color }) => {
    const pct = total > 0 ? (wins / total * 100) : 0;
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
          <span style={{ fontSize: 11, color: T.textSec }}>{label}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: pct >= 55 ? T.green : pct >= 40 ? T.yellow : T.red }}>{total > 0 ? `${pct.toFixed(0)}%` : "—"} ({wins}/{total})</span>
        </div>
        <div style={{ height: 5, background: "#1a2030", borderRadius: 3 }}>
          <div style={{ width: `${pct}%`, height: "100%", background: color || (pct >= 55 ? T.green : pct >= 40 ? T.yellow : T.red), borderRadius: 3, transition: "width 0.4s" }} />
        </div>
      </div>
    );
  };

  return (
    <div style={{ position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh", background: "rgba(0,0,0,0.85)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 14, width: "min(1100px, 97vw)", maxHeight: "94vh", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "'JetBrains Mono','Fira Code',monospace" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 20px", borderBottom: `1px solid ${T.border}`, background: "#080d14", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.textPri }}>🔬 Backtest Lab</div>
            <div style={{ fontSize: 11, color: T.textSec }}>Auto-captures daily signals · Track outcomes · Measure accuracy</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {captureMsg && <span style={{ fontSize: 11, color: captureMsg.startsWith("✅") ? T.green : T.yellow }}>{captureMsg}</span>}
            <button type="button" onClick={handleCapture} style={{ background: "#14532d", border: "1px solid #4ade8044", color: T.green, padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>📸 Capture Now</button>
            <button type="button" onClick={downloadCSV}   style={{ background: "#1e2a3a", border: `1px solid ${T.border}`, color: T.textSec, padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>⬇ Export CSV</button>
            <button type="button" onClick={onClose}       style={{ background: T.bgItem, border: `1px solid ${T.border}`, color: T.textSec, width: 30, height: 30, borderRadius: 5, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, padding: "12px 20px", borderBottom: `1px solid ${T.border}`, background: "#080d14", flexShrink: 0, flexWrap: "wrap" }}>
          {[
            { label: "Total Signals", value: analytics.total,   color: T.blue    },
            { label: "Resolved",      value: analytics.resolved, color: T.textSec },
            { label: "Wins",          value: analytics.wins,     color: T.green   },
            { label: "Losses",        value: analytics.resolved - analytics.wins, color: T.red },
            { label: "Pending",       value: analytics.pending,  color: T.yellow  },
            { label: "Overall Acc",   value: analytics.overallAcc ? analytics.overallAcc + "%" : "—", color: parseFloat(analytics.overallAcc) >= 55 ? T.green : T.red },
            { label: "Avg P&L",       value: analytics.avgPL ? (analytics.avgPL > 0 ? "+" : "") + analytics.avgPL + "%" : "—", color: parseFloat(analytics.avgPL) >= 0 ? T.green : T.red },
            { label: "Days Tracked",  value: dates.length,       color: T.indigo  },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: T.bgItem, border: `1px solid ${T.borderSub}`, borderRadius: 8, padding: "8px 12px", minWidth: 78, textAlign: "center", flex: "0 0 auto" }}>
              <div style={{ fontSize: 15, fontWeight: 800, color }}>{value}</div>
              <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 2, padding: "8px 20px", background: "#080d14", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          {[{ id: "tracker", label: "📋 Daily Tracker" }, { id: "analytics", label: "📊 Analytics" }, { id: "trend", label: "📈 Daily Trend" }].map(t => (
            <button key={t.id} type="button" onClick={() => setBtTab(t.id)} style={{ padding: "5px 14px", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "1px solid", borderColor: btTab === t.id ? T.blue : T.border, background: btTab === t.id ? `${T.blue}18` : "transparent", color: btTab === t.id ? T.blue : T.textDim }}>{t.label}</button>
          ))}
        </div>

        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <div style={{ width: 130, borderRight: `1px solid ${T.border}`, overflowY: "auto", background: "#080d14", flexShrink: 0 }}>
            <div style={{ padding: "8px 10px", fontSize: 9, color: T.textDim, fontWeight: 700, letterSpacing: "0.8px" }}>SESSIONS</div>
            {dates.length === 0 && <div style={{ padding: "12px 10px", fontSize: 10, color: T.textDim }}>No data yet</div>}
            {dates.map(d => {
              const dData = db[d];
              const r     = (dData.signals || []).filter(s => s.outcome === "WIN" || s.outcome === "LOSS");
              const w     = r.filter(s => s.outcome === "WIN").length;
              const acc   = r.length > 0 ? (w / r.length * 100).toFixed(0) : null;
              return (
                <div key={d} onClick={() => setActiveDate(d)} style={{ padding: "8px 10px", cursor: "pointer", borderBottom: `1px solid ${T.borderSub}`, background: activeDate === d ? `${T.blue}18` : "transparent", borderLeft: activeDate === d ? `2px solid ${T.blue}` : "2px solid transparent" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: activeDate === d ? T.blue : T.textSec }}>{d === todayKey() ? "Today" : d.slice(5)}</div>
                  <div style={{ fontSize: 9, color: T.textDim }}>{dData.signals?.length || 0} signals</div>
                  {acc !== null && <div style={{ fontSize: 9, fontWeight: 700, color: parseFloat(acc) >= 55 ? T.green : T.red }}>{acc}% acc</div>}
                </div>
              );
            })}
          </div>

          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
            {btTab === "tracker" && (
              <>
                <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: `1px solid ${T.border}`, flexShrink: 0, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: T.textSec, fontWeight: 700 }}>{activeDate}</span>
                  <input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ background: T.bgItem, border: `1px solid ${T.border}`, color: "#fff", padding: "4px 10px", borderRadius: 4, fontSize: 11, width: 120, outline: "none", fontFamily: "inherit" }} />
                  {["ALL","STRONG BUY","BUY","HOLD","SELL","STRONG SELL"].map(s => (
                    <button key={s} type="button" onClick={() => setFilterSig(s)} style={{ fontSize: 9, padding: "3px 8px", borderRadius: 3, cursor: "pointer", fontWeight: 700, border: `1px solid ${filterSig === s ? T.blue : T.border}`, background: filterSig === s ? `${T.blue}22` : "transparent", color: filterSig === s ? T.blue : T.textDim }}>{s}</button>
                  ))}
                  <span style={{ color: T.border }}>|</span>
                  {["ALL","WIN","LOSS","PENDING"].map(o => (
                    <button key={o} type="button" onClick={() => setFilterOutcome(o)} style={{ fontSize: 9, padding: "3px 8px", borderRadius: 3, cursor: "pointer", fontWeight: 700, border: `1px solid ${filterOutcome === o ? T.yellow : T.border}`, background: filterOutcome === o ? `${T.yellow}18` : "transparent", color: filterOutcome === o ? T.yellow : T.textDim }}>{o}</button>
                  ))}
                  <span style={{ marginLeft: "auto", fontSize: 10, color: T.textDim }}>{signals.length} rows</span>
                </div>

                {signals.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "60px 0", color: T.textDim }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>{dates.length === 0 ? "📭" : "🔍"}</div>
                    <div style={{ fontSize: 14, color: T.textSec, marginBottom: 8 }}>{dates.length === 0 ? "No sessions captured yet" : "No signals match filters"}</div>
                    <div style={{ fontSize: 12, color: T.textDim }}>{dates.length === 0 ? 'Click "Capture Now" to capture current signals' : "Try different filters"}</div>
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: "#060a10", position: "sticky", top: 0, zIndex: 2 }}>
                        {["Symbol","Signal","Score","Entry","EntryType","Gap%","SL","Target","RSI","MACD","Outcome","Exit ₹","P&L",""].map(h => (
                          <th key={h} style={{ padding: "8px 8px", color: T.textDim, fontSize: 9, fontWeight: 700, textAlign: "left", borderBottom: `1px solid ${T.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {signals.map(s => {
                        const pl = s.exitPrice && s.entry ? ((s.exitPrice - s.entry) / s.entry * 100) : null;
                        const outcomeColor = s.outcome === "WIN" ? T.green : s.outcome === "LOSS" ? T.red : T.textDim;
                        const entryColor = s.entryType === "MARKET_OPEN" ? T.green : s.entryType === "DAY_OPEN" ? T.blue : T.textDim;
                        return (
                          <tr key={s.id} style={{ borderBottom: `1px solid ${T.borderSub}` }} onMouseEnter={e => e.currentTarget.style.background = "#0d1520"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <td style={{ padding: "6px 8px", color: "#fff", fontWeight: 700 }}>{s.symbol}</td>
                            <td style={{ padding: "6px 8px" }}><SigBadge signal={s.signal} /></td>
                            <td style={{ padding: "6px 8px", fontWeight: 700, color: s.techScore >= 60 ? T.green : s.techScore <= 40 ? T.red : T.yellow }}>{s.techScore}</td>
                            <td style={{ padding: "6px 8px", color: T.blue }}>₹{fmt(s.entry)}</td>
                            <td style={{ padding: "6px 8px" }}>
                              <span style={{ fontSize: 8, fontWeight: 700, color: entryColor, background: `${entryColor}18`, border: `1px solid ${entryColor}33`, padding: "1px 5px", borderRadius: 3 }}>
                                {s.entryType === "MARKET_OPEN" ? "⚡LIVE" : s.entryType === "DAY_OPEN" ? "DAY" : "PRE"}
                              </span>
                            </td>
                            <td style={{ padding: "6px 8px", color: s.gapPct > 0.1 ? T.green : s.gapPct < -0.1 ? T.red : T.textDim, fontWeight: 600, fontSize: 10 }}>
                              {s.gapPct != null && Math.abs(s.gapPct) >= 0.1 ? `${s.gapPct > 0 ? "▲" : "▼"}${Math.abs(s.gapPct).toFixed(1)}%` : "—"}
                            </td>
                            <td style={{ padding: "6px 8px", color: T.red }}>₹{fmt(s.sl)}</td>
                            <td style={{ padding: "6px 8px", color: T.green }}>₹{fmt(s.tp)}</td>
                            <td style={{ padding: "6px 8px", color: s.rsi > 70 ? T.red : s.rsi < 30 ? T.green : T.yellow }}>{s.rsi?.toFixed(1) || "—"}</td>
                            <td style={{ padding: "6px 8px", color: s.macdCross === "BULLISH" ? T.green : T.red, fontSize: 10 }}>{s.macdCross === "BULLISH" ? "▲" : "▼"} {s.macdCross || "—"}</td>
                            <td style={{ padding: "6px 8px" }}>
                              <select value={s.outcome || ""} onChange={e => handleOutcome(activeDate, s.id, e.target.value || null)} style={{ background: "#111620", border: `1px solid ${outcomeColor}44`, color: outcomeColor, fontSize: 10, borderRadius: 4, padding: "3px 5px", cursor: "pointer" }}>
                                <option value="">Pending</option>
                                <option value="WIN">✅ WIN</option>
                                <option value="LOSS">❌ LOSS</option>
                                <option value="SKIP">⏭ SKIP</option>
                              </select>
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              <input type="number" placeholder="0.00" value={s.exitPrice || ""} onChange={e => handleExitPrice(activeDate, s.id, e.target.value)} style={{ width: 72, background: "#111620", border: `1px solid ${T.border}`, color: "#fff", fontSize: 10, borderRadius: 4, padding: "3px 6px", fontFamily: "inherit" }} />
                            </td>
                            <td style={{ padding: "6px 8px", fontWeight: 700, color: pl === null ? T.textDim : pl >= 0 ? T.green : T.red }}>{pl === null ? "—" : `${pl >= 0 ? "+" : ""}${pl.toFixed(2)}%`}</td>
                            <td style={{ padding: "6px 8px" }}>
                              <button type="button" onClick={() => handleDelete(activeDate, s.id)} style={{ background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 12 }}>🗑</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            )}

            {btTab === "analytics" && (
              <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {[
                  { title: "ACCURACY BY SIGNAL TYPE", entries: Object.entries(analytics.bySignal),   colorFn: ([sig]) => sig.includes("BUY") ? T.green : sig.includes("SELL") ? T.red : T.yellow },
                  { title: "ACCURACY BY RSI RANGE",   entries: Object.entries(analytics.rsiBuckets), colorFn: () => null },
                  { title: "ACCURACY BY TECH SCORE",  entries: Object.entries(analytics.byScore),    colorFn: () => T.indigo },
                  { title: "ACCURACY BY MACD",        entries: Object.entries(analytics.byMacd),     colorFn: ([cross]) => cross === "BULLISH" ? T.green : T.red },
                ].map(({ title, entries, colorFn }) => (
                  <div key={title} style={{ background: T.bgItem, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, letterSpacing: "0.8px", marginBottom: 14 }}>{title}</div>
                    {entries.length === 0
                      ? <div style={{ fontSize: 12, color: T.textDim }}>No resolved signals yet</div>
                      : entries.map(([k, { wins, total }]) => <AccBar key={k} label={k} wins={wins} total={total} color={colorFn([k])} />)
                    }
                  </div>
                ))}
              </div>
            )}

            {btTab === "trend" && (
              <div style={{ padding: 20 }}>
                <div style={{ background: T.bgItem, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, letterSpacing: "0.8px", marginBottom: 16 }}>DAILY ACCURACY TREND (LAST 14 DAYS)</div>
                  {analytics.dailyTrend.length === 0 ? (
                    <div style={{ fontSize: 12, color: T.textDim }}>No data yet</div>
                  ) : (
                    <>
                      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120, marginBottom: 12 }}>
                        {analytics.dailyTrend.map(d => {
                          const acc    = parseFloat(d.accuracy);
                          const height = d.accuracy ? Math.max(8, acc * 1.2) : 8;
                          const color  = d.accuracy ? (acc >= 60 ? T.green : acc >= 45 ? T.yellow : T.red) : T.textDim;
                          return (
                            <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                              <div style={{ fontSize: 9, color, fontWeight: 700 }}>{d.accuracy ? d.accuracy + "%" : "—"}</div>
                              <div style={{ width: "100%", height, background: color, borderRadius: "2px 2px 0 0", opacity: d.accuracy ? 1 : 0.3, minHeight: 4 }} />
                              <div style={{ fontSize: 8, color: T.textDim, transform: "rotate(-45deg)", whiteSpace: "nowrap" }}>{d.date.slice(5)}</div>
                            </div>
                          );
                        })}
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                        <thead>
                          <tr>{["Date","Signals","Resolved","Wins","Accuracy"].map(h => <th key={h} style={{ padding: "6px 8px", fontSize: 9, color: T.textDim, fontWeight: 700, textAlign: "left", borderBottom: `1px solid ${T.border}` }}>{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {analytics.dailyTrend.map(d => (
                            <tr key={d.date} style={{ borderBottom: `1px solid ${T.borderSub}`, cursor: "pointer" }} onClick={() => { setActiveDate(d.date); setBtTab("tracker"); }} onMouseEnter={e => e.currentTarget.style.background = "#0d1520"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                              <td style={{ padding: "6px 8px", color: d.date === todayKey() ? T.blue : T.textSec, fontWeight: d.date === todayKey() ? 700 : 400 }}>{d.date} {d.date === todayKey() ? "(today)" : ""}</td>
                              <td style={{ padding: "6px 8px", color: T.textPri }}>{btLoad()[d.date]?.signals?.length || 0}</td>
                              <td style={{ padding: "6px 8px", color: T.textSec }}>{d.total}</td>
                              <td style={{ padding: "6px 8px", color: T.green }}>{d.wins}</td>
                              <td style={{ padding: "6px 8px", fontWeight: 700, color: d.accuracy ? (parseFloat(d.accuracy) >= 60 ? T.green : parseFloat(d.accuracy) >= 45 ? T.yellow : T.red) : T.textDim }}>{d.accuracy ? d.accuracy + "%" : "No resolved"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: "8px 20px", borderTop: `1px solid ${T.border}`, fontSize: 10, color: T.textDim, background: "#080d14", flexShrink: 0, display: "flex", justifyContent: "space-between" }}>
          <span>💡 All data stored locally in browser · Click any date on left to view that session</span>
          <span>{Object.keys(db).length} sessions · {Object.values(db).reduce((a, d) => a + (d.signals?.length || 0), 0)} total signals</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function MarketScannerPage() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem(SESSION_KEY) === "1");
  if (!authed) return <AccessGate onAuth={() => setAuthed(true)} />;
  return <ScannerBody />;
}

function ScannerBody() {
  const [data,         setData]         = useState(null);
  const [selectedSym,  setSelectedSym]  = useState(null);
  const [tech,         setTech]         = useState(null);
  const [techLoading,  setTechLoading]  = useState(false);
  const [activeTF,     setActiveTF]     = useState("1day");
  const [tab,          setTab]          = useState("gainers");
  const [sortBy,       setSortBy]       = useState("gainers");
  const [searchQ,      setSearchQ]      = useState("");
  const [updatedAt,    setUpdatedAt]    = useState(null);
  const [showBacktest, setShowBacktest] = useState(false);
  const [displayLimit, setDisplayLimit] = useState(500);
  const [autoCapMsg,   setAutoCapMsg]   = useState("");
  const [livePriceMap, setLivePriceMap] = useState({});
  const [techVersion,  setTechVersion]  = useState(0);

  const techCacheRef   = useRef({});
  const selectedSymRef = useRef(null);
  const activeTFRef    = useRef("1day");
  const tableRef       = useRef(null);
  const autoCapFired   = useRef(false);
  const stockMapRef    = useRef(new Map());

  useEffect(() => { activeTFRef.current = activeTF; }, [activeTF]);

  // Auto-capture at 9:15–9:30 AM
  useEffect(() => {
    const tryAutoCapture = () => {
      if (autoCapFired.current) return;
      const now = new Date(); const h = now.getHours(); const m = now.getMinutes();
      if (h === 9 && m >= 15 && m <= 30) {
        const result = autoCapture(techCacheRef);
        if (result.count > 0) { setAutoCapMsg(`📸 Auto-captured ${result.count} signals at ${now.toLocaleTimeString("en-IN")}`); setTimeout(() => setAutoCapMsg(""), 6000); }
        autoCapFired.current = true;
      }
    };
    tryAutoCapture();
    const interval = setInterval(tryAutoCapture, 60000);
    return () => clearInterval(interval);
  }, []);

  const getStocksForTab = useCallback((d, t) => {
    if (!d) return [];
    if (t === "gainers")  return d.gainers          || [];
    if (t === "losers")   return d.losers           || [];
    if (t === "all")      return d.allStocks        || [];
    if (t === "largecap") return d.byMcap?.largecap || [];
    if (t === "midcap")   return d.byMcap?.midcap   || [];
    if (t === "smallcap") return d.byMcap?.smallcap || [];
    if (t === "microcap") return d.byMcap?.microcap || [];
    return [];
  }, []);

  const rebuildDataFromMap = useCallback((map) => {
    const stocks  = [...map.values()];
    const sorted  = [...stocks].sort((a, b) => b.changePct - a.changePct);
    const gainers = sorted.filter(s => s.changePct > 0).slice(0, 20);
    const losers  = [...sorted].reverse().filter(s => s.changePct < 0).slice(0, 20);
    const byMcap  = { largecap: [], midcap: [], smallcap: [], microcap: [] };
    for (const s of stocks) { const b = s.mcapBucket || "microcap"; if (byMcap[b]) byMcap[b].push(s); }

    const sectorMap = {};
    for (const s of stocks) { if (!s.sector) continue; if (!sectorMap[s.sector]) sectorMap[s.sector] = []; sectorMap[s.sector].push(s); }
    const bySector = Object.entries(sectorMap).map(([sector, ss]) => ({
      sector,
      avgChange:  Math.round((ss.reduce((sum, s) => sum + s.changePct, 0) / ss.length) * 100) / 100,
      advancing:  ss.filter(s => s.changePct > 0).length,
      declining:  ss.filter(s => s.changePct < 0).length,
      total:      ss.length,
      topGainer:  [...ss].sort((a, b) => b.changePct - a.changePct)[0],
    })).sort((a, b) => b.avgChange - a.avgChange);

    setData({
      gainers, losers, allStocks: stocks, byMcap, bySector,
      market: {
        advancing: stocks.filter(s => s.changePct > 0).length,
        declining: stocks.filter(s => s.changePct < 0).length,
        unchanged: stocks.filter(s => s.changePct === 0).length,
        total:     stocks.length,
      },
      updatedAt: Date.now(),
    });
    setUpdatedAt(new Date());
  }, []);

  // ── REST fallback — fires after 4s if socket hasn't delivered a snapshot ──
  // Handles weekends and slow connections where scanner:snapshot never arrives
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (stockMapRef.current.size > 0) return; // socket already delivered data
      try {
        const res = await fetch("/api/scanner");
const d   = await res.json();
if (d.error && !d.weekend) return; // block only real errors, not weekend state
// If weekend but no data yet, retry after 8s
if (d.error && d.weekend) {
  setTimeout(async () => {
    try {
      const r2 = await fetch("/api/scanner");
      const d2 = await r2.json();
      if (d2.gainers?.length || d2.losers?.length) {
        const map = new Map();
        const seen = new Set();
        [...(d2.gainers||[]), ...(d2.losers||[]), ...Object.values(d2.byMcap||{}).flat()]
          .forEach(s => { if (s?.symbol && !seen.has(s.symbol)) { seen.add(s.symbol); map.set(s.symbol, s); } });
        if (map.size > 0) { stockMapRef.current = map; rebuildDataFromMap(map); }
      }
    } catch {}
  }, 8000);
  return;
}
        // weekends: still load the cached last-session data
        const map  = new Map();
        const seen = new Set();
        const all  = [
          ...(d.gainers  || []),
          ...(d.losers   || []),
          ...Object.values(d.byMcap || {}).flat(),
        ];
        all.forEach(s => {
          if (s?.symbol && !seen.has(s.symbol)) {
            seen.add(s.symbol);
            map.set(s.symbol, s);
          }
        });
        if (map.size > 0) {
          stockMapRef.current = map;
          rebuildDataFromMap(map);
        }
      } catch {}
    }, 4000);
    return () => clearTimeout(timer);
  }, [rebuildDataFromMap]);

  // ── Live-ranked gainers/losers with real-time re-sort ─────────────────────
  const liveRankedGainers = useMemo(() => {
    if (!data?.allStocks?.length) return data?.gainers || [];
    return [...data.allStocks]
      .map(s => {
        const lp = livePriceMap[s.symbol];
        if (!lp) return { ...s, _livePct: s.changePct };
        let pc = s.prevClose || 0;
        if (pc <= 0 && s.ltp > 0) pc = s.ltp / (1 + (s.changePct || 0.001) / 100);
        if (pc <= 0) pc = s.ltp;
        const pct = pc > 0 ? ((lp - pc) / pc) * 100 : s.changePct;
        return { ...s, _livePct: pct, ltp: lp };
      })
      .filter(s => (s._livePct ?? s.changePct) > 0)
      .sort((a, b) => (b._livePct ?? b.changePct) - (a._livePct ?? a.changePct))
      .slice(0, 20);
  }, [data?.allStocks, livePriceMap]);

  const liveRankedLosers = useMemo(() => {
    if (!data?.allStocks?.length) return data?.losers || [];
    return [...data.allStocks]
      .map(s => {
        const lp = livePriceMap[s.symbol];
        if (!lp) return { ...s, _livePct: s.changePct };
        let pc = s.prevClose || 0;
        if (pc <= 0 && s.ltp > 0) pc = s.ltp / (1 + (s.changePct || 0.001) / 100);
        if (pc <= 0) pc = s.ltp;
        const pct = pc > 0 ? ((lp - pc) / pc) * 100 : s.changePct;
        return { ...s, _livePct: pct, ltp: lp };
      })
      .filter(s => (s._livePct ?? s.changePct) < 0)
      .sort((a, b) => (a._livePct ?? a.changePct) - (b._livePct ?? b.changePct))
      .slice(0, 20);
  }, [data?.allStocks, livePriceMap]);

  // ── Socket setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    socket.emit("join:scanner");
    socket.emit("join:alerts");
    socket.emit("backtest:start");

    socket.on("scanner:snapshot", (allStocks) => {
      if (!Array.isArray(allStocks)) return;
      const map = new Map();
      allStocks.forEach(s => map.set(s.symbol, s));
      stockMapRef.current = map;
      rebuildDataFromMap(map);
    });

    socket.on("scanner:diff", (diffs) => {
      if (!Array.isArray(diffs) || !diffs.length) return;
      diffs.forEach(d => {
        const stock = d.s !== undefined ? expandDiffStock(d) : d;
        if (stock.symbol) stockMapRef.current.set(stock.symbol, stock);
      });
      rebuildDataFromMap(stockMapRef.current);
    });

    socket.on("scanner-update", d => {
      setData(d);
      setUpdatedAt(new Date(d.updatedAt));
      if (d.allStocks) {
        const map = new Map();
        d.allStocks.forEach(s => map.set(s.symbol, s));
        stockMapRef.current = map;
      }
    });

    socket.on("scanner-tech-batch", (batch) => {
      if (!Array.isArray(batch) || !batch.length) return;
      const priceUpdates = {};
      let hasNew = false;
      for (const { key, data: techData } of batch) {
        if (!key || !techData) continue;
        const existing = techCacheRef.current[key];
        if (!existing || techData.computedAt > existing.computedAt) {
          techCacheRef.current[key] = techData;
          hasNew = true;
          if (key.endsWith(":1day") && techData.ltp) {
            const sym = key.replace(":1day", "");
            priceUpdates[sym] = techData.ltp;
          }
          if (selectedSymRef.current) {
            const panelKey = `${selectedSymRef.current}:${activeTFRef.current}`;
            if (key === panelKey) setTech(techData);
          }
        }
      }
      if (hasNew) setTechVersion(v => v + 1);
      if (Object.keys(priceUpdates).length > 0) setLivePriceMap(prev => ({ ...prev, ...priceUpdates }));
    });

    socket.on("ltp", ({ s, p }) => {
      if (s && p > 0) setLivePriceMap(prev => ({ ...prev, [s]: p }));
    });

    socket.on("backtest-live-tick", ({ symbol: sym, price }) => {
      if (sym && price > 0) setLivePriceMap(prev => ({ ...prev, [sym]: price }));
    });

    return () => {
      socket.emit("leave:scanner");
      socket.emit("leave:alerts");
      socket.off("scanner:snapshot");
      socket.off("scanner:diff");
      socket.off("scanner-update");
      socket.off("scanner-tech-batch");
      socket.off("ltp");
      socket.off("backtest-live-tick");
    };
  }, [rebuildDataFromMap]);

  const handleSelect = useCallback(async (symbol, timeframe) => {
    const tf  = timeframe || activeTFRef.current || "1day";
    const key = `${symbol}:${tf}`;
    selectedSymRef.current = symbol;
    setSelectedSym(symbol);
    getSocket().emit("watch:chart", symbol);
    if (techCacheRef.current[key]) { setTech(techCacheRef.current[key]); setTechLoading(false); return; }
    setTech(null); setTechLoading(true);
    try {
      const res  = await fetch(`/api/scanner/technicals/${symbol}?timeframe=${tf}`);
      const json = await res.json();
      if (json && !json.error) {
        techCacheRef.current[key] = json;
        if (selectedSymRef.current === symbol) { setTech(json); setTechLoading(false); }
      } else {
        if (selectedSymRef.current === symbol) setTechLoading(false);
      }
    } catch {
      if (selectedSymRef.current === symbol) setTechLoading(false);
    }
  }, []);

  const handleTimeframeChange = useCallback((tf) => {
    setActiveTF(tf); activeTFRef.current = tf;
    if (selectedSymRef.current) handleSelect(selectedSymRef.current, tf);
  }, [handleSelect]);

  const handleViewAll = useCallback((tabId) => {
    setTab(tabId); setSortBy(tabId === "losers" ? "losers" : "gainers");
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }, []);

  const stocks   = getStocksForTab(data, tab);
  const filtered = searchQ
    ? stocks.filter(s => s.symbol.includes(searchQ.toUpperCase()) || (s.name || "").toLowerCase().includes(searchQ.toLowerCase()))
    : stocks;

  const sorted = [...filtered].sort((a, b) => {
    const getPct = (s) => {
      const lp = livePriceMap[s.symbol]; if (!lp) return s.changePct;
      let pc = s.prevClose || 0;
      if (pc <= 0 && s.changePct !== 0 && s.ltp > 0) pc = s.ltp / (1 + s.changePct / 100);
      if (pc <= 0) pc = s.ltp;
      return pc > 0 ? ((lp - pc) / pc) * 100 : s.changePct;
    };
    if (sortBy === "gainers") return getPct(b) - getPct(a);
    if (sortBy === "losers")  return getPct(a) - getPct(b);
    if (sortBy === "volume")  return b.volume     - a.volume;
    if (sortBy === "value")   return b.totalValue - a.totalValue;
    return 0;
  });

  const TABS = [
    { id: "gainers",  label: "Top Gainers", accent: T.green   },
    { id: "losers",   label: "Top Losers",  accent: T.red     },
    { id: "all",      label: "All Stocks",  accent: T.blue    },
    { id: "largecap", label: "Large Cap",   accent: T.indigo  },
    { id: "midcap",   label: "Mid Cap",     accent: T.green   },
    { id: "smallcap", label: "Small Cap",   accent: T.purple  },
    { id: "microcap", label: "Micro Cap",   accent: T.textSec },
    { id: "sector",   label: "Sectors",     accent: T.yellow  },
  ];

  const liveCount      = Object.keys(livePriceMap).length;
  const totalBtSignals = (() => { try { const db = JSON.parse(localStorage.getItem(BT_KEY) || "{}"); return Object.values(db).reduce((a, d) => a + (d.signals?.length || 0), 0); } catch { return 0; } })();
  const todayBtCount   = (() => { try { const db = JSON.parse(localStorage.getItem(BT_KEY) || "{}"); return db[todayKey()]?.signals?.length || 0; } catch { return 0; } })();
  const market         = data?.market || {};

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.textPri, fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" }}>

      {/* Top bar */}
      <div style={{ background: "#080d14", borderBottom: `1px solid ${T.border}`, padding: "12px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 900, color: T.textPri, letterSpacing: "0.8px" }}>📊 MARKET SCANNER</div>
          <div style={{ fontSize: 10, color: T.textDim }}>NSE 500 + BSE · Live data + Upstox historical</div>
        </div>

        {data?.market && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ background: "#052e16", border: "1px solid #4ade8044", borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.green, fontWeight: 700 }}>▲ {market.advancing}</span>
            <span style={{ background: "#3b0a0a", border: "1px solid #f8717144", borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.red,   fontWeight: 700 }}>▼ {market.declining}</span>
            <span style={{ background: "#1a2030", border: "1px solid #4a608044", borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.textSec }}>— {market.unchanged}</span>
            <BreadthBar advancing={market.advancing} declining={market.declining} unchanged={market.unchanged} total={market.total} />
            <span style={{ fontSize: 10, color: T.textDim }}>{market.total} stocks</span>
          </div>
        )}

        {liveCount > 0 && (
          <div style={{ background: "#052e16", border: "1px solid #4ade8033", borderRadius: 6, padding: "3px 10px", fontSize: 10, color: T.green, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.green, display: "inline-block", animation: "pulse 1.5s infinite" }} />
            {liveCount} live prices
            <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
          </div>
        )}

        {autoCapMsg && (
          <div style={{ background: "#052e16", border: "1px solid #4ade8044", borderRadius: 6, padding: "4px 12px", fontSize: 11, color: T.green, fontWeight: 600 }}>{autoCapMsg}</div>
        )}

        <button type="button" onClick={() => setShowBacktest(true)}
          style={{ background: "#1a1040", border: `1px solid ${T.indigo}44`, color: T.indigo, padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}
        >
          🔬 Backtest Lab
          {totalBtSignals > 0 && <span style={{ background: T.indigo, color: "#fff", fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 10 }}>{totalBtSignals}</span>}
          {todayBtCount > 0 && <span style={{ fontSize: 9, color: T.green }}>✓ today</span>}
        </button>

        <div style={{ marginLeft: "auto", fontSize: 10, color: T.textDim }}>
          {updatedAt ? `Snapshot ${updatedAt.toLocaleTimeString("en-IN")}` : "Connecting…"}
        </div>
      </div>

      {/* Weekend banner */}
      {(new Date().getDay() === 0 || new Date().getDay() === 6) && (
        <div style={{ background: "#1a120a", borderBottom: "1px solid #f59e0b44", padding: "8px 20px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14 }}>⏸</span>
          <span style={{ fontSize: 12, color: "#f59e0b", fontWeight: 700 }}>
            Weekend — Showing last session data (Friday close)
          </span>
          <span style={{ fontSize: 11, color: "#78716c", marginLeft: 4 }}>
            · Change % is vs Thursday's close · Live prices resume Monday 9:15 AM IST
          </span>
        </div>
      )}

      {/* Main content */}
      <div style={{ padding: "16px 20px 40px", paddingRight: selectedSym ? "434px" : "20px", transition: "padding-right 0.2s" }}>

        {data && (
          <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
            <GainLossCard title="TOP GAINERS" stocks={liveRankedGainers} onSelect={sym => handleSelect(sym)} accent={T.green} onViewAll={() => handleViewAll("gainers")} livePriceMap={livePriceMap} />
            <GainLossCard title="TOP LOSERS"  stocks={liveRankedLosers}  onSelect={sym => handleSelect(sym)} accent={T.red}   onViewAll={() => handleViewAll("losers")}  livePriceMap={livePriceMap} />
          </div>
        )}

        <div ref={tableRef} style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
          {TABS.map(t => (
            <button type="button" key={t.id} onClick={e => { e.preventDefault(); setTab(t.id); setDisplayLimit(500); }}
              style={{ padding: "5px 13px", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "1px solid", borderColor: tab === t.id ? t.accent : T.border, background: tab === t.id ? `${t.accent}18` : T.bgPanel, color: tab === t.id ? t.accent : T.textDim, transition: "all 0.15s" }}
            >
              {t.label}
              {data && t.id !== "sector" && (
                <span style={{ marginLeft: 5, fontSize: 9, opacity: 0.7 }}>
                  {t.id === "gainers"  ? (data.gainers?.length          || 0) :
                   t.id === "losers"   ? (data.losers?.length           || 0) :
                   t.id === "all"      ? (data.allStocks?.length        || 0) :
                   t.id === "largecap" ? (data.byMcap?.largecap?.length || 0) :
                   t.id === "midcap"   ? (data.byMcap?.midcap?.length   || 0) :
                   t.id === "smallcap" ? (data.byMcap?.smallcap?.length || 0) :
                   t.id === "microcap" ? (data.byMcap?.microcap?.length || 0) : ""}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === "sector" ? (
          <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: T.textDim, fontWeight: 700, letterSpacing: "1px", marginBottom: 10 }}>SECTOR PERFORMANCE — NSE 500 + BSE</div>
            {(data?.bySector || []).map(s => <SectorBar key={s.sector} sector={s} />)}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input placeholder="Search symbol or name…" value={searchQ} onChange={e => setSearchQ(e.target.value)}
                style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 6, color: "#ffffff", padding: "6px 12px", fontSize: 12, width: 220, outline: "none", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: 4 }}>
                {[{ id: "gainers", label: "% ↑" }, { id: "losers", label: "% ↓" }, { id: "volume", label: "Vol" }, { id: "value", label: "Value" }].map(s => (
                  <button type="button" key={s.id} onClick={e => { e.preventDefault(); setSortBy(s.id); }}
                    style={{ padding: "5px 10px", fontSize: 10, borderRadius: 4, cursor: "pointer", border: "1px solid", fontWeight: 700, borderColor: sortBy === s.id ? T.indigo : T.border, background: sortBy === s.id ? `${T.indigo}22` : T.bgPanel, color: sortBy === s.id ? T.indigo : T.textDim }}
                  >{s.label}</button>
                ))}
              </div>
              <span style={{ marginLeft: "auto", fontSize: 11, color: T.textDim }}>
                Showing {Math.min(sorted.length, displayLimit)} of {sorted.length} stocks
              </span>
            </div>

            {!data ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: T.textDim }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>📡</div>
                <div style={{ fontSize: 14, color: T.textSec }}>
                  {new Date().getDay() === 0 || new Date().getDay() === 6
                    ? "⏸ Weekend — last session data loading…"
                    : "Connecting to scanner room…"}
                </div>
              </div>
            ) : sorted.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: T.textDim }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>📭</div>
                <div style={{ color: T.textSec }}>No stocks in this category yet</div>
              </div>
            ) : (
              <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#080d14", borderBottom: `1px solid ${T.border}` }}>
                      {["#", "Symbol", "LTP", "Change", "Volume", "Cap", "RSI", "MACD", "Bollinger", "MA Signal"].map(h => (
                        <th key={h} style={{ padding: "8px 8px", fontSize: 10, color: "#94a3b8", fontWeight: 700, textAlign: ["LTP", "Change", "Volume"].includes(h) ? "right" : "left", letterSpacing: "0.5px", position: "sticky", top: 0, background: "#080d14", zIndex: 1 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.slice(0, displayLimit).map((s, i) => (
                      <StockRow key={s.symbol} stock={s} rank={i + 1} onSelect={sym => handleSelect(sym)} selected={selectedSym === s.symbol} tech={techCacheRef.current[`${s.symbol}:${activeTF}`] || null} livePrice={livePriceMap[s.symbol] ?? null} _v={techVersion} />
                    ))}
                  </tbody>
                </table>
                {sorted.length > displayLimit && (
                  <div style={{ textAlign: "center", padding: "12px", borderTop: `1px solid ${T.borderSub}` }}>
                    <button type="button" onClick={() => setDisplayLimit(l => l + 500)} style={{ background: T.bgItem, border: `1px solid ${T.border}`, color: T.textSec, padding: "8px 20px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                      Load more ({sorted.length - displayLimit} remaining)
                    </button>
                  </div>
                )}
                {sorted.length <= displayLimit && sorted.length > 0 && (
                  <div style={{ textAlign: "center", padding: "8px", fontSize: 10, color: T.textDim, borderTop: `1px solid ${T.borderSub}` }}>
                    ✅ All {sorted.length} stocks shown
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {selectedSym && (
        <TechPanel
          symbol={selectedSym}
          tech={tech}
          loading={techLoading}
          timeframe={activeTF}
          livePrice={livePriceMap[selectedSym] ?? null}
          onTimeframeChange={handleTimeframeChange}
          onClose={() => {
            selectedSymRef.current = null;
            setSelectedSym(null);
            setTech(null);
            setActiveTF("1day");
            activeTFRef.current = "1day";
            getSocket().emit("watch:chart", null);
          }}
        />
      )}

      {showBacktest && <BacktestPanel onClose={() => setShowBacktest(false)} techCacheRef={techCacheRef} />}
    </div>
  );
}