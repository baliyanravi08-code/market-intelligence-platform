import { useEffect, useState, useCallback, useRef } from "react";
import GannBadge from "../components/GannBadge";

/**
 * OptionsIntelligencePage.jsx — Session 9
 *
 * LAYOUT CHANGES:
 *  1. Score Card: score+symbol on LEFT, stat strip on RIGHT (same row, no extra height)
 *  2. Four panels SIDE BY SIDE in a single row below: GEX | OI | Gann | Market Structure
 *     — each panel scrolls internally, no page scroll needed
 *  3. Bloomberg-style density: every pixel earns its place
 */

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt2(n)   { return n == null ? "—" : Number(n).toFixed(2); }
function fmtInt(n) { return n == null ? "—" : Math.round(Number(n)).toLocaleString("en-IN"); }
function fmtCr(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return (n / 1000).toFixed(1) + "K Cr";
  return Number(n).toFixed(1) + " Cr";
}
function calcPct(a, b) {
  if (!a || !b) return null;
  return +((a - b) / b * 100).toFixed(1);
}

const GANN_SYM = { "NIFTY 50": "NIFTY", "BANK NIFTY": "BANKNIFTY", "SENSEX": "SENSEX" };
function toGannSym(sym) { return GANN_SYM[sym] || sym; }

function normaliseIV(raw) {
  if (raw == null) return null;
  const v = Number(raw);
  return isNaN(v) ? null : (v > 200 ? v / 100 : v);
}

function filterByProximity(arr, spot, symbol, pct = 10) {
  if (!arr?.length || !spot) return arr || [];
  const p  = (symbol || "").toUpperCase().includes("BANK") ? 15 : pct;
  const lo = spot * (1 - p / 100);
  const hi = spot * (1 + p / 100);
  return arr.filter(u => Number(u.strike) >= lo && Number(u.strike) <= hi);
}

function ScoreBand(score) {
  if (score >= 80) return { color: "#00ff9c", bg: "#002210", label: "STRONG BUY" };
  if (score >= 65) return { color: "#4fc3f7", bg: "#001a28", label: "BUY" };
  if (score >= 45) return { color: "#ffd54f", bg: "#1a1500", label: "NEUTRAL" };
  if (score >= 30) return { color: "#ff8a65", bg: "#1a0a00", label: "SELL" };
  return { color: "#ef5350", bg: "#1a0000", label: "STRONG SELL" };
}

function gannPalette(bias) {
  const p = {
    STRONG_BULLISH: { color: "#00ff9c", bg: "#003318", border: "#00ff9c66" },
    BULLISH:        { color: "#00ff9c", bg: "#002210", border: "#00ff9c44" },
    NEUTRAL:        { color: "#ffd54f", bg: "#1a1500", border: "#ffd54f44" },
    BEARISH:        { color: "#ef5350", bg: "#1a0000", border: "#ef535044" },
    STRONG_BEARISH: { color: "#ef5350", bg: "#280000", border: "#ef535066" },
  };
  return p[bias] || p.NEUTRAL;
}

function interpretOI(u, spot) {
  const isCall     = (u.type || "").toUpperCase() === "CALL";
  const dist       = u.distPct ?? calcPct(u.strike, spot) ?? 0;
  const increasing = (u.oiChange || 0) > 0;
  if (isCall) {
    if (increasing  && dist > 0) return { label: "Supply wall",    color: "#ef5350", icon: "▲", action: `Resistance @ ${fmtInt(u.strike)}` };
    if (!increasing && dist > 0) return { label: "Call unwind",    color: "#00ff9c", icon: "▼", action: `Breakout above ${fmtInt(u.strike)}` };
    if (increasing  && dist < 0) return { label: "Bearish hedge",  color: "#ffd54f", icon: "◆", action: `Below spot @ ${fmtInt(u.strike)}` };
  } else {
    if (increasing  && dist < 0) return { label: "Support build",  color: "#00ff9c", icon: "▲", action: `Support @ ${fmtInt(u.strike)}` };
    if (!increasing && dist < 0) return { label: "Put unwind",     color: "#4fc3f7", icon: "▼", action: `Weak floor @ ${fmtInt(u.strike)}` };
    if (increasing  && dist > 0) return { label: "Put writing",    color: "#ff8a65", icon: "◆", action: `Dealer short @ ${fmtInt(u.strike)}` };
  }
  return { label: "OI activity", color: "#a8c8e0", icon: "◈", action: `${fmtInt(u.strike)}` };
}

const ALERT_ICONS = {
  GAMMA_FLIP: "⚡", GEX_FLIP: "⚡", PCR_SPIKE: "▲", PUT_WALL: "●",
  CALL_WALL: "●", OI_SURGE: "▲", REGIME_CHANGE: "◆", GANN_ANGLE: "◤",
  TIME_CYCLE: "◷", CARDINAL_CROSS: "✕", SQUARE_OF_NINE: "#",
};

// ════════════════ Shared sub-components ══════════════════════════════════════

/** Tiny 2-line stat used in the score card header strip */
function HStat({ label, value, sub, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 52 }}>
      <div style={{ fontSize: 8, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 0.8, textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 700, color: color || "#e8f2ff", fontFamily: "IBM Plex Mono,monospace", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 7, color: "#a0b8cc", fontFamily: "IBM Plex Mono,monospace" }}>{sub}</div>}
    </div>
  );
}

