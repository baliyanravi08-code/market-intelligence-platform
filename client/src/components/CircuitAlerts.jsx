/**
 * CircuitAlerts.jsx
 * Location: client/src/components/CircuitAlerts.jsx
 *
 * UPDATED: Session 3 patch
 * - Listens to both "circuit-alerts" (threshold breaches) and "circuit-watchlist" (full 167-stock snapshot)
 * - Shows watchlist table sorted by closest-to-circuit when no threshold alerts exist
 * - ProximityBar now uses actual WATCH threshold (15%) not hardcoded 5
 * - tradedValue shows volume instead when value is 0
 * - Staleness badge on alerts older than 5 min
 */

import { useState, useEffect, useCallback, useRef } from "react";

// Must match TIER_THRESHOLDS.WATCH in circuitWatcher.js
const WATCH_THRESHOLD_PCT = 15;

const TIER_CONFIG = {
  LOCKED:   { label: "Locked",   color: "#E24B4A", bg: "rgba(226,75,74,0.10)",   border: "rgba(226,75,74,0.35)",   text: "#E24B4A" },
  CRITICAL: { label: "Critical", color: "#EF9F27", bg: "rgba(239,159,39,0.10)",  border: "rgba(239,159,39,0.35)",  text: "#EF9F27" },
  WARNING:  { label: "Warning",  color: "#F2C94C", bg: "rgba(242,201,76,0.08)",  border: "rgba(242,201,76,0.30)",  text: "#C9A800" },
  WATCH:    { label: "Watch",    color: "#378ADD", bg: "rgba(55,138,221,0.08)",   border: "rgba(55,138,221,0.25)",  text: "#378ADD" },
  SAFE:     { label: "Safe",     color: "#4CAF7D", bg: "transparent",             border: "transparent",            text: "#4CAF7D" },
};

const ACTION_LABELS = {
  UPPER_CIRCUIT_LOCKED: "🔒 Upper locked",
  LOWER_CIRCUIT_LOCKED: "🔒 Lower locked",
  UPPER_CIRCUIT_NEAR:   "↑ Upper near",
  LOWER_CIRCUIT_NEAR:   "↓ Lower near",
};

const MAX_ALERTS    = 25;
const STALE_MS      = 5 * 60 * 1000; // 5 min

function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-IN", {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function fmtVol(volume) {
  if (!volume || volume === 0) return null;
  if (volume >= 1_00_00_000) return `${(volume / 1_00_00_000).toFixed(1)}Cr`;
  if (volume >= 1_00_000)    return `${(volume / 1_00_000).toFixed(1)}L`;
  if (volume >= 1_000)       return `${(volume / 1_000).toFixed(1)}K`;
  return String(volume);
}

function timeStr(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function isStale(iso) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > STALE_MS;
}

// ProximityBar — uses WATCH_THRESHOLD_PCT so fill is meaningful
function ProximityBar({ distPct, side, tier }) {
  const cap     = WATCH_THRESHOLD_PCT;
  const fillPct = tier === "LOCKED" ? 100 : Math.max(0, Math.min(100, ((cap - distPct) / cap) * 100));
  const cfg     = TIER_CONFIG[tier] || TIER_CONFIG.SAFE;
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
          transition: "width 0.4s ease",
        }} />
      </div>
    </div>
  );
}

function AlertCard({ alert }) {
  const cfg    = TIER_CONFIG[alert.tier] || TIER_CONFIG.WATCH;
  const isUp   = (alert.changePercent || 0) >= 0;
  const stale  = isStale(alert.timestamp);
  const volStr = fmtVol(alert.volume);

  return (
    <div style={{
      padding: "12px 14px", borderRadius: 10,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      marginBottom: 8,
      opacity: stale ? 0.65 : 1,
    }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--color-text-primary)", letterSpacing: "0.02em" }}>
            {alert.symbol}
          </span>
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4, background: cfg.color, color: "#fff", letterSpacing: "0.05em" }}>
            {cfg.label.toUpperCase()}
          </span>
          <span style={{ fontSize: 11, color: cfg.text, background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 4, padding: "1px 6px" }}>
            {ACTION_LABELS[alert.action] || alert.action}
          </span>
          {stale && (
            <span style={{ fontSize: 10, color: "var(--color-text-tertiary)", background: "rgba(255,255,255,0.05)", border: "1px solid var(--color-border-tertiary)", borderRadius: 4, padding: "1px 5px" }}>
              stale
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
          {timeStr(alert.timestamp)}
        </span>
      </div>

      {/* Price */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
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
      <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11, color: "var(--color-text-secondary)", flexWrap: "wrap" }}>
        {volStr && <span>Vol: {volStr}</span>}
        <span>{alert.side === "UPPER" ? "↑ Upper" : "↓ Lower"} band · ±{alert.bandPct}%</span>
      </div>
    </div>
  );
}

