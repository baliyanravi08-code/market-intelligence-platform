/**
 * OptionChain.jsx — FIXED
 *
 * FIX A: StrikeRow — oiChange column was calling fmt() which strips sign and
 *         formats as "2.7L" without the minus. Changed to fmtDelta() which
 *         preserves sign and formats correctly: "-2.7L", "+1.3L".
 *         ALSO: the raw number -2,68,775 was appearing because oiChange was
 *         coming from the server as the raw integer — fmtDelta handles it.
 *
 * FIX B: GreeksPanel center grid — restructured from:
 *           LEFT sidebar (Δ+Γ stats) | CENTER 2×2 charts | RIGHT sidebar (θ+ν stats)
 *         to:
 *           2×2 grid where EACH cell = [mini value card on left] + [chart on right]
 *         The value card is pinned beside its own chart's Y-axis so the number
 *         and the curve are always visually adjacent.
 *         Chart size is unchanged. All 4 charts still visible simultaneously.
 *         SidebarStatBlock is kept but moved inside each chart cell.
 *
 * FIX C: OptionChain.css header overflow — header uses flex-wrap:wrap which
 *         causes controls to disappear on zoom. Changed to overflow-x:auto +
 *         flex-wrap:nowrap + min-width guards so all controls scroll instead
 *         of wrapping/clipping.
 *
 * Everything else (FIX 1-7, portal, ResizeObserver, mergeChainData, etc.)
 * is UNCHANGED from the original.
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect
} from "react";
import ReactDOM from "react-dom";
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

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n) {
  if (!n && n !== 0) return "—";
  if (n >= 10000000) return (n / 10000000).toFixed(1) + "Cr";
  if (n >= 100000)   return (n / 100000).toFixed(1) + "L";
  if (n >= 1000)     return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString("en-IN");
}

// FIX A: fmtDelta correctly formats signed OI changes e.g. "-2.7L", "+1.3L"
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

// ─── Black-Scholes Greeks (Hull 10th ed.) ─────────────────────────────────────

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

// ─── Greek Interpretation ─────────────────────────────────────────────────────

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

// ─── Risk Meter ───────────────────────────────────────────────────────────────

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

// ─── Bloomberg Sparkline ──────────────────────────────────────────────────────

function BloombergSparkline({ data, color, height = 110, animKey }) {
  const pathRef = useRef(null);
  const W = 260;
  const pad = { t: 14, r: 44, b: 18, l: 38 };
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
    const yTicks = [0, 0.5, 1].map(t => ({ y: pad.t + (1-t) * IH, val: yMin + t * yRange }));
    return { pts, pathD, areaD, yTicks, last: pts[pts.length-1], lastVal: validData[validData.length-1], min, max };
  }, [validData, IW, IH]);

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
  }, [animKey]);

  const uid = useMemo(() => `c${Math.random().toString(36).slice(2,8)}`, []);

  const fmtTick = v => {
    const a = Math.abs(v);
    if (a >= 10000)  return (v/1000).toFixed(0)+"K";
    if (a >= 1)      return v.toFixed(2);
    if (a >= 0.001)  return v.toFixed(4);
    return v.toFixed(5);
  };

  if (!computed) return (
    <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} style={{ display: "block" }}>
      <text x={W/2} y={height/2} textAnchor="middle" fill="#4a6a84" fontSize="9" fontFamily="JetBrains Mono, monospace">No cross-strike data</text>
    </svg>
  );

  const { pts, pathD, areaD, yTicks, last, lastVal } = computed;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} style={{ display: "block" }}>
      <defs>
        <linearGradient id={`g_${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <rect x={pad.l} y={pad.t} width={IW} height={IH} fill="none" stroke="#1e3045" strokeWidth="0.5" rx="2"/>
      {yTicks.map((tick, i) => (
        <g key={i}>
          <line x1={pad.l} y1={tick.y} x2={pad.l + IW} y2={tick.y}
            stroke={i === 1 ? "#243850" : "#162030"} strokeWidth={i === 1 ? 0.8 : 0.5} strokeDasharray={i === 1 ? "none" : "3,3"} />
          <text x={pad.l - 4} y={tick.y + 3.5} textAnchor="end"
            fill="#6a8aaa" fontSize="7" fontFamily="JetBrains Mono, monospace">{fmtTick(tick.val)}</text>
        </g>
      ))}
      {computed.min < 0 && computed.max > 0 && (() => {
        const range = computed.max - computed.min || 1;
        const padR2 = range * 0.18;
        const yR = (computed.max + padR2) - (computed.min - padR2);
        const zY = pad.t + IH - ((0 - (computed.min - range*0.18)) / yR) * IH;
        return <line x1={pad.l} y1={zY} x2={pad.l+IW} y2={zY}
          stroke={color} strokeWidth="0.8" strokeOpacity="0.3" strokeDasharray="4,3" />;
      })()}
      <path d={areaD} fill={`url(#g_${uid})`} />
      <path ref={pathRef} d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <line x1={last[0]} y1={pad.t} x2={last[0]} y2={pad.t + IH}
        stroke={color} strokeWidth="0.6" strokeOpacity="0.35" strokeDasharray="3,3" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill={color} />
      <rect x={last[0] + 5} y={last[1] - 9} width={38} height={16} rx="3"
        fill="#06101e" stroke={color} strokeWidth="0.7" strokeOpacity="0.6" />
      <text x={last[0] + 24} y={last[1] + 3} textAnchor="middle"
        fill={color} fontSize="7.5" fontWeight="800" fontFamily="JetBrains Mono, monospace">
        {fmtTick(lastVal)}
      </text>
    </svg>
  );
}

// ─── FIX B: Greek Chart Cell ───────────────────────────────────────────────────
// Replaces the old "LEFT sidebar | CENTER 2×2 | RIGHT sidebar" layout.
// Each Greek now has its own cell containing:
//   [value card + mini stats pinned to left] | [chart filling remaining width]
// This keeps the number right next to its curve on the Y-axis.

function GreekChartCell({ greek, greeks, greekSeries, strike, spotPrice, dte, animKey }) {
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
    <div style={{
      background: "linear-gradient(145deg, #060c1a, #070d1c)",
      display: "flex",
      flexDirection: "row",
      overflow: "hidden",
      minHeight: 0,
    }}>
      {/* ── Left: value card pinned beside the Y-axis ── */}
      <div style={{
        width: 88,
        flexShrink: 0,
        background: "#040912",
        borderRight: "1px solid #0d1e30",
        padding: "10px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        justifyContent: "flex-start",
      }}>
        {/* Greek symbol + name */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
          <span style={{
            fontSize: 17, fontWeight: 900, color: greek.color,
            fontFamily: "JetBrains Mono, monospace",
            textShadow: `0 0 8px ${greek.color}50`,
            lineHeight: 1,
          }}>{greek.sym}</span>
          <div>
            <div style={{ fontSize: 8, fontWeight: 800, color: greek.color, letterSpacing: 0.8, fontFamily: "JetBrains Mono, monospace" }}>{greek.name}</div>
            <div style={{ fontSize: 6.5, color: "#3a5a70", fontFamily: "JetBrains Mono, monospace", lineHeight: 1.2 }}>{greek.desc}</div>
          </div>
        </div>

        {/* Current value — the main number */}
        <div style={{
          background: "#070e1e",
          border: `1px solid ${greek.color}22`,
          borderRadius: 4,
          padding: "5px 6px",
        }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: greek.color, fontFamily: "JetBrains Mono, monospace", lineHeight: 1 }}>
            {fmtVal(val)}
          </div>
          <div style={{ fontSize: 6.5, color: "#2a4a60", fontFamily: "JetBrains Mono, monospace", marginTop: 2 }}>current</div>
        </div>

        {/* Min / Max / Strikes */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
          {[
            { lbl: "MIN", v: valid.length >= 2 ? Math.min(...valid).toFixed(greek.key === "gamma" ? 5 : 3) : "—" },
            { lbl: "MAX", v: valid.length >= 2 ? Math.max(...valid).toFixed(greek.key === "gamma" ? 5 : 3) : "—" },
            { lbl: "STR", v: valid.length || "—" },
          ].map((s, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 6.5, color: "#1e3a50", fontFamily: "JetBrains Mono, monospace", letterSpacing: 0.4 }}>{s.lbl}</span>
              <span style={{ fontSize: 8, fontWeight: 700, color: "#5a7a90", fontFamily: "JetBrains Mono, monospace" }}>{s.v}</span>
            </div>
          ))}
        </div>

        {/* Badge */}
        <span style={{
          fontSize: 7, fontWeight: 800, fontFamily: "JetBrains Mono, monospace",
          color: interp.color, background: `${interp.color}18`,
          border: `1px solid ${interp.color}35`, padding: "2px 4px", borderRadius: 3,
          letterSpacing: 0.3, whiteSpace: "nowrap", overflow: "hidden",
          textOverflow: "ellipsis", marginTop: 2,
        }}>{interp.badge}</span>

        {/* Risk meter */}
        <RiskMeter risk={interp.risk} />
      </div>

      {/* ── Right: chart fills remaining width ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "8px 8px 6px 6px", minWidth: 0, overflow: "hidden" }}>
        {/* Top row: label + strikes badge */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexShrink: 0 }}>
          <span style={{ fontSize: 7.5, color: "#3a5a70", fontFamily: "JetBrains Mono, monospace" }}>{greek.desc}</span>
          <span style={{
            fontSize: 6.5, color: greek.color,
            background: `${greek.color}15`, border: `1px solid ${greek.color}30`,
            borderRadius: 2, padding: "1px 4px", letterSpacing: 0.3,
            fontFamily: "JetBrains Mono, monospace",
          }}>{valid.length > 0 ? `${valid.length} strikes` : "BS fallback"}</span>
        </div>

        {/* Chart */}
        <div style={{
          flex: 1, background: "rgba(0,0,0,0.3)", borderRadius: 4,
          border: `1px solid ${greek.color}18`, overflow: "hidden", minHeight: 0,
        }}>
          <BloombergSparkline data={series} color={greek.color} height={108} animKey={animKey} />
        </div>

        {/* Insight text — right below the chart, beside the X-axis */}
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 4, marginTop: 4, flexShrink: 0,
        }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: interp.color, flexShrink: 0, marginTop: 3 }} />
          <span style={{ fontSize: 7.5, color: `${interp.color}bb`, lineHeight: 1.35, fontFamily: "JetBrains Mono, monospace" }}>
            {interp.text}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Greeks Panel ─────────────────────────────────────────────────────────────