function VDivider() {
  return <div style={{ width: 1, background: "#2a5070", alignSelf: "stretch", margin: "0 6px", flexShrink: 0 }} />;
}

function SL({ children, icon }) {
  return (
    <div style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: "#c8d8e8", letterSpacing: 1.5, textTransform: "uppercase", borderBottom: "1px solid #1e4060", paddingBottom: 4, marginBottom: 6 }}>
      {icon && <span style={{ marginRight: 4 }}>{icon}</span>}{children}
    </div>
  );
}

function GexBar({ label, value, max, color }) {
  const pct = Math.min(Math.abs((value || 0) / (max || 1)) * 100, 100);
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", marginBottom: 2 }}>
        <span style={{ color: "#c8d8e8" }}>{label}</span>
        <span style={{ color }}>{fmtCr(value)}</span>
      </div>
      <div style={{ height: 3, background: "#1a3040", borderRadius: 2 }}>
        <div style={{ height: 3, width: `${pct}%`, background: color, borderRadius: 2, minWidth: pct > 0 ? 2 : 0 }} />
      </div>
    </div>
  );
}

function MiniCard({ label, value, sub, color }) {
  return (
    <div style={{ background: "#071828", border: "1px solid #1e3a50", borderRadius: 4, padding: "6px 8px" }}>
      <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || "#e8f2ff", fontFamily: "IBM Plex Mono,monospace", lineHeight: 1.1, wordBreak: "break-word" }}>{value}</div>
      {sub && <div style={{ fontSize: 7, color: "#a0b8cc", marginTop: 1, fontFamily: "IBM Plex Mono,monospace" }}>{sub}</div>}
    </div>
  );
}

function IVRankBar({ ivRank, ivPct }) {
  const rank = Math.min(Math.max(ivRank || 0, 0), 100);
  const clr  = rank > 70 ? "#ef5350" : rank > 40 ? "#ffd54f" : "#00ff9c";
  return (
    <div style={{ minWidth: 80 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 7, fontFamily: "IBM Plex Mono,monospace", marginBottom: 2 }}>
        <span style={{ color: "#c8d8e8", textTransform: "uppercase", letterSpacing: 0.8 }}>IV Rank</span>
        <span style={{ color: clr, fontWeight: 700 }}>{rank > 0 ? fmt2(rank) : "—"}</span>
      </div>
      <div style={{ height: 4, background: "#1a3040", borderRadius: 2 }}>
        <div style={{ height: 4, width: `${rank}%`, minWidth: rank > 0 ? 2 : 0, background: clr, borderRadius: 2 }} />
      </div>
      {ivPct != null && <div style={{ fontSize: 6, color: "#a0b8cc", fontFamily: "IBM Plex Mono,monospace", marginTop: 1 }}>%ile: {fmt2(ivPct)}</div>}
    </div>
  );
}

function StrategyTag({ signal }) {
  const label = typeof signal === "string" ? signal : (signal?.strategy || "");
  const colors = {
    SELL_PREMIUM:     { bg: "#002210", color: "#00ff9c", border: "#00ff9c33" },
    BUY_OPTIONS:      { bg: "#001828", color: "#4fc3f7", border: "#4fc3f733" },
    BUY_PREMIUM:      { bg: "#001828", color: "#4fc3f7", border: "#4fc3f733" },
    GAMMA_SQUEEZE:    { bg: "#1a1000", color: "#ffd54f", border: "#ffd54f33" },
    GAMMA_WALL:       { bg: "#1a1000", color: "#ffd54f", border: "#ffd54f33" },
    SKEW_TRADE:       { bg: "#1a0a00", color: "#ff8a65", border: "#ff8a6533" },
    UNUSUAL_ACTIVITY: { bg: "#1a0018", color: "#ff5cff", border: "#ff5cff33" },
    UNUSUAL_OI:       { bg: "#1a0018", color: "#ff5cff", border: "#ff5cff33" },
    DEFENSIVE:        { bg: "#1a0000", color: "#ef5350", border: "#ef535033" },
    IV_CRUSH:         { bg: "#1a0000", color: "#ef5350", border: "#ef535033" },
  };
  const c = colors[label] || { bg: "#1a3040", color: "#a8c8e0", border: "#4a9abb33" };
  return (
    <span style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, padding: "1px 5px", borderRadius: 2, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      {label.replace(/_/g, " ")}
    </span>
  );
}

function PanelWrap({ children, borderColor }) {
  return (
    <div style={{ background: "#060f1c", border: `1px solid ${borderColor || "#1c3a58"}`, borderRadius: 6, padding: "10px 12px", flex: "1 1 0", minWidth: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>
      {children}
    </div>
  );
}

function EmptyState({ symbol }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10 }}>
      <div style={{ fontSize: 28, opacity: 0.2 }}>◤</div>
      <div style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 10, color: "#c8d8e8", textAlign: "center" }}>
        {symbol ? `Waiting for data on ${symbol}…` : "Select a symbol"}
      </div>
    </div>
  );
}

// ════════════════ Alert Feed ══════════════════════════════════════════════════

