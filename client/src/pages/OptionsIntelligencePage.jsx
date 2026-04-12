// OptionsIntelligencePage.jsx
// Save as: client/src/pages/OptionsIntelligencePage.jsx
//
// ══════════════════════════════════════════════════════════════
// FIXES APPLIED (this session):
//
// FIX-NETFLOW-DISPLAY — NET FLOW showed in Lakhs instead of Crores:
//   OIPanel used fmtL(oi.netPremiumFlow) but engine now outputs Crores.
//   Fix: changed to fmtCr(oi.netPremiumFlow). Label also updated to "NET FLOW".
//
// FIX-SPOT-FIELD — DIST% column blank in OI table:
//   spot was read as: d?.spot || d?.ltp || structure?.spot
//   But optionsIntelligenceEngine returns spotPrice (not spot) at top level.
//   Both fields now emitted (spot + spotPrice aliases in engine).
//   Fix: read d?.spot || d?.spotPrice || d?.ltp to cover both.
//
// FIX-LAMBDA-DISPLAY — Lambda showed "—":
//   Engine was not including lambda in atmGreeks return object (fixed in engine).
//   Frontend display: lambda is now in greeks.lambda — no change needed here
//   beyond ensuring the read path is correct (greeks.lambda ?? greeks.leverage).
//
// FIX-GAMMA-DISPLAY — Gamma showed 0.0006 losing precision:
//   Engine now returns gamma rounded to 6dp (was 4dp → showed 0.0000 for small values).
//   Frontend display: changed toFixed(4) → toFixed(6) so 0.000032 shows correctly.
//
// Previously fixed (preserved):
//   FIX 1 — fmtCr() double-scaling flash
//   FIX 2 — Vanna/Charm wrong fallback source in GEXPanel
//   FIX 3 — Total OI double-divide
//   FIX 4 — netPremiumFlow unit mismatch (was partially fixed, now complete)
//   FIX 5 — Market hours awareness
//   FIX 6 — Mixed IV signal conflict
//   FIX 7 — GannPanel: show last known price outside market hours
// ══════════════════════════════════════════════════════════════

import { useEffect, useState, useCallback, useRef } from "react";
import GannBadge from "../components/GannBadge";

// ─── IST helpers ──────────────────────────────────────────────────────────────
function nowIST() {
  const now   = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istMs = utcMs + 5.5 * 60 * 60 * 1000;
  const ist   = new Date(istMs);
  return {
    day:     ist.getDay(),
    hours:   ist.getHours(),
    minutes: ist.getMinutes(),
    ist,
  };
}

function isMarketOpen() {
  const { day, hours, minutes } = nowIST();
  if (day === 0 || day === 6) return false;
  const total = hours * 60 + minutes;
  return total >= 9 * 60 && total <= 15 * 60 + 35;
}

function marketStatusLabel() {
  const { day, hours, minutes } = nowIST();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (day === 0 || day === 6) return `CLOSED (${days[day]} — weekend)`;
  const total = hours * 60 + minutes;
  if (total < 9 * 60)        return `PRE-MARKET (opens 09:00 IST)`;
  if (total > 15 * 60 + 35)  return `CLOSED (after hours ${hours}:${String(minutes).padStart(2,"0")} IST)`;
  return `OPEN`;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt2(n)   { return n == null ? "—" : Number(n).toFixed(2); }
function fmtInt(n) { return n == null ? "—" : Math.round(Number(n)).toLocaleString("en-IN"); }

function fmtCr(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return (n / 1000).toFixed(1) + "K Cr";
  if (abs >= 0.01) return Number(n).toFixed(1) + " Cr";
  return "0 Cr";
}

function fmtL(n) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return (n / 1000).toFixed(1) + "K L";
  return Number(n).toFixed(1) + " L";
}

function fmtOILakhs(totalCallOI, totalPutOI) {
  const t = (totalCallOI || 0) + (totalPutOI || 0);
  if (!t) return "—";
  if (t > 1e6) return (t / 1e5).toFixed(1) + "L";
  if (t > 1)   return t.toFixed(1) + "L";
  return "—";
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
  if (isNaN(v) || v <= 0) return null;
  if (v > 200) return v / 100;
  if (v > 3)   return v;
  return v * 100;
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

const ALERT_ICONS = {
  GAMMA_FLIP: "⚡", GEX_FLIP: "⚡", PCR_SPIKE: "▲", PUT_WALL: "●",
  CALL_WALL: "●", OI_SURGE: "▲", REGIME_CHANGE: "◆", GANN_ANGLE: "◤",
  TIME_CYCLE: "◷", CARDINAL_CROSS: "✕", SQUARE_OF_NINE: "#",
};

// ─── Market Hours Banner ──────────────────────────────────────────────────────
function MarketClosedBanner({ lastUpdated }) {
  const open = isMarketOpen();
  if (open) return null;

  const status = marketStatusLabel();
  const ageMins = lastUpdated ? Math.round((Date.now() - lastUpdated) / 60000) : null;
  const isStale = ageMins == null || ageMins > 30;

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
      padding: "4px 12px", background: "#0d1800", borderBottom: "1px solid #ffd54f33",
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 8, color: "#ffd54f", fontFamily: "IBM Plex Mono,monospace", fontWeight: 700 }}>
        ◷ MARKET {status}
      </span>
      {isStale && (
        <span style={{ fontSize: 7, color: "#5a90a8", fontFamily: "IBM Plex Mono,monospace" }}>
          · Showing last session data
          {ageMins != null ? ` (${ageMins < 60 ? `${ageMins}m` : `${Math.round(ageMins/60)}h`} ago)` : ""}
        </span>
      )}
    </div>
  );
}

// ─── Trade Decision Engine ────────────────────────────────────────────────────
function TradeDecision({ spot, callWall, putWall, gammaFlip, regime, pcr, skew25 }) {
  if (!spot) return null;
  let text = null, color = "#a0b8cc", icon = "◈";

  if (gammaFlip && spot > gammaFlip && regime === "TREND_AMPLIFYING") {
    text = "Trend mode → Buy dips / momentum longs"; color = "#00ff9c"; icon = "▲";
  } else if (gammaFlip && spot < gammaFlip && regime === "MEAN_REVERTING") {
    text = "Mean reversion → Sell rallies / range plays"; color = "#ffd54f"; icon = "◆";
  } else if (callWall && spot >= callWall * 0.995) {
    text = "At call wall → Expect pin / sell calls"; color = "#4fc3f7"; icon = "●";
  } else if (putWall && spot <= putWall * 1.005) {
    text = "At put wall → Expect bounce / buy dips"; color = "#ff8a65"; icon = "●";
  } else if (pcr && pcr > 1.4) {
    text = "PCR extreme → Contrarian buy signals"; color = "#00ff9c"; icon = "▲";
  } else if (pcr && pcr < 0.7) {
    text = "PCR low → Market complacent, stay hedged"; color = "#ef5350"; icon = "▼";
  } else if (skew25 && skew25 > 6) {
    text = "Put skew extreme → Risk reversal opportunity"; color = "#ff8a65"; icon = "◆";
  }

  if (!text) return null;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:5, padding:"3px 8px", background:`${color}11`, borderRadius:3, border:`1px solid ${color}33`, marginTop:5 }}>
      <span style={{ fontSize:9, color }}>{icon}</span>
      <span style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, color }}>▶ {text}</span>
    </div>
  );
}

// ════════════════ Shared sub-components ══════════════════════════════════════