// Compact watchlist row — shown when no threshold alerts, sorted by proximity
function WatchRow({ stock, rank }) {
  const isUp  = (stock.changePercent || 0) >= 0;
  const cfg   = TIER_CONFIG[stock.tier] || TIER_CONFIG.SAFE;
  const isSafe = stock.tier === "SAFE";

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "24px 90px 80px 70px 1fr 70px",
      alignItems: "center",
      gap: 6,
      padding: "6px 10px",
      borderRadius: 7,
      background: isSafe ? "transparent" : cfg.bg,
      borderBottom: "1px solid var(--color-border-tertiary)",
      fontSize: 12,
    }}>
      <span style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>{rank}</span>
      <span style={{ fontWeight: 600, color: "var(--color-text-primary)", fontSize: 13 }}>{stock.symbol}</span>
      <span style={{ color: isUp ? "var(--color-text-success)" : "var(--color-text-danger)", fontWeight: 500 }}>
        ₹{fmt(stock.ltp, 1)}
        <span style={{ marginLeft: 4, fontSize: 11 }}>{isUp ? "+" : ""}{fmt(stock.changePercent, 1)}%</span>
      </span>
      <span style={{ color: cfg.text, fontWeight: 500, fontSize: 11 }}>
        {stock.tier === "LOCKED" ? "AT LIMIT" : `${fmt(stock.distPct, 1)}% away`}
      </span>
      {/* proximity bar inline */}
      <div style={{ height: 4, borderRadius: 2, background: "var(--color-border-tertiary)", overflow: "hidden", position: "relative" }}>
        {(() => {
          const fillPct = stock.tier === "LOCKED" ? 100 : Math.max(0, Math.min(100, ((WATCH_THRESHOLD_PCT - stock.distPct) / WATCH_THRESHOLD_PCT) * 100));
          return (
            <div style={{
              position: "absolute",
              height: "100%",
              width: `${fillPct}%`,
              background: cfg.color,
              borderRadius: 2,
              [stock.side === "UPPER" ? "right" : "left"]: 0,
            }} />
          );
        })()}
      </div>
      <span style={{ color: "var(--color-text-tertiary)", fontSize: 11, textAlign: "right" }}>
        {stock.side === "UPPER" ? "↑" : "↓"} {stock.bandPct}%
      </span>
    </div>
  );
}

