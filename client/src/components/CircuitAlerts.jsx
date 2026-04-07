/**
 * CircuitAlerts.jsx — HYBRID FINAL
 * ─────────────────────────────────────────────────────────────────
 * Intelligence upgrades over both V1 + V2:
 *  • Velocity score  — acceleration-aware, not just momentum direction
 *  • Pre-circuit radar — 3–5% zone w/ building momentum flagged
 *  • Smart sort engine — by tier rank → distPct → velocity
 *  • Flash animation  — new alerts pulse on arrival
 *  • Tier change badge — shows when a stock escalates
 *  • Velocity badge   — EXPLODING / BUILDING / SLOW / FADING
 *  • Pre-Circuit tab  — dedicated radar for stocks about to move
 *
 * Visual identity: V1 dark theme (#010812, #d8eeff, #3a6888)
 * Architecture:    V2 structured TIERS with rank, scalable layout
 *
 * Props: { socket }   (same as before, zero breaking changes)
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ── Theme ──────────────────────────────────────────────────────────────────────
const C = {
  bg:        "#010812",
  panel:     "#020d1c",
  row:       "#030f20",
  border:    "#0c2240",
  borderFaint:"#071828",
  text:      "#d8eeff",
  textMid:   "#7ab0d0",
  textDim:   "#3a6888",
  textGhost: "#1e4060",
  green:     "#00ff9c",
  red:       "#ff5c5c",
  blue:      "#00cfff",
  accent:    "#4a9abb",
};

// ── Tiers ──────────────────────────────────────────────────────────────────────
const TIERS = {
  LOCKED:   { label: "LOCKED",   color: "#ff5c5c", dim: "rgba(255,92,92,0.10)",   border: "rgba(255,92,92,0.30)",   rank: 5 },
  CRITICAL: { label: "CRITICAL", color: "#ff9c00", dim: "rgba(255,156,0,0.10)",   border: "rgba(255,156,0,0.28)",   rank: 4 },
  WARNING:  { label: "WARNING",  color: "#ffd60a", dim: "rgba(255,214,10,0.08)",  border: "rgba(255,214,10,0.25)",  rank: 3 },
  WATCH:    { label: "WATCH",    color: "#4a9abb", dim: "rgba(74,154,187,0.08)",  border: "rgba(74,154,187,0.22)", rank: 2 },
  SAFE:     { label: "SAFE",     color: "#00ff9c", dim: "transparent",             border: "transparent",            rank: 1 },
};

const SIDE_COLOR = { UPPER: C.green, LOWER: C.red };
const SIDE_ICON  = { UPPER: "▲", LOWER: "▼" };
const MAX_ALERTS = 60;
const STALE_MS   = 5 * 60 * 1000;
const WATCH_PCT  = 10;
const PRE_CIRCUIT_MIN = 3;   // 3–5% = pre-circuit radar zone
const PRE_CIRCUIT_MAX = 5;

// ── Formatters ─────────────────────────────────────────────────────────────────
const f2 = n => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f1 = n => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const f0 = n => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

function fmtVol(v) {
  if (!v || v === 0) return null;
  if (v >= 1_00_00_000) return `${(v / 1_00_00_000).toFixed(1)}Cr`;
  if (v >= 1_00_000)    return `${(v / 1_00_000).toFixed(1)}L`;
  if (v >= 1_000)       return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}
function fmtVal(v) {
  if (!v || v === 0) return null;
  const cr = v / 1_00_00_000;
  if (cr >= 100) return `₹${(cr / 100).toFixed(1)}KCr`;
  if (cr >= 1)   return `₹${cr.toFixed(1)}Cr`;
  const l = v / 1_00_000;
  if (l >= 1)    return `₹${l.toFixed(1)}L`;
  return null;
}
function timeStr(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function isStale(iso) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > STALE_MS;
}

// ── Velocity engine ────────────────────────────────────────────────────────────
// momentum < 0 = moving TOWARD circuit
// velocity score = urgency level 0–100
function velocityScore(momentum, distPct, tier) {
  if (tier === "LOCKED") return 100;
  if (!momentum) return 0;
  const toward  = momentum < 0;
  const abs     = Math.abs(momentum);
  const proximity = Math.max(0, 1 - (distPct / WATCH_PCT)); // 0=far, 1=at circuit
  const base    = toward ? abs * 60 : abs * 10;
  return Math.min(100, Math.round(base * (1 + proximity * 2)));
}

function velocityLabel(score, toward) {
  if (!toward) return { label: "FADING", color: C.textDim, icon: "↗" };
  if (score >= 70) return { label: "EXPLODING", color: C.red,    icon: "🔥" };
  if (score >= 40) return { label: "BUILDING",  color: "#ff9c00", icon: "⚡" };
  if (score >= 15) return { label: "DRIFTING",  color: "#ffd60a", icon: "→" };
  return             { label: "SLOW",      color: C.textDim, icon: "·" };
}

// ── Atoms ──────────────────────────────────────────────────────────────────────
function TierBadge({ tier, small }) {
  const t = TIERS[tier] || TIERS.SAFE;
  return (
    <span style={{
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: small ? 8 : 9, fontWeight: 700,
      letterSpacing: "0.5px", padding: small ? "1px 4px" : "1px 6px",
      borderRadius: 3,
      background: t.dim, border: `1px solid ${t.border}`, color: t.color,
      whiteSpace: "nowrap",
    }}>{t.label}</span>
  );
}

function ProxBar({ distPct, side, tier, height = 4 }) {
  const t    = TIERS[tier] || TIERS.SAFE;
  const fill = tier === "LOCKED" ? 100 : Math.max(0, Math.min(100, ((WATCH_PCT - Math.min(distPct, WATCH_PCT)) / WATCH_PCT) * 100));
  return (
    <div style={{ height, borderRadius: 2, background: "#0a1828", overflow: "hidden", position: "relative", width: "100%" }}>
      <div style={{
        position: "absolute", top: 0, bottom: 0,
        width: `${fill}%`,
        [side === "UPPER" ? "right" : "left"]: 0,
        background: t.color, borderRadius: 2,
        opacity: tier === "SAFE" ? 0.2 : 0.88,
        transition: "width 0.5s ease",
      }} />
    </div>
  );
}

function VelocityBadge({ momentum, distPct, tier }) {
  const score  = velocityScore(momentum, distPct, tier);
  const toward = momentum != null && momentum < 0;
  const { label, color, icon } = velocityLabel(score, toward);
  if (!momentum && tier !== "LOCKED") return <span style={{ color: C.textGhost, fontSize: 9 }}>—</span>;
  return (
    <span style={{
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 700, color,
      display: "inline-flex", alignItems: "center", gap: 2,
    }}>
      <span>{icon}</span>
      <span style={{ opacity: 0.8 }}>{label}</span>
    </span>
  );
}

// ── CSS keyframes injected once ────────────────────────────────────────────────
const STYLE_ID = "__ca_styles__";
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes ca-flash {
      0%   { box-shadow: 0 0 0 0 rgba(0,207,255,0.55); background: rgba(0,207,255,0.12); }
      60%  { box-shadow: 0 0 0 6px rgba(0,207,255,0); }
      100% { box-shadow: none; background: transparent; }
    }
    @keyframes ca-pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.4; transform: scale(0.7); }
    }
    @keyframes ca-tier-up {
      0%   { background: rgba(255,214,10,0.25); }
      100% { background: transparent; }
    }
    .ca-new-alert { animation: ca-flash 1.6s ease-out forwards; }
    .ca-tier-escalate { animation: ca-tier-up 2s ease-out forwards; }
    .ca-dot-pulse { animation: ca-pulse-dot 1.4s ease-in-out infinite; }
    .ca-scroll::-webkit-scrollbar { width: 3px; }
    .ca-scroll::-webkit-scrollbar-track { background: transparent; }
    .ca-scroll::-webkit-scrollbar-thumb { background: #1a4060; border-radius: 2px; }
    .ca-row:hover { background: rgba(255,255,255,0.025) !important; }
    .ca-input::placeholder { color: #1e4060; }
    .ca-input:focus { border-color: #1a4a80 !important; outline: none; }
  `;
  document.head.appendChild(s);
}

// ── Summary Strip ──────────────────────────────────────────────────────────────
function SummaryStrip({ watchlist, alerts, tab, onTierClick, tierFilter }) {
  const counts = { LOCKED: 0, CRITICAL: 0, WARNING: 0, WATCH: 0, SAFE: 0 };
  const src = tab === "ALERTS" ? alerts : watchlist;
  for (const s of src) counts[s.tier] = (counts[s.tier] || 0) + 1;

  return (
    <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${C.border}`, marginBottom: 8 }}>
      {["LOCKED","CRITICAL","WARNING","WATCH","SAFE"].map((tier, i, arr) => {
        const t   = TIERS[tier];
        const n   = counts[tier];
        const active = tierFilter === tier;
        return (
          <div key={tier}
            onClick={() => onTierClick(tier)}
            style={{
              flex: 1, textAlign: "center", padding: "5px 2px", cursor: "pointer",
              background: active ? t.dim : (n > 0 ? `${t.dim.slice(0,-1)}, 0.05)` : "#020c1a"),
              borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
              transition: "background 0.15s",
              outline: active ? `1px solid ${t.border}` : "none",
            }}>
            <div style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 800,
              color: n > 0 ? t.color : C.textGhost, lineHeight: 1,
            }}>{n}</div>
            <div style={{ fontSize: 7, color: C.textDim, marginTop: 2, letterSpacing: "0.04em" }}>{tier}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Alert Card ─────────────────────────────────────────────────────────────────
function AlertCard({ alert, onDismiss, isNew }) {
  const t    = TIERS[alert.tier] || TIERS.WATCH;
  const isUp = (alert.changePercent || 0) >= 0;
  const stale = isStale(alert.timestamp);
  const vol  = fmtVol(alert.volume);
  const val  = fmtVal(alert.tradedValue);
  const score  = velocityScore(alert.momentum, alert.distPct, alert.tier);
  const toward = alert.momentum != null && alert.momentum < 0;
  const vel  = velocityLabel(score, toward);

  return (
    <div className={isNew ? "ca-new-alert" : ""}
      style={{
        padding: "8px 10px", borderRadius: 4,
        background: t.dim, border: `1px solid ${t.border}`,
        borderLeft: `3px solid ${t.color}`,
        marginBottom: 5, opacity: stale ? 0.5 : 1,
        transition: "opacity 0.3s",
      }}>

      {/* Row 1: symbol + badges + time */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 12, color: C.text, letterSpacing: "0.04em" }}>
          {alert.symbol}
        </span>
        {alert.sector && (
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: C.accent, background: "#041020", padding: "1px 5px", borderRadius: 3, border: `1px solid ${C.borderFaint}` }}>
            {alert.sector}
          </span>
        )}
        <TierBadge tier={alert.tier} />
        <span style={{ fontSize: 10, color: SIDE_COLOR[alert.side], fontWeight: 700 }}>
          {SIDE_ICON[alert.side]} {alert.side}
        </span>
        {/* Velocity badge inline */}
        {score >= 15 && (
          <span style={{ fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: vel.color }}>
            {vel.icon} {vel.label}
          </span>
        )}
        {stale && (
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: C.textDim, background: "#041020", padding: "1px 5px", borderRadius: 3, border: `1px solid ${C.borderFaint}` }}>
            STALE
          </span>
        )}
        <span style={{ marginLeft: "auto", fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.textDim }}>
          {timeStr(alert.timestamp)}
        </span>
        {onDismiss && (
          <button onClick={() => onDismiss(alert)}
            style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>
            ×
          </button>
        )}
      </div>

      {/* Row 2: price */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 18, fontWeight: 700, color: "#e8f4ff" }}>
          ₹{f2(alert.ltp)}
        </span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 700, color: isUp ? C.green : C.red }}>
          {isUp ? "+" : ""}{f2(alert.changePercent)}%
        </span>
        <span style={{ fontSize: 10, color: C.textMid }}>Prev ₹{f2(alert.prevClose)}</span>
        <span style={{ fontSize: 10, color: C.textDim }}>
          Circuit ₹{f2(alert.circuitLimit)}{" "}
          {alert.fromExchange
            ? <span style={{ color: C.green }}>⚡live</span>
            : `(±${alert.bandPct}%)`}
        </span>
      </div>

      {/* Row 3: prox bar */}
      <div style={{ marginTop: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.textMid, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 3 }}>
          <span>{alert.side === "UPPER" ? "↑ Upper" : "↓ Lower"} circuit proximity</span>
          <span style={{ color: t.color, fontWeight: 700 }}>
            {alert.tier === "LOCKED" ? "AT LIMIT" : `${f2(alert.distPct)}% away`}
          </span>
        </div>
        <ProxBar distPct={alert.distPct} side={alert.side} tier={alert.tier} height={4} />
      </div>

      {/* Row 4: stats */}
      <div style={{ display: "flex", gap: 10, marginTop: 5, fontSize: 9, color: C.textDim, fontFamily: "'IBM Plex Mono', monospace", flexWrap: "wrap", alignItems: "center" }}>
        {vol && <span>Vol <span style={{ color: C.textMid }}>{vol}</span></span>}
        {val && <span>Val <span style={{ color: C.textMid }}>{val}</span></span>}
        <VelocityBadge momentum={alert.momentum} distPct={alert.distPct} tier={alert.tier} />
      </div>
    </div>
  );
}