function AlertFeed({ alerts }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = 0; }, [alerts?.length]);
  if (!alerts?.length) return <div style={{ fontSize: 8, color: "#a0b8cc", fontFamily: "IBM Plex Mono,monospace", textAlign: "center", padding: "6px 0" }}>◌ No alerts</div>;
  return (
    <div ref={ref} style={{ maxHeight: 100, overflowY: "auto" }}>
      {alerts.slice(0, 8).map((a, i) => {
        const icon   = ALERT_ICONS[a.type] || "◈";
        const isHigh = a.priority === "HIGH";
        const color  = isHigh ? "#ef5350" : a.priority === "MEDIUM" ? "#ffd54f" : "#a8c8e0";
        const age    = a.ts ? Math.round((Date.now() - a.ts) / 1000) : null;
        return (
          <div key={i} style={{ display: "flex", gap: 5, padding: "3px 0", borderBottom: i < alerts.length - 1 ? "1px solid #1a3040" : "none", opacity: age && age > 300 ? 0.4 : 1 }}>
            <span style={{ fontSize: 9, flexShrink: 0 }}>{icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 8, color, fontFamily: "IBM Plex Mono,monospace", fontWeight: isHigh ? 700 : 400, lineHeight: 1.3 }}>{a.message || a.detail || String(a)}</div>
            </div>
            {age != null && <span style={{ fontSize: 6, color: "#a0b8cc", fontFamily: "IBM Plex Mono,monospace", flexShrink: 0, marginTop: 1 }}>{age < 60 ? `${age}s` : `${Math.round(age / 60)}m`}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ════════════════ GEX Panel ═══════════════════════════════════════════════════

function GEXPanel({ gex }) {
  const gexCallVal = gex.callGEX ?? null;
  const gexPutVal  = gex.putGEX  ?? null;
  const gexMax     = Math.max(Math.abs(gex.netGEX || 0), Math.abs(gexCallVal || 0), Math.abs(gexPutVal || 0), 1);
  return (
    <PanelWrap>
      <SL>Dealer GEX</SL>
      <GexBar label="Net GEX"  value={gex.netGEX}  max={gexMax} color={gex.netGEX >= 0 ? "#00ff9c" : "#ef5350"} />
      <GexBar label="Call GEX" value={gexCallVal}  max={gexMax} color="#4fc3f7" />
      <GexBar label="Put GEX"  value={gexPutVal}   max={gexMax} color="#ff8a65" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginTop: 8 }}>
        <MiniCard label="GAMMA FLIP" value={gex.gammaFlip ? gex.gammaFlip.toLocaleString("en-IN") : "—"} sub="spot level"  color="#ffd54f" />
        <MiniCard label="REGIME"     value={gex.regime ? gex.regime.replace(/_/g, " ") : "—"}             sub=""            color={gex.regime === "MEAN_REVERTING" ? "#00ff9c" : "#ef5350"} />
        <MiniCard label="CALL WALL"  value={gex.callWall ? gex.callWall.toLocaleString("en-IN") : "—"}    sub="resistance"  color="#4fc3f7" />
        <MiniCard label="PUT WALL"   value={gex.putWall  ? gex.putWall.toLocaleString("en-IN")  : "—"}    sub="support"     color="#ff8a65" />
      </div>
      {(gex.vanna != null || gex.charm != null) && (
        <>
          <div style={{ borderTop: "1px solid #1a3040", margin: "8px 0 4px" }}/>
          <SL>2nd Order</SL>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
            <MiniCard label="VANNA" value={fmtCr(gex.vanna)} sub="Δ vs vol"   color="#ff5cff" />
            <MiniCard label="CHARM" value={fmtCr(gex.charm)} sub="time decay" color="#ffd54f" />
          </div>
        </>
      )}
    </PanelWrap>
  );
}

// ════════════════ OI Panel ════════════════════════════════════════════════════

function OIPanel({ oi, nearATMSignals, tailRiskSignals, spot, activeSymbol, liveAlerts }) {
  return (
    <PanelWrap>
      <SL>OI Intelligence</SL>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 8 }}>
        <MiniCard label="PCR"      value={fmt2(oi.pcr)}      sub="put/call"  color={oi.pcr > 1.2 ? "#00ff9c" : oi.pcr < 0.8 ? "#ef5350" : "#ffd54f"} />
        <MiniCard label="MAX PAIN" value={oi.maxPain ? oi.maxPain.toLocaleString("en-IN") : "—"} sub="expiry" color="#4fc3f7" />
        <MiniCard label="TOTAL OI" value={(() => { const t = (oi.totalCallOI || 0) + (oi.totalPutOI || 0); return t > 0 ? (t / 1e5).toFixed(1) + "L" : "—"; })()} />
        <MiniCard label="NET FLOW" value={oi.netPremiumFlow != null ? fmtCr(oi.netPremiumFlow) : "—"} color={oi.netPremiumFlow > 0 ? "#00ff9c" : "#ef5350"} />
      </div>

      {nearATMSignals.length > 0 && (
        <>
          <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 4 }}>
            UNUSUAL OI — NEAR ATM <span style={{ color: "#c8d8e8", fontWeight: 400 }}>±{(activeSymbol || "").toUpperCase().includes("BANK") ? "10" : "8"}%</span>
          </div>
          {nearATMSignals.slice(0, 5).map((u, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 8, fontFamily: "IBM Plex Mono,monospace", padding: "3px 0", borderBottom: i < Math.min(nearATMSignals.length, 5) - 1 ? "1px solid #1a3040" : "none" }}>
              <span style={{ color: (u.type || "").toUpperCase() === "CALL" ? "#4fc3f7" : "#ff8a65", minWidth: 72 }}>{(u.type || "").toUpperCase()} {u.strike}</span>
              <span style={{ color: "#e8f2ff" }}>{(u.oi || 0).toLocaleString("en-IN")}</span>
              <span style={{ color: "#ff5cff", fontSize: 7 }}>v:{(u.vol || 0).toLocaleString("en-IN")}</span>
              {u.oiChgPct > 0 && <span style={{ color: (u.oiChange || 0) > 0 ? "#00ff9c" : "#ef5350", fontSize: 7 }}>{(u.oiChange || 0) > 0 ? "+" : ""}{u.oiChgPct}%</span>}
            </div>
          ))}
        </>
      )}

      {tailRiskSignals.length > 0 && (
        <>
          <div style={{ borderTop: "1px solid #1a3040", margin: "6px 0 4px" }} />
          <div style={{ fontSize: 7, color: "#8a60b0", fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 4 }}>Inst. / Tail Risk</div>
          {tailRiskSignals.slice(0, 3).map((u, i) => (
            <div key={i} style={{ padding: "3px 0", borderBottom: i < 2 ? "1px solid #0a0a20" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, fontFamily: "IBM Plex Mono,monospace" }}>
                <span style={{ color: (u.type || "").toUpperCase() === "CALL" ? "#4fc3f788" : "#ff8a6588" }}>
                  {(u.type || "").toUpperCase()} {u.strike} <span style={{ color: "#c090e0", fontSize: 7 }}>({u.distPct > 0 ? "+" : ""}{u.distPct}%)</span>
                </span>
                <span style={{ color: "#d890f8", fontSize: 7, fontWeight: 700 }}>{u.neighborRatio}× nbrs</span>
              </div>
              {u.interpretation && <div style={{ fontSize: 7, color: "#d0a0f8", fontFamily: "IBM Plex Mono,monospace", lineHeight: 1.3 }}>◈ {u.interpretation}</div>}
            </div>
          ))}
        </>
      )}

      <div style={{ borderTop: "1px solid #1a3040", marginTop: 6, paddingTop: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>⚡ Alerts</div>
          {liveAlerts?.length > 0 && <span style={{ fontSize: 7, fontFamily: "IBM Plex Mono,monospace", padding: "1px 4px", borderRadius: 2, background: "#1a0000", color: "#ef5350" }}>{liveAlerts.length}</span>}
        </div>
        <AlertFeed alerts={liveAlerts} />
      </div>
    </PanelWrap>
  );
}

