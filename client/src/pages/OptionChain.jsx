/**
 * OptionChain.jsx — BLOOMBERG TERMINAL LEVEL
 * Greeks panel: animated SVG charts, Black-Scholes formulas,
 * tick-by-tick sparklines, gamma computed if missing, full interpretation engine
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { io } from "socket.io-client";
import "./OptionChain.css";

const UNDERLYINGS = ["NIFTY", "BANKNIFTY"];

const SIGNAL_LABELS = {
  long_buildup:   { label: "Long Buildup",   color: "#00c896", icon: "▲" },
  short_buildup:  { label: "Short Buildup",  color: "#ff6b6b", icon: "▼" },
  short_covering: { label: "Short Covering", color: "#4db8ff", icon: "▲" },
  long_unwinding: { label: "Long Unwinding", color: "#f0c040", icon: "▼" },
  buildup:        { label: "Buildup",        color: "#00c896", icon: "▲" },
  unwinding:      { label: "Unwinding",      color: "#ff6b6b", icon: "▼" },
  neutral:        { label: "",               color: "transparent", icon: "" },
};

// ── Formatters ─────────────────────────────────────────────────────────────
function fmt(n) {
  if (!n && n !== 0) return "—";
  if (n >= 10000000) return (n / 10000000).toFixed(1) + "Cr";
  if (n >= 100000)   return (n / 100000).toFixed(1) + "L";
  if (n >= 1000)     return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString("en-IN");
}
function fmtDelta(n) {
  if (!n && n !== 0) return null;
  const s = n > 0 ? "+" : "";
  if (Math.abs(n) >= 10000000) return s + (n / 10000000).toFixed(1) + "Cr";
  if (Math.abs(n) >= 100000)   return s + (n / 100000).toFixed(1) + "L";
  if (Math.abs(n) >= 1000)     return s + (n / 1000).toFixed(1) + "K";
  return s + n.toLocaleString("en-IN");
}
function fmtPrice(n) {
  if (!n && n !== 0) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function fmtGreek(n, dec = 3) {
  if (n == null || isNaN(n)) return "—";
  return n.toFixed(dec);
}

// ── Black-Scholes Greeks Engine (Hull 10th ed.) ────────────────────────────
function normCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x >= 0 ? 1 - p : p;
}
function normPDF(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

function blackScholesGreeks(S, K, T, r, sigma, type = "ce") {
  if (!S || !K || !T || !sigma || T <= 0 || sigma <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const npd1 = normPDF(d1);
  const delta = type === "ce" ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = npd1 / (S * sigma * sqrtT);
  const vega  = S * npd1 * sqrtT / 100;
  const theta = type === "ce"
    ? (-S * npd1 * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365
    : (-S * npd1 * sigma / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365;
  const rho = type === "ce"
    ? K * T * Math.exp(-r * T) * normCDF(d2) / 100
    : -K * T * Math.exp(-r * T) * normCDF(-d2) / 100;
  return { delta, gamma, vega, theta, rho };
}

// ── Deep Greek Interpretation (Bloomberg-style) ────────────────────────────
function interpretGreekDeep(type, value, strike, spotPrice, dte) {
  if (value == null || isNaN(value)) return { text: "Insufficient data — Greeks not returned by server. Will compute via Black-Scholes if IV is available.", color: "#3d5a72", badge: "N/A", risk: 0 };
  switch (type) {
    case "delta": {
      const abs = Math.abs(value);
      const mono = spotPrice && strike ? ((spotPrice - strike) / spotPrice * 100).toFixed(2) : null;
      if (abs > 0.80) return { text: `Deep ITM Δ${value.toFixed(4)}${mono ? ` · ${mono}% moneyness` : ""}. Behaves like underlying. High assignment risk near expiry. Gamma near zero — delta stable.`, color: "#00c896", badge: "DEEP ITM", risk: 3 };
      if (abs > 0.60) return { text: `ITM Δ${value.toFixed(4)} — strong directional exposure. Gamma acceleration risk. Suitable for positional delta plays.`, color: "#4db8ff", badge: "ITM", risk: 2 };
      if (abs > 0.40) return { text: `Near ATM Δ${value.toFixed(4)} — balanced sensitivity. Peak gamma zone.${dte != null ? ` ${dte}d DTE — gamma spikes exponentially near expiry.` : ""} Max pain territory.`, color: "#f0c040", badge: "ATM ZONE", risk: 2 };
      if (abs > 0.20) return { text: `OTM Δ${value.toFixed(4)} — low directional bias.${dte != null && dte < 5 ? " ⚠ Expiry week — theta crush accelerating." : " Premium decay dominant."}`, color: "#ff8c42", badge: "OTM", risk: 1 };
      return { text: `Deep OTM Δ${value.toFixed(4)} — lottery ticket. Intrinsic ≈ 0. Avoid buying; sell if IV elevated.`, color: "#ff6b6b", badge: "DEEP OTM", risk: 1 };
    }
    case "gamma": {
      if (value > 0.08) return { text: `Explosive Γ ${value.toFixed(5)} — delta shifts ~${(value*100).toFixed(1)} per ₹100 move. Pin risk near expiry. Market makers aggressively delta-hedging.`, color: "#ff6b6b", badge: "EXPLOSIVE Γ", risk: 3 };
      if (value > 0.04) return { text: `High Γ ${value.toFixed(5)} — rapid delta changes. Scalpers paradise. ${dte != null && dte < 3 ? "⚠ Expiry gamma spike — extreme caution." : "Directional bets amplified."}`, color: "#f0c040", badge: "HIGH Γ", risk: 2 };
      if (value > 0.01) return { text: `Moderate Γ ${value.toFixed(5)} — delta shifts ~${(value*100).toFixed(2)} per ₹100. Spreads and calendars work well here.`, color: "#00c896", badge: "MODERATE Γ", risk: 1 };
      return { text: `Low Γ ${value.toFixed(5)} — delta nearly linear. Deep ITM/OTM or long-dated. Gamma risk minimal.`, color: "#5a7a9a", badge: "STABLE Γ", risk: 0 };
    }
    case "theta": {
      const daily = Math.abs(value);
      if (daily > 50) return { text: `Severe θ ₹${daily.toFixed(1)}/day.${dte != null && dte < 5 ? " ⚠ Expiry week — theta accelerates exponentially (T-effect)." : ""} Weekend = 3× decay. Sellers collecting ₹${(daily*7).toFixed(0)}/week.`, color: "#ff6b6b", badge: "SEVERE DECAY", risk: 3 };
      if (daily > 10) return { text: `High θ ₹${daily.toFixed(1)}/day — time rapidly working against buyers. Break-even requires significant daily move.`, color: "#ff8c42", badge: "HIGH DECAY", risk: 2 };
      if (daily > 2)  return { text: `Moderate θ ₹${daily.toFixed(1)}/day — balanced carry. Suitable for debit spreads to reduce theta drag.`, color: "#f0c040", badge: "MODERATE", risk: 1 };
      return { text: `Low θ ₹${daily.toFixed(2)}/day — minimal erosion. Long-dated or deep ITM. Directional play viable without rush.`, color: "#00c896", badge: "LOW DECAY", risk: 0 };
    }
    case "vega": {
      if (value > 80) return { text: `Extreme ν ${value.toFixed(2)} — ₹${value.toFixed(0)} P&L per 1% IV change. IV crush post-event destroys 40-60% of premium instantly. Avoid buying pre-event.`, color: "#ff6b6b", badge: "IV TRAP", risk: 3 };
      if (value > 40) return { text: `High ν ${value.toFixed(2)} — heavily IV-sensitive. Buy before events, sell after IV expansion. Monitor India VIX regime.`, color: "#a78bfa", badge: "HIGH ν", risk: 2 };
      if (value > 15) return { text: `Moderate ν ${value.toFixed(2)} — ₹${value.toFixed(0)} per 1% IV move. India VIX changes matter here.`, color: "#4db8ff", badge: "MODERATE ν", risk: 1 };
      return { text: `Low ν ${value.toFixed(2)} — IV-insensitive. Near expiry or deep moneyness. Delta dominates P&L.`, color: "#5a7a9a", badge: "LOW ν", risk: 0 };
    }
    default: return { text: "", color: "#5a7a9a", badge: "", risk: 0 };
  }
}

// ── Risk Meter ─────────────────────────────────────────────────────────────
function RiskMeter({ risk = 0 }) {
  const colors = ["#00c896", "#f0c040", "#ff8c42", "#ff6b6b"];
  const labels = ["LOW", "MODERATE", "HIGH", "EXTREME"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}>
      {[0,1,2,3].map(i => (
        <div key={i} style={{
          width: 20, height: 4, borderRadius: 2,
          background: i <= risk ? colors[risk] : "#1a2a3a",
          boxShadow: i <= risk ? `0 0 5px ${colors[risk]}80` : "none",
          transition: "all 0.3s"
        }} />
      ))}
      <span style={{ fontSize: 8, fontFamily: "JetBrains Mono, monospace", fontWeight: 800,
        color: colors[risk], marginLeft: 6, letterSpacing: 0.5 }}>{labels[risk]} RISK</span>
    </div>
  );
}

// ── Animated Bloomberg Sparkline ───────────────────────────────────────────
function BloombergSparkline({ data, color, height = 165, animKey }) {
  const pathRef = useRef(null);
  const W = 440, pad = { t: 22, r: 56, b: 26, l: 52 };
  const IW = W - pad.l - pad.r;
  const IH = height - pad.t - pad.b;

  const validData = useMemo(() => (data || []).filter(v => v != null && !isNaN(v) && isFinite(v)), [data]);

  const computed = useMemo(() => {
    if (validData.length < 2) return null;
    const min = Math.min(...validData);
    const max = Math.max(...validData);
    const range = (max - min) || Math.abs(min) * 0.2 || 1;
    const pad2 = range * 0.15;
    const yMin = min - pad2, yMax = max + pad2, yRange = yMax - yMin;

    const pts = validData.map((v, i) => [
      pad.l + (i / (validData.length - 1)) * IW,
      pad.t + IH - ((v - yMin) / yRange) * IH
    ]);

    const pathD = `M ${pts.map(p => p.join(",")).join(" L ")}`;
    const areaD = `M ${pts[0].join(",")} L ${pts.map(p => p.join(",")).join(" L ")} L ${pts[pts.length-1][0]},${pad.t+IH} L ${pts[0][0]},${pad.t+IH} Z`;
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
      y: pad.t + (1-t) * IH,
      val: yMin + t * yRange
    }));
    const xStep = Math.max(1, Math.floor(pts.length / 5));
    const xLabels = pts.filter((_, i) => i % xStep === 0 || i === pts.length - 1);
    return { pts, pathD, areaD, yTicks, xLabels, last: pts[pts.length-1], lastVal: validData[validData.length-1], min, max };
  }, [validData, IW, IH, pad]);

  // Animate draw on change
  useEffect(() => {
    if (!pathRef.current || !computed) return;
    const el = pathRef.current;
    const len = el.getTotalLength?.() || 700;
    el.style.transition = "none";
    el.style.strokeDasharray = `${len}`;
    el.style.strokeDashoffset = `${len}`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = "stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1)";
      el.style.strokeDashoffset = "0";
    }));
  }, [animKey, computed?.pathD]);

  const gId = `g${color.replace(/[^a-z0-9]/gi, "")}`;
  const fId = `f${color.replace(/[^a-z0-9]/gi, "")}`;

  if (!computed) return (
    <svg width={W} height={height} style={{ width: "100%", height }}>
      <text x={W/2} y={height/2} textAnchor="middle" fill="#2a4060" fontSize="10"
        fontFamily="JetBrains Mono, monospace">
        No data — server not returning this Greek
      </text>
      <text x={W/2} y={height/2+16} textAnchor="middle" fill="#1a3050" fontSize="8"
        fontFamily="JetBrains Mono, monospace">
        Will be computed via Black-Scholes if IV is available
      </text>
    </svg>
  );

  const { pts, pathD, areaD, yTicks, xLabels, last, lastVal, min, max } = computed;

  const fmtTick = v => {
    const a = Math.abs(v);
    if (a >= 100) return v.toFixed(0);
    if (a >= 1)   return v.toFixed(2);
    if (a >= 0.001) return v.toFixed(4);
    return v.toFixed(6);
  };

  return (
    <svg width={W} height={height} style={{ width: "100%", height, display: "block" }}>
      <defs>
        <linearGradient id={gId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.4" />
          <stop offset="60%"  stopColor={color} stopOpacity="0.08" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <filter id={fId}>
          <feGaussianBlur stdDeviation="2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Y grid + labels */}
      {yTicks.map((tick, i) => (
        <g key={i}>
          <line x1={pad.l} y1={tick.y} x2={pad.l+IW} y2={tick.y}
            stroke={i === 2 ? "#243545" : "#141e2a"} strokeWidth={i === 2 ? 1.2 : 0.7}
            strokeDasharray={i === 2 ? "none" : "4,5"} />
          <text x={pad.l-7} y={tick.y+4} textAnchor="end" fill="#2e4a5e" fontSize="8.5"
            fontFamily="JetBrains Mono, monospace">{fmtTick(tick.val)}</text>
        </g>
      ))}

      {/* X labels (strike index) */}
      {xLabels.map(([x], i) => (
        <text key={i} x={x} y={pad.t+IH+16} textAnchor="middle"
          fill="#1e3a50" fontSize="8" fontFamily="JetBrains Mono, monospace">
          S{i * Math.max(1, Math.floor(pts.length/5))}
        </text>
      ))}

      {/* Zero line */}
      {min < 0 && max > 0 && (() => {
        const r2 = max - min || 1;
        const p2 = r2 * 0.15;
        const yR = (max + p2) - (min - p2);
        const zY = pad.t + IH - ((0 - (min - r2*0.15)) / yR) * IH;
        return <line x1={pad.l} y1={zY} x2={pad.l+IW} y2={zY}
          stroke={color} strokeWidth="1" strokeOpacity="0.25" strokeDasharray="6,4" />;
      })()}

      {/* Area */}
      <path d={areaD} fill={`url(#${gId})`} />

      {/* Main line */}
      <path ref={pathRef} d={pathD} fill="none" stroke={color}
        strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"
        filter={`url(#${fId})`} />

      {/* Dots on every 10th point for "tick" feel */}
      {pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length/12)) === 0).map(([x,y], i) => (
        <circle key={i} cx={x} cy={y} r="2" fill={color} opacity="0.5" />
      ))}

      {/* Last value callout */}
      <line x1={last[0]} y1={pad.t} x2={last[0]} y2={pad.t+IH}
        stroke={color} strokeWidth="0.8" strokeOpacity="0.35" strokeDasharray="3,3" />
      <circle cx={last[0]} cy={last[1]} r="5" fill={color}
        style={{ filter: `drop-shadow(0 0 5px ${color})` }} />
      <rect x={last[0]+8} y={last[1]-11} width={48} height={20} rx="4"
        fill="#06101e" stroke={color} strokeWidth="0.8" strokeOpacity="0.7" />
      <text x={last[0]+32} y={last[1]+4} textAnchor="middle"
        fill={color} fontSize="9" fontWeight="800" fontFamily="JetBrains Mono, monospace">
        {fmtTick(lastVal)}
      </text>
    </svg>
  );
}

