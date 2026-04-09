import { useEffect, useState } from "react";

/**
 * OptionsIntelligencePage.jsx
 *
 * FIXES:
 *  1. Data key mismatch — engine emits { volatility, atmGreeks, gex, oi, structure, strategy }
 *     but page was reading { iv, greeks, gex, oi, structure }. All keys corrected.
 *  2. volatility.atmIV is already a % number (e.g. 19.5) — was being double-formatted
 *  3. greeks was reading d?.greeks but engine puts it under d?.atmGreeks
 *  4. GEX bars: engine emits netGEX/callWall/putWall as ₹Cr numbers — fmtCr updated
 *  5. unusualOI: engine emits { strike, type, oi, vol } but page expected { type, strike, oi, ratio }
 *  6. factors: engine emits string[] directly — was wrapped in { label, reason } objects
 *  7. signals: engine emits [{ strategy, confidence, note }] — was treated as string[]
 */

function fmt2(n) { return n == null ? "—" : Number(n).toFixed(2); }

// Engine emits GEX values in ₹Cr already (e.g. -1989.9)
function fmtCr(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return (n / 1000).toFixed(1) + "K Cr";
  return Number(n).toFixed(1) + " Cr";
}

function fmtPct(n) { return n == null ? "—" : Number(n).toFixed(1) + "%"; }

function ScoreBand(score) {
  if (score >= 80) return { color: "#00ff9c", bg: "#002210", label: "STRONG BUY" };
  if (score >= 65) return { color: "#4fc3f7", bg: "#001a28", label: "BUY" };
  if (score >= 45) return { color: "#ffd54f", bg: "#1a1500", label: "NEUTRAL" };
  if (score >= 30) return { color: "#ff8a65", bg: "#1a0a00", label: "SELL" };
  return { color: "#ef5350", bg: "#1a0000", label: "STRONG SELL" };
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 6, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || "#d8eeff", fontFamily: "IBM Plex Mono,monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "#2a6080", marginTop: 3, fontFamily: "IBM Plex Mono,monospace" }}>{sub}</div>}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: "#1a5070", letterSpacing: 1.5, textTransform: "uppercase", borderBottom: "1px solid #0a2030", paddingBottom: 5, marginBottom: 8 }}>{children}</div>
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
        <div style={{ height: 4, width: `${pct}%`, background: color, borderRadius: 2 }} />
      </div>
    </div>
  );
}

// FIX 7: signals is now [{ strategy, confidence, note, direction }]
function StrategyTag({ signal }) {
  // signal can be a string (old format) or { strategy } object (new format)
  const label = typeof signal === "string" ? signal : (signal?.strategy || "");
  const colors = {
    SELL_PREMIUM:      { bg: "#002210", color: "#00ff9c", border: "#00ff9c44" },
    BUY_OPTIONS:       { bg: "#001828", color: "#4fc3f7", border: "#4fc3f744" },
    BUY_PREMIUM:       { bg: "#001828", color: "#4fc3f7", border: "#4fc3f744" },
    GAMMA_SQUEEZE:     { bg: "#1a1000", color: "#ffd54f", border: "#ffd54f44" },
    GAMMA_WALL:        { bg: "#1a1000", color: "#ffd54f", border: "#ffd54f44" },
    SKEW_TRADE:        { bg: "#1a0a00", color: "#ff8a65", border: "#ff8a6544" },
    UNUSUAL_ACTIVITY:  { bg: "#1a0018", color: "#ff5cff", border: "#ff5cff44" },
    UNUSUAL_OI:        { bg: "#1a0018", color: "#ff5cff", border: "#ff5cff44" },
    DEFENSIVE:         { bg: "#1a0000", color: "#ef5350", border: "#ef535044" },
    IV_CRUSH:          { bg: "#1a0000", color: "#ef5350", border: "#ef535044" },
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
  const clr = rank > 70 ? "#ef5350" : rank > 40 ? "#ffd54f" : "#00ff9c";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", marginBottom: 4 }}>
        <span style={{ color: "#1a5070" }}>IV RANK</span>
        <span style={{ color: clr, fontWeight: 700 }}>{fmt2(rank)}</span>
      </div>
      <div style={{ position: "relative", height: 8, background: "#0a1828", borderRadius: 4 }}>
        <div style={{ height: 8, width: `${rank}%`, background: clr, borderRadius: 4 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, fontFamily: "IBM Plex Mono,monospace", marginTop: 3 }}>
        <span style={{ color: "#1a4060" }}>LOW</span>
        <span style={{ color: "#1a5070" }}>IV%ile: {fmt2(ivPct)}</span>
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
        NIFTY, BANKNIFTY, and F&O stocks update every cycle.
      </div>
    </div>
  );
}