// FIX B: Replaced 3-column layout with 2×2 grid of GreekChartCell components.
// Each cell is self-contained: value card on the left, chart on the right.

function GreeksPanel({ strike, side, data, allStrikes, spotPrice, dte, onClose }) {

  const greekSeries = useMemo(() => {
    if (!allStrikes?.length) return { delta: [], gamma: [], theta: [], vega: [] };
    const series = { delta: [], gamma: [], theta: [], vega: [] };
    allStrikes.forEach(row => {
      const opt = side === "ce" ? row.ce : row.pe;
      let { delta: d, gamma: g, theta: t, vega: v } = opt || {};
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

  const animKey = useMemo(() => {
    return Object.entries(greekSeries).map(([k, s]) => {
      const valid = s.filter(v => v != null && !isNaN(v));
      return `${k}:${valid.length}:${valid[valid.length-1]?.toFixed(5) ?? ""}`;
    }).join("|");
  }, [greekSeries]);

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
    { key: "gamma", sym: "Γ", name: "GAMMA", color: "#4db8ff", desc: "delta/₹1 move"  },
    { key: "theta", sym: "θ", name: "THETA", color: "#ff8c42", desc: "₹ daily decay"  },
    { key: "vega",  sym: "ν", name: "VEGA",  color: "#a78bfa", desc: "₹/1% IV change" },
  ];

  return ReactDOM.createPortal(
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
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
        width: "min(1100px, 98vw)",
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
          flexShrink: 0,
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

        {/* FIX B: 2×2 grid — each cell is self-contained value card + chart */}
        <div style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          gap: "1px",
          background: "#060c18",
          overflow: "hidden",
        }}>
          {Greeks.map(g => (
            <GreekChartCell
              key={g.key}
              greek={g}
              greeks={greeks}
              greekSeries={greekSeries}
              strike={strike}
              spotPrice={spotPrice}
              dte={dte}
              animKey={animKey}
            />
          ))}
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
    </div>,
    document.body
  );
}

// ─── OI Bar ───────────────────────────────────────────────────────────────────

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

// ─── Greek Cell (inline in table row) ────────────────────────────────────────

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

// ─── Strike Row ───────────────────────────────────────────────────────────────
// FIX A: oiChange column now uses fmtDelta() — was using fmt() which dropped sign
// and showed raw numbers. fmtDelta("-268775") → "-2.7L"

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

      {/* FIX A: was fmt(row.ce.oiChange) — now fmtDelta(row.ce.oiChange) */}
      <td className={`ce-cell change ${row.ce.oiChange>0?"pos":row.ce.oiChange<0?"neg":""}`}>
        {row.ce.oiChange !== 0 && (
          <span>{fmtDelta(row.ce.oiChange)}</span>
        )}
      </td>

      <td className="ce-cell ltp">{fmtPrice(row.ce.ltp)}</td>
      <td className="ce-cell iv">{row.ce.iv ? row.ce.iv.toFixed(1)+"%" : "—"}</td>
      {showGreeks && <td className="ce-cell"><GreekCell delta={row.ce.delta} theta={row.ce.theta} vega={row.ce.vega} side="ce" onGreekClick={()=>onGreekClick(row.strike,"ce",row.ce)}/></td>}
      <td className="ce-cell sig">{ceSig.icon && <span className="sig-pill" style={{color:ceSig.color}}>{ceSig.icon} {ceSig.label}</span>}</td>

      <td className="strike-cell">
        <span className="strike-num">{row.strike.toLocaleString("en-IN")}</span>
        {isATM && <span className="atm-badge">ATM</span>}
      </td>

      <td className="pe-cell sig">{peSig.icon && <span className="sig-pill" style={{color:peSig.color}}>{peSig.icon} {peSig.label}</span>}</td>
      {showGreeks && <td className="pe-cell"><GreekCell delta={row.pe.delta} theta={row.pe.theta} vega={row.pe.vega} side="pe" onGreekClick={()=>onGreekClick(row.strike,"pe",row.pe)}/></td>}
      <td className="pe-cell iv">{row.pe.iv ? row.pe.iv.toFixed(1)+"%" : "—"}</td>
      <td className="pe-cell ltp">{fmtPrice(row.pe.ltp)}</td>

      {/* FIX A: was fmt(row.pe.oiChange) — now fmtDelta(row.pe.oiChange) */}
      <td className={`pe-cell change ${row.pe.oiChange>0?"pos":row.pe.oiChange<0?"neg":""}`}>
        {row.pe.oiChange !== 0 && (
          <span>{fmtDelta(row.pe.oiChange)}</span>
        )}
      </td>

      <td className="pe-cell oi-cell"><OIBar value={row.pe.oi} prevValue={prevRow?.pe.oi} max={maxPEOI} side="pe" signal={row.pe.signal}/></td>
    </tr>
  );
}, (prev, next) => (
  prev.row        === next.row        &&
  prev.prevRow    === next.prevRow    &&
  prev.maxCEOI    === next.maxCEOI    &&
  prev.maxPEOI    === next.maxPEOI    &&
  prev.spotPrice  === next.spotPrice  &&
  prev.isFlash    === next.isFlash    &&
  prev.showGreeks === next.showGreeks
));

