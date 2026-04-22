import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

// ── Socket singleton ──────────────────────────────────────────────────────────
let _socket = null;
function getSocket() {
  if (!_socket) _socket = io({ transports: ["websocket"] });
  return _socket;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

// ── ACCESS CONTROL ─────────────────────────────────────────────────────────────
// Change these to your preferred credentials
const ACCESS_PIN = "MARKET2024";
const SESSION_KEY = "mscanner_auth";

function AccessGate({ onAuth }) {
  const [pin, setPin] = useState("");
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
    <div style={{
      minHeight: "100vh", background: "#060a10", display: "flex",
      alignItems: "center", justifyContent: "center", fontFamily: "'JetBrains Mono','Fira Code',monospace",
    }}>
      <div style={{
        background: "#0a0f16", border: "1px solid #1e2a3a", borderRadius: 12,
        padding: "40px 48px", textAlign: "center", maxWidth: 380, width: "100%",
        animation: shake ? "shake 0.5s" : "none",
      }}>
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
          style={{
            width: "100%", background: "#111620", border: "1px solid #1e2a3a",
            borderRadius: 8, padding: "12px 16px", color: "#e2eaf4", fontSize: 14,
            fontFamily: "inherit", outline: "none", marginBottom: 12, letterSpacing: 3,
            textAlign: "center",
          }}
        />
        {error && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 12 }}>{error}</div>}
        <button
          type="button"
          onClick={handleSubmit}
          style={{
            width: "100%", background: "#3b82f6", border: "none", borderRadius: 8,
            padding: "12px", color: "#fff", fontSize: 14, fontWeight: 700,
            cursor: "pointer", fontFamily: "inherit",
          }}
        >
          Access Scanner →
        </button>
        <div style={{ fontSize: 10, color: "#3d5068", marginTop: 20 }}>
          Unauthorized access is prohibited
        </div>
      </div>
    </div>
  );
}

// ── Theme tokens ──────────────────────────────────────────────────────────────
const T = {
  bg:        "#060a10",
  bgPanel:   "#0a0f16",
  bgCard:    "#0d1117",
  bgItem:    "#111620",
  border:    "#1e2a3a",
  borderSub: "#192130",
  // FIX: much brighter text for visibility
  textPri:   "#f0f6ff",   // was #e2eaf4 — now near-white
  textSec:   "#94a3b8",   // was #7a8fa6 — brighter
  textDim:   "#4a6080",   // was #3d5068 — brighter
  // FIX: brighter status colors
  green:     "#4ade80",   // was #22c55e
  red:       "#f87171",   // was #ef4444
  yellow:    "#fbbf24",   // was #f59e0b
  blue:      "#60a5fa",   // was #3b82f6
  purple:    "#c4b5fd",   // was #a78bfa
  indigo:    "#a5b4fc",   // was #818cf8
  orange:    "#fb923c",   // was #f97316
  // Price specifically — make it pop
  price:     "#ffffff",
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
    <span style={{
      background: s.bg, color: s.color, border: `1px solid ${s.color}55`,
      fontSize: 9, fontWeight: 700, padding: "2px 7px",
      borderRadius: 3, letterSpacing: "0.5px", whiteSpace: "nowrap",
    }}>{signal || "N/A"}</span>
  );
}

function ExBadge({ exchange }) {
  const isBSE = exchange === "BSE";
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 2,
      background: isBSE ? "#1a1a40" : "#0a2010",
      color: isBSE ? "#a5b4fc" : "#86efac",
      border: `1px solid ${isBSE ? "#a5b4fc44" : "#86efac44"}`,
      marginLeft: 3,
    }}>{exchange || "NSE"}</span>
  );
}

function McapBadge({ bucket, label }) {
  const styles = {
    largecap:  { bg: "#1e2060", color: T.indigo  },
    midcap:    { bg: "#0e3020", color: T.green    },
    smallcap:  { bg: "#2a1060", color: T.purple   },
    microcap:  { bg: "#1a1a2a", color: T.textSec  },
  };
  const s = styles[bucket] || styles.microcap;
  return (
    <span style={{
      fontSize: 10, padding: "2px 6px", borderRadius: 3, fontWeight: 600,
      background: s.bg, color: s.color,
    }}>{label || "—"}</span>
  );
}

