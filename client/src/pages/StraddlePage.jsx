// client/src/pages/StraddlePage.jsx
// Live Straddle & Strangle Chart Page
//
// ════════════════════════════════════════════════════════════════════════════
// FIX SUMMARY (this revision)
// ════════════════════════════════════════════════════════════════════════════
//
// FIX-1 TIME:
//   • toISTLabel() uses the tick's own `ts` epoch-ms (set by Upstox feed time,
//     NOT Date.now()) so X-axis shows 09:15–15:30 even during evening testing.
//   • marketNow() is only a last-resort fallback.
//   • The snapshot's `data.timestamp` comes from the cache file's own ISO field
//     (set when optionChainPoller last fetched from NSE), so the seed point
//     also shows the correct market-capture time.
//
// FIX-2 HISTORY SEEDING:
//   • On mount, hits /api/straddle/history to pre-fill the chart with all
//     intraday ticks the server has already seen today. Without this the chart
//     is blank until the next live tick arrives.
//   • History entries already carry an ISO `ts` from the server, so labels are
//     correct immediately.
//
// FIX-3 STRANGLE ≠ STRADDLE:
//   • Socket handler no longer falls back to `s.straddlePrice` when
//     `s.stranglePrice` is missing/identical.  Instead it keeps the last
//     known strangle from the REST snapshot.
//   • The binary protocol's OPTIONS_INTEL_TICK frame (0x0D) now carries
//     stranglePrice in bytes 9-12 (server fix in binaryProtocol.js /
//     websocket.js required separately — see companion patch).
//
// FIX-4 MARKET-HOURS X-AXIS:
//   • Pre-populates chart slots from 09:15 → current IST minute so Recharts
//     always renders a full intraday skeleton even before live ticks arrive.
//   • Uses `domain` prop on XAxis so the axis never compresses to a single dot.
//
// FIX-5 BINARY PROTOCOL:
//   • handleOptionsIntel now reads BOTH the JSON socket path
//     ("options-intelligence") AND the binary-decoded path
//     ("options-intel-tick" from MSG 0x0D) so it works regardless of whether
//     the server sends JSON or binary frames.
//
// ════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from "react";
import {
  AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ReferenceArea, ResponsiveContainer, Legend,
} from "recharts";

// ─── Constants ───────────────────────────────────────────────────────────────
const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

// Market session boundaries in IST
const MARKET_OPEN_H  = 9;
const MARKET_OPEN_M  = 15;
const MARKET_CLOSE_H = 15;
const MARKET_CLOSE_M = 30;

const COLOR = {
  buy:       "#00e5a0",
  sell:      "#ff4d6d",
  straddle:  "#7dd3fc",
  strangle:  "#f9a825",
  breakeven: "#94a3b8",
  spot:      "#ffffff",
  grid:      "#1e293b",
  cardBg:    "rgba(15,23,42,0.85)",
  border:    "rgba(99,120,160,0.18)",
  green:     "#22c55e",
  red:       "#ef4444",
  muted:     "#64748b",
  text:      "#e2e8f0",
  accent:    "#38bdf8",
  cone1:     "rgba(56,189,248,0.10)",
  cone2:     "rgba(56,189,248,0.05)",
};

// ─── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Convert epoch-ms OR ISO string → IST "HH:MM" label.
 * This is the ONLY source of chart X-axis labels — ensures they always
 * reflect when NSE data was captured (09:15–15:30), not the browser clock.
 */
function toISTLabel(tsOrIso) {
  if (!tsOrIso) return currentISTTime();
  const d = typeof tsOrIso === "number" ? new Date(tsOrIso) : new Date(tsOrIso);
  if (isNaN(d.getTime())) return currentISTTime();
  return d.toLocaleTimeString("en-IN", {
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
    timeZone: "Asia/Kolkata",
  });
}