// ── Watch Row ──────────────────────────────────────────────────────────────────
function WatchRow({ stock, rank, expanded, prevTier }) {
  const t     = TIERS[stock.tier] || TIERS.SAFE;
  const isUp  = (stock.changePercent || 0) >= 0;
  const vol   = fmtVol(stock.volume);
  const tierUp = prevTier && TIERS[stock.tier]?.rank > TIERS[prevTier]?.rank;
  const tpl   = expanded
    ? "22px 80px 72px 60px 50px 1fr 90px 42px"
    : "22px 80px 72px 60px 1fr 90px";

  return (
    <div className={`ca-row${tierUp ? " ca-tier-escalate" : ""}`}
      style={{
        display: "grid", gridTemplateColumns: tpl,
        alignItems: "center", gap: 5,
        padding: "4px 8px", borderRadius: 3,
        background: stock.tier !== "SAFE" ? t.dim : "transparent",
        borderBottom: `1px solid ${C.borderFaint}`,
        transition: "background 0.2s",
      }}>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.textGhost, fontWeight: 700 }}>{rank}</span>

      <div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: C.text, fontSize: 11 }}>
          {stock.symbol}
        </div>
        {stock.sector && stock.tier !== "SAFE" && (
          <div style={{ fontSize: 7, color: C.textDim, marginTop: 1 }}>{stock.sector}</div>
        )}
      </div>

      <div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, color: C.textMid, fontSize: 11 }}>
          ₹{f1(stock.ltp)}
        </div>
        <div style={{ fontSize: 9, color: isUp ? C.green : C.red, fontWeight: 700 }}>
          {isUp ? "+" : ""}{f1(stock.changePercent)}%
        </div>
      </div>

      <div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: t.color, fontSize: 11 }}>
          {stock.tier === "LOCKED" ? "LOCK" : `${f1(stock.distPct)}%`}
        </div>
        <div style={{ fontSize: 9, color: SIDE_COLOR[stock.side], fontWeight: 700 }}>
          {SIDE_ICON[stock.side]} {stock.side}
        </div>
      </div>

      {expanded && <TierBadge tier={stock.tier} small />}

      <ProxBar distPct={stock.distPct} side={stock.side} tier={stock.tier} height={4} />

      <VelocityBadge momentum={stock.momentum} distPct={stock.distPct} tier={stock.tier} />

      {expanded && (
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.textDim, textAlign: "right" }}>
          {vol || "—"}
        </span>
      )}
    </div>
  );
}