export default function OptionsIntelligencePage({ socket }) {
  const [data,         setData]         = useState({});
  const [activeSymbol, setActiveSymbol] = useState(null);
  const [symbolList,   setSymbolList]   = useState([]);
  const [lastUpdated,  setLastUpdated]  = useState(null);

  useEffect(() => {
    if (!socket) return;
    const onIntel = (payload) => {
      if (!payload) return;
      const sym = payload.symbol || "UNKNOWN";
      setSymbolList(prev => prev.includes(sym) ? prev : [sym, ...prev].slice(0, 40));
      setActiveSymbol(prev => prev || sym);
      setData(prev => ({ ...prev, [sym]: payload }));
      setLastUpdated(Date.now());
    };
    socket.on("options-intelligence", onIntel);
    return () => socket.off("options-intelligence", onIntel);
  }, [socket]);

  const current = data[activeSymbol] || null;
  // FIX 1: engine emits the full result directly — no nested .data wrapper needed
  // but support both shapes just in case coordinator wraps it
  const d = current?.data || current || null;

  const score  = d?.score ?? null;
  const bias   = d?.bias  ?? "NEUTRAL";
  const band   = score != null ? ScoreBand(score) : null;

  // FIX 1: correct key names from optionsIntelligenceEngine output
  const vol      = d?.volatility  || {};   // was d?.iv
  const greeks   = d?.atmGreeks   || {};   // was d?.greeks
  const gex      = d?.gex         || {};
  const oi       = d?.oi          || {};
  const structure = d?.structure  || {};
  const strategy = d?.strategy    || [];   // [{ strategy, confidence, note, direction }]
  // FIX 6: factors is string[] directly from engine, not [{ label, reason }]
  const factors  = d?.factors || [];

  // GEX bar max
  const maxGex = Math.max(
    Math.abs(gex.netGEX  || 0),
    Math.abs(gex.callWall ? gex.callWall : 0),   // FIX 4: callWall is a strike number, not ₹Cr
    Math.abs(gex.putWall  ? gex.putWall  : 0),
    Math.abs(gex.callGEX  || 0),
    Math.abs(gex.putGEX   || 0),
    1
  );

  // FIX 4: GEX panel uses callGEX/putGEX (₹Cr values), not callWall/putWall (strike numbers)
  const gexCallVal = gex.callGEX ?? null;
  const gexPutVal  = gex.putGEX  ?? null;

  // FIX 5: unusualOI shape from engine: { strike, type: 'call'|'put', oi, vol, note }
  const unusualOI = oi.unusualOI || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#020d1c" }}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #0c2240", flexShrink: 0, background: "#010a18", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 10, fontWeight: 700, color: "#00cfff", letterSpacing: 1 }}>⚡ OPTIONS INTELLIGENCE</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
          {symbolList.length === 0 && <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#1a5070" }}>◌ Waiting for live data…</span>}
          {symbolList.slice(0, 20).map(sym => (
            <button key={sym} onClick={() => setActiveSymbol(sym)} style={{
              background: activeSymbol === sym ? "#00cfff22" : "transparent",
              border: `1px solid ${activeSymbol === sym ? "#00cfff66" : "#0c2240"}`,
              borderRadius: 3, padding: "2px 8px", cursor: "pointer",
              fontFamily: "IBM Plex Mono,monospace", fontSize: 9, fontWeight: 700,
              color: activeSymbol === sym ? "#00cfff" : "#2a6080"
            }}>
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
        <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 10, alignContent: "start" }}>

          {/* Score Card — full width */}
          <div style={{ gridColumn: "1 / -1", background: band?.bg || "#010a18", border: `1px solid ${band?.color || "#0c2240"}44`, borderRadius: 8, padding: "14px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 80 }}>
              <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "IBM Plex Mono,monospace", color: band?.color || "#4a9abb", lineHeight: 1 }}>
                {score != null ? Math.round(score) : "—"}
              </div>
              <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: band?.color || "#1a5070", letterSpacing: 1 }}>
                {band?.label || "NO DATA"}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 14, fontWeight: 700, color: "#d8eeff", marginBottom: 6 }}>
                {activeSymbol}
                <span style={{ fontSize: 10, color: band?.color, marginLeft: 10, fontWeight: 400 }}>{bias}</span>
              </div>
              {/* FIX 7: strategy is [{ strategy, note }] objects */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {strategy.slice(0, 5).map((s, i) => <StrategyTag key={i} signal={s} />)}
              </div>
              {/* FIX 6: factors is string[] */}
              {factors.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {factors.slice(0, 3).map((f, i) => (
                    <div key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#2a7090", marginBottom: 2 }}>
                      · {typeof f === "string" ? f : (f.label || f.reason || JSON.stringify(f))}
                    </div>
                  ))}
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
                value={structure.eventRiskScore != null ? Math.round(structure.eventRiskScore) : "—"}
                sub="0–100 scale"
                color={structure.eventRiskScore > 60 ? "#ef5350" : "#ffd54f"}
              />
            </div>
          </div>

          {/* ── IV / Volatility Panel ── */}
          {/* FIX 1+2: all keys corrected to match engine output */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Volatility</SectionLabel>
            <IVRankMeter ivRank={vol.ivRank} ivPct={vol.ivPercentile} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
              {/* FIX 2: vol.atmIV is already a % (e.g. 19.5) — just append % */}
              <StatCard label="ATM IV"  value={vol.atmIV  != null ? `${Number(vol.atmIV).toFixed(1)}%`  : "—"} color="#00cfff" />
              <StatCard label="VRP"     value={vol.vrp    != null ? `${vol.vrp > 0 ? "+" : ""}${fmt2(vol.vrp)}%` : "—"} sub="IV − HV20" color={vol.vrp > 0 ? "#ff8a65" : "#00ff9c"} />
              {/* FIX 1: hv20/hv60 are already % values from engine */}
              <StatCard label="HV 20"   value={vol.hv20   != null ? `${Number(vol.hv20).toFixed(1)}%`   : "—"} />
              <StatCard label="HV 60"   value={vol.hv60   != null ? `${Number(vol.hv60).toFixed(1)}%`   : "—"} />
            </div>
            {vol.ivEnvironment === "RICH_SELL_PREMIUM" && (
              <div style={{ marginTop: 8, padding: "5px 8px", background: "#1a0800", border: "1px solid #ff8a6544", borderRadius: 4, fontSize: 9, color: "#ff8a65", fontFamily: "IBM Plex Mono,monospace" }}>
                ⚠ IV ELEVATED — sell premium environment (VRP: +{fmt2(vol.vrp)}%)
              </div>
            )}
            {vol.ivEnvironment === "CHEAP_BUY_OPTIONS" && (
              <div style={{ marginTop: 8, padding: "5px 8px", background: "#001828", border: "1px solid #4fc3f744", borderRadius: 4, fontSize: 9, color: "#4fc3f7", fontFamily: "IBM Plex Mono,monospace" }}>
                ✓ IV LOW — cheap options, consider buying premium
              </div>
            )}
          </div>

          {/* ── GEX Panel ── */}
          {/* FIX 4: use callGEX/putGEX for bars, callWall/putWall for strike labels */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Dealer Positioning (GEX)</SectionLabel>
            <GexBar label="Net GEX"   value={gex.netGEX}  max={Math.abs(gex.netGEX || 1)}  color={gex.netGEX >= 0 ? "#00ff9c" : "#ef5350"} />
            <GexBar label="Call GEX"  value={gexCallVal}  max={Math.max(Math.abs(gexCallVal || 0), Math.abs(gexPutVal || 0), 1)} color="#4fc3f7" />
            <GexBar label="Put GEX"   value={gexPutVal}   max={Math.max(Math.abs(gexCallVal || 0), Math.abs(gexPutVal || 0), 1)} color="#ff8a65" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <StatCard label="GAMMA FLIP"  value={gex.gammaFlip ? gex.gammaFlip.toLocaleString("en-IN") : "—"} sub="spot level"  color="#ffd54f" />
              <StatCard label="REGIME"      value={gex.regime || "—"}                                            color={gex.regime === "MEAN_REVERTING" ? "#00ff9c" : "#ef5350"} />
              {/* Show call wall and put wall as strike prices */}
              <StatCard label="CALL WALL"   value={gex.callWall ? gex.callWall.toLocaleString("en-IN") : "—"}   sub="resistance"  color="#4fc3f7" />
              <StatCard label="PUT WALL"    value={gex.putWall  ? gex.putWall.toLocaleString("en-IN")  : "—"}   sub="support"     color="#ff8a65" />
            </div>
          </div>

          {/* ── OI Panel ── */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Open Interest Intelligence</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="PCR"       value={fmt2(oi.pcr)}         sub="put/call ratio"  color={oi.pcr > 1.2 ? "#00ff9c" : oi.pcr < 0.8 ? "#ef5350" : "#ffd54f"} />
              <StatCard label="MAX PAIN"  value={oi.maxPain ? oi.maxPain.toLocaleString("en-IN") : "—"} sub="expiry" color="#4fc3f7" />
              {/* FIX: totalOI from engine is totalCallOI + totalPutOI */}
              <StatCard label="TOTAL OI"  value={(() => {
                const t = (oi.totalCallOI || 0) + (oi.totalPutOI || 0);
                return t > 0 ? (t / 1e5).toFixed(1) + "L" : "—";
              })()} />
              <StatCard label="NET FLOW"  value={oi.netPremiumFlow != null ? fmtCr(oi.netPremiumFlow) : "—"} color={oi.netPremiumFlow > 0 ? "#00ff9c" : "#ef5350"} />
            </div>
            {/* FIX 5: unusualOI shape: { strike, type: 'call'|'put', oi, vol, note } */}
            {unusualOI.length > 0 && (
              <>
                <SectionLabel>Unusual OI Signals</SectionLabel>
                {unusualOI.slice(0, 4).map((u, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "4px 0", borderBottom: "1px solid #0a1828" }}>
                    <span style={{ color: (u.type === "call" || u.type === "CALL") ? "#4fc3f7" : "#ff8a65" }}>
                      {(u.type || "").toUpperCase()} {u.strike}
                    </span>
                    <span style={{ color: "#d8eeff" }}>{(u.oi || 0).toLocaleString("en-IN")} OI</span>
                    {/* engine doesn't emit ratio — show vol instead */}
                    <span style={{ color: "#ff5cff" }}>vol: {(u.vol || 0).toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* ── Portfolio Greeks Panel ── */}
          {/* FIX 3: was d?.greeks, now correctly d?.atmGreeks */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Portfolio Greeks (ATM)</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="DELTA"  value={fmt2(greeks.delta)}  color={greeks.delta > 0 ? "#00ff9c" : "#ef5350"} />
              <StatCard label="GAMMA"  value={greeks.gamma  != null ? greeks.gamma.toFixed(4) : "—"} />
              <StatCard label="THETA"  value={greeks.theta  != null ? fmt2(greeks.theta) : "—"} sub="₹/day"    color="#ff8a65" />
              <StatCard label="VEGA"   value={fmt2(greeks.vega)}   sub="per 1% IV"  color="#4fc3f7" />
              <StatCard label="LAMBDA" value={fmt2(greeks.lambda)} sub="leverage" />
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

          {/* ── Market Structure ── */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Market Structure</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              {/* FIX: engine uses supportFromOI / resistanceFromOI */}
              <StatCard label="SUPPORT"    value={structure.supportFromOI    ? structure.supportFromOI.toLocaleString("en-IN")    : "—"} sub="put OI wall"  color="#00ff9c" />
              <StatCard label="RESISTANCE" value={structure.resistanceFromOI ? structure.resistanceFromOI.toLocaleString("en-IN") : "—"} sub="call OI wall" color="#ef5350" />
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
          </div>

        </div>
      )}
    </div>
  );
}