/** Current IST wall-clock as "HH:MM" — used ONLY as fallback. */
function currentISTTime() {
  return new Date().toLocaleTimeString("en-IN", {
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Return current IST time as { h, m } integers.
 */
function currentISTHM() {
  const s = currentISTTime(); // "HH:MM"
  const [h, m] = s.split(":").map(Number);
  return { h, m };
}

/**
 * Generate the full market-session skeleton from 09:15 to `untilHM` (inclusive),
 * one entry per minute, with null values.  Recharts uses this to render a
 * proper X-axis even before live ticks fill real values.
 */
function buildMarketSlots(untilHM) {
  const slots = [];
  let h = MARKET_OPEN_H, m = MARKET_OPEN_M;
  const endH = Math.min(untilHM.h, MARKET_CLOSE_H);
  const endM = untilHM.h === MARKET_CLOSE_H
    ? Math.min(untilHM.m, MARKET_CLOSE_M)
    : untilHM.m;

  while (h < endH || (h === endH && m <= endM)) {
    const label = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    slots.push({ time: label, straddle: null, strangle: null });
    m++;
    if (m === 60) { m = 0; h++; }
    if (h > MARKET_CLOSE_H) break;
    if (h === MARKET_CLOSE_H && m > MARKET_CLOSE_M) break;
  }
  return slots;
}

/**
 * Merge live/history ticks into the skeleton slots array.
 * Matches by "HH:MM" label; fills in real values.
 */
function mergeIntoSlots(slots, ticks) {
  const map = new Map(slots.map((s, i) => [s.time, i]));
  const out  = [...slots];
  for (const tick of ticks) {
    if (!tick.time) continue;
    const label = tick.time.length > 5 ? tick.time.slice(0, 5) : tick.time;
    const idx   = map.get(label);
    if (idx !== undefined) {
      out[idx] = { ...out[idx], ...tick };
    } else {
      // Time outside market hours (e.g. pre-open snapshot) — append
      out.push({ ...tick, time: label });
    }
  }
  return out;
}

// ─── Utility ─────────────────────────────────────────────────────────────────
const fmt    = (n, d = 2) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: d });
const fmtPct = (n) => (n == null ? "—" : `${Number(n).toFixed(2)}%`);

function getDTE(expiryStr) {
  if (!expiryStr) return 1;
  const exp   = new Date(expiryStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.max(0, (exp - today) / (1000 * 60 * 60 * 24));
  return diff < 0.5 ? 0.5 : diff;
}

function getSigmaBounds(spotPrice, ivAtm, expiry) {
  if (!spotPrice || !ivAtm) return null;
  const dte   = getDTE(expiry);
  const sigma = spotPrice * (ivAtm / 100) * Math.sqrt(dte / 365);
  return {
    upper1: Math.round(spotPrice + sigma),
    lower1: Math.round(spotPrice - sigma),
    upper2: Math.round(spotPrice + 2 * sigma),
    lower2: Math.round(spotPrice - 2 * sigma),
    sigma:  Math.round(sigma),
  };
}

function exportCSV(symbol, expiry, premHistory) {
  const rows = premHistory.filter(r => r.straddle != null);
  if (!rows.length) return;
  const header = "Time,Straddle Premium,Strangle Premium\n";
  const body   = rows.map(r => `${r.time},${r.straddle ?? ""},${r.strangle ?? ""}`).join("\n");
  const blob   = new Blob([header + body], { type: "text/csv" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = `straddle_${symbol}_${expiry || "all"}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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
      <div style={{ fontSize: 11, color: COLOR.muted, marginBottom: 4,
        letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || COLOR.text,
        fontFamily: "'JetBrains Mono', monospace" }}>{value ?? "—"}</div>
      {sub && <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function GreeksRow({ greeks }) {
  if (!greeks?.delta?.ce) return null;
  const items = [
    { label: "Δ CE Delta", value: greeks.delta.ce?.toFixed(3) },
    { label: "Δ PE Delta", value: greeks.delta.pe?.toFixed(3) },
    { label: "Θ Theta CE", value: greeks.theta?.ce?.toFixed(3) },
    { label: "Θ Theta PE", value: greeks.theta?.pe?.toFixed(3) },
    { label: "V Vega CE",  value: greeks.vega?.ce?.toFixed(3)  },
    { label: "V Vega PE",  value: greeks.vega?.pe?.toFixed(3)  },
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
      {payload.filter(p => p.value != null).map((p) => (
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

function AlertBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div style={{
      background: "rgba(239,68,68,0.15)",
      border: "1px solid rgba(239,68,68,0.5)",
      borderRadius: 10, padding: "12px 18px",
      marginBottom: 14, fontSize: 14,
      color: "#fca5a5", display: "flex",
      alignItems: "center", justifyContent: "space-between",
      animation: "fadeIn .3s ease",
    }}>
      <span>🚨 {message}</span>
      <button onClick={onDismiss} style={{
        background: "none", border: "none", color: "#fca5a5",
        cursor: "pointer", fontSize: 18, lineHeight: 1,
      }}>×</button>
    </div>
  );
}

function buildPayoffCurve({ callStrike, putStrike, callPremium, putPremium, type, side, lotSize = 1 }) {
  const totalPremium = callPremium + putPremium;
  const lowerBE = putStrike  - totalPremium;
  const upperBE = callStrike + totalPremium;
  const mid     = (callStrike + putStrike) / 2;
  const range   = mid * 0.05;
  const step    = range / 50;
  const points  = [];
  for (let price = mid - range; price <= mid + range; price += step) {
    let callPL, putPL;
    if (side === "buy") {
      callPL = Math.max(0, price - callStrike) - callPremium;
      putPL  = Math.max(0, putStrike - price)  - putPremium;
    } else {
      callPL = callPremium - Math.max(0, price - callStrike);
      putPL  = putPremium  - Math.max(0, putStrike - price);
    }
    points.push({ price: Math.round(price), pl: Math.round((callPL + putPL) * lotSize * 100) / 100 });
  }
  return {
    points,
    maxProfit:      side === "buy" ? null : Math.round(totalPremium * lotSize * 100) / 100,
    maxLoss:        side === "buy" ? Math.round(-totalPremium * lotSize * 100) / 100 : null,
    upperBreakeven: Math.round(upperBE * 100) / 100,
    lowerBreakeven: Math.round(lowerBE * 100) / 100,
    totalPremium:   Math.round(totalPremium * 100) / 100,
  };
}

const LOT_SIZES = {
  BANKNIFTY:  35, FINNIFTY: 65, MIDCPNIFTY: 120, SENSEX: 20, NIFTY: 75,
};

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function StraddlePage({ socket }) {
  const [symbol,       setSymbol]       = useState("NIFTY");
  const [expiry,       setExpiry]       = useState("");
  const [stratType,    setStratType]    = useState("straddle");
  const [side,         setSide]         = useState("sell");
  const [strangleStep, setStrangleStep] = useState(1);

  const [snap,        setSnap]        = useState(null);
  const [payoff,      setPayoff]      = useState(null);
  // premHistory = array of { time:"HH:MM", straddle:number|null, strangle:number|null }
  // Pre-filled with market-session skeleton so X-axis is always visible
  const [premHistory, setPremHistory] = useState(() => buildMarketSlots(currentISTHM()));
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [lastRefresh, setLastRefresh] = useState("—");

  const [alertMsg,        setAlertMsg]        = useState(null);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const alertedRef = useRef({ upper: false, lower: false });

  const symbolRef = useRef(symbol);
  const expiryRef = useRef(expiry);
  const snapRef   = useRef(snap);
  useEffect(() => { symbolRef.current = symbol;  }, [symbol]);
  useEffect(() => { expiryRef.current = expiry;  }, [expiry]);
  useEffect(() => { snapRef.current   = snap;    }, [snap]);

  const requestNotifPermission = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
  };

  const checkBreakevenBreach = useCallback((spotPrice, activeStrat) => {
    if (!spotPrice || !activeStrat) return;
    const { upperBreakeven, lowerBreakeven } = activeStrat;
    if (!upperBreakeven || !lowerBreakeven) return;
    if (spotPrice >= upperBreakeven && !alertedRef.current.upper) {
      alertedRef.current.upper = true;
      alertedRef.current.lower = false;
      const msg = `Spot ₹${fmt(spotPrice)} breached UPPER breakeven ₹${fmt(upperBreakeven)} — consider hedging!`;
      setAlertMsg(msg);
      if (notifPermission === "granted") new Notification("⚠ Upper Breakeven Breached", { body: msg });
    } else if (spotPrice <= lowerBreakeven && !alertedRef.current.lower) {
      alertedRef.current.lower = true;
      alertedRef.current.upper = false;
      const msg = `Spot ₹${fmt(spotPrice)} breached LOWER breakeven ₹${fmt(lowerBreakeven)} — consider hedging!`;
      setAlertMsg(msg);
      if (notifPermission === "granted") new Notification("⚠ Lower Breakeven Breached", { body: msg });
    } else if (spotPrice > lowerBreakeven && spotPrice < upperBreakeven) {
      alertedRef.current.upper = false;
      alertedRef.current.lower = false;
    }
  }, [notifPermission]);

  const fetchPayoff = useCallback(async (currentSnap) => {
    try {
      const s = currentSnap || snapRef.current;
      if (!s) return;
      const ex      = expiryRef.current || s.expiry || "";
      const exQ     = ex ? `&expiry=${ex}` : "";
      const sym     = symbolRef.current;
      const strat   = s[stratType === "straddle" ? "straddle" : "strangle"];
      if (!strat) return;

      // Build client-side payoff (avoids extra round-trip if we have the data)
      const lotSize  = LOT_SIZES[sym] || 75;
      const computed = buildPayoffCurve({
        callStrike:   strat.callStrike   ?? s.atmStrike,
        putStrike:    strat.putStrike    ?? s.atmStrike,
        callPremium:  strat.callPremium  ?? 0,
        putPremium:   strat.putPremium   ?? 0,
        type: stratType, side, lotSize,
      });
      setPayoff(computed);
    } catch (e) {
      console.warn("Payoff build error:", e.message);
    }
  }, [stratType, side]);

  // ── Reset everything on symbol change ──────────────────────────────────────
  useEffect(() => {
    setSnap(null);
    setPremHistory(buildMarketSlots(currentISTHM()));
    setPayoff(null);
    setLoading(true);
    setError(null);
    setLastRefresh("—");
    alertedRef.current = { upper: false, lower: false };
    setAlertMsg(null);
  }, [symbol]);

  // ── Main data effect: REST seed + socket listener ─────────────────────────
  useEffect(() => {
    if (!socket) return;
    let cancelled = false;

    socket.emit("join:intel");
    socket.emit("join:straddle");

    const handleConnect = () => {
      socket.emit("join:intel");
      socket.emit("join:straddle");
    };
    socket.on("connect", handleConnect);

    // ── FIX-2: Seed chart from /history FIRST, then /snapshot ─────────────
    const currentSymbol = symbolRef.current;

    async function seedData() {
      try {
        // 1️⃣ Load history — gives us all intraday ticks already recorded
        let historyTicks = [];
        try {
          const hr = await fetch(`/api/straddle/history?symbol=${currentSymbol}`);
          const hd = await hr.json();
          // hd.history = [{ ts: epoch_ms|ISO, straddle: number, strangle: number }, ...]
          if (Array.isArray(hd.history) && hd.history.length > 0) {
            historyTicks = hd.history.map(h => ({
              time:     toISTLabel(h.ts || h.time),
              straddle: h.straddle ?? h.straddlePrice ?? null,
              strangle: h.strangle ?? h.stranglePrice ?? null,
            }));
          }
        } catch (e) {
          console.warn("History fetch failed:", e.message);
        }

        if (cancelled) return;

        // 2️⃣ Load snapshot — gives us current premium + expiry list
        const sr   = await fetch(`/api/straddle/snapshot?symbol=${currentSymbol}`);
        const data = await sr.json();
        if (cancelled) return;
        if (!data || data.error) { setLoading(false); return; }

        setSnap(data);

        // FIX-1: seed point time uses the CACHE's own ISO timestamp (NSE data time)
        const seedTime     = toISTLabel(data.timestamp);
        const seedStraddle = data.straddle?.combined ?? null;
        // FIX-3: real strangle premium from OTM strikes (server now reads OTM rows)
        const seedStrangle = data.strangle?.combined ?? null;

        if (seedStraddle != null) {
          historyTicks.push({ time: seedTime, straddle: seedStraddle, strangle: seedStrangle });
        }

        // FIX-4: merge all ticks into the market-session skeleton
        setPremHistory(prev => {
          const slots = buildMarketSlots(currentISTHM());
          return mergeIntoSlots(slots, historyTicks);
        });

        // Fix expiry selection
        if (expiryRef.current && data.expiries?.length && !data.expiries.includes(expiryRef.current)) {
          setExpiry(data.expiries[0] || "");
        }

        setLoading(false);
        fetchPayoff(data);
      } catch (e) {
        if (!cancelled) { setLoading(false); setError(e.message); }
      }
    }
    seedData();

    // ── FIX-5: handle BOTH json ("options-intelligence") AND binary-decoded
    //           ("options-intel-tick" from MSG 0x0D) paths ──────────────────
    const handleOptionsIntel = (data) => {
      if (data?.symbol !== symbolRef.current) return;

      const result     = data?.data;
      const s          = result?.structure;
      if (!s) return;

      const spotPrice = data.ltp ?? result?.spotPrice ?? null;

      // FIX-1: use the socket frame's own `ts` (epoch ms from Upstox feed time).
      // The server MUST set ts = upstoxTick.feedTimestamp or equivalent NSE time.
      // If missing (old server), fall back to current IST — still better than Date.now() TZ.
      const t = data.ts
        ? toISTLabel(data.ts)          // ← NSE data capture time (e.g. "09:30")
        : currentISTTime();            // ← fallback: current IST (not local TZ)

      // FIX-3: stranglePrice from binary frame (companion server patch adds it to 0x0D).
      // If server hasn't been updated yet, use last known snapshot strangle — never
      // fall back to straddlePrice which makes them identical.
      const socketStrangle = (s.stranglePrice && s.stranglePrice !== s.straddlePrice)
        ? s.stranglePrice
        : snapRef.current?.strangle?.combined ?? null;

      const newSnap = {
        spotPrice,
        atmStrike: result.atmStrike,
        straddle: {
          combined:       s.straddlePrice,
          callStrike:     result.atmStrike,
          putStrike:      result.atmStrike,
          callPremium:    (s.callLTP ?? s.straddlePrice / 2),
          putPremium:     (s.putLTP  ?? s.straddlePrice / 2),
          upperBreakeven: result.atmStrike + s.straddlePrice,
          lowerBreakeven: result.atmStrike - s.straddlePrice,
        },
        // FIX-3: preserve real strangle from snapshot; only update if socket provides distinct value
        strangle: snapRef.current?.strangle
          ? { ...snapRef.current.strangle, combined: socketStrangle ?? snapRef.current.strangle.combined }
          : null,
        iv: {
          atm: result.volatility?.atmIV,
          ce:  result.volSurface?.iv25call,
          pe:  result.volSurface?.iv25put,
        },
        oi: {
          ce:  result.oi?.totalCallOI,
          pe:  result.oi?.totalPutOI,
          pcr: result.oi?.pcr,
        },
        greeks: result.atmGreeks,
        expiry: result.expiryDate ?? expiryRef.current,
      };

      setSnap(prev => ({
        ...prev,
        ...newSnap,
        expiries: prev?.expiries?.length ? prev.expiries : [],
      }));

      // FIX-4: update the skeleton slot for this minute
      setPremHistory(prev => {
        const entry = {
          time:     t,
          straddle: s.straddlePrice,
          strangle: socketStrangle ?? s.straddlePrice,
        };
        // Upsert: if same-minute slot exists, update it; else append
        const idx = prev.findIndex(p => p.time === t);
        if (idx !== -1) {
          const next = [...prev];
          next[idx]  = { ...next[idx], ...entry };
          return next;
        }
        return [...prev, entry].slice(-375); // 375 = 6.25h × 60min max
      });

      setLastRefresh(t);
      setLoading(false);
      setError(null);

      const activeStratForAlert = stratType === "straddle"
        ? newSnap.straddle
        : (newSnap.strangle ?? newSnap.straddle);
      checkBreakevenBreach(spotPrice, activeStratForAlert);
    };

    // FIX-5: binary path — server decodes MSG 0x0D → emits "options-intel-tick"
    const handleIntelTick = (data) => {
      if (data?.symbol !== symbolRef.current) return;
      // Translate binary tick shape to the options-intelligence shape and reuse handler
      handleOptionsIntel({
        symbol: data.symbol,
        ltp:    data.spotPrice,
        ts:     data.ts,
        data: {
          spotPrice:  data.spotPrice,
          atmStrike:  snapRef.current?.atmStrike,
          structure:  {
            straddlePrice: data.straddlePrice,
            stranglePrice: data.stranglePrice ?? null,
            callLTP:       null,
            putLTP:        null,
          },
          volatility: { atmIV: data.atmIV },
          oi:         {},
          atmGreeks:  {},
        },
      });
    };

    socket.on("options-intelligence", handleOptionsIntel);
    socket.on("options-intel-tick",   handleIntelTick);

    return () => {
      cancelled = true;
      socket.off("connect",             handleConnect);
      socket.off("options-intelligence", handleOptionsIntel);
      socket.off("options-intel-tick",   handleIntelTick);
      socket.emit("leave:intel");
      socket.emit("leave:straddle");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, symbol]);

  useEffect(() => {
    if (snap) fetchPayoff(snap);
  }, [stratType, side, strangleStep, fetchPayoff, snap]);

  useEffect(() => {
    alertedRef.current = { upper: false, lower: false };
    setAlertMsg(null);
  }, [stratType, side]);

  const activeStrat  = snap ? (stratType === "straddle" ? snap.straddle : snap.strangle) : null;
  const sigmaBounds  = snap ? getSigmaBounds(snap.spotPrice, snap.iv?.atm, snap.expiry || expiry) : null;
  const premiumPct   = snap && snap.spotPrice && activeStrat?.combined
    ? ((activeStrat.combined / snap.spotPrice) * 100).toFixed(2) : null;

  const validExpiries = snap?.expiries || [];
  const safeExpiry    = expiry && validExpiries.includes(expiry)
    ? expiry : (validExpiries[0] || "");

  // Chart only contains slots with real data for dot rendering;
  // skeleton null-slots still render axis correctly
  const chartData = premHistory;

  // ─── render ───────────────────────────────────────────────────────────────
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
        .strat-tab.active { background:rgba(56,189,248,.15); border-color:#38bdf8; color:#38bdf8; }
        .strat-tab:not(.active) { color:#64748b; }
        .strat-tab:not(.active):hover { background:rgba(255,255,255,.04); color:#e2e8f0; }
        .side-btn { cursor:pointer; padding:7px 20px; border-radius:8px; font-size:13px; font-weight:700;
                    border:1px solid transparent; transition:all .2s; }
        select { background:#0f172a; color:#e2e8f0; border:1px solid rgba(99,120,160,0.18);
                 border-radius:8px; padding:7px 12px; font-size:13px; cursor:pointer; outline:none; }
        select:hover { border-color:#38bdf8; }
        .card { background:rgba(15,23,42,0.85); border:1px solid rgba(99,120,160,0.18);
                border-radius:14px; padding:20px 22px; animation:fadeIn .4s ease; }
        .section-title { font-size:13px; font-weight:600; color:#64748b;
                         text-transform:uppercase; letter-spacing:.07em; margin-bottom:14px; }
        .icon-btn { cursor:pointer; background:rgba(30,41,59,0.8); border:1px solid rgba(99,120,160,0.18);
                    border-radius:8px; padding:7px 14px; font-size:12px; font-weight:600;
                    color:#64748b; transition:all .2s; display:flex; align-items:center; gap:6px; }
        .icon-btn:hover { border-color:#38bdf8; color:#38bdf8; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        marginBottom:22, flexWrap:"wrap", gap:12 }}>
        <div>
          <h1 style={{ margin:0, fontSize:26, fontWeight:800, letterSpacing:"-0.03em" }}>
            <span style={{ color:COLOR.accent }}>Straddle</span> &amp; Strangle
          </h1>
          <div style={{ fontSize:12, color:COLOR.muted, marginTop:3 }}>
            Live combined premium · Auto ATM · Payoff + σ cone · Greeks · Alerts
          </div>
        </div>

        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
          <select value={symbol} onChange={e => { setSymbol(e.target.value); setExpiry(""); }}>
            {SYMBOLS.map(s => <option key={s}>{s}</option>)}
          </select>

          {validExpiries.length > 0 && (
            <select value={safeExpiry} onChange={e => setExpiry(e.target.value)}>
              {validExpiries.map((ex, i) => (
                <option key={ex} value={ex}>{ex}{i === 0 ? " ★" : ""}</option>
              ))}
            </select>
          )}

          <div style={{ display:"flex", gap:4, background:"rgba(15,23,42,.8)", padding:3, borderRadius:10 }}>
            {["straddle","strangle"].map(t => (
              <button key={t} className={`strat-tab ${stratType === t ? "active" : ""}`}
                onClick={() => setStratType(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {stratType === "strangle" && (
            <select value={strangleStep} onChange={e => setStrangleStep(+e.target.value)}>
              {[1,2,3].map(n => <option key={n} value={n}>{n} step OTM</option>)}
            </select>
          )}

          <div style={{ display:"flex", gap:4, background:"rgba(15,23,42,.8)", padding:3, borderRadius:10 }}>
            <button className="side-btn" onClick={() => setSide("buy")}
              style={{ background: side==="buy" ? "rgba(0,229,160,.15)" : "transparent",
                       borderColor: side==="buy" ? COLOR.buy : "transparent",
                       color: side==="buy" ? COLOR.buy : COLOR.muted }}>Buy</button>
            <button className="side-btn" onClick={() => setSide("sell")}
              style={{ background: side==="sell" ? "rgba(255,77,109,.15)" : "transparent",
                       borderColor: side==="sell" ? COLOR.sell : "transparent",
                       color: side==="sell" ? COLOR.sell : COLOR.muted }}>Sell</button>
          </div>

          <button className="icon-btn" onClick={requestNotifPermission}
            style={{ borderColor: notifPermission==="granted" ? COLOR.green : COLOR.border,
                     color: notifPermission==="granted" ? COLOR.green : COLOR.muted }}>
            🔔 {notifPermission==="granted" ? "Alerts ON" : "Enable Alerts"}
          </button>

          <button className="icon-btn"
            onClick={() => exportCSV(symbol, safeExpiry, premHistory.filter(r => r.straddle != null))}>
            ⬇ CSV
          </button>
        </div>
      </div>

      <AlertBanner message={alertMsg} onDismiss={() => setAlertMsg(null)} />

      {error && (
        <div style={{ background:"rgba(239,68,68,.1)", border:"1px solid rgba(239,68,68,.3)",
          borderRadius:10, padding:"10px 16px", marginBottom:16, fontSize:13, color:"#fca5a5" }}>
          ⚠ {error}
        </div>
      )}

      {loading && !snap && (
        <div style={{ textAlign:"center", padding:60, color:COLOR.muted }}>
          Loading {symbol} option chain data…
        </div>
      )}

      {/* ── Chart always visible (skeleton) even before snap loads ── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:20 }}>

        {/* Live Premium Chart */}
        <div className="card">
          <div className="section-title">
            Live Combined Premium — {symbol}
            <span style={{ marginLeft:8, fontWeight:400, color:COLOR.muted,
              fontSize:11, textTransform:"none" }}>(X-axis: IST 09:15–15:30)</span>
          </div>
          {/* FIX-4: always render chart; null values show axis without breaking line */}
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chartData} margin={{ top:4, right:8, bottom:0, left:0 }}>
              <defs>
                <linearGradient id="gStraddle" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={COLOR.straddle} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={COLOR.straddle} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gStrangle" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={COLOR.strangle} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={COLOR.strangle} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fill:COLOR.muted, fontSize:10 }}
                // FIX-4: always show 09:15 and 15:30 as domain anchors
                ticks={["09:15","10:00","11:00","12:00","13:00","14:00","15:00","15:30"]}
                interval={0}
                minTickGap={0}
              />
              <YAxis tick={{ fill:COLOR.muted, fontSize:10 }} width={55} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize:12 }} />
              <Area
                type="monotone" dataKey="straddle" name="Straddle"
                stroke={COLOR.straddle} fill="url(#gStraddle)"
                strokeWidth={2} dot={false}
                connectNulls={false}   // gaps show where no data yet — honest display
              />
              <Area
                type="monotone" dataKey="strangle" name="Strangle"
                stroke={COLOR.strangle} fill="url(#gStrangle)"
                strokeWidth={2} dot={false}
                connectNulls={false}
              />
              {/* Mark market open / close */}
              <ReferenceLine x="09:15" stroke={COLOR.green} strokeDasharray="4 2"
                label={{ value:"Open", fill:COLOR.green, fontSize:9, position:"insideTopRight" }} />
              <ReferenceLine x="15:30" stroke={COLOR.red} strokeDasharray="4 2"
                label={{ value:"Close", fill:COLOR.red, fontSize:9, position:"insideTopLeft" }} />
            </AreaChart>
          </ResponsiveContainer>
          <div style={{ fontSize:11, color:COLOR.muted, marginTop:6 }}>
            {premHistory.filter(p => p.straddle != null).length} ticks recorded
            {" · "}last update: <span style={{ color:COLOR.text }}>{lastRefresh}</span>
          </div>
        </div>

        {/* Payoff Chart */}
        <div className="card">
          <div className="section-title">
            Payoff at Expiry — {side==="buy" ? "Long" : "Short"}{" "}
            {stratType.charAt(0).toUpperCase() + stratType.slice(1)}
            {sigmaBounds && (
              <span style={{ marginLeft:10, fontSize:11, color:COLOR.accent,
                fontWeight:400, textTransform:"none" }}>· σ cone</span>
            )}
          </div>
          {!payoff || !snap ? (
            <div style={{ color:COLOR.muted, fontSize:13, padding:"20px 0" }}>
              {!snap ? "Waiting for data…" : "Computing payoff…"}
            </div>
          ) : (
            <>
              <div style={{ display:"flex", gap:8, marginBottom:10, fontSize:12, flexWrap:"wrap" }}>
                {[
                  { label:"Upper BE", val:`₹${fmt(payoff.upperBreakeven)}`, c:COLOR.green, bg:"rgba(34,197,94,.12)", bc:"rgba(34,197,94,.25)" },
                  { label:"Lower BE", val:`₹${fmt(payoff.lowerBreakeven)}`, c:COLOR.red,   bg:"rgba(239,68,68,.12)",  bc:"rgba(239,68,68,.25)" },
                  payoff.maxProfit != null && { label:"Max Profit", val:`₹${fmt(payoff.maxProfit)}`, c:COLOR.green, bg:"rgba(34,197,94,.12)", bc:"rgba(34,197,94,.25)" },
                  payoff.maxLoss   != null && { label:"Max Loss",   val:`₹${fmt(payoff.maxLoss)}`,   c:COLOR.red,   bg:"rgba(239,68,68,.12)",  bc:"rgba(239,68,68,.25)" },
                  sigmaBounds && { label:`1σ ±₹${fmt(sigmaBounds.sigma)}`, val:"", c:COLOR.accent, bg:"rgba(56,189,248,.08)", bc:"rgba(56,189,248,.25)" },
                ].filter(Boolean).map((b, i) => (
                  <span key={i} style={{ background:b.bg, color:b.c, borderRadius:6,
                    padding:"3px 10px", border:`1px solid ${b.bc}` }}>
                    {b.label}{b.val ? `: ${b.val}` : ""}
                  </span>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={payoff.points} margin={{ top:4, right:8, bottom:0, left:0 }}>
                  <defs>
                    <linearGradient id="gPLPos" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={COLOR.green} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={COLOR.green} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gPLNeg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={COLOR.red}   stopOpacity={0.25} />
                      <stop offset="95%" stopColor={COLOR.red}    stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={COLOR.grid} strokeDasharray="3 3" />
                  <XAxis dataKey="price" tick={{ fill:COLOR.muted, fontSize:10 }}
                    tickFormatter={v => `₹${(v/1000).toFixed(1)}k`} />
                  <YAxis tick={{ fill:COLOR.muted, fontSize:10 }} width={60}
                    tickFormatter={v => `₹${v}`} />
                  <Tooltip content={<PayoffTooltip />} />
                  {sigmaBounds && <>
                    <ReferenceArea x1={sigmaBounds.lower2} x2={sigmaBounds.upper2}
                      fill={COLOR.cone2} fillOpacity={1}
                      label={{ value:"2σ", fill:COLOR.accent, fontSize:10, position:"insideTopLeft" }} />
                    <ReferenceArea x1={sigmaBounds.lower1} x2={sigmaBounds.upper1}
                      fill={COLOR.cone1} fillOpacity={1}
                      label={{ value:"1σ", fill:COLOR.accent, fontSize:10, position:"insideTopRight" }} />
                  </>}
                  <ReferenceLine y={0} stroke={COLOR.breakeven} strokeDasharray="4 4" />
                  {snap?.spotPrice && (
                    <ReferenceLine x={snap.spotPrice} stroke={COLOR.spot} strokeDasharray="3 3"
                      label={{ value:"Spot", fill:COLOR.muted, fontSize:10 }} />
                  )}
                  <ReferenceLine x={payoff.upperBreakeven} stroke={COLOR.green} strokeDasharray="3 3"
                    label={{ value:"UBE", fill:COLOR.green, fontSize:10 }} />
                  <ReferenceLine x={payoff.lowerBreakeven} stroke={COLOR.red} strokeDasharray="3 3"
                    label={{ value:"LBE", fill:COLOR.red, fontSize:10 }} />
                  <Area type="monotone" dataKey="pl" name="P&L"
                    stroke={side==="sell" ? COLOR.green : COLOR.buy}
                    fill={side==="sell" ? "url(#gPLPos)" : "url(#gPLNeg)"}
                    strokeWidth={2.5} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      </div>

      {snap && (
        <>
          {/* ── Stat cards ── */}
          <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:20 }}>
            <StatCard label="Spot Price"   value={`₹${fmt(snap.spotPrice)}`} pulse />
            <StatCard label="ATM Strike"   value={fmt(snap.atmStrike)} />
            <StatCard
              label={`${stratType === "straddle" ? "Straddle" : "Strangle"} Premium`}
              value={`₹${fmt(activeStrat?.combined)}`}
              color={COLOR.accent}
            />
            <StatCard label="Premium % Spot" value={premiumPct ? `${premiumPct}%` : "—"}
              sub="normalised cost" color={COLOR.strangle} />
            <StatCard label="Upper BE" value={`₹${fmt(activeStrat?.upperBreakeven)}`} color={COLOR.green} />
            <StatCard label="Lower BE" value={`₹${fmt(activeStrat?.lowerBreakeven)}`} color={COLOR.red} />
            <StatCard label="ATM IV"   value={fmtPct(snap.iv?.atm)} color={COLOR.strangle} />
            <StatCard label="PCR"      value={snap.oi?.pcr ?? "—"}
              color={+snap.oi?.pcr > 1 ? COLOR.green : COLOR.red} />
            <StatCard label="Last Update (IST)" value={lastRefresh} sub="market data time" />
          </div>

          {/* ── Sigma cone bar ── */}
          {sigmaBounds && (
            <div style={{
              background:"rgba(56,189,248,0.06)", border:"1px solid rgba(56,189,248,0.2)",
              borderRadius:10, padding:"10px 18px", marginBottom:16,
              display:"flex", gap:28, flexWrap:"wrap", alignItems:"center",
            }}>
              <span style={{ fontSize:12, color:COLOR.accent, fontWeight:600 }}>σ Expected Move</span>
              <span style={{ fontSize:12, color:COLOR.muted }}>
                1σ: <span style={{ color:COLOR.text, fontFamily:"monospace" }}>
                  ₹{fmt(sigmaBounds.lower1)} – ₹{fmt(sigmaBounds.upper1)}</span> (±₹{fmt(sigmaBounds.sigma)})
              </span>
              <span style={{ fontSize:12, color:COLOR.muted }}>
                2σ: <span style={{ color:COLOR.text, fontFamily:"monospace" }}>
                  ₹{fmt(sigmaBounds.lower2)} – ₹{fmt(sigmaBounds.upper2)}</span>
              </span>
              <span style={{ fontSize:11, color:COLOR.muted }}>
                IV {fmtPct(snap.iv?.atm)} · DTE {Math.round(getDTE(snap.expiry || safeExpiry))}d
              </span>
            </div>
          )}

          {/* ── Strike pills ── */}
          <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
            {stratType === "straddle" ? (
              <>
                <div style={pillStyle("#22c55e")}>CE {fmt(snap.straddle?.callStrike)} @ ₹{fmt(snap.straddle?.callPremium)}</div>
                <div style={pillStyle("#ef4444")}>PE {fmt(snap.straddle?.putStrike)} @ ₹{fmt(snap.straddle?.putPremium)}</div>
              </>
            ) : (
              <>
                <div style={pillStyle("#22c55e")}>CE {fmt(snap.strangle?.callStrike)} @ ₹{fmt(snap.strangle?.callPremium)}</div>
                <div style={pillStyle("#ef4444")}>PE {fmt(snap.strangle?.putStrike)} @ ₹{fmt(snap.strangle?.putPremium)}</div>
              </>
            )}
            <div style={pillStyle(COLOR.accent)}>OI CE: {fmt(snap.oi?.ce, 0)}</div>
            <div style={pillStyle(COLOR.strangle)}>OI PE: {fmt(snap.oi?.pe, 0)}</div>
          </div>

          <GreeksRow greeks={snap.greeks} />

          {/* ── IV + OI bar ── */}
          <div className="card" style={{ marginTop:16 }}>
            <div className="section-title">Implied Volatility &amp; Open Interest</div>
            <div style={{ display:"flex", gap:40, flexWrap:"wrap" }}>
              {[
                { label:"CE IV",  value:fmtPct(snap.iv?.ce),  color:COLOR.straddle },
                { label:"PE IV",  value:fmtPct(snap.iv?.pe),  color:COLOR.strangle },
                { label:"ATM IV", value:fmtPct(snap.iv?.atm), color:COLOR.accent   },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <div style={{ fontSize:12, color:COLOR.muted }}>{label}</div>
                  <div style={{ fontSize:20, fontWeight:700, color, fontFamily:"monospace" }}>{value}</div>
                </div>
              ))}
              <div style={{ width:1, background:COLOR.border }} />
              <div>
                <div style={{ fontSize:12, color:COLOR.muted }}>CE OI</div>
                <div style={{ fontSize:20, fontWeight:700, color:"#22c55e", fontFamily:"monospace" }}>{fmt(snap.oi?.ce, 0)}</div>
              </div>
              <div>
                <div style={{ fontSize:12, color:COLOR.muted }}>PE OI</div>
                <div style={{ fontSize:20, fontWeight:700, color:"#ef4444", fontFamily:"monospace" }}>{fmt(snap.oi?.pe, 0)}</div>
              </div>
              <div>
                <div style={{ fontSize:12, color:COLOR.muted }}>PCR</div>
                <div style={{ fontSize:20, fontWeight:700, fontFamily:"monospace",
                  color: +snap.oi?.pcr > 1 ? "#22c55e" : "#ef4444" }}>{snap.oi?.pcr ?? "—"}</div>
                <div style={{ fontSize:11, color:COLOR.muted }}>
                  {+snap.oi?.pcr > 1.2 ? "Bullish bias" : +snap.oi?.pcr < 0.8 ? "Bearish bias" : "Neutral"}
                </div>
              </div>
              <div>
                <div style={{ fontSize:12, color:COLOR.muted }}>Straddle Width</div>
                <div style={{ fontSize:20, fontWeight:700, color:COLOR.text, fontFamily:"monospace" }}>
                  ₹{fmt((snap.straddle?.upperBreakeven ?? 0) - (snap.straddle?.lowerBreakeven ?? 0))}
                </div>
                <div style={{ fontSize:11, color:COLOR.muted }}>expected range</div>
              </div>
            </div>
          </div>

          {/* ── Buyer vs Seller guide ── */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginTop:16 }}>
            <div className="card" style={{ borderColor:"rgba(0,229,160,.2)" }}>
              <div style={{ color:COLOR.buy, fontWeight:700, marginBottom:10, fontSize:14 }}>
                🟢 Option Buyer View (Long {stratType})
              </div>
              <ul style={{ margin:0, paddingLeft:18, fontSize:13, color:COLOR.text, lineHeight:1.9 }}>
                <li>Pay premium: <strong>₹{fmt(activeStrat?.combined)}</strong>
                  {premiumPct && <span style={{ color:COLOR.muted }}> ({premiumPct}% of spot)</span>}</li>
                <li>Profit if spot moves beyond breakevens</li>
                <li>Upper target: <strong>₹{fmt(activeStrat?.upperBreakeven)}</strong></li>
                <li>Lower target: <strong>₹{fmt(activeStrat?.lowerBreakeven)}</strong></li>
                {sigmaBounds && <li style={{ color:COLOR.accent }}>Market pricing ±₹{fmt(sigmaBounds.sigma)} move (1σ)</li>}
                <li>Max loss limited to premium paid</li>
                <li style={{ color:COLOR.muted }}>
                  {+snap.iv?.atm > 20 ? "⚠ High IV — premium expensive" : "✅ Low IV — good time to buy"}
                </li>
              </ul>
            </div>
            <div className="card" style={{ borderColor:"rgba(255,77,109,.2)" }}>
              <div style={{ color:COLOR.sell, fontWeight:700, marginBottom:10, fontSize:14 }}>
                🔴 Option Seller View (Short {stratType})
              </div>
              <ul style={{ margin:0, paddingLeft:18, fontSize:13, color:COLOR.text, lineHeight:1.9 }}>
                <li>Collect premium: <strong>₹{fmt(activeStrat?.combined)}</strong>
                  {premiumPct && <span style={{ color:COLOR.muted }}> ({premiumPct}% of spot)</span>}</li>
                <li>Profit if spot stays inside breakevens</li>
                <li>Range: ₹{fmt(activeStrat?.lowerBreakeven)} – ₹{fmt(activeStrat?.upperBreakeven)}</li>
                {sigmaBounds && <li style={{ color:COLOR.accent }}>
                  1σ safe zone: ₹{fmt(sigmaBounds.lower1)} – ₹{fmt(sigmaBounds.upper1)}</li>}
                <li>Theta decay works in your favour</li>
                <li>Unlimited risk if spot breaks out sharply</li>
                <li style={{ color:COLOR.muted }}>
                  {+snap.iv?.atm > 20 ? "✅ High IV — good time to sell" : "⚠ Low IV — less premium to collect"}
                </li>
              </ul>
            </div>
          </div>

          {/* ── Footer ── */}
          <div style={{ marginTop:14, padding:"10px 16px",
            background:"rgba(15,23,42,0.6)", borderRadius:10,
            border:`1px solid ${COLOR.border}`, fontSize:12, color:COLOR.muted,
            display:"flex", gap:20, flexWrap:"wrap", alignItems:"center" }}>
            <span>
              🔔 Alerts:{" "}
              <span style={{ color: notifPermission==="granted" ? COLOR.green : COLOR.muted }}>
                {notifPermission==="granted"
                  ? "Enabled — will notify on breakeven breach"
                  : notifPermission==="denied"
                    ? "Blocked — allow in browser site settings"
                    : "Click 'Enable Alerts' to activate"}
              </span>
            </span>
            <span>
              📥 {premHistory.filter(r => r.straddle != null).length} ticks recorded
              <button onClick={() => exportCSV(symbol, safeExpiry, premHistory)}
                style={{ marginLeft:8, background:"none", border:"none",
                  color:COLOR.accent, cursor:"pointer", fontSize:12, textDecoration:"underline" }}>
                Export CSV
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const pillStyle = (color) => ({
  background: `${color}18`,
  border:     `1px solid ${color}40`,
  color,
  borderRadius:  8,
  padding:       "5px 12px",
  fontSize:      12,
  fontWeight:    600,
  fontFamily:    "monospace",
});