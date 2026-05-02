/**
 * SmartCircuitPage.jsx
 * client/src/pages/SmartCircuitPage.jsx
 *
 * Replaces: ScoresPage.jsx + CircuitAlerts.jsx (old)
 *
 * Shows:
 *   1. LIVE WATCHLIST — stocks approaching circuits (scored, tiered)
 *   2. TRAP ALERTS — stocks hitting circuit in opening 30 min
 *   3. MAGNET STOCKS — approaching same circuit 3+ days
 *   4. RECENT ALERTS — timestamped alert log
 */

import { useEffect, useState, useRef } from "react";

const TIER_CONFIG = {
  LOCKED:   { color: "#ff2d55", bg: "#1a0010", label: "CIRCUIT LOCKED",   icon: "🔒" },
  CRITICAL: { color: "#ff5c5c", bg: "#1a0008", label: "CRITICAL",         icon: "🔴" },
  WARNING:  { color: "#ff8c00", bg: "#1a0e00", label: "WARNING",          icon: "🟠" },
  WATCH:    { color: "#ffd54f", bg: "#1a1500", label: "WATCH",            icon: "🟡" },
  SAFE:     { color: "#4a9abb", bg: "#010a18", label: "SAFE",             icon: "⚪" },
};

const SIDE_CONFIG = {
  UPPER: { color: "#00ff9c", label: "UPPER ↑", icon: "🟢" },
  LOWER: { color: "#ff5c5c", label: "LOWER ↓", icon: "🔴" },
};

function formatTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