function HStat({ label, value, sub, color }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:1, minWidth:52, flexShrink:0 }}>
      <div style={{ fontSize:8, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", letterSpacing:0.8, textTransform:"uppercase", whiteSpace:"nowrap" }}>{label}</div>
      <div style={{ fontSize:11, fontWeight:700, color:color||"#e8f2ff", fontFamily:"IBM Plex Mono,monospace", lineHeight:1.1 }}>{value}</div>
      {sub && <div style={{ fontSize:7, color:"#a0b8cc", fontFamily:"IBM Plex Mono,monospace" }}>{sub}</div>}
    </div>
  );
}

function VDivider() {
  return <div style={{ width:1, background:"#2a5070", alignSelf:"stretch", margin:"0 6px", flexShrink:0 }} />;
}

function SL({ children, icon }) {
  return (
    <div style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, color:"#c8d8e8", letterSpacing:1.5, textTransform:"uppercase", borderBottom:"1px solid #1e4060", paddingBottom:4, marginBottom:6, flexShrink:0 }}>
      {icon && <span style={{ marginRight:4 }}>{icon}</span>}{children}
    </div>
  );
}

function GexBar({ label, value, max, color }) {
  const pct = Math.min(Math.abs((value||0)/(max||1))*100, 100);
  return (
    <div style={{ marginBottom:5 }}>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, fontFamily:"IBM Plex Mono,monospace", marginBottom:2 }}>
        <span style={{ color:"#c8d8e8" }}>{label}</span>
        <span style={{ color }}>{fmtCr(value)}</span>
      </div>
      <div style={{ height:3, background:"#1a3040", borderRadius:2 }}>
        <div style={{ height:3, width:`${pct}%`, background:color, borderRadius:2, minWidth:pct>0?2:0 }} />
      </div>
    </div>
  );
}

function MiniCard({ label, value, sub, color }) {
  return (
    <div style={{ background:"#071828", border:"1px solid #1e3a50", borderRadius:4, padding:"5px 8px" }}>
      <div style={{ fontSize:7, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", letterSpacing:1, marginBottom:2 }}>{label}</div>
      <div style={{ fontSize:12, fontWeight:700, color:color||"#e8f2ff", fontFamily:"IBM Plex Mono,monospace", lineHeight:1.1, wordBreak:"break-word" }}>{value}</div>
      {sub && <div style={{ fontSize:7, color:"#a0b8cc", marginTop:1, fontFamily:"IBM Plex Mono,monospace" }}>{sub}</div>}
    </div>
  );
}

function IVRankBar({ ivRank, ivPct }) {
  if (ivRank == null) {
    return (
      <div style={{ minWidth:80 }}>
        <div style={{ fontSize:7, color:"#5a90a8", fontFamily:"IBM Plex Mono,monospace", textTransform:"uppercase", letterSpacing:0.8 }}>IV Rank</div>
        <div style={{ fontSize:7, color:"#5a90a8", fontFamily:"IBM Plex Mono,monospace", marginTop:2 }}>No IV history</div>
      </div>
    );
  }
  const rank = Math.min(Math.max(ivRank,0),100);
  const clr  = rank>70?"#ef5350":rank>40?"#ffd54f":"#00ff9c";
  return (
    <div style={{ minWidth:80 }}>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:7, fontFamily:"IBM Plex Mono,monospace", marginBottom:2 }}>
        <span style={{ color:"#c8d8e8", textTransform:"uppercase", letterSpacing:0.8 }}>IV Rank</span>
        <span style={{ color:clr, fontWeight:700 }}>{fmt2(rank)}</span>
      </div>
      <div style={{ height:4, background:"#1a3040", borderRadius:2 }}>
        <div style={{ height:4, width:`${rank}%`, minWidth:rank>0?2:0, background:clr, borderRadius:2 }} />
      </div>
      {ivPct!=null && <div style={{ fontSize:6, color:"#a0b8cc", fontFamily:"IBM Plex Mono,monospace", marginTop:1 }}>%ile: {fmt2(ivPct)}</div>}
    </div>
  );
}

function StrategyTag({ signal }) {
  const label = typeof signal==="string"?signal:(signal?.strategy||"");
  const colors = {
    SELL_PREMIUM:     { bg:"#002210", color:"#00ff9c", border:"#00ff9c33" },
    BUY_OPTIONS:      { bg:"#001828", color:"#4fc3f7", border:"#4fc3f733" },
    BUY_PREMIUM:      { bg:"#001828", color:"#4fc3f7", border:"#4fc3f733" },
    MIXED_IV:         { bg:"#1a1000", color:"#ffd54f", border:"#ffd54f55" },
    GAMMA_SQUEEZE:    { bg:"#1a1000", color:"#ffd54f", border:"#ffd54f33" },
    GAMMA_WALL:       { bg:"#1a1000", color:"#ffd54f", border:"#ffd54f33" },
    SKEW_TRADE:       { bg:"#1a0a00", color:"#ff8a65", border:"#ff8a6533" },
    UNUSUAL_ACTIVITY: { bg:"#1a0018", color:"#ff5cff", border:"#ff5cff33" },
    UNUSUAL_OI:       { bg:"#1a0018", color:"#ff5cff", border:"#ff5cff33" },
    DEFENSIVE:        { bg:"#1a0000", color:"#ef5350", border:"#ef535033" },
    IV_CRUSH:         { bg:"#1a0000", color:"#ef5350", border:"#ef535033" },
  };
  const c = colors[label]||{ bg:"#1a3040", color:"#a8c8e0", border:"#4a9abb33" };
  const prefix = label === "MIXED_IV" ? "⚡ " : "";
  return (
    <span style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, padding:"1px 5px", borderRadius:2, background:c.bg, color:c.color, border:`1px solid ${c.border}`, whiteSpace:"nowrap" }}>
      {prefix}{label.replace(/_/g," ")}
    </span>
  );
}

function PanelWrap({ children, borderColor }) {
  return (
    <div style={{ background:"#060f1c", border:`1px solid ${borderColor||"#1c3a58"}`, borderRadius:6, padding:"10px 12px", flex:"1 1 0", minWidth:0, minHeight:0, overflowY:"auto", display:"flex", flexDirection:"column" }}>
      {children}
    </div>
  );
}

function EmptyState({ symbol }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:10 }}>
      <div style={{ fontSize:28, opacity:0.2 }}>◤</div>
      <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:10, color:"#c8d8e8", textAlign:"center" }}>
        {symbol?`Waiting for data on ${symbol}…`:"Select a symbol"}
      </div>
    </div>
  );
}

// ════════════════ Alert Card ══════════════════════════════════════════════════

function AlertCard({ alerts }) {
  const ref = useRef(null);
  useEffect(()=>{ if(ref.current) ref.current.scrollTop=0; },[alerts?.length]);
  return (
    <div style={{ background:"#071828", border:"1px solid #1c3a58", borderRadius:5, padding:"5px 10px", minWidth:200, maxWidth:280, flexShrink:0 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:3 }}>
        <div style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, color:"#c8d8e8", letterSpacing:1.2, textTransform:"uppercase" }}>⚡ Alerts</div>
        {alerts?.length>0 && <span style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", padding:"1px 4px", borderRadius:2, background:"#1a0000", color:"#ef5350", fontWeight:700 }}>{alerts.length}</span>}
      </div>
      <div ref={ref} style={{ maxHeight:62, overflowY:"auto" }}>
        {!alerts?.length
          ? <div style={{ fontSize:7, color:"#5a90a8", fontFamily:"IBM Plex Mono,monospace" }}>◌ No alerts</div>
          : alerts.slice(0,5).map((a,i)=>{
              const isHigh=a.priority==="HIGH";
              const color=isHigh?"#ef5350":a.priority==="MEDIUM"?"#ffd54f":"#a8c8e0";
              const age=a.ts?Math.round((Date.now()-a.ts)/1000):null;
              return (
                <div key={i} style={{ display:"flex", gap:4, padding:"2px 0", borderBottom:i<Math.min(alerts.length,5)-1?"1px solid #1a3040":"none", animation:isHigh?"alertPulse 1.5s infinite":"none" }}>
                  <span style={{ fontSize:8, flexShrink:0 }}>{ALERT_ICONS[a.type]||"◈"}</span>
                  <div style={{ flex:1, fontSize:7, color, fontFamily:"IBM Plex Mono,monospace", fontWeight:isHigh?700:400, lineHeight:1.3 }}>{a.message||a.detail||String(a)}</div>
                  {age!=null && <span style={{ fontSize:6, color:"#a0b8cc", fontFamily:"IBM Plex Mono,monospace", flexShrink:0 }}>{age<60?`${age}s`:`${Math.round(age/60)}m`}</span>}
                </div>
              );
            })
        }
      </div>
    </div>
  );
}

