import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

// ── Socket singleton ──────────────────────────────────────────────────────────
let _socket = null;
function getSocket() {
  if (!_socket) _socket = io({ transports: ["websocket"] });
  return _socket;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (n, d = 2) => n == null ? "—" : Number(n).toFixed(d);
const fmtK = (n) => {
  if (!n) return "—";
  if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(2) + " L";
  return n.toLocaleString("en-IN");
};
const clr  = (v) => v > 0 ? "#22c55e" : v < 0 ? "#ef4444" : "#888";
const arrow = (v) => v > 0 ? "▲" : v < 0 ? "▼" : "—";
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

// ── Theme tokens (readable on dark bg) ───────────────────────────────────────
const T = {
  bg:        "#060a10",
  bgPanel:   "#0a0f16",
  bgCard:    "#0d1117",
  bgItem:    "#111620",
  border:    "#1e2a3a",
  borderSub: "#192130",
  textPri:   "#e2eaf4",
  textSec:   "#7a8fa6",
  textDim:   "#3d5068",
  green:     "#22c55e",
  red:       "#ef4444",
  yellow:    "#f59e0b",
  blue:      "#3b82f6",
  purple:    "#a78bfa",
  indigo:    "#818cf8",
};

// ── Timeframes ────────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { id: "5min",   label: "5m"  },
  { id: "15min",  label: "15m" },
  { id: "1hour",  label: "1H"  },
  { id: "4hour",  label: "4H"  },
  { id: "1day",   label: "1D"  },
  { id: "1week",  label: "1W"  },
  { id: "1month", label: "1M"  },
];

// ── Shared small components ───────────────────────────────────────────────────
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
    "STRONG BUY":  { bg: "#14532d", color: "#22c55e" },
    "BUY":         { bg: "#052e16", color: "#4ade80" },
    "HOLD":        { bg: "#431407", color: "#f59e0b" },
    "SELL":        { bg: "#450a0a", color: "#f87171" },
    "STRONG SELL": { bg: "#3b0a0a", color: "#ef4444" },
    "N/A":         { bg: "#1a2030", color: "#4a5568" },
  };
  const s = map[signal] || map["N/A"];
  return (
    <span style={{
      background: s.bg, color: s.color, border: `1px solid ${s.color}44`,
      fontSize: 9, fontWeight: 700, padding: "2px 7px",
      borderRadius: 3, letterSpacing: "0.5px", whiteSpace: "nowrap",
    }}>{signal || "N/A"}</span>
  );
}