function WatchHeader({ expanded }) {
  const cols = expanded
    ? ["#", "SYMBOL", "LTP/CHG", "DIST", "TIER", "PROXIMITY", "VELOCITY", "VOL"]
    : ["#", "SYMBOL", "LTP/CHG", "DIST", "PROXIMITY", "VELOCITY"];
  const tpl  = expanded
    ? "22px 80px 72px 60px 50px 1fr 90px 42px"
    : "22px 80px 72px 60px 1fr 90px";
  return (
    <div style={{
      display: "grid", gridTemplateColumns: tpl, gap: 5,
      padding: "3px 8px 5px",
      fontSize: 8, fontWeight: 700, color: C.textGhost,
      letterSpacing: "0.07em", fontFamily: "'IBM Plex Mono', monospace",
      borderBottom: `1px solid ${C.border}`, marginBottom: 2,
    }}>
      {cols.map(c => <span key={c}>{c}</span>)}
    </div>
  );
}

// ── Pre-Circuit Radar ──────────────────────────────────────────────────────────
function RadarRow({ stock, rank }) {
  const isUp  = (stock.changePercent || 0) >= 0;
  const score = velocityScore(stock.momentum, stock.distPct, stock.tier);
  const toward = stock.momentum != null && stock.momentum < 0;
  const vel   = velocityLabel(score, toward);
  const urgency = score >= 40 ? C.red : score >= 15 ? "#ff9c00" : "#ffd60a";

  return (
    <div className="ca-row" style={{
      display: "grid", gridTemplateColumns: "22px 80px 55px 55px 1fr 90px",
      alignItems: "center", gap: 5,
      padding: "5px 8px", borderRadius: 3,
      background: "rgba(255,214,10,0.04)",
      borderBottom: `1px solid ${C.borderFaint}`,
      borderLeft: `2px solid ${urgency}`,
    }}>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.textGhost }}>{rank}</span>

      <div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: C.text, fontSize: 11 }}>{stock.symbol}</div>
        {stock.sector && <div style={{ fontSize: 7, color: C.textDim }}>{stock.sector}</div>}
      </div>

      <div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, color: C.textMid, fontSize: 10 }}>₹{f1(stock.ltp)}</div>
        <div style={{ fontSize: 9, color: isUp ? C.green : C.red, fontWeight: 700 }}>{isUp ? "+" : ""}{f1(stock.changePercent)}%</div>
      </div>

      <div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: urgency, fontSize: 10 }}>{f1(stock.distPct)}%</div>
        <div style={{ fontSize: 9, color: SIDE_COLOR[stock.side], fontWeight: 700 }}>{SIDE_ICON[stock.side]} {stock.side}</div>
      </div>

      <ProxBar distPct={stock.distPct} side={stock.side} tier="WATCH" height={3} />

      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 700, color: vel.color }}>
        {vel.icon} {vel.label}
      </span>
    </div>
  );
}