// ════════════════ OI Chain Viewer ═════════════════════════════════════════════

function OIChainViewer({ nearATMSignals, tailRiskSignals, spot, activeSymbol }) {
  const [view,setView]           = useState("near");
  const [scrollIdx,setScrollIdx] = useState(0);
  const ROWS=7;
  const nearLabel=(activeSymbol||"").toUpperCase().includes("BANK")?"±10%":"±8%";

  const sortRows=(arr)=>[...(arr||[])].sort((a,b)=>{
    const da=Math.abs(a.strike-spot), db=Math.abs(b.strike-spot);
    if(da!==db) return da-db;
    return (a.type||"").toUpperCase()==="CALL"?-1:1;
  });

  const rows=sortRows(view==="near"?nearATMSignals:tailRiskSignals);
  const visible=rows.slice(scrollIdx,scrollIdx+ROWS);
  const canUp=scrollIdx>0, canDn=scrollIdx+ROWS<rows.length;

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, minHeight:0 }}>
      <div style={{ display:"flex", gap:4, marginBottom:5 }}>
        {[{ key:"near", label:`NEAR ATM ${nearLabel}`, color:"#4fc3f7" },{ key:"tail", label:"FII HEDGE / TAIL", color:"#d890f8" }].map(t=>(
          <button key={t.key} onClick={()=>{ setView(t.key); setScrollIdx(0); }}
            style={{ flex:1, fontSize:7, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, letterSpacing:0.7, padding:"3px 2px", borderRadius:3, cursor:"pointer",
              background:view===t.key?`${t.color}15`:"transparent", border:`1px solid ${view===t.key?t.color+"55":"#1a3040"}`, color:view===t.key?t.color:"#5a90a8" }}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"28px 52px 1fr 1fr 44px", gap:3, fontSize:7, fontFamily:"IBM Plex Mono,monospace", color:"#5a90a8", letterSpacing:0.7, textTransform:"uppercase", paddingBottom:3, borderBottom:"1px solid #1a3040", marginBottom:2, flexShrink:0 }}>
        <span/><span>STRIKE</span><span style={{ textAlign:"right" }}>OI</span><span style={{ textAlign:"right" }}>VOL</span><span style={{ textAlign:"right" }}>DIST%</span>
      </div>
      <div style={{ flex:1, overflow:"hidden" }}>
        {rows.length===0
          ? <div style={{ fontSize:7, color:"#5a90a8", fontFamily:"IBM Plex Mono,monospace", textAlign:"center", padding:"10px 0" }}>◌ No data</div>
          : visible.map((u,i)=>{
              const isCE=(u.type||"").toUpperCase()==="CALL";
              // FIX-SPOT-FIELD: spot is guaranteed non-null from parent (fixed below)
              const dist=(spot&&spot>0&&u.strike>0)?+((u.strike-spot)/spot*100).toFixed(1):null;
              const typeC=isCE?"#4fc3f7":"#ff8a65";
              const oiChg=u.oiChange||0;
              return (
                <div key={`${u.strike}-${u.type}-${i}`} style={{ display:"grid", gridTemplateColumns:"28px 52px 1fr 1fr 44px", gap:3, padding:"3px 2px", background:i%2===0?"#071828":"transparent", borderRadius:2, alignItems:"center" }}>
                  <span style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, padding:"1px 2px", borderRadius:2, background:`${typeC}15`, color:typeC, border:`1px solid ${typeC}33`, textAlign:"center" }}>{isCE?"CE":"PE"}</span>
                  <span style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, color:"#e8f2ff" }}>{fmtInt(u.strike)}</span>
                  <span style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", color:"#c8d8e8", textAlign:"right" }}>
                    {(u.oi||0).toLocaleString("en-IN")}
                    {oiChg!==0&&<span style={{ fontSize:6, color:oiChg>0?"#00ff9c":"#ef5350", marginLeft:2 }}>{oiChg>0?"▲":"▼"}</span>}
                  </span>
                  <span style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", color:"#ff5cff", textAlign:"right" }}>{(u.vol||0).toLocaleString("en-IN")}</span>
                  <span style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, textAlign:"right", color:dist!=null?(dist>0?"#4fc3f7":"#ff8a65"):"#5a90a8" }}>
                    {dist!=null?`${dist>0?"+":""}${dist}%`:"—"}
                  </span>
                </div>
              );
            })
        }
      </div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", paddingTop:4, borderTop:"1px solid #1a3040", marginTop:4, flexShrink:0 }}>
        <span style={{ fontSize:7, color:"#5a90a8", fontFamily:"IBM Plex Mono,monospace" }}>
          {rows.length>0?`${scrollIdx+1}–${Math.min(scrollIdx+ROWS,rows.length)} / ${rows.length}`:"0"}
        </span>
        <div style={{ display:"flex", gap:3 }}>
          <button onClick={()=>setScrollIdx(Math.max(0,scrollIdx-ROWS))} disabled={!canUp}
            style={{ fontSize:9, padding:"1px 6px", borderRadius:2, background:canUp?"#1a3040":"transparent", border:`1px solid ${canUp?"#2a5070":"#1a2030"}`, color:canUp?"#c8d8e8":"#2a4050", cursor:canUp?"pointer":"default", fontFamily:"IBM Plex Mono,monospace" }}>▲</button>
          <button onClick={()=>setScrollIdx(Math.min(rows.length-ROWS,scrollIdx+ROWS))} disabled={!canDn}
            style={{ fontSize:9, padding:"1px 6px", borderRadius:2, background:canDn?"#1a3040":"transparent", border:`1px solid ${canDn?"#2a5070":"#1a2030"}`, color:canDn?"#c8d8e8":"#2a4050", cursor:canDn?"pointer":"default", fontFamily:"IBM Plex Mono,monospace" }}>▼</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════ GEX Panel ═══════════════════════════════════════════════════