// ── Stock row — FIX: improved contrast ───────────────────────────────────────
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
        {/* FIX: Symbol now white/bright, name also brighter */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontWeight: 800, fontSize: 13, color: "#ffffff" }}>{stock.symbol}</span>
          <ExBadge exchange={stock.exchange} />
        </div>
        <div style={{ fontSize: 10, color: "#6b8aad", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {stock.name}
        </div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right" }}>
        {/* FIX: price is pure white, larger */}
        <div style={{ fontWeight: 800, fontSize: 14, color: "#ffffff" }}>₹{fmt(stock.ltp)}</div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right" }}>
        <div style={{ color: clr(pct), fontWeight: 700, fontSize: 12 }}>
          {arrow(pct)} {fmt(Math.abs(pct))}%
        </div>
        <div style={{ color: clr(stock.change), fontSize: 10 }}>
          {stock.change > 0 ? "+" : ""}{fmt(stock.change)}
        </div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right", color: "#94a3b8", fontSize: 11 }}>
        {fmtK(stock.volume)}
      </td>
      <td style={{ padding: "7px 8px" }}>
        <McapBadge bucket={stock.mcapBucket} label={stock.mcapLabel} />
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
            <span style={{ color: tech.rsi > 70 ? T.red : tech.rsi < 30 ? T.green : T.yellow, fontSize: 12, fontWeight: 700 }}>
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
            tech.bollingerBands.position === "ABOVE_UPPER" ? T.red   :
            tech.bollingerBands.position === "BELOW_LOWER" ? T.green :
            tech.bollingerBands.position === "NEAR_UPPER"  ? T.orange :
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
        {tech?.maSummary
          ? <SigBadge signal={tech.maSummary.summary} />
          : <span style={{ color: T.textDim, fontSize: 11 }}>—</span>}
      </td>
    </tr>
  );
}

