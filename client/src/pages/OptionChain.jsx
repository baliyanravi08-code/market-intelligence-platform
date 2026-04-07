/**
 * OptionChain.jsx — NEXT LEVEL
 * Fix: tick-by-tick OI updates via 3s REST poll + socket push (no skip logic)
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

// ── Formatters ────────────────────────────────────────────────────────────────
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
  if (n == null || n === 0) return "—";
  return n.toFixed(dec);
}

// ── Greek interpretation engine ───────────────────────────────────────────────
function interpretGreek(type, value, side) {
  if (value == null) return { text: "No data", color: "#5a7a9a" };
  switch (type) {
    case "delta": {
      const abs = Math.abs(value);
      if (abs > 0.7)  return { text: side === "ce" ? "Deep ITM — behaves like stock" : "Deep ITM put — strong hedge", color: "#00c896" };
      if (abs > 0.5)  return { text: "ITM — high price sensitivity", color: "#00c896" };
      if (abs > 0.3)  return { text: "Near ATM — balanced sensitivity", color: "#f0c040" };
      return { text: "OTM — low directional exposure", color: "#5a7a9a" };
    }
    case "theta": {
      if (value < -5)  return { text: "High time decay — losing value fast", color: "#ff6b6b" };
      if (value < -1)  return { text: "Moderate decay — watch expiry", color: "#f0c040" };
      if (value < 0)   return { text: "Low decay — time is gentle", color: "#00c896" };
      return { text: "Positive theta — time works for you", color: "#00c896" };
    }
    case "vega": {
      if (value > 0.5) return { text: "High IV sensitivity — volatile moves matter", color: "#a78bfa" };
      if (value > 0.2) return { text: "Moderate IV sensitivity", color: "#f0c040" };
      return { text: "Low IV sensitivity", color: "#5a7a9a" };
    }
    case "gamma": {
      if (value > 0.05) return { text: "High gamma — delta changes fast near ATM", color: "#4db8ff" };
      if (value > 0.01) return { text: "Moderate gamma", color: "#f0c040" };
      return { text: "Low gamma — delta stable", color: "#5a7a9a" };
    }
    default: return { text: "", color: "#5a7a9a" };
  }
}

// ── Inline SVG sparkline chart ────────────────────────────────────────────────
function Sparkline({ data, color, height = 120, width = 360 }) {
  if (!data || data.length < 2) {
    return (
      <svg className="greek-svg" viewBox={`0 0 ${width} ${height}`}>
        <text x={width/2} y={height/2} textAnchor="middle" fill="#2a4060" fontSize="11">No history yet</text>
      </svg>
    );
  }

  const min    = Math.min(...data);
  const max    = Math.max(...data);
  const range  = max - min || 1;
  const pad    = 10;
  const W      = width - pad * 2;
  const H      = height - pad * 2;

  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * W;
    const y = pad + H - ((v - min) / range) * H;
    return `${x},${y}`;
  });

  const pathD   = `M ${pts.join(" L ")}`;
  const areaD   = `M ${pts[0]} L ${pts.join(" L ")} L ${pad + W},${pad + H} L ${pad},${pad + H} Z`;
  const lastPt  = pts[pts.length - 1].split(",");
  const lastVal = data[data.length - 1];

  return (
    <svg className="greek-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`grad-${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map(t => {
        const y = pad + t * H;
        return <line key={t} x1={pad} y1={y} x2={pad+W} y2={y} stroke="#1a2a3a" strokeWidth="1" />;
      })}
      <path d={areaD} fill={`url(#grad-${color.replace("#","")})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastPt[0]} cy={lastPt[1]} r="3" fill={color} />
      <text x={pad+2} y={pad+10} fill="#3d5a72" fontSize="8">{min.toFixed(2)}</text>
      <text x={pad+2} y={pad+H} fill="#3d5a72" fontSize="8">{max.toFixed(2)}</text>
      <text x={Number(lastPt[0])+6} y={Number(lastPt[1])} fill={color} fontSize="9" fontWeight="700">
        {lastVal.toFixed(3)}
      </text>
    </svg>
  );
}

// ── Greeks Chart Panel ────────────────────────────────────────────────────────
function GreeksPanel({ strike, side, data, history, onClose }) {
  const Greeks = [
    { key: "delta", name: "Delta", symbol: "Δ", color: "#00c896", desc: "Price sensitivity" },
    { key: "theta", name: "Theta", symbol: "θ", color: "#ff8c42", desc: "Time decay / day" },
    { key: "vega",  name: "Vega",  symbol: "ν", color: "#a78bfa", desc: "IV sensitivity" },
    { key: "gamma", name: "Gamma", symbol: "γ", color: "#4db8ff", desc: "Delta change rate" },
  ];

  useEffect(() => {
    const handler = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="greeks-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="greeks-panel">
        <div className="greeks-panel-header">
          <div>
            <span className="greeks-panel-title">
              Greeks — {strike?.toLocaleString("en-IN")} {side?.toUpperCase()}
            </span>
            <span className="greeks-panel-sub">
              Click outside or Esc to close · Sparklines show cross-strike distribution
            </span>
          </div>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="greeks-charts-grid">
          {Greeks.map(g => {
            const value  = data?.[g.key];
            const interp = interpretGreek(g.key, value, side);
            const chartData = history?.map(h => h[g.key]).filter(v => v != null) || [];

            return (
              <div key={g.key} className="greek-chart-box">
                <div className="greek-chart-label" style={{ color: g.color }}>
                  {g.symbol} {g.name}
                  <span className="greek-name">{g.desc}</span>
                </div>
                <div className="greek-chart-canvas">
                  <Sparkline data={chartData} color={g.color} />
                </div>
                <div className="greek-stat-row">
                  <div className="greek-stat">
                    <span className="greek-stat-val" style={{ color: g.color }}>
                      {fmtGreek(value, g.key === "gamma" ? 4 : 3)}
                    </span>
                    <span className="greek-stat-lbl">Current</span>
                  </div>
                  {chartData.length > 1 && (
                    <>
                      <div className="greek-stat">
                        <span className="greek-stat-val" style={{ color: "#5a7a9a" }}>
                          {fmtGreek(Math.min(...chartData), g.key === "gamma" ? 4 : 3)}
                        </span>
                        <span className="greek-stat-lbl">Min (chain)</span>
                      </div>
                      <div className="greek-stat">
                        <span className="greek-stat-val" style={{ color: "#5a7a9a" }}>
                          {fmtGreek(Math.max(...chartData), g.key === "gamma" ? 4 : 3)}
                        </span>
                        <span className="greek-stat-lbl">Max (chain)</span>
                      </div>
                    </>
                  )}
                </div>
                <div className="greek-interp" style={{ background: interp.color + "18", color: interp.color, border: `1px solid ${interp.color}30` }}>
                  {interp.text}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── OI Bar ────────────────────────────────────────────────────────────────────
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
      {deltaStr && (
        <span className="oi-delta" style={{ color: oiChange > 0 ? "#00c896" : "#ff6b6b" }}>
          {deltaStr}
        </span>
      )}
    </div>
  );
}

// ── Greek Cell — clickable ────────────────────────────────────────────────────
function GreekCell({ delta, theta, vega, gamma, side, onGreekClick }) {
  const dColor = side === "ce"
    ? (delta > 0.5 ? "#00c896" : "#5a7a9a")
    : (delta < -0.5 ? "#ff6b6b" : "#5a7a9a");

  return (
    <div className="greek-cell" onClick={onGreekClick} title="Click to open Greeks chart">
      <span className="greek-item" style={{ color: dColor }}>
        <span className="greek-label">Δ</span>{fmtGreek(delta, 2)}
      </span>
      <span className="greek-item" style={{ color: "#ff8c42" }}>
        <span className="greek-label">θ</span>{fmtGreek(theta, 1)}
      </span>
      <span className="greek-item" style={{ color: "#a78bfa" }}>
        <span className="greek-label">ν</span>{fmtGreek(vega, 2)}
      </span>
    </div>
  );
}

// ── Strike row ────────────────────────────────────────────────────────────────
function StrikeRow({ row, prevRow, maxCEOI, maxPEOI, spotPrice, isFlash, showGreeks, onGreekClick }) {
  const isATM  = row.isATM;
  const itm_ce = spotPrice > 0 && row.strike < spotPrice;
  const itm_pe = spotPrice > 0 && row.strike > spotPrice;
  const ceSig  = SIGNAL_LABELS[row.ce.signal] || SIGNAL_LABELS.neutral;
  const peSig  = SIGNAL_LABELS[row.pe.signal] || SIGNAL_LABELS.neutral;

  const ceOIChange = prevRow ? row.ce.oi - prevRow.ce.oi : 0;
  const peOIChange = prevRow ? row.pe.oi - prevRow.pe.oi : 0;
  const netChange  = ceOIChange + peOIChange;
  const tickClass  = netChange > 0 ? " tick-up" : netChange < 0 ? " tick-down" : "";

  return (
    <tr className={`strike-row${isATM ? " atm" : ""}${isFlash ? " flash" : ""}${tickClass}${itm_ce ? " itm-ce" : ""}${itm_pe ? " itm-pe" : ""}`}>
      <td className="ce-cell oi-cell">
        <OIBar value={row.ce.oi} prevValue={prevRow?.ce.oi} max={maxCEOI} side="ce" signal={row.ce.signal} />
      </td>
      <td className={`ce-cell change ${row.ce.oiChange > 0 ? "pos" : row.ce.oiChange < 0 ? "neg" : ""}`}>
        {row.ce.oiChange !== 0 && <span>{row.ce.oiChange > 0 ? "+" : ""}{fmt(row.ce.oiChange)}</span>}
      </td>
      <td className="ce-cell ltp">{fmtPrice(row.ce.ltp)}</td>
      <td className="ce-cell iv">{row.ce.iv ? row.ce.iv.toFixed(1) + "%" : "—"}</td>
      {showGreeks && (
        <td className="ce-cell">
          <GreekCell
            delta={row.ce.delta} theta={row.ce.theta}
            vega={row.ce.vega} gamma={row.ce.gamma}
            side="ce"
            onGreekClick={() => onGreekClick(row.strike, "ce", row.ce)}
          />
        </td>
      )}
      <td className="ce-cell sig">
        {ceSig.icon && <span className="sig-pill" style={{ color: ceSig.color }}>{ceSig.icon} {ceSig.label}</span>}
      </td>

      <td className="strike-cell">
        <span className="strike-num">{row.strike.toLocaleString("en-IN")}</span>
        {isATM && <span className="atm-badge">ATM</span>}
      </td>

      <td className="pe-cell sig">
        {peSig.icon && <span className="sig-pill" style={{ color: peSig.color }}>{peSig.icon} {peSig.label}</span>}
      </td>
      {showGreeks && (
        <td className="pe-cell">
          <GreekCell
            delta={row.pe.delta} theta={row.pe.theta}
            vega={row.pe.vega} gamma={row.pe.gamma}
            side="pe"
            onGreekClick={() => onGreekClick(row.strike, "pe", row.pe)}
          />
        </td>
      )}
      <td className="pe-cell iv">{row.pe.iv ? row.pe.iv.toFixed(1) + "%" : "—"}</td>
      <td className="pe-cell ltp">{fmtPrice(row.pe.ltp)}</td>
      <td className={`pe-cell change ${row.pe.oiChange > 0 ? "pos" : row.pe.oiChange < 0 ? "neg" : ""}`}>
        {row.pe.oiChange !== 0 && <span>{row.pe.oiChange > 0 ? "+" : ""}{fmt(row.pe.oiChange)}</span>}
      </td>
      <td className="pe-cell oi-cell">
        <OIBar value={row.pe.oi} prevValue={prevRow?.pe.oi} max={maxPEOI} side="pe" signal={row.pe.signal} />
      </td>
    </tr>
  );
}

// ── PCR Gauge ─────────────────────────────────────────────────────────────────
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

// ── Live timer ────────────────────────────────────────────────────────────────
function UpdateTimer({ lastUpdate }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!lastUpdate) return;
    const tick = () => setSecs(Math.floor((Date.now() - lastUpdate) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [lastUpdate]);
  if (!lastUpdate) return <span className="s-val updated">—</span>;
  const color = secs < 20 ? "#00c896" : secs < 60 ? "#f0c040" : "#ff6b6b";
  return <span className="s-val updated" style={{ color }}>{secs}s ago</span>;
}

// ── Connection badge ──────────────────────────────────────────────────────────
function ConnBadge({ status }) {
  const map = {
    live:         { label: "LIVE",         color: "#00c896" },
    rest:         { label: "REST POLL",    color: "#f0c040" },
    disconnected: { label: "DISCONNECTED", color: "#ff6b6b" },
  };
  const cfg = map[status] || map.disconnected;
  return (
    <div className={`conn-badge ${status}`} style={{ color: cfg.color, borderColor: cfg.color + "30" }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: cfg.color, display: "inline-block", animation: status === "live" ? "dot-pulse 1.4s infinite" : "none" }} />
      {cfg.label}
    </div>
  );
}

// ── OI Flow bar ───────────────────────────────────────────────────────────────
function OIFlowBar({ totalCEOI, totalPEOI }) {
  const total = (totalCEOI || 0) + (totalPEOI || 0);
  const cePct = total > 0 ? ((totalCEOI / total) * 100).toFixed(1) : 50;
  const pePct = total > 0 ? ((totalPEOI / total) * 100).toFixed(1) : 50;
  return (
    <div className="oi-flow-bar" title={`CE: ${cePct}%  PE: ${pePct}%`}>
      <div className="oi-flow-ce" style={{ width: `${cePct}%` }} />
      <div className="oi-flow-pe" style={{ width: `${pePct}%` }} />
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function OptionChain({ onBack }) {
  const [underlying,     setUnderlying]   = useState("NIFTY");
  const [expiries,       setExpiries]     = useState([]);
  const [selectedExpiry, setExpiry]       = useState(null);
  const [chainData,      setChainData]    = useState(null);
  const [prevStrikes,    setPrevStrikes]  = useState({});
  const [loading,        setLoading]      = useState(true);
  const [lastUpdate,     setLastUpdate]   = useState(null);
  const [flashStrikes,   setFlashStrikes] = useState(new Set());
  const [showATMOnly,    setShowATMOnly]  = useState(false);
  const [strikeCount,    setStrikeCount]  = useState(20);
  const [showGreeks,     setShowGreeks]   = useState(false);
  const [connStatus,     setConnStatus]   = useState("disconnected");
  const [greekPanel,     setGreekPanel]   = useState(null);

  const socketRef      = useRef(null);
  const tableRef       = useRef(null);
  const pollRef        = useRef(null);
  const lastUpdateRef  = useRef(null); // ref mirror so poll closure sees latest value

  // ── Apply chain data (single point of update) ────────────────────────────
  const applyChainData = useCallback((data, source) => {
    if (!data) return;

    // Save prev strikes for OI diff before overwriting
    setPrevStrikes(() => {
      const next = {};
      (data.strikes || []).forEach(row => { next[row.strike] = row; });
      return next;
    });

    setChainData(data);
    const now = Date.now();
    setLastUpdate(now);
    lastUpdateRef.current = now;
    setLoading(false);

    if (source === "socket") setConnStatus("live");
    else setConnStatus("rest");

    if (data.alerts?.length) {
      const newFlash = new Set(data.alerts.map(a => a.strike));
      setFlashStrikes(newFlash);
      setTimeout(() => setFlashStrikes(new Set()), 1500);
    }
  }, []);

  // ── Socket (primary) ─────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(window.location.origin, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnStatus("live");
      socket.emit("request-option-chain", { underlying, expiry: selectedExpiry });
    });

    socket.on("disconnect", () => setConnStatus("disconnected"));

    socket.on("option-expiries", ({ underlying: u, expiries: e }) => {
      if (u !== underlying) return;
      setExpiries(e || []);
      if (e?.length && !selectedExpiry) setExpiry(e[0]);
    });

    // ── KEY FIX 1: accept every push — removed expiry guard that blocked updates ──
    socket.on("option-chain-update", ({ underlying: u, data }) => {
      if (u !== underlying) return;
      applyChainData(data, "socket");
    });

    return () => {
      socket.disconnect();
      setConnStatus("disconnected");
    };
  }, [underlying]); // eslint-disable-line

  // ── Re-request on expiry change via socket ───────────────────────────────
  useEffect(() => {
    if (socketRef.current?.connected && selectedExpiry) {
      socketRef.current.emit("request-option-chain", { underlying, expiry: selectedExpiry });
    }
  }, [underlying, selectedExpiry]);

  // ── REST poll — always runs every 3s, no socket-skip logic ───────────────
  useEffect(() => {
    if (!selectedExpiry) return;

    const poll = () => {
      fetch(`/api/option-chain?underlying=${underlying}&expiry=${selectedExpiry}`)
        .then(r => r.json())
        .then(data => {
          if (!data?.strikes) return;
          // ── KEY FIX 2: only apply REST if newer than last socket push ────
          // Use ref so this closure always sees the latest timestamp
          const age = lastUpdateRef.current ? Date.now() - lastUpdateRef.current : Infinity;
          if (age > 2000) {
            // Socket hasn't updated in 2s — apply REST data
            applyChainData(data, "rest");
          } else {
            // Socket is live — still update lastUpdate to show "Xs ago" ticking
            setLastUpdate(Date.now());
            lastUpdateRef.current = Date.now();
          }
        })
        .catch(() => {});
    };

    // Immediate fetch
    setLoading(true);
    poll();

    // ── KEY FIX 3: poll every 3s instead of 15s ──────────────────────────
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [underlying, selectedExpiry]); // eslint-disable-line

  // ── Expiries on underlying change ────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setChainData(null);
    setExpiry(null);
    lastUpdateRef.current = null;
    fetch(`/api/option-chain/expiries?underlying=${underlying}`)
      .then(r => r.json())
      .then(({ expiries: e }) => {
        setExpiries(e || []);
        if (e?.length) setExpiry(e[0]);
      })
      .catch(() => {});
  }, [underlying]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const strikes = chainData?.strikes || [];

  const visibleStrikes = useMemo(() => {
    if (!strikes.length) return [];
    if (!showATMOnly) return strikes;
    const atmIdx = strikes.findIndex(s => s.isATM);
    if (atmIdx < 0) return strikes;
    const from = Math.max(0, atmIdx - strikeCount);
    const to   = Math.min(strikes.length - 1, atmIdx + strikeCount);
    return strikes.slice(from, to + 1);
  }, [strikes, showATMOnly, strikeCount]);

  const maxCEOI = useMemo(() => Math.max(...visibleStrikes.map(s => s.ce.oi), 1), [visibleStrikes]);
  const maxPEOI = useMemo(() => Math.max(...visibleStrikes.map(s => s.pe.oi), 1), [visibleStrikes]);

  const greekHistory = useMemo(() => {
    return visibleStrikes.map(row => ({
      strike: row.strike,
      delta:  greekPanel?.side === "ce" ? row.ce?.delta : row.pe?.delta,
      theta:  greekPanel?.side === "ce" ? row.ce?.theta : row.pe?.theta,
      vega:   greekPanel?.side === "ce" ? row.ce?.vega  : row.pe?.vega,
      gamma:  greekPanel?.side === "ce" ? row.ce?.gamma : row.pe?.gamma,
    }));
  }, [visibleStrikes, greekPanel]);

  // ── Scroll to ATM on expiry/underlying change ─────────────────────────────
  useEffect(() => {
    if (!chainData) return;
    const atmRow = tableRef.current?.querySelector(".atm");
    if (atmRow) setTimeout(() => atmRow.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
  }, [chainData?.expiry, chainData?.underlying]);

  // ── Greek panel handlers ──────────────────────────────────────────────────
  const handleGreekClick = useCallback((strike, side, data) => {
    setGreekPanel({ strike, side, data });
    setShowGreeks(true);
  }, []);

  const closeGreekPanel = useCallback(() => setGreekPanel(null), []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="oc-page">

      {greekPanel && (
        <GreeksPanel
          strike={greekPanel.strike}
          side={greekPanel.side}
          data={greekPanel.data}
          history={greekHistory}
          onClose={closeGreekPanel}
        />
      )}

      {/* ── Header ── */}
      <div className="oc-header">
        <div className="oc-title">
          <span style={{ fontSize: 15 }}>⚡</span>
          <h1>Option Chain <span className="oc-sub">OI Heatmap</span></h1>
          {chainData && <span className="live-dot" />}
        </div>

        <div className="oc-controls">
          <div className="control-group">
            {UNDERLYINGS.map(u => (
              <button key={u} className={`ctrl-btn${underlying === u ? " active" : ""}`}
                onClick={() => setUnderlying(u)}>{u}</button>
            ))}
          </div>

          {expiries.length > 0 && (
            <div className="control-group">
              {expiries.slice(0, 5).map(e => (
                <button key={e} className={`ctrl-btn expiry${selectedExpiry === e ? " active" : ""}`}
                  onClick={() => setExpiry(e)}>{e}</button>
              ))}
            </div>
          )}

          <div className="control-group">
            <button className={`ctrl-btn${showATMOnly ? " active" : ""}`}
              onClick={() => setShowATMOnly(v => !v)}>Near ATM</button>
            {showATMOnly && (
              <select className="ctrl-select" value={strikeCount}
                onChange={e => setStrikeCount(Number(e.target.value))}>
                {[5, 10, 15, 20, 30].map(n => <option key={n} value={n}>±{n}</option>)}
              </select>
            )}
          </div>

          <div className="control-group">
            <button className={`ctrl-btn${showGreeks ? " active" : ""}`}
              onClick={() => setShowGreeks(v => !v)}>
              {showGreeks ? "Hide Δθν" : "Δθν Greeks"}
            </button>
          </div>

          {onBack && (
            <button className="ctrl-btn" onClick={onBack}>← Back</button>
          )}

          <ConnBadge status={connStatus} />
        </div>
      </div>

      {/* ── Summary bar ── */}
      {chainData && (
        <div className="oc-summary">
          <div className="summary-item">
            <span className="s-label">Spot</span>
            <span className="s-val spot">{fmtPrice(chainData.spotPrice)}</span>
          </div>
          <PCRGauge pcr={chainData.pcr} />
          <div className="summary-item">
            <span className="s-label">Max Pain</span>
            <span className="s-val maxpain">{chainData.maxPainStrike?.toLocaleString("en-IN") || "—"}</span>
          </div>
          <div className="summary-item">
            <span className="s-label">Support</span>
            <span className="s-val support">{chainData.support?.toLocaleString("en-IN") || "—"}</span>
          </div>
          <div className="summary-item">
            <span className="s-label">Resistance</span>
            <span className="s-val resistance">{chainData.resistance?.toLocaleString("en-IN") || "—"}</span>
          </div>
          <div className="summary-item">
            <span className="s-label">CE OI</span>
            <span className="s-val ce-oi">{fmt(chainData.totalCEOI)}</span>
          </div>
          <div className="summary-item">
            <span className="s-label">PE OI</span>
            <span className="s-val pe-oi">{fmt(chainData.totalPEOI)}</span>
          </div>
          {chainData.ivSkew != null && (
            <div className="summary-item">
              <span className="s-label">IV Skew</span>
              <span className="s-val" style={{ color: chainData.ivSkew > 0 ? "#ff6b6b" : "#00c896", fontSize: 12 }}>
                {chainData.ivSkew > 0 ? "+" : ""}{chainData.ivSkew?.toFixed(1)}%
              </span>
            </div>
          )}
          <div className="summary-item">
            <span className="s-label">Updated</span>
            <UpdateTimer lastUpdate={lastUpdate} />
          </div>
        </div>
      )}

      {chainData && (
        <OIFlowBar totalCEOI={chainData.totalCEOI} totalPEOI={chainData.totalPEOI} />
      )}

      {showGreeks && (
        <div className="greeks-legend">
          <span><span style={{ color: "#00c896" }}>Δ Delta</span> — price sensitivity</span>
          <span><span style={{ color: "#ff8c42" }}>θ Theta</span> — time decay/day</span>
          <span><span style={{ color: "#a78bfa" }}>ν Vega</span> — IV sensitivity</span>
          <span style={{ color: "#3d5a72", marginLeft: "auto" }}>Click any greek cell to open chart →</span>
        </div>
      )}

      {chainData?.alerts?.length > 0 && (
        <div className="oc-alerts">
          {chainData.alerts.slice(0, 6).map((a, i) => {
            const sig = SIGNAL_LABELS[a.signal] || SIGNAL_LABELS.neutral;
            return (
              <div key={i} className="oc-alert-pill" style={{ borderColor: sig.color + "50" }}>
                <span style={{ color: sig.color }}>{sig.icon}</span>
                <span className="alert-strike">{a.strike.toLocaleString("en-IN")}</span>
                <span className="alert-side">{a.side}</span>
                <span style={{ color: sig.color }}>{sig.label}</span>
                {a.pct && <span className="alert-pct">{a.pct}</span>}
              </div>
            );
          })}
        </div>
      )}

      {loading && (
        <div className="oc-loading">
          <div className="loading-pulse" />
          <span>Fetching option chain data...</span>
        </div>
      )}

      {!loading && !chainData && (
        <div className="oc-empty">
          <p>⏳ Waiting for first poll...</p>
          <p className="empty-sub">Data via NSE — socket primary, 3s REST fallback</p>
        </div>
      )}

      {!loading && chainData && (
        <div className="oc-table-wrap" ref={tableRef}>
          <table className="oc-table">
            <thead>
              <tr className="side-label-row">
                <th className="ce-side-label" colSpan={showGreeks ? 6 : 5}>CALL — CE</th>
                <th />
                <th className="pe-side-label" colSpan={showGreeks ? 6 : 5}>PUT — PE</th>
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

      <div className="oc-footer">
        <span>
          Socket primary · 3s REST fallback ·
          {showGreeks ? " Click Δθν cells for charts" : " Toggle Greeks for Δθν"}
        </span>
        {chainData && (
          <span>
            {visibleStrikes.length} / {strikes.length} strikes · {underlying} · {selectedExpiry}
          </span>
        )}
      </div>
    </div>
  );
}