function GEXPanel({ gex, dealerExposures }) {
  const gexCallVal = gex.callGEX ?? null;
  const gexPutVal  = gex.putGEX  ?? null;
  const gexMax = Math.max(
    Math.abs(gex.netGEX  || 0),
    Math.abs(gexCallVal  || 0),
    Math.abs(gexPutVal   || 0),
    1
  );
  const gexBias   = gex.netGEX > 0 ? "Dealers long gamma — market stabilized"
                  : gex.netGEX < 0 ? "Dealers short gamma — volatile, trend-amplifying"
                  : "Neutral dealer positioning";
  const gexBiasC  = gex.netGEX > 0 ? "#00ff9c" : gex.netGEX < 0 ? "#ef5350" : "#ffd54f";
  const vanna = dealerExposures?.vex  ?? null;
  const charm = dealerExposures?.chex ?? null;

  return (
    <PanelWrap>
      <SL>Dealer GEX</SL>
      <GexBar label="Net GEX"  value={gex.netGEX}  max={gexMax} color={gex.netGEX>=0?"#00ff9c":"#ef5350"} />
      <GexBar label="Call GEX" value={gexCallVal}   max={gexMax} color="#4fc3f7" />
      <GexBar label="Put GEX"  value={gexPutVal}    max={gexMax} color="#ff8a65" />
      <div style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", color:gexBiasC, margin:"4px 0 8px", lineHeight:1.4, padding:"3px 6px", background:`${gexBiasC}10`, borderRadius:3, border:`1px solid ${gexBiasC}22` }}>◈ {gexBias}</div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5 }}>
        <MiniCard label="GAMMA FLIP" value={gex.gammaFlip ? gex.gammaFlip.toLocaleString("en-IN") : "—"} sub="spot level" color="#ffd54f" />
        <MiniCard label="REGIME"     value={gex.regime ? gex.regime.replace(/_/g," ") : "—"} color={gex.regime==="MEAN_REVERTING"?"#00ff9c":"#ef5350"} />
        <MiniCard label="CALL WALL"  value={gex.callWall ? gex.callWall.toLocaleString("en-IN") : "—"} sub="resistance" color="#4fc3f7" />
        <MiniCard label="PUT WALL"   value={gex.putWall  ? gex.putWall.toLocaleString("en-IN")  : "—"} sub="support"    color="#ff8a65" />
      </div>
      {(vanna != null || charm != null) && (<>
        <div style={{ borderTop:"1px solid #1a3040", margin:"8px 0 4px" }}/>
        <SL>2nd Order</SL>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5 }}>
          <MiniCard label="VANNA" value={fmtCr(vanna)} sub="Δ vs vol"   color="#ff5cff" />
          <MiniCard label="CHARM" value={fmtCr(charm)} sub="time decay" color="#ffd54f" />
        </div>
      </>)}
      {gex.topStrikes?.length > 0 && (<>
        <div style={{ borderTop:"1px solid #1a3040", margin:"8px 0 4px" }}/>
        <SL>Top GEX Strikes</SL>
        {gex.topStrikes.slice(0,4).map((s,i) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:8, fontFamily:"IBM Plex Mono,monospace", padding:"2px 0", borderBottom:"1px solid #0d2030" }}>
            <span style={{ color:"#c8d8e8" }}>{fmtInt(s.strike)}</span>
            <span style={{ color:s.netGEX>=0?"#00ff9c":"#ef5350", fontWeight:700 }}>{fmtCr(s.netGEX)}</span>
          </div>
        ))}
      </>)}
    </PanelWrap>
  );
}

// ════════════════ OI Panel ════════════════════════════════════════════════════

function OIPanel({ oi, nearATMSignals, tailRiskSignals, spot, activeSymbol }) {
  const oiSummary = oi.pcr > 1.2 ? "Put dominance → bullish (mm hedge)"
                  : oi.pcr < 0.8 ? "Call dominance → market complacent"
                  : oi.pcr != null ? "Balanced PCR → neutral" : null;
  const oiColor = oi.pcr > 1.2 ? "#00ff9c" : oi.pcr < 0.8 ? "#ef5350" : "#ffd54f";

  return (
    <PanelWrap>
      <SL>OI Intelligence</SL>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginBottom:5 }}>
        <MiniCard label="PCR"      value={fmt2(oi.pcr)} sub="put/call" color={oi.pcr>1.2?"#00ff9c":oi.pcr<0.8?"#ef5350":"#ffd54f"} />
        <MiniCard label="MAX PAIN" value={oi.maxPain ? oi.maxPain.toLocaleString("en-IN") : "—"} sub="expiry" color="#4fc3f7" />
        <MiniCard label="TOTAL OI" value={fmtOILakhs(oi.totalCallOI, oi.totalPutOI)} />
        {/* FIX-NETFLOW-DISPLAY: was fmtL() — engine outputs Crores so use fmtCr() */}
        <MiniCard
          label="NET FLOW"
          value={oi.netPremiumFlow != null ? fmtCr(oi.netPremiumFlow) : "—"}
          sub="Cr"
          color={oi.netPremiumFlow > 0 ? "#00ff9c" : "#ef5350"}
        />
      </div>
      {oiSummary && (
        <div style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", color:oiColor, marginBottom:6, padding:"3px 6px", background:`${oiColor}10`, borderRadius:3, border:`1px solid ${oiColor}22` }}>◈ {oiSummary}</div>
      )}
      <OIChainViewer
        nearATMSignals={nearATMSignals}
        tailRiskSignals={tailRiskSignals}
        spot={spot}
        activeSymbol={activeSymbol}
      />
    </PanelWrap>
  );
}

// ════════════════ Gann Panel ══════════════════════════════════════════════════