// ── Greeks Chart Panel — Bloomberg Level ──────────────────────────────────
function GreeksPanel({ strike, side, data, allStrikes, spotPrice, dte, onClose }) {
  const [animKey, setAnimKey] = useState(0);

  // Re-trigger animation every 3s (simulates tick-by-tick)
  useEffect(() => {
    const t = setInterval(() => setAnimKey(k => k + 1), 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Build cross-strike series — use server value OR compute via BS
  const greekSeries = useMemo(() => {
    if (!allStrikes?.length) return { delta: [], gamma: [], theta: [], vega: [] };
    const series = { delta: [], gamma: [], theta: [], vega: [] };
    allStrikes.forEach(row => {
      const opt = side === "ce" ? row.ce : row.pe;
      let { delta: d, gamma: g, theta: t, vega: v } = opt || {};
      // Augment missing values via BS if IV is present
      if ((g == null || isNaN(g) || d == null || isNaN(d)) && spotPrice && row.strike && opt?.iv && dte > 0) {
        const T = dte / 365;
        const sigma = Math.max(0.01, (opt.iv || 15) / 100);
        const bs = blackScholesGreeks(spotPrice, row.strike, T, 0.065, sigma, side);
        if (bs) {
          if (d == null || isNaN(d)) d = bs.delta;
          if (g == null || isNaN(g)) g = bs.gamma;
          if (t == null || isNaN(t)) t = bs.theta;
          if (v == null || isNaN(v)) v = bs.vega;
        }
      }
      series.delta.push(d ?? null);
      series.gamma.push(g ?? null);
      series.theta.push(t ?? null);
      series.vega.push(v ?? null);
    });
    return series;
  }, [allStrikes, side, spotPrice, dte]);

  // Current strike's greeks — BS-augmented
  const greeks = useMemo(() => {
    let { delta: d, gamma: g, theta: t, vega: v, rho: r, iv, ltp, oi } = data || {};
    if (spotPrice && strike && iv && dte > 0) {
      const T = dte / 365;
      const sigma = Math.max(0.01, iv / 100);
      const bs = blackScholesGreeks(spotPrice, strike, T, 0.065, sigma, side);
      if (bs) {
        if (d == null || isNaN(d)) d = bs.delta;
        if (g == null || isNaN(g)) g = bs.gamma;
        if (t == null || isNaN(t)) t = bs.theta;
        if (v == null || isNaN(v)) v = bs.vega;
        if (r == null || isNaN(r)) r = bs.rho;
      }
    }
    return { delta: d, gamma: g, theta: t, vega: v, rho: r, iv, ltp, oi };
  }, [data, spotPrice, strike, dte, side]);

  const Greeks = [
    { key: "delta", sym: "Δ", name: "DELTA",  color: "#00c896", desc: "₹ move per ₹1 in underlying" },
    { key: "gamma", sym: "Γ", name: "GAMMA",  color: "#4db8ff", desc: "delta change per ₹1 move" },
    { key: "theta", sym: "θ", name: "THETA",  color: "#ff8c42", desc: "daily time decay in ₹" },
    { key: "vega",  sym: "ν", name: "VEGA",   color: "#a78bfa", desc: "₹ P&L per 1% IV change" },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 500,
      background: "rgba(2,6,14,0.94)",
      display: "flex", alignItems: "center", justifyContent: "center",
      backdropFilter: "blur(8px)",
      animation: "overlay-in 0.18s ease-out"
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: "linear-gradient(160deg, #070d1b 0%, #080f1f 100%)",
        border: "1px solid #182840",
        borderRadius: 12,
        width: "min(980px, 96vw)",
        maxHeight: "94vh",
        overflowY: "auto",
        boxShadow: "0 40px 100px rgba(0,0,0,0.9), 0 0 0 1px #0d2035",
        animation: "panel-in 0.22s ease-out",
      }}>

        {/* ── Header ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 22px", borderBottom: "1px solid #0d1e30",
          background: "linear-gradient(90deg,#050c1a,#080f20)",
          position: "sticky", top: 0, zIndex: 2, borderRadius: "12px 12px 0 0"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ fontFamily: "JetBrains Mono,monospace", fontSize: 14, fontWeight: 900,
              color: "#d4e8f8", letterSpacing: 2 }}>GREEKS</span>
            <span style={{
              fontFamily: "JetBrains Mono,monospace", fontSize: 13, fontWeight: 700,
              color: side === "ce" ? "#00c896" : "#ff6b6b",
              background: side === "ce" ? "rgba(0,200,150,0.1)" : "rgba(255,107,107,0.1)",
              border: `1px solid ${side === "ce" ? "#00c89640" : "#ff6b6b40"}`,
              padding: "3px 12px", borderRadius: 5
            }}>{strike?.toLocaleString("en-IN")} {side?.toUpperCase()}</span>
            {spotPrice && <span style={{ fontSize: 10, color: "#4db8ff", fontFamily: "JetBrains Mono,monospace" }}>
              SPOT ₹{fmtPrice(spotPrice)}</span>}
            {dte != null && <span style={{
              fontSize: 10, fontWeight: 800,
              color: dte <= 3 ? "#ff6b6b" : dte <= 7 ? "#f0c040" : "#5a7a9a",
              fontFamily: "JetBrains Mono,monospace"
            }}>{dte}d DTE{dte <= 3 ? " ⚠" : ""}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 8, color: "#1e3a50", fontFamily: "JetBrains Mono,monospace" }}>
              ESC / click outside · Black-Scholes augmented · Hull 10th ed.
            </span>
            <button onClick={onClose} style={{
              background: "none", border: "1px solid #1a3050", color: "#4a7a9a",
              width: 28, height: 28, borderRadius: 5, cursor: "pointer", fontSize: 16,
              display: "flex", alignItems: "center", justifyContent: "center"
            }}>×</button>
          </div>
        </div>

        {/* ── Summary strip ── */}
        <div style={{ display: "flex", background: "#03080f", borderBottom: "1px solid #0d1e30", overflowX: "auto" }}>
          {[
            { lbl: "Δ DELTA",  val: greeks.delta != null ? greeks.delta.toFixed(4) : "—",  col: "#00c896" },
            { lbl: "Γ GAMMA",  val: greeks.gamma != null ? greeks.gamma.toFixed(5) : "—",  col: "#4db8ff" },
            { lbl: "θ THETA",  val: greeks.theta != null ? `₹${greeks.theta.toFixed(2)}/d` : "—", col: "#ff8c42" },
            { lbl: "ν VEGA",   val: greeks.vega  != null ? `₹${greeks.vega.toFixed(2)}/%` : "—",  col: "#a78bfa" },
            { lbl: "IV",       val: greeks.iv    != null ? `${greeks.iv.toFixed(1)}%` : "—",        col: "#f0c040" },
            { lbl: "LTP",      val: greeks.ltp   != null ? `₹${fmtPrice(greeks.ltp)}` : "—",       col: "#d4e8f8" },
            { lbl: "OI",       val: fmt(greeks.oi),  col: "#5a7a9a" },
            { lbl: "DTE",      val: dte != null ? `${dte}d` : "—", col: dte <= 3 ? "#ff6b6b" : "#5a7a9a" },
          ].map((item, i) => (
            <div key={i} style={{ padding: "8px 18px", borderRight: "1px solid #0d1e30",
              display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
              <span style={{ fontSize: 8, color: "#1e3a52", fontFamily: "JetBrains Mono,monospace", letterSpacing: 0.8 }}>{item.lbl}</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: item.col, fontFamily: "JetBrains Mono,monospace" }}>{item.val}</span>
            </div>
          ))}
        </div>

        {/* ── 2×2 Charts ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1px", background: "#060c18" }}>
          {Greeks.map(g => {
            const val    = greeks[g.key];
            const series = greekSeries[g.key] || [];
            const interp = interpretGreekDeep(g.key, val, strike, spotPrice, dte);
            const valid  = series.filter(v => v != null && !isNaN(v) && isFinite(v));
            const hasData = valid.length >= 2;

            return (
              <div key={g.key} style={{
                background: "linear-gradient(145deg,#060c1a,#070d1c)",
                padding: "18px 20px",
                borderBottom: "1px solid #060c18", borderRight: "1px solid #060c18"
              }}>
                {/* Chart header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 22, fontWeight: 900, color: g.color,
                      fontFamily: "JetBrains Mono,monospace", textShadow: `0 0 14px ${g.color}70` }}>{g.sym}</span>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: g.color, letterSpacing: 1.5,
                        fontFamily: "JetBrains Mono,monospace" }}>{g.name}</div>
                      <div style={{ fontSize: 8, color: "#2a4a60", fontFamily: "JetBrains Mono,monospace" }}>{g.desc}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 18, fontWeight: 900, color: g.color,
                      fontFamily: "JetBrains Mono,monospace", textShadow: `0 0 10px ${g.color}60` }}>
                      {val != null && !isNaN(val)
                        ? (g.key === "gamma" ? val.toFixed(5) : g.key === "theta" || g.key === "vega" ? val.toFixed(3) : val.toFixed(4))
                        : "—"}
                    </div>
                    <div style={{ fontSize: 8, color: "#2a4a60", fontFamily: "JetBrains Mono,monospace" }}>current</div>
                  </div>
                </div>

                {/* Chart area */}
                <div style={{
                  background: "rgba(0,0,0,0.3)", borderRadius: 8,
                  border: `1px solid ${g.color}18`, overflow: "hidden", position: "relative"
                }}>
                  <BloombergSparkline data={series} color={g.color} height={165} animKey={animKey} />
                  <div style={{
                    position: "absolute", top: 7, right: 10,
                    fontSize: 7, fontFamily: "JetBrains Mono,monospace",
                    color: g.color, background: `${g.color}12`,
                    border: `1px solid ${g.color}25`, borderRadius: 3, padding: "1px 6px",
                    letterSpacing: 0.5
                  }}>CROSS-STRIKE {hasData ? `${valid.length}pts` : "BS-COMPUTED"}</div>
                </div>

                {/* Stats */}
                <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                  {[
                    { lbl: "CURRENT",   val: val != null && !isNaN(val) ? (g.key === "gamma" ? val.toFixed(5) : val.toFixed(3)) : "—", col: g.color },
                    { lbl: "CHAIN MIN", val: hasData ? Math.min(...valid).toFixed(g.key === "gamma" ? 5 : 3) : "—", col: "#2a4a60" },
                    { lbl: "CHAIN MAX", val: hasData ? Math.max(...valid).toFixed(g.key === "gamma" ? 5 : 3) : "—", col: "#2a4a60" },
                    { lbl: "STRIKES",   val: hasData ? valid.length : "—", col: "#1a3050" },
                  ].map((s, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 7, color: "#1a3a50", fontFamily: "JetBrains Mono,monospace", letterSpacing: 0.8 }}>{s.lbl}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: s.col, fontFamily: "JetBrains Mono,monospace" }}>{s.val}</div>
                    </div>
                  ))}
                </div>

                {/* Interpretation */}
                <div style={{
                  marginTop: 10, padding: "8px 12px", borderRadius: 6,
                  background: `${interp.color}0c`, border: `1px solid ${interp.color}22`,
                  display: "flex", gap: 10, alignItems: "flex-start"
                }}>
                  <span style={{
                    fontSize: 8, fontWeight: 800, fontFamily: "JetBrains Mono,monospace",
                    color: interp.color, background: `${interp.color}1e`,
                    border: `1px solid ${interp.color}40`, padding: "2px 7px", borderRadius: 4,
                    whiteSpace: "nowrap", flexShrink: 0, letterSpacing: 0.5
                  }}>{interp.badge}</span>
                  <span style={{ fontSize: 10, color: `${interp.color}cc`, lineHeight: 1.6,
                    fontFamily: "JetBrains Mono,monospace" }}>{interp.text}</span>
                </div>
                <RiskMeter risk={interp.risk} />
              </div>
            );
          })}
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: "10px 22px", borderTop: "1px solid #0a1828",
          background: "#03080f", borderRadius: "0 0 12px 12px",
          display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6
        }}>
          <span style={{ fontSize: 8, color: "#152a3a", fontFamily: "JetBrains Mono,monospace" }}>
            Model: Black-Scholes-Merton · r = 6.5% (RBI repo) · σ from server IV · Γ/ν computed if missing · Ref: Hull "Options, Futures & Other Derivatives" 10th ed.
          </span>
          <span style={{ fontSize: 8, color: "#152a3a", fontFamily: "JetBrains Mono,monospace" }}>
            {greekSeries.delta?.filter(v => v != null).length || 0} strikes · {side?.toUpperCase()} · cross-strike distribution
          </span>
        </div>
      </div>
    </div>
  );
}