// ── Technical Detail Panel (unchanged logic, updated colors) ─────────────────
function TechPanel({ symbol, tech, loading, timeframe, onTimeframeChange, onClose }) {
  if (!symbol) return null;

  const scoreColor = tech
    ? tech.techScore >= 60 ? T.green : tech.techScore <= 40 ? T.red : T.yellow
    : T.textSec;

  const sigBg = tech
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.textPri, letterSpacing: "0.5px" }}>{symbol}</div>
          <div style={{ fontSize: 11, color: T.textSec }}>Technical Analysis · Multi-timeframe</div>
        </div>
        <button type="button" onClick={e => { e.preventDefault(); onClose(); }} style={{
          background: T.bgItem, border: `1px solid ${T.border}`, color: T.textSec,
          width: 28, height: 28, borderRadius: 5, cursor: "pointer", fontSize: 14,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>✕</button>
      </div>

      <div style={{
        display: "flex", gap: 2, marginBottom: 14,
        background: "#080d14", padding: 3, borderRadius: 7, border: `1px solid ${T.border}`,
      }}>
        {TIMEFRAMES.map(tf => (
          <button type="button" key={tf.id} onClick={e => { e.preventDefault(); onTimeframeChange(tf.id); }} style={{
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
        </div>
      )}

      {!loading && !tech && (
        <div style={{ textAlign: "center", padding: "50px 0", color: T.textSec }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>📭</div>
          <div style={{ fontSize: 13 }}>No data for {timeframe}</div>
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>Check Upstox token</div>
        </div>
      )}

      {!loading && tech && (
        <>
          <div style={{
            background: sigBg,
            border: `1px solid ${tech.signal?.includes("BUY") ? "#4ade8044" : tech.signal?.includes("SELL") ? "#f8717144" : "#fbbf2444"}`,
            borderRadius: 10, padding: "14px 16px", marginBottom: 10,
          }}>
            <div style={{ fontSize: 10, color: T.textSec, fontWeight: 700, letterSpacing: "0.8px", marginBottom: 10 }}>
              LIVE SIGNAL · {timeframe.toUpperCase()}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <svg viewBox="0 0 56 56" width="56" height="56" style={{ flexShrink: 0 }}>
                <circle cx="28" cy="28" r="22" fill="none" stroke="#1a2030" strokeWidth="4"/>
                <circle cx="28" cy="28" r="22" fill="none" stroke={scoreColor} strokeWidth="4"
                  strokeDasharray={`${Math.round(2 * Math.PI * 22 * tech.techScore / 100)} ${Math.round(2 * Math.PI * 22)}`}
                  strokeDashoffset={Math.round(2 * Math.PI * 22 * 0.25)}
                  strokeLinecap="round"/>
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
              </div>
            )}
          </Card>

          <Card title="Trend">
            {tech.macd && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: T.textSec, marginBottom: 6 }}>MACD (12, 26, 9)</div>
                <Row label="MACD Line" value={fmt(tech.macd.macd)}      color={tech.macd.macd > 0 ? T.green : T.red} />
                <Row label="Signal"    value={fmt(tech.macd.signal)} />
                <Row label="Histogram" value={fmt(tech.macd.histogram)} color={tech.macd.histogram > 0 ? T.green : T.red} />
                <div style={{
                  marginTop: 8, padding: "5px 10px", borderRadius: 5, textAlign: "center",
                  background: tech.macd.crossover === "BULLISH" ? "#052e16" : "#3b0a0a",
                  color: tech.macd.crossover === "BULLISH" ? T.green : T.red,
                  fontSize: 12, fontWeight: 700,
                  border: `1px solid ${tech.macd.crossover === "BULLISH" ? "#4ade8044" : "#f8717144"}`,
                }}>
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
                <div style={{ fontSize: 11, color: tech.ltp > tech.supertrend.level ? T.green : T.red, marginTop: 5 }}>
                  Level ₹{fmt(tech.supertrend.level)} · {tech.ltp > tech.supertrend.level ? "Above — bullish" : "Below — bearish"}
                </div>
              </div>
            )}
          </Card>

          <Card title="Volatility">
            {tech.bollingerBands && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {[
                    { label: "Upper",     value: tech.bollingerBands.upper,  color: T.red     },
                    { label: "Mid SMA20", value: tech.bollingerBands.middle, color: T.textSec },
                    { label: "Lower",     value: tech.bollingerBands.lower,  color: T.green   },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ flex: 1, background: "#0d1117", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color, marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T.textPri }}>₹{fmt(value)}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: T.textSec, marginBottom: 3 }}>%B position ({tech.bollingerBands.percentB}%)</div>
                <MiniBar value={tech.bollingerBands.percentB} color={T.blue} />
                <div style={{ marginTop: 6, fontSize: 11, color: T.textSec }}>
                  BW {fmt(tech.bollingerBands.bandwidth, 1)}% · {tech.bollingerBands.bandwidth < 3 ? "🔔 Squeeze" : tech.bollingerBands.bandwidth > 8 ? "Expanding" : "Normal"}
                </div>
              </div>
            )}
            {tech.atr != null && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <Row label="ATR" value={`₹${fmt(tech.atr, 1)}`} color={tech.atr > tech.ltp * 0.03 ? T.red : T.textSec} />
              </div>
            )}
          </Card>

          <Card title="Volume">
            {tech.obv && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>OBV Trend</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: tech.obv?.includes("Rising") ? T.green : tech.obv?.includes("Falling") ? T.red : T.textSec }}>{tech.obv}</span>
                </div>
              </div>
            )}
            {tech.vwap != null && (
              <div style={{ paddingTop: 8, borderTop: `1px solid ${T.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: T.textSec }}>VWAP</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: tech.vwapDiff > 0 ? T.green : T.red }}>₹{fmt(tech.vwap)}</span>
                </div>
                <div style={{ fontSize: 11, color: T.textSec }}>
                  {tech.vwapDiff > 0 ? "+" : ""}{fmt(tech.vwapDiff, 2)}% · {tech.vwapDiff > 0 ? "Above VWAP bullish" : "Below VWAP bearish"}
                </div>
              </div>
            )}
          </Card>

          <Card title="Moving Average Summary">
            {tech.maSummary && (
              <>
                <div style={{
                  textAlign: "center", padding: "10px", borderRadius: 7, marginBottom: 10,
                  background: tech.maSummary.summary?.includes("BUY")  ? "#052e16" :
                              tech.maSummary.summary?.includes("SELL") ? "#3b0a0a" : "#431407",
                }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color:
                    tech.maSummary.summary?.includes("BUY")  ? T.green :
                    tech.maSummary.summary?.includes("SELL") ? T.red   : T.yellow }}>
                    {tech.maSummary.summary}
                  </div>
                  <div style={{ fontSize: 11, color: T.textSec }}>
                    {tech.maSummary.buy}B · {tech.maSummary.sell}S · {tech.maSummary.neutral}N
                  </div>
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
        <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); onViewAll(); }} style={{
          fontSize: 9, color: accent, background: `${accent}18`,
          border: `1px solid ${accent}44`, borderRadius: 3, padding: "2px 7px",
          cursor: "pointer", fontWeight: 700,
        }}>VIEW ALL ↓</button>
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {(stocks || []).slice(0, 15).map(s => (
          <div key={s.symbol} onClick={() => onSelect(s.symbol)}
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 14px", borderBottom: `1px solid ${T.borderSub}`, cursor: "pointer" }}
            onMouseEnter={e => e.currentTarget.style.background = "#0d1520"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ fontWeight: 800, fontSize: 13, color: "#ffffff" }}>{s.symbol}</span>
                <ExBadge exchange={s.exchange} />
              </div>
              <div style={{ fontSize: 10, color: "#6b8aad" }}>₹{fmt(s.ltp)}</div>
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
      <div style={{ width: 140, fontSize: 11, color: T.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sector.sector}</div>
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

// ── Market breadth bar ────────────────────────────────────────────────────────
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
      <span style={{ fontSize: 10, color: T.textDim, whiteSpace: "nowrap" }}>
        {advPct}% adv · {decPct}% dec
      </span>
    </div>
  );
}

// ── ACCURACY TRACKER PANEL ────────────────────────────────────────────────────
const SIGNALS_KEY = "mscanner_signals";

function loadSavedSignals() {
  try { return JSON.parse(localStorage.getItem(SIGNALS_KEY) || "[]"); } catch { return []; }
}
function saveSavedSignals(arr) {
  try { localStorage.setItem(SIGNALS_KEY, JSON.stringify(arr)); } catch {}
}

function AccuracyPanel({ onClose, techCacheRef }) {
  const [signals, setSignals] = useState(loadSavedSignals);
  const [tab, setTab] = useState("tracker");

  // Add current snapshot of all cached 1day signals
  const captureSnapshot = () => {
    const now = Date.now();
    const newEntries = [];
    for (const [key, data] of Object.entries(techCacheRef.current)) {
      if (!key.endsWith(":1day")) continue;
      const sym = key.replace(":1day", "");
      // Don't duplicate if already captured within last 30 min
      const alreadyHave = signals.find(s => s.symbol === sym && now - s.capturedAt < 30 * 60 * 1000);
      if (alreadyHave) continue;
      newEntries.push({
        id: `${sym}_${now}`,
        symbol: sym,
        signal: data.signal,
        techScore: data.techScore,
        ltp: data.ltp,
        entry: data.entry,
        sl: data.sl,
        tp: data.tp,
        rsi: data.rsi,
        macdCross: data.macd?.crossover,
        capturedAt: now,
        capturedDate: new Date(now).toLocaleDateString("en-IN"),
        capturedTime: new Date(now).toLocaleTimeString("en-IN"),
        // User fills in later:
        outcome: null,  // "WIN" | "LOSS" | "PENDING" | "SKIP"
        exitPrice: null,
        exitDate: null,
        notes: "",
      });
    }
    const updated = [...signals, ...newEntries];
    setSignals(updated);
    saveSavedSignals(updated);
    alert(`✅ Captured ${newEntries.length} new signals (${updated.length} total)`);
  };

  const updateOutcome = (id, outcome) => {
    const updated = signals.map(s => s.id === id ? { ...s, outcome } : s);
    setSignals(updated);
    saveSavedSignals(updated);
  };

  const updateExitPrice = (id, exitPrice) => {
    const updated = signals.map(s => s.id === id ? { ...s, exitPrice: parseFloat(exitPrice) || null } : s);
    setSignals(updated);
    saveSavedSignals(updated);
  };

  const deleteSignal = (id) => {
    const updated = signals.filter(s => s.id !== id);
    setSignals(updated);
    saveSavedSignals(updated);
  };

  const downloadCSV = () => {
    const headers = ["Symbol","Signal","Score","LTP at Capture","Entry","SL","Target","RSI","MACD Cross","Captured Date","Captured Time","Outcome","Exit Price","P&L %","Notes"];
    const rows = signals.map(s => {
      const pl = s.exitPrice && s.entry
        ? ((s.exitPrice - s.entry) / s.entry * 100).toFixed(2)
        : "";
      return [
        s.symbol, s.signal, s.techScore, s.ltp, s.entry, s.sl, s.tp,
        s.rsi?.toFixed(1) || "", s.macdCross || "",
        s.capturedDate, s.capturedTime,
        s.outcome || "PENDING", s.exitPrice || "", pl, `"${s.notes || ""}"`
      ].join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `market_signals_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Calculate accuracy stats
  const resolved = signals.filter(s => s.outcome === "WIN" || s.outcome === "LOSS");
  const wins = resolved.filter(s => s.outcome === "WIN").length;
  const accuracy = resolved.length > 0 ? ((wins / resolved.length) * 100).toFixed(1) : "—";
  const pending = signals.filter(s => !s.outcome || s.outcome === "PENDING").length;
  const buySigs = resolved.filter(s => s.signal?.includes("BUY"));
  const buyAcc = buySigs.length > 0 ? ((buySigs.filter(s => s.outcome === "WIN").length / buySigs.length) * 100).toFixed(1) : "—";
  const sellSigs = resolved.filter(s => s.signal?.includes("SELL"));
  const sellAcc = sellSigs.length > 0 ? ((sellSigs.filter(s => s.outcome === "WIN").length / sellSigs.length) * 100).toFixed(1) : "—";

  return (
    <div style={{
      position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh",
      background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 12,
        width: "min(900px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column",
        overflow: "hidden", fontFamily: "'JetBrains Mono','Fira Code',monospace",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${T.border}`, background: "#080d14", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.textPri }}>📊 Signal Accuracy Tracker</div>
            <div style={{ fontSize: 11, color: T.textSec }}>Capture signals, track outcomes, measure accuracy</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" onClick={captureSnapshot} style={{
              background: "#14532d", border: "1px solid #4ade8044", color: T.green,
              padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
            }}>📸 Capture Signals</button>
            <button type="button" onClick={downloadCSV} style={{
              background: "#1e2a3a", border: `1px solid ${T.border}`, color: T.textSec,
              padding: "7px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
            }}>⬇ Download CSV</button>
            <button type="button" onClick={onClose} style={{
              background: T.bgItem, border: `1px solid ${T.border}`, color: T.textSec,
              width: 30, height: 30, borderRadius: 5, cursor: "pointer", fontSize: 16,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>✕</button>
          </div>
        </div>

        {/* Stats bar */}
        <div style={{ display: "flex", gap: 12, padding: "12px 18px", borderBottom: `1px solid ${T.border}`, background: "#080d14", flexShrink: 0 }}>
          {[
            { label: "Total Signals", value: signals.length, color: T.blue },
            { label: "Resolved", value: resolved.length, color: T.textSec },
            { label: "Wins", value: wins, color: T.green },
            { label: "Losses", value: resolved.length - wins, color: T.red },
            { label: "Pending", value: pending, color: T.yellow },
            { label: "Accuracy", value: accuracy + (accuracy !== "—" ? "%" : ""), color: parseFloat(accuracy) >= 55 ? T.green : T.red },
            { label: "Buy Acc", value: buyAcc + (buyAcc !== "—" ? "%" : ""), color: T.blue },
            { label: "Sell Acc", value: sellAcc + (sellAcc !== "—" ? "%" : ""), color: T.orange },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: T.bgItem, border: `1px solid ${T.borderSub}`, borderRadius: 8, padding: "8px 12px", minWidth: 80, textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color }}>{value}</div>
              <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: "0 0 8px 0" }}>
          {signals.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: T.textDim }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
              <div style={{ fontSize: 14, color: T.textSec, marginBottom: 8 }}>No signals captured yet</div>
              <div style={{ fontSize: 12 }}>Click "Capture Signals" to snapshot current RSI/MACD/Signal data for all loaded stocks</div>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ background: "#060a10", position: "sticky", top: 0 }}>
                  {["Symbol","Signal","Score","LTP","Entry","SL","Target","RSI","MACD","Date","Outcome","Exit ₹","P&L",""].map(h => (
                    <th key={h} style={{ padding: "8px 10px", color: T.textDim, fontSize: 9, fontWeight: 700, textAlign: "left", borderBottom: `1px solid ${T.border}`, letterSpacing: "0.5px" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...signals].reverse().map(s => {
                  const pl = s.exitPrice && s.entry ? ((s.exitPrice - s.entry) / s.entry * 100) : null;
                  return (
                    <tr key={s.id} style={{ borderBottom: `1px solid ${T.borderSub}` }}
                      onMouseEnter={e => e.currentTarget.style.background = "#0d1520"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    >
                      <td style={{ padding: "6px 10px", color: "#ffffff", fontWeight: 700 }}>{s.symbol}</td>
                      <td style={{ padding: "6px 10px" }}><SigBadge signal={s.signal} /></td>
                      <td style={{ padding: "6px 10px", color: s.techScore >= 60 ? T.green : s.techScore <= 40 ? T.red : T.yellow, fontWeight: 700 }}>{s.techScore}</td>
                      <td style={{ padding: "6px 10px", color: "#ffffff" }}>₹{fmt(s.ltp)}</td>
                      <td style={{ padding: "6px 10px", color: T.blue }}>₹{fmt(s.entry)}</td>
                      <td style={{ padding: "6px 10px", color: T.red }}>₹{fmt(s.sl)}</td>
                      <td style={{ padding: "6px 10px", color: T.green }}>₹{fmt(s.tp)}</td>
                      <td style={{ padding: "6px 10px", color: s.rsi > 70 ? T.red : s.rsi < 30 ? T.green : T.yellow }}>{s.rsi?.toFixed(1)}</td>
                      <td style={{ padding: "6px 10px", color: s.macdCross === "BULLISH" ? T.green : T.red, fontSize: 10 }}>{s.macdCross === "BULLISH" ? "▲" : "▼"} {s.macdCross || "—"}</td>
                      <td style={{ padding: "6px 10px", color: T.textDim, fontSize: 10 }}>{s.capturedDate}</td>
                      <td style={{ padding: "6px 10px" }}>
                        <select value={s.outcome || ""} onChange={e => updateOutcome(s.id, e.target.value || null)}
                          style={{ background: "#111620", border: `1px solid ${T.border}`, color: T.textPri, fontSize: 10, borderRadius: 4, padding: "2px 4px" }}>
                          <option value="">Pending</option>
                          <option value="WIN">✅ WIN</option>
                          <option value="LOSS">❌ LOSS</option>
                          <option value="SKIP">⏭ SKIP</option>
                        </select>
                      </td>
                      <td style={{ padding: "6px 10px" }}>
                        <input type="number" placeholder="0.00" value={s.exitPrice || ""}
                          onChange={e => updateExitPrice(s.id, e.target.value)}
                          style={{ width: 70, background: "#111620", border: `1px solid ${T.border}`, color: "#ffffff", fontSize: 10, borderRadius: 4, padding: "2px 6px" }}
                        />
                      </td>
                      <td style={{ padding: "6px 10px", fontWeight: 700, color: pl === null ? T.textDim : pl >= 0 ? T.green : T.red }}>
                        {pl === null ? "—" : `${pl >= 0 ? "+" : ""}${pl.toFixed(2)}%`}
                      </td>
                      <td style={{ padding: "6px 10px" }}>
                        <button type="button" onClick={() => deleteSignal(s.id)} style={{
                          background: "none", border: "none", color: T.textDim, cursor: "pointer", fontSize: 12,
                        }}>🗑</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ padding: "8px 18px", borderTop: `1px solid ${T.border}`, fontSize: 10, color: T.textDim, background: "#080d14", flexShrink: 0 }}>
          💡 Capture signals when market opens → set outcome after stock moves → Download CSV for detailed analysis
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MarketScannerPage() {
  // ── Auth gate ─────────────────────────────────────────────────────────────
  const [authed, setAuthed] = useState(() => sessionStorage.getItem(SESSION_KEY) === "1");

  if (!authed) return <AccessGate onAuth={() => setAuthed(true)} />;

  return <ScannerBody />;
}

function ScannerBody() {
  const [data,        setData]        = useState(null);
  const [selectedSym, setSelectedSym] = useState(null);
  const [tech,        setTech]        = useState(null);
  const [techLoading, setTechLoading] = useState(false);
  const [activeTF,    setActiveTF]    = useState("1day");
  const [tab,         setTab]         = useState("gainers");
  const [sortBy,      setSortBy]      = useState("gainers");
  const [searchQ,     setSearchQ]     = useState("");
  const [updatedAt,   setUpdatedAt]   = useState(null);
  const [showAccuracy, setShowAccuracy] = useState(false);
  // FIX: removed 150 limit — show all, but virtualize with a "show more" if needed
  const [displayLimit, setDisplayLimit] = useState(500);

  const [techVersion, setTechVersion] = useState(0);

  const techCacheRef   = useRef({});
  const selectedSymRef = useRef(null);
  const activeTFRef    = useRef("1day");
  const tableRef       = useRef(null);

  useEffect(() => { activeTFRef.current = activeTF; }, [activeTF]);

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

  useEffect(() => {
    const socket = getSocket();

    socket.on("scanner-update", d => {
      setData(d);
      setUpdatedAt(new Date(d.updatedAt));
      setTechVersion(v => v + 1);
    });

    socket.on("scanner-tech-batch", (batch) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      let changed = false;
      for (const { key, data: techData } of batch) {
        if (key && techData) {
          const existing = techCacheRef.current[key];
          if (!existing || techData.computedAt > existing.computedAt) {
            techCacheRef.current[key] = techData;
            changed = true;
            if (selectedSymRef.current) {
              const panelKey = `${selectedSymRef.current}:${activeTFRef.current}`;
              if (key === panelKey) setTech(techData);
            }
          }
        }
      }
      if (changed) setTechVersion(v => v + 1);
    });

    return () => {
      socket.off("scanner-update");
      socket.off("scanner-tech-batch");
    };
  }, []);

  const handleSelect = useCallback(async (symbol, timeframe) => {
    const tf  = timeframe || activeTFRef.current || "1day";
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
        setTechVersion(v => v + 1);
        if (selectedSymRef.current === symbol) {
          setTech(json);
          setTechLoading(false);
        }
      } else {
        if (selectedSymRef.current === symbol) setTechLoading(false);
      }
    } catch {
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

  const stocks   = getStocksForTab(data, tab);
  const filtered = searchQ
    ? stocks.filter(s => s.symbol.includes(searchQ.toUpperCase()) || (s.name || "").toLowerCase().includes(searchQ.toLowerCase()))
    : stocks;
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "gainers") return b.changePct  - a.changePct;
    if (sortBy === "losers")  return a.changePct  - b.changePct;
    if (sortBy === "volume")  return b.volume     - a.volume;
    if (sortBy === "value")   return b.totalValue - a.totalValue;
    return 0;
  });

  const TABS = [
    { id: "gainers",  label: "Top Gainers",  accent: T.green  },
    { id: "losers",   label: "Top Losers",   accent: T.red    },
    { id: "all",      label: "All Stocks",   accent: T.blue   },
    { id: "largecap", label: "Large Cap",    accent: T.indigo },
    { id: "midcap",   label: "Mid Cap",      accent: T.green  },
    { id: "smallcap", label: "Small Cap",    accent: T.purple },
    { id: "microcap", label: "Micro Cap",    accent: T.textSec},
    { id: "sector",   label: "Sectors",      accent: T.yellow },
  ];

  const market = data?.market || {};

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.textPri, fontFamily: "'JetBrains Mono','Fira Code','Courier New',monospace" }}>
      {/* ── Header ── */}
      <div style={{ background: "#080d14", borderBottom: `1px solid ${T.border}`, padding: "12px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 900, color: T.textPri, letterSpacing: "0.8px" }}>📊 MARKET SCANNER</div>
          <div style={{ fontSize: 10, color: T.textDim }}>NSE 500 + BSE · Live data + Upstox historical</div>
        </div>

        {data?.market && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ background: "#052e16", border: `1px solid #4ade8044`, borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.green, fontWeight: 700 }}>▲ {market.advancing}</span>
            <span style={{ background: "#3b0a0a", border: `1px solid #f8717144`, borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.red,   fontWeight: 700 }}>▼ {market.declining}</span>
            <span style={{ background: "#1a2030", border: `1px solid #4a608044`, borderRadius: 20, padding: "3px 11px", fontSize: 11, color: T.textSec }}>— {market.unchanged}</span>
            <BreadthBar advancing={market.advancing} declining={market.declining} unchanged={market.unchanged} total={market.total} />
            <span style={{ fontSize: 10, color: T.textDim }}>{market.total} stocks</span>
          </div>
        )}

        {/* Accuracy tracker button */}
        <button type="button" onClick={() => setShowAccuracy(true)} style={{
          background: "#1e2a3a", border: `1px solid ${T.border}`, color: T.textSec,
          padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 6,
        }}>📈 Accuracy Tracker</button>

        <div style={{ marginLeft: "auto", fontSize: 10, color: T.textDim }}>
          {updatedAt ? `Updated ${updatedAt.toLocaleTimeString("en-IN")}` : "Connecting…"}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: "16px 20px 40px", paddingRight: selectedSym ? "390px" : "20px", transition: "padding-right 0.2s" }}>

        {/* Gainers + Losers strip */}
        {data && (
          <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
            <GainLossCard title="TOP GAINERS" stocks={data.gainers} onSelect={sym => handleSelect(sym)} accent={T.green} onViewAll={() => handleViewAll("gainers")} />
            <GainLossCard title="TOP LOSERS"  stocks={data.losers}  onSelect={sym => handleSelect(sym)} accent={T.red}   onViewAll={() => handleViewAll("losers")} />
          </div>
        )}

        {/* ── Tabs ── */}
        <div ref={tableRef} style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
          {TABS.map(t => (
            <button type="button" key={t.id} onClick={e => { e.preventDefault(); setTab(t.id); setDisplayLimit(500); }} style={{
              padding: "5px 13px", borderRadius: 5, fontSize: 11, fontWeight: 700,
              cursor: "pointer", border: "1px solid",
              borderColor: tab === t.id ? t.accent : T.border,
              background:  tab === t.id ? `${t.accent}18` : T.bgPanel,
              color:       tab === t.id ? t.accent : T.textDim,
              transition: "all 0.15s",
            }}>
              {t.label}
              {data && t.id !== "sector" && (
                <span style={{ marginLeft: 5, fontSize: 9, color: tab === t.id ? t.accent : T.textDim, opacity: 0.7 }}>
                  {t.id === "gainers"  ? (data.gainers?.length  || 0)         :
                   t.id === "losers"   ? (data.losers?.length   || 0)         :
                   t.id === "all"      ? (data.allStocks?.length || 0)        :
                   t.id === "largecap" ? (data.byMcap?.largecap?.length || 0) :
                   t.id === "midcap"   ? (data.byMcap?.midcap?.length   || 0) :
                   t.id === "smallcap" ? (data.byMcap?.smallcap?.length || 0) :
                   t.id === "microcap" ? (data.byMcap?.microcap?.length || 0) : ""}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Sector view ── */}
        {tab === "sector" ? (
          <div style={{ background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: T.textDim, fontWeight: 700, letterSpacing: "1px", marginBottom: 10 }}>SECTOR PERFORMANCE — NSE 500 + BSE</div>
            {(data?.bySector || []).map(s => <SectorBar key={s.sector} sector={s} />)}
          </div>
        ) : (
          <>
            {/* Search + sort toolbar */}
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="Search symbol or name…"
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                style={{
                  background: T.bgPanel, border: `1px solid ${T.border}`, borderRadius: 6,
                  color: "#ffffff", padding: "6px 12px", fontSize: 12, width: 220,
                  outline: "none", fontFamily: "inherit",
                }}
              />
              <div style={{ display: "flex", gap: 4 }}>
                {[{ id: "gainers", label: "% ↑" }, { id: "losers", label: "% ↓" }, { id: "volume", label: "Vol" }, { id: "value", label: "Value" }].map(s => (
                  <button type="button" key={s.id} onClick={e => { e.preventDefault(); setSortBy(s.id); }} style={{
                    padding: "5px 10px", fontSize: 10, borderRadius: 4, cursor: "pointer",
                    border: "1px solid", fontWeight: 700,
                    borderColor: sortBy === s.id ? T.indigo : T.border,
                    background:  sortBy === s.id ? `${T.indigo}22` : T.bgPanel,
                    color:       sortBy === s.id ? T.indigo : T.textDim,
                  }}>{s.label}</button>
                ))}
              </div>
              {/* FIX: Show actual count, not 150 cap */}
              <span style={{ marginLeft: "auto", fontSize: 11, color: T.textDim }}>
                Showing {Math.min(sorted.length, displayLimit)} of {sorted.length} stocks
              </span>
            </div>

            {/* Table */}
            {!data ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: T.textDim }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>📡</div>
                <div style={{ fontSize: 14, color: T.textSec }}>Fetching NSE 500 + BSE live data…</div>
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
                          padding: "8px 8px", fontSize: 10, color: "#94a3b8", fontWeight: 700,
                          textAlign: ["LTP", "Change", "Volume"].includes(h) ? "right" : "left",
                          letterSpacing: "0.5px",
                          position: "sticky", top: 0, background: "#080d14", zIndex: 1,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* FIX: No more 150 cap — use displayLimit (default 500) */}
                    {sorted.slice(0, displayLimit).map((s, i) => (
                      <StockRow
                        key={`${s.symbol}-${techVersion}`}
                        stock={s}
                        rank={i + 1}
                        onSelect={sym => handleSelect(sym)}
                        selected={selectedSym === s.symbol}
                        tech={techCacheRef.current[`${s.symbol}:${activeTF}`] || null}
                      />
                    ))}
                  </tbody>
                </table>
                {/* FIX: Load More button instead of hard cap */}
                {sorted.length > displayLimit && (
                  <div style={{ textAlign: "center", padding: "12px", borderTop: `1px solid ${T.borderSub}` }}>
                    <button type="button" onClick={() => setDisplayLimit(l => l + 500)} style={{
                      background: T.bgItem, border: `1px solid ${T.border}`, color: T.textSec,
                      padding: "8px 20px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
                    }}>
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

      {/* Accuracy Tracker Modal */}
      {showAccuracy && (
        <AccuracyPanel onClose={() => setShowAccuracy(false)} techCacheRef={techCacheRef} />
      )}
    </div>
  );
}