function toAgo(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── Score bar ──────────────────────────────────────────────────────────────────
function ScoreBar({ score, tier }) {
  const cfg = TIER_CONFIG[tier] || TIER_CONFIG.SAFE;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: "#0a1828", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${score}%`, background: cfg.color, borderRadius: 2, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono, monospace", color: cfg.color, minWidth: 24 }}>{score}</span>
    </div>
  );
}

// ── Circuit stock card ─────────────────────────────────────────────────────────
function CircuitCard({ entry }) {
  const tier = TIER_CONFIG[entry.tier] || TIER_CONFIG.SAFE;
  const side = SIDE_CONFIG[entry.side] || SIDE_CONFIG.UPPER;

  return (
    <div style={{
      background: tier.bg,
      border: `1px solid ${tier.color}33`,
      borderLeft: `3px solid ${tier.color}`,
      borderRadius: 5, padding: "10px 12px", marginBottom: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, fontSize: 13, color: "#d8eeff" }}>
            {entry.symbol}
          </span>
          {entry.trapAlert && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "#1a0020", color: "#ff2d55", border: "1px solid #ff2d5544" }}>
              ⚡ TRAP
            </span>
          )}
          {entry.magnetAlert && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "#0a1a30", color: "#00cfff", border: "1px solid #00cfff44" }}>
              🧲 MAGNET
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, fontFamily: "IBM Plex Mono, monospace", color: "#4a9abb" }}>
            ₹{entry.ltp?.toLocaleString("en-IN")}
          </span>
          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: `${tier.color}18`, color: tier.color, border: `1px solid ${tier.color}40` }}>
            {tier.icon} {tier.label}
          </span>
        </div>
      </div>

      <ScoreBar score={entry.score} tier={entry.tier} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <span style={{ fontSize: 10, fontFamily: "IBM Plex Mono, monospace", color: side.color }}>
            {side.icon} {side.label} Circuit
          </span>
          <span style={{ fontSize: 10, fontFamily: "IBM Plex Mono, monospace", color: "#7ab0d0" }}>
            {entry.distPct}% away
          </span>
        </div>
        <span style={{ fontSize: 9, color: "#2a5070", fontFamily: "IBM Plex Mono, monospace" }}>
          {toAgo(entry.updatedAt)}
        </span>
      </div>

      {entry.trapMsg && (
        <div style={{ marginTop: 6, fontSize: 9, color: "#ff6080", fontFamily: "IBM Plex Mono, monospace", fontStyle: "italic" }}>
          {entry.trapMsg}
        </div>
      )}
      {entry.magnetMsg && !entry.trapMsg && (
        <div style={{ marginTop: 6, fontSize: 9, color: "#00cfff", fontFamily: "IBM Plex Mono, monospace", fontStyle: "italic" }}>
          {entry.magnetMsg}
        </div>
      )}
    </div>
  );
}

// ── Alert row ──────────────────────────────────────────────────────────────────
function AlertRow({ alert }) {
  const tier = TIER_CONFIG[alert.tier] || TIER_CONFIG.WATCH;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "7px 10px",
      borderBottom: "1px solid #0a1828",
      background: alert.trap ? "#0d0010" : alert.magnet ? "#030d1a" : "transparent",
    }}>
      <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "IBM Plex Mono, monospace", color: "#00cfff", minWidth: 70 }}>
        {alert.symbol}
      </span>
      <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono, monospace", color: tier.color, minWidth: 60 }}>
        {tier.icon} {alert.tier}
      </span>
      <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono, monospace", color: "#4a9abb", minWidth: 40 }}>
        {alert.distPct}%
      </span>
      <span style={{ fontSize: 9, flex: 1, color: "#7ab0d0" }}>{alert.msg}</span>
      <span style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace", flexShrink: 0 }}>
        {formatTime(alert.timestamp)}
      </span>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function SmartCircuitPage({ socket }) {
  const [watchlist,   setWatchlist]   = useState([]);
  const [alerts,      setAlerts]      = useState([]);
  const [activeTab,   setActiveTab]   = useState("watchlist");
  const [filterTier,  setFilterTier]  = useState("ALL");
  const [filterSide,  setFilterSide]  = useState("ALL");
  const [connected,   setConnected]   = useState(false);

  useEffect(() => {
    if (!socket) return;

    setConnected(socket.connected);

    socket.on("connect",    () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("circuit-watchlist", (data) => {
      if (Array.isArray(data)) setWatchlist(data);
    });

    socket.on("circuit-alerts", (data) => {
      if (!Array.isArray(data)) return;
      setAlerts(prev => {
        const combined = [...data, ...prev];
        const seen = new Set();
        return combined.filter(a => {
          const key = `${a.symbol}:${a.timestamp}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 100);
      });
    });

    return () => {
      socket.off("circuit-watchlist");
      socket.off("circuit-alerts");
      socket.off("connect");
      socket.off("disconnect");
    };
  }, [socket]);

  // Filter watchlist
  const filtered = watchlist.filter(e => {
    if (filterTier !== "ALL" && e.tier !== filterTier) return false;
    if (filterSide !== "ALL" && e.side !== filterSide) return false;
    return true;
  });

  const trapAlerts   = watchlist.filter(e => e.trapAlert);
  const magnetAlerts = watchlist.filter(e => e.magnetAlert);
  const criticalCount = watchlist.filter(e => e.score >= 65).length;

  const TABS = [
    { key: "watchlist", label: `📋 Watchlist (${filtered.length})` },
    { key: "traps",     label: `⚡ Traps (${trapAlerts.length})` },
    { key: "magnets",   label: `🧲 Magnets (${magnetAlerts.length})` },
    { key: "alerts",    label: `🔔 Alert Log (${alerts.length})` },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#010812", color: "#d8eeff", fontFamily: "system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ padding: "12px 16px", background: "linear-gradient(90deg, #020d1f, #041828)", borderBottom: "1px solid #0d3560", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, fontWeight: 700, color: "#00cfff", letterSpacing: 1 }}>
              🔔 SMART CIRCUIT TRACKER
            </div>
            <div style={{ fontSize: 10, color: "#2a7090", marginTop: 2 }}>
              Trap detection · Magnet patterns · Real-time proximity scoring
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {criticalCount > 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "IBM Plex Mono, monospace", padding: "3px 10px", borderRadius: 4, background: "#1a0008", color: "#ff5c5c", border: "1px solid #ff5c5c44" }}>
                ⚠ {criticalCount} CRITICAL
              </span>
            )}
            <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono, monospace", color: connected ? "#00ff9c" : "#ff5c5c" }}>
              {connected ? "● LIVE" : "○ OFFLINE"}
            </span>
          </div>
        </div>

        {/* Stat chips */}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {[
            { label: "Tracking", value: watchlist.length, color: "#4a9abb" },
            { label: "Critical", value: watchlist.filter(e => e.score >= 85).length, color: "#ff5c5c" },
            { label: "Warning",  value: watchlist.filter(e => e.score >= 65 && e.score < 85).length, color: "#ff8c00" },
            { label: "Traps",    value: trapAlerts.length, color: "#ff2d55" },
            { label: "Magnets",  value: magnetAlerts.length, color: "#00cfff" },
          ].map(s => (
            <div key={s.label} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 9, fontFamily: "IBM Plex Mono, monospace", padding: "2px 8px", borderRadius: 3, background: `${s.color}12`, border: `1px solid ${s.color}33`, color: s.color }}>
              <span style={{ fontWeight: 700 }}>{s.value}</span>
              <span style={{ opacity: 0.7 }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, background: "#010a18", borderBottom: "1px solid #0d3560", flexShrink: 0, overflowX: "auto" }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
            background: activeTab === t.key ? "#031428" : "transparent",
            border: "none", borderBottom: activeTab === t.key ? "2px solid #00cfff" : "2px solid transparent",
            color: activeTab === t.key ? "#00cfff" : "#4a7090",
            fontSize: 11, fontFamily: "IBM Plex Mono, monospace", padding: "8px 14px",
            cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.15s",
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters — only for watchlist tab */}
      {activeTab === "watchlist" && (
        <div style={{ display: "flex", gap: 6, padding: "8px 16px", background: "#010a18", borderBottom: "1px solid #0a2040", flexShrink: 0, flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace", alignSelf: "center" }}>TIER:</span>
          {["ALL", "LOCKED", "CRITICAL", "WARNING", "WATCH"].map(t => (
            <button key={t} onClick={() => setFilterTier(t)} style={{
              fontSize: 9, fontFamily: "IBM Plex Mono, monospace", padding: "2px 8px", borderRadius: 3, cursor: "pointer",
              background: filterTier === t ? "#0d3060" : "transparent",
              border: filterTier === t ? "1px solid #4a9abb" : "1px solid #0d2040",
              color: filterTier === t ? "#d8eeff" : "#4a7090",
            }}>{t}</button>
          ))}
          <span style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace", alignSelf: "center", marginLeft: 8 }}>SIDE:</span>
          {["ALL", "UPPER", "LOWER"].map(s => (
            <button key={s} onClick={() => setFilterSide(s)} style={{
              fontSize: 9, fontFamily: "IBM Plex Mono, monospace", padding: "2px 8px", borderRadius: 3, cursor: "pointer",
              background: filterSide === s ? "#0d3060" : "transparent",
              border: filterSide === s ? "1px solid #4a9abb" : "1px solid #0d2040",
              color: filterSide === s ? "#d8eeff" : "#4a7090",
            }}>{s}</button>
          ))}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>

        {/* WATCHLIST TAB */}
        {activeTab === "watchlist" && (
          <>
            {filtered.length === 0 ? (
              <div style={{ textAlign: "center", color: "#1a5070", padding: "60px 20px", fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🔔</div>
                {watchlist.length === 0
                  ? "Waiting for circuit data... Scanner runs during market hours."
                  : "No stocks match the current filters."}
              </div>
            ) : filtered.map(e => <CircuitCard key={e.symbol} entry={e} />)}
          </>
        )}

        {/* TRAPS TAB */}
        {activeTab === "traps" && (
          <>
            <div style={{ fontSize: 10, color: "#4a7090", marginBottom: 12, fontFamily: "IBM Plex Mono, monospace" }}>
              Stocks hitting circuit proximity within first 30 minutes of market open. High probability of trapped operators.
            </div>
            {trapAlerts.length === 0 ? (
              <div style={{ textAlign: "center", color: "#1a5070", padding: "60px 20px", fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
                No trap alerts today. Traps appear in first 30 min of market open.
              </div>
            ) : trapAlerts.map(e => <CircuitCard key={e.symbol} entry={e} />)}
          </>
        )}

        {/* MAGNETS TAB */}
        {activeTab === "magnets" && (
          <>
            <div style={{ fontSize: 10, color: "#4a7090", marginBottom: 12, fontFamily: "IBM Plex Mono, monospace" }}>
              Stocks approaching the same circuit for 3+ consecutive days. High momentum pattern.
            </div>
            {magnetAlerts.length === 0 ? (
              <div style={{ textAlign: "center", color: "#1a5070", padding: "60px 20px", fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🧲</div>
                No magnet patterns detected. Requires 3+ days of consecutive circuit approach.
              </div>
            ) : magnetAlerts.map(e => <CircuitCard key={e.symbol} entry={e} />)}
          </>
        )}

        {/* ALERT LOG TAB */}
        {activeTab === "alerts" && (
          <div style={{ background: "#010a18", border: "1px solid #0d2040", borderRadius: 5, overflow: "hidden" }}>
            <div style={{ padding: "8px 10px", background: "#020d1f", borderBottom: "1px solid #0d2040", fontSize: 10, fontFamily: "IBM Plex Mono, monospace", color: "#4a9abb" }}>
              CIRCUIT ALERT LOG · {alerts.length} events
            </div>
            {alerts.length === 0 ? (
              <div style={{ textAlign: "center", color: "#1a5070", padding: "40px 20px", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 }}>
                No alerts yet this session
              </div>
            ) : alerts.map((a, i) => <AlertRow key={i} alert={a} />)}
          </div>
        )}
      </div>
    </div>
  );
}