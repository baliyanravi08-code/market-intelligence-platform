import React, { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import "./OptionChain.css";

// ── Constants ────────────────────────────────────────────────────────────────
const UNDERLYINGS = ["NIFTY", "BANKNIFTY"];

const SIGNAL_LABELS = {
  long_buildup:   { label: "Long Buildup",   color: "#00ff9c", icon: "▲" },
  short_buildup:  { label: "Short Buildup",  color: "#ff4560", icon: "▼" },
  short_covering: { label: "Short Covering", color: "#00cfff", icon: "▲" },
  long_unwinding: { label: "Long Unwinding", color: "#ffd60a", icon: "▼" },
  buildup:        { label: "Buildup",        color: "#00ff9c", icon: "▲" },
  unwinding:      { label: "Unwinding",      color: "#ff4560", icon: "▼" },
  neutral:        { label: "",               color: "transparent", icon: "" },
};

function fmt(n) {
  if (!n && n !== 0) return "—";
  if (n >= 10000000) return (n / 10000000).toFixed(1) + "Cr";
  if (n >= 100000)   return (n / 100000).toFixed(1) + "L";
  if (n >= 1000)     return (n / 1000).toFixed(1) + "K";
  return n.toLocaleString("en-IN");
}

function fmtPrice(n) {
  if (!n && n !== 0) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function pct(n) {
  if (!n && n !== 0) return "";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

// ── OI bar component ──────────────────────────────────────────────────────────
function OIBar({ value, max, side, signal }) {
  const width = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const sig   = SIGNAL_LABELS[signal] || SIGNAL_LABELS.neutral;
  const color = side === "ce"
    ? (signal === "short_buildup" || signal === "unwinding" ? "#ff4560" : "#00ff9c")
    : (signal === "long_buildup"  || signal === "buildup"   ? "#00ff9c" : "#ff4560");

  return (
    <div className="oi-bar-wrap">
      {side === "pe" && (
        <div className="oi-bar" style={{ width: `${width}%`, background: color, opacity: 0.35 }} />
      )}
      <span className="oi-val">{fmt(value)}</span>
      {side === "ce" && (
        <div className="oi-bar right" style={{ width: `${width}%`, background: color, opacity: 0.35 }} />
      )}
    </div>
  );
}

// ── Strike row ────────────────────────────────────────────────────────────────
function StrikeRow({ row, maxCEOI, maxPEOI, spotPrice, isFlash }) {
  const isATM      = row.isATM;
  const itm_ce     = spotPrice > 0 && row.strike < spotPrice;
  const itm_pe     = spotPrice > 0 && row.strike > spotPrice;
  const ceSig      = SIGNAL_LABELS[row.ce.signal] || SIGNAL_LABELS.neutral;
  const peSig      = SIGNAL_LABELS[row.pe.signal] || SIGNAL_LABELS.neutral;

  return (
    <tr className={`strike-row${isATM ? " atm" : ""}${isFlash ? " flash" : ""}${itm_ce ? " itm-ce" : ""}${itm_pe ? " itm-pe" : ""}`}>
      {/* CE OI */}
      <td className="ce-cell oi-cell">
        <OIBar value={row.ce.oi} max={maxCEOI} side="ce" signal={row.ce.signal} />
      </td>
      {/* CE OI Change */}
      <td className={`ce-cell change ${row.ce.oiChange > 0 ? "pos" : row.ce.oiChange < 0 ? "neg" : ""}`}>
        {row.ce.oiChange !== 0 && (
          <span>{row.ce.oiChange > 0 ? "+" : ""}{fmt(row.ce.oiChange)}</span>
        )}
      </td>
      {/* CE LTP */}
      <td className="ce-cell ltp">{fmtPrice(row.ce.ltp)}</td>
      {/* CE IV */}
      <td className="ce-cell iv">{row.ce.iv ? (row.ce.iv * 100).toFixed(1) + "%" : "—"}</td>
      {/* CE signal */}
      <td className="ce-cell sig">
        {ceSig.icon && (
          <span className="sig-pill" style={{ color: ceSig.color }}>
            {ceSig.icon} {ceSig.label}
          </span>
        )}
      </td>

      {/* STRIKE */}
      <td className="strike-cell">
        <span className="strike-num">{row.strike.toLocaleString("en-IN")}</span>
        {isATM && <span className="atm-badge">ATM</span>}
      </td>

      {/* PE signal */}
      <td className="pe-cell sig">
        {peSig.icon && (
          <span className="sig-pill" style={{ color: peSig.color }}>
            {peSig.icon} {peSig.label}
          </span>
        )}
      </td>
      {/* PE IV */}
      <td className="pe-cell iv">{row.pe.iv ? (row.pe.iv * 100).toFixed(1) + "%" : "—"}</td>
      {/* PE LTP */}
      <td className="pe-cell ltp">{fmtPrice(row.pe.ltp)}</td>
      {/* PE OI Change */}
      <td className={`pe-cell change ${row.pe.oiChange > 0 ? "pos" : row.pe.oiChange < 0 ? "neg" : ""}`}>
        {row.pe.oiChange !== 0 && (
          <span>{row.pe.oiChange > 0 ? "+" : ""}{fmt(row.pe.oiChange)}</span>
        )}
      </td>
      {/* PE OI */}
      <td className="pe-cell oi-cell">
        <OIBar value={row.pe.oi} max={maxPEOI} side="pe" signal={row.pe.signal} />
      </td>
    </tr>
  );
}

// ── PCR Gauge ─────────────────────────────────────────────────────────────────
function PCRGauge({ pcr }) {
  if (!pcr) return null;
  const level = pcr > 1.2 ? "bullish" : pcr < 0.8 ? "bearish" : "neutral";
  const colors = { bullish: "#00ff9c", neutral: "#ffd60a", bearish: "#ff4560" };
  const label  = { bullish: "Bullish", neutral: "Neutral", bearish: "Bearish" };
  return (
    <div className="pcr-gauge">
      <span className="pcr-label">PCR</span>
      <span className="pcr-val" style={{ color: colors[level] }}>{pcr.toFixed(3)}</span>
      <span className="pcr-level" style={{ color: colors[level] }}>{label[level]}</span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function OptionChain() {
  const [underlying, setUnderlying]   = useState("NIFTY");
  const [expiries, setExpiries]        = useState([]);
  const [selectedExpiry, setExpiry]    = useState(null);
  const [chainData, setChainData]      = useState(null);
  const [loading, setLoading]          = useState(true);
  const [lastUpdate, setLastUpdate]    = useState(null);
  const [flashStrikes, setFlashStrikes]= useState(new Set());
  const [oiTicks, setOITicks]          = useState({});   // instrKey → {oi, ltp}
  const [showATMOnly, setShowATMOnly]  = useState(false);
  const [strikeCount, setStrikeCount]  = useState(20);   // strikes above+below ATM
  const socketRef = useRef(null);
  const tableRef  = useRef(null);

  // ── Socket.io connection ───────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(window.location.origin, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("request-option-chain", { underlying, expiry: selectedExpiry });
      socket.emit("option-expiries", { underlying });
    });

    socket.on("option-expiries", ({ underlying: u, expiries: e }) => {
      if (u !== underlying) return;
      setExpiries(e || []);
      if (e?.length && !selectedExpiry) {
        setExpiry(e[0]);
      }
    });

    socket.on("option-chain-update", ({ underlying: u, expiry: exp, data }) => {
      if (u !== underlying) return;
      if (exp !== selectedExpiry && selectedExpiry) return;

      setChainData(data);
      setLastUpdate(Date.now());
      setLoading(false);

      // Flash changed strikes
      if (data.alerts?.length) {
        const newFlash = new Set(data.alerts.map(a => a.strike));
        setFlashStrikes(newFlash);
        setTimeout(() => setFlashStrikes(new Set()), 1500);
      }
    });

    // Live OI ticks from WS
    socket.on("option-oi-tick", ({ instrKey, oi, ltp, ts }) => {
      setOITicks(prev => ({ ...prev, [instrKey]: { oi, ltp, ts } }));
    });

    return () => socket.disconnect();
  }, [underlying]);

  // Re-request when expiry changes
  useEffect(() => {
    if (!selectedExpiry || !socketRef.current?.connected) return;
    setLoading(true);
    socketRef.current.emit("request-option-chain", { underlying, expiry: selectedExpiry });

    // Also fetch via REST as fallback
    fetch(`/api/option-chain?underlying=${underlying}&expiry=${selectedExpiry}`)
      .then(r => r.json())
      .then(data => {
        if (data.strikes) {
          setChainData(data);
          setLastUpdate(Date.now());
          setLoading(false);
        }
      })
      .catch(() => {});
  }, [underlying, selectedExpiry]);

  // Fetch expiries on underlying change
  useEffect(() => {
    setLoading(true);
    setChainData(null);
    setExpiry(null);

    fetch(`/api/option-chain/expiries?underlying=${underlying}`)
      .then(r => r.json())
      .then(({ expiries: e }) => {
        setExpiries(e || []);
        if (e?.length) setExpiry(e[0]);
      })
      .catch(() => {});
  }, [underlying]);

  // ── Derived values ─────────────────────────────────────────────────────────
  const strikes = chainData?.strikes || [];

  const visibleStrikes = (() => {
    if (!strikes.length) return [];
    if (!showATMOnly) return strikes;

    const atmIdx = strikes.findIndex(s => s.isATM);
    if (atmIdx < 0) return strikes;
    const from = Math.max(0, atmIdx - strikeCount);
    const to   = Math.min(strikes.length - 1, atmIdx + strikeCount);
    return strikes.slice(from, to + 1);
  })();

  const maxCEOI = Math.max(...visibleStrikes.map(s => s.ce.oi), 1);
  const maxPEOI = Math.max(...visibleStrikes.map(s => s.pe.oi), 1);

  const timeSince = lastUpdate
    ? Math.floor((Date.now() - lastUpdate) / 1000)
    : null;

  // ── Scroll to ATM on data load ─────────────────────────────────────────────
  useEffect(() => {
    if (!chainData) return;
    const atmRow = tableRef.current?.querySelector(".atm");
    if (atmRow) {
      setTimeout(() => atmRow.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    }
  }, [chainData?.expiry, chainData?.underlying]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="oc-page">
      {/* Header */}
      <div className="oc-header">
        <div className="oc-title">
          <span className="oc-icon">⚡</span>
          <h1>Option Chain <span className="oc-sub">OI Heatmap</span></h1>
          {chainData && <span className="live-dot" />}
        </div>

        {/* Controls */}
        <div className="oc-controls">
          {/* Underlying selector */}
          <div className="control-group">
            {UNDERLYINGS.map(u => (
              <button
                key={u}
                className={`ctrl-btn${underlying === u ? " active" : ""}`}
                onClick={() => setUnderlying(u)}
              >
                {u}
              </button>
            ))}
          </div>

          {/* Expiry selector */}
          {expiries.length > 0 && (
            <div className="control-group">
              {expiries.slice(0, 4).map(e => (
                <button
                  key={e}
                  className={`ctrl-btn expiry${selectedExpiry === e ? " active" : ""}`}
                  onClick={() => setExpiry(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          )}

          {/* ATM filter */}
          <div className="control-group">
            <button
              className={`ctrl-btn${showATMOnly ? " active" : ""}`}
              onClick={() => setShowATMOnly(v => !v)}
            >
              Near ATM
            </button>
            {showATMOnly && (
              <select
                className="ctrl-select"
                value={strikeCount}
                onChange={e => setStrikeCount(Number(e.target.value))}
              >
                {[5, 10, 15, 20, 30].map(n => (
                  <option key={n} value={n}>±{n} strikes</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Summary bar */}
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
            <span className="s-label">Total CE OI</span>
            <span className="s-val ce-oi">{fmt(chainData.totalCEOI)}</span>
          </div>
          <div className="summary-item">
            <span className="s-label">Total PE OI</span>
            <span className="s-val pe-oi">{fmt(chainData.totalPEOI)}</span>
          </div>
          <div className="summary-item">
            <span className="s-label">Updated</span>
            <span className="s-val updated">
              {timeSince !== null ? `${timeSince}s ago` : "—"}
            </span>
          </div>
        </div>
      )}

      {/* Alerts */}
      {chainData?.alerts?.length > 0 && (
        <div className="oc-alerts">
          {chainData.alerts.slice(0, 5).map((a, i) => {
            const sig = SIGNAL_LABELS[a.signal] || SIGNAL_LABELS.neutral;
            return (
              <div key={i} className="oc-alert-pill" style={{ borderColor: sig.color + "55" }}>
                <span style={{ color: sig.color }}>{sig.icon}</span>
                <span className="alert-strike">{a.strike.toLocaleString("en-IN")}</span>
                <span className="alert-side">{a.side}</span>
                <span style={{ color: sig.color }}>{sig.label}</span>
                <span className="alert-pct">{a.pct}%</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="oc-loading">
          <div className="loading-pulse" />
          <span>Fetching option chain data...</span>
        </div>
      )}

      {/* No data */}
      {!loading && !chainData && (
        <div className="oc-empty">
          <p>⏳ Waiting for first poll (up to 60s)...</p>
          <p className="empty-sub">Market must be open (Mon–Fri 9:15–15:30 IST)</p>
        </div>
      )}

      {/* Main table */}
      {!loading && chainData && (
        <div className="oc-table-wrap" ref={tableRef}>
          <table className="oc-table">
            <thead>
              <tr>
                {/* CE side */}
                <th className="ce-th" colSpan="1">OI</th>
                <th className="ce-th">Chg OI</th>
                <th className="ce-th">LTP</th>
                <th className="ce-th">IV</th>
                <th className="ce-th">Signal</th>
                {/* Center */}
                <th className="strike-th">Strike</th>
                {/* PE side */}
                <th className="pe-th">Signal</th>
                <th className="pe-th">IV</th>
                <th className="pe-th">LTP</th>
                <th className="pe-th">Chg OI</th>
                <th className="pe-th" colSpan="1">OI</th>
              </tr>
              <tr className="side-label-row">
                <th className="ce-side-label" colSpan="5">CALL — CE</th>
                <th />
                <th className="pe-side-label" colSpan="5">PUT — PE</th>
              </tr>
            </thead>
            <tbody>
              {visibleStrikes.map(row => (
                <StrikeRow
                  key={row.strike}
                  row={row}
                  maxCEOI={maxCEOI}
                  maxPEOI={maxPEOI}
                  spotPrice={chainData.spotPrice}
                  isFlash={flashStrikes.has(row.strike)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      <div className="oc-footer">
        <span>Data via Upstox API · REST poll every 60s · Live OI ticks via WebSocket</span>
        {chainData && (
          <span>
            Showing {visibleStrikes.length} of {strikes.length} strikes ·{" "}
            {underlying} · {selectedExpiry}
          </span>
        )}
      </div>
    </div>
  );
}
