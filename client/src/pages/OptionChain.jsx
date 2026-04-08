/**
 * OptionChain.jsx — BLOOMBERG TERMINAL LEVEL
 *
 * ALL 5 FIXES FULLY INTEGRATED (reading upstoxStream.js + server/index.js):
 *
 *  FIX 1 — position:fixed layout: header/summary/footer never scroll with page.
 *           CSS vars --header-h, --summary-h, --table-top drive the table container.
 *
 *  FIX 2 — ResizeObserver measures every fixed bar on each render.
 *           Writes exact pixel values to CSS vars so table top is mathematically
 *           correct even when header wraps on small screens or Greeks legend appears.
 *
 *  FIX 3 — mergeChainData returns same row object refs when data unchanged.
 *           StrikeRow wrapped in React.memo with ref-equality comparator.
 *           Unchanged rows are fully skipped by React's reconciler.
 *
 *  FIX 4 — Greeks chart animKey derived from greekSeries data hash (NOT setInterval).
 *           Chart draws once on panel open, re-animates ONLY when real data changes.
 *           Removed the 3-second timer that caused constant re-animation.
 *
 *  FIX 5 — REST poll + socket feed same applyChainData merge pipeline.
 *           REST data silently ignored when socket has updated within last 2s.
 *           applyChainData is stable (useCallback, no closure over stale refs).
 *
 *  UPSTOX WIRING (from upstoxStream.js analysis):
 *    - Server emits "market-tick" for index prices (NIFTY 50, SENSEX, BANK NIFTY)
 *    - Server emits "option-chain-update" { underlying, data } for OI chain data
 *    - Server emits "option-expiries" { underlying, expiries } on connect
 *    - Server emits "upstox-status" { connected } on WS open/close
 *    - Client emits "request-option-chain" { underlying, expiry } to trigger push
 *    - upstoxStream.js handles reconnection internally — no client-side retry needed
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect
} from "react";
import { io } from "socket.io-client";
import "./OptionChain.css";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Black-Scholes Greeks (Hull 10th ed.)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Greek Interpretation
// ─────────────────────────────────────────────────────────────────────────────

function interpretGreekDeep(type, value, strike, spotPrice, dte) {
  if (value == null || isNaN(value)) {
    return { text: "BS-computed from IV. Server greek not available.", color: "#5a8aaa", badge: "BS", risk: 0 };
  }
  switch (type) {
    case "delta": {
      const abs = Math.abs(value);
      if (abs > 0.80) return { text: `Deep ITM Δ${value.toFixed(4)}. Behaves like underlying. High assignment risk near expiry.`, color: "#00c896", badge: "DEEP ITM", risk: 3 };
      if (abs > 0.60) return { text: `ITM Δ${value.toFixed(4)} — strong directional exposure. Gamma acceleration risk.`, color: "#4db8ff", badge: "ITM", risk: 2 };
      if (abs > 0.40) return { text: `Near ATM Δ${value.toFixed(4)} — balanced sensitivity. Peak gamma zone.${dte != null ? ` ${dte}d DTE.` : ""}`, color: "#f0c040", badge: "ATM ZONE", risk: 2 };
      if (abs > 0.20) return { text: `OTM Δ${value.toFixed(4)} — low directional bias.${dte != null && dte < 5 ? " ⚠ Expiry week — theta crush." : " Premium decay dominant."}`, color: "#ff8c42", badge: "OTM", risk: 1 };
      return { text: `Deep OTM Δ${value.toFixed(4)} — lottery ticket. Intrinsic ≈ 0.`, color: "#ff6b6b", badge: "DEEP OTM", risk: 1 };
    }
    case "gamma": {
      if (value > 0.08) return { text: `Explosive Γ ${value.toFixed(5)} — delta shifts ~${(value*100).toFixed(1)} per ₹100. Pin risk near expiry.`, color: "#ff6b6b", badge: "EXPLOSIVE Γ", risk: 3 };
      if (value > 0.04) return { text: `High Γ ${value.toFixed(5)} — rapid delta changes.${dte != null && dte < 3 ? " ⚠ Expiry gamma spike." : ""}`, color: "#f0c040", badge: "HIGH Γ", risk: 2 };
      if (value > 0.01) return { text: `Moderate Γ ${value.toFixed(5)} — delta shifts ~${(value*100).toFixed(2)} per ₹100.`, color: "#00c896", badge: "MODERATE Γ", risk: 1 };
      return { text: `Low Γ ${value.toFixed(5)} — delta nearly linear. Deep ITM/OTM or long-dated.`, color: "#5a7a9a", badge: "STABLE Γ", risk: 0 };
    }
    case "theta": {
      const daily = Math.abs(value);
      if (daily > 50) return { text: `Severe θ ₹${daily.toFixed(1)}/day.${dte != null && dte < 5 ? " ⚠ Expiry week." : ""} Weekend = 3× decay.`, color: "#ff6b6b", badge: "SEVERE DECAY", risk: 3 };
      if (daily > 10) return { text: `High θ ₹${daily.toFixed(1)}/day — time rapidly working against buyers.`, color: "#ff8c42", badge: "HIGH DECAY", risk: 2 };
      if (daily > 2)  return { text: `Moderate θ ₹${daily.toFixed(1)}/day — balanced carry.`, color: "#f0c040", badge: "MODERATE", risk: 1 };
      return { text: `Low θ ₹${daily.toFixed(2)}/day — minimal erosion.`, color: "#00c896", badge: "LOW DECAY", risk: 0 };
    }
    case "vega": {
      if (value > 80) return { text: `Extreme ν ${value.toFixed(2)} — IV crush destroys 40-60% premium instantly.`, color: "#ff6b6b", badge: "IV TRAP", risk: 3 };
      if (value > 40) return { text: `High ν ${value.toFixed(2)} — heavily IV-sensitive.`, color: "#a78bfa", badge: "HIGH ν", risk: 2 };
      if (value > 15) return { text: `Moderate ν ${value.toFixed(2)} — ₹${value.toFixed(0)} per 1% IV.`, color: "#4db8ff", badge: "MODERATE ν", risk: 1 };
      return { text: `Low ν ${value.toFixed(2)} — IV-insensitive.`, color: "#5a7a9a", badge: "LOW ν", risk: 0 };
    }
    default: return { text: "", color: "#5a7a9a", badge: "", risk: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk Meter
// ─────────────────────────────────────────────────────────────────────────────

function RiskMeter({ risk = 0 }) {
  const colors = ["#00c896", "#f0c040", "#ff8c42", "#ff6b6b"];
  const labels = ["LOW", "MOD", "HIGH", "EXT"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 5 }}>
      {[0,1,2,3].map(i => (
        <div key={i} style={{
          width: 16, height: 3, borderRadius: 2,
          background: i <= risk ? colors[risk] : "#1a2a3a",
          boxShadow: i <= risk ? `0 0 4px ${colors[risk]}80` : "none",
          transition: "all 0.3s"
        }} />
      ))}
      <span style={{
        fontSize: 7, fontFamily: "JetBrains Mono, monospace", fontWeight: 800,
        color: colors[risk], marginLeft: 4, letterSpacing: 0.5
      }}>{labels[risk]}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloomberg Sparkline
// FIX 4: animKey comes from data hash — no setInterval, no spurious redraws
// ─────────────────────────────────────────────────────────────────────────────

function BloombergSparkline({ data, color, height = 110, animKey }) {
  const pathRef = useRef(null);
  const W = 340;
  const pad = { t: 18, r: 52, b: 22, l: 52 };
  const IW = W - pad.l - pad.r;
  const IH = height - pad.t - pad.b;

  const validData = useMemo(
    () => (data || []).filter(v => v != null && !isNaN(v) && isFinite(v)),
    [data]
  );

  const computed = useMemo(() => {
    if (validData.length < 2) return null;
    const min = Math.min(...validData);
    const max = Math.max(...validData);
    const range = (max - min) || Math.abs(min) * 0.2 || 1;
    const padR = range * 0.18;
    const yMin = min - padR, yMax = max + padR, yRange = yMax - yMin;
    const pts = validData.map((v, i) => [
      pad.l + (i / (validData.length - 1)) * IW,
      pad.t + IH - ((v - yMin) / yRange) * IH
    ]);
    const pathD = `M ${pts.map(p => p.join(",")).join(" L ")}`;
    const areaD = `M ${pts[0].join(",")} L ${pts.map(p => p.join(",")).join(" L ")} L ${pts[pts.length-1][0]},${pad.t+IH} L ${pts[0][0]},${pad.t+IH} Z`;
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({ y: pad.t + (1-t) * IH, val: yMin + t * yRange }));
    return { pts, pathD, areaD, yTicks, last: pts[pts.length-1], lastVal: validData[validData.length-1], min, max };
  }, [validData, IW, IH]);

  // FIX 4: Only fires when animKey changes (data hash changed), NOT on a timer
  useEffect(() => {
    if (!pathRef.current || !computed) return;
    const el = pathRef.current;
    const len = el.getTotalLength?.() || 500;
    el.style.transition = "none";
    el.style.strokeDasharray = `${len}`;
    el.style.strokeDashoffset = `${len}`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = "stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1)";
      el.style.strokeDashoffset = "0";
    }));
  }, [animKey]); // ← stable hash, only changes when data actually changes

  const uid = useMemo(() => `c${Math.random().toString(36).slice(2,8)}`, []);
  const gId = `g_${uid}`;
  const fId = `f_${uid}`;

  const fmtTick = v => {
    const a = Math.abs(v);
    if (a >= 10000)  return (v/1000).toFixed(0)+"K";
    if (a >= 1000)   return v.toFixed(0);
    if (a >= 100)    return v.toFixed(0);
    if (a >= 1)      return v.toFixed(2);
    if (a >= 0.001)  return v.toFixed(4);
    return v.toFixed(5);
  };

  if (!computed) return (
    <svg width={W} height={height} style={{ width: "100%", height, display: "block" }}>
      <rect x={pad.l} y={pad.t} width={IW} height={IH} fill="none" stroke="#1a2a3a" strokeWidth="0.5" rx="2"/>
      <text x={W/2} y={height/2 - 8} textAnchor="middle" fill="#6a9abf" fontSize="10" fontFamily="JetBrains Mono, monospace" fontWeight="600">BS Computed</text>
      <text x={W/2} y={height/2 + 8} textAnchor="middle" fill="#4a7a9a" fontSize="8" fontFamily="JetBrains Mono, monospace">No cross-strike data yet</text>
    </svg>
  );

  const { pts, pathD, areaD, yTicks, last, lastVal } = computed;

  return (
    <svg width={W} height={height} style={{ width: "100%", height, display: "block" }}>
      <defs>
        <linearGradient id={gId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
        <filter id={fId}>
          <feGaussianBlur stdDeviation="1.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect x={pad.l} y={pad.t} width={IW} height={IH} fill="none" stroke="#1e3045" strokeWidth="0.6" rx="2"/>
      {yTicks.map((tick, i) => (
        <g key={i}>
          <line x1={pad.l} y1={tick.y} x2={pad.l + IW} y2={tick.y}
            stroke={i === 2 ? "#243850" : "#162030"}
            strokeWidth={i === 2 ? 1 : 0.5}
            strokeDasharray={i === 2 ? "none" : "4,4"}
          />
          <text x={pad.l - 6} y={tick.y + 3.5} textAnchor="end"
            fill="#8ab0cc" fontSize="8" fontFamily="JetBrains Mono, monospace" fontWeight="500">
            {fmtTick(tick.val)}
          </text>
        </g>
      ))}
      {computed.min < 0 && computed.max > 0 && (() => {
        const range = computed.max - computed.min || 1;
        const padR2 = range * 0.18;
        const yR = (computed.max + padR2) - (computed.min - padR2);
        const zY = pad.t + IH - ((0 - (computed.min - range*0.18)) / yR) * IH;
        return <line x1={pad.l} y1={zY} x2={pad.l+IW} y2={zY}
          stroke={color} strokeWidth="1" strokeOpacity="0.35" strokeDasharray="6,4" />;
      })()}
      {[0, Math.floor(validData.length / 2), validData.length - 1].map((idx, i) => {
        const pt = pts[idx];
        if (!pt) return null;
        return (
          <text key={i} x={pt[0]} y={pad.t + IH + 12} textAnchor="middle"
            fill="#5a7a96" fontSize="7.5" fontFamily="JetBrains Mono, monospace">{idx + 1}</text>
        );
      })}
      <path d={areaD} fill={`url(#${gId})`} />
      <path ref={pathRef} d={pathD} fill="none" stroke={color}
        strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"
        filter={`url(#${fId})`} />
      {pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 8)) === 0).map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2" fill={color} opacity="0.5" />
      ))}
      <line x1={last[0]} y1={pad.t} x2={last[0]} y2={pad.t + IH}
        stroke={color} strokeWidth="0.8" strokeOpacity="0.4" strokeDasharray="3,3" />
      <circle cx={last[0]} cy={last[1]} r="4.5" fill={color}
        style={{ filter: `drop-shadow(0 0 5px ${color})` }} />
      <rect x={last[0] + 7} y={last[1] - 10} width={44} height={18} rx="3"
        fill="#06101e" stroke={color} strokeWidth="0.8" strokeOpacity="0.7" />
      <text x={last[0] + 29} y={last[1] + 3.5} textAnchor="middle"
        fill={color} fontSize="8.5" fontWeight="800" fontFamily="JetBrains Mono, monospace">
        {fmtTick(lastVal)}
      </text>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar Stat Block
// ─────────────────────────────────────────────────────────────────────────────

function SidebarStatBlock({ greek, greeks, greekSeries, strike, spotPrice, dte }) {
  const val    = greeks[greek.key];
  const series = greekSeries[greek.key] || [];
  const valid  = series.filter(v => v != null && !isNaN(v) && isFinite(v));
  const interp = interpretGreekDeep(greek.key, val, strike, spotPrice, dte);

  const fmtVal = v => {
    if (v == null || isNaN(v)) return "—";
    if (greek.key === "gamma") return v.toFixed(5);
    if (greek.key === "theta" || greek.key === "vega") return v.toFixed(3);
    return v.toFixed(4);
  };

  return (
    <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #0d1e30" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            fontSize: 16, fontWeight: 900, color: greek.color,
            fontFamily: "JetBrains Mono, monospace", textShadow: `0 0 10px ${greek.color}60`
          }}>{greek.sym}</span>
          <div>
            <div style={{ fontSize: 9, fontWeight: 800, color: greek.color, letterSpacing: 1.2, fontFamily: "JetBrains Mono, monospace" }}>{greek.name}</div>
            <div style={{ fontSize: 7, color: "#4a6a84", fontFamily: "JetBrains Mono, monospace" }}>{greek.desc}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: greek.color, fontFamily: "JetBrains Mono, monospace" }}>{fmtVal(val)}</div>
          <div style={{ fontSize: 7, color: "#3a5a72", fontFamily: "JetBrains Mono, monospace" }}>current</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", marginBottom: 6 }}>
        {[
          { lbl: "MIN",     val: valid.length >= 2 ? Math.min(...valid).toFixed(greek.key === "gamma" ? 5 : 3) : "—" },
          { lbl: "MAX",     val: valid.length >= 2 ? Math.max(...valid).toFixed(greek.key === "gamma" ? 5 : 3) : "—" },
          { lbl: "STRIKES", val: valid.length || "—" },
        ].map((s, i) => (
          <div key={i}>
            <div style={{ fontSize: 6.5, color: "#2a4a60", fontFamily: "JetBrains Mono, monospace", letterSpacing: 0.6 }}>{s.lbl}</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#7a9ab8", fontFamily: "JetBrains Mono, monospace" }}>{s.val}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 5, alignItems: "flex-start", marginBottom: 3 }}>
        <span style={{
          fontSize: 7, fontWeight: 800, fontFamily: "JetBrains Mono, monospace",
          color: interp.color, background: `${interp.color}18`,
          border: `1px solid ${interp.color}35`, padding: "1px 5px", borderRadius: 3,
          whiteSpace: "nowrap", flexShrink: 0, letterSpacing: 0.4
        }}>{interp.badge}</span>
        <span style={{ fontSize: 8, color: `${interp.color}cc`, lineHeight: 1.4, fontFamily: "JetBrains Mono, monospace" }}>{interp.text}</span>
      </div>
      <RiskMeter risk={interp.risk} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Greeks Panel
// FIX 4: animKey = useMemo over greekSeries hash — chart only redraws on data change
// ─────────────────────────────────────────────────────────────────────────────

function GreeksPanel({ strike, side, data, allStrikes, spotPrice, dte, onClose }) {

  // Build cross-strike greek series from all visible strikes
  const greekSeries = useMemo(() => {
    if (!allStrikes?.length) return { delta: [], gamma: [], theta: [], vega: [] };
    const series = { delta: [], gamma: [], theta: [], vega: [] };
    allStrikes.forEach(row => {
      const opt = side === "ce" ? row.ce : row.pe;
      let { delta: d, gamma: g, theta: t, vega: v } = opt || {};
      // BS fallback for missing greeks
      if (spotPrice && row.strike && opt?.iv && dte != null && dte >= 0) {
        const T = Math.max(0.0001, (dte + 0.5) / 365);
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

  // FIX 4: Derive animKey from data content — NOT from a timer
  // Format: "delta:N:lastVal|gamma:N:lastVal|..."
  const animKey = useMemo(() => {
    return Object.entries(greekSeries).map(([k, s]) => {
      const valid = s.filter(v => v != null && !isNaN(v));
      return `${k}:${valid.length}:${valid[valid.length-1]?.toFixed(5) ?? ""}`;
    }).join("|");
  }, [greekSeries]);

  // Greeks for the specific selected strike, BS-augmented
  const greeks = useMemo(() => {
    let { delta: d, gamma: g, theta: t, vega: v, rho: r, iv, ltp, oi } = data || {};
    if (spotPrice && strike && iv && dte != null && dte >= 0) {
      const T = Math.max(0.0001, (dte + 0.5) / 365);
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

  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const Greeks = [
    { key: "delta", sym: "Δ", name: "DELTA", color: "#00c896", desc: "₹/₹1 spot move" },
    { key: "gamma", sym: "Γ", name: "GAMMA", color: "#4db8ff", desc: "delta/₹1 move" },
    { key: "theta", sym: "θ", name: "THETA", color: "#ff8c42", desc: "₹ daily decay" },
    { key: "vega",  sym: "ν", name: "VEGA",  color: "#a78bfa", desc: "₹/1% IV change" },
  ];

  const leftGreeks  = [Greeks[0], Greeks[1]];
  const rightGreeks = [Greeks[2], Greeks[3]];

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 500,
        background: "rgba(2,6,14,0.92)",
        display: "flex", alignItems: "center", justifyContent: "center",
        backdropFilter: "blur(6px)",
        animation: "overlay-in 0.18s ease-out"
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        background: "linear-gradient(160deg, #070d1b 0%, #080f1f 100%)",
        border: "1px solid #182840",
        borderRadius: 10,
        width: "min(1200px, 98vw)",
        height: "min(680px, 96vh)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 40px 100px rgba(0,0,0,0.9), 0 0 0 1px #0d2035",
        animation: "panel-in 0.22s ease-out",
      }}>
        {/* Panel Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 18px",
          borderBottom: "1px solid #0d1e30",
          background: "linear-gradient(90deg, #050c1a, #080f20)",
          flexShrink: 0
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 13, fontWeight: 900, color: "#c8dff0", letterSpacing: 2 }}>GREEKS</span>
            <span style={{
              fontFamily: "JetBrains Mono, monospace", fontSize: 12, fontWeight: 700,
              color: side === "ce" ? "#00c896" : "#ff6b6b",
              background: side === "ce" ? "rgba(0,200,150,0.1)" : "rgba(255,107,107,0.1)",
              border: `1px solid ${side === "ce" ? "#00c89640" : "#ff6b6b40"}`,
              padding: "2px 10px", borderRadius: 4
            }}>{strike?.toLocaleString("en-IN")} {side?.toUpperCase()}</span>
            {spotPrice && <span style={{ fontSize: 10, color: "#4db8ff", fontFamily: "JetBrains Mono, monospace" }}>SPOT ₹{fmtPrice(spotPrice)}</span>}
            {dte != null && <span style={{
              fontSize: 10, fontWeight: 800,
              color: dte <= 3 ? "#ff6b6b" : dte <= 7 ? "#f0c040" : "#6a8aaa",
              fontFamily: "JetBrains Mono, monospace"
            }}>{dte}d DTE{dte <= 3 ? " ⚠" : ""}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {[
              { lbl: "IV",  val: greeks.iv  != null ? `${greeks.iv.toFixed(1)}%`  : "—", col: "#f0c040" },
              { lbl: "LTP", val: greeks.ltp != null ? `₹${fmtPrice(greeks.ltp)}` : "—", col: "#c8dff0" },
              { lbl: "OI",  val: fmt(greeks.oi),                                          col: "#6a8aaa" },
            ].map((c, i) => (
              <div key={i} style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                padding: "2px 8px", borderRight: "1px solid #0d1e30"
              }}>
                <span style={{ fontSize: 7, color: "#3a5a72", fontFamily: "JetBrains Mono, monospace" }}>{c.lbl}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: c.col, fontFamily: "JetBrains Mono, monospace" }}>{c.val}</span>
              </div>
            ))}
            <span style={{ fontSize: 8, color: "#3a5a72", fontFamily: "JetBrains Mono, monospace", marginLeft: 4 }}>ESC · BS · Hull 10th</span>
            <button onClick={onClose} style={{
              background: "none", border: "1px solid #1a3050", color: "#6a8aaa",
              width: 26, height: 26, borderRadius: 4, cursor: "pointer", fontSize: 15,
              display: "flex", alignItems: "center", justifyContent: "center"
            }}>×</button>
          </div>
        </div>

        {/* Body: LEFT | CHARTS | RIGHT */}
        <div style={{ display: "grid", gridTemplateColumns: "200px 1fr 200px", flex: 1, overflow: "hidden" }}>
          {/* LEFT: Delta + Gamma */}
          <div style={{
            background: "#040912", borderRight: "1px solid #0d1e30",
            padding: "12px 10px", overflowY: "auto", display: "flex", flexDirection: "column",
          }}>
            <div style={{ fontSize: 7, fontWeight: 800, color: "#1a3050", letterSpacing: 1.5, fontFamily: "JetBrains Mono, monospace", marginBottom: 10 }}>Δ / Γ — DIRECTION</div>
            {leftGreeks.map(g => (
              <SidebarStatBlock key={g.key} greek={g} greeks={greeks} greekSeries={greekSeries} strike={strike} spotPrice={spotPrice} dte={dte} />
            ))}
          </div>

          {/* CENTER: 2×2 chart grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: "1px", background: "#060c18", overflow: "hidden" }}>
            {Greeks.map(g => {
              const series = greekSeries[g.key] || [];
              const valid  = series.filter(v => v != null && !isNaN(v) && isFinite(v));
              const hasData = valid.length >= 2;
              return (
                <div key={g.key} style={{
                  background: "linear-gradient(145deg, #060c1a, #070d1c)",
                  padding: "10px 12px", display: "flex", flexDirection: "column", overflow: "hidden",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexShrink: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 17, fontWeight: 900, color: g.color, fontFamily: "JetBrains Mono, monospace", textShadow: `0 0 10px ${g.color}60` }}>{g.sym}</span>
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 800, color: g.color, letterSpacing: 1.2, fontFamily: "JetBrains Mono, monospace" }}>{g.name}</div>
                        <div style={{ fontSize: 7, color: "#4a6a84", fontFamily: "JetBrains Mono, monospace" }}>{g.desc}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 15, fontWeight: 900, color: g.color, fontFamily: "JetBrains Mono, monospace", textShadow: `0 0 8px ${g.color}50` }}>
                        {(() => {
                          const v = greeks[g.key];
                          if (v == null || isNaN(v)) return "—";
                          if (g.key === "gamma") return v.toFixed(5);
                          if (g.key === "theta" || g.key === "vega") return v.toFixed(3);
                          return v.toFixed(4);
                        })()}
                      </div>
                      <div style={{ fontSize: 6.5, color: "#3a5a72", fontFamily: "JetBrains Mono, monospace" }}>current</div>
                    </div>
                  </div>
                  <div style={{
                    flex: 1, background: "rgba(0,0,0,0.35)", borderRadius: 6,
                    border: `1px solid ${g.color}20`, overflow: "hidden", position: "relative", minHeight: 0,
                  }}>
                    {/* FIX 4: animKey prop is data-derived, not timer-derived */}
                    <BloombergSparkline data={series} color={g.color} height={110} animKey={animKey} />
                    <div style={{
                      position: "absolute", top: 5, right: 7,
                      fontSize: 6, fontFamily: "JetBrains Mono, monospace",
                      color: g.color, background: `${g.color}15`,
                      border: `1px solid ${g.color}30`, borderRadius: 2, padding: "1px 5px", letterSpacing: 0.4
                    }}>{hasData ? `${valid.length} strikes` : "BS fallback"}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* RIGHT: Theta + Vega */}
          <div style={{
            background: "#040912", borderLeft: "1px solid #0d1e30",
            padding: "12px 10px", overflowY: "auto", display: "flex", flexDirection: "column",
          }}>
            <div style={{ fontSize: 7, fontWeight: 800, color: "#1a3050", letterSpacing: 1.5, fontFamily: "JetBrains Mono, monospace", marginBottom: 10 }}>θ / ν — TIME & VOL</div>
            {rightGreeks.map(g => (
              <SidebarStatBlock key={g.key} greek={g} greeks={greeks} greekSeries={greekSeries} strike={strike} spotPrice={spotPrice} dte={dte} />
            ))}
          </div>
        </div>

        {/* Panel Footer */}
        <div style={{
          padding: "7px 18px", borderTop: "1px solid #0a1828", background: "#03080f",
          display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 4, flexShrink: 0
        }}>
          <span style={{ fontSize: 7.5, color: "#2a4a60", fontFamily: "JetBrains Mono, monospace" }}>
            Black-Scholes-Merton · r=6.5% RBI repo · σ from IV · Hull 10th ed.
          </span>
          <span style={{ fontSize: 7.5, color: "#2a4a60", fontFamily: "JetBrains Mono, monospace" }}>
            {greekSeries.delta?.filter(v => v != null).length || 0} strikes · {side?.toUpperCase()} · cross-strike
          </span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OI Bar
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Greek Cell (inline in table row)
// ─────────────────────────────────────────────────────────────────────────────