// ════════════════ Gann Panel ══════════════════════════════════════════════════

function GannPanel({ gann }) {
  if (!gann) return (
    <PanelWrap>
      <SL icon="◤">Gann Analysis</SL>
      <div style={{ fontSize: 8, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", textAlign: "center", padding: "16px 0" }}>◌ Awaiting Gann data…</div>
    </PanelWrap>
  );

  const sig      = gann.signal    || {};
  const son      = gann.squareOfNine || {};
  const fan      = gann.priceOnUpFan || gann.priceOnDownFan || null;
  const cycles   = (gann.timeCycles     || []).slice(0, 4);
  const seasonal = (gann.seasonalAlerts || []).slice(0, 2);
  const gAlerts  = (gann.alerts || []).filter(a => a.priority === "HIGH").slice(0, 2);
  const levels   = gann.keyLevels  || {};
  const cardinal = gann.cardinalCross || {};
  const gBias    = sig.bias || "NEUTRAL";
  const gScore   = sig.score ?? null;
  const gc       = gannPalette(gBias);
  const proxC    = { IMMINENT: "#ef5350", THIS_WEEK: "#ffd54f", THIS_FORTNIGHT: "#ff8a65", THIS_MONTH: "#4fc3f7" };
  const cycC     = { EXTREME: "#ef5350", MAJOR: "#ff8a65", SIGNIFICANT: "#ffd54f", MINOR: "#4a9abb" };

  return (
    <PanelWrap borderColor={gc.border}>
      <SL icon="◤">Gann Analysis</SL>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "6px 8px", background: gc.bg, borderRadius: 4, border: `1px solid ${gc.border}` }}>
        <div style={{ textAlign: "center", minWidth: 40 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: gc.color, fontFamily: "IBM Plex Mono,monospace", lineHeight: 1 }}>{gScore != null ? Math.round(gScore) : "—"}</div>
          <div style={{ fontSize: 7, color: gc.color, fontFamily: "IBM Plex Mono,monospace", opacity: 0.7 }}>/100</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: gc.color, fontFamily: "IBM Plex Mono,monospace" }}>{gBias.replace(/_/g, " ")}</div>
          {sig.summary && <div style={{ fontSize: 8, color: "#a0b8cc", fontFamily: "IBM Plex Mono,monospace", lineHeight: 1.3 }}>{sig.summary.replace(/^Gann: [A-Z]+ \(score \d+\/100\)\.\s?/, "")}</div>}
        </div>
        {cardinal?.inCardinalZone?.strength === "ON_CARDINAL" && (
          <span style={{ fontSize: 7, padding: "1px 4px", borderRadius: 2, background: "#1a0800", border: "1px solid #ffd54f44", color: "#ffd54f", fontFamily: "IBM Plex Mono,monospace" }}>CARDINAL</span>
        )}
      </div>

      {(levels.supports?.length > 0 || levels.resistances?.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 8 }}>
          <div style={{ background: "#071828", border: "1px solid #00ff9c22", borderRadius: 4, padding: "5px 7px" }}>
            <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 3 }}>SUPPORTS</div>
            {(levels.supports || []).slice(0, 3).map((s, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 8, fontFamily: "IBM Plex Mono,monospace", padding: "1px 0" }}>
                <span style={{ color: "#00ff9c" }}>S{i + 1} {fmtInt(s.price)}</span>
                <span style={{ color: "#c8d8e8", fontSize: 7 }}>{s.source?.includes("Nine") ? "SoN" : s.source?.includes("Cardinal") ? "Card" : "—"}</span>
              </div>
            ))}
          </div>
          <div style={{ background: "#071828", border: "1px solid #ef535022", borderRadius: 4, padding: "5px 7px" }}>
            <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 3 }}>RESISTANCES</div>
            {(levels.resistances || []).slice(0, 3).map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 8, fontFamily: "IBM Plex Mono,monospace", padding: "1px 0" }}>
                <span style={{ color: "#ef5350" }}>R{i + 1} {fmtInt(r.price)}</span>
                <span style={{ color: "#c8d8e8", fontSize: 7 }}>{r.source?.includes("Nine") ? "SoN" : r.source?.includes("Cardinal") ? "Card" : "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {son?.positionOnSquare && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 3 }}>SQUARE OF NINE</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", color: "#4fc3f7" }}>{son.angleOnSquare?.toFixed(1)}° on square</span>
            <span style={{ fontSize: 7, padding: "1px 4px", borderRadius: 2, fontFamily: "IBM Plex Mono,monospace",
              background: son.positionOnSquare.strength === "EXTREME" ? "#1a0000" : son.positionOnSquare.strength === "STRONG" ? "#1a0800" : "#0a1020",
              color:      son.positionOnSquare.strength === "EXTREME" ? "#ef5350" : son.positionOnSquare.strength === "STRONG" ? "#ffd54f" : "#4a9abb" }}>
              {son.positionOnSquare.strength}
            </span>
          </div>
          <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", marginTop: 2 }}>{son.positionOnSquare.label}</div>
        </div>
      )}

      {fan && (
        <div style={{ marginBottom: 6, padding: "5px 7px", background: "#071828", borderRadius: 3, border: "1px solid #1a3848" }}>
          <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", marginBottom: 2 }}>GANN FAN</div>
          <div style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", color: fan.aboveMasterAngle ? "#00ff9c" : "#ef5350", fontWeight: 700 }}>
            {fan.aboveMasterAngle ? "▲ Above" : "▼ Below"} 1×1 master
            {fan.criticalLevel != null && <span style={{ color: "#a8c8e0", fontWeight: 400 }}> @ ₹{fmtInt(fan.criticalLevel)}</span>}
          </div>
        </div>
      )}

      {cycles.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 3 }}>TIME CYCLES</div>
          {cycles.map((c, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 8, fontFamily: "IBM Plex Mono,monospace", padding: "2px 0", borderBottom: "1px solid #1a3040" }}>
              <span style={{ color: cycC[c.cycleStrength] || "#4a9abb", flex: 1, paddingRight: 4, lineHeight: 1.3 }}>{c.label}</span>
              <span style={{ color: proxC[c.proximity] || "#4a9abb", whiteSpace: "nowrap", fontSize: 7 }}>
                {c.daysFromToday === 0 ? "TODAY" : c.daysFromToday < 0 ? `${Math.abs(c.daysFromToday)}d ago` : `+${c.daysFromToday}d`}
              </span>
            </div>
          ))}
        </div>
      )}

      {gAlerts.length > 0 && (
        <div>
          <div style={{ fontSize: 7, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 3 }}>ALERTS</div>
          {gAlerts.map((a, i) => (
            <div key={i} style={{ padding: "4px 6px", background: "#1a0000", border: "1px solid #ef535033", borderRadius: 3, marginBottom: 3, fontSize: 8, fontFamily: "IBM Plex Mono,monospace" }}>
              <div style={{ color: "#ef5350", fontWeight: 700 }}>{a.message}</div>
            </div>
          ))}
        </div>
      )}

      {gann.headline && (
        <div style={{ fontSize: 8, color: "#c8d8e8", fontFamily: "IBM Plex Mono,monospace", marginTop: 4, lineHeight: 1.4, padding: "4px 6px", background: "#071828", borderRadius: 3, border: "1px solid #1a3848" }}>{gann.headline}</div>
      )}
    </PanelWrap>
  );
}

