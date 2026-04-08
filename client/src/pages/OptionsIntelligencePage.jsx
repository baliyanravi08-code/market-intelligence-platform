import { useEffect, useState } from "react";

function fmt2(n) { return n == null ? "—" : Number(n).toFixed(2); }
function fmtCr(n) { return n == null ? "—" : (Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + "K" : Number(n).toFixed(0)) + " Cr"; }
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
  const pct = Math.min(Math.abs((value || 0) / max) * 100, 100);
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

function StrategyTag({ signal }) {
  const colors = {
    SELL_PREMIUM:  { bg: "#002210", color: "#00ff9c", border: "#00ff9c44" },
    BUY_PREMIUM:   { bg: "#001828", color: "#4fc3f7", border: "#4fc3f744" },
    GAMMA_SQUEEZE: { bg: "#1a1000", color: "#ffd54f", border: "#ffd54f44" },
    SKEW_TRADE:    { bg: "#1a0a00", color: "#ff8a65", border: "#ff8a6544" },
    UNUSUAL_OI:    { bg: "#1a0018", color: "#ff5cff", border: "#ff5cff44" },
    IV_CRUSH:      { bg: "#1a0000", color: "#ef5350", border: "#ef535044" },
  };
  const c = colors[signal] || { bg: "#0a1828", color: "#4a9abb", border: "#4a9abb44" };
  return (
    <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      {signal.replace(/_/g, " ")}
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
  const d = current?.data || current || null;

  const score  = d?.score ?? null;
  const bias   = d?.bias ?? "NEUTRAL";
  const band   = score != null ? ScoreBand(score) : null;
  const iv       = d?.iv       || {};
  const greeks   = d?.greeks   || {};
  const gex      = d?.gex      || {};
  const oi       = d?.oi       || {};
  const structure = d?.structure || {};
  const signals  = d?.signals  || [];
  const factors  = d?.factors  || d?.top3Reasons || [];
  const maxGex   = Math.max(Math.abs(gex.callWall || 0), Math.abs(gex.putWall || 0), Math.abs(gex.netGEX || 0), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#020d1c" }}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #0c2240", flexShrink: 0, background: "#010a18", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 10, fontWeight: 700, color: "#00cfff", letterSpacing: 1 }}>⚡ OPTIONS INTELLIGENCE</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
          {symbolList.length === 0 && <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#1a5070" }}>◌ Waiting for live data…</span>}
          {symbolList.slice(0, 20).map(sym => (
            <button key={sym} onClick={() => setActiveSymbol(sym)} style={{ background: activeSymbol === sym ? "#00cfff22" : "transparent", border: `1px solid ${activeSymbol === sym ? "#00cfff66" : "#0c2240"}`, borderRadius: 3, padding: "2px 8px", cursor: "pointer", fontFamily: "IBM Plex Mono,monospace", fontSize: 9, fontWeight: 700, color: activeSymbol === sym ? "#00cfff" : "#2a6080" }}>
              {sym}
            </button>
          ))}
        </div>
        {lastUpdated && <span style={{ fontSize: 8, fontFamily: "IBM Plex Mono,monospace", color: "#0d3050", marginLeft: "auto" }}>Updated {Math.round((Date.now() - lastUpdated) / 1000)}s ago</span>}
      </div>

      {!d ? <EmptyState symbol={activeSymbol} /> : (
        <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 10, alignContent: "start" }}>

          {/* Score Card — full width */}
          <div style={{ gridColumn: "1 / -1", background: band?.bg || "#010a18", border: `1px solid ${band?.color || "#0c2240"}44`, borderRadius: 8, padding: "14px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 80 }}>
              <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "IBM Plex Mono,monospace", color: band?.color || "#4a9abb", lineHeight: 1 }}>{score != null ? Math.round(score) : "—"}</div>
              <div style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", fontWeight: 700, color: band?.color || "#1a5070", letterSpacing: 1 }}>{band?.label || "NO DATA"}</div>
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontFamily: "IBM Plex Mono,monospace", fontSize: 14, fontWeight: 700, color: "#d8eeff", marginBottom: 6 }}>
                {activeSymbol}
                <span style={{ fontSize: 10, color: band?.color, marginLeft: 10, fontWeight: 400 }}>{bias}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {signals.slice(0, 5).map((s, i) => <StrategyTag key={i} signal={s} />)}
              </div>
              {factors.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {factors.slice(0, 3).map((f, i) => (
                    <div key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono,monospace", color: "#2a7090", marginBottom: 2 }}>· {f.label || f.reason || f}</div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, minWidth: 200 }}>
              <StatCard label="EXPECTED MOVE" value={structure.expectedMove ? `±${fmt2(structure.expectedMove)}` : "—"} sub="1σ straddle" color="#4fc3f7" />
              <StatCard label="EVENT RISK" value={structure.eventRiskScore != null ? Math.round(structure.eventRiskScore) : "—"} sub="0–100 scale" color={structure.eventRiskScore > 60 ? "#ef5350" : "#ffd54f"} />
            </div>
          </div>

          {/* IV Panel */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Volatility</SectionLabel>
            <IVRankMeter ivRank={iv.ivRank} ivPct={iv.ivPercentile} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
              <StatCard label="ATM IV" value={fmtPct(iv.atmIV)} color="#00cfff" />
              <StatCard label="VRP" value={iv.vrp != null ? (iv.vrp > 0 ? "+" : "") + fmt2(iv.vrp) + "%" : "—"} sub="IV − HV20" color={iv.vrp > 0 ? "#ff8a65" : "#00ff9c"} />
              <StatCard label="HV 20" value={fmtPct(iv.hv20)} />
              <StatCard label="HV 60" value={fmtPct(iv.hv60)} />
            </div>
            {iv.ivCrushDetected && (
              <div style={{ marginTop: 8, padding: "5px 8px", background: "#1a0800", border: "1px solid #ff8a6544", borderRadius: 4, fontSize: 9, color: "#ff8a65", fontFamily: "IBM Plex Mono,monospace" }}>
                ⚠ IV CRUSH DETECTED
              </div>
            )}
          </div>

          {/* GEX Panel */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Dealer Positioning (GEX)</SectionLabel>
            <GexBar label="Net GEX" value={gex.netGEX} max={maxGex} color={gex.netGEX >= 0 ? "#00ff9c" : "#ef5350"} />
            <GexBar label="Call Wall" value={gex.callWall} max={maxGex} color="#4fc3f7" />
            <GexBar label="Put Wall" value={gex.putWall} max={maxGex} color="#ff8a65" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <StatCard label="GAMMA FLIP" value={gex.gammaFlip ? fmt2(gex.gammaFlip) : "—"} sub="spot level" color="#ffd54f" />
              <StatCard label="REGIME" value={gex.regime || "—"} color={gex.regime === "MEAN_REVERTING" ? "#00ff9c" : "#ef5350"} />
            </div>
          </div>

          {/* OI Panel */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Open Interest Intelligence</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="PCR" value={fmt2(oi.pcr)} sub="put/call ratio" color={oi.pcr > 1.2 ? "#00ff9c" : oi.pcr < 0.8 ? "#ef5350" : "#ffd54f"} />
              <StatCard label="MAX PAIN" value={oi.maxPain ? fmt2(oi.maxPain) : "—"} sub="expiry" color="#4fc3f7" />
              <StatCard label="TOTAL OI" value={oi.totalOI ? (oi.totalOI / 1e5).toFixed(1) + "L" : "—"} />
              <StatCard label="NET FLOW" value={oi.netPremiumFlow ? fmtCr(oi.netPremiumFlow) : "—"} color={oi.netPremiumFlow > 0 ? "#00ff9c" : "#ef5350"} />
            </div>
            {oi.unusualOI && oi.unusualOI.length > 0 && (
              <>
                <SectionLabel>Unusual OI Signals</SectionLabel>
                {oi.unusualOI.slice(0, 4).map((u, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "IBM Plex Mono,monospace", padding: "4px 0", borderBottom: "1px solid #0a1828" }}>
                    <span style={{ color: u.type === "CALL" ? "#4fc3f7" : "#ff8a65" }}>{u.type} {u.strike}</span>
                    <span style={{ color: "#d8eeff" }}>{u.oi?.toLocaleString("en-IN")} OI</span>
                    <span style={{ color: "#ff5cff" }}>↑{fmt2(u.ratio)}x</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Greeks Panel */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Portfolio Greeks (ATM)</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="DELTA" value={fmt2(greeks.delta)} color={greeks.delta > 0 ? "#00ff9c" : "#ef5350"} />
              <StatCard label="GAMMA" value={fmt2(greeks.gamma)} />
              <StatCard label="THETA" value={greeks.theta ? fmt2(greeks.theta) : "—"} sub="₹/day" color="#ff8a65" />
              <StatCard label="VEGA" value={fmt2(greeks.vega)} sub="per 1% IV" color="#4fc3f7" />
              <StatCard label="LAMBDA" value={fmt2(greeks.lambda)} sub="leverage" />
              <StatCard label="RHO" value={fmt2(greeks.rho)} />
            </div>
            {(gex.vanna != null || gex.charm != null) && (
              <>
                <SectionLabel>Second-Order Flow</SectionLabel>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <StatCard label="VANNA (DEX)" value={gex.vanna != null ? fmtCr(gex.vanna) : "—"} sub="Δ vs vol" color="#ff5cff" />
                  <StatCard label="CHARM" value={gex.charm != null ? fmtCr(gex.charm) : "—"} sub="time-decay flow" color="#ffd54f" />
                </div>
              </>
            )}
          </div>

          {/* Market Structure */}
          <div style={{ background: "#010a18", border: "1px solid #0c2240", borderRadius: 8, padding: "12px 14px" }}>
            <SectionLabel>Market Structure</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <StatCard label="SUPPORT" value={structure.support ? fmt2(structure.support) : "—"} sub="put OI wall" color="#00ff9c" />
              <StatCard label="RESISTANCE" value={structure.resistance ? fmt2(structure.resistance) : "—"} sub="call OI wall" color="#ef5350" />
            </div>
            {structure.is0DTE && (
              <div style={{ padding: "5px 8px", background: "#1a0018", border: "1px solid #ff5cff44", borderRadius: 4, fontSize: 9, color: "#ff5cff", fontFamily: "IBM Plex Mono,monospace", marginBottom: 8 }}>
                ⚡ 0DTE SESSION — gamma risk elevated
              </div>
            )}
            {structure.skew != null && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "IBM Plex Mono,monospace", padding: "6px 0" }}>
                <span style={{ color: "#1a5070" }}>Skew (25Δ)</span>
                <span style={{ color: structure.skew > 0 ? "#ff8a65" : "#4fc3f7", fontWeight: 700 }}>
                  {structure.skew > 0 ? "+" : ""}{fmt2(structure.skew * 100)} vol pts
                </span>
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