function RadarHeader() {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "22px 80px 55px 55px 1fr 90px", gap: 5,
      padding: "3px 8px 5px",
      fontSize: 8, fontWeight: 700, color: C.textGhost,
      letterSpacing: "0.07em", fontFamily: "'IBM Plex Mono', monospace",
      borderBottom: `1px solid ${C.border}`, marginBottom: 2,
    }}>
      {["#","SYMBOL","LTP/CHG","DIST","PROXIMITY","VELOCITY"].map(c => <span key={c}>{c}</span>)}
    </div>
  );
}

// ── Pill / Tab buttons ─────────────────────────────────────────────────────────
function PillBtn({ active, color, onClick, children, style: xStyle }) {
  return (
    <button onClick={onClick} style={{
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 700,
      letterSpacing: "0.04em", padding: "2px 7px", borderRadius: 3, cursor: "pointer",
      background: active ? (color ? color + "22" : "#0d3060") : "#041020",
      border: `1px solid ${active ? (color || "#1a4a80") : C.borderFaint}`,
      color:  active ? (color || C.text) : C.textDim,
      transition: "all 0.12s", whiteSpace: "nowrap",
      ...xStyle,
    }}>{children}</button>
  );
}
function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 700,
      letterSpacing: "0.05em", padding: "3px 10px", borderRadius: 3, cursor: "pointer",
      background: active ? "#0d3060" : "#041020",
      border: `1px solid ${active ? "#1a4a80" : C.borderFaint}`,
      color:  active ? C.text : C.textDim,
      transition: "all 0.12s",
    }}>{children}</button>
  );
}