// ════════════════ Market Structure Panel ══════════════════════════════════════

function MarketStructurePanel({ structure, gannData, gannBadgeMap, activeSymbol, spot, callWall, putWall, gammaFlip, maxPain, pcr }) {
  const dCall  = callWall  ? calcPct(callWall,  spot) : null;
  const dPut   = putWall   ? calcPct(spot, putWall)   : null;
  const dGamma = gammaFlip ? calcPct(gammaFlip, spot) : null;
  const aboveGF = gammaFlip ? spot > gammaFlip : null;

  let zoneLabel, zoneColor;
  if      (callWall  && spot >= callWall  * 0.99) { zoneLabel = "At Call Wall — resistance"; zoneColor = "#4fc3f7"; }
  else if (putWall   && spot <= putWall   * 1.01) { zoneLabel = "At Put Wall — support";    zoneColor = "#ff8a65"; }
  else if (gammaFlip && spot >= gammaFlip)         { zoneLabel = "Above Gamma Flip — trend"; zoneColor = "#00ff9c"; }
  else if (gammaFlip && spot <  gammaFlip)         { zoneLabel = "Below Gamma Flip — MR";   zoneColor = "#ffd54f"; }
  else                                             { zoneLabel = "Between walls";            zoneColor = "#4a9abb"; }

  return (
    <PanelWrap>
      <SL>Market Structure</SL>

      {gannData && (
        <div style={{ marginBottom: 8 }}>
          <GannBadge symbol={activeSymbol} gannMap={gannBadgeMap} compact={false} />
        </div>
      )}

      {/* Zone badge */}
      {spot && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 7px", borderRadius: 3, marginBottom: 8, background: `${zoneColor}11`, border: `1px solid ${zoneColor}33` }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: zoneColor, display: "inline-block" }} />
          <span style={{ fontSize: 8, color: zoneColor, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700 }}>{zoneLabel}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 8 }}>
        <MiniCard label="SUPPORT (OI)"    value={structure.supportFromOI    ? structure.supportFromOI.toLocaleString("en-IN")    : "—"} sub="put OI wall"  color="#00ff9c" />
        <MiniCard label="RESIST (OI)"     value={structure.resistanceFromOI ? structure.resistanceFromOI.toLocaleString("en-IN") : "—"} sub="call OI wall" color="#ef5350" />
        {gannData?.keyLevels && (
          <>
            <MiniCard label="SUPPORT (GANN)" value={gannData.keyLevels.supports?.[0]?.price ? gannData.keyLevels.supports[0].price.toLocaleString("en-IN") : "—"}    sub={gannData.keyLevels.supports?.[0]?.source  || "SoN"} color="#00ff9c" />
            <MiniCard label="RESIST (GANN)"  value={gannData.keyLevels.resistances?.[0]?.price ? gannData.keyLevels.resistances[0].price.toLocaleString("en-IN") : "—"} sub={gannData.keyLevels.resistances?.[0]?.source || "SoN"} color="#ef5350" />
          </>
        )}
      </div>

      {/* Distance rows */}
      {spot && (
        <div style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace" }}>
          {callWall  && dCall  != null && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #1a3040" }}>
              <span style={{ color: "#c8d8e8" }}>↑ To Call Wall</span>
              <span style={{ color: "#4fc3f7", fontWeight: 700 }}>+{Math.abs(dCall).toFixed(1)}% ₹{fmtInt(callWall - spot)}</span>
            </div>
          )}
          {putWall  && dPut   != null && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #1a3040" }}>
              <span style={{ color: "#c8d8e8" }}>↓ To Put Wall</span>
              <span style={{ color: "#ff8a65", fontWeight: 700 }}>-{Math.abs(dPut).toFixed(1)}% ₹{fmtInt(spot - putWall)}</span>
            </div>
          )}
          {gammaFlip && dGamma != null && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #1a3040" }}>
              <span style={{ color: "#c8d8e8" }}>γ Gamma Flip</span>
              <span style={{ color: aboveGF ? "#00ff9c" : "#ffd54f", fontWeight: 700 }}>{aboveGF ? "+" : "-"}{Math.abs(dGamma).toFixed(1)}% ₹{fmtInt(gammaFlip)}</span>
            </div>
          )}
          {maxPain && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #1a3040" }}>
              <span style={{ color: "#c8d8e8" }}>⊗ Max Pain</span>
              <span style={{ color: "#a8c8e0", fontWeight: 700 }}>₹{fmtInt(maxPain)}</span>
            </div>
          )}
          {pcr != null && (
            <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
              <span style={{ color: "#c8d8e8" }}>⊕ PCR</span>
              <span style={{ color: pcr > 1.2 ? "#00ff9c" : pcr < 0.8 ? "#ef5350" : "#ffd54f", fontWeight: 700 }}>{pcr.toFixed(2)} {pcr > 1.2 ? "bullish" : pcr < 0.8 ? "bearish" : "neutral"}</span>
            </div>
          )}
        </div>
      )}

      {structure.ivEnvironment && (
        <div style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", color: "#a0b8cc", marginTop: 6 }}>
          IV env: <span style={{ color: "#ffd54f" }}>{structure.ivEnvironment.replace(/_/g, " ")}</span>
        </div>
      )}
      {structure.straddlePrice != null && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "5px 0", borderTop: "1px solid #1a3040", marginTop: 6 }}>
          <span style={{ color: "#c8d8e8" }}>ATM Straddle</span>
          <span style={{ color: "#e8f2ff", fontWeight: 700 }}>₹{fmt2(structure.straddlePrice)}</span>
        </div>
      )}
      {gannData?.keyLevels?.masterAngle != null && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "5px 0", borderTop: "1px solid #1a3040" }}>
          <span style={{ color: "#c8d8e8" }}>Gann 1×1</span>
          <span style={{ color: "#ffd54f", fontWeight: 700 }}>₹{Math.round(gannData.keyLevels.masterAngle).toLocaleString("en-IN")}</span>
        </div>
      )}
    </PanelWrap>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ── Main Page