export default function CircuitAlerts({ socket }) {
  const [alerts,     setAlerts]    = useState([]);
  const [watchlist,  setWatchlist] = useState([]);
  const [filter,     setFilter]    = useState("ALL");
  const [sideFilter, setSide]      = useState("ALL");
  const [connected,  setConn]      = useState(false);
  const [tab,        setTab]       = useState("ALERTS"); // "ALERTS" | "WATCHLIST"
  const [watchLimit, setWatchLimit] = useState(20);

  const addAlerts = useCallback((incoming) => {
    setAlerts((prev) => {
      const seen  = new Set(prev.map((a) => `${a.symbol}:${a.timestamp}`));
      const fresh = incoming.filter((a) => !seen.has(`${a.symbol}:${a.timestamp}`));
      if (!fresh.length) return prev;
      return [...fresh, ...prev].slice(0, MAX_ALERTS);
    });
    // Auto-switch to alerts tab when new ones arrive
    setTab("ALERTS");
  }, []);

  const updateWatchlist = useCallback((list) => {
    setWatchlist(list || []);
  }, []);

  useEffect(() => {
    if (!socket) return;
    setConn(socket.connected);
    const onConnect    = () => setConn(true);
    const onDisconnect = () => setConn(false);
    socket.on("connect",           onConnect);
    socket.on("disconnect",        onDisconnect);
    socket.on("circuit-alerts",    addAlerts);
    socket.on("circuit-watchlist", updateWatchlist);
    return () => {
      socket.off("connect",           onConnect);
      socket.off("disconnect",        onDisconnect);
      socket.off("circuit-alerts",    addAlerts);
      socket.off("circuit-watchlist", updateWatchlist);
    };
  }, [socket, addAlerts, updateWatchlist]);

  const visible = alerts.filter((a) => {
    if (filter     !== "ALL" && a.tier !== filter)     return false;
    if (sideFilter !== "ALL" && a.side !== sideFilter) return false;
    return true;
  });

  const tierCounts = {
    LOCKED:   alerts.filter((a) => a.tier === "LOCKED").length,
    CRITICAL: alerts.filter((a) => a.tier === "CRITICAL").length,
    WARNING:  alerts.filter((a) => a.tier === "WARNING").length,
    WATCH:    alerts.filter((a) => a.tier === "WATCH").length,
  };

  // watchlist: show only stocks within WATCH threshold by default, sorted closest first
  const watchVisible = watchlist
    .filter((s) => s.tier !== "SAFE")
    .slice(0, watchLimit);

  const pill = (active, color) => ({
    padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 500,
    cursor: "pointer", border: "1px solid",
    borderColor: active ? (color || "var(--color-border-primary)") : "var(--color-border-tertiary)",
    background:  active ? (color ? color + "22" : "var(--color-background-secondary)") : "transparent",
    color:       active ? (color || "var(--color-text-primary)") : "var(--color-text-secondary)",
    transition:  "all 0.15s ease",
  });

  const tabBtn = (active) => ({
    padding: "4px 14px", borderRadius: 6, fontSize: 12, fontWeight: 500,
    cursor: "pointer", border: "1px solid",
    borderColor: active ? "var(--color-border-primary)" : "var(--color-border-tertiary)",
    background:  active ? "var(--color-background-secondary)" : "transparent",
    color:       active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
  });

  return (
    <div style={{ padding: "0 0 16px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text-primary)" }}>Circuit Alerts</span>
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: connected ? "var(--color-text-success)" : "var(--color-text-danger)",
            display: "inline-block",
          }} />
          {alerts.length > 0 && (
            <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>
              {alerts.length} alert{alerts.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        {alerts.length > 0 && (
          <button
            onClick={() => setAlerts([])}
            style={{ fontSize: 11, color: "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <button style={tabBtn(tab === "ALERTS")}    onClick={() => setTab("ALERTS")}>
          🔔 Alerts {alerts.length > 0 ? `(${alerts.length})` : ""}
        </button>
        <button style={tabBtn(tab === "WATCHLIST")} onClick={() => setTab("WATCHLIST")}>
          📊 Watchlist {watchlist.length > 0 ? `(${watchlist.length})` : ""}
        </button>
      </div>

      {/* ── ALERTS TAB ── */}
      {tab === "ALERTS" && (
        <>
          {/* Filter pills */}
          {alerts.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <button style={pill(filter === "ALL")} onClick={() => setFilter("ALL")}>All ({alerts.length})</button>
              {Object.entries(tierCounts).map(([tier, count]) =>
                count > 0 ? (
                  <button key={tier} style={pill(filter === tier, TIER_CONFIG[tier]?.color)} onClick={() => setFilter(filter === tier ? "ALL" : tier)}>
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

          {visible.length === 0 ? (
            <div style={{ padding: "16px 0", textAlign: "center" }}>
              <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
                {alerts.length === 0
                  ? "No stocks have breached alert thresholds"
                  : "No alerts match current filters"}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-tertiary)", opacity: 0.6 }}>
                {connected
                  ? watchlist.length > 0
                    ? `Watching ${watchlist.length} stocks · Switch to Watchlist tab to see proximity`
                    : "Polling every 30s · Thresholds: Critical ≤1% · Warning ≤3% · Watch ≤15%"
                  : "Socket disconnected · Reconnecting…"}
              </div>
            </div>
          ) : (
            visible.map((alert, i) => (
              <AlertCard key={`${alert.symbol}:${alert.timestamp}:${i}`} alert={alert} />
            ))
          )}
        </>
      )}

      {/* ── WATCHLIST TAB ── */}
      {tab === "WATCHLIST" && (
        <>
          {watchlist.length === 0 ? (
            <div style={{ padding: "16px 0", textAlign: "center" }}>
              <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
                {connected ? "Waiting for first poll (every 30s)…" : "Socket disconnected · Reconnecting…"}
              </div>
            </div>
          ) : (
            <>
              {/* Column headers */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "24px 90px 80px 70px 1fr 70px",
                gap: 6, padding: "4px 10px", marginBottom: 2,
                fontSize: 10, color: "var(--color-text-tertiary)", fontWeight: 600, letterSpacing: "0.05em",
              }}>
                <span>#</span>
                <span>SYMBOL</span>
                <span>LTP / CHG</span>
                <span>DISTANCE</span>
                <span>PROXIMITY</span>
                <span style={{ textAlign: "right" }}>BAND</span>
              </div>

              {watchVisible.length === 0 ? (
                <div style={{ padding: "12px 10px", fontSize: 12, color: "var(--color-text-tertiary)", textAlign: "center" }}>
                  All {watchlist.length} stocks are &gt;{WATCH_THRESHOLD_PCT}% from circuit limits — market is calm
                </div>
              ) : (
                watchVisible.map((stock, i) => (
                  <WatchRow key={stock.symbol} stock={stock} rank={i + 1} />
                ))
              )}

              {watchlist.filter((s) => s.tier !== "SAFE").length > watchLimit && (
                <button
                  onClick={() => setWatchLimit((l) => l + 20)}
                  style={{ marginTop: 8, width: "100%", padding: "6px", fontSize: 12, color: "var(--color-text-secondary)", background: "none", border: "1px solid var(--color-border-tertiary)", borderRadius: 6, cursor: "pointer" }}
                >
                  Show more
                </button>
              )}

              <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-tertiary)", textAlign: "right" }}>
                {watchlist.filter((s) => s.tier !== "SAFE").length} of {watchlist.length} stocks within {WATCH_THRESHOLD_PCT}% of circuit
              </div>
            </>
          )}
        </>
      )}

    </div>
  );
}