// ── OI Bar ─────────────────────────────────────────────────────────────────
function OIBar({ value, prevValue, max, side, signal }) {
  const width    = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const oiChange = prevValue != null ? value - prevValue : 0;
  const color    = side === "ce"
    ? (signal === "short_buildup" || signal === "unwinding" ? "#ff6b6b" : "#00c896")
    : (signal === "long_buildup"  || signal === "buildup"   ? "#00c896" : "#ff6b6b");
  const deltaStr = oiChange !== 0 ? fmtDelta(oiChange) : null;
  return (
    <div className="oi-bar-wrap">
      <div className="oi-bar" style={{ width: `${width}%`, background: color, opacity: 0.3 }} />
      <span className="oi-val">{fmt(value)}</span>
      {deltaStr && <span className="oi-delta" style={{ color: oiChange > 0 ? "#00c896" : "#ff6b6b" }}>{deltaStr}</span>}
    </div>
  );
}

// ── Greek Cell ─────────────────────────────────────────────────────────────
function GreekCell({ delta, theta, vega, gamma, side, onGreekClick }) {
  const dColor = side === "ce" ? (delta > 0.5 ? "#00c896" : "#5a7a9a") : (delta < -0.5 ? "#ff6b6b" : "#5a7a9a");
  return (
    <div className="greek-cell" onClick={onGreekClick} title="Click for Bloomberg Greeks chart">
      <span className="greek-item" style={{ color: dColor }}><span className="greek-label">Δ</span>{fmtGreek(delta, 2)}</span>
      <span className="greek-item" style={{ color: "#ff8c42" }}><span className="greek-label">θ</span>{fmtGreek(theta, 1)}</span>
      <span className="greek-item" style={{ color: "#a78bfa" }}><span className="greek-label">ν</span>{fmtGreek(vega, 2)}</span>
    </div>
  );
}