function GannPanel({ gann }) {
  const now   = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist   = new Date(utcMs + 5.5 * 3600000);
  const day   = ist.getDay();
  const days  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const hh    = String(ist.getHours()).padStart(2,"0");
  const mm    = String(ist.getMinutes()).padStart(2,"0");

  if (!gann) return (
    <PanelWrap>
      <SL icon="◤">Gann Analysis</SL>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:8, padding:"16px 0" }}>
        <div style={{ fontSize:22, opacity:0.2 }}>◤</div>
        <div style={{ fontSize:8, color:"#5a90a8", fontFamily:"IBM Plex Mono,monospace" }}>◌ Requesting…</div>
      </div>
    </PanelWrap>
  );

  const hasSignal = !!(gann.signal && !gann.error);
  const noCacheAtAll = !hasSignal && !gann._usingCachedLTP;

  if (noCacheAtAll && (gann.marketClosed || gann.error)) return (
    <PanelWrap borderColor="#1a3040">
      <SL icon="◤">Gann Analysis</SL>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:10, padding:"16px 8px" }}>
        <div style={{ fontSize:28, opacity:0.15 }}>◤</div>
        <div style={{ fontSize:9, fontWeight:700, color:"#ffd54f", fontFamily:"IBM Plex Mono,monospace", textAlign:"center", letterSpacing:1 }}>
          {day === 0 || day === 6
            ? `MARKET CLOSED — ${days[day].toUpperCase()}`
            : gann._marketStatus || "MARKET CLOSED"}
        </div>
        <div style={{ fontSize:8, color:"#5a90a8", fontFamily:"IBM Plex Mono,monospace", textAlign:"center", lineHeight:1.7 }}>
          {day === 0 || day === 6
            ? "Gann data will load\nMon 9:00 AM IST"
            : "Data loads at\n9:00 AM IST"}
        </div>
        <div style={{ fontSize:7, color:"#2a5070", fontFamily:"IBM Plex Mono,monospace" }}>
          {hh}:{mm} IST · {days[day]}
        </div>
        {gann.symbol && (
          <div style={{ fontSize:7, color:"#2a5070", fontFamily:"IBM Plex Mono,monospace", padding:"2px 6px", border:"1px solid #1a3040", borderRadius:2 }}>
            {gann.symbol}
          </div>
        )}
      </div>
    </PanelWrap>
  );

  const sig     = gann.signal || {};
  const son     = gann.squareOfNine || {};
  const fan     = gann.priceOnUpFan || gann.priceOnDownFan || null;
  const cycles  = (gann.timeCycles || []).slice(0, 5);
  const gAlerts = (gann.alerts || []).filter(a => a.priority === "HIGH").slice(0, 2);
  const levels  = gann.keyLevels || {};
  const cardinal = gann.cardinalCross || {};
  const gBias   = sig.bias || "NEUTRAL";
  const gScore  = sig.score ?? null;
  const gc      = gannPalette(gBias);
  const proxC   = { IMMINENT:"#ef5350", THIS_WEEK:"#ffd54f", THIS_FORTNIGHT:"#ff8a65", THIS_MONTH:"#4fc3f7" };
  const cycC    = { EXTREME:"#ef5350", MAJOR:"#ff8a65", SIGNIFICANT:"#ffd54f", MINOR:"#4a9abb" };

  let lastUpdateLabel = null;
  if (gann._lastUpdatedAt) {
    try {
      const updIST = new Date(new Date(gann._lastUpdatedAt).getTime() + 5.5 * 3600000);
      const uh  = String(updIST.getUTCHours()).padStart(2, "0");
      const um  = String(updIST.getUTCMinutes()).padStart(2, "0");
      const uday = days[updIST.getUTCDay()];
      lastUpdateLabel = `${uh}:${um} IST · ${uday}`;
    } catch (_) {}
  }

  const showStaleBanner = gann._usingCachedLTP || (!isMarketOpen() && gann._marketStatus);

  return (
    <PanelWrap borderColor={gc.border}>
      <SL icon="◤">Gann Analysis</SL>

      {showStaleBanner && (
        <div style={{
          display:"flex", alignItems:"center", justifyContent:"space-between",
          fontSize:7, fontFamily:"IBM Plex Mono,monospace",
          color:"#ffd54f", background:"#1a1000",
          border:"1px solid #ffd54f33", borderRadius:3,
          padding:"3px 8px", marginBottom:6, gap:6,
        }}>
          <span style={{ whiteSpace:"nowrap" }}>◷ Last known price</span>
          <span style={{ color:"#a08020", textAlign:"right", lineHeight:1.4 }}>
            {gann._marketStatus || marketStatusLabel()}
            {lastUpdateLabel ? ` · ${lastUpdateLabel}` : ""}
          </span>
        </div>
      )}

      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, padding:"6px 8px", background:gc.bg, borderRadius:4, border:`1px solid ${gc.border}` }}>
        <div style={{ textAlign:"center", minWidth:40 }}>
          <div style={{ fontSize:22, fontWeight:700, color:gc.color, fontFamily:"IBM Plex Mono,monospace", lineHeight:1 }}>
            {gScore != null ? Math.round(gScore) : "—"}
          </div>
          <div style={{ fontSize:7, color:gc.color, fontFamily:"IBM Plex Mono,monospace", opacity:0.7 }}>/100</div>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:11, fontWeight:700, color:gc.color, fontFamily:"IBM Plex Mono,monospace" }}>
            {gBias.replace(/_/g," ")}
          </div>
          {sig.summary && (
            <div style={{ fontSize:8, color:"#a0b8cc", fontFamily:"IBM Plex Mono,monospace", lineHeight:1.3 }}>
              {sig.summary.replace(/^Gann: [A-Z]+ \(score \d+\/100\)\.\s?/,"")}
            </div>
          )}
        </div>
        {cardinal?.inCardinalZone?.strength === "ON_CARDINAL" && (
          <span style={{ fontSize:7, padding:"1px 4px", borderRadius:2, background:"#1a0800", border:"1px solid #ffd54f44", color:"#ffd54f", fontFamily:"IBM Plex Mono,monospace" }}>CARDINAL</span>
        )}
      </div>

      {(levels.supports?.length > 0 || levels.resistances?.length > 0) && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginBottom:8 }}>
          <div style={{ background:"#071828", border:"1px solid #00ff9c22", borderRadius:4, padding:"5px 7px" }}>
            <div style={{ fontSize:7, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", letterSpacing:1, marginBottom:3 }}>SUPPORTS</div>
            {(levels.supports||[]).slice(0,3).map((s,i) => (
              <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:8, fontFamily:"IBM Plex Mono,monospace", padding:"1px 0" }}>
                <span style={{ color:"#00ff9c" }}>S{i+1} {fmtInt(s.price)}</span>
                <span style={{ color:"#c8d8e8", fontSize:7 }}>{s.source?.includes("Nine")?"SoN":s.source?.includes("Cardinal")?"Card":"—"}</span>
              </div>
            ))}
          </div>
          <div style={{ background:"#071828", border:"1px solid #ef535022", borderRadius:4, padding:"5px 7px" }}>
            <div style={{ fontSize:7, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", letterSpacing:1, marginBottom:3 }}>RESISTANCES</div>
            {(levels.resistances||[]).slice(0,3).map((r,i) => (
              <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:8, fontFamily:"IBM Plex Mono,monospace", padding:"1px 0" }}>
                <span style={{ color:"#ef5350" }}>R{i+1} {fmtInt(r.price)}</span>
                <span style={{ color:"#c8d8e8", fontSize:7 }}>{r.source?.includes("Nine")?"SoN":r.source?.includes("Cardinal")?"Card":"—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {son?.positionOnSquare && (
        <div style={{ marginBottom:6 }}>
          <div style={{ fontSize:7, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", letterSpacing:1, marginBottom:3 }}>SQUARE OF NINE</div>
          <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
            <span style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", color:"#4fc3f7" }}>
              {son.angleOnSquare?.toFixed(1)}° on square
            </span>
            <span style={{ fontSize:7, padding:"1px 4px", borderRadius:2, fontFamily:"IBM Plex Mono,monospace",
              background:son.positionOnSquare.strength==="EXTREME"?"#1a0000":son.positionOnSquare.strength==="STRONG"?"#1a0800":"#0a1020",
              color:son.positionOnSquare.strength==="EXTREME"?"#ef5350":son.positionOnSquare.strength==="STRONG"?"#ffd54f":"#4a9abb" }}>
              {son.positionOnSquare.strength}
            </span>
          </div>
          <div style={{ fontSize:7, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", marginTop:2 }}>
            {son.positionOnSquare.label}
          </div>
        </div>
      )}

      {fan && (
        <div style={{ marginBottom:6, padding:"5px 7px", background:"#071828", borderRadius:3, border:"1px solid #1a3848" }}>
          <div style={{ fontSize:7, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", marginBottom:2 }}>GANN FAN</div>
          <div style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", color:fan.aboveMasterAngle?"#00ff9c":"#ef5350", fontWeight:700 }}>
            {fan.aboveMasterAngle?"▲ Above":"▼ Below"} 1×1 master
            {fan.criticalLevel != null && (
              <span style={{ color:"#a8c8e0", fontWeight:400 }}> @ ₹{fmtInt(fan.criticalLevel)}</span>
            )}
          </div>
        </div>
      )}

      {cycles.length > 0 && (
        <div style={{ marginBottom:6 }}>
          <div style={{ fontSize:7, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", letterSpacing:1, marginBottom:3 }}>TIME CYCLES</div>
          {cycles.map((c,i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:8, fontFamily:"IBM Plex Mono,monospace", padding:"2px 0", borderBottom:"1px solid #1a3040" }}>
              <span style={{ color:cycC[c.cycleStrength]||"#4a9abb", flex:1, paddingRight:4, lineHeight:1.3 }}>{c.label}</span>
              <span style={{ color:proxC[c.proximity]||"#4a9abb", whiteSpace:"nowrap", fontSize:7 }}>
                {c.daysFromToday===0?"TODAY":c.daysFromToday<0?`${Math.abs(c.daysFromToday)}d ago`:`+${c.daysFromToday}d`}
              </span>
            </div>
          ))}
        </div>
      )}

      {gAlerts.length > 0 && (
        <div>
          <div style={{ fontSize:7, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", letterSpacing:1, marginBottom:3 }}>HIGH PRIORITY</div>
          {gAlerts.map((a,i) => (
            <div key={i} style={{ padding:"4px 6px", background:"#1a0000", border:"1px solid #ef535033", borderRadius:3, marginBottom:3, fontSize:8, fontFamily:"IBM Plex Mono,monospace", color:"#ef5350", fontWeight:700 }}>
              {a.message}
            </div>
          ))}
        </div>
      )}

      {gann.headline && (
        <div style={{ fontSize:8, color:"#c8d8e8", fontFamily:"IBM Plex Mono,monospace", marginTop:4, lineHeight:1.4, padding:"4px 6px", background:"#071828", borderRadius:3, border:"1px solid #1a3848" }}>
          {gann.headline}
        </div>
      )}

      {gann._usingCachedLTP && gann.ltp && (
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, fontFamily:"IBM Plex Mono,monospace", padding:"5px 0", borderTop:"1px solid #1a3040", marginTop:6 }}>
          <span style={{ color:"#c8d8e8" }}>Last LTP</span>
          <span style={{ color:"#ffd54f", fontWeight:700 }}>₹{fmtInt(gann.ltp)}</span>
        </div>
      )}
    </PanelWrap>
  );
}

// ════════════════ Market Structure Panel ══════════════════════════════════════

function MarketStructurePanel({ structure, gannData, gannBadgeMap, activeSymbol, spot, callWall, putWall, gammaFlip, maxPain, pcr, skew25 }) {
  const dCall  = callWall  ? calcPct(callWall,  spot) : null;
  const dPut   = putWall   ? calcPct(spot, putWall)   : null;
  const dGamma = gammaFlip ? calcPct(gammaFlip, spot) : null;
  const aboveGF = gammaFlip ? spot > gammaFlip : null;

  let rangePct = null;
  if (callWall && putWall && spot) {
    rangePct = Math.round(((spot - putWall) / (callWall - putWall)) * 100);
    rangePct = Math.max(0, Math.min(100, rangePct));
  }

  let zoneLabel, zoneColor;
  if      (callWall  && spot >= callWall  * 0.99) { zoneLabel = "At Call Wall — resistance"; zoneColor = "#4fc3f7"; }
  else if (putWall   && spot <= putWall   * 1.01) { zoneLabel = "At Put Wall — support";     zoneColor = "#ff8a65"; }
  else if (gammaFlip && spot >= gammaFlip)         { zoneLabel = "Above Gamma Flip — trend";  zoneColor = "#00ff9c"; }
  else if (gammaFlip && spot <  gammaFlip)         { zoneLabel = "Below Gamma Flip — MR";     zoneColor = "#ffd54f"; }
  else                                              { zoneLabel = "Between walls";             zoneColor = "#4a9abb"; }

  const ivEnvDisplay = {
    RICH_SELL_PREMIUM: { label: "RICH — SELL PREMIUM",  color: "#ef5350" },
    ELEVATED:          { label: "ELEVATED",              color: "#ff8a65" },
    NORMAL:            { label: "NORMAL",                color: "#a0b8cc" },
    CHEAP_BUY_OPTIONS: { label: "CHEAP — BUY OPTIONS",  color: "#00ff9c" },
    VERY_CHEAP:        { label: "VERY CHEAP",            color: "#00ff9c" },
    MIXED_IV:          { label: "⚡ MIXED IV",           color: "#ffd54f" },
  };
  const ivEnv     = structure.ivEnvironment || "NORMAL";
  const ivDisplay = ivEnvDisplay[ivEnv] || { label: ivEnv.replace(/_/g," "), color: "#a0b8cc" };

  const gannHasData   = gannData && (gannData.signal || gannData._usingCachedLTP);
  const gannHasLevels = gannData?.keyLevels && gannHasData;

  return (
    <PanelWrap>
      <SL>Market Structure</SL>
      {gannHasData && (
        <div style={{ marginBottom:6 }}><GannBadge symbol={activeSymbol} gannMap={gannBadgeMap} compact={false} /></div>
      )}
      {spot && (
        <div style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"3px 7px", borderRadius:3, marginBottom:6, background:`${zoneColor}11`, border:`1px solid ${zoneColor}33` }}>
          <span style={{ width:5, height:5, borderRadius:"50%", background:zoneColor, display:"inline-block" }} />
          <span style={{ fontSize:8, color:zoneColor, fontFamily:"IBM Plex Mono,monospace", fontWeight:700 }}>{zoneLabel}</span>
        </div>
      )}
      {spot && (
        <div style={{ marginBottom:8 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#e8f2ff", fontFamily:"IBM Plex Mono,monospace", marginBottom:3 }}>₹{fmtInt(spot)}</div>
          {rangePct !== null && (<>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:7, fontFamily:"IBM Plex Mono,monospace", color:"#5a90a8", marginBottom:2 }}>
              <span>PUT {fmtInt(putWall)}</span>
              <span style={{ color:"#e8f2ff" }}>{rangePct}% in range</span>
              <span>CALL {fmtInt(callWall)}</span>
            </div>
            <div style={{ height:5, background:"#1a3040", borderRadius:3, position:"relative" }}>
              <div style={{ height:5, width:`${rangePct}%`, background:"linear-gradient(90deg, #ff8a6566, #ffd54f66)", borderRadius:3 }} />
              <div style={{ position:"absolute", left:`${rangePct}%`, top:-1, width:2, height:7, background:"#e8f2ff", borderRadius:1, transform:"translateX(-50%)" }} />
            </div>
          </>)}
        </div>
      )}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginBottom:8 }}>
        <MiniCard label="SUPPORT (OI)"   value={structure.supportFromOI    ? structure.supportFromOI.toLocaleString("en-IN")    : "—"} sub="put OI wall"  color="#00ff9c" />
        <MiniCard label="RESIST (OI)"    value={structure.resistanceFromOI ? structure.resistanceFromOI.toLocaleString("en-IN") : "—"} sub="call OI wall" color="#ef5350" />
        {gannHasLevels && (<>
          <MiniCard label="SUPPORT (GANN)" value={gannData.keyLevels.supports?.[0]?.price    ? gannData.keyLevels.supports[0].price.toLocaleString("en-IN")    : "—"} sub={gannData.keyLevels.supports?.[0]?.source    || "SoN"} color="#00ff9c" />
          <MiniCard label="RESIST (GANN)"  value={gannData.keyLevels.resistances?.[0]?.price ? gannData.keyLevels.resistances[0].price.toLocaleString("en-IN") : "—"} sub={gannData.keyLevels.resistances?.[0]?.source || "SoN"} color="#ef5350" />
        </>)}
      </div>
      {spot && (
        <div style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace" }}>
          {callWall  && dCall  != null && <div style={{ display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:"1px solid #1a3040" }}><span style={{ color:"#c8d8e8" }}>↑ Call Wall</span><span style={{ color:"#4fc3f7", fontWeight:700 }}>+{Math.abs(dCall).toFixed(1)}% ₹{fmtInt(callWall-spot)}</span></div>}
          {putWall   && dPut   != null && <div style={{ display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:"1px solid #1a3040" }}><span style={{ color:"#c8d8e8" }}>↓ Put Wall</span><span style={{ color:"#ff8a65", fontWeight:700 }}>-{Math.abs(dPut).toFixed(1)}% ₹{fmtInt(spot-putWall)}</span></div>}
          {gammaFlip && dGamma != null && <div style={{ display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:"1px solid #1a3040" }}><span style={{ color:"#c8d8e8" }}>γ Flip</span><span style={{ color:aboveGF?"#00ff9c":"#ffd54f", fontWeight:700 }}>{aboveGF?"+":"-"}{Math.abs(dGamma).toFixed(1)}% ₹{fmtInt(gammaFlip)}</span></div>}
          {maxPain   && <div style={{ display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:"1px solid #1a3040" }}><span style={{ color:"#c8d8e8" }}>⊗ Max Pain</span><span style={{ color:"#a8c8e0", fontWeight:700 }}>₹{fmtInt(maxPain)}</span></div>}
          {pcr != null && <div style={{ display:"flex", justifyContent:"space-between", padding:"3px 0", borderBottom:"1px solid #1a3040" }}><span style={{ color:"#c8d8e8" }}>⊕ PCR</span><span style={{ color:pcr>1.2?"#00ff9c":pcr<0.8?"#ef5350":"#ffd54f", fontWeight:700 }}>{pcr.toFixed(2)} — {pcr>1.2?"bullish":pcr<0.8?"bearish":"neutral"}</span></div>}
          {spot && callWall && <div style={{ display:"flex", justifyContent:"space-between", padding:"3px 0" }}><span style={{ color:"#c8d8e8" }}>Breakout</span><span style={{ color:spot>callWall*0.99?"#00ff9c":"#ef5350", fontWeight:700 }}>{spot>callWall*0.99?"High — at resistance":"Low — below call wall"}</span></div>}
        </div>
      )}
      {structure.ivEnvironment && (
        <div style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", color:"#a0b8cc", marginTop:6, display:"flex", alignItems:"center", gap:4 }}>
          <span>IV env:</span>
          <span style={{ color: ivDisplay.color, fontWeight: 700 }}>{ivDisplay.label}</span>
        </div>
      )}
      {ivEnv === "MIXED_IV" && (
        <div style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", color:"#ffd54f99", marginTop:3, lineHeight:1.5, padding:"3px 6px", background:"#1a100033", borderRadius:3, border:"1px solid #ffd54f22" }}>
          IV Rank high vs history but cheap vs realized vol. Avoid premium selling — wait for VRP to turn positive.
        </div>
      )}
      {structure.straddlePrice != null && (
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, fontFamily:"IBM Plex Mono,monospace", padding:"5px 0", borderTop:"1px solid #1a3040", marginTop:6 }}>
          <span style={{ color:"#c8d8e8" }}>ATM Straddle</span>
          <span style={{ color:"#e8f2ff", fontWeight:700 }}>₹{fmt2(structure.straddlePrice)}</span>
        </div>
      )}
      {gannHasLevels && gannData.keyLevels.masterAngle != null && (
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, fontFamily:"IBM Plex Mono,monospace", padding:"5px 0", borderTop:"1px solid #1a3040" }}>
          <span style={{ color:"#c8d8e8" }}>Gann 1×1{gannData._usingCachedLTP ? " ◷" : ""}</span>
          <span style={{ color:"#ffd54f", fontWeight:700 }}>₹{Math.round(gannData.keyLevels.masterAngle).toLocaleString("en-IN")}</span>
        </div>
      )}
    </PanelWrap>
  );
}