// ════════════════════════════════════════════════════════════════════════════

export default function OptionsIntelligencePage({ socket }) {
  const [data,         setData]        = useState({});
  const [gannMap,      setGannMap]     = useState({});
  const [liveAlerts,   setLiveAlerts]  = useState([]);
  const [activeSymbol, setActiveSymbol]= useState(null);
  const [symbolList,   setSymbolList]  = useState([]);
  const [lastUpdated,  setLastUpdated] = useState(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const t = setInterval(() => forceRender(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const requestGann = useCallback((sym, ltp) => {
    if (!socket || !sym) return;
    socket.emit("get-gann-analysis", { symbol: toGannSym(sym), ltp });
  }, [socket]);

  useEffect(() => {
    if (!socket) return;
    const onIntel = (payload) => {
      if (!payload) return;
      const sym = payload.symbol || "UNKNOWN";
      setSymbolList(prev => prev.includes(sym) ? prev : [sym, ...prev].slice(0, 40));
      setActiveSymbol(prev => {
        if (!prev) {
          const d = payload?.data || payload || {};
          setTimeout(() => requestGann(sym, d?.ltp || d?.spot || null), 100);
        }
        return prev || sym;
      });
      setData(prev => ({ ...prev, [sym]: payload }));
      setLastUpdated(Date.now());
    };
    const onGann = (analysis) => {
      if (!analysis?.symbol) return;
      setGannMap(prev => ({ ...prev, [analysis.symbol.toUpperCase()]: analysis }));
    };
    const onGannAlert = (alert) => {
      if (!alert?.symbol) return;
      (alert.alerts || []).forEach(a => {
        setLiveAlerts(prev => [{ ...a, symbol: alert.symbol, ts: Date.now() }, ...prev].slice(0, 30));
      });
      setGannMap(prev => {
        const ex = prev[alert.symbol.toUpperCase()];
        if (!ex) return prev;
        return { ...prev, [alert.symbol.toUpperCase()]: { ...ex, alerts: [...(alert.alerts || []), ...(ex.alerts || []).filter(a => a.priority !== "HIGH")] } };
      });
    };
    const onMarketAlert = (alert) => {
      if (!alert) return;
      setLiveAlerts(prev => [{ ...alert, ts: Date.now() }, ...prev].slice(0, 30));
    };
    socket.on("options-intelligence", onIntel);
    socket.on("gann-analysis",        onGann);
    socket.on("gann-alert",           onGannAlert);
    socket.on("market-alert",         onMarketAlert);
    return () => {
      socket.off("options-intelligence", onIntel);
      socket.off("gann-analysis",        onGann);
      socket.off("gann-alert",           onGannAlert);
      socket.off("market-alert",         onMarketAlert);
    };
  }, [socket, requestGann]);

  const handleSymbolChange = (sym) => {
    setActiveSymbol(sym);
    const payload = data[sym], d = payload?.data || payload || {};
    requestGann(sym, d?.ltp || d?.spot || null);
  };

  // ── Derived state ───────────────────────────────────────────────────────────
  const current   = data[activeSymbol] || null;
  const d         = current?.data || current || null;
  const score     = d?.score ?? null;
  const bias      = d?.bias  ?? "NEUTRAL";
  const band      = score != null ? ScoreBand(score) : null;

  const vol       = d?.volatility  || {};
  const greeks    = d?.atmGreeks   || {};
  const gex       = d?.gex         || {};
  const oi        = d?.oi          || {};
  const structure = d?.structure   || {};
  const strategy  = d?.strategy    || [];
  const factors   = d?.factors     || [];

  const gannData = activeSymbol
    ? (gannMap[toGannSym(activeSymbol)] || gannMap[activeSymbol] || gannMap[activeSymbol?.toUpperCase()] || null)
    : null;

  const gannBadgeMap = {};
  if (activeSymbol && gannData) {
    const gs = gannData.signal || {}, gl = gannData.keyLevels || {};
    gannBadgeMap[activeSymbol] = {
      bias:       gs.bias || "NEUTRAL",
      support:    gl.supports?.[0]?.price    ?? null,
      resistance: gl.resistances?.[0]?.price ?? null,
      angle:      gannData.squareOfNine?.angleOnSquare ?? null,
    };
  }

  const spot = d?.spot || d?.ltp || structure?.spot || null;

  const oiNear         = oi.unusualOI         || [];
  const oiTail         = oi.unusualOITailRisk || [];
  const rawLeg         = (oiNear.length || oiTail.length) ? null : (oi.unusualOI || []);
  const nearATMSignals = rawLeg ? filterByProximity(rawLeg, spot, activeSymbol, 8) : oiNear;
  const tailRiskSignals= rawLeg
    ? filterByProximity(rawLeg, spot, activeSymbol, 100).filter(u => !filterByProximity([u], spot, activeSymbol, 8).length)
    : oiTail;

  const atmIV  = normaliseIV(vol.atmIV ?? vol.iv ?? vol.atm_iv ?? vol.atmIv ?? null);
  const hv20   = vol.hv20 ?? vol.hv_20 ?? vol.HV20 ?? null;
  const hv60   = vol.hv60 ?? vol.hv_60 ?? vol.HV60 ?? null;
  const vrp    = vol.vrp  ?? vol.vRp   ?? vol.VRP  ?? null;
  const lambda = greeks.lambda ?? greeks.leverage ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#020d1c", overflow: "hidden" }}>

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", borderBottom: "1px solid #1c3a58", flexShrink: 0, background: "#060f1c", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 9, fontWeight: 700, color: "#00cfff", letterSpacing: 1 }}>⚡ OPTIONS INTEL</span>
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", flex: 1 }}>
          {symbolList.length === 0 && <span style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", color: "#c8d8e8" }}>◌ Waiting…</span>}
          {symbolList.slice(0, 20).map(sym => (
            <button key={sym} onClick={() => handleSymbolChange(sym)} style={{ background: activeSymbol === sym ? "#00cfff22" : "transparent", border: `1px solid ${activeSymbol === sym ? "#00cfff66" : "#1c3a58"}`, borderRadius: 2, padding: "1px 7px", cursor: "pointer", fontFamily: "IBM Plex Mono,monospace", fontSize: 8, fontWeight: 700, color: activeSymbol === sym ? "#00cfff" : "#5a90a8" }}>
              {sym}
            </button>
          ))}
        </div>
        {lastUpdated && <span style={{ fontSize: 7, fontFamily: "IBM Plex Mono,monospace", color: "#a0b8cc" }}>Updated {Math.round((Date.now() - lastUpdated) / 1000)}s ago</span>}
      </div>

      {!d ? <EmptyState symbol={activeSymbol} /> : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 8, gap: 8, overflow: "hidden", minHeight: 0 }}>

          {/* ══════ SCORE CARD — compact single row ══════════════════════════ */}
          <div style={{ flexShrink: 0, background: band?.bg || "#060f1c", border: `1px solid ${band?.color || "#1c3a58"}44`, borderRadius: 6, padding: "8px 14px", display: "flex", alignItems: "center", gap: 12 }}>

            {/* LEFT: score + identity */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 56 }}>
                <div style={{ fontSize: 34, fontWeight: 700, fontFamily: "IBM Plex Mono,monospace", color: band?.color || "#4a9abb", lineHeight: 1 }}>{score != null ? Math.round(score) : "—"}</div>
                <div style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: band?.color || "#6aA0b8", letterSpacing: 0.8 }}>{band?.label || "NO DATA"}</div>
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 13, fontWeight: 700, color: "#e8f2ff" }}>{activeSymbol}</span>
                  <span style={{ fontSize: 9, color: band?.color, fontFamily: "IBM Plex Mono,monospace" }}>{bias}</span>
                  {gannData && <GannBadge symbol={activeSymbol} gannMap={gannBadgeMap} compact={true} />}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {strategy.slice(0, 4).map((s, i) => <StrategyTag key={i} signal={s} />)}
                </div>
              </div>
            </div>

            {/* DIVIDER */}
            <VDivider />

            {/* RIGHT: stat strip — Market + Vol + Greeks */}
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flex: 1, flexWrap: "wrap", overflowX: "auto" }}>

              {/* Market */}
              <HStat label="Exp Move" value={structure.expectedMoveAbs ? `±${fmt2(structure.expectedMoveAbs)}` : "—"} sub="1σ" color="#4fc3f7" />
              <HStat label="Evt Risk" value={structure.eventRiskScore != null ? Math.round(structure.eventRiskScore) : "0"} sub="0–100"
                color={structure.eventRiskScore > 60 ? "#ef5350" : structure.eventRiskScore > 0 ? "#ffd54f" : "#5a90a8"} />

              <VDivider />

              {/* Volatility */}
              <HStat label="ATM IV"  value={atmIV != null ? `${atmIV.toFixed(1)}%` : "—"} color="#00cfff" />
              <HStat label="VRP"     value={vrp  != null ? `${vrp > 0 ? "+" : ""}${fmt2(vrp)}%` : "—"} sub="IV−HV20"
                color={vrp != null ? (vrp > 0 ? "#ff8a65" : "#00ff9c") : "#4a9abb"} />
              <HStat label="HV 20"   value={hv20 != null ? `${Number(hv20).toFixed(1)}%` : "—"} />
              <HStat label="HV 60"   value={hv60 != null ? `${Number(hv60).toFixed(1)}%` : "—"} />
              {/* IV Rank bar */}
              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 80 }}>
                <IVRankBar ivRank={vol.ivRank} ivPct={vol.ivPercentile} />
              </div>

              <VDivider />

              {/* Greeks */}
              <HStat label="Delta"  value={fmt2(greeks.delta)}  color={greeks.delta > 0 ? "#00ff9c" : greeks.delta < 0 ? "#ef5350" : "#e8f2ff"} />
              <HStat label="Gamma"  value={greeks.gamma != null ? greeks.gamma.toFixed(4) : "—"} />
              <HStat label="Theta"  value={greeks.theta != null ? fmt2(greeks.theta) : "—"} sub="₹/day" color="#ff8a65" />
              <HStat label="Vega"   value={fmt2(greeks.vega)} sub="1%IV" color="#4fc3f7" />
              <HStat label="Lambda" value={lambda != null ? fmt2(lambda) : "—"} sub="lev" />
              <HStat label="Rho"    value={fmt2(greeks.rho)} />
            </div>
          </div>

          {/* ══════ FOUR PANELS SIDE BY SIDE ════════════════════════════════ */}
          <div style={{ flex: 1, display: "flex", gap: 8, minHeight: 0, overflow: "hidden" }}>
            <GEXPanel gex={gex} />
            <OIPanel
              oi={oi}
              nearATMSignals={nearATMSignals}
              tailRiskSignals={tailRiskSignals}
              spot={spot}
              activeSymbol={activeSymbol}
              liveAlerts={liveAlerts}
            />
            <GannPanel gann={gannData} />
            <MarketStructurePanel
              structure={structure}
              gannData={gannData}
              gannBadgeMap={gannBadgeMap}
              activeSymbol={activeSymbol}
              spot={spot}
              callWall={gex.callWall}
              putWall={gex.putWall}
              gammaFlip={gex.gammaFlip}
              maxPain={oi.maxPain}
              pcr={oi.pcr}
            />
          </div>

        </div>
      )}
    </div>
  );
}