// ── Strike Row ─────────────────────────────────────────────────────────────
function StrikeRow({ row, prevRow, maxCEOI, maxPEOI, spotPrice, isFlash, showGreeks, onGreekClick }) {
  const isATM  = row.isATM;
  const itm_ce = spotPrice > 0 && row.strike < spotPrice;
  const itm_pe = spotPrice > 0 && row.strike > spotPrice;
  const ceSig  = SIGNAL_LABELS[row.ce.signal] || SIGNAL_LABELS.neutral;
  const peSig  = SIGNAL_LABELS[row.pe.signal] || SIGNAL_LABELS.neutral;
  const netChange = (prevRow ? row.ce.oi - prevRow.ce.oi : 0) + (prevRow ? row.pe.oi - prevRow.pe.oi : 0);
  const tickClass = netChange > 0 ? " tick-up" : netChange < 0 ? " tick-down" : "";
  return (
    <tr className={`strike-row${isATM?" atm":""}${isFlash?" flash":""}${tickClass}${itm_ce?" itm-ce":""}${itm_pe?" itm-pe":""}`}>
      <td className="ce-cell oi-cell"><OIBar value={row.ce.oi} prevValue={prevRow?.ce.oi} max={maxCEOI} side="ce" signal={row.ce.signal}/></td>
      <td className={`ce-cell change ${row.ce.oiChange>0?"pos":row.ce.oiChange<0?"neg":""}`}>{row.ce.oiChange!==0&&<span>{row.ce.oiChange>0?"+":""}{fmt(row.ce.oiChange)}</span>}</td>
      <td className="ce-cell ltp">{fmtPrice(row.ce.ltp)}</td>
      <td className="ce-cell iv">{row.ce.iv?row.ce.iv.toFixed(1)+"%":"—"}</td>
      {showGreeks&&<td className="ce-cell"><GreekCell delta={row.ce.delta} theta={row.ce.theta} vega={row.ce.vega} gamma={row.ce.gamma} side="ce" onGreekClick={()=>onGreekClick(row.strike,"ce",row.ce)}/></td>}
      <td className="ce-cell sig">{ceSig.icon&&<span className="sig-pill" style={{color:ceSig.color}}>{ceSig.icon} {ceSig.label}</span>}</td>
      <td className="strike-cell"><span className="strike-num">{row.strike.toLocaleString("en-IN")}</span>{isATM&&<span className="atm-badge">ATM</span>}</td>
      <td className="pe-cell sig">{peSig.icon&&<span className="sig-pill" style={{color:peSig.color}}>{peSig.icon} {peSig.label}</span>}</td>
      {showGreeks&&<td className="pe-cell"><GreekCell delta={row.pe.delta} theta={row.pe.theta} vega={row.pe.vega} gamma={row.pe.gamma} side="pe" onGreekClick={()=>onGreekClick(row.strike,"pe",row.pe)}/></td>}
      <td className="pe-cell iv">{row.pe.iv?row.pe.iv.toFixed(1)+"%":"—"}</td>
      <td className="pe-cell ltp">{fmtPrice(row.pe.ltp)}</td>
      <td className={`pe-cell change ${row.pe.oiChange>0?"pos":row.pe.oiChange<0?"neg":""}`}>{row.pe.oiChange!==0&&<span>{row.pe.oiChange>0?"+":""}{fmt(row.pe.oiChange)}</span>}</td>
      <td className="pe-cell oi-cell"><OIBar value={row.pe.oi} prevValue={prevRow?.pe.oi} max={maxPEOI} side="pe" signal={row.pe.signal}/></td>
    </tr>
  );
}

