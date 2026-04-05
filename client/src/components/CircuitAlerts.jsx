/**
 * CircuitAlerts.jsx
 * Location: client/src/components/CircuitAlerts.jsx
 *
 * Wire into App.jsx:
 *   import CircuitAlerts from './components/CircuitAlerts';
 *   <CircuitAlerts socket={socket} />
 */

import { useState, useEffect, useCallback } from "react";

const TIER_CONFIG = {
  LOCKED:   { label: "Locked",   color: "#E24B4A", bg: "rgba(226,75,74,0.10)",   border: "rgba(226,75,74,0.35)",   text: "#E24B4A" },
  CRITICAL: { label: "Critical", color: "#EF9F27", bg: "rgba(239,159,39,0.10)",  border: "rgba(239,159,39,0.35)",  text: "#BA7517" },
  WARNING:  { label: "Warning",  color: "#F2C94C", bg: "rgba(242,201,76,0.08)",  border: "rgba(242,201,76,0.30)",  text: "#856B00" },
  WATCH:    { label: "Watch",    color: "#378ADD", bg: "rgba(55,138,221,0.08)",   border: "rgba(55,138,221,0.25)",  text: "#185FA5" },
};

const ACTION_LABELS = {
  UPPER_CIRCUIT_LOCKED: "🔒 Upper locked",
  LOWER_CIRCUIT_LOCKED: "🔒 Lower locked",
  UPPER_CIRCUIT_NEAR:   "↑ Upper near",
  LOWER_CIRCUIT_NEAR:   "↓ Lower near",
};

const MAX_ALERTS = 25;

function fmt(n, dec = 2) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-IN", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function fmtCr(val) {
  const cr = val / 1_00_00_000;
  return cr >= 100 ? `₹${(cr / 100).toFixed(1)}k Cr` : `₹${cr.toFixed(1)} Cr`;
}

function timeStr(iso) {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function ProximityBar({ distPct, side, tier }) {
  const fillPct = Math.max(0, Math.min(100, ((5 - distPct) / 5) * 100));
  const cfg = TIER_CONFIG[tier];
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 3 }}>
        <span>{side === "UPPER" ? "Upper circuit proximity" : "Lower circuit proximity"}</span>
        <span style={{ color: cfg.text, fontWeight: 500 }}>
          {tier === "LOCKED" ? "AT LIMIT" : `${fmt(distPct, 2)}% away`}
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: "var(--color-border-tertiary)", overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: `${fillPct}%`,
          background: cfg.color,
          borderRadius: 3,
          float: side === "UPPER" ? "right" : "left",
        }} />
      </div>
    </div>
  );
}

function AlertCard({ alert }) {
  const cfg  = TIER_CONFIG[alert.tier];
  const isUp = (alert.changePercent || 0) >= 0;
  return (
    <div style={{ padding: "12px 14px", borderRadius: 10, background: cfg.bg, border: `1px solid ${cfg.border}`, marginBottom: 8 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text-primary)", letterSpacing: "0.02em" }}>
            {alert.symbol}
          </span>
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4, background: cfg.color, color: "#fff", letterSpacing: "0.05em" }}>
            {cfg.label.toUpperCase()}
          </span>
          <span style={{ fontSize: 11, color: cfg.text, background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 4, padding: "1px 6px" }}>
            {ACTION_LABELS[alert.action] || alert.action}
          </span>
        </div>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
          {timeStr(alert.timestamp)}
        </span>
      </div>

      {/* Price */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 8 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: "var(--color-text-primary)" }}>
          ₹{fmt(alert.ltp)}
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, color: isUp ? "var(--color-text-success)" : "var(--color-text-danger)" }}>
          {isUp ? "+" : ""}{fmt(alert.changePercent, 2)}%
        </span>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Prev ₹{fmt(alert.prevClose)} · Circuit ₹{fmt(alert.circuitLimit)} (±{alert.bandPct}%)
        </span>
      </div>

      {/* Bar */}
      <ProximityBar distPct={alert.distPct} side={alert.side} tier={alert.tier} />

      {/* Footer */}
      <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "var(--color-text-secondary)" }}>
        <span>Vol: {fmtCr(alert.tradedValue)}</span>
        <span>·</span>
        <span>{alert.side === "UPPER" ? "Upper" : "Lower"} band · ±{alert.bandPct}%</span>
      </div>
    </div>
  );
}