// ─── PCR Gauge ────────────────────────────────────────────────────────────────

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

// ─── Update Timer ─────────────────────────────────────────────────────────────

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

// ─── Connection Badge ─────────────────────────────────────────────────────────

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

// ─── OI Flow Bar ──────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcDTE(expiryStr) {
  if (!expiryStr) return null;
  try { return Math.max(0, Math.ceil((new Date(expiryStr) - new Date()) / 86400000)); }
  catch { return null; }
}

const SS_KEY = "oc_state_v2";
function saveSession(obj) { try { sessionStorage.setItem(SS_KEY, JSON.stringify(obj)); } catch {} }
function loadSession()    { try { return JSON.parse(sessionStorage.getItem(SS_KEY) || "null"); } catch { return null; } }

function mergeChainData(prev, next) {
  if (!prev) return next;
  const merged = { ...prev, ...next };
  const prevMap = {};
  (prev.strikes || []).forEach(r => { prevMap[r.strike] = r; });
  merged.strikes = (next.strikes || []).map(newRow => {
    const old = prevMap[newRow.strike];
    if (!old) return newRow;
    if (
      old.ce.oi     === newRow.ce.oi     &&
      old.ce.ltp    === newRow.ce.ltp    &&
      old.ce.iv     === newRow.ce.iv     &&
      old.ce.signal === newRow.ce.signal &&
      old.pe.oi     === newRow.pe.oi     &&
      old.pe.ltp    === newRow.pe.ltp    &&
      old.pe.iv     === newRow.pe.iv     &&
      old.pe.signal === newRow.pe.signal
    ) return old;
    return newRow;
  });
  return merged;
}