// ── Sort watchlist: rank DESC → distPct ASC → velocityScore DESC ──────────────
function sortWatchlist(list) {
  return [...list].sort((a, b) => {
    const rankA = TIERS[a.tier]?.rank ?? 0;
    const rankB = TIERS[b.tier]?.rank ?? 0;
    if (rankB !== rankA) return rankB - rankA;
    if (a.distPct !== b.distPct) return a.distPct - b.distPct;
    const va = velocityScore(a.momentum, a.distPct, a.tier);
    const vb = velocityScore(b.momentum, b.distPct, b.tier);
    return vb - va;
  });
}

// ── Main Component ──────────────────────────────────────────────────────────────
export default function CircuitAlerts({ socket }) {
  const [alerts,       setAlerts]     = useState([]);
  const [watchlist,    setWatchlist]  = useState([]);
  const [connected,    setConn]       = useState(false);
  const [tab,          setTab]        = useState("WATCHLIST");
  const [tierFilter,   setTierFilter] = useState("ALL");
  const [sideFilter,   setSideFilter] = useState("ALL");
  const [sectorFilter, setSector]     = useState("ALL");
  const [search,       setSearch]     = useState("");
  const [expanded,     setExpanded]   = useState(false);
  const [showSafe,     setShowSafe]   = useState(false);
  const [watchPage,    setWatchPage]  = useState(30);
  const [newAlertIds,  setNewIds]     = useState(new Set());
  const prevTiersRef   = useRef({});  // symbol → last tier (for escalation highlight)

  useEffect(() => { injectStyles(); }, []);

  const sectors = useMemo(() => {
    const s = new Set(watchlist.map(w => w.sector).filter(Boolean));
    return ["ALL", ...Array.from(s).sort()];
  }, [watchlist]);

  // Pre-circuit radar: 3–5% away, toward circuit, has momentum
  const radarList = useMemo(() => {
    return sortWatchlist(
      watchlist.filter(s => {
        if (s.tier === "LOCKED" || s.tier === "CRITICAL") return false;
        const inZone  = s.distPct >= PRE_CIRCUIT_MIN && s.distPct <= PRE_CIRCUIT_MAX;
        const moving  = s.momentum != null && s.momentum < 0;
        const hasVol  = s.volume > 0;
        return inZone && moving && hasVol;
      })
    );
  }, [watchlist]);

  const addAlerts = useCallback((incoming) => {
    const freshIds = new Set();
    setAlerts(prev => {
      const seen  = new Set(prev.map(a => `${a.symbol}:${a.timestamp}`));
      const fresh = incoming.filter(a => !seen.has(`${a.symbol}:${a.timestamp}`));
      if (!fresh.length) return prev;
      fresh.forEach(a => freshIds.add(`${a.symbol}:${a.timestamp}`));
      return [...fresh, ...prev].slice(0, MAX_ALERTS);
    });
    if (freshIds.size) {
      setNewIds(prev => new Set([...prev, ...freshIds]));
      setTimeout(() => setNewIds(prev => {
        const n = new Set(prev);
        freshIds.forEach(id => n.delete(id));
        return n;
      }), 2500);
      setTab("ALERTS");
    }
  }, []);

  const updateWatchlist = useCallback((list) => {
    if (!list) return;
    // Track tier changes for escalation animation
    const prev = prevTiersRef.current;
    const next = {};
    list.forEach(s => { next[s.symbol] = s.tier; });
    prevTiersRef.current = next;
    setWatchlist(sortWatchlist(list));
  }, []);

  const dismissAlert = useCallback((alert) => {
    setAlerts(prev => prev.filter(a => !(a.symbol === alert.symbol && a.timestamp === alert.timestamp)));
  }, []);

  useEffect(() => {
    if (!socket) return;
    setConn(socket.connected);
    const onConn = () => setConn(true);
    const onDisc = () => setConn(false);
    socket.on("connect",           onConn);
    socket.on("disconnect",        onDisc);
    socket.on("circuit-alerts",    addAlerts);
    socket.on("circuit-watchlist", updateWatchlist);
    return () => {
      socket.off("connect",           onConn);
      socket.off("disconnect",        onDisc);
      socket.off("circuit-alerts",    addAlerts);
      socket.off("circuit-watchlist", updateWatchlist);
    };
  }, [socket, addAlerts, updateWatchlist]);

  // ── Filtered views ──────────────────────────────────────────────────────────
  const filteredWatch = useMemo(() => {
    return watchlist.filter(s => {
      if (!showSafe && s.tier === "SAFE") return false;
      if (tierFilter   !== "ALL" && s.tier   !== tierFilter)   return false;
      if (sideFilter   !== "ALL" && s.side   !== sideFilter)   return false;
      if (sectorFilter !== "ALL" && s.sector !== sectorFilter) return false;
      if (search && !s.symbol.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [watchlist, tierFilter, sideFilter, sectorFilter, search, showSafe]);

  const filteredAlerts = useMemo(() => {
    return alerts.filter(a => {
      if (tierFilter !== "ALL" && a.tier !== tierFilter) return false;
      if (sideFilter !== "ALL" && a.side !== sideFilter) return false;
      if (search && !a.symbol.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [alerts, tierFilter, sideFilter, search]);

  const tierCounts = useMemo(() => {
    const src = tab === "ALERTS" ? alerts : watchlist;
    return Object.fromEntries(
      ["LOCKED","CRITICAL","WARNING","WATCH","SAFE"].map(t => [t, src.filter(s => s.tier === t).length])
    );
  }, [tab, watchlist, alerts]);

  const alertCount  = alerts.filter(a => a.tier !== "SAFE").length;
  const radarCount  = radarList.length;

  const handleTierClick = (tier) => {
    setTierFilter(prev => prev === tier ? "ALL" : tier);
  };

  return (
    <div style={{ paddingBottom: 10, fontFamily: "'IBM Plex Mono', monospace" }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: C.blue, letterSpacing: "1.5px" }}>
            CIRCUIT MONITOR
          </span>
          <span className={connected ? "ca-dot-pulse" : ""} style={{
            width: 6, height: 6, borderRadius: "50%",
            background: connected ? C.green : C.red, display: "inline-block",
            boxShadow: connected ? `0 0 6px ${C.green}80` : "none",
          }} />
          <span style={{ fontSize: 9, color: C.textDim }}>{watchlist.length} stocks</span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <PillBtn active={expanded} onClick={() => setExpanded(e => !e)}>
            {expanded ? "COMPACT" : "EXPAND"}
          </PillBtn>
          {alertCount > 0 && (
            <PillBtn active={false} onClick={() => setAlerts([])}>
              CLEAR {alertCount}
            </PillBtn>
          )}
        </div>
      </div>

      {/* ── Summary strip (clickable) ────────────────────────────────────────── */}
      <SummaryStrip
        watchlist={watchlist} alerts={alerts}
        tab={tab} onTierClick={handleTierClick} tierFilter={tierFilter}
      />

      {/* ── Tabs ──────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        <TabBtn active={tab === "WATCHLIST"} onClick={() => setTab("WATCHLIST")}>
          📊 WATCHLIST ({watchlist.length})
        </TabBtn>
        <TabBtn active={tab === "ALERTS"} onClick={() => setTab("ALERTS")}>
          🔔 ALERTS{alertCount > 0 ? ` (${alertCount})` : ""}
        </TabBtn>
        <TabBtn active={tab === "RADAR"} onClick={() => setTab("RADAR")}>
          ⚡ RADAR{radarCount > 0 ? ` (${radarCount})` : ""}
        </TabBtn>
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 3, marginBottom: 5, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: C.textDim, pointerEvents: "none" }}>⌕</span>
          <input type="text" className="ca-input" placeholder="symbol..."
            value={search} onChange={e => setSearch(e.target.value)}
            style={{
              width: 78, paddingLeft: 18, paddingRight: 5, paddingTop: 3, paddingBottom: 3,
              background: "#041020", border: `1px solid ${C.borderFaint}`, borderRadius: 3,
              color: C.text, fontSize: 9, fontFamily: "'IBM Plex Mono', monospace",
            }} />
        </div>

        <PillBtn active={tierFilter === "ALL"} onClick={() => setTierFilter("ALL")}>ALL</PillBtn>
        {["LOCKED","CRITICAL","WARNING","WATCH"].map(t =>
          tierCounts[t] > 0 && (
            <PillBtn key={t} active={tierFilter === t} color={TIERS[t].color}
              onClick={() => handleTierClick(t)}>
              {t} {tierCounts[t]}
            </PillBtn>
          )
        )}

        <span style={{ width: 1, height: 11, background: C.border, flexShrink: 0 }} />

        <PillBtn active={sideFilter === "ALL"}   onClick={() => setSideFilter("ALL")}>BOTH</PillBtn>
        <PillBtn active={sideFilter === "UPPER"} color={C.green}
          onClick={() => setSideFilter(s => s === "UPPER" ? "ALL" : "UPPER")}>↑ UPR</PillBtn>
        <PillBtn active={sideFilter === "LOWER"} color={C.red}
          onClick={() => setSideFilter(s => s === "LOWER" ? "ALL" : "LOWER")}>↓ LWR</PillBtn>

        {tab === "WATCHLIST" && (
          <PillBtn active={showSafe} onClick={() => setShowSafe(s => !s)}>
            {showSafe ? "HIDE SAFE" : "+ SAFE"}
          </PillBtn>
        )}
      </div>

      {/* Sector row */}
      {tab === "WATCHLIST" && sectors.length > 2 && (
        <div style={{ display: "flex", gap: 3, marginBottom: 5, flexWrap: "wrap" }}>
          {sectors.slice(0, 14).map(s => (
            <PillBtn key={s} active={sectorFilter === s}
              onClick={() => setSector(sectorFilter === s && s !== "ALL" ? "ALL" : s)}
              style={{ fontSize: 8, padding: "1px 5px" }}>
              {s}
            </PillBtn>
          ))}
        </div>
      )}

      {/* ── WATCHLIST TAB ─────────────────────────────────────────────────────── */}
      {tab === "WATCHLIST" && (
        watchlist.length === 0
          ? (
            <div style={{ padding: "18px 0", textAlign: "center", fontSize: 11, color: C.textDim }}>
              {connected ? "Waiting for first poll (every 30s)…" : "⚠ Socket disconnected"}
            </div>
          ) : (
            <>
              <WatchHeader expanded={expanded} />
              {filteredWatch.length === 0
                ? <div style={{ padding: "10px 8px", fontSize: 10, color: C.textDim, textAlign: "center" }}>No stocks match filters</div>
                : filteredWatch.slice(0, watchPage).map((stock, i) => (
                    <WatchRow
                      key={stock.symbol} stock={stock} rank={i + 1}
                      expanded={expanded}
                      prevTier={prevTiersRef.current[stock.symbol]}
                    />
                  ))
              }
              {filteredWatch.length > watchPage && (
                <button onClick={() => setWatchPage(p => p + 30)} style={{
                  marginTop: 6, width: "100%", padding: "5px",
                  fontSize: 10, color: C.textMid,
                  background: "#041020", border: `1px solid ${C.borderFaint}`,
                  borderRadius: 4, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace",
                }}>
                  Show more ({filteredWatch.length - watchPage} remaining)
                </button>
              )}
              <div style={{ marginTop: 4, fontSize: 8, color: C.textGhost, textAlign: "right" }}>
                {Math.min(watchPage, filteredWatch.length)} / {filteredWatch.length} · sorted by urgency · polls every 30s
              </div>
            </>
          )
      )}

      {/* ── ALERTS TAB ────────────────────────────────────────────────────────── */}
      {tab === "ALERTS" && (
        filteredAlerts.length === 0
          ? (
            <div style={{ padding: "18px 0", textAlign: "center" }}>
              <div style={{ fontSize: 12, color: C.textDim }}>
                {alerts.length === 0 ? "No threshold breaches detected" : "No alerts match filters"}
              </div>
              <div style={{ marginTop: 5, fontSize: 9, color: C.textGhost }}>
                {connected
                  ? `${watchlist.length} stocks · Critical ≤1% · Warning ≤3% · Watch ≤${WATCH_PCT}%`
                  : "⚠ Socket disconnected"}
              </div>
            </div>
          ) : (
            filteredAlerts.map((alert, i) => (
              <AlertCard
                key={`${alert.symbol}:${alert.timestamp}:${i}`}
                alert={alert}
                onDismiss={dismissAlert}
                isNew={newAlertIds.has(`${alert.symbol}:${alert.timestamp}`)}
              />
            ))
          )
      )}

      {/* ── RADAR TAB ─────────────────────────────────────────────────────────── */}
      {tab === "RADAR" && (
        <>
          <div style={{ marginBottom: 8, padding: "5px 8px", borderRadius: 3, background: "rgba(255,214,10,0.04)", border: `1px solid rgba(255,214,10,0.15)` }}>
            <span style={{ fontSize: 9, color: "#ffd60a", fontWeight: 700 }}>⚡ PRE-CIRCUIT RADAR</span>
            <span style={{ fontSize: 8, color: C.textDim, marginLeft: 8 }}>
              Stocks 3–5% from circuit, moving toward limit with volume
            </span>
          </div>

          {radarList.length === 0
            ? (
              <div style={{ padding: "18px 0", textAlign: "center", fontSize: 11, color: C.textDim }}>
                No stocks in pre-circuit zone right now
                <div style={{ marginTop: 4, fontSize: 9, color: C.textGhost }}>
                  Zone: {PRE_CIRCUIT_MIN}–{PRE_CIRCUIT_MAX}% from circuit · toward limit · with volume
                </div>
              </div>
            ) : (
              <>
                <RadarHeader />
                {radarList.map((stock, i) => (
                  <RadarRow key={stock.symbol} stock={stock} rank={i + 1} />
                ))}
                <div style={{ marginTop: 4, fontSize: 8, color: C.textGhost, textAlign: "right" }}>
                  {radarList.length} stocks in zone · sorted by urgency
                </div>
              </>
            )
          }
        </>
      )}

    </div>
  );
}