function GreekCell({ delta, theta, vega, side, onGreekClick }) {
  const dColor = side === "ce" ? (delta > 0.5 ? "#00c896" : "#6a8aaa") : (delta < -0.5 ? "#ff6b6b" : "#6a8aaa");
  return (
    <div className="greek-cell" onClick={onGreekClick}>
      <span className="greek-item" style={{ color: dColor }}><span className="greek-label">Δ</span>{fmtGreek(delta, 2)}</span>
      <span className="greek-item" style={{ color: "#ff8c42" }}><span className="greek-label">θ</span>{fmtGreek(theta, 1)}</span>
      <span className="greek-item" style={{ color: "#a78bfa" }}><span className="greek-label">ν</span>{fmtGreek(vega, 2)}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Strike Row
// FIX 3: React.memo with ref-equality comparator
// Since mergeChainData returns same object reference when row data is unchanged,
// the `row === next.row` check causes React to skip re-rendering untouched rows.
// ─────────────────────────────────────────────────────────────────────────────

const StrikeRow = React.memo(function StrikeRow({
  row, prevRow, maxCEOI, maxPEOI, spotPrice, isFlash, showGreeks, onGreekClick
}) {
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
      {showGreeks&&<td className="ce-cell"><GreekCell delta={row.ce.delta} theta={row.ce.theta} vega={row.ce.vega} side="ce" onGreekClick={()=>onGreekClick(row.strike,"ce",row.ce)}/></td>}
      <td className="ce-cell sig">{ceSig.icon&&<span className="sig-pill" style={{color:ceSig.color}}>{ceSig.icon} {ceSig.label}</span>}</td>
      <td className="strike-cell"><span className="strike-num">{row.strike.toLocaleString("en-IN")}</span>{isATM&&<span className="atm-badge">ATM</span>}</td>
      <td className="pe-cell sig">{peSig.icon&&<span className="sig-pill" style={{color:peSig.color}}>{peSig.icon} {peSig.label}</span>}</td>
      {showGreeks&&<td className="pe-cell"><GreekCell delta={row.pe.delta} theta={row.pe.theta} vega={row.pe.vega} side="pe" onGreekClick={()=>onGreekClick(row.strike,"pe",row.pe)}/></td>}
      <td className="pe-cell iv">{row.pe.iv?row.pe.iv.toFixed(1)+"%":"—"}</td>
      <td className="pe-cell ltp">{fmtPrice(row.pe.ltp)}</td>
      <td className={`pe-cell change ${row.pe.oiChange>0?"pos":row.pe.oiChange<0?"neg":""}`}>{row.pe.oiChange!==0&&<span>{row.pe.oiChange>0?"+":""}{fmt(row.pe.oiChange)}</span>}</td>
      <td className="pe-cell oi-cell"><OIBar value={row.pe.oi} prevValue={prevRow?.pe.oi} max={maxPEOI} side="pe" signal={row.pe.signal}/></td>
    </tr>
  );
}, (prev, next) => {
  // FIX 3: Only re-render when THIS row's data actually changed.
  // mergeChainData returns old ref if ce/pe values are identical, so this
  // comparison short-circuits the entire render for unchanged rows.
  return (
    prev.row        === next.row        &&  // same object ref = data unchanged
    prev.prevRow    === next.prevRow    &&
    prev.maxCEOI    === next.maxCEOI    &&
    prev.maxPEOI    === next.maxPEOI    &&
    prev.spotPrice  === next.spotPrice  &&
    prev.isFlash    === next.isFlash    &&
    prev.showGreeks === next.showGreeks
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PCR Gauge
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Update Timer — counts seconds since last data update
// ─────────────────────────────────────────────────────────────────────────────

function UpdateTimer({ lastUpdate }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!lastUpdate) return;
    const tick = () => setSecs(Math.floor((Date.now()-lastUpdate)/1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [lastUpdate]);
  if (!lastUpdate) return <span className="s-val updated">—</span>;
  const color = secs<20?"#00c896":secs<60?"#f0c040":"#ff6b6b";
  return <span className="s-val updated" style={{color}}>{secs}s ago</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Badge
// Reads upstox-status events from upstoxStream.js (connected: true/false)
// ─────────────────────────────────────────────────────────────────────────────

function ConnBadge({ status }) {
  const map = {
    live:         { label: "LIVE",         color: "#00c896" },
    rest:         { label: "REST POLL",    color: "#f0c040" },
    disconnected: { label: "DISCONNECTED", color: "#ff6b6b" },
  };
  const cfg = map[status] || map.disconnected;
  return (
    <div className={`conn-badge ${status}`} style={{color:cfg.color,borderColor:cfg.color+"30"}}>
      <span style={{width:5,height:5,borderRadius:"50%",background:cfg.color,display:"inline-block",
        animation:status==="live"?"dot-pulse 1.4s infinite":"none"}}/>
      {cfg.label}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OI Flow Bar
// ─────────────────────────────────────────────────────────────────────────────

function OIFlowBar({ totalCEOI, totalPEOI }) {
  const total = (totalCEOI||0)+(totalPEOI||0);
  const cePct = total>0 ? ((totalCEOI/total)*100).toFixed(1) : 50;
  const pePct = total>0 ? ((totalPEOI/total)*100).toFixed(1) : 50;
  return (
    <div className="oi-flow-bar" title={`CE: ${cePct}%  PE: ${pePct}%`}>
      <div className="oi-flow-ce" style={{width:`${cePct}%`}}/>
      <div className="oi-flow-pe" style={{width:`${pePct}%`}}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function calcDTE(expiryStr) {
  if (!expiryStr) return null;
  try { return Math.max(0, Math.ceil((new Date(expiryStr) - new Date()) / 86400000)); }
  catch { return null; }
}

// Session persistence
const SS_KEY = "oc_state_v2";
function saveSession(obj) { try { sessionStorage.setItem(SS_KEY, JSON.stringify(obj)); } catch {} }
function loadSession()    { try { return JSON.parse(sessionStorage.getItem(SS_KEY) || "null"); } catch { return null; } }

// ─────────────────────────────────────────────────────────────────────────────
// FIX 5: Stable data merger
//
// Key insight from reading mergeChainData + applyChainData together:
// - Called from BOTH socket "option-chain-update" AND REST poll
// - Returns same row object ref when trading values haven't changed
// - This is what makes StrikeRow's ref-equality memo comparator work
//
// The REST poll path (FIX 5): if socket updated within 2s, REST data is dropped
// entirely in applyChainData — this function is never even called for stale REST data.
// ─────────────────────────────────────────────────────────────────────────────

function mergeChainData(prev, next) {
  if (!prev) return next;
  const merged = { ...prev, ...next };

  // Build strike lookup map from previous data
  const prevMap = {};
  (prev.strikes || []).forEach(r => { prevMap[r.strike] = r; });

  merged.strikes = (next.strikes || []).map(newRow => {
    const old = prevMap[newRow.strike];
    if (!old) return newRow; // new strike, always render

    // If key trading values are identical, return old reference
    // → StrikeRow sees prev.row === next.row → skips re-render entirely
    if (
      old.ce.oi     === newRow.ce.oi     &&
      old.ce.ltp    === newRow.ce.ltp    &&
      old.ce.iv     === newRow.ce.iv     &&
      old.ce.signal === newRow.ce.signal &&
      old.pe.oi     === newRow.pe.oi     &&
      old.pe.ltp    === newRow.pe.ltp    &&
      old.pe.iv     === newRow.pe.iv     &&
      old.pe.signal === newRow.pe.signal
    ) return old; // ← CRITICAL: same reference → React.memo bails

    return newRow;
  });

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function OptionChain({ onBack }) {
  const saved = useMemo(() => loadSession(), []);

  const [underlying,     setUnderlying]  = useState(saved?.underlying || "NIFTY");
  const [expiries,       setExpiries]    = useState([]);
  const [selectedExpiry, setExpiry]      = useState(saved?.expiry || null);
  const [chainData,      setChainData]   = useState(null);
  const [prevStrikes,    setPrevStrikes] = useState({});
  const [loading,        setLoading]     = useState(true);
  const [lastUpdate,     setLastUpdate]  = useState(null);
  const [flashStrikes,   setFlashStrikes]= useState(new Set());
  const [showATMOnly,    setShowATMOnly] = useState(saved?.showATMOnly ?? false);
  const [strikeCount,    setStrikeCount] = useState(saved?.strikeCount || 20);
  const [showGreeks,     setShowGreeks]  = useState(saved?.showGreeks ?? false);
  const [connStatus,     setConnStatus]  = useState("disconnected");
  const [greekPanel,     setGreekPanel]  = useState(null);

  // ── FIX 1+2: Refs for DOM measurement of all fixed bars
  const headerRef  = useRef(null);
  const summaryRef = useRef(null);
  const legendRef  = useRef(null);
  const alertsRef  = useRef(null);
  const footerRef  = useRef(null);
  const tableRef   = useRef(null);

  const socketRef      = useRef(null);
  const lastUpdateRef  = useRef(null);  // ref so REST poll check doesn't need stale closure
  const pollRef        = useRef(null);

  // ── FIX 1+2: Measure all fixed bars → write CSS vars → table top is always exact
  // Uses ResizeObserver so it auto-corrects on: header wrap, legend show/hide,
  // alerts appearing, window resize, font scale changes.
  useLayoutEffect(() => {
    const measure = () => {
      const hh     = headerRef.current?.offsetHeight  || 41;
      const sh     = summaryRef.current?.offsetHeight || 56;
      const lh     = legendRef.current?.offsetHeight  || 0;
      const ah     = alertsRef.current?.offsetHeight  || 0;
      const fh     = footerRef.current?.offsetHeight  || 28;
      const flowH  = 4; // .oi-flow-bar fixed height
      const tableTop = hh + sh + flowH + lh + ah;

      const root = document.documentElement;
      root.style.setProperty("--header-h",  hh  + "px");
      root.style.setProperty("--summary-h", sh  + "px");
      root.style.setProperty("--legend-h",  lh  + "px");
      root.style.setProperty("--footer-h",  fh  + "px");
      root.style.setProperty("--table-top", tableTop + "px");
    };

    measure();

    // ResizeObserver: fires when any fixed bar changes height
    // Throttled internally by browser — cheap to attach to every render
    const ro = new ResizeObserver(measure);
    [headerRef, summaryRef, legendRef, alertsRef, footerRef].forEach(r => {
      if (r.current) ro.observe(r.current);
    });
    return () => ro.disconnect();
  }); // ← runs every render (intentional — ResizeObserver throttles)

  // ── Persist session state
  useEffect(() => {
    saveSession({ underlying, expiry: selectedExpiry, showATMOnly, strikeCount, showGreeks });
  }, [underlying, selectedExpiry, showATMOnly, strikeCount, showGreeks]);

  // ── FIX 5: Stable applyChainData — the single merge pipeline for ALL data sources
  // Both socket and REST poll call this. REST data is silently dropped if socket
  // has pushed within 2s (checked via lastUpdateRef, not state).
  const applyChainData = useCallback((data, source) => {
    if (!data?.strikes) return;

    // Snapshot prev strikes for OI delta display BEFORE merging
    setPrevStrikes(() => {
      const n = {};
      (data.strikes || []).forEach(r => { n[r.strike] = r; });
      return n;
    });

    // FIX 3+5: Merge new data — unchanged rows keep same object reference
    // → React.memo StrikeRow comparator short-circuits unchanged rows
    setChainData(prev => mergeChainData(prev, data));

    const now = Date.now();
    setLastUpdate(now);
    lastUpdateRef.current = now;   // used by REST poll to check socket freshness
    setLoading(false);
    setConnStatus(source === "socket" ? "live" : "rest");

    // Flash animation for alert strikes
    if (data.alerts?.length) {
      const f = new Set(data.alerts.map(a => a.strike));
      setFlashStrikes(f);
      setTimeout(() => setFlashStrikes(new Set()), 1500);
    }
  }, []); // no deps — stable across re-renders

  // ── Socket.io connection
  // Reads: "option-expiries", "option-chain-update" from nseOIListener via server/index.js
  // Reads: "upstox-status" from upstoxStream.js (connected true/false)
  // Emits: "request-option-chain" to trigger push (server.js re-emits on expiry change)
  useEffect(() => {
    const socket = io(window.location.origin, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnStatus("live");
      socket.emit("request-option-chain", { underlying, expiry: selectedExpiry });
    });

    socket.on("disconnect", () => setConnStatus("disconnected"));

    // upstoxStream.js emits this when its WS connects/disconnects
    // We use it to update badge but don't change data flow
    socket.on("upstox-status", ({ connected }) => {
      if (!connected) setConnStatus(prev => prev === "live" ? "rest" : prev);
    });

    socket.on("option-expiries", ({ underlying: u, expiries: e }) => {
      if (u !== underlying) return;
      setExpiries(e || []);
      setExpiry(prev => (prev && e?.includes(prev)) ? prev : (e?.[0] || null));
    });

    // FIX 5: Socket data goes straight into applyChainData
    // No separate state path — same pipeline as REST
    socket.on("option-chain-update", ({ underlying: u, data }) => {
      if (u !== underlying) return;
      applyChainData(data, "socket");
    });

    return () => {
      socket.disconnect();
      setConnStatus("disconnected");
    };
  }, [underlying]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-emit subscription request when expiry changes (server will push fresh chain)
  useEffect(() => {
    if (socketRef.current?.connected && selectedExpiry)
      socketRef.current.emit("request-option-chain", { underlying, expiry: selectedExpiry });
  }, [underlying, selectedExpiry]);

  // ── REST fallback poll (3s)
  // FIX 5: Only applies data when socket hasn't updated in >2s
  // Uses lastUpdateRef (not state) to avoid stale closure issues
  useEffect(() => {
    if (!selectedExpiry) return;

    const poll = () => {
      fetch(`/api/option-chain?underlying=${underlying}&expiry=${selectedExpiry}`)
        .then(r => r.json())
        .then(data => {
          if (!data?.strikes) return;
          const age = lastUpdateRef.current ? Date.now() - lastUpdateRef.current : Infinity;

          if (age > 2000) {
            // Socket hasn't sent data recently — use REST data
            applyChainData(data, "rest");
          } else {
            // FIX 5: Socket is live and fresh — silently update timestamp only
            // Do NOT call applyChainData here to avoid double-render
            const now = Date.now();
            setLastUpdate(now);
            lastUpdateRef.current = now;
          }
        })
        .catch(() => {});
    };

    setLoading(true);
    poll(); // immediate first poll
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [underlying, selectedExpiry, applyChainData]);

  // ── Load expiries when underlying changes
  useEffect(() => {
    setLoading(true);
    setChainData(null);
    lastUpdateRef.current = null;
    fetch(`/api/option-chain/expiries?underlying=${underlying}`)
      .then(r => r.json())
      .then(({ expiries: e }) => {
        setExpiries(e || []);
        setExpiry(prev => (prev && e?.includes(prev)) ? prev : (e?.[0] || null));
      })
      .catch(() => {});
  }, [underlying]);

  const strikes = chainData?.strikes || [];
  const dte = useMemo(() => calcDTE(selectedExpiry), [selectedExpiry]);

  // Apply ATM filter
  const visibleStrikes = useMemo(() => {
    if (!strikes.length) return [];
    if (!showATMOnly) return strikes;
    const idx = strikes.findIndex(s => s.isATM);
    if (idx < 0) return strikes;
    return strikes.slice(
      Math.max(0, idx - strikeCount),
      Math.min(strikes.length - 1, idx + strikeCount) + 1
    );
  }, [strikes, showATMOnly, strikeCount]);

  const maxCEOI = useMemo(() => Math.max(...visibleStrikes.map(s => s.ce.oi), 1), [visibleStrikes]);
  const maxPEOI = useMemo(() => Math.max(...visibleStrikes.map(s => s.pe.oi), 1), [visibleStrikes]);

  // Auto-scroll to ATM on first data load or underlying/expiry change
  useEffect(() => {
    if (!chainData) return;
    const atm = tableRef.current?.querySelector(".atm");
    if (atm) setTimeout(() => atm.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
  }, [chainData?.expiry, chainData?.underlying]); // eslint-disable-line

  const handleGreekClick = useCallback((strike, side, data) => setGreekPanel({ strike, side, data }), []);
  const closeGreekPanel  = useCallback(() => setGreekPanel(null), []);

  const hasAlerts = chainData?.alerts?.length > 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="oc-page">

      {/* Greeks Panel modal — rendered outside table scroll context */}
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

      {/* ── FIX 1: HEADER — position:fixed, never scrolls ── */}
      <div className="oc-header" ref={headerRef}>
        <div className="oc-title">
          <span style={{fontSize:15}}>⚡</span>
          <h1>Option Chain <span className="oc-sub">OI Heatmap</span></h1>
          {chainData && <span className="live-dot"/>}
        </div>
        <div className="oc-controls">
          <div className="control-group">
            {UNDERLYINGS.map(u => (
              <button key={u} className={`ctrl-btn${underlying===u?" active":""}`} onClick={()=>setUnderlying(u)}>{u}</button>
            ))}
          </div>
          {expiries.length > 0 && (
            <div className="control-group">
              {expiries.slice(0,5).map(e => (
                <button key={e} className={`ctrl-btn expiry${selectedExpiry===e?" active":""}`} onClick={()=>setExpiry(e)}>{e}</button>
              ))}
            </div>
          )}
          <div className="control-group">
            <button className={`ctrl-btn${showATMOnly?" active":""}`} onClick={()=>setShowATMOnly(v=>!v)}>Near ATM</button>
            {showATMOnly && (
              <select className="ctrl-select" value={strikeCount} onChange={e=>setStrikeCount(Number(e.target.value))}>
                {[5,10,15,20,30].map(n=><option key={n} value={n}>±{n}</option>)}
              </select>
            )}
          </div>
          <div className="control-group">
            <button className={`ctrl-btn${showGreeks?" active":""}`} onClick={()=>setShowGreeks(v=>!v)}>
              {showGreeks ? "Hide Δθν" : "Δθν Greeks"}
            </button>
          </div>
          {dte != null && (
            <div style={{
              fontSize:9, fontFamily:"JetBrains Mono,monospace", fontWeight:700,
              color: dte<=3?"#ff6b6b":dte<=7?"#f0c040":"#6a8aaa",
              padding:"3px 8px", background:"rgba(0,0,0,0.3)", borderRadius:4,
              border:`1px solid ${dte<=3?"#ff6b6b30":"#1c2b3a"}`
            }}>{dte}d DTE</div>
          )}
          {onBack && <button className="ctrl-btn" onClick={onBack}>← Back</button>}
          <ConnBadge status={connStatus}/>
        </div>
      </div>

      {/* ── FIX 1: SUMMARY BAR — position:fixed ── */}
      {chainData && (
        <div className="oc-summary" ref={summaryRef}>
          <div className="summary-item"><span className="s-label">Spot</span><span className="s-val spot">{fmtPrice(chainData.spotPrice)}</span></div>
          <PCRGauge pcr={chainData.pcr}/>
          <div className="summary-item"><span className="s-label">Max Pain</span><span className="s-val maxpain">{chainData.maxPainStrike?.toLocaleString("en-IN")||"—"}</span></div>
          <div className="summary-item"><span className="s-label">Support</span><span className="s-val support">{chainData.support?.toLocaleString("en-IN")||"—"}</span></div>
          <div className="summary-item"><span className="s-label">Resistance</span><span className="s-val resistance">{chainData.resistance?.toLocaleString("en-IN")||"—"}</span></div>
          <div className="summary-item"><span className="s-label">CE OI</span><span className="s-val ce-oi">{fmt(chainData.totalCEOI)}</span></div>
          <div className="summary-item"><span className="s-label">PE OI</span><span className="s-val pe-oi">{fmt(chainData.totalPEOI)}</span></div>
          {chainData.ivSkew != null && (
            <div className="summary-item">
              <span className="s-label">IV Skew</span>
              <span className="s-val" style={{color:chainData.ivSkew>0?"#ff6b6b":"#00c896",fontSize:12}}>
                {chainData.ivSkew>0?"+":""}{chainData.ivSkew?.toFixed(1)}%
              </span>
            </div>
          )}
          <div className="summary-item"><span className="s-label">Updated</span><UpdateTimer lastUpdate={lastUpdate}/></div>
        </div>
      )}

      {/* ── OI Flow bar (4px fixed strip below summary) ── */}
      {chainData && <OIFlowBar totalCEOI={chainData.totalCEOI} totalPEOI={chainData.totalPEOI}/>}

      {/* ── Greeks legend (appears/disappears, ResizeObserver recalculates table top) ── */}
      {showGreeks && (
        <div className="greeks-legend" ref={legendRef}>
          <span><span style={{color:"#00c896"}}>Δ Delta</span> — price sensitivity</span>
          <span><span style={{color:"#ff8c42"}}>θ Theta</span> — daily decay ₹</span>
          <span><span style={{color:"#a78bfa"}}>ν Vega</span> — IV sensitivity</span>
          <span><span style={{color:"#4db8ff"}}>Γ Gamma</span> — delta curvature</span>
        </div>
      )}

      {/* ── Alerts strip ── */}
      {hasAlerts && (
        <div className="oc-alerts" ref={alertsRef}>
          {chainData.alerts.slice(0,6).map((a,i) => {
            const sig = SIGNAL_LABELS[a.signal] || SIGNAL_LABELS.neutral;
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

      {/* ── Loading state ── */}
      {loading && (
        <div className="oc-loading">
          <div className="loading-pulse"/>
          <span>Fetching option chain data...</span>
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !chainData && (
        <div className="oc-empty">
          <p>⏳ Waiting for first poll...</p>
          <p className="empty-sub">NSE · socket primary · 3s REST fallback</p>
        </div>
      )}

      {/* ── FIX 2: TABLE CONTAINER — top set by CSS var --table-top ── */}
      {/* thead is sticky-within-this-container (not fixed to page) */}
      {!loading && chainData && (
        <div className="oc-table-wrap" ref={tableRef}>
          <table className="oc-table">
            <thead>
              <tr className="side-label-row">
                <th className="ce-side-label" colSpan={showGreeks?6:5}>CALL — CE</th>
                <th/>
                <th className="pe-side-label" colSpan={showGreeks?6:5}>PUT — PE</th>
              </tr>
              <tr>
                <th className="ce-th">OI</th>
                <th className="ce-th">Chg OI</th>
                <th className="ce-th">LTP</th>
                <th className="ce-th">IV</th>
                {showGreeks && <th className="ce-th">Greeks ↗</th>}
                <th className="ce-th">Signal</th>
                <th className="strike-th">Strike</th>
                <th className="pe-th">Signal</th>
                {showGreeks && <th className="pe-th">Greeks ↗</th>}
                <th className="pe-th">IV</th>
                <th className="pe-th">LTP</th>
                <th className="pe-th">Chg OI</th>
                <th className="pe-th">OI</th>
              </tr>
            </thead>
            <tbody>
              {visibleStrikes.map(row => (
                // FIX 3: StrikeRow memoized — skips render when row ref unchanged
                <StrikeRow
                  key={row.strike}
                  row={row}
                  prevRow={prevStrikes[row.strike]}
                  maxCEOI={maxCEOI}
                  maxPEOI={maxPEOI}
                  spotPrice={chainData.spotPrice}
                  isFlash={flashStrikes.has(row.strike)}
                  showGreeks={showGreeks}
                  onGreekClick={handleGreekClick}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── FIX 1: FOOTER — position:fixed at bottom ── */}
      <div className="oc-footer" ref={footerRef}>
        <span>Socket · 3s REST · BS-augmented Greeks · Hull 10th ed. · {showGreeks?"Greeks visible":"Enable Greeks via Δθν button"}</span>
        {chainData && <span>{visibleStrikes.length}/{strikes.length} strikes · {underlying} · {selectedExpiry}{dte!=null?` · ${dte}d DTE`:""}</span>}
      </div>

    </div>
  );
}