// ── PCR / Timer / Badge / FlowBar ──────────────────────────────────────────
function PCRGauge({ pcr }) {
  if (!pcr) return null;
  const level  = pcr > 1.2 ? "bullish" : pcr < 0.8 ? "bearish" : "neutral";
  const colors = { bullish: "#00c896", neutral: "#f0c040", bearish: "#ff6b6b" };
  const label  = { bullish: "Bullish", neutral: "Neutral", bearish: "Bearish" };
  return (
    <div className="pcr-gauge">
      <span className="pcr-label">PCR</span>
      <span className="pcr-val" style={{ color: colors[level] }}>{pcr.toFixed(3)}</span>
      <span className="pcr-level" style={{ color: colors[level] }}>{label[level]}</span>
    </div>
  );
}
function UpdateTimer({ lastUpdate }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!lastUpdate) return;
    const tick = () => setSecs(Math.floor((Date.now()-lastUpdate)/1000));
    tick(); const t = setInterval(tick, 1000); return () => clearInterval(t);
  }, [lastUpdate]);
  if (!lastUpdate) return <span className="s-val updated">—</span>;
  const color = secs<20?"#00c896":secs<60?"#f0c040":"#ff6b6b";
  return <span className="s-val updated" style={{color}}>{secs}s ago</span>;
}
function ConnBadge({ status }) {
  const map = { live:{label:"LIVE",color:"#00c896"}, rest:{label:"REST POLL",color:"#f0c040"}, disconnected:{label:"DISCONNECTED",color:"#ff6b6b"} };
  const cfg = map[status]||map.disconnected;
  return (
    <div className={`conn-badge ${status}`} style={{color:cfg.color,borderColor:cfg.color+"30"}}>
      <span style={{width:5,height:5,borderRadius:"50%",background:cfg.color,display:"inline-block",animation:status==="live"?"dot-pulse 1.4s infinite":"none"}}/>
      {cfg.label}
    </div>
  );
}
function OIFlowBar({ totalCEOI, totalPEOI }) {
  const total=(totalCEOI||0)+(totalPEOI||0);
  const cePct=total>0?((totalCEOI/total)*100).toFixed(1):50;
  const pePct=total>0?((totalPEOI/total)*100).toFixed(1):50;
  return (
    <div className="oi-flow-bar" title={`CE: ${cePct}%  PE: ${pePct}%`}>
      <div className="oi-flow-ce" style={{width:`${cePct}%`}}/>
      <div className="oi-flow-pe" style={{width:`${pePct}%`}}/>
    </div>
  );
}
function calcDTE(expiryStr) {
  if (!expiryStr) return null;
  try { return Math.max(0, Math.ceil((new Date(expiryStr) - new Date()) / 86400000)); }
  catch { return null; }
}