// ── Stock row ─────────────────────────────────────────────────────────────────
function StockRow({ stock, rank, onSelect, selected, tech }) {
  const pct = stock.changePct;
  return (
    <tr
      onClick={() => onSelect(stock.symbol)}
      style={{
        cursor: "pointer",
        background: selected ? "#0f2a1a" : "transparent",
        borderBottom: `1px solid ${T.borderSub}`,
        transition: "background 0.12s",
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "#0d1520"; }}
      onMouseLeave={e => { e.currentTarget.style.background = selected ? "#0f2a1a" : "transparent"; }}
    >
      <td style={{ padding: "7px 8px", color: T.textDim, fontSize: 10, width: 28 }}>{rank}</td>
      <td style={{ padding: "7px 8px" }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: T.textPri }}>{stock.symbol}</div>
        <div style={{ fontSize: 10, color: T.textDim, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {stock.name}
        </div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right" }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: T.textPri }}>₹{fmt(stock.ltp)}</div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right" }}>
        <div style={{ color: clr(pct), fontWeight: 700, fontSize: 12 }}>
          {arrow(pct)} {fmt(Math.abs(pct))}%
        </div>
        <div style={{ color: clr(stock.change), fontSize: 10 }}>
          {stock.change > 0 ? "+" : ""}{fmt(stock.change)}
        </div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right", color: T.textSec, fontSize: 11 }}>
        {fmtK(stock.volume)}
      </td>
      <td style={{ padding: "7px 8px" }}>
        <span style={{
          fontSize: 10, padding: "2px 6px", borderRadius: 3, fontWeight: 600,
          background: stock.mcapBucket === "largecap" ? "#1e2060" :
                      stock.mcapBucket === "midcap"   ? "#0e3020" :
                      stock.mcapBucket === "smallcap" ? "#2a1060" : "#1a1a2a",
          color:      stock.mcapBucket === "largecap" ? T.indigo :
                      stock.mcapBucket === "midcap"   ? T.green  :
                      stock.mcapBucket === "smallcap" ? T.purple : T.textSec,
        }}>{stock.mcapLabel || "—"}</span>
      </td>
      {/* RSI */}
      <td style={{ padding: "7px 8px" }}>
        {tech ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 46, height: 4, background: "#1a2030", borderRadius: 2, overflow: "hidden" }}>
              <div style={{
                width: `${tech.rsi || 0}%`, height: "100%", borderRadius: 2,
                background: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow,
              }} />
            </div>
            <span style={{ color: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow, fontSize: 11, fontWeight: 600 }}>
              {fmt(tech.rsi, 1)}
            </span>
          </div>
        ) : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
      {/* MACD */}
      <td style={{ padding: "7px 8px" }}>
        {tech?.macd ? (
          <span style={{ color: tech.macd.crossover === "BULLISH" ? T.green : T.red, fontSize: 11, fontWeight: 700 }}>
            {tech.macd.crossover === "BULLISH" ? "▲" : "▼"} {fmt(tech.macd.macd)}
          </span>
        ) : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
      {/* Bollinger */}
      <td style={{ padding: "7px 8px" }}>
        {tech?.bollingerBands ? (
          <span style={{ fontSize: 11, fontWeight: 600, color:
            tech.bollingerBands.position === "ABOVE_UPPER" ? T.red :
            tech.bollingerBands.position === "BELOW_LOWER" ? T.green :
            tech.bollingerBands.position === "NEAR_UPPER"  ? "#f97316" :
            tech.bollingerBands.position === "NEAR_LOWER"  ? "#38bdf8" : T.textSec,
          }}>
            {{
              ABOVE_UPPER: "Above BB",
              NEAR_UPPER:  "Near Upper",
              MIDDLE:      "Mid BB",
              NEAR_LOWER:  "Near Lower",
              BELOW_LOWER: "Below BB",
            }[tech.bollingerBands.position] || tech.bollingerBands.position}
          </span>
        ) : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
      {/* MA Signal */}
      <td style={{ padding: "7px 8px" }}>
        {tech?.maSummary ? <SigBadge signal={tech.maSummary.summary} /> : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
    </tr>
  );
}

// ── Technical Detail Panel ────────────────────────────────────────────────────
function TechPanel({ symbol, tech, loading, timeframe, onTimeframeChange, onClose }) {
  if (!symbol) return null;

  const scoreColor = tech
    ? tech.techScore >= 60 ? T.green : tech.techScore <= 40 ? T.red : T.yellow
    : T.textSec;

  const sigBgClass = tech
    ? tech.signal?.includes("BUY")  ? "#14532d"
    : tech.signal?.includes("SELL") ? "#3b0a0a" : "#431407"
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

  return (
    <div style={{
      position: "fixed", right: 0, top: 0, width: 370, height: "100vh",
      background: T.bgCard, borderLeft: `1px solid ${T.border}`,
      overflowY: "auto", zIndex: 100, padding: "16px 14px",
      boxShadow: "-12px 0 48px rgba(0,0,0,0.7)",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.textPri, letterSpacing: "0.5px" }}>{symbol}</div>
          <div style={{ fontSize: 11, color: T.textSec }}>Technical Analysis · Multi-timeframe</div>
        </div>
        <button onClick={onClose} style={{
          background: T.bgItem, border: `1px solid ${T.border}`, color: T.textSec,
          width: 28, height: 28, borderRadius: 5, cursor: "pointer", fontSize: 14,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>✕</button>
      </div>

      {/* Timeframe bar */}
      <div style={{
        display: "flex", gap: 2, marginBottom: 14,
        background: "#080d14", padding: 3, borderRadius: 7, border: `1px solid ${T.border}`,
      }}>
        {TIMEFRAMES.map(tf => (
          <button key={tf.id} onClick={() => onTimeframeChange(tf.id)} style={{
            flex: 1, padding: "5px 0", fontSize: 10, fontWeight: 700,
            borderRadius: 5, cursor: "pointer", border: "none",
            background: timeframe === tf.id ? T.indigo : "transparent",
            color:      timeframe === tf.id ? "#fff"   : T.textDim,
            transition: "all 0.15s",
          }}>{tf.label}</button>
        ))}
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: "50px 0", color: T.textSec }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>⏳</div>
          <div style={{ fontSize: 13 }}>Loading {timeframe} data…</div>
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>Fetching candles from Upstox</div>
        </div>
      )}

      {!loading && !tech && (
        <div style={{ textAlign: "center", padding: "50px 0", color: T.textSec }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>📭</div>
          <div style={{ fontSize: 13 }}>No data for {timeframe}</div>
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>
            Check Upstox token · intraday needs valid instrument key
          </div>
        </div>
      )}

      {!loading && tech && (
        <>
          {/* ── Live Signal Card ── */}
          <div style={{
            background: sigBgClass, border: `1px solid ${tech.signal?.includes("BUY") ? "#22c55e44" : tech.signal?.includes("SELL") ? "#ef444444" : "#f59e0b44"}`,
            borderRadius: 10, padding: "14px 16px", marginBottom: 10,
          }}>
            <div style={{ fontSize: 10, color: T.textSec, fontWeight: 700, letterSpacing: "0.8px", marginBottom: 10 }}>
              LIVE SIGNAL · {timeframe.toUpperCase()}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              {/* Score ring */}
              <svg viewBox="0 0 56 56" width="56" height="56" style={{ flexShrink: 0 }}>
                <circle cx="28" cy="28" r="22" fill="none" stroke="#1a2030" strokeWidth="4"/>
                <circle cx="28" cy="28" r="22" fill="none" stroke={scoreColor} strokeWidth="4"
                  strokeDasharray={`${Math.round(2 * Math.PI * 22 * tech.techScore / 100)} ${Math.round(2 * Math.PI * 22)}`}
                  strokeDashoffset={Math.round(2 * Math.PI * 22 * 0.25)}
                  strokeLinecap="round"/>
                <text x="28" y="33" textAnchor="middle" fontSize="13" fontWeight="700" fill={scoreColor}>{tech.techScore}</text>
              </svg>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: scoreColor, marginBottom: 3 }}>
                  {tech.signal}
                </div>
                <div style={{ height: 6, background: "#1a2030", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${tech.strength || tech.techScore}%`, height: "100%", background: scoreColor, borderRadius: 3, transition: "width 0.4s" }} />
                </div>
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 4 }}>
                  {(tech.strength || tech.techScore)}/100 · {(tech.strength || tech.techScore) >= 65 ? "Strong" : (tech.strength || tech.techScore) >= 50 ? "Moderate" : "Weak"}
                </div>
              </div>
            </div>
            {/* Entry / SL / TP */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {[
                { label: "Entry", value: tech.entry, color: T.blue },
                { label: "Stop Loss", value: tech.sl, color: T.red },
                { label: "Target", value: tech.tp, color: T.green },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: "#0d1117", border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 8px", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: T.textSec, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color }}>₹{fmt(value)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Momentum ── */}
          <Card title="Momentum">
            {/* RSI */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: T.textSec }}>RSI (14)</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow }}>
                  {fmt(tech.rsi, 1)}
                </span>
              </div>
              <MiniBar value={tech.rsi || 0} color={tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                <span style={{ fontSize: 9, color: T.textDim }}>OS 30</span>
                <span style={{ fontSize: 9, color: T.textDim }}>70 OB</span>
              </div>
              <div style={{ fontSize: 11, color: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.textSec, marginTop: 4 }}>
                {tech.rsi > 70 ? "⚠️ Overbought — potential reversal" : tech.rsi < 30 ? "✅ Oversold — potential bounce" : "RSI in neutral zone"}
              </div>
            </div>
            {/* Stochastic */}
            {tech.stochastic && (
              <div style={{ marginBottom: 10, paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ fontSize: 11, color: T.textSec, marginBottom: 5 }}>Stochastic %K / %D</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span style={{ fontSize: 9, color: T.textDim }}>%K</span>
                      <span style={{ fontSize: 11, color: T.textPri, fontWeight: 600 }}>{fmt(tech.stochastic.k, 1)}</span>
                    </div>
                    <MiniBar value={tech.stochastic.k} color={tech.stochastic.k > 80 ? T.red : tech.stochastic.k < 20 ? T.green : T.yellow} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span style={{ fontSize: 9, color: T.textDim }}>%D</span>
                      <span style={{ fontSize: 11, color: T.textPri, fontWeight: 600 }}>{fmt(tech.stochastic.d, 1)}</span>
                    </div>
                    <MiniBar value={tech.stochastic.d} color={T.blue} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: T.textSec }}>
                  {tech.stochastic.k > tech.stochastic.d ? "Bullish cross" : "Bearish cross"} · {tech.stochastic.k > 80 ? "Overbought" : tech.stochastic.k < 20 ? "Oversold" : "Neutral"}
                </div>
              </div>
            )}
            {/* Williams %R */}
            {tech.williamsR != null && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>Williams %R</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tech.williamsR > -20 ? T.red : tech.williamsR < -80 ? T.green : T.yellow }}>
                    {fmt(tech.williamsR, 1)}
                  </span>
                </div>
                <MiniBar value={clamp(100 + tech.williamsR, 0, 100)} color={tech.williamsR > -20 ? T.red : tech.williamsR < -80 ? T.green : T.yellow} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                  <span style={{ fontSize: 9, color: T.textDim }}>OB -20</span>
                  <span style={{ fontSize: 9, color: T.textDim }}>-80 OS</span>
                </div>
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 3 }}>
                  {tech.williamsR > -20 ? "Overbought zone" : tech.williamsR < -80 ? "Oversold zone" : "Mid range"}
                </div>
              </div>
            )}
            {/* MFI */}
            {tech.mfi != null && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}`, marginTop: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>MFI (Money Flow)</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tech.mfi > 80 ? T.red : tech.mfi < 20 ? T.green : T.yellow }}>
                    {fmt(tech.mfi, 1)}
                  </span>
                </div>
                <MiniBar value={tech.mfi} color={tech.mfi > 80 ? T.red : tech.mfi < 20 ? T.green : T.yellow} />
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 3 }}>
                  {tech.mfi > 80 ? "Overbought" : tech.mfi < 20 ? "Oversold" : "Neutral"} · {tech.mfi > 50 ? "Money flowing in" : "Money flowing out"}
                </div>
              </div>
            )}
          </Card>

          {/* ── Trend ── */}
          <Card title="Trend">
            {/* MACD */}
            {tech.macd && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: T.textSec, marginBottom: 6 }}>MACD (12, 26, 9)</div>
                <Row label="MACD Line" value={fmt(tech.macd.macd)} color={tech.macd.macd > 0 ? T.green : T.red} />
                <Row label="Signal"    value={fmt(tech.macd.signal)} />
                <Row label="Histogram" value={fmt(tech.macd.histogram)} color={tech.macd.histogram > 0 ? T.green : T.red} />
                <div style={{
                  marginTop: 8, padding: "5px 10px", borderRadius: 5, textAlign: "center",
                  background: tech.macd.crossover === "BULLISH" ? "#052e16" : "#3b0a0a",
                  color:      tech.macd.crossover === "BULLISH" ? T.green : T.red,
                  fontSize: 12, fontWeight: 700, border: `1px solid ${tech.macd.crossover === "BULLISH" ? "#22c55e44" : "#ef444444"}`,
                }}>
                  {tech.macd.crossover === "BULLISH" ? "▲ Bullish Crossover" : "▼ Bearish Crossover"}
                </div>
              </div>
            )}
            {/* ADX */}
            {tech.adx && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>ADX + DMI</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tech.adx.adx > 40 ? T.green : tech.adx.adx > 25 ? T.yellow : T.textSec }}>
                    {fmt(tech.adx.adx, 1)}
                  </span>
                </div>
                <MiniBar value={clamp(tech.adx.adx * 2, 0, 100)} color={tech.adx.adx > 40 ? T.green : tech.adx.adx > 25 ? T.yellow : T.textSec} />
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 3, marginBottom: 6 }}>
                  {tech.adx.adx > 40 ? "Strong trend" : tech.adx.adx > 25 ? "Trending" : "Weak / ranging"}
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <span style={{ fontSize: 12, color: T.green, fontWeight: 600 }}>+DI {fmt(tech.adx.diPlus, 1)}</span>
                  <span style={{ fontSize: 12, color: T.red,   fontWeight: 600 }}>−DI {fmt(tech.adx.diMinus, 1)}</span>
                  <span style={{ fontSize: 11, color: T.textSec }}>
                    {tech.adx.diPlus > tech.adx.diMinus ? "Bulls stronger" : "Bears stronger"}
                  </span>
                </div>
              </div>
            )}
            {/* Supertrend */}
            {tech.supertrend && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>Supertrend</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tech.supertrend.trend === "BULLISH" ? T.green : tech.supertrend.trend === "BEARISH" ? T.red : T.yellow }}>
                    {tech.supertrend.trend}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
                  <div>
                    <div style={{ fontSize: 10, color: T.textDim }}>Level</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.textPri }}>₹{fmt(tech.supertrend.level)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: T.textDim }}>Price vs level</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: tech.ltp > tech.supertrend.level ? T.green : T.red }}>
                      {tech.ltp > tech.supertrend.level ? "Above — bullish" : "Below — bearish"}
                      {" "}({fmt(Math.abs((tech.ltp - tech.supertrend.level) / tech.supertrend.level * 100), 1)}%)
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* ── Volatility ── */}
          <Card title="Volatility">
            {tech.bollingerBands && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {[
                    { label: "Upper", value: tech.bollingerBands.upper, color: T.red },
                    { label: "Mid SMA20", value: tech.bollingerBands.middle, color: T.textSec },
                    { label: "Lower", value: tech.bollingerBands.lower, color: T.green },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ flex: 1, background: "#0d1117", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color, marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T.textPri }}>₹{fmt(value)}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: T.textSec, marginBottom: 3 }}>%B position ({tech.bollingerBands.percentB}%)</div>
                <MiniBar value={tech.bollingerBands.percentB} color={T.blue} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                  <span style={{ fontSize: 9, color: T.textDim }}>0% lower</span>
                  <span style={{ fontSize: 9, color: T.textDim }}>100% upper</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: T.textSec }}>
                  BW {fmt(tech.bollingerBands.bandwidth, 1)}% · {tech.bollingerBands.bandwidth < 3 ? "🔔 Squeeze — breakout imminent" : tech.bollingerBands.bandwidth > 8 ? "Expanding volatility" : "Normal"}
                </div>
              </div>
            )}
            {tech.atr != null && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <Row label="ATR" value={`₹${fmt(tech.atr, 1)}`} color={tech.atr > tech.ltp * 0.03 ? T.red : T.textSec} />
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 3 }}>
                  {tech.atr > tech.ltp * 0.03 ? "High volatility" : "Normal volatility"}
                </div>
              </div>
            )}
          </Card>

          {/* ── Volume ── */}
          <Card title="Volume">
            {/* OBV */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: T.textSec }}>OBV Trend</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: tech.obv?.includes("Strongly") ? T.green : tech.obv?.includes("Rising") ? "#4ade80" : tech.obv?.includes("Falling") ? T.red : T.textSec }}>
                  {tech.obv || "—"}
                </span>
              </div>
              <div style={{ fontSize: 11, color: T.textSec, marginTop: 3 }}>
                {tech.obv?.includes("Rising") ? "Buyers in control" : tech.obv?.includes("Falling") ? "Sellers in control" : "No clear direction"}
              </div>
            </div>
            {/* Volume Ratio */}
            {tech.volRatio != null && (
              <div style={{ marginBottom: 8, paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>Volume Ratio</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tech.volRatio > 1.2 ? T.green : tech.volRatio < 0.8 ? T.red : T.textSec }}>
                    {fmt(tech.volRatio, 2)}x
                  </span>
                </div>
                <MiniBar value={clamp(tech.volRatio * 50, 0, 100)} color={tech.volRatio > 1.2 ? T.green : tech.volRatio < 0.8 ? T.red : T.textSec} />
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 3 }}>
                  {tech.volRatio > 1.2 ? "Above avg volume" : tech.volRatio < 0.8 ? "Below avg volume" : "Average volume"}
                </div>
              </div>
            )}
            {/* VWAP */}
            {tech.vwap != null && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>VWAP</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: tech.vwapDiff > 0 ? T.green : T.red }}>₹{fmt(tech.vwap)}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <MiniBar value={clamp(50 + (tech.vwapDiff || 0) * 5, 0, 100)} color={tech.vwapDiff > 0 ? T.green : T.red} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tech.vwapDiff > 0 ? T.green : T.red }}>
                    {tech.vwapDiff > 0 ? "+" : ""}{fmt(tech.vwapDiff, 2)}%
                  </span>
                </div>
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 4 }}>
                  {tech.vwapDiff > 0 ? "Trading above VWAP — bullish intraday" : "Below VWAP — bearish bias"}
                </div>
              </div>
            )}
          </Card>

          {/* ── Moving Average Summary ── */}
          <Card title="Moving Average Summary">
            {tech.maSummary && (
              <>
                <div style={{
                  textAlign: "center", padding: "10px", borderRadius: 7, marginBottom: 10,
                  background: tech.maSummary.summary?.includes("BUY")  ? "#052e16" :
                              tech.maSummary.summary?.includes("SELL") ? "#3b0a0a" : "#431407",
                  border: `1px solid ${tech.maSummary.summary?.includes("BUY") ? "#22c55e44" : tech.maSummary.summary?.includes("SELL") ? "#ef444444" : "#f59e0b44"}`,
                }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: tech.maSummary.summary?.includes("BUY") ? T.green : tech.maSummary.summary?.includes("SELL") ? T.red : T.yellow }}>
                    {tech.maSummary.summary}
                  </div>
                  <div style={{ fontSize: 11, color: T.textSec, marginTop: 2 }}>
                    {tech.maSummary.buy}B · {tech.maSummary.sell}S · {tech.maSummary.neutral}N
                  </div>
                </div>
                {[
                  ["EMA 5",   tech.emas?.ema5],
                  ["EMA 9",   tech.emas?.ema9],
                  ["EMA 21",  tech.emas?.ema21],
                  ["EMA 50",  tech.emas?.ema50],
                  ["EMA 200", tech.emas?.ema200],
                ].map(([label, val]) => {
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

// ── Gainers/Losers strip ──────────────────────────────────────────────────────
function GainLossCard({ title, stocks, onSelect, accent, onViewAll }) {
  return (
    <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", flex: 1 }}>
      <div style={{
        padding: "9px 14px", borderBottom: `1px solid ${T.borderSub}`,
        background: `linear-gradient(90deg, ${accent}12, transparent)`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontWeight: 800, fontSize: 11, color: accent, letterSpacing: "0.8px" }}>{title}</span>
        <button onClick={onViewAll} style={{
          fontSize: 9, color: accent, background: `${accent}18`,
          border: `1px solid ${accent}44`, borderRadius: 3, padding: "2px 7px",
          cursor: "pointer", fontWeight: 700,
        }}>VIEW ALL ↓</button>
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {stocks.slice(0, 15).map(s => (
          <div key={s.symbol} onClick={() => onSelect(s.symbol)}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 14px", borderBottom: `1px solid ${T.borderSub}`, cursor: "pointer" }}
            onMouseEnter={e => e.currentTarget.style.background = "#0d1520"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 12, color: T.textPri }}>{s.symbol}</div>
              <div style={{ fontSize: 10, color: T.textDim }}>₹{fmt(s.ltp)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ color: accent, fontWeight: 800, fontSize: 13 }}>{s.changePct > 0 ? "+" : ""}{fmt(s.changePct)}%</div>
              <div style={{ fontSize: 10, color: T.textDim }}>Vol: {fmtK(s.volume)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Sector bar ────────────────────────────────────────────────────────────────
function SectorBar({ sector }) {
  const bull  = sector.avgChange >= 0;
  const width = Math.min(Math.abs(sector.avgChange) * 15, 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px solid ${T.borderSub}` }}>
      <div style={{ width: 140, fontSize: 11, color: T.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {sector.sector}
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 80, height: 4, background: "#1a2030", borderRadius: 2 }}>
          <div style={{ width: `${width}%`, height: "100%", borderRadius: 2, background: bull ? T.green : T.red }} />
        </div>
        <span style={{ color: clr(sector.avgChange), fontWeight: 700, fontSize: 12, width: 52, textAlign: "right" }}>
          {sector.avgChange > 0 ? "+" : ""}{fmt(sector.avgChange)}%
        </span>
      </div>
      <span style={{ fontSize: 10, color: T.textDim, width: 54, textAlign: "right" }}>
        {sector.advancing}↑ {sector.declining}↓
      </span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MarketScannerPage() {
  const [data,        setData]        = useState(null);
  const [selectedSym, setSelectedSym] = useState(null);
  const [tech,        setTech]        = useState(null);
  const [techLoading, setTechLoading] = useState(false);
  const [activeTF,    setActiveTF]    = useState("1day");
  const [tab,         setTab]         = useState("gainers");
  const [sortBy,      setSortBy]      = useState("gainers");
  const [searchQ,     setSearchQ]     = useState("");
  const [updatedAt,   setUpdatedAt]   = useState(null);

  const techCacheRef   = useRef({});
  const selectedSymRef = useRef(null);
  const activeTFRef    = useRef("1day");
  const tableRef       = useRef(null);

  useEffect(() => { activeTFRef.current = activeTF; }, [activeTF]);

  const getStocksForTab = useCallback((d, t) => {
    if (!d) return [];
    if (t === "gainers")  return d.gainers          || [];
    if (t === "losers")   return d.losers           || [];
    if (t === "largecap") return d.byMcap?.largecap || [];
    if (t === "midcap")   return d.byMcap?.midcap   || [];
    if (t === "smallcap") return d.byMcap?.smallcap || [];
    if (t === "microcap") return d.byMcap?.microcap || [];
    return [];
  }, []);

  useEffect(() => {
    const socket = getSocket();
    socket.on("scanner-update", d => { setData(d); setUpdatedAt(new Date(d.updatedAt)); });
    return () => { socket.off("scanner-update"); };
  }, []);

  // ── Fetch technicals ────────────────────────────────────────────────────────
  const handleSelect = useCallback(async (symbol, timeframe) => {
    const tf = timeframe || activeTFRef.current || "1day";
    const key = `${symbol}:${tf}`;
    selectedSymRef.current = symbol;
    setSelectedSym(symbol);

    if (techCacheRef.current[key]) {
      setTech(techCacheRef.current[key]);
      setTechLoading(false);
      return;
    }

    setTech(null);
    setTechLoading(true);
    try {
      const res  = await fetch(`/api/scanner/technicals/${symbol}?timeframe=${tf}`);
      const json = await res.json();
      if (json && !json.error) {
        techCacheRef.current[key] = json;
        if (selectedSymRef.current === symbol) {
          setTech(json);
          setTechLoading(false);
        }
      } else {
        console.warn("Technicals error:", json.error);
        if (selectedSymRef.current === symbol) setTechLoading(false);
      }
    } catch (e) {
      console.error("Technicals fetch failed:", e);
      if (selectedSymRef.current === symbol) setTechLoading(false);
    }
  }, []);

  const handleTimeframeChange = useCallback((tf) => {
    setActiveTF(tf);
    activeTFRef.current = tf;
    if (selectedSymRef.current) handleSelect(selectedSymRef.current, tf);
  }, [handleSelect]);

  const handleViewAll = useCallback((tabId) => {
    setTab(tabId);
    setSortBy(tabId === "losers" ? "losers" : "gainers");
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }, []);

  const stocks = getStocksForTab(data, tab);
  const filtered = searchQ
    ? stocks.filter(s => s.symbol.includes(searchQ.toUpperCase()) || (s.name || "").toLowerCase().includes(searchQ.toLowerCase()))
    : stocks;
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "gainers") return b.changePct - a.changePct;
    if (sortBy === "losers")  return a.changePct - b.changePct;
    if (sortBy === "volume")  return b.volume - a.volume;
    if (sortBy === "value")   return b.totalValue - a.totalValue;
    return 0;
  });

  const TABS = [
    { id: "gainers",  label: "Top Gainers",  accent: T.green  },
    { id: "losers",   label: "Top Losers",   accent: T.red    },
    { id: "largecap", label: "Large Cap",    accent: T.indigo },
    { id: "midcap",   label: "Mid Cap",      accent: T.green  },
    { id: "smallcap", label: "Small Cap",    accent: T.purple },
    { id: "microcap", label: "Micro Cap",    accent: T.textSec},
    { id: "sector",   label: "Sectors",      accent: T.yellow },
  ];

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.textPri, fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" }}>
      {/* Header */}
      <div style={{ background: "#080d14", borderBottom: `1px solid ${T.border}`, padding: "12px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 900, color: T.textPri, letterSpacing: "0.8px" }}>📊 MARKET SCANNER</div>
          <div style={{ fontSize: 10, color: T.textDim }}>NSE 500 · Live data + Upstox historical</div>
        </div>
        {data?.market && (
          <div style={{ display: "flex", gap: 6 }}>
            <span style={{ background: "#052e16", border: `1px solid #22c55e44`, borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.green, fontWeight: 700 }}>▲ {data.market.advancing}</span>
            <span style={{ background: "#3b0a0a", border: `1px solid #ef444444`, borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.red,   fontWeight: 700 }}>▼ {data.market.declining}</span>
            <span style={{ background: "#1a2030", border: `1px solid #3d506844`, borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.textSec }}>— {data.market.unchanged}</span>
          </div>
        )}
        <div style={{ marginLeft: "auto", fontSize: 10, color: T.textDim }}>
          {updatedAt ? `Updated ${updatedAt.toLocaleTimeString("en-IN")}` : "Connecting…"}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "16px 20px 40px", paddingRight: selectedSym ? "390px" : "20px", transition: "padding-right 0.2s" }}>

        {/* Gainers + Losers strip */}
        {data && (
          <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
            <GainLossCard title="TOP GAINERS" stocks={data.gainers || []} onSelect={sym => handleSelect(sym)} accent={T.green} onViewAll={() => handleViewAll("gainers")} />
            <GainLossCard title="TOP LOSERS"  stocks={data.losers  || []} onSelect={sym => handleSelect(sym)} accent={T.red}   onViewAll={() => handleViewAll("losers")} />
          </div>
        )}

        {/* Tabs */}
        <div ref={tableRef} style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "5px 13px", borderRadius: 5, fontSize: 11, fontWeight: 700,
              cursor: "pointer", border: "1px solid",
              borderColor: tab === t.id ? t.accent : T.border,
              background:  tab === t.id ? `${t.accent}18` : T.bgPanel,
              color:       tab === t.id ? t.accent : T.textDim,
              transition: "all 0.15s",
            }}>{t.label}</button>
          ))}
        </div>

        {/* Sector view */}
        {tab === "sector" ? (
          <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: T.textDim, fontWeight: 700, letterSpacing: "1px", marginBottom: 10 }}>SECTOR PERFORMANCE — NSE 500</div>
            {(data?.bySector || []).map(s => <SectorBar key={s.sector} sector={s} />)}
          </div>
        ) : (
          <>
            {/* Search + sort */}
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="Search symbol or name…"
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 6, color: T.textPri, padding: "6px 12px", fontSize: 12, width: 220, outline: "none", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: 4 }}>
                {[{ id: "gainers", label: "% ↑" }, { id: "losers", label: "% ↓" }, { id: "volume", label: "Vol" }, { id: "value", label: "Value" }].map(s => (
                  <button key={s.id} onClick={() => setSortBy(s.id)} style={{
                    padding: "5px 10px", fontSize: 10, borderRadius: 4, cursor: "pointer", border: "1px solid", fontWeight: 700,
                    borderColor: sortBy === s.id ? T.indigo : T.border,
                    background:  sortBy === s.id ? `${T.indigo}22` : T.bgPanel,
                    color:       sortBy === s.id ? T.indigo : T.textDim,
                  }}>{s.label}</button>
                ))}
              </div>
              <span style={{ marginLeft: "auto", fontSize: 11, color: T.textDim }}>{sorted.length} stocks</span>
            </div>

            {/* Table */}
            {!data ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: T.textDim }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>📡</div>
                <div style={{ fontSize: 14, color: T.textSec }}>Fetching NSE 500 live data…</div>
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
                        <th key={h} style={{
                          padding: "8px 8px", fontSize: 10, color: T.textDim, fontWeight: 700,
                          textAlign: ["LTP","Change","Volume"].includes(h) ? "right" : "left",
                          letterSpacing: "0.5px",
                          position: "sticky", top: 0, background: "#080d14", zIndex: 1,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.slice(0, 100).map((s, i) => (
                      <StockRow
                        key={s.symbol} stock={s} rank={i + 1}
                        onSelect={sym => handleSelect(sym)}
                        selected={selectedSym === s.symbol}
                        tech={techCacheRef.current[`${s.symbol}:${activeTF}`] || null}
                      />
                    ))}
                  </tbody>
                </table>
                {sorted.length > 100 && (
                  <div style={{ textAlign: "center", padding: "10px", fontSize: 11, color: T.textDim, borderTop: `1px solid ${T.borderSub}` }}>
                    Showing 100 of {sorted.length} — use search to filter
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Tech Panel */}
      {selectedSym && (
        <TechPanel
          symbol={selectedSym}
          tech={tech}
          loading={techLoading}
          timeframe={activeTF}
          onTimeframeChange={handleTimeframeChange}
          onClose={() => {
            selectedSymRef.current = null;
            setSelectedSym(null);
            setTech(null);
            setActiveTF("1day");
            activeTFRef.current = "1day";
          }}
        />
      )}
    </div>
  );
}