export default function CircuitAlerts({ socket }) {
  const [alerts,    setAlerts]  = useState([]);
  const [filter,    setFilter]  = useState("ALL");
  const [sideFilter, setSide]   = useState("ALL");
  const [connected, setConn]    = useState(false);

  const addAlerts = useCallback((incoming) => {
    setAlerts((prev) => {
      const seen  = new Set(prev.map((a) => `${a.symbol}:${a.timestamp}`));
      const fresh = incoming.filter((a) => !seen.has(`${a.symbol}:${a.timestamp}`));
      if (!fresh.length) return prev;
      return [...fresh, ...prev].slice(0, MAX_ALERTS);
    });
  }, []);

  useEffect(() => {
    if (!socket) return;
    socket.on("connect",       () => setConn(true));
    socket.on("disconnect",    () => setConn(false));
    socket.on("circuit-alerts", addAlerts);
    setConn(socket.connected);
    return () => { socket.off("circuit-alerts", addAlerts); };
  }, [socket, addAlerts]);

  const visible = alerts.filter((a) => {
    if (filter    !== "ALL" && a.tier  !== filter)    return false;
    if (sideFilter !== "ALL" && a.side !== sideFilter) return false;
    return true;
  });

  const tierCounts = {
    LOCKED:   alerts.filter((a) => a.tier === "LOCKED").length,
    CRITICAL: alerts.filter((a) => a.tier === "CRITICAL").length,
    WARNING:  alerts.filter((a) => a.tier === "WARNING").length,
    WATCH:    alerts.filter((a) => a.tier === "WATCH").length,
  };

  const pill = (active) => ({
    padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 500,
    cursor: "pointer", border: "1px solid",
    borderColor: active ? "var(--color-border-primary)" : "var(--color-border-tertiary)",
    background:  active ? "var(--color-background-secondary)" : "transparent",
    color:       active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
  });

  return (
    <div style={{ padding: "0 0 16px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>Circuit Alerts</span>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? "var(--color-text-success)" : "var(--color-text-danger)", display: "inline-block" }} />
          {alerts.length > 0 && (
            <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{alerts.length} alert{alerts.length !== 1 ? "s" : ""}</span>
          )}
        </div>
        {alerts.length > 0 && (
          <button onClick={() => setAlerts([])} style={{ fontSize: 11, color: "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}>
            Clear
          </button>
        )}
      </div>

      {/* Filter pills */}
      {alerts.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          <button style={pill(filter === "ALL")} onClick={() => setFilter("ALL")}>All ({alerts.length})</button>
          {Object.entries(tierCounts).map(([tier, count]) =>
            count > 0 ? (
              <button key={tier} style={pill(filter === tier)} onClick={() => setFilter(filter === tier ? "ALL" : tier)}>
                {TIER_CONFIG[tier].label} ({count})
              </button>
            ) : null
          )}
          <span style={{ width: 1, background: "var(--color-border-tertiary)", margin: "0 4px" }} />
          <button style={pill(sideFilter === "ALL")}   onClick={() => setSide("ALL")}>Both</button>
          <button style={pill(sideFilter === "UPPER")} onClick={() => setSide((s) => s === "UPPER" ? "ALL" : "UPPER")}>↑ Upper</button>
          <button style={pill(sideFilter === "LOWER")} onClick={() => setSide((s) => s === "LOWER" ? "ALL" : "LOWER")}>↓ Lower</button>
        </div>
      )}

      {/* Cards */}
      {visible.length === 0 ? (
        <div style={{ padding: "28px 0", textAlign: "center", fontSize: 13, color: "var(--color-text-tertiary)" }}>
          {alerts.length === 0 ? "Watching for circuit proximity…" : "No alerts match current filters"}
        </div>
      ) : (
        visible.map((alert, i) => (
          <AlertCard key={`${alert.symbol}:${alert.timestamp}:${i}`} alert={alert} />
        ))
      )}
    </div>
  );
}
