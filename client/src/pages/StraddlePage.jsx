// client/src/pages/StraddlePage.jsx
// Live Straddle & Strangle Chart Page
// Features: ATM tracker, combined premium chart, payoff diagram, Greeks, IV, PCR

import { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend,
} from "recharts";

// ─── Constants ──────────────────────────────────────────────────────────────
const SYMBOLS   = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
const REFRESH_MS = 5000; // poll every 5s

const COLOR = {
  buy:         "#00e5a0",
  sell:        "#ff4d6d",
  straddle:    "#7dd3fc",
  strangle:    "#f9a825",
  breakeven:   "#94a3b8",
  spot:        "#ffffff",
  grid:        "#1e293b",
  cardBg:      "rgba(15,23,42,0.85)",
  border:      "rgba(99,120,160,0.18)",
  green:       "#22c55e",
  red:         "#ef4444",
  muted:       "#64748b",
  text:        "#e2e8f0",
  accent:      "#38bdf8",
};

// ─── Utility ─────────────────────────────────────────────────────────────────
const fmt = (n, d = 2) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d });
const fmtPct = (n) => (n == null ? "—" : `${Number(n).toFixed(2)}%`);
const now = () =>
  new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, pulse }) {
  return (
    <div style={{
      background: COLOR.cardBg,
      border: `1px solid ${COLOR.border}`,
      borderRadius: 12,
      padding: "14px 18px",
      minWidth: 120,
      position: "relative",
      overflow: "hidden",
    }}>
      {pulse && (
        <span style={{
          position: "absolute", top: 10, right: 10,
          width: 8, height: 8, borderRadius: "50%",
          background: COLOR.green,
          boxShadow: `0 0 6px ${COLOR.green}`,
          animation: "blink 1.4s ease-in-out infinite",
        }} />
      )}
      <div style={{ fontSize: 11, color: COLOR.muted, marginBottom: 4, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || COLOR.text, fontFamily: "'JetBrains Mono', monospace" }}>
        {value ?? "—"}
      </div>
      {sub && <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function GreeksRow({ greeks }) {
  if (!greeks?.delta?.ce) return null;
  const items = [
    { label: "Δ CE Delta", value: greeks.delta.ce?.toFixed(3) },
    { label: "Δ PE Delta", value: greeks.delta.pe?.toFixed(3) },
    { label: "Θ Theta CE", value: greeks.theta.ce?.toFixed(3) },
    { label: "Θ Theta PE", value: greeks.theta.pe?.toFixed(3) },
    { label: "V Vega CE",  value: greeks.vega.ce?.toFixed(3)  },
    { label: "V Vega PE",  value: greeks.vega.pe?.toFixed(3)  },
  ];
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
      {items.map(({ label, value }) => (
        <div key={label} style={{
          background: "rgba(30,41,59,0.7)", borderRadius: 8,
          padding: "6px 12px", fontSize: 12,
          border: `1px solid ${COLOR.border}`,
        }}>
          <span style={{ color: COLOR.muted }}>{label}: </span>
          <span style={{ color: COLOR.accent, fontFamily: "monospace" }}>{value ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#0f172a", border: `1px solid ${COLOR.border}`,
      borderRadius: 8, padding: "10px 14px", fontSize: 12,
    }}>
      <div style={{ color: COLOR.muted, marginBottom: 6 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <strong>{fmt(p.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function PayoffTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const pl = payload[0]?.value;
  return (
    <div style={{
      background: "#0f172a", border: `1px solid ${COLOR.border}`,
      borderRadius: 8, padding: "10px 14px", fontSize: 12,
    }}>
      <div style={{ color: COLOR.muted, marginBottom: 4 }}>Spot: ₹{fmt(label)}</div>
      <div style={{ color: pl >= 0 ? COLOR.green : COLOR.red, fontWeight: 700 }}>
        P&L: ₹{fmt(pl)}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function StraddlePage() {
  const [symbol,      setSymbol]      = useState("NIFTY");
  const [expiry,      setExpiry]      = useState("");
  const [stratType,   setStratType]   = useState("straddle"); // straddle | strangle
  const [side,        setSide]        = useState("sell");     // buy | sell
  const [strangleStep,setStrangleStep]= useState(1);

  const [snap,        setSnap]        = useState(null);
  const [payoff,      setPayoff]      = useState(null);
  const [premHistory, setPremHistory] = useState([]); // [{time, straddle, strangle}]
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [lastRefresh, setLastRefresh] = useState("—");

  const timerRef = useRef(null);

  // ── Fetch snapshot ──────────────────────────────────────────────────────
  const fetchSnap = useCallback(async () => {
    try {
      const expiryQ = expiry ? `&expiry=${expiry}` : "";
      const r = await fetch(`/api/straddle/snapshot?symbol=${symbol}${expiryQ}`);
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setSnap(data);

      // update expiry list default
      if (!expiry && data.expiries?.[0]) setExpiry(data.expiries[0]);

      // append to premium history
      const t = now();
      setPremHistory((prev) => {
        const next = [...prev, {
          time: t,
          straddle: data.straddle.combined,
          strangle: data.strangle.combined,
        }];
        return next.slice(-120); // keep last 120 ticks (~10 min @ 5s)
      });

      setLastRefresh(t);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, expiry]);

  // ── Fetch payoff ────────────────────────────────────────────────────────
  const fetchPayoff = useCallback(async () => {
    try {
      const expiryQ = expiry ? `&expiry=${expiry}` : "";
      const r = await fetch(
        `/api/straddle/payoff?symbol=${symbol}${expiryQ}&type=${stratType}&side=${side}&steps=${strangleStep}`
      );
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setPayoff(data);
    } catch (e) {
      console.error("Payoff fetch error:", e);
    }
  }, [symbol, expiry, stratType, side, strangleStep]);

  // ── Polling ─────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchSnap();
    fetchPayoff();
    timerRef.current = setInterval(() => {
      fetchSnap();
      fetchPayoff();
    }, REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [fetchSnap, fetchPayoff]);

  // ── Payoff chart color (green above 0, red below) ─────────────────────
  const payoffColor = (entry) => (entry.pl >= 0 ? COLOR.green : COLOR.red);

  const activeStrat = snap ? (stratType === "straddle" ? snap.straddle : snap.strangle) : null;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg,#020817 0%,#0c1628 60%,#071020 100%)",
      color: COLOR.text,
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
      padding: "24px 28px",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600;700&display=swap');
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
        .strat-tab { cursor:pointer; padding:7px 18px; border-radius:8px; font-size:13px; font-weight:600;
                     border:1px solid transparent; transition:all .2s; }
        .strat-tab.active { background:rgba(56,189,248,.15); border-color:${COLOR.accent}; color:${COLOR.accent}; }
        .strat-tab:not(.active) { color:${COLOR.muted}; }
        .strat-tab:not(.active):hover { background:rgba(255,255,255,.04); color:${COLOR.text}; }
        .side-btn { cursor:pointer; padding:7px 20px; border-radius:8px; font-size:13px; font-weight:700;
                    border:1px solid transparent; transition:all .2s; }
        select { background:#0f172a; color:${COLOR.text}; border:1px solid ${COLOR.border};
                 border-radius:8px; padding:7px 12px; font-size:13px; cursor:pointer; outline:none; }
        select:hover { border-color:${COLOR.accent}; }
        .card { background:rgba(15,23,42,0.85); border:1px solid ${COLOR.border}; border-radius:14px;
                padding:20px 22px; animation:fadeIn .4s ease; }
        .section-title { font-size:13px; font-weight:600; color:${COLOR.muted};
                         text-transform:uppercase; letter-spacing:.07em; margin-bottom:14px; }
      `}</style>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" }}>
            <span style={{ color: COLOR.accent }}>Straddle</span> &amp; Strangle
          </h1>
          <div style={{ fontSize: 12, color: COLOR.muted, marginTop: 3 }}>
            Live combined premium · Auto ATM · Payoff diagram · Greeks
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {/* Symbol */}
          <select value={symbol} onChange={(e) => { setSymbol(e.target.value); setExpiry(""); setPremHistory([]); }}>
            {SYMBOLS.map((s) => <option key={s}>{s}</option>)}
          </select>

          {/* Expiry */}
          {snap?.expiries?.length > 0 && (
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {snap.expiries.map((ex) => <option key={ex}>{ex}</option>)}
            </select>
          )}

          {/* Strategy type tabs */}
          <div style={{ display: "flex", gap: 4, background: "rgba(15,23,42,.8)", padding: 3, borderRadius: 10 }}>
            {["straddle", "strangle"].map((t) => (
              <button key={t} className={`strat-tab ${stratType === t ? "active" : ""}`}
                onClick={() => setStratType(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* OTM steps (strangle only) */}
          {stratType === "strangle" && (
            <select value={strangleStep} onChange={(e) => setStrangleStep(+e.target.value)}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{n} step OTM</option>)}
            </select>
          )}

          {/* Buy / Sell */}
          <div style={{ display: "flex", gap: 4, background: "rgba(15,23,42,.8)", padding: 3, borderRadius: 10 }}>
            <button className="side-btn" onClick={() => setSide("buy")}
              style={{ background: side === "buy" ? "rgba(0,229,160,.15)" : "transparent",
                       borderColor: side === "buy" ? COLOR.buy : "transparent",
                       color: side === "buy" ? COLOR.buy : COLOR.muted }}>
              Buy
            </button>
            <button className="side-btn" onClick={() => setSide("sell")}
              style={{ background: side === "sell" ? "rgba(255,77,109,.15)" : "transparent",
                       borderColor: side === "sell" ? COLOR.sell : "transparent",
                       color: side === "sell" ? COLOR.sell : COLOR.muted }}>
              Sell
            </button>
          </div>
        </div>
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ background: "rgba(239,68,68,.1)", border: "1px solid rgba(239,68,68,.3)",
          borderRadius: 10, padding: "10px 16px", marginBottom: 16, fontSize: 13, color: "#fca5a5" }}>
          ⚠ {error} — Check that <code>/api/straddle/snapshot</code> is registered in server.js
        </div>
      )}

      {loading && !snap && (
        <div style={{ textAlign: "center", padding: 60, color: COLOR.muted }}>Loading option chain data…</div>
      )}

      {snap && (
        <>
          {/* ── Top stat cards ─────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
            <StatCard label="Spot Price" value={`₹${fmt(snap.spotPrice)}`} pulse />
            <StatCard label="ATM Strike" value={fmt(snap.atmStrike)} />
            <StatCard
              label={`${stratType === "straddle" ? "Straddle" : "Strangle"} Premium`}
              value={`₹${fmt(activeStrat?.combined)}`}
              color={COLOR.accent}
            />
            <StatCard
              label="Upper BE"
              value={`₹${fmt(activeStrat?.upperBreakeven)}`}
              color={COLOR.green}
            />
            <StatCard
              label="Lower BE"
              value={`₹${fmt(activeStrat?.lowerBreakeven)}`}
              color={COLOR.red}
            />
            <StatCard label="ATM IV" value={fmtPct(snap.iv?.atm)} color={COLOR.strangle} />
            <StatCard label="PCR" value={snap.oi?.pcr ?? "—"}
              color={+snap.oi?.pcr > 1 ? COLOR.green : COLOR.red} />
            <StatCard label="Last Update" value={lastRefresh} sub="auto-refresh 5s" />
          </div>

          {/* ── Strike pills ───────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
            {stratType === "straddle" ? (
              <>
                <div style={{ ...pillStyle("#22c55e"), }}>
                  CE {fmt(snap.straddle.callStrike)} @ ₹{fmt(snap.straddle.callPremium)}
                </div>
                <div style={pillStyle("#ef4444")}>
                  PE {fmt(snap.straddle.putStrike)} @ ₹{fmt(snap.straddle.putPremium)}
                </div>
              </>
            ) : (
              <>
                <div style={pillStyle("#22c55e")}>
                  CE {fmt(snap.strangle.callStrike)} @ ₹{fmt(snap.strangle.callPremium)}
                </div>
                <div style={pillStyle("#ef4444")}>
                  PE {fmt(snap.strangle.putStrike)} @ ₹{fmt(snap.strangle.putPremium)}
                </div>
              </>
            )}
            <div style={pillStyle(COLOR.accent)}>
              OI CE: {fmt(snap.oi?.ce, 0)}
            </div>
            <div style={pillStyle(COLOR.strangle)}>
              OI PE: {fmt(snap.oi?.pe, 0)}
            </div>
          </div>

          {/* ── Greeks ─────────────────────────────────────────────────── */}
          <GreeksRow greeks={snap.greeks} />

          {/* ── Two charts side by side ────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>

            {/* Live Premium Chart */}
            <div className="card">
              <div className="section-title">Live Combined Premium — {symbol}</div>
              {premHistory.length < 2 ? (
                <div style={{ color: COLOR.muted, fontSize: 13, padding: "20px 0" }}>
                  Collecting data… (refreshes every 5s)
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={premHistory} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="gStraddle" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={COLOR.straddle} stopOpacity={0.25} />
                        <stop offset="95%" stopColor={COLOR.straddle} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gStrangle" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={COLOR.strangle} stopOpacity={0.2} />
                        <stop offset="95%" stopColor={COLOR.strangle} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" />
                    <XAxis dataKey="time" tick={{ fill: COLOR.muted, fontSize: 10 }}
                      interval="preserveStartEnd" />
                    <YAxis tick={{ fill: COLOR.muted, fontSize: 10 }} width={55} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="straddle" name="Straddle"
                      stroke={COLOR.straddle} fill="url(#gStraddle)" strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="strangle" name="Strangle"
                      stroke={COLOR.strangle} fill="url(#gStrangle)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Payoff Chart */}
            <div className="card">
              <div className="section-title">
                Payoff at Expiry — {side === "buy" ? "Long" : "Short"}{" "}
                {stratType.charAt(0).toUpperCase() + stratType.slice(1)}
              </div>
              {!payoff ? (
                <div style={{ color: COLOR.muted, fontSize: 13, padding: "20px 0" }}>Loading payoff…</div>
              ) : (
                <>
                  {/* Breakeven badges */}
                  <div style={{ display: "flex", gap: 8, marginBottom: 10, fontSize: 12 }}>
                    <span style={{ background: "rgba(34,197,94,.12)", color: COLOR.green,
                      borderRadius: 6, padding: "3px 10px", border: `1px solid rgba(34,197,94,.25)` }}>
                      Upper BE: ₹{fmt(payoff.upperBreakeven)}
                    </span>
                    <span style={{ background: "rgba(239,68,68,.12)", color: COLOR.red,
                      borderRadius: 6, padding: "3px 10px", border: `1px solid rgba(239,68,68,.25)` }}>
                      Lower BE: ₹{fmt(payoff.lowerBreakeven)}
                    </span>
                    {payoff.maxProfit != null && (
                      <span style={{ background: "rgba(34,197,94,.12)", color: COLOR.green,
                        borderRadius: 6, padding: "3px 10px", border: `1px solid rgba(34,197,94,.25)` }}>
                        Max Profit: ₹{fmt(payoff.maxProfit)}
                      </span>
                    )}
                    {payoff.maxLoss != null && (
                      <span style={{ background: "rgba(239,68,68,.12)", color: COLOR.red,
                        borderRadius: 6, padding: "3px 10px", border: `1px solid rgba(239,68,68,.25)` }}>
                        Max Loss: ₹{fmt(payoff.maxLoss)}
                      </span>
                    )}
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={payoff.points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="gPLPos" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={COLOR.green} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={COLOR.green} stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="gPLNeg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={COLOR.red} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={COLOR.red} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" />
                      <XAxis dataKey="price" tick={{ fill: COLOR.muted, fontSize: 10 }}
                        tickFormatter={(v) => `₹${(v / 1000).toFixed(1)}k`} />
                      <YAxis tick={{ fill: COLOR.muted, fontSize: 10 }} width={60}
                        tickFormatter={(v) => `₹${v}`} />
                      <Tooltip content={<PayoffTooltip />} />
                      <ReferenceLine y={0} stroke={COLOR.breakeven} strokeDasharray="4 4" />
                      <ReferenceLine x={snap.spotPrice}
                        stroke={COLOR.spot} strokeDasharray="3 3"
                        label={{ value: "Spot", fill: COLOR.muted, fontSize: 10 }} />
                      <ReferenceLine x={payoff.upperBreakeven}
                        stroke={COLOR.green} strokeDasharray="3 3"
                        label={{ value: "UBE", fill: COLOR.green, fontSize: 10 }} />
                      <ReferenceLine x={payoff.lowerBreakeven}
                        stroke={COLOR.red} strokeDasharray="3 3"
                        label={{ value: "LBE", fill: COLOR.red, fontSize: 10 }} />
                      <Area
                        type="monotone" dataKey="pl" name="P&L"
                        stroke={side === "sell" ? COLOR.green : COLOR.buy}
                        fill={side === "sell" ? "url(#gPLPos)" : "url(#gPLNeg)"}
                        strokeWidth={2.5} dot={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </>
              )}
            </div>
          </div>

          {/* ── IV + OI info bar ───────────────────────────────────────── */}
          <div className="card" style={{ marginTop: 16 }}>
            <div className="section-title">Implied Volatility &amp; Open Interest</div>
            <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, color: COLOR.muted }}>CE IV</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: COLOR.straddle, fontFamily: "monospace" }}>
                  {fmtPct(snap.iv?.ce)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: COLOR.muted }}>PE IV</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: COLOR.strangle, fontFamily: "monospace" }}>
                  {fmtPct(snap.iv?.pe)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: COLOR.muted }}>ATM IV</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: COLOR.accent, fontFamily: "monospace" }}>
                  {fmtPct(snap.iv?.atm)}
                </div>
              </div>
              <div style={{ width: 1, background: COLOR.border }} />
              <div>
                <div style={{ fontSize: 12, color: COLOR.muted }}>CE OI</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#22c55e", fontFamily: "monospace" }}>
                  {fmt(snap.oi?.ce, 0)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: COLOR.muted }}>PE OI</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#ef4444", fontFamily: "monospace" }}>
                  {fmt(snap.oi?.pe, 0)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: COLOR.muted }}>PCR</div>
                <div style={{ fontSize: 20, fontWeight: 700,
                  color: +snap.oi?.pcr > 1 ? "#22c55e" : "#ef4444", fontFamily: "monospace" }}>
                  {snap.oi?.pcr ?? "—"}
                </div>
                <div style={{ fontSize: 11, color: COLOR.muted }}>
                  {+snap.oi?.pcr > 1.2 ? "Bullish bias" : +snap.oi?.pcr < 0.8 ? "Bearish bias" : "Neutral"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: COLOR.muted }}>Straddle Width</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: COLOR.text, fontFamily: "monospace" }}>
                  ₹{fmt(snap.straddle.upperBreakeven - snap.straddle.lowerBreakeven)}
                </div>
                <div style={{ fontSize: 11, color: COLOR.muted }}>expected range</div>
              </div>
            </div>
          </div>

          {/* ── Buyer vs Seller guide ──────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
            <div className="card" style={{ borderColor: "rgba(0,229,160,.2)" }}>
              <div style={{ color: COLOR.buy, fontWeight: 700, marginBottom: 10, fontSize: 14 }}>
                🟢 Option Buyer View (Long {stratType})
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: COLOR.text, lineHeight: 1.9 }}>
                <li>Pay premium: <strong>₹{fmt(activeStrat?.combined)}</strong></li>
                <li>Profit if spot moves beyond breakevens</li>
                <li>Upper target: <strong>₹{fmt(activeStrat?.upperBreakeven)}</strong></li>
                <li>Lower target: <strong>₹{fmt(activeStrat?.lowerBreakeven)}</strong></li>
                <li>Max loss limited to premium paid</li>
                <li>Best entry: before high-impact events (budget, RBI)</li>
                <li style={{ color: COLOR.muted }}>
                  {+snap.iv?.atm > 20
                    ? "⚠ High IV — premium expensive, buyer caution"
                    : "✅ Low IV — good time to buy straddle"}
                </li>
              </ul>
            </div>
            <div className="card" style={{ borderColor: "rgba(255,77,109,.2)" }}>
              <div style={{ color: COLOR.sell, fontWeight: 700, marginBottom: 10, fontSize: 14 }}>
                🔴 Option Seller View (Short {stratType})
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: COLOR.text, lineHeight: 1.9 }}>
                <li>Collect premium: <strong>₹{fmt(activeStrat?.combined)}</strong></li>
                <li>Profit if spot stays between breakevens</li>
                <li>Range: ₹{fmt(activeStrat?.lowerBreakeven)} – ₹{fmt(activeStrat?.upperBreakeven)}</li>
                <li>Theta works in your favor (time decay)</li>
                <li>Unlimited risk if spot breaks out sharply</li>
                <li>Best entry: sideways/range-bound market</li>
                <li style={{ color: COLOR.muted }}>
                  {+snap.iv?.atm > 20
                    ? "✅ High IV — premium rich, good time to sell"
                    : "⚠ Low IV — less premium to collect, seller caution"}
                </li>
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const pillStyle = (color) => ({
  background: `${color}18`,
  border: `1px solid ${color}40`,
  color: color,
  borderRadius: 8,
  padding: "5px 12px",
  fontSize: 12,
  fontWeight: 600,
  fontFamily: "monospace",
});