// ════════════════ Main Page ═══════════════════════════════════════════════════

export default function OptionsIntelligencePage({ socket }) {
  const [data,setData]               = useState({});
  const [gannMap,setGannMap]         = useState({});
  const [liveAlerts,setLiveAlerts]   = useState([]);
  const [activeSymbol,setActiveSymbol] = useState(null);
  const [symbolList,setSymbolList]   = useState([]);
  const [lastUpdated,setLastUpdated] = useState(null);
  const [tick,setTick]               = useState(0);

  useEffect(() => { const t = setInterval(() => setTick(n => n+1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!socket) return; socket.emit("request-intel-snapshot"); }, [socket]);

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
        if (!prev) setTimeout(() => requestGann(sym, (payload?.data || payload)?.ltp || null), 100);
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
        return { ...prev, [alert.symbol.toUpperCase()]: { ...ex, alerts: [...(alert.alerts||[]), ...(ex.alerts||[]).filter(a => a.priority !== "HIGH")] } };
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
    requestGann(sym, d?.ltp || d?.spot || d?.spotPrice || null);
  };

  const current  = data[activeSymbol] || null;
  const d        = current?.data || current || null;
  const score    = d?.score ?? null;
  const bias     = d?.bias ?? "NEUTRAL";
  const band     = score != null ? ScoreBand(score) : null;
  const vol      = d?.volatility      || {};
  const greeks   = d?.atmGreeks       || {};
  const gex      = d?.gex             || {};
  const dealerExp = d?.dealerExposures || {};
  const oi       = d?.oi              || {};
  const structure = d?.structure      || {};
  const strategy  = d?.strategy       || [];

  const gannData = activeSymbol
    ? (gannMap[toGannSym(activeSymbol)] || gannMap[activeSymbol] || gannMap[activeSymbol?.toUpperCase()] || null)
    : null;

  const gannBadgeMap = {};
  if (activeSymbol && gannData && (gannData.signal || gannData._usingCachedLTP)) {
    const gs = gannData.signal || {}, gl = gannData.keyLevels || {};
    gannBadgeMap[activeSymbol] = {
      bias:       gs.bias || "NEUTRAL",
      support:    gl.supports?.[0]?.price    ?? null,
      resistance: gl.resistances?.[0]?.price ?? null,
      angle:      gannData.squareOfNine?.angleOnSquare ?? null,
    };
  }

  // FIX-SPOT-FIELD: read spotPrice OR spot — engine now emits both as aliases
  // d.spot = d.spotPrice = spotPrice from analyzeOptionsChain()
  const spot = d?.spot || d?.spotPrice || d?.ltp || structure?.spot || null;

  const oiNear    = oi.unusualOI || [];
  const oiTail    = oi.unusualOITailRisk || [];
  const hasDedicatedFields = oiNear.length > 0 || oiTail.length > 0;
  const nearATMPct = (activeSymbol || "").toUpperCase().includes("BANK") ? 10 : 8;
  let nearATMSignals, tailRiskSignals;
  if (hasDedicatedFields) {
    nearATMSignals = oiNear; tailRiskSignals = oiTail;
  } else {
    const allUnusual = oi.unusualOI || [];
    nearATMSignals = filterByProximity(allUnusual, spot, activeSymbol, nearATMPct);
    const nearSet  = new Set(nearATMSignals.map(u => `${u.strike}-${u.type}`));
    tailRiskSignals = allUnusual.filter(u => !nearSet.has(`${u.strike}-${u.type}`));
  }

  const atmIV    = normaliseIV(vol.atmIV ?? vol.iv ?? vol.atm_iv ?? vol.atmIv ?? vol.ATM_IV ?? null);
  const hv20     = vol.hv20 ?? vol.hv_20 ?? vol.HV20 ?? vol.Hv20 ?? null;
  const hv60     = vol.hv60 ?? vol.hv_60 ?? vol.HV60 ?? vol.Hv60 ?? null;
  const vrp      = vol.vrp  ?? vol.vRp   ?? vol.VRP  ?? null;
  const skew25   = vol.skew25 ?? null;

  // FIX-LAMBDA-DISPLAY: engine now includes lambda in atmGreeks
  const lambda   = greeks.lambda ?? greeks.leverage ?? null;
  const lambdaDisplay = (lambda != null && lambda !== 0) ? fmt2(lambda) : "—";

  // FIX-GAMMA-DISPLAY: engine returns 6dp precision — show 6dp not 4dp
  const gammaDisplay = (greeks.gamma && greeks.gamma !== 0)
    ? greeks.gamma.toFixed(6)
    : "—";

  const deltaVal      = greeks.delta ?? null;
  const deltaDisplay  = deltaVal != null ? fmt2(deltaVal) : "—";
  const deltaColor    = deltaVal == null ? "#e8f2ff" : Math.abs(deltaVal) > 0.85 ? "#ffd54f" : deltaVal > 0 ? "#00ff9c" : "#ef5350";
  const ageSec        = lastUpdated ? Math.round((Date.now() - lastUpdated) / 1000) : null;
  const hv20Display   = hv20 != null ? (hv20 < 3 ? (hv20*100).toFixed(1) : Number(hv20).toFixed(1)) + "%" : "—";
  const hv60Display   = hv60 != null ? (hv60 < 3 ? (hv60*100).toFixed(1) : Number(hv60).toFixed(1)) + "%" : "—";
  const vrpDisplay    = vrp  != null ? `${vrp > 0 ? "+" : ""}${fmt2(vrp)}%` : "—";

  return (
    <>
      <style>{`@keyframes alertPulse { 0%,100%{opacity:1} 50%{opacity:0.35} }`}</style>
      <div style={{ display:"flex", flexDirection:"column", height:"100%", background:"#020d1c", overflow:"hidden" }}>

        {/* Toolbar */}
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 12px", borderBottom:"1px solid #1c3a58", flexShrink:0, background:"#060f1c", minHeight:36 }}>
          <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:9, fontWeight:700, color:"#00cfff", letterSpacing:1, flexShrink:0 }}>⚡ OPTIONS INTEL</span>
          <div style={{ display:"flex", gap:3, overflowX:"auto", flex:1 }}>
            {symbolList.length === 0 && <span style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", color:"#c8d8e8" }}>◌ Waiting…</span>}
            {symbolList.slice(0,20).map(sym => (
              <button key={sym} onClick={() => handleSymbolChange(sym)}
                style={{ background:activeSymbol===sym?"#00cfff22":"transparent", border:`1px solid ${activeSymbol===sym?"#00cfff66":"#1c3a58"}`, borderRadius:2, padding:"1px 7px", cursor:"pointer", fontFamily:"IBM Plex Mono,monospace", fontSize:8, fontWeight:700, color:activeSymbol===sym?"#00cfff":"#5a90a8", flexShrink:0 }}>
                {sym}
              </button>
            ))}
          </div>
          {d && <AlertCard alerts={liveAlerts} />}
          {ageSec != null && (
            <span style={{ fontSize:7, fontFamily:"IBM Plex Mono,monospace", color: ageSec > 120 ? "#ffd54f" : "#a0b8cc", flexShrink:0 }}>
              ↻ {ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec/60)}m`}
            </span>
          )}
        </div>

        {/* Market closed banner */}
        <MarketClosedBanner lastUpdated={lastUpdated} />

        {!d ? <EmptyState symbol={activeSymbol} /> : (
          <div style={{ flex:1, display:"flex", flexDirection:"column", padding:8, gap:8, overflow:"hidden", minHeight:0 }}>

            {/* Score Card */}
            <div style={{ flexShrink:0, background:band?.bg||"#060f1c", border:`1px solid ${band?.color||"#1c3a58"}44`, borderRadius:6, padding:"8px 14px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", minWidth:52, flexShrink:0 }}>
                  <div style={{ fontSize:34, fontWeight:700, fontFamily:"IBM Plex Mono,monospace", color:band?.color||"#4a9abb", lineHeight:1 }}>{score != null ? Math.round(score) : "—"}</div>
                  <div style={{ fontSize:8, fontFamily:"IBM Plex Mono,monospace", fontWeight:700, color:band?.color||"#6aA0b8", letterSpacing:0.8 }}>{band?.label||"NO DATA"}</div>
                </div>
                <div style={{ flexShrink:0, minWidth:120 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                    <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:13, fontWeight:700, color:"#e8f2ff" }}>{activeSymbol}</span>
                    <span style={{ fontSize:9, color:band?.color, fontFamily:"IBM Plex Mono,monospace" }}>{bias}</span>
                    {gannData && (gannData.signal || gannData._usingCachedLTP) && (
                      <GannBadge symbol={activeSymbol} gannMap={gannBadgeMap} compact={true} />
                    )}
                  </div>
                  <div style={{ display:"flex", gap:3, flexWrap:"wrap" }}>
                    {strategy.slice(0,4).map((s,i) => <StrategyTag key={i} signal={s} />)}
                  </div>
                </div>
                <VDivider />
                <div style={{ display:"flex", gap:10, alignItems:"flex-start", flex:1, overflowX:"auto", flexWrap:"nowrap" }}>
                  {spot && <HStat label="Spot" value={`₹${fmtInt(spot)}`} sub={gex.callWall&&gex.putWall?`${Math.max(0,Math.min(100,Math.round(((spot-gex.putWall)/(gex.callWall-gex.putWall))*100)))}% range`:""} color="#e8f2ff" />}
                  <HStat label="Exp Move" value={structure.expectedMoveAbs ? `±${fmt2(structure.expectedMoveAbs)}` : "—"} sub="1σ" color="#4fc3f7" />
                  <HStat label="Evt Risk" value={structure.eventRiskScore != null ? Math.round(structure.eventRiskScore) : "0"} sub="0–100" color={structure.eventRiskScore > 60 ? "#ef5350" : structure.eventRiskScore > 0 ? "#ffd54f" : "#5a90a8"} />
                  <VDivider />
                  <HStat label="ATM IV" value={atmIV != null ? `${atmIV.toFixed(1)}%` : "—"} color="#00cfff" />
                  <HStat label="VRP"    value={vrpDisplay} sub="IV−HV20" color={vrp != null ? (vrp > 0 ? "#ff8a65" : "#00ff9c") : "#4a9abb"} />
                  <HStat label="HV 20"  value={hv20Display} />
                  <HStat label="HV 60"  value={hv60Display} />
                  <IVRankBar ivRank={vol.ivRank} ivPct={vol.ivPercentile} />
                  <VDivider />
                  <HStat label="Delta"  value={deltaDisplay}  color={deltaColor} />
                  {/* FIX-GAMMA-DISPLAY: 6 decimal places */}
                  <HStat label="Gamma"  value={gammaDisplay}  color={gammaDisplay === "—" ? "#5a90a8" : "#e8f2ff"} />
                  <HStat label="Theta"  value={greeks.theta != null ? fmt2(greeks.theta) : "—"} sub="₹/day" color="#ff8a65" />
                  <HStat label="Vega"   value={fmt2(greeks.vega)} sub="1%IV" color="#4fc3f7" />
                  {/* FIX-LAMBDA-DISPLAY: engine now returns greeks.lambda */}
                  <HStat label="Lambda" value={lambdaDisplay} sub="lev" />
                  <HStat label="Rho"    value={fmt2(greeks.rho)} />
                </div>
              </div>
              <TradeDecision spot={spot} callWall={gex.callWall} putWall={gex.putWall} gammaFlip={gex.gammaFlip} regime={gex.regime} pcr={oi.pcr} skew25={skew25} />
            </div>

            {/* 4 Panels */}
            <div style={{ flex:1, display:"flex", gap:8, minHeight:0 }}>
              <GEXPanel gex={gex} dealerExposures={dealerExp} />
              <OIPanel oi={oi} nearATMSignals={nearATMSignals} tailRiskSignals={tailRiskSignals} spot={spot} activeSymbol={activeSymbol} />
              <GannPanel gann={gannData} />
              <MarketStructurePanel structure={structure} gannData={gannData} gannBadgeMap={gannBadgeMap} activeSymbol={activeSymbol} spot={spot} callWall={gex.callWall} putWall={gex.putWall} gammaFlip={gex.gammaFlip} maxPain={oi.maxPain} pcr={oi.pcr} skew25={skew25} />
            </div>

          </div>
        )}
      </div>
    </>
  );
}
