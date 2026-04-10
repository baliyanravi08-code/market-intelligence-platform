import { useEffect, useState, useCallback, useRef } from "react";
import GannBadge from "../components/GannBadge";

/**
 * OptionsIntelligencePage.jsx — COMPLETE, single file, no extra imports needed.
 *
 * NEW in this version:
 *  A. MarketContextBar — fully inlined (no separate file, no extra import)
 *     · Visual bar: spot dot positioned between put wall → gamma flip → call wall
 *     · Distance rows: "+5.1% to Call Wall, ₹1,225 away"
 *     · OI Signal Read: "🟢 Call unwinding → Breakout potential above 24,000"
 *     · Live Alert Feed: auto-scrolls, fades old alerts after 5 min
 *  B. liveAlerts state — wired to gann-alert + market-alert socket events
 *  C. Symbol normalisation fix: "NIFTY 50"→"NIFTY", "BANK NIFTY"→"BANKNIFTY"
 *     for Gann requests (was causing dead Gann panel)
 *  D. All prior fixes preserved (two-tier OI, IV normalisation, GEX bar, etc.)
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

// ─── Symbol normalisation ─────────────────────────────────────────────────────
const GANN_SYM = { "NIFTY 50": "NIFTY", "BANK NIFTY": "BANKNIFTY", "SENSEX": "SENSEX" };
function toGannSym(sym) { return GANN_SYM[sym] || sym; }

// ─── IV normalisation ─────────────────────────────────────────────────────────
function normaliseIV(raw) {
  if (raw == null) return null;
  const v = Number(raw);
  return isNaN(v) ? null : (v > 200 ? v / 100 : v);
}

// ─── Proximity filter (legacy fallback for old backend) ───────────────────────
function filterByProximity(arr, spot, symbol, pct = 10) {
  if (!arr?.length || !spot) return arr || [];
  const p  = (symbol || "").toUpperCase().includes("BANK") ? 15 : pct;
  const lo = spot * (1 - p / 100);
  const hi = spot * (1 + p / 100);
  return arr.filter(u => Number(u.strike) >= lo && Number(u.strike) <= hi);
}

// ─── Score band ───────────────────────────────────────────────────────────────
function ScoreBand(score) {
  if (score >= 80) return { color: "#00ff9c", bg: "#002210", label: "STRONG BUY" };
  if (score >= 65) return { color: "#4fc3f7", bg: "#001a28", label: "BUY" };
  if (score >= 45) return { color: "#ffd54f", bg: "#1a1500", label: "NEUTRAL" };
  if (score >= 30) return { color: "#ff8a65", bg: "#1a0a00", label: "SELL" };
  return { color: "#ef5350", bg: "#1a0000", label: "STRONG SELL" };
}

// ─── Gann palette ─────────────────────────────────────────────────────────────
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

// ─── OI signal interpreter ────────────────────────────────────────────────────
function interpretOI(u, spot) {
  const isCall    = (u.type || "").toUpperCase() === "CALL";
  const dist      = u.distPct ?? calcPct(u.strike, spot) ?? 0;
  const increasing = (u.oiChange || 0) > 0;
  if (isCall) {
    if (increasing  && dist > 0) return { label: "Supply wall building",   color: "#ef5350", icon: "🔴", action: `Resistance at ${fmtInt(u.strike)}` };
    if (!increasing && dist > 0) return { label: "Call unwinding",          color: "#00ff9c", icon: "🟢", action: `Breakout potential above ${fmtInt(u.strike)}` };
    if (increasing  && dist < 0) return { label: "Call writing below spot", color: "#ffd54f", icon: "🟡", action: `Bearish hedge at ${fmtInt(u.strike)}` };
  } else {
    if (increasing  && dist < 0) return { label: "Support building",        color: "#00ff9c", icon: "🟢", action: `Strong support at ${fmtInt(u.strike)}` };
    if (!increasing && dist < 0) return { label: "Put unwinding",           color: "#4fc3f7", icon: "🔵", action: `Support weakening at ${fmtInt(u.strike)}` };
    if (increasing  && dist > 0) return { label: "Heavy put writing",       color: "#ff8a65", icon: "🔴", action: `Dealer short at ${fmtInt(u.strike)}` };
  }
  return { label: "Positioning", color: "#4a9abb", icon: "◈", action: `${fmtInt(u.strike)} OI activity` };
}

// ─── Alert icon map ───────────────────────────────────────────────────────────
const ALERT_ICONS = {
  GAMMA_FLIP: "⚡", GEX_FLIP: "⚡", PCR_SPIKE: "📊", PUT_WALL: "🟠",
  CALL_WALL: "🔵", OI_SURGE: "🔺", REGIME_CHANGE: "🔄", GANN_ANGLE: "📐",
  TIME_CYCLE: "⏰", CARDINAL_CROSS: "🎯", SQUARE_OF_NINE: "🔢",
};

// ════════════════════════════════════════════════════════════════════════════
// ── Shared sub-components ────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

function StatCard({ label, value, sub, color, small }) {
  const isLong = typeof value === "string" && value.length > 12;
  return (
    <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 6, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: small || isLong ? 11 : 18, fontWeight: 700, color: color || "#d8eeff", fontFamily: "IBM Plex Mono,monospace", wordBreak: "break-word", lineHeight: 1.3 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "#2a6080", marginTop: 3, fontFamily: "IBM Plex Mono,monospace" }}>{sub}</div>}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: "#1a5070", letterSpacing: 1.5, textTransform: "uppercase", borderBottom: "1px solid #0a2030", paddingBottom: 5, marginBottom: 8 }}>
      {children}
    </div>
  );
}

function GexBar({ label, value, max, color }) {
  const pct = Math.min(Math.abs((value || 0) / (max || 1)) * 100, 100);
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "IBM Plex Mono,monospace", marginBottom: 3 }}>
        <span style={{ color: "#7ab0d0" }}>{label}</span><span style={{ color }}>{fmtCr(value)}</span>
      </div>
      <div style={{ height: 4, background: "#0a1828", borderRadius: 2 }}>
        <div style={{ height: 4, width: `${pct}%`, background: color, borderRadius: 2, minWidth: pct > 0 ? 2 : 0 }} />
      </div>
    </div>
  );
}

function StrategyTag({ signal }) {
  const label = typeof signal === "string" ? signal : (signal?.strategy || "");
  const colors = {
    SELL_PREMIUM: { bg: "#002210", color: "#00ff9c", border: "#00ff9c44" },
    BUY_OPTIONS:  { bg: "#001828", color: "#4fc3f7", border: "#4fc3f744" },
    BUY_PREMIUM:  { bg: "#001828", color: "#4fc3f7", border: "#4fc3f744" },
    GAMMA_SQUEEZE:    { bg: "#1a1000", color: "#ffd54f", border: "#ffd54f44" },
    GAMMA_WALL:       { bg: "#1a1000", color: "#ffd54f", border: "#ffd54f44" },
    SKEW_TRADE:       { bg: "#1a0a00", color: "#ff8a65", border: "#ff8a6544" },
    UNUSUAL_ACTIVITY: { bg: "#1a0018", color: "#ff5cff", border: "#ff5cff44" },
    UNUSUAL_OI:       { bg: "#1a0018", color: "#ff5cff", border: "#ff5cff44" },
    DEFENSIVE:        { bg: "#1a0000", color: "#ef5350", border: "#ef535044" },
    IV_CRUSH:         { bg: "#1a0000", color: "#ef5350", border: "#ef535044" },
  };
  const c = colors[label] || { bg: "#0a1828", color: "#4a9abb", border: "#4a9abb44" };
  return (
    <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      {label.replace(/_/g, " ")}
    </span>
  );
}

function IVRankMeter({ ivRank, ivPct }) {
  const rank = Math.min(Math.max(ivRank || 0, 0), 100);
  const clr  = rank > 70 ? "#ef5350" : rank > 40 ? "#ffd54f" : "#00ff9c";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", marginBottom: 4 }}>
        <span style={{ color: "#1a5070" }}>IV RANK</span>
        <span style={{ color: clr, fontWeight: 700 }}>{fmt2(rank)}</span>
      </div>
      <div style={{ height: 8, background: "#0a1828", borderRadius: 4 }}>
        <div style={{ height: 8, width: `${rank}%`, minWidth: 2, background: clr, borderRadius: 4 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, fontFamily: "IBM Plex Mono,monospace", marginTop: 3 }}>
        <span style={{ color: "#1a4060" }}>LOW</span>
        <span style={{ color: "#1a5070" }}>IV%ile: {ivPct != null ? fmt2(ivPct) : "—"}</span>
        <span style={{ color: "#1a4060" }}>HIGH</span>
      </div>
    </div>
  );
}

function EmptyState({ symbol }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 320, gap: 12 }}>
      <div style={{ fontSize: 32, opacity: 0.3 }}>📐</div>
      <div style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 11, color: "#1a5070", textAlign: "center" }}>
        {symbol ? `Waiting for options data on ${symbol}…` : "Select a symbol to view options intelligence"}
      </div>
      <div style={{ fontSize: 9, color: "#0d3050", fontFamily: "IBM Plex Mono,monospace", textAlign: "center", maxWidth: 280, lineHeight: 1.6 }}>
        Live data streams in as your nseOIListener ingests chain data.<br />
        NIFTY, BANKNIFTY, and F&amp;O stocks update every cycle.
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ── MarketContextBar (inlined — no separate file needed) ─────────────────────
// ════════════════════════════════════════════════════════════════════════════

function PriceBar({ spot, putWall, callWall, gammaFlip }) {
  if (!spot || !putWall || !callWall) return null;
  const lo = putWall * 0.96, hi = callWall * 1.04, rng = hi - lo;
  const p  = v => Math.max(0, Math.min(100, (v - lo) / rng * 100));
  const nearPut  = Math.abs(calcPct(spot, putWall))  < 2;
  const nearCall = Math.abs(calcPct(spot, callWall)) < 2;
  const dotClr   = nearPut ? "#ff8a65" : nearCall ? "#4fc3f7" : (gammaFlip && spot > gammaFlip) ? "#00ff9c" : "#ffd54f";
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ position: "relative", height: 18, borderRadius: 4, overflow: "hidden", background: "#0a1828" }}>
        {gammaFlip && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${p(gammaFlip)}%`, width: `${p(callWall) - p(gammaFlip)}%`, background: "#00ff9c09", borderLeft: "1px solid #00ff9c22" }} />}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${p(putWall)}%`,  width: 2, background: "#ff8a6555" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${p(callWall)}%`, width: 2, background: "#4fc3f755" }} />
        {gammaFlip && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${p(gammaFlip)}%`, width: 1, background: "#ffd54f55" }} />}
        <div style={{ position: "absolute", top: 3, bottom: 3, left: `${p(spot)}%`, width: 4, borderRadius: 2, background: dotClr, transform: "translateX(-50%)", boxShadow: `0 0 6px ${dotClr}88` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, fontFamily: "IBM Plex Mono,monospace", marginTop: 3 }}>
        <span style={{ color: "#ff8a6666" }}>PUT {fmtInt(putWall)}</span>
        {gammaFlip && <span style={{ color: "#ffd54f66" }}>γ {fmtInt(gammaFlip)}</span>}
        <span style={{ color: "#4fc3f766" }}>CALL {fmtInt(callWall)}</span>
      </div>
    </div>
  );
}

function CtxRow({ label, value, sub, color, icon }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid #0a1828", fontSize: 9, fontFamily: "IBM Plex Mono,monospace" }}>
      <span style={{ color: "#1a5070" }}>{icon && <span style={{ marginRight: 4 }}>{icon}</span>}{label}</span>
      <div style={{ textAlign: "right" }}>
        <span style={{ color: color || "#d8eeff", fontWeight: 700 }}>{value}</span>
        {sub && <span style={{ color: "#1a4060", marginLeft: 6 }}>{sub}</span>}
      </div>
    </div>
  );
}

function AlertFeed({ alerts }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = 0; }, [alerts?.length]);
  if (!alerts?.length) {
    return <div style={{ fontSize: 9, color: "#0d3050", fontFamily: "IBM Plex Mono,monospace", textAlign: "center", padding: "10px 0" }}>◌ No alerts — market quiet</div>;
  }
  return (
    <div ref={ref} style={{ maxHeight: 140, overflowY: "auto" }}>
      {alerts.slice(0, 12).map((a, i) => {
        const icon   = ALERT_ICONS[a.type] || "◈";
        const isHigh = a.priority === "HIGH";
        const color  = isHigh ? "#ef5350" : a.priority === "MEDIUM" ? "#ffd54f" : "#4a9abb";
        const age    = a.ts ? Math.round((Date.now() - a.ts) / 1000) : null;
        return (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "5px 0", borderBottom: i < alerts.length - 1 ? "1px solid #0a1828" : "none", opacity: age && age > 300 ? 0.4 : 1 }}>
            <span style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }}>{icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9, color, fontFamily: "IBM Plex Mono,monospace", fontWeight: isHigh ? 700 : 400, lineHeight: 1.4 }}>{a.message || a.detail || String(a)}</div>
              {a.detail && a.message && <div style={{ fontSize: 8, color: "#1a4060", fontFamily: "IBM Plex Mono,monospace", marginTop: 1, lineHeight: 1.3 }}>{a.detail}</div>}
            </div>
            {age != null && <span style={{ fontSize: 7, color: "#0d3050", fontFamily: "IBM Plex Mono,monospace", flexShrink: 0, marginTop: 2 }}>{age < 60 ? `${age}s` : `${Math.round(age / 60)}m`}</span>}
          </div>
        );
      })}
    </div>
  );
}

function MarketContextBar({ spot, callWall, putWall, gammaFlip, maxPain, pcr, alerts, nearATMSignals, symbol }) {
  if (!spot) return null;

  const dCall  = callWall  ? calcPct(callWall,  spot) : null;
  const dPut   = putWall   ? calcPct(spot, putWall)   : null;
  const dGamma = gammaFlip ? calcPct(gammaFlip, spot) : null;
  const dPain  = maxPain   ? calcPct(maxPain,   spot) : null;
  const aboveGF = gammaFlip ? spot > gammaFlip : null;

  let zoneLabel, zoneColor;
  if (callWall  && spot >= callWall  * 0.99) { zoneLabel = "At Call Wall — resistance zone";    zoneColor = "#4fc3f7"; }
  else if (putWall  && spot <= putWall  * 1.01) { zoneLabel = "At Put Wall — support zone";     zoneColor = "#ff8a65"; }
  else if (gammaFlip && spot >= gammaFlip)       { zoneLabel = "Above Gamma Flip — trend zone"; zoneColor = "#00ff9c"; }
  else if (gammaFlip && spot <  gammaFlip)       { zoneLabel = "Below Gamma Flip — mean-revert";zoneColor = "#ffd54f"; }
  else { zoneLabel = "Between walls"; zoneColor = "#4a9abb"; }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

      {/* Price position card */}
      <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
        <SectionLabel>Price vs Key Levels</SectionLabel>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 4, marginBottom: 10, background: `${zoneColor}11`, border: `1px solid ${zoneColor}33` }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: zoneColor, display: "inline-block" }} />
          <span style={{ fontSize: 9, color: zoneColor, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700 }}>{zoneLabel}</span>
        </div>
        <PriceBar spot={spot} putWall={putWall} callWall={callWall} gammaFlip={gammaFlip} />
        {callWall  && dCall  != null && <CtxRow label="To Call Wall"  value={`+${Math.abs(dCall).toFixed(1)}%`}  sub={`₹${fmtInt(callWall - spot)} away`}  color="#4fc3f7" icon="↑" />}
        {putWall   && dPut   != null && <CtxRow label="To Put Wall"   value={`-${Math.abs(dPut).toFixed(1)}%`}   sub={`₹${fmtInt(spot - putWall)} away`}   color="#ff8a65" icon="↓" />}
        {gammaFlip && dGamma != null && <CtxRow label="Gamma Flip" value={aboveGF ? `+${Math.abs(dGamma).toFixed(1)}% above` : `-${Math.abs(dGamma).toFixed(1)}% below`} sub={`₹${fmtInt(gammaFlip)}`} color={aboveGF ? "#00ff9c" : "#ffd54f"} icon="γ" />}
        {maxPain   && dPain  != null && <CtxRow label="Max Pain"  value={`${dPain >= 0 ? "+" : ""}${dPain.toFixed(1)}%`} sub={`₹${fmtInt(maxPain)} expiry magnet`} color="#4a9abb" icon="⊗" />}
        {pcr != null && <CtxRow label="PCR" value={pcr.toFixed(2)} sub={pcr > 1.2 ? "bullish (put-heavy)" : pcr < 0.8 ? "bearish (call-heavy)" : "neutral"} color={pcr > 1.2 ? "#00ff9c" : pcr < 0.8 ? "#ef5350" : "#ffd54f"} icon="⊕" />}
      </div>

      {/* OI Signal Read */}
      {nearATMSignals?.length > 0 && (
        <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
          <SectionLabel>OI Signal Read</SectionLabel>
          {nearATMSignals.slice(0, 4).map((u, i) => {
            const interp = interpretOI(u, spot);
            return (
              <div key={i} style={{ padding: "6px 0", borderBottom: i < Math.min(nearATMSignals.length, 4) - 1 ? "1px solid #0a1828" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 11 }}>{interp.icon}</span>
                  <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: interp.color, fontWeight: 700 }}>{interp.label}</span>
                  <span style={{ fontSize: 8, color: "#1a4060", fontFamily: "IBM Plex Mono,monospace", marginLeft: "auto" }}>{(u.type || "").toUpperCase()} {u.strike}</span>
                </div>
                <div style={{ fontSize: 8, color: "#2a6080", fontFamily: "IBM Plex Mono,monospace", paddingLeft: 18, lineHeight: 1.4 }}>
                  {interp.action}
                  {u.oiChgPct > 5 && <span style={{ color: (u.oiChange || 0) > 0 ? "#00ff9c88" : "#ef535088", marginLeft: 8 }}>· OI {(u.oiChange || 0) > 0 ? "▲" : "▼"} {u.oiChgPct}%</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Alert Feed */}
      <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #0a2030", paddingBottom: 5, marginBottom: 8 }}>
          <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: "#1a5070", letterSpacing: 1.5, textTransform: "uppercase" }}>⚡ Live Alerts</div>
          {alerts?.length > 0 && (
            <span style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", padding: "1px 5px", borderRadius: 3, background: "#1a0000", border: "1px solid #ef535033", color: "#ef5350" }}>{alerts.length}</span>
          )}
        </div>
        <AlertFeed alerts={alerts} />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ── GannPanel ────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

function GannPanel({ gann }) {
  if (!gann) {
    return (
      <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
        <SectionLabel>📐 Gann Analysis</SectionLabel>
        <div style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", textAlign: "center", padding: "20px 0" }}>
          ◌ Awaiting Gann data…<br /><span style={{ color: "#0d3050" }}>Swing data ingested at startup — check gannDataFetcher</span>
        </div>
      </div>
    );
  }
  const sig = gann.signal || {}, son = gann.squareOfNine || {}, fan = gann.priceOnUpFan || gann.priceOnDownFan || null;
  const cycles = (gann.timeCycles || []).slice(0, 4), seasonal = (gann.seasonalAlerts || []).slice(0, 2);
  const gAlerts = (gann.alerts || []).filter(a => a.priority === "HIGH").slice(0, 3);
  const levels = gann.keyLevels || {}, cardinal = gann.cardinalCross || {};
  const gBias = sig.bias || "NEUTRAL", gScore = sig.score ?? null, gc = gannPalette(gBias);
  const proxC = { IMMINENT: "#ef5350", THIS_WEEK: "#ffd54f", THIS_FORTNIGHT: "#ff8a65", THIS_MONTH: "#4fc3f7" };
  const cycC  = { EXTREME: "#ef5350", MAJOR: "#ff8a65", SIGNIFICANT: "#ffd54f", MINOR: "#4a9abb" };

  return (
    <div style={{ background: "#010a18", border: `1px solid ${gc.border}`, borderRadius: 8, padding: "12px 14px" }}>
      <SectionLabel>📐 Gann Analysis</SectionLabel>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "8px 10px", background: gc.bg, borderRadius: 6, border: `1px solid ${gc.border}` }}>
        <div style={{ textAlign: "center", minWidth: 48 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: gc.color, fontFamily: "IBM Plex Mono,monospace", lineHeight: 1 }}>{gScore != null ? Math.round(gScore) : "—"}</div>
          <div style={{ fontSize: 8, color: gc.color, fontFamily: "IBM Plex Mono,monospace", opacity: 0.7, marginTop: 2 }}>/100</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: gc.color, fontFamily: "IBM Plex Mono,monospace" }}>{gBias.replace(/_/g, " ")}</div>
          {sig.summary && <div style={{ fontSize: 9, color: "#2a6080", fontFamily: "IBM Plex Mono,monospace", marginTop: 2, lineHeight: 1.4 }}>{sig.summary.replace(/^Gann: [A-Z]+ \(score \d+\/100\)\.\s?/, "")}</div>}
        </div>
        {cardinal?.inCardinalZone?.strength === "ON_CARDINAL" && <span style={{ fontSize: 8, padding: "2px 6px", borderRadius: 3, background: "#1a0800", border: "1px solid #ffd54f44", color: "#ffd54f", fontFamily: "IBM Plex Mono,monospace" }}>ON CARDINAL</span>}
      </div>
      {gann.headline && <div style={{ fontSize: 9, color: "#2a7090", fontFamily: "IBM Plex Mono,monospace", marginBottom: 8, lineHeight: 1.5, padding: "4px 6px", background: "#010f1e", borderRadius: 4, border: "1px solid #0a2030" }}>{gann.headline}</div>}
      {(levels.supports?.length > 0 || levels.resistances?.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <div style={{ background: "#010f1e", border: "1px solid #00ff9c22", borderRadius: 5, padding: "7px 9px" }}>
            <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>GANN SUPPORTS</div>
            {(levels.supports || []).slice(0, 3).map((s, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "2px 0" }}>
                <span style={{ color: "#00ff9c" }}>S{i + 1} {fmtInt(s.price)}</span>
                <span style={{ color: "#1a4060", fontSize: 8 }}>{s.source?.includes("Nine") ? "SoN" : s.source?.includes("Cardinal") ? "Card" : s.source?.includes("1×1") ? "1×1" : "—"}</span>
              </div>
            ))}
          </div>
          <div style={{ background: "#010f1e", border: "1px solid #ef535022", borderRadius: 5, padding: "7px 9px" }}>
            <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>GANN RESISTANCES</div>
            {(levels.resistances || []).slice(0, 3).map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "2px 0" }}>
                <span style={{ color: "#ef5350" }}>R{i + 1} {fmtInt(r.price)}</span>
                <span style={{ color: "#1a4060", fontSize: 8 }}>{r.source?.includes("Nine") ? "SoN" : r.source?.includes("Cardinal") ? "Card" : r.source?.includes("1×1") ? "1×1" : "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {son?.positionOnSquare && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>SQUARE OF NINE</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#4fc3f7" }}>{son.angleOnSquare?.toFixed(1)}° on square</span>
            <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, fontFamily: "IBM Plex Mono,monospace", background: son.positionOnSquare.strength === "EXTREME" ? "#1a0000" : son.positionOnSquare.strength === "STRONG" ? "#1a0800" : "#0a1020", color: son.positionOnSquare.strength === "EXTREME" ? "#ef5350" : son.positionOnSquare.strength === "STRONG" ? "#ffd54f" : "#4a9abb", border: "1px solid #0a2030" }}>{son.positionOnSquare.strength}</span>
          </div>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", marginTop: 3 }}>{son.positionOnSquare.label}</div>
          {son.priceVibration && <div style={{ fontSize: 8, color: "#0d3050", fontFamily: "IBM Plex Mono,monospace", marginTop: 2 }}>{son.priceVibration}</div>}
        </div>
      )}
      {fan && (
        <div style={{ marginBottom: 8, padding: "6px 8px", background: "#010f1e", borderRadius: 4, border: "1px solid #0a2030" }}>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>GANN FAN</div>
          <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: fan.aboveMasterAngle ? "#00ff9c" : "#ef5350", fontWeight: 700 }}>
            {fan.aboveMasterAngle ? "▲ Above" : "▼ Below"} 1×1 master angle
            {fan.criticalLevel != null && <span style={{ color: "#4a9abb", fontWeight: 400 }}> @ ₹{fmtInt(fan.criticalLevel)}</span>}
          </div>
          {fan.trendStrength && <div style={{ fontSize: 8, color: "#2a6080", fontFamily: "IBM Plex Mono,monospace", marginTop: 2 }}>{fan.trendStrength}</div>}
          {fan.alert         && <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", marginTop: 2 }}>{fan.alert}</div>}
        </div>
      )}
      {cycles.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>TIME CYCLES (NEXT 30d)</div>
          {cycles.map((c, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "3px 0", borderBottom: "1px solid #0a1828" }}>
              <span style={{ color: cycC[c.cycleStrength] || "#4a9abb", flex: 1, paddingRight: 6, lineHeight: 1.3 }}>{c.label}</span>
              <span style={{ color: proxC[c.proximity] || "#4a9abb", whiteSpace: "nowrap" }}>{c.daysFromToday === 0 ? "TODAY" : c.daysFromToday < 0 ? `${Math.abs(c.daysFromToday)}d ago` : `+${c.daysFromToday}d`}</span>
            </div>
          ))}
        </div>
      )}
      {seasonal.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>SEASONAL PRESSURE</div>
          {seasonal.map((s, i) => (
            <div key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: s.daysAway <= 3 ? "#ffd54f" : "#2a6080", padding: "2px 0" }}>
              📅 {s.label} <span style={{ color: "#1a4060", marginLeft: 6 }}>{s.daysAway === 0 ? "TODAY" : s.daysAway < 0 ? `${Math.abs(s.daysAway)}d ago` : `in ${s.daysAway}d`}</span>
            </div>
          ))}
        </div>
      )}
      {gAlerts.length > 0 && (
        <div>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>GANN ALERTS</div>
          {gAlerts.map((a, i) => (
            <div key={i} style={{ padding: "5px 7px", background: "#1a0000", border: "1px solid #ef535033", borderRadius: 4, marginBottom: 4, fontSize: 9, fontFamily: "IBM Plex Mono,monospace" }}>
              <div style={{ color: "#ef5350", fontWeight: 700, marginBottom: 2 }}>{a.message}</div>
              {a.detail && <div style={{ color: "#5a2020", lineHeight: 1.4 }}>{a.detail}</div>}
            </div>
          ))}
        </div>
      )}
      {(sig.factors || []).length > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px solid #0a1828", paddingTop: 8 }}>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>SIGNAL FACTORS</div>
          {(sig.factors || []).slice(0, 4).map((f, i) => (
            <div key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#2a7090", marginBottom: 2, lineHeight: 1.4 }}>· {f}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ── Main Page ────────────────────────────────────────════════════════════════
// ════════════════════════════════════════════════════════════════════════════

export default function OptionsIntelligencePage({ socket }) {
  const [data,         setData]        = useState({});
  const [gannMap,      setGannMap]     = useState({});
  const [liveAlerts,   setLiveAlerts]  = useState([]);
  const [activeSymbol, setActiveSymbol] = useState(null);
  const [symbolList,   setSymbolList]  = useState([]);
  const [lastUpdated,  setLastUpdated] = useState(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const t = setInterval(() => forceRender(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const requestGann = useCallback((sym, ltp) => {
    if (!socket || !sym) return;
    // ← FIX: normalise symbol before sending ("NIFTY 50" → "NIFTY")
    socket.emit("get-gann-analysis", { symbol: toGannSym(sym), ltp });
  }, [socket]);

  useEffect(() => {
    if (!socket) return;

    const onIntel = (payload) => {
      if (!payload) return;
      const sym = payload.symbol || "UNKNOWN";
      setSymbolList(prev => prev.includes(sym) ? prev : [sym, ...prev].slice(0, 40));
      setActiveSymbol(prev => {
        if (!prev) { const d = payload?.data || payload || {}; setTimeout(() => requestGann(sym, d?.ltp || d?.spot || null), 100); }
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

  const current = data[activeSymbol] || null;
  const d       = current?.data || current || null;
  const score   = d?.score ?? null;
  const bias    = d?.bias  ?? "NEUTRAL";
  const band    = score != null ? ScoreBand(score) : null;

  const vol = d?.volatility || {}, greeks = d?.atmGreeks || {}, gex = d?.gex || {};
  const oi  = d?.oi || {}, structure = d?.structure || {};
  const strategy = d?.strategy || [], factors = d?.factors || [];

  // Gann data — look up by both short and long key
  const gannData = activeSymbol
    ? (gannMap[toGannSym(activeSymbol)] || gannMap[activeSymbol] || gannMap[activeSymbol?.toUpperCase()] || null)
    : null;

  const gannBadgeMap = {};
  if (activeSymbol && gannData) {
    const gs = gannData.signal || {}, gl = gannData.keyLevels || {};
    gannBadgeMap[activeSymbol] = { bias: gs.bias || "NEUTRAL", support: gl.supports?.[0]?.price ?? null, resistance: gl.resistances?.[0]?.price ?? null, angle: gannData.squareOfNine?.angleOnSquare ?? null };
  }

  const gexCallVal = gex.callGEX ?? null, gexPutVal = gex.putGEX ?? null;
  const gexMax = Math.max(Math.abs(gex.netGEX || 0), Math.abs(gexCallVal || 0), Math.abs(gexPutVal || 0), 1);
  const spot = d?.spot || d?.ltp || structure?.spot || null;

  // Two-tier OI
  const oiNear = oi.unusualOI || [], oiTail = oi.unusualOITailRisk || [];
  const rawLeg = (oiNear.length || oiTail.length) ? null : (oi.unusualOI || []);
  const nearATMSignals  = rawLeg ? filterByProximity(rawLeg, spot, activeSymbol, 8)  : oiNear;
  const tailRiskSignals = rawLeg ? filterByProximity(rawLeg, spot, activeSymbol, 100).filter(u => !filterByProximity([u], spot, activeSymbol, 8).length) : oiTail;

  const atmIV  = normaliseIV(vol.atmIV ?? vol.iv ?? vol.atm_iv ?? vol.atmIv ?? null);
  const hv20   = vol.hv20  ?? vol.hv_20 ?? vol.HV20 ?? null;
  const hv60   = vol.hv60  ?? vol.hv_60 ?? vol.HV60 ?? null;
  const vrp    = vol.vrp   ?? vol.vRp   ?? vol.VRP  ?? null;
  const lambda = greeks.lambda ?? greeks.leverage ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#020d1c" }}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #0c2240", flexShrink: 0, background: "#010a18", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 10, fontWeight: 700, color: "#00cfff", letterSpacing: 1 }}>⚡ OPTIONS INTELLIGENCE</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
          {symbolList.length === 0 && <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#1a5070" }}>◌ Waiting for live data…</span>}
          {symbolList.slice(0, 20).map(sym => (
            <button key={sym} onClick={() => handleSymbolChange(sym)} style={{ background: activeSymbol === sym ? "#00cfff22" : "transparent", border: `1px solid ${activeSymbol === sym ? "#00cfff66" : "#0c2240"}`, borderRadius: 3, padding: "2px 8px", cursor: "pointer", fontFamily: "IBM Plex Mono,monospace", fontSize: 9, fontWeight: 700, color: activeSymbol === sym ? "#00cfff" : "#2a6080" }}>
              {sym}
            </button>
          ))}
        </div>
        {lastUpdated && <span style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", color: "#0d3050", marginLeft: "auto" }}>Updated {Math.round((Date.now() - lastUpdated) / 1000)}s ago</span>}
      </div>

      {!d ? <EmptyState symbol={activeSymbol} /> : (
        <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10, alignContent: "start" }}>

          {/* Score Card */}
          <div style={{ gridColumn: "1 / -1", background: band?.bg || "#010a18", border: `1px solid ${band?.color || "#0c2240"}44`, borderRadius: 8, padding: "14px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 80 }}>
              <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "IBM Plex Mono,monospace", color: band?.color || "#4a9abb", lineHeight: 1 }}>{score != null ? Math.round(score) : "—"}</div>
              <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: band?.color || "#1a5070", letterSpacing: 1 }}>{band?.label || "NO DATA"}</div>
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 14, fontWeight: 700, color: "#d8eeff" }}>{activeSymbol}</span>
                <span style={{ fontSize: 10, color: band?.color, fontWeight: 400, fontFamily: "IBM Plex Mono,monospace" }}>{bias}</span>
                {gannData && <GannBadge symbol={activeSymbol} gannMap={gannBadgeMap} compact={true} />}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>{strategy.slice(0, 5).map((s, i) => <StrategyTag key={i} signal={s} />)}</div>
              {factors.length > 0 && <div>{factors.slice(0, 3).map((f, i) => <div key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#2a7090", marginBottom: 2 }}>· {typeof f === "string" ? f : (f.label || f.reason || JSON.stringify(f))}</div>)}</div>}
              {gannData?.headline && <div style={{ marginTop: 6, fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#1a5070", lineHeight: 1.4 }}>📐 {gannData.headline}</div>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, minWidth: 200 }}>
              <StatCard label="EXPECTED MOVE" value={structure.expectedMoveAbs ? `±${fmt2(structure.expectedMoveAbs)}` : "—"} sub="1σ straddle" color="#4fc3f7" />
              <StatCard label="EVENT RISK" value={structure.eventRiskScore != null ? Math.round(structure.eventRiskScore) : "0"} sub="0–100 scale" color={structure.eventRiskScore > 60 ? "#ef5350" : structure.eventRiskScore > 0 ? "#ffd54f" : "#2a6080"} />
            </div>
          </div>

          {/* Volatility */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Volatility</SectionLabel>
            <IVRankMeter ivRank={vol.ivRank} ivPct={vol.ivPercentile} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
              <StatCard label="ATM IV" value={atmIV != null ? `${atmIV.toFixed(1)}%` : "—"} color="#00cfff" />
              <StatCard label="VRP" value={vrp != null ? `${vrp > 0 ? "+" : ""}${fmt2(vrp)}%` : "—"} sub="IV − HV20" color={vrp != null ? (vrp > 0 ? "#ff8a65" : "#00ff9c") : "#4a9abb"} />
              <StatCard label="HV 20" value={hv20 != null ? `${Number(hv20).toFixed(1)}%` : "—"} />
              <StatCard label="HV 60" value={hv60 != null ? `${Number(hv60).toFixed(1)}%` : "—"} />
            </div>
          </div>

          {/* GEX */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Dealer Positioning (GEX)</SectionLabel>
            <GexBar label="Net GEX"  value={gex.netGEX}  max={gexMax} color={gex.netGEX >= 0 ? "#00ff9c" : "#ef5350"} />
            <GexBar label="Call GEX" value={gexCallVal}  max={gexMax} color="#4fc3f7" />
            <GexBar label="Put GEX"  value={gexPutVal}   max={gexMax} color="#ff8a65" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <StatCard label="GAMMA FLIP" value={gex.gammaFlip ? gex.gammaFlip.toLocaleString("en-IN") : "—"} sub="spot level" color="#ffd54f" />
              <StatCard label="REGIME"     value={gex.regime ? gex.regime.replace(/_/g, " ") : "—"} small color={gex.regime === "MEAN_REVERTING" ? "#00ff9c" : "#ef5350"} />
              <StatCard label="CALL WALL"  value={gex.callWall ? gex.callWall.toLocaleString("en-IN") : "—"} sub="resistance" color="#4fc3f7" />
              <StatCard label="PUT WALL"   value={gex.putWall  ? gex.putWall.toLocaleString("en-IN")  : "—"} sub="support"    color="#ff8a65" />
            </div>
          </div>

          {/* OI Panel */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Open Interest Intelligence</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="PCR"      value={fmt2(oi.pcr)} sub="put/call ratio" color={oi.pcr > 1.2 ? "#00ff9c" : oi.pcr < 0.8 ? "#ef5350" : "#ffd54f"} />
              <StatCard label="MAX PAIN" value={oi.maxPain ? oi.maxPain.toLocaleString("en-IN") : "—"} sub="expiry" color="#4fc3f7" />
              <StatCard label="TOTAL OI" value={(() => { const t = (oi.totalCallOI || 0) + (oi.totalPutOI || 0); return t > 0 ? (t / 1e5).toFixed(1) + "L" : "—"; })()} />
              <StatCard label="NET FLOW" value={oi.netPremiumFlow != null ? fmtCr(oi.netPremiumFlow) : "—"} color={oi.netPremiumFlow > 0 ? "#00ff9c" : "#ef5350"} />
            </div>
            {(nearATMSignals.length > 0 || tailRiskSignals.length > 0) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {nearATMSignals.length > 0 && (
                  <div style={{ background: "#010f1e", border: "1px solid #0a2030", borderRadius: 5, padding: "8px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>Unusual OI — Near ATM</div>
                      <span style={{ fontSize: 8, color: "#1a4060", fontFamily: "IBM Plex Mono,monospace" }}>±{(activeSymbol || "").toUpperCase().includes("BANK") ? "10" : "8"}% of spot</span>
                    </div>
                    {nearATMSignals.slice(0, 5).map((u, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "4px 0", borderBottom: i < nearATMSignals.slice(0, 5).length - 1 ? "1px solid #0a1828" : "none" }}>
                        <span style={{ color: (u.type || "").toUpperCase() === "CALL" ? "#4fc3f7" : "#ff8a65", minWidth: 80 }}>{(u.type || "").toUpperCase()} {u.strike}</span>
                        <span style={{ color: "#d8eeff" }}>{(u.oi || 0).toLocaleString("en-IN")} OI</span>
                        <span style={{ color: "#ff5cff" }}>vol: {(u.vol || 0).toLocaleString("en-IN")}</span>
                        {u.oiChgPct > 0 && <span style={{ color: (u.oiChange || 0) > 0 ? "#00ff9c" : "#ef5350", fontSize: 8 }}>{(u.oiChange || 0) > 0 ? "+" : ""}{u.oiChgPct}%</span>}
                      </div>
                    ))}
                  </div>
                )}
                {tailRiskSignals.length > 0 && (
                  <div style={{ background: "#0a0a18", border: "1px solid #1a0a3040", borderRadius: 5, padding: "8px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 8, color: "#5a3080", fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>Institutional / Tail Risk</div>
                      <span style={{ fontSize: 8, color: "#2a1040", fontFamily: "IBM Plex Mono,monospace" }}>far OTM · anomalous vs neighbours</span>
                    </div>
                    {tailRiskSignals.slice(0, 4).map((u, i) => (
                      <div key={i} style={{ padding: "5px 0", borderBottom: i < tailRiskSignals.slice(0, 4).length - 1 ? "1px solid #0a0a20" : "none" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9, fontFamily: "IBM Plex Mono,monospace" }}>
                          <span style={{ color: (u.type || "").toUpperCase() === "CALL" ? "#4fc3f788" : "#ff8a6588", minWidth: 80 }}>{(u.type || "").toUpperCase()} {u.strike} <span style={{ color: "#2a1040" }}>({u.distPct > 0 ? "+" : ""}{u.distPct}%)</span></span>
                          <span style={{ color: "#5a4070" }}>{(u.oi || 0).toLocaleString("en-IN")} OI</span>
                          <span style={{ fontSize: 8, color: "#8040a0", fontWeight: 700 }}>{u.neighborRatio}× nbrs</span>
                        </div>
                        {u.interpretation && <div style={{ fontSize: 8, color: "#3a1060", fontFamily: "IBM Plex Mono,monospace", marginTop: 2, lineHeight: 1.4 }}>◈ {u.interpretation}{u.oiChgPct > 0 && <span style={{ color: (u.oiChange || 0) > 0 ? "#40805088" : "#80404088", marginLeft: 6 }}>OI {(u.oiChange || 0) > 0 ? "+" : ""}{u.oiChgPct}%</span>}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ══ MarketContextBar — sits right here in the grid, no import needed ══ */}
          <MarketContextBar
            spot={spot}
            callWall={gex.callWall}
            putWall={gex.putWall}
            gammaFlip={gex.gammaFlip}
            maxPain={oi.maxPain}
            pcr={oi.pcr}
            alerts={liveAlerts}
            nearATMSignals={nearATMSignals}
            symbol={activeSymbol}
          />

          {/* Greeks */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Portfolio Greeks (ATM)</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="DELTA"  value={fmt2(greeks.delta)} color={greeks.delta > 0 ? "#00ff9c" : "#ef5350"} />
              <StatCard label="GAMMA"  value={greeks.gamma != null ? greeks.gamma.toFixed(4) : "—"} />
              <StatCard label="THETA"  value={greeks.theta != null ? fmt2(greeks.theta) : "—"} sub="₹/day" color="#ff8a65" />
              <StatCard label="VEGA"   value={fmt2(greeks.vega)} sub="per 1% IV" color="#4fc3f7" />
              <StatCard label="LAMBDA" value={lambda != null ? fmt2(lambda) : "—"} sub="leverage" />
              <StatCard label="RHO"    value={fmt2(greeks.rho)} />
            </div>
            {(gex.vanna != null || gex.charm != null) && (
              <>
                <SectionLabel>Second-Order Flow</SectionLabel>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <StatCard label="VANNA (DEX)" value={gex.vanna != null ? fmtCr(gex.vanna) : "—"} sub="Δ vs vol" color="#ff5cff" />
                  <StatCard label="CHARM"       value={gex.charm != null ? fmtCr(gex.charm) : "—"} sub="time-decay flow" color="#ffd54f" />
                </div>
              </>
            )}
          </div>

          {/* Gann Panel */}
          <GannPanel gann={gannData} />

          {/* Market Structure */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Market Structure</SectionLabel>
            {gannData && <div style={{ marginBottom: 10 }}><GannBadge symbol={activeSymbol} gannMap={gannBadgeMap} compact={false} /></div>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="SUPPORT (OI)"    value={structure.supportFromOI ? structure.supportFromOI.toLocaleString("en-IN") : "—"} sub="put OI wall" color="#00ff9c" />
              <StatCard label="RESISTANCE (OI)" value={structure.resistanceFromOI ? structure.resistanceFromOI.toLocaleString("en-IN") : "—"} sub="call OI wall" color="#ef5350" />
              {gannData?.keyLevels && (
                <>
                  <StatCard label="SUPPORT (GANN)"    value={gannData.keyLevels.supports?.[0]?.price ? gannData.keyLevels.supports[0].price.toLocaleString("en-IN") : "—"} sub={gannData.keyLevels.supports?.[0]?.source || "Square of Nine"} color="#00ff9c" />
                  <StatCard label="RESISTANCE (GANN)" value={gannData.keyLevels.resistances?.[0]?.price ? gannData.keyLevels.resistances[0].price.toLocaleString("en-IN") : "—"} sub={gannData.keyLevels.resistances?.[0]?.source || "Square of Nine"} color="#ef5350" />
                </>
              )}
            </div>
            {structure.ivEnvironment && <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#2a6080", marginBottom: 6 }}>IV env: <span style={{ color: "#ffd54f" }}>{structure.ivEnvironment.replace(/_/g, " ")}</span></div>}
            {structure.straddlePrice != null && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "IBM Plex Mono,monospace", padding: "6px 0", borderTop: "1px solid #0a1828" }}>
                <span style={{ color: "#1a5070" }}>ATM Straddle</span>
                <span style={{ color: "#d8eeff", fontWeight: 700 }}>₹{fmt2(structure.straddlePrice)}</span>
              </div>
            )}
            {gannData?.keyLevels?.masterAngle != null && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "IBM Plex Mono,monospace", padding: "6px 0", borderTop: "1px solid #0a1828" }}>
                <span style={{ color: "#1a5070" }}>Gann 1×1 Master</span>
                <span style={{ color: "#ffd54f", fontWeight: 700 }}>₹{Math.round(gannData.keyLevels.masterAngle).toLocaleString("en-IN")}</span>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
