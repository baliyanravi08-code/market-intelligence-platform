/**
 * BacktestLab.jsx
 * Place at: src/components/BacktestLab.jsx  (or wherever your components live)
 *
 * Import in MarketScanner.jsx:
 *   import BacktestLab from "./BacktestLab";
 *   // Replace your existing <BacktestLab> modal with this component
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Utility ───────────────────────────────────────────────────────────────────
const fmt  = (n) => n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtP = (n) => n == null ? "—" : "₹" + parseFloat(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const clr  = (v) => v > 0 ? "#00e676" : v < 0 ? "#ff5252" : "#aaa";

const SIGNAL_COLORS = {
  "STRONG BUY":  "#00e676",
  "BUY":         "#69f0ae",
  "HOLD":        "#ffd740",
  "SELL":        "#ff6e6e",
  "STRONG SELL": "#ff1744",
};

const STATUS_META = {
  WIN:         { label: "WIN",     bg: "rgba(0,230,118,0.15)",  color: "#00e676", icon: "✅" },
  MANUAL_WIN:  { label: "WIN ✋",  bg: "rgba(0,230,118,0.10)",  color: "#00e676", icon: "✅" },
  LOSS:        { label: "LOSS",    bg: "rgba(255,82,82,0.15)",  color: "#ff5252", icon: "❌" },
  MANUAL_LOSS: { label: "LOSS ✋", bg: "rgba(255,82,82,0.10)",  color: "#ff5252", icon: "❌" },
  PENDING:     { label: "LIVE",    bg: "rgba(255,215,64,0.12)", color: "#ffd740", icon: "🔴" },
  EXPIRED:     { label: "EXPRD",   bg: "rgba(100,100,100,0.2)", color: "#888",    icon: "⏱" },
};

// ── Mini bar chart ────────────────────────────────────────────────────────────
function MiniBar({ wins, losses, total }) {
  if (!total) return <span style={{ color: "#555", fontSize: 11 }}>No data</span>;
  const pct = Math.round((wins / total) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: "#1a1a2e", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: pct + "%", height: "100%", background: pct >= 60 ? "#00e676" : pct >= 45 ? "#ffd740" : "#ff5252", borderRadius: 3, transition: "width 0.6s ease" }} />
      </div>
      <span style={{ fontSize: 12, color: pct >= 60 ? "#00e676" : pct >= 45 ? "#ffd740" : "#ff5252", minWidth: 32 }}>{pct}%</span>
      <span style={{ fontSize: 11, color: "#555" }}>{wins}W/{losses}L</span>
    </div>
  );
}

// ── Accuracy row ──────────────────────────────────────────────────────────────
function AccRow({ label, data, highlight }) {
  if (!data) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <div style={{ width: 90, fontSize: 12, color: highlight ? "#ffd740" : "#aaa", fontWeight: highlight ? 600 : 400 }}>{label}</div>
      <div style={{ flex: 1 }}>
        <MiniBar wins={data.wins} losses={data.losses} total={data.total} />
      </div>
      <div style={{ fontSize: 11, color: clr(data.avgPnl), minWidth: 52, textAlign: "right" }}>{fmt(data.avgPnl)}</div>
      <div style={{ fontSize: 11, color: "#555", minWidth: 36, textAlign: "right" }}>{data.total}x</div>
    </div>
  );
}

// ── Live ticker badge ─────────────────────────────────────────────────────────
function LiveBadge({ symbol, entry, target, stopLoss, livePrice }) {
  if (!livePrice) return null;
  const isBuy   = true; // simplified — you can pass signalType
  const toTgt   = (((target - livePrice) / entry) * 100).toFixed(1);
  const toSL    = (((livePrice - stopLoss) / entry) * 100).toFixed(1);
  const progress = Math.min(100, Math.max(0, ((livePrice - stopLoss) / (target - stopLoss)) * 100));

  return (
    <div style={{ marginTop: 4, padding: "4px 8px", background: "rgba(255,215,64,0.05)", borderRadius: 6, border: "1px solid rgba(255,215,64,0.15)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#aaa", marginBottom: 3 }}>
        <span>SL ₹{stopLoss}</span>
        <span style={{ color: "#ffd740", fontWeight: 600 }}>LIVE ₹{livePrice?.toLocaleString("en-IN")}</span>
        <span>TGT ₹{target}</span>
      </div>
      <div style={{ height: 4, background: "#1a1a2e", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: progress + "%", height: "100%", background: `linear-gradient(90deg, #ff5252, #ffd740 50%, #00e676)`, borderRadius: 2, transition: "width 0.5s ease" }} />
      </div>
    </div>
  );
}

// ── Daily Trend chart ─────────────────────────────────────────────────────────
function TrendChart({ data }) {
  if (!data?.length) return (
    <div style={{ textAlign: "center", padding: 40, color: "#444" }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>📈</div>
      <div>No resolved signals yet — accuracy chart appears after 1st day</div>
    </div>
  );

  const maxH = 120;
  const barW = Math.min(40, Math.floor(560 / data.length) - 6);

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, padding: "16px 0 8px", minWidth: data.length * (barW + 6) }}>
        {data.slice(-14).map((d) => {
          const h = Math.max(4, (d.pct / 100) * maxH);
          const c = d.pct >= 60 ? "#00e676" : d.pct >= 45 ? "#ffd740" : "#ff5252";
          return (
            <div key={d.date} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, color: c, fontWeight: 600 }}>{d.pct}%</span>
              <div title={`${d.date}: ${d.wins}W / ${d.losses}L`}
                style={{ width: barW, height: h, background: c, borderRadius: "3px 3px 0 0", opacity: 0.85, cursor: "pointer", transition: "opacity 0.2s" }}
                onMouseEnter={e => e.target.style.opacity = 1}
                onMouseLeave={e => e.target.style.opacity = 0.85}
              />
              <span style={{ fontSize: 9, color: "#555", transform: "rotate(-45deg)", transformOrigin: "top left", whiteSpace: "nowrap", marginTop: 4 }}>
                {d.date.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main BacktestLab component ────────────────────────────────────────────────
export default function BacktestLab({ onClose, socket }) {
  const [tab, setTab]               = useState("tracker");
  const [sessions, setSessions]     = useState([]);
  const [selectedDate, setSelected] = useState(() => {
    const d = new Date(); 
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  });
  const [signals, setSignals]       = useState([]);
  const [analytics, setAnalytics]   = useState(null);
  const [filter, setFilter]         = useState("ALL");
  const [search, setSearch]         = useState("");
  const [livePrices, setLivePrices] = useState({});
  const [resolvedFlash, setFlash]   = useState({});
  const [loading, setLoading]       = useState(false);
  const [toast, setToast]           = useState(null);
  const [analyticsDays, setDays]    = useState(30);
  const [capturing, setCapturing]   = useState(false);
  const manualRef                   = useRef({});

  // ── Fetch sessions ──────────────────────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/backtest/sessions");
      if (r.ok) setSessions(await r.json());
    } catch {}
  }, []);

  // ── Fetch signals for selected date ────────────────────────────────────────
  const fetchSignals = useCallback(async (date) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/backtest/signals?date=${date}`);
      if (r.ok) setSignals(await r.json());
    } catch {}
    setLoading(false);
  }, []);

  // ── Fetch analytics ─────────────────────────────────────────────────────────
  const fetchAnalytics = useCallback(async () => {
    try {
      const r = await fetch(`/api/backtest/analytics?days=${analyticsDays}`);
      if (r.ok) setAnalytics(await r.json());
    } catch {}
  }, [analyticsDays]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);
  useEffect(() => { fetchSignals(selectedDate); }, [selectedDate, fetchSignals]);
  useEffect(() => { if (tab === "analytics") fetchAnalytics(); }, [tab, fetchAnalytics]);

  // ── Socket live events ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    socket.on("backtest-live-tick", ({ symbol, price }) => {
      setLivePrices(prev => ({ ...prev, [symbol]: price }));
    });

    socket.on("backtest-resolved", ({ signalId, symbol, result, exitPrice, pnlPct, resolvedBy }) => {
      // Flash resolved signal
      setFlash(prev => ({ ...prev, [signalId]: result }));
      setTimeout(() => setFlash(prev => { const n = {...prev}; delete n[signalId]; return n; }), 3000);

      // Update signal in list
      setSignals(prev => prev.map(s =>
        s.signalId === signalId
          ? { ...s, status: result, exitPrice, pnlPct, resolvedBy }
          : s
      ));

      showToast(`🎯 ${symbol} → ${result} @ ₹${exitPrice?.toLocaleString("en-IN")} (${resolvedBy?.replace(/_/g," ")})`, result === "WIN" || result === "MANUAL_WIN" ? "win" : "loss");
      fetchSessions();
    });

    socket.on("backtest-session-captured", ({ count, date }) => {
      showToast(`📸 Auto-captured ${count} signals for ${date}`, "info");
      fetchSessions();
      fetchSignals(date);
    });

    // ✅ NEW: 3:25 PM auto-expiry result
    socket.on("backtest-expiry-complete", ({ date, wins, losses, expired, total }) => {
      showToast(`⏰ Market closed · ${wins}W ${losses}L ${expired} expired of ${total} signals`, "info");
      fetchSignals(date);   // re-fetch so all PENDING → WIN/LOSS/EXPIRED
      fetchSessions();      // update sidebar accuracy numbers
      if (tab === "analytics") fetchAnalytics(); // refresh charts too
    });

    return () => {
      socket.off("backtest-live-tick");
      socket.off("backtest-resolved");
      socket.off("backtest-session-captured");
      socket.off("backtest-expiry-complete"); // ✅ cleanup
    };
  }, [socket, fetchSessions, fetchSignals]);

  function showToast(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  // ── Manual capture ──────────────────────────────────────────────────────────
  async function handleCapture() {
    setCapturing(true);
    try {
      const r = await fetch("/api/backtest/capture-now", { method: "POST" });
      const d = await r.json();
      if (d.success) showToast(`📸 Captured ${d.count} signals`, "info");
      else showToast(d.error || "Nothing to capture right now", "warn");
    } catch { showToast("Capture failed", "loss"); }
    setCapturing(false);
  }

  // ── Manual resolve ──────────────────────────────────────────────────────────
  async function handleManualResolve(signalId, result) {
    const exitPrice = parseFloat(manualRef.current[signalId] || 0);
    if (!exitPrice) { showToast("Enter exit price first", "warn"); return; }
    try {
      const r = await fetch("/api/backtest/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId, result, exitPrice }),
      });
      if (r.ok) {
        showToast(`✅ ${result} marked manually`, "win");
        fetchSignals(selectedDate);
        fetchSessions();
      }
    } catch {}
  }

  // ── Stats from current date signals ────────────────────────────────────────
  const stats = {
    total:    signals.length,
    resolved: signals.filter(s => !["PENDING","EXPIRED"].includes(s.status)).length,
    wins:     signals.filter(s => s.status.includes("WIN")).length,
    losses:   signals.filter(s => s.status.includes("LOSS")).length,
    pending:  signals.filter(s => s.status === "PENDING").length,
    avgPnl:   signals.filter(s => s.pnlPct != null).reduce((sum,s,_,a) => sum + s.pnlPct/a.length, 0),
    bestTrade: signals.reduce((best, s) => s.pnlPct > (best?.pnlPct||−Infinity) ? s : best, null),
  };
  const overallAcc = stats.resolved ? Math.round((stats.wins / stats.resolved) * 100) : 0;

  // ── Filtered signals ────────────────────────────────────────────────────────
  const filtered = signals.filter(s => {
    const matchFilter = filter === "ALL" || s.status.includes(filter) ||
      (filter === "PENDING" && s.status === "PENDING");
    const matchSearch = !search || s.symbol.toLowerCase().includes(search.toLowerCase());
    return matchFilter && matchSearch;
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        width: "min(1200px, 96vw)", height: "min(780px, 94vh)",
        background: "linear-gradient(160deg, #0a0a1a 0%, #0d1117 100%)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 16, display: "flex", flexDirection: "column",
        overflow: "hidden", boxShadow: "0 32px 80px rgba(0,0,0,0.7)",
      }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ padding: "16px 20px 0", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>🔬</span>
                <span style={{ fontSize: 17, fontWeight: 700, color: "#fff", letterSpacing: 0.3 }}>Backtest Lab</span>
                <span style={{ fontSize: 10, padding: "2px 7px", background: "rgba(0,230,118,0.12)", color: "#00e676", borderRadius: 20, border: "1px solid rgba(0,230,118,0.3)" }}>LIVE AUTO-RESOLVE</span>
              </div>
              <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>Live NSE tracking · Auto WIN/LOSS · 30-day analytics</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={handleCapture} disabled={capturing} style={{
                padding: "7px 14px", background: capturing ? "#1a1a2e" : "rgba(0,230,118,0.15)",
                color: "#00e676", border: "1px solid rgba(0,230,118,0.3)", borderRadius: 8,
                cursor: "pointer", fontSize: 12, fontWeight: 600,
              }}>
                {capturing ? "Capturing..." : "📸 Capture Now"}
              </button>
              <button onClick={() => {
                const data = signals.map(s => [
                  s.symbol, s.signalType, s.entry, s.target, s.stopLoss,
                  s.status, s.exitPrice, s.pnlPct, s.captureTime, s.exitTime,
                  s.rsi, s.techScore, s.sector
                ]);
                const csv = ["Symbol,Signal,Entry,Target,SL,Status,Exit,P&L%,CaptureTime,ExitTime,RSI,TechScore,Sector",
                  ...data.map(r => r.join(","))].join("\n");
                const a = document.createElement("a");
                a.href = "data:text/csv," + encodeURIComponent(csv);
                a.download = `backtest_${selectedDate}.csv`;
                a.click();
              }} style={{
                padding: "7px 14px", background: "rgba(100,100,255,0.1)",
                color: "#8888ff", border: "1px solid rgba(100,100,255,0.25)", borderRadius: 8,
                cursor: "pointer", fontSize: 12,
              }}>⬇ Export</button>
              <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 20, padding: "0 4px" }}>✕</button>
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            {[
              { label: "Total", value: stats.total, color: "#64b5f6" },
              { label: "Resolved", value: stats.resolved, color: "#aaa" },
              { label: "Wins", value: stats.wins, color: "#00e676" },
              { label: "Losses", value: stats.losses, color: "#ff5252" },
              { label: "Pending", value: stats.pending, color: "#ffd740" },
              { label: "Accuracy", value: stats.resolved ? overallAcc + "%" : "—", color: overallAcc >= 60 ? "#00e676" : overallAcc >= 45 ? "#ffd740" : "#ff5252" },
              { label: "Avg P&L", value: stats.resolved ? fmt(stats.avgPnl) : "—", color: clr(stats.avgPnl) },
              { label: "Best Trade", value: stats.bestTrade ? `${stats.bestTrade.symbol} ${fmt(stats.bestTrade.pnlPct)}` : "—", color: "#00e676" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ flex: 1, background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "8px 10px", minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
                <div style={{ fontSize: 10, color: "#444", marginTop: 1 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 2 }}>
            {[
              { id: "tracker",   icon: "📋", label: "Daily Tracker" },
              { id: "analytics", icon: "📊", label: "Analytics" },
              { id: "trend",     icon: "📈", label: "Daily Trend" },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: "8px 16px", background: tab === t.id ? "rgba(255,255,255,0.08)" : "none",
                color: tab === t.id ? "#fff" : "#555", border: "none",
                borderBottom: tab === t.id ? "2px solid #00e676" : "2px solid transparent",
                cursor: "pointer", fontSize: 13, borderRadius: "6px 6px 0 0",
              }}>{t.icon} {t.label}</button>
            ))}
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* Sessions sidebar */}
          <div style={{ width: 160, borderRight: "1px solid rgba(255,255,255,0.06)", overflowY: "auto", padding: "8px 0", flexShrink: 0 }}>
            <div style={{ fontSize: 10, color: "#333", padding: "4px 12px 8px", textTransform: "uppercase", letterSpacing: 1 }}>Sessions</div>
            {sessions.length === 0 && <div style={{ padding: "8px 12px", fontSize: 11, color: "#444" }}>No data yet</div>}
            {sessions.map(s => {
              const acc = s.resolved ? Math.round((s.wins / s.resolved) * 100) : null;
              return (
                <div key={s.key} onClick={() => setSelected(s.date)}
                  style={{
                    padding: "8px 12px", cursor: "pointer",
                    background: selectedDate === s.date ? "rgba(255,255,255,0.06)" : "none",
                    borderLeft: selectedDate === s.date ? "2px solid #00e676" : "2px solid transparent",
                  }}>
                  <div style={{ fontSize: 11, color: selectedDate === s.date ? "#fff" : "#888" }}>{s.date.slice(5)}</div>
                  <div style={{ fontSize: 10, color: "#444", marginTop: 1 }}>{s.totalSignals} signals</div>
                  {acc !== null && (
                    <div style={{ fontSize: 11, color: acc >= 60 ? "#00e676" : acc >= 45 ? "#ffd740" : "#ff5252", marginTop: 1 }}>{acc}% acc</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Main content */}
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>

            {/* ── TRACKER TAB ─────────────────────────────────────────────── */}
            {tab === "tracker" && (
              <>
                {/* Filter bar */}
                <div style={{ padding: "10px 16px", display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.04)", flexShrink: 0 }}>
                  <span style={{ fontSize: 12, color: "#555" }}>{selectedDate}</span>
                  <input value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search symbol..."
                    style={{ padding: "4px 10px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, color: "#fff", fontSize: 12, width: 130 }} />
                  {["ALL","PENDING","WIN","LOSS","EXPIRED"].map(f => (
                    <button key={f} onClick={() => setFilter(f)} style={{
                      padding: "3px 10px", fontSize: 11,
                      background: filter === f ? "rgba(255,255,255,0.1)" : "none",
                      color: filter === f ? "#fff" : "#555",
                      border: "1px solid " + (filter === f ? "rgba(255,255,255,0.2)" : "transparent"),
                      borderRadius: 20, cursor: "pointer",
                    }}>{f}</button>
                  ))}
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "#444" }}>{filtered.length} rows</span>
                </div>

                {/* Signals table */}
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {loading && <div style={{ padding: 40, textAlign: "center", color: "#444" }}>Loading...</div>}
                  {!loading && filtered.length === 0 && (
                    <div style={{ padding: 60, textAlign: "center", color: "#333" }}>
                      <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
                      <div style={{ fontSize: 14, marginBottom: 4 }}>No signals captured yet</div>
                      <div style={{ fontSize: 12 }}>Signals auto-capture at market open, or click "Capture Now"</div>
                    </div>
                  )}
                  {filtered.map(sig => {
                    const meta  = STATUS_META[sig.status] || STATUS_META.PENDING;
                    const live  = livePrices[sig.symbol];
                    const flash = resolvedFlash[sig.signalId];

                    return (
                      <div key={sig.signalId} style={{
                        padding: "10px 16px",
                        background: flash ? (flash.includes("WIN") ? "rgba(0,230,118,0.08)" : "rgba(255,82,82,0.08)") : "none",
                        borderBottom: "1px solid rgba(255,255,255,0.03)",
                        transition: "background 0.5s",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {/* Signal info */}
                          <div style={{ minWidth: 80 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{sig.symbol}</div>
                            <div style={{ fontSize: 10, color: "#555", marginTop: 1 }}>{sig.sector}</div>
                          </div>

                          {/* Signal type badge */}
                          <div style={{
                            padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                            background: "rgba(255,255,255,0.05)",
                            color: SIGNAL_COLORS[sig.signalType] || "#aaa",
                            border: `1px solid ${SIGNAL_COLORS[sig.signalType] || "#333"}44`,
                            minWidth: 70, textAlign: "center",
                          }}>{sig.signalType}</div>

                          {/* Prices */}
                          <div style={{ fontSize: 11, color: "#888", minWidth: 50 }}>E: {fmtP(sig.entry)}</div>
                          <div style={{ fontSize: 11, color: "#00e676", minWidth: 50 }}>T: {fmtP(sig.target)}</div>
                          <div style={{ fontSize: 11, color: "#ff5252", minWidth: 50 }}>SL: {fmtP(sig.stopLoss)}</div>

                          {/* RSI + Tech */}
                          <div style={{ fontSize: 10, color: "#555", minWidth: 80 }}>RSI {sig.rsi?.toFixed(0)} · T{sig.techScore?.toFixed(0)}</div>

                          {/* Live price */}
                          {live && sig.status === "PENDING" && (
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#ffd740", minWidth: 70 }}>
                              🔴 {fmtP(live)}
                            </div>
                          )}

                          {/* Status */}
                          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                            {sig.status === "PENDING" ? (
                              // Manual resolve controls
                              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                <input
                                  placeholder="Exit ₹"
                                  onChange={e => manualRef.current[sig.signalId] = e.target.value}
                                  style={{ width: 70, padding: "3px 6px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4, color: "#fff", fontSize: 11 }}
                                />
                                <button onClick={() => handleManualResolve(sig.signalId, "WIN")}
                                  style={{ padding: "2px 8px", background: "rgba(0,230,118,0.15)", color: "#00e676", border: "1px solid rgba(0,230,118,0.3)", borderRadius: 4, cursor: "pointer", fontSize: 10 }}>W</button>
                                <button onClick={() => handleManualResolve(sig.signalId, "LOSS")}
                                  style={{ padding: "2px 8px", background: "rgba(255,82,82,0.15)", color: "#ff5252", border: "1px solid rgba(255,82,82,0.3)", borderRadius: 4, cursor: "pointer", fontSize: 10 }}>L</button>
                              </div>
                            ) : (
                              <div style={{
                                padding: "3px 10px", borderRadius: 5, fontSize: 11, fontWeight: 700,
                                background: meta.bg, color: meta.color,
                                border: `1px solid ${meta.color}33`,
                              }}>
                                {meta.icon} {meta.label}
                                {sig.pnlPct != null && <span style={{ marginLeft: 6, opacity: 0.8 }}>{fmt(sig.pnlPct)}</span>}
                              </div>
                            )}
                            <div style={{ fontSize: 9, color: "#333", textAlign: "right", minWidth: 50 }}>
                              {sig.exitTime || sig.captureTime}
                              {sig.isSwing && <div style={{ color: "#a78bfa" }}>SWING</div>}
                            </div>
                          </div>
                        </div>

                        {/* Live progress bar */}
                        {live && sig.status === "PENDING" && (
                          <LiveBadge symbol={sig.symbol} entry={sig.entry} target={sig.target} stopLoss={sig.stopLoss} livePrice={live} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* ── ANALYTICS TAB ───────────────────────────────────────────── */}
            {tab === "analytics" && (
              <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "#555" }}>Analyse last:</span>
                  {[7, 14, 30, 60].map(d => (
                    <button key={d} onClick={() => setDays(d)} style={{
                      padding: "3px 10px", fontSize: 11,
                      background: analyticsDays === d ? "rgba(0,230,118,0.15)" : "rgba(255,255,255,0.03)",
                      color: analyticsDays === d ? "#00e676" : "#555",
                      border: "1px solid " + (analyticsDays === d ? "rgba(0,230,118,0.3)" : "transparent"),
                      borderRadius: 20, cursor: "pointer",
                    }}>{d}D</button>
                  ))}
                  {analytics && (
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "#444" }}>
                      {analytics.totalSignals} resolved signals
                    </span>
                  )}
                </div>

                {!analytics ? (
                  <div style={{ textAlign: "center", padding: 40, color: "#444" }}>Loading analytics...</div>
                ) : analytics.totalSignals === 0 ? (
                  <div style={{ textAlign: "center", padding: 60, color: "#333" }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
                    <div>No resolved signals yet</div>
                    <div style={{ fontSize: 12, marginTop: 4, color: "#222" }}>Analytics appear after signals are auto-resolved or manually marked</div>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

                    {/* By Signal Type */}
                    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 14, border: "1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Accuracy by Signal Type</div>
                      {Object.entries(analytics.byType).map(([k, v]) => <AccRow key={k} label={k} data={v} highlight={v.pct >= 60} />)}
                    </div>

                    {/* By RSI */}
                    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 14, border: "1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Accuracy by RSI Range</div>
                      {Object.entries(analytics.byRSI).map(([k, v]) => <AccRow key={k} label={"RSI " + k} data={v} highlight={v.pct >= 60} />)}
                    </div>

                    {/* By Tech Score */}
                    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 14, border: "1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Accuracy by Tech Score</div>
                      {Object.entries(analytics.byTech).map(([k, v]) => <AccRow key={k} label={"Score " + k} data={v} highlight={v.pct >= 60} />)}
                    </div>

                    {/* By Time */}
                    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 14, border: "1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Accuracy by Time of Day</div>
                      {Object.entries(analytics.byTime).map(([k, v]) => <AccRow key={k} label={k} data={v} highlight={v.pct >= 60} />)}
                    </div>

                    {/* By Sector */}
                    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 14, border: "1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Accuracy by Sector (Top 10)</div>
                      {Object.entries(analytics.bySector).map(([k, v]) => <AccRow key={k} label={k.length > 12 ? k.slice(0,12)+"…" : k} data={v} highlight={v.pct >= 60} />)}
                    </div>

                    {/* By Stock */}
                    <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 14, border: "1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Best/Worst Stocks (Top 20)</div>
                      {Object.entries(analytics.byStock)
                        .sort(([,a],[,b]) => b.pct - a.pct)
                        .map(([k, v]) => <AccRow key={k} label={k} data={v} highlight={v.pct >= 70} />)}
                    </div>

                  </div>
                )}
              </div>
            )}

            {/* ── DAILY TREND TAB ──────────────────────────────────────────── */}
            {tab === "trend" && (
              <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, padding: 16, border: "1px solid rgba(255,255,255,0.05)", marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>Daily Accuracy Trend (Last 14 Days)</div>
                  <TrendChart data={analytics?.dailyTrend} />
                </div>

                {analytics?.dailyTrend?.length > 0 && (
                  <div style={{ background: "rgba(255,255,255,0.02)", borderRadius: 10, border: "1px solid rgba(255,255,255,0.05)", overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 1fr", padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: 10, color: "#444", textTransform: "uppercase" }}>
                      <span>Date</span><span>Signals</span><span>Wins</span><span>Losses</span><span>Accuracy</span><span>Avg P&L</span>
                    </div>
                    {[...analytics.dailyTrend].reverse().map(d => (
                      <div key={d.date} onClick={() => { setSelected(d.date); setTab("tracker"); }}
                        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 1fr", padding: "9px 14px", borderBottom: "1px solid rgba(255,255,255,0.03)", cursor: "pointer", fontSize: 12 }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}>
                        <span style={{ color: "#888" }}>{d.date}</span>
                        <span style={{ color: "#64b5f6" }}>{d.total}</span>
                        <span style={{ color: "#00e676" }}>{d.wins}</span>
                        <span style={{ color: "#ff5252" }}>{d.losses}</span>
                        <span style={{ color: d.pct >= 60 ? "#00e676" : d.pct >= 45 ? "#ffd740" : "#ff5252", fontWeight: 700 }}>{d.pct}%</span>
                        <span style={{ color: clr(d.avgPnl) }}>{fmt(d.avgPnl)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.04)", display: "flex", justifyContent: "space-between", fontSize: 10, color: "#333", flexShrink: 0 }}>
          <span>💡 Live prices tracked via Upstox · Auto-resolves when target/SL hit · Intraday expires at 3:25 PM</span>
          <span>{sessions.length} sessions · {signals.length} signals today</span>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 99999,
          padding: "10px 18px", borderRadius: 8, fontSize: 13,
          background: toast.type === "win" ? "rgba(0,230,118,0.15)" : toast.type === "loss" ? "rgba(255,82,82,0.15)" : "rgba(100,100,100,0.2)",
          color: toast.type === "win" ? "#00e676" : toast.type === "loss" ? "#ff5252" : "#aaa",
          border: `1px solid ${toast.type === "win" ? "rgba(0,230,118,0.3)" : toast.type === "loss" ? "rgba(255,82,82,0.3)" : "rgba(255,255,255,0.1)"}`,
          backdropFilter: "blur(8px)",
          animation: "slideIn 0.3s ease",
          maxWidth: 380,
        }}>{toast.msg}</div>
      )}
    </div>
  );
}