// ── Main ───────────────────────────────────────────────────────────────────
export default function OptionChain({ onBack }) {
  const [underlying,     setUnderlying]  = useState("NIFTY");
  const [expiries,       setExpiries]    = useState([]);
  const [selectedExpiry, setExpiry]      = useState(null);
  const [chainData,      setChainData]   = useState(null);
  const [prevStrikes,    setPrevStrikes] = useState({});
  const [loading,        setLoading]     = useState(true);
  const [lastUpdate,     setLastUpdate]  = useState(null);
  const [flashStrikes,   setFlashStrikes]= useState(new Set());
  const [showATMOnly,    setShowATMOnly] = useState(false);
  const [strikeCount,    setStrikeCount] = useState(20);
  const [showGreeks,     setShowGreeks]  = useState(false);
  const [connStatus,     setConnStatus]  = useState("disconnected");
  const [greekPanel,     setGreekPanel]  = useState(null);

  const socketRef     = useRef(null);
  const tableRef      = useRef(null);
  const pollRef       = useRef(null);
  const lastUpdateRef = useRef(null);

  const applyChainData = useCallback((data, source) => {
    if (!data) return;
    setPrevStrikes(() => { const n={}; (data.strikes||[]).forEach(r=>{n[r.strike]=r;}); return n; });
    setChainData(data);
    const now = Date.now();
    setLastUpdate(now); lastUpdateRef.current = now;
    setLoading(false);
    setConnStatus(source === "socket" ? "live" : "rest");
    if (data.alerts?.length) {
      const f = new Set(data.alerts.map(a=>a.strike));
      setFlashStrikes(f); setTimeout(()=>setFlashStrikes(new Set()), 1500);
    }
  }, []);

  useEffect(() => {
    const socket = io(window.location.origin, { transports: ["websocket"] });
    socketRef.current = socket;
    socket.on("connect", () => { setConnStatus("live"); socket.emit("request-option-chain",{underlying,expiry:selectedExpiry}); });
    socket.on("disconnect", () => setConnStatus("disconnected"));
    socket.on("option-expiries", ({underlying:u,expiries:e}) => { if(u!==underlying)return; setExpiries(e||[]); if(e?.length&&!selectedExpiry)setExpiry(e[0]); });
    socket.on("option-chain-update", ({underlying:u,data}) => { if(u!==underlying)return; applyChainData(data,"socket"); });
    return () => { socket.disconnect(); setConnStatus("disconnected"); };
  }, [underlying]); // eslint-disable-line

  useEffect(() => {
    if (socketRef.current?.connected && selectedExpiry)
      socketRef.current.emit("request-option-chain",{underlying,expiry:selectedExpiry});
  }, [underlying, selectedExpiry]);

  useEffect(() => {
    if (!selectedExpiry) return;
    const poll = () => {
      fetch(`/api/option-chain?underlying=${underlying}&expiry=${selectedExpiry}`)
        .then(r=>r.json()).then(data => {
          if (!data?.strikes) return;
          const age = lastUpdateRef.current ? Date.now()-lastUpdateRef.current : Infinity;
          if (age > 2000) applyChainData(data, "rest");
          else { const now=Date.now(); setLastUpdate(now); lastUpdateRef.current=now; }
        }).catch(()=>{});
    };
    setLoading(true); poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [underlying, selectedExpiry]); // eslint-disable-line

  useEffect(() => {
    setLoading(true); setChainData(null); setExpiry(null); lastUpdateRef.current=null;
    fetch(`/api/option-chain/expiries?underlying=${underlying}`)
      .then(r=>r.json()).then(({expiries:e})=>{ setExpiries(e||[]); if(e?.length)setExpiry(e[0]); }).catch(()=>{});
  }, [underlying]);

  const strikes = chainData?.strikes || [];
  const dte = useMemo(() => calcDTE(selectedExpiry), [selectedExpiry]);

  const visibleStrikes = useMemo(() => {
    if (!strikes.length) return [];
    if (!showATMOnly) return strikes;
    const idx = strikes.findIndex(s=>s.isATM);
    if (idx<0) return strikes;
    return strikes.slice(Math.max(0,idx-strikeCount), Math.min(strikes.length-1,idx+strikeCount)+1);
  }, [strikes, showATMOnly, strikeCount]);

  const maxCEOI = useMemo(()=>Math.max(...visibleStrikes.map(s=>s.ce.oi),1),[visibleStrikes]);
  const maxPEOI = useMemo(()=>Math.max(...visibleStrikes.map(s=>s.pe.oi),1),[visibleStrikes]);

  useEffect(() => {
    if (!chainData) return;
    const atm = tableRef.current?.querySelector(".atm");
    if (atm) setTimeout(()=>atm.scrollIntoView({behavior:"smooth",block:"center"}),100);
  }, [chainData?.expiry, chainData?.underlying]);

  const handleGreekClick = useCallback((strike, side, data) => { setGreekPanel({strike,side,data}); setShowGreeks(true); }, []);
  const closeGreekPanel  = useCallback(() => setGreekPanel(null), []);

  return (
    <div className="oc-page">
      {greekPanel && (
        <GreeksPanel
          strike={greekPanel.strike}
          side={greekPanel.side}
          data={greekPanel.data}
          allStrikes={visibleStrikes}
          spotPrice={chainData?.spotPrice}
          dte={dte}
          onClose={closeGreekPanel}
        />
      )}

      <div className="oc-header">
        <div className="oc-title">
          <span style={{fontSize:15}}>⚡</span>
          <h1>Option Chain <span className="oc-sub">OI Heatmap</span></h1>
          {chainData && <span className="live-dot"/>}
        </div>
        <div className="oc-controls">
          <div className="control-group">
            {UNDERLYINGS.map(u=>(
              <button key={u} className={`ctrl-btn${underlying===u?" active":""}`} onClick={()=>setUnderlying(u)}>{u}</button>
            ))}
          </div>
          {expiries.length>0&&(
            <div className="control-group">
              {expiries.slice(0,5).map(e=>(
                <button key={e} className={`ctrl-btn expiry${selectedExpiry===e?" active":""}`} onClick={()=>setExpiry(e)}>{e}</button>
              ))}
            </div>
          )}
          <div className="control-group">
            <button className={`ctrl-btn${showATMOnly?" active":""}`} onClick={()=>setShowATMOnly(v=>!v)}>Near ATM</button>
            {showATMOnly&&(
              <select className="ctrl-select" value={strikeCount} onChange={e=>setStrikeCount(Number(e.target.value))}>
                {[5,10,15,20,30].map(n=><option key={n} value={n}>±{n}</option>)}
              </select>
            )}
          </div>
          <div className="control-group">
            <button className={`ctrl-btn${showGreeks?" active":""}`} onClick={()=>setShowGreeks(v=>!v)}>
              {showGreeks?"Hide Δθν":"Δθν Greeks"}
            </button>
          </div>
          {dte!=null&&(
            <div style={{fontSize:9,fontFamily:"JetBrains Mono,monospace",fontWeight:700,
              color:dte<=3?"#ff6b6b":dte<=7?"#f0c040":"#5a7a9a",
              padding:"3px 8px",background:"rgba(0,0,0,0.3)",borderRadius:4,
              border:`1px solid ${dte<=3?"#ff6b6b30":"#1c2b3a"}`}}>
              {dte}d DTE
            </div>
          )}
          {onBack&&<button className="ctrl-btn" onClick={onBack}>← Back</button>}
          <ConnBadge status={connStatus}/>
        </div>
      </div>

      {chainData&&(
        <div className="oc-summary">
          <div className="summary-item"><span className="s-label">Spot</span><span className="s-val spot">{fmtPrice(chainData.spotPrice)}</span></div>
          <PCRGauge pcr={chainData.pcr}/>
          <div className="summary-item"><span className="s-label">Max Pain</span><span className="s-val maxpain">{chainData.maxPainStrike?.toLocaleString("en-IN")||"—"}</span></div>
          <div className="summary-item"><span className="s-label">Support</span><span className="s-val support">{chainData.support?.toLocaleString("en-IN")||"—"}</span></div>
          <div className="summary-item"><span className="s-label">Resistance</span><span className="s-val resistance">{chainData.resistance?.toLocaleString("en-IN")||"—"}</span></div>
          <div className="summary-item"><span className="s-label">CE OI</span><span className="s-val ce-oi">{fmt(chainData.totalCEOI)}</span></div>
          <div className="summary-item"><span className="s-label">PE OI</span><span className="s-val pe-oi">{fmt(chainData.totalPEOI)}</span></div>
          {chainData.ivSkew!=null&&(
            <div className="summary-item"><span className="s-label">IV Skew</span>
              <span className="s-val" style={{color:chainData.ivSkew>0?"#ff6b6b":"#00c896",fontSize:12}}>
                {chainData.ivSkew>0?"+":""}{chainData.ivSkew?.toFixed(1)}%
              </span>
            </div>
          )}
          <div className="summary-item"><span className="s-label">Updated</span><UpdateTimer lastUpdate={lastUpdate}/></div>
        </div>
      )}

      {chainData&&<OIFlowBar totalCEOI={chainData.totalCEOI} totalPEOI={chainData.totalPEOI}/>}

      {showGreeks&&(
        <div className="greeks-legend">
          <span><span style={{color:"#00c896"}}>Δ Delta</span> — price sensitivity</span>
          <span><span style={{color:"#ff8c42"}}>θ Theta</span> — daily decay ₹</span>
          <span><span style={{color:"#a78bfa"}}>ν Vega</span> — IV sensitivity</span>
          <span><span style={{color:"#4db8ff"}}>Γ Gamma</span> — delta curvature</span>
          <span style={{color:"#3d5a72",marginLeft:"auto"}}>Click any cell → Bloomberg chart →</span>
        </div>
      )}

      {chainData?.alerts?.length>0&&(
        <div className="oc-alerts">
          {chainData.alerts.slice(0,6).map((a,i)=>{
            const sig=SIGNAL_LABELS[a.signal]||SIGNAL_LABELS.neutral;
            return (
              <div key={i} className="oc-alert-pill" style={{borderColor:sig.color+"50"}}>
                <span style={{color:sig.color}}>{sig.icon}</span>
                <span className="alert-strike">{a.strike.toLocaleString("en-IN")}</span>
                <span className="alert-side">{a.side}</span>
                <span style={{color:sig.color}}>{sig.label}</span>
                {a.pct&&<span className="alert-pct">{a.pct}</span>}
              </div>
            );
          })}
        </div>
      )}

      {loading&&<div className="oc-loading"><div className="loading-pulse"/><span>Fetching option chain data...</span></div>}
      {!loading&&!chainData&&<div className="oc-empty"><p>⏳ Waiting for first poll...</p><p className="empty-sub">NSE · socket primary · 3s REST fallback</p></div>}

      {!loading&&chainData&&(
        <div className="oc-table-wrap" ref={tableRef}>
          <table className="oc-table">
            <thead>
              <tr className="side-label-row">
                <th className="ce-side-label" colSpan={showGreeks?6:5}>CALL — CE</th>
                <th/>
                <th className="pe-side-label" colSpan={showGreeks?6:5}>PUT — PE</th>
              </tr>
              <tr>
                <th className="ce-th">OI</th><th className="ce-th">Chg OI</th><th className="ce-th">LTP</th><th className="ce-th">IV</th>
                {showGreeks&&<th className="ce-th">Greeks ↗</th>}
                <th className="ce-th">Signal</th><th className="strike-th">Strike</th><th className="pe-th">Signal</th>
                {showGreeks&&<th className="pe-th">Greeks ↗</th>}
                <th className="pe-th">IV</th><th className="pe-th">LTP</th><th className="pe-th">Chg OI</th><th className="pe-th">OI</th>
              </tr>
            </thead>
            <tbody>
              {visibleStrikes.map(row=>(
                <StrikeRow key={row.strike} row={row} prevRow={prevStrikes[row.strike]}
                  maxCEOI={maxCEOI} maxPEOI={maxPEOI} spotPrice={chainData.spotPrice}
                  isFlash={flashStrikes.has(row.strike)} showGreeks={showGreeks} onGreekClick={handleGreekClick}/>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="oc-footer">
        <span>Socket · 3s REST · BS-augmented Greeks · Hull 10th ed. · {showGreeks?"Click Δθν → Bloomberg chart":"Toggle Greeks for Δθν"}</span>
        {chainData&&<span>{visibleStrikes.length}/{strikes.length} strikes · {underlying} · {selectedExpiry}{dte!=null?` · ${dte}d DTE`:""}</span>}
      </div>
    </div>
  );
}
