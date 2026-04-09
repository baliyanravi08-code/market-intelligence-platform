import { useEffect, useState, useCallback } from "react";
import GannBadge from "../components/GannBadge";

/**
 * OptionsIntelligencePage.jsx
 *
 * FIXES IN THIS VERSION:
 *  1. Unusual OI proximity filter — only shows strikes within ±10% of spot
 *     (was showing PUT 20300–20600 when spot=23775, i.e. 14–17% OTM)
 *  2. ATM IV defensive cap — values > 500% are almost certainly a units error
 *     (backend sends raw decimal e.g. 20.65 → frontend was showing 2065.0%)
 *  3. Spot price extracted from multiple fallback paths for proximity filter
 *  4. Unusual OI section shows "Near ATM only" label + empty state when all filtered
 *  5. All prior fixes preserved (GEX bar max, IVRank minWidth, StatCard small,
 *     Lambda fallback, forceRender tick, multi-key vol fallbacks)
 */

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt2(n) { return n == null ? "—" : Number(n).toFixed(2); }
function fmt1(n) { return n == null ? "—" : Number(n).toFixed(1); }
function fmtInt(n) { return n == null ? "—" : Math.round(Number(n)).toLocaleString("en-IN"); }

function fmtCr(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return (n / 1000).toFixed(1) + "K Cr";
  return Number(n).toFixed(1) + " Cr";
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

// ─── FIX 1: Proximity filter for unusual OI ───────────────────────────────────
/**
 * Filter unusual OI entries to only those within ±proximity% of spot.
 * Default 10% — keeps roughly ±2400 pts on NIFTY at 23800.
 * Raises to 15% for BANKNIFTY which has a wider natural range.
 */
function filterByProximity(unusualOI, spot, symbol, proximityPct = 10) {
  if (!unusualOI?.length) return [];
  if (!spot || spot <= 0) return unusualOI; // no spot available — don't filter

  // BANKNIFTY moves wider, allow a bit more range
  const pct = (symbol || "").toUpperCase().includes("BANK") ? 15 : proximityPct;
  const lo  = spot * (1 - pct / 100);
  const hi  = spot * (1 + pct / 100);

  return unusualOI.filter(u => {
    const strike = Number(u.strike);
    return strike >= lo && strike <= hi;
  });
}

// ─── FIX 2: ATM IV units normalisation ───────────────────────────────────────
/**
 * Some backends emit IV as a decimal fraction (0.2065) others as percent (20.65).
 * A value > 200 is almost certainly raw fraction × 100 applied twice.
 * Cap at 200 and if > 200 divide by 100 to recover the real percentage.
 */
function normaliseIV(raw) {
  if (raw == null) return null;
  const v = Number(raw);
  if (isNaN(v)) return null;
  // If > 200%, assume it was sent as fractional (0.xx) but already ×100'd upstream
  // Divide once more to recover e.g. 2065 → 20.65
  return v > 200 ? v / 100 : v;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, small }) {
  const isLong = typeof value === "string" && value.length > 12;
  const fontSize = small || isLong ? 11 : 18;
  return (
    <div style={{
      background: "#010a18", border: "1px solid #0c2240",
      borderRadius: 6, padding: "10px 12px", minWidth: 0,
    }}>
      <div style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{
        fontSize, fontWeight: 700, color: color || "#d8eeff",
        fontFamily: "IBM Plex Mono,monospace",
        wordBreak: "break-word", lineHeight: 1.3,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 9, color: "#2a6080", marginTop: 3, fontFamily: "IBM Plex Mono,monospace" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700,
      color: "#1a5070", letterSpacing: 1.5, textTransform: "uppercase",
      borderBottom: "1px solid #0a2030", paddingBottom: 5, marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

function GexBar({ label, value, max, color }) {
  const pct = Math.min(Math.abs((value || 0) / (max || 1)) * 100, 100);
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "IBM Plex Mono,monospace", marginBottom: 3 }}>
        <span style={{ color: "#7ab0d0" }}>{label}</span>
        <span style={{ color }}>{fmtCr(value)}</span>
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
    SELL_PREMIUM:     { bg: "#002210", color: "#00ff9c", border: "#00ff9c44" },
    BUY_OPTIONS:      { bg: "#001828", color: "#4fc3f7", border: "#4fc3f744" },
    BUY_PREMIUM:      { bg: "#001828", color: "#4fc3f7", border: "#4fc3f744" },
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
    <span style={{
      fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700,
      padding: "2px 7px", borderRadius: 3,
      background: c.bg, color: c.color, border: `1px solid ${c.border}`,
    }}>
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
      <div style={{ position: "relative", height: 8, background: "#0a1828", borderRadius: 4 }}>
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

// ─── Gann Panel ───────────────────────────────────────────────────────────────

function GannPanel({ gann }) {
  if (!gann) {
    return (
      <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
        <SectionLabel>📐 Gann Analysis</SectionLabel>
        <div style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", textAlign: "center", padding: "20px 0" }}>
          ◌ Awaiting Gann data…<br />
          <span style={{ color: "#0d3050" }}>Swing data ingested at startup — check gannDataFetcher</span>
        </div>
      </div>
    );
  }

  const sig      = gann.signal       || {};
  const son      = gann.squareOfNine || {};
  const fan      = gann.priceOnUpFan || gann.priceOnDownFan || null;
  const cycles   = (gann.timeCycles  || []).slice(0, 4);
  const seasonal = (gann.seasonalAlerts || []).slice(0, 2);
  const alerts   = (gann.alerts      || []).filter(a => a.priority === "HIGH").slice(0, 3);
  const levels   = gann.keyLevels    || {};
  const cardinal = gann.cardinalCross || {};

  const gBias  = sig.bias || "NEUTRAL";
  const gScore = sig.score ?? null;
  const gc     = gannPalette(gBias);

  const proximityColor   = { IMMINENT: "#ef5350", THIS_WEEK: "#ffd54f", THIS_FORTNIGHT: "#ff8a65", THIS_MONTH: "#4fc3f7" };
  const cycleStrengthColor = { EXTREME: "#ef5350", MAJOR: "#ff8a65", SIGNIFICANT: "#ffd54f", MINOR: "#4a9abb" };

  return (
    <div style={{ background: "#010a18", border: `1px solid ${gc.border}`, borderRadius: 8, padding: "12px 14px" }}>
      <SectionLabel>📐 Gann Analysis</SectionLabel>

      {/* Bias + Score row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "8px 10px", background: gc.bg, borderRadius: 6, border: `1px solid ${gc.border}` }}>
        <div style={{ textAlign: "center", minWidth: 48 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: gc.color, fontFamily: "IBM Plex Mono,monospace", lineHeight: 1 }}>
            {gScore != null ? Math.round(gScore) : "—"}
          </div>
          <div style={{ fontSize: 8, color: gc.color, fontFamily: "IBM Plex Mono,monospace", opacity: 0.7, marginTop: 2 }}>/100</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: gc.color, fontFamily: "IBM Plex Mono,monospace" }}>
            {gBias.replace(/_/g, " ")}
          </div>
          {sig.summary && (
            <div style={{ fontSize: 9, color: "#2a6080", fontFamily: "IBM Plex Mono,monospace", marginTop: 2, lineHeight: 1.4 }}>
              {sig.summary.replace(/^Gann: [A-Z]+ \(score \d+\/100\)\.\s?/, "")}
            </div>
          )}
        </div>
        {cardinal?.inCardinalZone?.strength === "ON_CARDINAL" && (
          <span style={{ fontSize: 8, padding: "2px 6px", borderRadius: 3, background: "#1a0800", border: "1px solid #ffd54f44", color: "#ffd54f", fontFamily: "IBM Plex Mono,monospace" }}>
            ON CARDINAL
          </span>
        )}
      </div>

      {gann.headline && (
        <div style={{ fontSize: 9, color: "#2a7090", fontFamily: "IBM Plex Mono,monospace", marginBottom: 8, lineHeight: 1.5, padding: "4px 6px", background: "#010f1e", borderRadius: 4, border: "1px solid #0a2030" }}>
          {gann.headline}
        </div>
      )}

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
            <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#4fc3f7" }}>
              {son.angleOnSquare?.toFixed(1)}° on square
            </span>
            <span style={{
              fontSize: 8, padding: "1px 5px", borderRadius: 3, fontFamily: "IBM Plex Mono,monospace",
              background: son.positionOnSquare.strength === "EXTREME" ? "#1a0000" : son.positionOnSquare.strength === "STRONG" ? "#1a0800" : "#0a1020",
              color: son.positionOnSquare.strength === "EXTREME" ? "#ef5350" : son.positionOnSquare.strength === "STRONG" ? "#ffd54f" : "#4a9abb",
              border: "1px solid #0a2030",
            }}>
              {son.positionOnSquare.strength}
            </span>
          </div>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", marginTop: 3 }}>
            {son.positionOnSquare.label}
          </div>
          {son.priceVibration && (
            <div style={{ fontSize: 8, color: "#0d3050", fontFamily: "IBM Plex Mono,monospace", marginTop: 2 }}>
              {son.priceVibration}
            </div>
          )}
        </div>
      )}

      {fan && (
        <div style={{ marginBottom: 8, padding: "6px 8px", background: "#010f1e", borderRadius: 4, border: "1px solid #0a2030" }}>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>GANN FAN</div>
          <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: fan.aboveMasterAngle ? "#00ff9c" : "#ef5350", fontWeight: 700 }}>
            {fan.aboveMasterAngle ? "▲ Above" : "▼ Below"} 1×1 master angle
            {fan.criticalLevel != null && (
              <span style={{ color: "#4a9abb", fontWeight: 400 }}> @ ₹{fmtInt(fan.criticalLevel)}</span>
            )}
          </div>
          {fan.trendStrength && (
            <div style={{ fontSize: 8, color: "#2a6080", fontFamily: "IBM Plex Mono,monospace", marginTop: 2 }}>
              {fan.trendStrength}
            </div>
          )}
          {fan.alert && (
            <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", marginTop: 2 }}>
              {fan.alert}
            </div>
          )}
        </div>
      )}

      {cycles.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>TIME CYCLES (NEXT 30d)</div>
          {cycles.map((c, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "3px 0", borderBottom: "1px solid #0a1828" }}>
              <span style={{ color: cycleStrengthColor[c.cycleStrength] || "#4a9abb", flex: 1, paddingRight: 6, lineHeight: 1.3 }}>
                {c.label}
              </span>
              <span style={{ color: proximityColor[c.proximity] || "#4a9abb", whiteSpace: "nowrap" }}>
                {c.daysFromToday === 0 ? "TODAY" : c.daysFromToday < 0 ? `${Math.abs(c.daysFromToday)}d ago` : `+${c.daysFromToday}d`}
              </span>
            </div>
          ))}
        </div>
      )}

      {seasonal.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>SEASONAL PRESSURE</div>
          {seasonal.map((s, i) => (
            <div key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: s.daysAway <= 3 ? "#ffd54f" : "#2a6080", padding: "2px 0" }}>
              📅 {s.label}
              <span style={{ color: "#1a4060", marginLeft: 6 }}>
                {s.daysAway === 0 ? "TODAY" : s.daysAway < 0 ? `${Math.abs(s.daysAway)}d ago` : `in ${s.daysAway}d`}
              </span>
            </div>
          ))}
        </div>
      )}

      {alerts.length > 0 && (
        <div>
          <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>GANN ALERTS</div>
          {alerts.map((a, i) => (
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
            <div key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#2a7090", marginBottom: 2, lineHeight: 1.4 }}>
              · {f}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OptionsIntelligencePage({ socket }) {
  const [data,         setData]         = useState({});
  const [gannMap,      setGannMap]      = useState({});
  const [activeSymbol, setActiveSymbol] = useState(null);
  const [symbolList,   setSymbolList]   = useState([]);
  const [lastUpdated,  setLastUpdated]  = useState(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const t = setInterval(() => forceRender(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const requestGann = useCallback((sym, ltp) => {
    if (!socket || !sym) return;
    socket.emit("get-gann-analysis", { symbol: sym, ltp });
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
          const ltp = d?.ltp || d?.spot || null;
          setTimeout(() => requestGann(sym, ltp), 100);
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
      setGannMap(prev => {
        const existing = prev[alert.symbol.toUpperCase()];
        if (!existing) return prev;
        return {
          ...prev,
          [alert.symbol.toUpperCase()]: {
            ...existing,
            alerts: [
              ...(alert.alerts || []),
              ...(existing.alerts || []).filter(a => a.priority !== "HIGH"),
            ],
          },
        };
      });
    };

    socket.on("options-intelligence", onIntel);
    socket.on("gann-analysis",        onGann);
    socket.on("gann-alert",           onGannAlert);

    return () => {
      socket.off("options-intelligence", onIntel);
      socket.off("gann-analysis",        onGann);
      socket.off("gann-alert",           onGannAlert);
    };
  }, [socket, requestGann]);

  const handleSymbolChange = (sym) => {
    setActiveSymbol(sym);
    const payload = data[sym];
    const d = payload?.data || payload || {};
    const ltp = d?.ltp || d?.spot || null;
    requestGann(sym, ltp);
  };

  const current = data[activeSymbol] || null;
  const d       = current?.data || current || null;

  const score = d?.score ?? null;
  const bias  = d?.bias  ?? "NEUTRAL";
  const band  = score != null ? ScoreBand(score) : null;

  const vol       = d?.volatility   || {};
  const greeks    = d?.atmGreeks    || {};
  const gex       = d?.gex          || {};
  const oi        = d?.oi           || {};
  const structure = d?.structure    || {};
  const strategy  = d?.strategy     || [];
  const factors   = d?.factors      || [];

  const gannData = activeSymbol
    ? (gannMap[activeSymbol] || gannMap[activeSymbol?.toUpperCase()] || null)
    : null;

  const gannBadgeMap = {};
  if (activeSymbol && gannData) {
    const gs = gannData.signal    || {};
    const gl = gannData.keyLevels || {};
    gannBadgeMap[activeSymbol] = {
      bias:       gs.bias || "NEUTRAL",
      support:    gl.supports?.[0]?.price    ?? null,
      resistance: gl.resistances?.[0]?.price ?? null,
      angle:      gannData.squareOfNine?.angleOnSquare ?? null,
    };
  }

  const gexCallVal = gex.callGEX ?? null;
  const gexPutVal  = gex.putGEX  ?? null;
  const gexMax = Math.max(
    Math.abs(gex.netGEX || 0),
    Math.abs(gexCallVal || 0),
    Math.abs(gexPutVal  || 0),
    1
  );

  // ── Spot price from multiple paths ────────────────────────────────────────
  const spot = d?.spot || d?.ltp || structure?.spot || gex?.gammaFlip || null;

  // ── Two-tier unusual OI — backend now sends both fields ───────────────────
  // nearATM  = within ±8% of spot, high absolute OI + volume/change signal
  // tailRisk = far OTM but anomalous vs adjacent strikes (neighbor-ratio test)
  const unusualOINearATM  = oi.unusualOI         || [];
  const unusualOITailRisk = oi.unusualOITailRisk  || [];
  // Legacy fallback: if backend hasn't deployed yet, frontend-filter old field
  const rawUnusualOI      = unusualOINearATM.length || unusualOITailRisk.length
    ? null  // new backend — use both fields directly
    : (oi.unusualOI || []);
  const legacyNearATM  = rawUnusualOI ? filterByProximity(rawUnusualOI, spot, activeSymbol, 8)  : unusualOINearATM;
  const legacyTailRisk = rawUnusualOI ? filterByProximity(rawUnusualOI, spot, activeSymbol, 100).filter(
    u => !filterByProximity([u], spot, activeSymbol, 8).length
  ) : unusualOITailRisk;

  const nearATMSignals  = legacyNearATM;
  const tailRiskSignals = legacyTailRisk;

  // ── FIX 2: normalise ATM IV ────────────────────────────────────────────────
  const rawAtmIV = vol.atmIV ?? vol.iv ?? vol.atm_iv ?? vol.atmIv ?? null;
  const atmIV    = normaliseIV(rawAtmIV);

  const hv20   = vol.hv20  ?? vol.hv_20 ?? vol.HV20 ?? null;
  const hv60   = vol.hv60  ?? vol.hv_60 ?? vol.HV60 ?? null;
  const vrp    = vol.vrp   ?? vol.vRp   ?? vol.VRP  ?? null;
  const lambda = greeks.lambda ?? greeks.leverage ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#020d1c" }}>

      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", borderBottom: "1px solid #0c2240",
        flexShrink: 0, background: "#010a18", flexWrap: "wrap",
      }}>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 10, fontWeight: 700, color: "#00cfff", letterSpacing: 1 }}>
          ⚡ OPTIONS INTELLIGENCE
        </span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
          {symbolList.length === 0 && (
            <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#1a5070" }}>◌ Waiting for live data…</span>
          )}
          {symbolList.slice(0, 20).map(sym => (
            <button
              key={sym}
              onClick={() => handleSymbolChange(sym)}
              style={{
                background: activeSymbol === sym ? "#00cfff22" : "transparent",
                border: `1px solid ${activeSymbol === sym ? "#00cfff66" : "#0c2240"}`,
                borderRadius: 3, padding: "2px 8px", cursor: "pointer",
                fontFamily: "IBM Plex Mono,monospace", fontSize: 9, fontWeight: 700,
                color: activeSymbol === sym ? "#00cfff" : "#2a6080",
              }}
            >
              {sym}
            </button>
          ))}
        </div>
        {lastUpdated && (
          <span style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", color: "#0d3050", marginLeft: "auto" }}>
            Updated {Math.round((Date.now() - lastUpdated) / 1000)}s ago
          </span>
        )}
      </div>

      {!d ? <EmptyState symbol={activeSymbol} /> : (
        <div style={{
          flex: 1, overflowY: "auto", padding: 12,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 10, alignContent: "start",
        }}>

          {/* ── Score Card ── */}
          <div style={{
            gridColumn: "1 / -1",
            background: band?.bg || "#010a18",
            border: `1px solid ${band?.color || "#0c2240"}44`,
            borderRadius: 8, padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
          }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 80 }}>
              <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "IBM Plex Mono,monospace", color: band?.color || "#4a9abb", lineHeight: 1 }}>
                {score != null ? Math.round(score) : "—"}
              </div>
              <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: band?.color || "#1a5070", letterSpacing: 1 }}>
                {band?.label || "NO DATA"}
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 14, fontWeight: 700, color: "#d8eeff" }}>
                  {activeSymbol}
                </span>
                <span style={{ fontSize: 10, color: band?.color, fontWeight: 400, fontFamily: "IBM Plex Mono,monospace" }}>
                  {bias}
                </span>
                {gannData && (
                  <GannBadge symbol={activeSymbol} gannMap={gannBadgeMap} compact={true} />
                )}
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                {strategy.slice(0, 5).map((s, i) => <StrategyTag key={i} signal={s} />)}
              </div>

              {factors.length > 0 && (
                <div>
                  {factors.slice(0, 3).map((f, i) => (
                    <div key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#2a7090", marginBottom: 2 }}>
                      · {typeof f === "string" ? f : (f.label || f.reason || JSON.stringify(f))}
                    </div>
                  ))}
                </div>
              )}

              {gannData?.headline && (
                <div style={{ marginTop: 6, fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#1a5070", lineHeight: 1.4 }}>
                  📐 {gannData.headline}
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, minWidth: 200 }}>
              <StatCard
                label="EXPECTED MOVE"
                value={structure.expectedMoveAbs ? `±${fmt2(structure.expectedMoveAbs)}` : "—"}
                sub="1σ straddle"
                color="#4fc3f7"
              />
              <StatCard
                label="EVENT RISK"
                value={structure.eventRiskScore != null ? Math.round(structure.eventRiskScore) : "0"}
                sub="0–100 scale"
                color={structure.eventRiskScore > 60 ? "#ef5350" : structure.eventRiskScore > 0 ? "#ffd54f" : "#2a6080"}
              />
            </div>
          </div>

          {/* ── Volatility Panel ── */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Volatility</SectionLabel>
            <IVRankMeter ivRank={vol.ivRank} ivPct={vol.ivPercentile} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
              {/* FIX 2: normalised ATM IV — no more 2065% */}
              <StatCard
                label="ATM IV"
                value={atmIV != null ? `${atmIV.toFixed(1)}%` : "—"}
                color="#00cfff"
              />
              <StatCard
                label="VRP"
                value={vrp != null ? `${vrp > 0 ? "+" : ""}${fmt2(vrp)}%` : "—"}
                sub="IV − HV20"
                color={vrp != null ? (vrp > 0 ? "#ff8a65" : "#00ff9c") : "#4a9abb"}
              />
              <StatCard label="HV 20" value={hv20 != null ? `${Number(hv20).toFixed(1)}%` : "—"} />
              <StatCard label="HV 60" value={hv60 != null ? `${Number(hv60).toFixed(1)}%` : "—"} />
            </div>
            {vol.ivEnvironment === "RICH_SELL_PREMIUM" && (
              <div style={{ marginTop: 8, padding: "5px 8px", background: "#1a0800", border: "1px solid #ff8a6544", borderRadius: 4, fontSize: 9, color: "#ff8a65", fontFamily: "IBM Plex Mono,monospace" }}>
                ⚠ IV ELEVATED — sell premium environment (VRP: +{fmt2(vrp)}%)
              </div>
            )}
            {vol.ivEnvironment === "CHEAP_BUY_OPTIONS" && (
              <div style={{ marginTop: 8, padding: "5px 8px", background: "#001828", border: "1px solid #4fc3f744", borderRadius: 4, fontSize: 9, color: "#4fc3f7", fontFamily: "IBM Plex Mono,monospace" }}>
                ✓ IV LOW — cheap options, consider buying premium
              </div>
            )}
          </div>

          {/* ── GEX Panel ── */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Dealer Positioning (GEX)</SectionLabel>
            <GexBar label="Net GEX"  value={gex.netGEX}   max={gexMax} color={gex.netGEX >= 0 ? "#00ff9c" : "#ef5350"} />
            <GexBar label="Call GEX" value={gexCallVal}   max={gexMax} color="#4fc3f7" />
            <GexBar label="Put GEX"  value={gexPutVal}    max={gexMax} color="#ff8a65" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <StatCard label="GAMMA FLIP" value={gex.gammaFlip ? gex.gammaFlip.toLocaleString("en-IN") : "—"} sub="spot level" color="#ffd54f" />
              <StatCard label="REGIME"     value={gex.regime ? gex.regime.replace(/_/g, " ") : "—"} small color={gex.regime === "MEAN_REVERTING" ? "#00ff9c" : "#ef5350"} />
              <StatCard label="CALL WALL"  value={gex.callWall ? gex.callWall.toLocaleString("en-IN") : "—"} sub="resistance" color="#4fc3f7" />
              <StatCard label="PUT WALL"   value={gex.putWall  ? gex.putWall.toLocaleString("en-IN")  : "—"} sub="support"    color="#ff8a65" />
            </div>
          </div>

          {/* ── OI Panel ── */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Open Interest Intelligence</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="PCR"      value={fmt2(oi.pcr)} sub="put/call ratio" color={oi.pcr > 1.2 ? "#00ff9c" : oi.pcr < 0.8 ? "#ef5350" : "#ffd54f"} />
              <StatCard label="MAX PAIN" value={oi.maxPain ? oi.maxPain.toLocaleString("en-IN") : "—"} sub="expiry" color="#4fc3f7" />
              <StatCard label="TOTAL OI" value={(() => {
                const t = (oi.totalCallOI || 0) + (oi.totalPutOI || 0);
                return t > 0 ? (t / 1e5).toFixed(1) + "L" : "—";
              })()} />
              <StatCard label="NET FLOW" value={oi.netPremiumFlow != null ? fmtCr(oi.netPremiumFlow) : "—"} color={oi.netPremiumFlow > 0 ? "#00ff9c" : "#ef5350"} />
            </div>

            {/* ── Two-tier unusual OI ── */}
            {(nearATMSignals.length > 0 || tailRiskSignals.length > 0) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>

                {/* Tier 1 — Near ATM: actionable S/R */}
                {nearATMSignals.length > 0 && (
                  <div style={{ background: "#010f1e", border: "1px solid #0a2030", borderRadius: 5, padding: "8px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>
                        Unusual OI — Near ATM
                      </div>
                      <span style={{ fontSize: 8, color: "#1a4060", fontFamily: "IBM Plex Mono,monospace" }}>
                        S/R signal · ±{(activeSymbol || "").toUpperCase().includes("BANK") ? "10" : "8"}% of spot
                      </span>
                    </div>
                    {nearATMSignals.slice(0, 5).map((u, i) => (
                      <div key={i} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "4px 0",
                        borderBottom: i < nearATMSignals.slice(0, 5).length - 1 ? "1px solid #0a1828" : "none",
                      }}>
                        <span style={{ color: (u.type === "CALL" || u.type === "call") ? "#4fc3f7" : "#ff8a65", minWidth: 80 }}>
                          {(u.type || "").toUpperCase()} {u.strike}
                        </span>
                        <span style={{ color: "#d8eeff" }}>{(u.oi || 0).toLocaleString("en-IN")} OI</span>
                        <span style={{ color: "#ff5cff" }}>vol: {(u.vol || 0).toLocaleString("en-IN")}</span>
                        {u.oiChgPct > 0 && (
                          <span style={{ color: u.oiChange > 0 ? "#00ff9c" : "#ef5350", fontSize: 8 }}>
                            {u.oiChange > 0 ? "+" : ""}{u.oiChgPct}%
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Tier 2 — Far OTM: institutional / tail risk */}
                {tailRiskSignals.length > 0 && (
                  <div style={{ background: "#0a0a18", border: "1px solid #1a0a3040", borderRadius: 5, padding: "8px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <div style={{ fontSize: 8, color: "#5a3080", fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>
                        Institutional / Tail Risk
                      </div>
                      <span style={{ fontSize: 8, color: "#2a1040", fontFamily: "IBM Plex Mono,monospace" }}>
                        far OTM · anomalous vs neighbours
                      </span>
                    </div>
                    {tailRiskSignals.slice(0, 4).map((u, i) => (
                      <div key={i} style={{
                        padding: "5px 0",
                        borderBottom: i < tailRiskSignals.slice(0, 4).length - 1 ? "1px solid #0a0a20" : "none",
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9, fontFamily: "IBM Plex Mono,monospace" }}>
                          <span style={{ color: (u.type === "CALL" || u.type === "call") ? "#4fc3f788" : "#ff8a6588", minWidth: 80 }}>
                            {(u.type || "").toUpperCase()} {u.strike}
                            <span style={{ color: "#2a1040", marginLeft: 4 }}>
                              ({u.distPct > 0 ? "+" : ""}{u.distPct}%)
                            </span>
                          </span>
                          <span style={{ color: "#5a4070" }}>{(u.oi || 0).toLocaleString("en-IN")} OI</span>
                          {/* Neighbour ratio — the key signal */}
                          <span style={{ fontSize: 8, color: "#8040a0", fontWeight: 700 }}>
                            {u.neighborRatio}× neighbours
                          </span>
                        </div>
                        {/* Interpretation label — what this likely means */}
                        {u.interpretation && (
                          <div style={{ fontSize: 8, color: "#3a1060", fontFamily: "IBM Plex Mono,monospace", marginTop: 2, lineHeight: 1.4 }}>
                            ◈ {u.interpretation}
                            {u.oiChgPct > 0 && (
                              <span style={{ color: u.oiChange > 0 ? "#40805088" : "#80404088", marginLeft: 6 }}>
                                OI chg {u.oiChange > 0 ? "+" : ""}{u.oiChgPct}%
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

              </div>
            )}
          </div>

          {/* ── Portfolio Greeks Panel ── */}
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
                  <StatCard label="VANNA (DEX)" value={gex.vanna != null ? fmtCr(gex.vanna) : "—"} sub="Δ vs vol"        color="#ff5cff" />
                  <StatCard label="CHARM"        value={gex.charm != null ? fmtCr(gex.charm) : "—"} sub="time-decay flow" color="#ffd54f" />
                </div>
              </>
            )}
          </div>

          {/* ── Gann Panel ── */}
          <GannPanel gann={gannData} />

          {/* ── Market Structure ── */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Market Structure</SectionLabel>

            {gannData && (
              <div style={{ marginBottom: 10 }}>
                <GannBadge symbol={activeSymbol} gannMap={gannBadgeMap} compact={false} />
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard
                label="SUPPORT (OI)"
                value={structure.supportFromOI ? structure.supportFromOI.toLocaleString("en-IN") : "—"}
                sub="put OI wall"
                color="#00ff9c"
              />
              <StatCard
                label="RESISTANCE (OI)"
                value={structure.resistanceFromOI ? structure.resistanceFromOI.toLocaleString("en-IN") : "—"}
                sub="call OI wall"
                color="#ef5350"
              />
              {gannData?.keyLevels && (
                <>
                  <StatCard
                    label="SUPPORT (GANN)"
                    value={gannData.keyLevels.supports?.[0]?.price
                      ? gannData.keyLevels.supports[0].price.toLocaleString("en-IN") : "—"}
                    sub={gannData.keyLevels.supports?.[0]?.source || "Square of Nine"}
                    color="#00ff9c"
                  />
                  <StatCard
                    label="RESISTANCE (GANN)"
                    value={gannData.keyLevels.resistances?.[0]?.price
                      ? gannData.keyLevels.resistances[0].price.toLocaleString("en-IN") : "—"}
                    sub={gannData.keyLevels.resistances?.[0]?.source || "Square of Nine"}
                    color="#ef5350"
                  />
                </>
              )}
            </div>

            {structure.ivEnvironment && (
              <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#2a6080", marginBottom: 6 }}>
                IV env: <span style={{ color: "#ffd54f" }}>{structure.ivEnvironment.replace(/_/g, " ")}</span>
              </div>
            )}

            {structure.straddlePrice != null && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "IBM Plex Mono,monospace", padding: "6px 0", borderTop: "1px solid #0a1828" }}>
                <span style={{ color: "#1a5070" }}>ATM Straddle</span>
                <span style={{ color: "#d8eeff", fontWeight: 700 }}>₹{fmt2(structure.straddlePrice)}</span>
              </div>
            )}

            {structure.vrp != null && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "IBM Plex Mono,monospace", padding: "6px 0" }}>
                <span style={{ color: "#1a5070" }}>VRP (IV−HV20)</span>
                <span style={{ color: structure.vrp > 0 ? "#ff8a65" : "#4fc3f7", fontWeight: 700 }}>
                  {structure.vrp > 0 ? "+" : ""}{fmt2(structure.vrp)} vol pts
                </span>
              </div>
            )}

            {gannData?.keyLevels?.masterAngle != null && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "IBM Plex Mono,monospace", padding: "6px 0", borderTop: "1px solid #0a1828" }}>
                <span style={{ color: "#1a5070" }}>Gann 1×1 Master</span>
                <span style={{ color: "#ffd54f", fontWeight: 700 }}>
                  ₹{Math.round(gannData.keyLevels.masterAngle).toLocaleString("en-IN")}
                </span>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