// ─── Main Component ───────────────────────────────────────────────────────────

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

  const headerRef  = useRef(null);
  const summaryRef = useRef(null);
  const alertsRef  = useRef(null);
  const footerRef  = useRef(null);
  const tableRef   = useRef(null);
  const socketRef      = useRef(null);
  const lastUpdateRef  = useRef(null);
  const pollRef        = useRef(null);

  useLayoutEffect(() => {
    const measure = () => {
      const hh    = headerRef.current?.offsetHeight  || 41;
      const sh    = summaryRef.current?.offsetHeight || 56;
      const ah    = alertsRef.current?.offsetHeight  || 0;
      const fh    = footerRef.current?.offsetHeight  || 28;
      const tableTop = hh + sh + 4 + ah;
      const root = document.documentElement;
      root.style.setProperty("--header-h",  hh  + "px");
      root.style.setProperty("--summary-h", sh  + "px");
      root.style.setProperty("--footer-h",  fh  + "px");
      root.style.setProperty("--table-top", tableTop + "px");
    };
    measure();
    const ro = new ResizeObserver(measure);
    [headerRef, summaryRef, alertsRef, footerRef].forEach(r => {
      if (r.current) ro.observe(r.current);
    });
    return () => ro.disconnect();
  });

  useEffect(() => {
    saveSession({ underlying, expiry: selectedExpiry, showATMOnly, strikeCount, showGreeks });
  }, [underlying, selectedExpiry, showATMOnly, strikeCount, showGreeks]);

  const applyChainData = useCallback((data, source) => {
    if (!data?.strikes) return;
    setPrevStrikes(() => {
      const n = {};
      (data.strikes || []).forEach(r => { n[r.strike] = r; });
      return n;
    });
    setChainData(prev => mergeChainData(prev, data));
    const now = Date.now();
    setLastUpdate(now);
    lastUpdateRef.current = now;
    setLoading(false);
    setConnStatus(source === "socket" ? "live" : "rest");
    if (data.alerts?.length) {
      const f = new Set(data.alerts.map(a => a.strike));
      setFlashStrikes(f);
      setTimeout(() => setFlashStrikes(new Set()), 1500);
    }
  }, []);

  useEffect(() => {
    const socket = io(window.location.origin, { transports: ["websocket"] });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnStatus("live");
      socket.emit("request-option-chain", { underlying, expiry: selectedExpiry });
    });
    socket.on("disconnect", () => setConnStatus("disconnected"));
    socket.on("upstox-status", ({ connected }) => {
      if (!connected) setConnStatus(prev => prev === "live" ? "rest" : prev);
    });
    socket.on("option-expiries", ({ underlying: u, expiries: e }) => {
      if (u !== underlying) return;
      setExpiries(e || []);
      setExpiry(prev => (prev && e?.includes(prev)) ? prev : (e?.[0] || null));
    });
    socket.on("option-chain-update", ({ underlying: u, data }) => {
      if (u !== underlying) return;
      applyChainData(data, "socket");
    });
    return () => { socket.disconnect(); setConnStatus("disconnected"); };
  }, [underlying]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (socketRef.current?.connected && selectedExpiry)
      socketRef.current.emit("request-option-chain", { underlying, expiry: selectedExpiry });
  }, [underlying, selectedExpiry]);

  useEffect(() => {
    if (!selectedExpiry) return;
    const poll = () => {
      fetch(`/api/option-chain?underlying=${underlying}&expiry=${selectedExpiry}`)
        .then(r => r.json())
        .then(data => {
          if (!data?.strikes) return;
          const age = lastUpdateRef.current ? Date.now() - lastUpdateRef.current : Infinity;
          if (age > 2000) {
            applyChainData(data, "rest");
          } else {
            const now = Date.now();
            setLastUpdate(now);
            lastUpdateRef.current = now;
          }
        })
        .catch(() => {});
    };
    setLoading(true);
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [underlying, selectedExpiry, applyChainData]);

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

  useEffect(() => {
    if (!chainData) return;
    const atm = tableRef.current?.querySelector(".atm");
    if (atm) setTimeout(() => atm.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
  }, [chainData?.expiry, chainData?.underlying]); // eslint-disable-line

  const handleGreekClick = useCallback((strike, side, data) => setGreekPanel({ strike, side, data }), []);
  const closeGreekPanel  = useCallback(() => setGreekPanel(null), []);
  const hasAlerts = chainData?.alerts?.length > 0;

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

      {/* ── HEADER ── */}
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
              {showGreeks ? "Hide Greeks" : "Δθν Greeks"}
            </button>
            {showGreeks && (
              <>
                <span className="greek-legend-chip" style={{color:"#00c896"}}>Δ price</span>
                <span className="greek-legend-chip" style={{color:"#ff8c42"}}>θ decay</span>
                <span className="greek-legend-chip" style={{color:"#a78bfa"}}>ν vol</span>
                <span className="greek-legend-chip" style={{color:"#4db8ff"}}>Γ curve</span>
              </>
            )}
          </div>
          {dte != null && (
            <div style={{
              fontSize:9, fontFamily:"JetBrains Mono,monospace", fontWeight:700,
              color: dte<=3?"#ff6b6b":dte<=7?"#f0c040":"#6a8aaa",
              padding:"3px 8px", background:"rgba(0,0,0,0.3)", borderRadius:4,
              border:`1px solid ${dte<=3?"#ff6b6b30":"#1c2b3a"}`,
              whiteSpace: "nowrap",
            }}>{dte}d DTE</div>
          )}
          {onBack && <button className="ctrl-btn" onClick={onBack}>← Back</button>}
          <ConnBadge status={connStatus}/>
        </div>
      </div>

      {/* ── SUMMARY BAR ── */}
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

      {chainData && <OIFlowBar totalCEOI={chainData.totalCEOI} totalPEOI={chainData.totalPEOI}/>}

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

      {loading && (
        <div className="oc-loading">
          <div className="loading-pulse"/>
          <span>Fetching option chain data...</span>
        </div>
      )}

      {!loading && !chainData && (
        <div className="oc-empty">
          <p>⏳ Waiting for first poll...</p>
          <p className="empty-sub">NSE · socket primary · 3s REST fallback</p>
        </div>
      )}

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

      <div className="oc-footer" ref={footerRef}>
        <span>Socket · 3s REST · BS-augmented Greeks · Hull 10th ed.</span>
        {chainData && <span>{visibleStrikes.length}/{strikes.length} strikes · {underlying} · {selectedExpiry}{dte!=null?` · ${dte}d DTE`:""}</span>}
      </div>
    </div>
  );
}
