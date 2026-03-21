import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";
import "./App.css";

const STATUS_COLOR = {
  connected:    "#00ff9c",
  disconnected: "#ff5c5c",
  unavailable:  "#ffaa00",
  connecting:   "#555"
};

const SIGNAL_COLOR = {
  ORDER_ALERT:        { bg: "#00ff9c", fg: "#000" },
  MERGER:             { bg: "#ff9c00", fg: "#000" },
  CAPEX:              { bg: "#00cfff", fg: "#000" },
  INSIDER_BUY:        { bg: "#ff5cff", fg: "#000" },
  INSIDER_TRADE:      { bg: "#ff5cff", fg: "#000" },
  PARTNERSHIP:        { bg: "#ffe14d", fg: "#000" },
  CORPORATE_ACTION:   { bg: "#1a3040", fg: "#6090aa" },
  SMART_MONEY:        { bg: "#ff9c00", fg: "#000" },
  RESULT:             { bg: "#0088dd", fg: "#fff" },
  BANK_RESULT:        { bg: "#8833cc", fg: "#fff" },
  MULTIBAGGER_SIGNAL: { bg: "#ff2d55", fg: "#fff" },
  NEWS:               { bg: "#081828", fg: "#2a5a7a" }
};

const FEED_FILTERS = ["ALL", "ORDER", "MERGER", "CAPEX", "RESULT", "INSIDER", ">50"];

function formatTime(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw).replace("T", " ").substring(0, 16);
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit",
      hour12: true
    });
  } catch { return String(raw).substring(0, 16); }
}

function exchangeToTs(timeStr) {
  if (!timeStr) return null;
  try {
    const d = new Date(timeStr);
    if (!isNaN(d)) return d.getTime();
  } catch {}
  return null;
}

function toAgo(ts) {
  if (!ts) return "just now";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)     return "just now";
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function bestTsRadar(e) {
  if (e.savedAt) return e.savedAt;
  const et = exchangeToTs(e.time);
  if (et) return et;
  return Date.now();
}

function bestTsFeed(e) {
  const et = exchangeToTs(e.time);
  if (et && !isNaN(et)) return et;
  if (e.savedAt) return e.savedAt;
  return Date.now();
}

function scoreClass(score) {
  if (score >= 70) return "score-high";
  if (score >= 40) return "score-mid";
  return "score-low";
}

function scoreBg(score) {
  if (score >= 70) return "#00ff9c";
  if (score >= 40) return "#ffaa00";
  return "#0d5bd1";
}

function filterEvent(e, filter) {
  if (filter === "ALL")     return true;
  if (filter === "ORDER")   return e.type === "ORDER_ALERT";
  if (filter === "MERGER")  return e.type === "MERGER";
  if (filter === "CAPEX")   return e.type === "CAPEX";
  if (filter === "RESULT")  return e.type === "RESULT" || e.type === "BANK_RESULT";
  if (filter === "INSIDER") return e.type === "INSIDER_BUY" || e.type === "INSIDER_TRADE";
  if (filter === ">50")     return (e.value || 0) >= 50;
  return true;
}

function mergeEvents(incoming, existing) {
  const merged = [...incoming, ...existing];
  const deduped = Object.values(
    merged.reduce((acc, e) => {
      const key = (e.company || "") + (e.time || "") + (e.type || "") + (e.title || "");
      if (!acc[key]) acc[key] = e;
      return acc;
    }, {})
  );
  return deduped
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    .slice(0, 500);
}

function LiveAgo({ receivedAt, exchangeTime }) {
  const [ago, setAgo] = useState(toAgo(receivedAt));
  useEffect(() => {
    const t = setInterval(() => setAgo(toAgo(receivedAt)), 1000);
    return () => clearInterval(t);
  }, [receivedAt]);
  return (
    <div className="time-row">
      <span className="ago">{ago}</span>
      {exchangeTime && <span className="time-label">{formatTime(exchangeTime)}</span>}
    </div>
  );
}

function Tag({ type, crores, mcap, mcapPct }) {
  const c = SIGNAL_COLOR[type] || { bg: "#0d3060", fg: "#fff" };
  if (type === "ORDER_ALERT" && crores) {
    const crLabel = crores >= 1000 ? `₹${(crores / 1000).toFixed(1)}K` : `₹${crores}Cr`;
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "3px" }}>
        <span className="tag" style={{ background: c.bg, color: c.fg }}>ORDER {crLabel}</span>
        {mcap && (
          <span style={{ fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", color: "#2a6060", whiteSpace: "nowrap" }}>
            MCap ₹{mcap >= 1000 ? `${(mcap / 1000).toFixed(1)}K` : mcap?.toFixed(0)}Cr
            {mcapPct && (
              <span style={{
                marginLeft: 5, fontWeight: 700,
                color: parseFloat(mcapPct) >= 10 ? "#ff6622" : parseFloat(mcapPct) >= 5 ? "#ffaa00" : "#4488aa"
              }}>· {mcapPct}%</span>
            )}
          </span>
        )}
      </div>
    );
  }
  return <span className="tag" style={{ background: c.bg, color: c.fg }}>{type}</span>;
}

function ExBadge({ exchange }) {
  const exName = typeof exchange === "string" ? exchange.toLowerCase() : "unknown";
  return <span className={`ex-badge ex-${exName}`}>{exchange || "?"}</span>;
}
function MarketStatus() {
  const [status, setStatus] = useState(getMarketStatus());
  useEffect(() => {
    const t = setInterval(() => setStatus(getMarketStatus()), 60000);
    return () => clearInterval(t);
  }, []);
  function getMarketStatus() {
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const day  = ist.getDay();
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const open = 9 * 60 + 15, close = 15 * 60 + 30;
    if (day === 0 || day === 6) return { open: false, label: "CLOSED" };
    if (mins >= open && mins < close) return { open: true, label: "LIVE" };
    if (mins < open) return { open: false, label: "Pre-Open" };
    return { open: false, label: "CLOSED" };
  }
  return (
    <span style={{
      fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", fontWeight: 700,
      color: status.open ? "#00ff9c" : "#334455",
      background: status.open ? "#001a0a" : "#0a0a0a",
      border: `1px solid ${status.open ? "#00ff9c33" : "#222"}`,
      borderRadius: "3px", padding: "1px 6px", flexShrink: 0
    }}>
      {status.open ? "● " : "○ "}{status.label}
    </span>
  );
}
function CompanyScreener({ companyProfile, onClose }) {
  const p  = companyProfile.profile;
  const fi = companyProfile.financials;
  const sh = companyProfile.shareholding;
  const rf = companyProfile.recentFilings || [];
  const isUp = (p?.changePct || 0) >= 0;

  return (
    <div style={{ background: "#020d1e", border: "1px solid #0c3060", borderRadius: "6px", padding: "10px", marginBottom: "8px" }}>

      {/* NAME + SECTOR */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#d0eeff", marginBottom: "2px" }}>{p?.name || "Company"}</div>
          <div style={{ fontSize: "9px", color: "#1a5060" }}>{p?.sector}{p?.industry ? ` · ${p.industry}` : ""}</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#1a4a60", cursor: "pointer", fontSize: "14px", flexShrink: 0 }}>✕</button>
      </div>

      {/* LIVE PRICE */}
      {p?.price && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px", background: "#010a18", borderRadius: "4px", marginBottom: "8px" }}>
          <span style={{ fontSize: "18px", fontWeight: 700, color: "#d0eeff", fontFamily: "IBM Plex Mono, monospace" }}>₹{p.price}</span>
          <span style={{ fontSize: "12px", fontWeight: 700, fontFamily: "IBM Plex Mono, monospace", color: isUp ? "#00cc66" : "#ff4444" }}>
            {isUp ? "▲" : "▼"} {Math.abs(p.changePct || 0)}%
            <span style={{ fontSize: "10px", marginLeft: 4, opacity: 0.7 }}>({isUp ? "+" : ""}{p.change})</span>
          </span>
          {p.volume > 0 && (
            <span style={{ fontSize: "9px", color: "#1a4a60", marginLeft: "auto", fontFamily: "IBM Plex Mono, monospace" }}>
              Vol: {p.volume >= 100000 ? `${(p.volume / 100000).toFixed(1)}L` : p.volume >= 1000 ? `${(p.volume / 1000).toFixed(0)}K` : `${p.volume}`}
            </span>
          )}
        </div>
      )}

      {/* 52W BAR */}
      {p?.high52 > 0 && p?.low52 > 0 && p?.price > 0 && (() => {
        const pct = p.high52 === p.low52 ? 50 : Math.min(Math.max(((p.price - p.low52) / (p.high52 - p.low52)) * 100, 2), 98);
        return (
          <div style={{ marginBottom: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9px", color: "#1a4060", fontFamily: "IBM Plex Mono, monospace", marginBottom: "3px" }}>
              <span>52L ₹{p.low52}</span>
              <span style={{ color: "#1a6040" }}>▼ current</span>
              <span>52H ₹{p.high52}</span>
            </div>
            <div style={{ height: "4px", background: "#081828", borderRadius: "2px", position: "relative" }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: "linear-gradient(90deg, #0044aa, #00cc66)", borderRadius: "2px" }} />
              <div style={{ position: "absolute", top: "-3px", left: `${pct}%`, transform: "translateX(-50%)", width: "10px", height: "10px", background: "#00ff9c", borderRadius: "50%", border: "2px solid #010a18" }} />
            </div>
          </div>
        );
      })()}

      {/* METRICS GRID */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px", marginBottom: "8px" }}>
        {[
          { label: "MCap",    value: p?.mcap         ? `₹${p.mcap >= 1000 ? `${(p.mcap / 1000).toFixed(1)}K` : p.mcap?.toFixed(0)}Cr` : null },
          { label: "PE",      value: p?.pe            ? `${p.pe}x`            : null },
          { label: "EPS",     value: p?.eps           ? `₹${p.eps}`           : null },
          { label: "BV/sh",   value: p?.bookValue     ? `₹${p.bookValue}`     : null },
          { label: "Div Yld", value: p?.dividendYield ? `${p.dividendYield}%` : null },
          { label: "Face Val",value: p?.faceValue     ? `₹${p.faceValue}`     : null },
          { label: "D/E",     value: fi?.debtToEquity ? `${fi.debtToEquity}x` : null },
          { label: "Debt",    value: fi?.totalDebt    ? `₹${fi.totalDebt}Cr`  : null },
          { label: "Cash",    value: fi?.totalCash    ? `₹${fi.totalCash}Cr`  : null },
          { label: "ROE",     value: fi?.returnOnEquity   ? `${fi.returnOnEquity}%`   : null },
          { label: "ROA",     value: fi?.returnOnAssets   ? `${fi.returnOnAssets}%`   : null },
          { label: "Net Mgn", value: fi?.profitMargin     ? `${fi.profitMargin}%`     : null },
          { label: "Op Mgn",  value: fi?.operatingMargin  ? `${fi.operatingMargin}%`  : null },
          { label: "Rev Grw", value: fi?.revenueGrowth    ? `${fi.revenueGrowth}%`    : null },
          { label: "Cur Rat", value: fi?.currentRatio     ? `${fi.currentRatio}x`     : null },
        ].filter(m => m.value).map((m, i) => (
          <div key={i} style={{ background: "#010a18", borderRadius: "3px", padding: "5px 6px", border: "1px solid #081828" }}>
            <div style={{ fontSize: "8px", color: "#1a4060", fontFamily: "IBM Plex Mono, monospace", marginBottom: "2px" }}>{m.label}</div>
            <div style={{ fontSize: "10px", color: "#a0c0e0", fontWeight: 700, fontFamily: "IBM Plex Mono, monospace" }}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* DAY HIGH/LOW */}
      {(p?.dayHigh > 0 || p?.dayLow > 0) && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px", fontSize: "9px", fontFamily: "IBM Plex Mono, monospace" }}>
          {p.dayHigh > 0 && <span style={{ color: "#00cc66" }}>Day H ₹{p.dayHigh}</span>}
          {p.dayLow  > 0 && <span style={{ color: "#ff4444" }}>Day L ₹{p.dayLow}</span>}
        </div>
      )}

      {/* SHAREHOLDING */}
      {sh && (sh.promoter || sh.fii || sh.dii) && (
        <div style={{ marginBottom: "8px" }}>
          <div style={{ fontSize: "9px", color: "#1a4a60", fontFamily: "IBM Plex Mono, monospace", letterSpacing: "1px", marginBottom: "5px", textTransform: "uppercase" }}>
            Shareholding Pattern
          </div>
          <div style={{ display: "flex", gap: "4px", marginBottom: "5px" }}>
            {[
              { label: "Promoter", value: sh.promoter, color: "#4488ff" },
              { label: "FII/FPI",  value: sh.fii,      color: "#ff8844" },
              { label: "DII",      value: sh.dii,      color: "#00cc66" },
              { label: "Public",   value: sh.public,   color: "#aa44ff" },
            ].filter(s => s.value != null).map((s, i) => (
              <div key={i} style={{ flex: 1, background: "#010a18", borderRadius: "3px", padding: "4px 5px", border: `1px solid ${s.color}22`, textAlign: "center" }}>
                <div style={{ fontSize: "8px", color: "#1a4060", marginBottom: "2px" }}>{s.label}</div>
                <div style={{ fontSize: "11px", fontWeight: 700, color: s.color, fontFamily: "IBM Plex Mono, monospace" }}>{s.value}%</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", height: "4px", borderRadius: "2px", overflow: "hidden", gap: "1px" }}>
            {sh.promoter && <div style={{ flex: sh.promoter, background: "#4488ff" }} />}
            {sh.fii      && <div style={{ flex: sh.fii,      background: "#ff8844" }} />}
            {sh.dii      && <div style={{ flex: sh.dii,      background: "#00cc66" }} />}
            {sh.public   && <div style={{ flex: sh.public,   background: "#aa44ff" }} />}
          </div>
        </div>
      )}

      {/* QUARTERLY FINANCIALS */}
      {fi?.quarters?.length > 0 && (
        <div style={{ marginBottom: "8px" }}>
          <div style={{ fontSize: "9px", color: "#1a4a60", fontFamily: "IBM Plex Mono, monospace", letterSpacing: "1px", marginBottom: "5px", textTransform: "uppercase" }}>
            Quarterly Financials (₹Cr)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(fi.quarters.length, 4)}, 1fr)`, gap: "4px" }}>
            {fi.quarters.slice(0, 4).map((q, i) => (
              <div key={i} style={{ background: "#010a18", borderRadius: "3px", padding: "5px 4px", border: "1px solid #081828", textAlign: "center" }}>
                <div style={{ fontSize: "8px", color: "#1a4060", marginBottom: "3px" }}>{q.date ? q.date.substring(0, 7) : `Q${i + 1}`}</div>
                {q.revenue != null && <div style={{ fontSize: "9px", color: "#4488aa", fontFamily: "IBM Plex Mono, monospace" }}>Rev {q.revenue}</div>}
                {q.profit  != null && <div style={{ fontSize: "9px", fontWeight: 700, fontFamily: "IBM Plex Mono, monospace", color: q.profit >= 0 ? "#00cc66" : "#ff4444" }}>PAT {q.profit}</div>}
                {q.ebitda  != null && <div style={{ fontSize: "8px", color: "#2a6060", fontFamily: "IBM Plex Mono, monospace" }}>EBITDA {q.ebitda}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ORDERS FROM SCANNER */}
      {rf.some(f => f.type === "ORDER_ALERT") && (
        <div style={{ marginBottom: "8px" }}>
          <div style={{ fontSize: "9px", color: "#1a4a60", fontFamily: "IBM Plex Mono, monospace", letterSpacing: "1px", marginBottom: "5px", textTransform: "uppercase" }}>
            Orders (from scanner)
          </div>
          {rf.filter(f => f.type === "ORDER_ALERT").slice(0, 4).map((f, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #081828", gap: "6px" }}>
              <span style={{ fontSize: "9px", color: "#2a6060" }}>
                {f._orderInfo?.crores ? `₹${f._orderInfo.crores >= 1000 ? `${(f._orderInfo.crores / 1000).toFixed(1)}K` : f._orderInfo.crores}Cr` : "Order"}
                {f._orderInfo?.periodLabel ? ` · ${f._orderInfo.periodLabel}` : ""}
              </span>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <span style={{ fontSize: "9px", color: "#1a4060", fontFamily: "IBM Plex Mono, monospace" }}>{f.time?.substring(0, 10)}</span>
                {f.pdfUrl && <a href={f.pdfUrl} target="_blank" rel="noreferrer" className="plink">↗</a>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ABOUT */}
      {p?.about && (
        <div style={{ fontSize: "9px", color: "#1a3a55", lineHeight: "1.5", padding: "6px", background: "#010a18", borderRadius: "3px", marginBottom: "8px", maxHeight: "60px", overflow: "hidden" }}>
          {p.about.length <= 200 ? p.about : p.about.substring(0, 200) + "..."}
        </div>
      )}

      {/* RECENT SIGNALS */}
      {rf.length > 0 && (
        <>
          <div style={{ fontSize: "9px", color: "#1a4a60", fontFamily: "IBM Plex Mono, monospace", letterSpacing: "1px", marginBottom: "5px", textTransform: "uppercase" }}>
            Recent Signals
          </div>
          {rf.slice(0, 5).map((f, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #081828", gap: "6px" }}>
              <span style={{ fontSize: "9px", color: "#2a5a7a", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.title?.substring(0, 38)}
              </span>
              <div style={{ display: "flex", gap: "4px", alignItems: "center", flexShrink: 0 }}>
                <span className="tag" style={{ background: SIGNAL_COLOR[f.type]?.bg || "#081828", color: SIGNAL_COLOR[f.type]?.fg || "#2a5a7a", fontSize: "8px", padding: "1px 4px" }}>{f.type}</span>
                {f.pdfUrl && <a href={f.pdfUrl} target="_blank" rel="noreferrer" className="plink">↗</a>}
              </div>
            </div>
          ))}
        </>
      )}
      {rf.length === 0 && (
        <div style={{ fontSize: "9px", color: "#1a3a55", fontStyle: "italic" }}>No recent filings in database</div>
      )}
    </div>
  );
}

export default function App() {
  const socketRef = useRef(null);

  const [bseEvents,      setBseEvents]      = useState([]);
  const [nseEvents,      setNseEvents]      = useState([]);
  const [radar,          setRadar]          = useState([]);
  const [sector,         setSector]         = useState([]);
  const [orderBook,      setOrderBook]      = useState([]);
  const [opportunities,  setOpportunities]  = useState([]);
  const [megaOrders,     setMegaOrders]     = useState([]);
  const [bseStatus,      setBseStatus]      = useState("connecting");
  const [nseStatus,      setNseStatus]      = useState("connecting");
  const [activeTab,      setActiveTab]      = useState("bse");
  const [feedFilter,     setFeedFilter]     = useState("ALL");
  const [flash,          setFlash]          = useState(false);
  const [mobilePanel,    setMobilePanel]    = useState("radar");
  const [windowInfo,     setWindowInfo]     = useState({ hours: 24, label: "24h" });
  const [searchQuery,    setSearchQuery]    = useState("");
  const [searchResults,  setSearchResults]  = useState([]);
  const [companyProfile, setCompanyProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const flashTimer    = useRef(null);
  const searchTimeout = useRef(null);

  function closeProfile() {
    setCompanyProfile(null);
    setSearchQuery("");
    setSearchResults([]);
  }

  function clearSearch() {
    setSearchQuery("");
    setSearchResults([]);
    setCompanyProfile(null);
  }

  function triggerFlash() {
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 600);
  }

  function playAlert(freq1 = 880, freq2 = 1100) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!window._audioCtx || window._audioCtx.state === "closed") {
        window._audioCtx = new AudioCtx();
      }
      const ctx  = window._audioCtx;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(freq1, ctx.currentTime);
      osc.frequency.setValueAtTime(freq2, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch {}
  }

  function handleSearchInput(q) {
    setSearchQuery(q);
    clearTimeout(searchTimeout.current);
    if (!q || q.length < 2) { setSearchResults([]); return; }
    searchTimeout.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search/${encodeURIComponent(q)}`);
        const d = await r.json();
        setSearchResults(d.results || []);
      } catch {}
    }, 300);
  }

  async function loadCompanyProfile(code, name, nseSymbol) {
    setSearchResults([]);
    setSearchQuery(name || "");
    setProfileLoading(true);
    setCompanyProfile(null);
    try {
      const nseParam = nseSymbol ? `?nse=${nseSymbol}` : "";
      const r = await fetch(`/api/company/${code}${nseParam}`);
      if (!r.ok) { setProfileLoading(false); return; }
      const d = await r.json();
      setCompanyProfile({ ...d, code });
    } catch {}
    setProfileLoading(false);
  }
  useEffect(() => {
    fetch("/api/events")
      .then(r => r.json())
      .then(data => {
        if (data.bse?.length) {
          const stamped = data.bse.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
          setBseEvents(stamped.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 500));
        }
        if (data.nse?.length) {
          const stamped = data.nse.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
          setNseEvents(stamped.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 500));
        }
        if (data.windowHours) setWindowInfo({ hours: data.windowHours, label: data.windowLabel });
        if (data.orderBook?.length) {
          setOrderBook(data.orderBook.map(o => ({ ...o, receivedAt: o.receivedAt || o.savedAt || Date.now() })));
        }
        if (data.sectors?.length)    setSector(data.sectors);
        if (data.megaOrders?.length) setMegaOrders(data.megaOrders.map(o => ({ ...o, receivedAt: o.receivedAt || Date.now() })));
        setFeedFilter("ALL");
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!socketRef.current) {
      socketRef.current = io(window.location.origin);
    }
    const socket = socketRef.current;

    socket.on("bse_status",  s    => setBseStatus(s));
    socket.on("nse_status",  s    => setNseStatus(s));
    socket.on("window_info", info => setWindowInfo(info));

    socket.on("radar_update", data => {
      setRadar(prev => {
        const getKey  = r => (r.company || "") + (r.code || "");
        const prevMap = Object.fromEntries(prev.map(r => [getKey(r), r]));
        return data.map(r => {
          const prevItem = prevMap[getKey(r)];
          return {
            ...r,
            receivedAt: prevItem && prevItem.score === r.score
              ? (prevItem.receivedAt || bestTsRadar(r))
              : bestTsRadar(r)
          };
        });
      });
    });

    socket.on("bse_events", data => {
      const stamped = data.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
      if (data.length <= 5) {
        triggerFlash();
        const high = stamped.find(e => (e.value || 0) >= 70);
        if (high) playAlert(660, 880);
      }
      setBseEvents(prev => mergeEvents(stamped, prev));
    });

    socket.on("nse_events", data => {
      const stamped = data.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
      setNseEvents(prev => mergeEvents(stamped, prev));
    });

   
  socket.on("order_book_update", data => {
  if ((data.currentLiveOrderBook || 0) >= 1000) playAlert(900, 1400);
  setOrderBook(prev => {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    return [
      { ...data, receivedAt: bestTsFeed(data) },
      ...prev.filter(o => o.company !== data.company)
    ].filter(o => (o.receivedAt || 0) > cutoff).slice(0, 50);
  });
});

    socket.on("mega_order_alert", data => {
      setMegaOrders(prev => [
        { ...data, receivedAt: Date.now() },
        ...prev.filter(o => o.company !== data.company)
      ].slice(0, 10));
      playAlert(880, 1320);
    });

    socket.on("sector_alerts", data => {
      setSector(prev => {
        const merged = [...data, ...prev];
        return Object.values(
          merged.reduce((a, s) => { a[s.sector] = s; return a; }, {})
        ).slice(0, 15);
      });
    });

    socket.on("sector_boom", data => {
      setSector(prev => [data, ...prev.filter(s => s.sector !== data.sector)].slice(0, 15));
    });

    socket.on("opportunity_alert", data => {
      setOpportunities(prev => [
        { ...data, receivedAt: bestTsFeed(data) }, ...prev
      ].slice(0, 10));
    });

    return () => {
      socket.off("bse_status");
      socket.off("nse_status");
      socket.off("window_info");
      socket.off("radar_update");
      socket.off("bse_events");
      socket.off("nse_events");
      socket.off("order_book_update");
      socket.off("mega_order_alert");
      socket.off("sector_alerts");
      socket.off("sector_boom");
      socket.off("opportunity_alert");
    };
  }, []);

  const filteredRadar = searchQuery
    ? radar.filter(r => r.company.toLowerCase().includes(searchQuery.toLowerCase()))
    : radar;
  const filteredFeed = (activeTab === "bse" ? bseEvents : nseEvents).filter(e => filterEvent(e, feedFilter));
  const isWeekend    = windowInfo.hours > 24;

  return (
    <div className="terminal">

      {/* HEADER */}
      <div className="header">
        <div className="header-left">
          <span className="star">★</span>
          <span className="title">Market Intelligence</span>
<MarketStatus />
          {isWeekend && (
            <span style={{
              fontFamily: "IBM Plex Mono, monospace", fontSize: "9px",
              color: "#ffaa00", background: "#1a0800",
              border: "1px solid #ff440033", borderRadius: "3px",
              padding: "1px 6px", fontWeight: 700, flexShrink: 0
            }}>⏱ {windowInfo.label}</span>
          )}
        </div>
        <div className="header-right">
          <div className="status-pill">
            <span className="dot pulse" style={{ background: STATUS_COLOR[bseStatus] }} />
            <span style={{ color: STATUS_COLOR[bseStatus] }}>BSE</span>
          </div>
          <div className="status-pill">
            <span className="dot pulse" style={{ background: STATUS_COLOR[nseStatus] }} />
            <span style={{ color: STATUS_COLOR[nseStatus] }}>NSE</span>
          </div>
        </div>
      </div>

      {/* MOBILE TABS */}
      <div className="mobile-tabs">
        <button className={`mobile-tab ${mobilePanel === "radar" ? "active" : ""}`} onClick={() => setMobilePanel("radar")}>📡 Radar</button>
        <button className={`mobile-tab ${mobilePanel === "feed"  ? "active" : ""}`} onClick={() => setMobilePanel("feed")}>📋 Feed</button>
        <button className={`mobile-tab ${mobilePanel === "right" ? "active" : ""}`} onClick={() => setMobilePanel("right")}>📊 Data</button>
      </div>

      <div className="layout">

        {/* RADAR PANEL */}
        <div className={`panel radar-panel ${mobilePanel === "radar" ? "mobile-active" : ""}`}>
          <div className="panel-header">
            <span className="panel-title">📡 Radar <span className="count">{filteredRadar.length}</span></span>
            {isWeekend && (
              <span style={{ fontSize: "9px", color: "#ffaa00", fontFamily: "IBM Plex Mono, monospace" }}>Fri–Mon data</span>
            )}
          </div>

          {/* SEARCH */}
          <div style={{ position: "relative", marginBottom: "6px" }}>
            <input
              className="radar-search"
              style={{ marginBottom: 0, paddingRight: searchQuery ? "28px" : "8px" }}
              placeholder="🔍 Search company..."
              value={searchQuery}
              onChange={e => handleSearchInput(e.target.value)}
            />
            {searchQuery && (
              <button onClick={clearSearch} style={{
                position: "absolute", right: "6px", top: "50%",
                transform: "translateY(-50%)", background: "none",
                border: "none", color: "#1a4a60", cursor: "pointer", fontSize: "12px"
              }}>✕</button>
            )}
          </div>

          {/* SEARCH RESULTS */}
          {searchResults.length > 0 && (
            <div style={{ background: "#020c1a", border: "1px solid #0c2240", borderRadius: "4px", marginBottom: "6px", overflow: "hidden" }}>
              {searchResults.map((r, i) => (
                <div key={i}
                  onClick={() => loadCompanyProfile(r.code, r.name, r.nseSymbol || null)}
                  style={{ padding: "7px 8px", cursor: "pointer", borderBottom: "1px solid #081828", display: "flex", alignItems: "center", gap: "6px" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#041020"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <span style={{ fontSize: "11px", color: "#d0eeff", fontWeight: 700, flex: 1 }}>{r.name}</span>
                  <span style={{ fontSize: "9px", color: "#1a4a60", fontFamily: "IBM Plex Mono, monospace" }}>{r.code}</span>
                  {r.sector && <span style={{ fontSize: "9px", color: "#1a5050" }}>{r.sector}</span>}
                </div>
              ))}
            </div>
          )}

          {/* LOADING */}
          {profileLoading && (
            <div style={{ padding: "16px", textAlign: "center", color: "#1a4a60", fontSize: "10px", fontFamily: "IBM Plex Mono, monospace" }}>
              Loading profile...
            </div>
          )}

          {/* SCREENER */}
          {companyProfile && !profileLoading && (
            <CompanyScreener companyProfile={companyProfile} onClose={closeProfile} />
          )}

          {/* EMPTY */}
          {filteredRadar.length === 0 && !companyProfile && !profileLoading && (
            <div className="empty">
              {isWeekend ? "Weekend mode — showing last 96h\nMarket opens Mon 9:15 AM" : "Waiting for signals…"}
            </div>
          )}

          {/* RADAR CARDS */}
          {filteredRadar.map((r, i) => {
            const isMega = r.signals?.includes("ORDER_ALERT") && r.score >= 85;
            return (
              <div
                className={`radar-card ${isMega ? "mega" : r.score >= 60 ? "high-score" : ""}`}
                key={i} style={{ cursor: "pointer" }}
                onClick={() => loadCompanyProfile(r.code || r.company, r.company, null)}
              >
                <div className="rc-top">
                  <span className="co-name">{r.company}</span>
                  <div className="rc-badges">
                    {(r.exchanges || []).map((ex, j) => <ExBadge key={j} exchange={ex} />)}
                    <span className={`score ${scoreClass(r.score)}`}>{r.score}</span>
                  </div>
                </div>
                <div className="sbar">
                  <div className="sfill" style={{ width: `${Math.min(r.score, 100)}%`, background: scoreBg(r.score) }} />
                </div>
                <div className="tags">
                  {[...new Set(r.signals)].slice(0, 3).map((s, j) => (
                    <Tag key={j} type={s} crores={r._orderInfo?.crores} mcap={r._orderInfo?.mcap} mcapPct={r.mcapRatio} />
                  ))}
                </div>
                <div className="rc-foot">
                  {r.pdfUrl
                    ? <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="plink" onClick={e => e.stopPropagation()}>Filing ↗</a>
                    : <span />
                  }
                  <LiveAgo receivedAt={r.receivedAt} exchangeTime={r.time} />
                </div>
              </div>
            );
          })}
        </div>

        {/* FEED PANEL */}
        <div className={`panel feed-panel ${flash ? "flash" : ""} ${mobilePanel === "feed" ? "mobile-active" : ""}`}>
          <div className="panel-header">
            <div style={{ display: "flex", gap: 4 }}>
              <button className={`tbtn ${activeTab === "bse" ? "active" : ""}`} onClick={() => setActiveTab("bse")}>
                BSE <span className="count">{bseEvents.length}</span>
              </button>
              <button className={`tbtn ${activeTab === "nse" ? "active" : ""}`} onClick={() => setActiveTab("nse")}>
                NSE <span className="count">{nseEvents.length}</span>
              </button>
            </div>
            <span style={{ fontSize: "9px", color: isWeekend ? "#ffaa00" : "#1a4a60", fontFamily: "IBM Plex Mono, monospace" }}>
              {isWeekend ? `⏱ ${windowInfo.label}` : `${filteredFeed.length} shown`}
            </span>
          </div>

          <div className="filter-bar">
            {FEED_FILTERS.map(f => (
              <button key={f} className={`fbtn ${feedFilter === f ? "active" : ""}`} onClick={() => setFeedFilter(f)}>{f}</button>
            ))}
          </div>

          {filteredFeed.length === 0
            ? <div className="empty">{isWeekend ? "Weekend — no new filings" : "No signals match filter"}</div>
            : filteredFeed.map((e, i) => {
              const crores  = e._orderInfo?.crores || null;
              const mcap    = e._orderInfo?.mcap   || null;
              const mcapPct = e.mcapRatio ?? ((crores && mcap) ? ((crores / mcap) * 100).toFixed(1) : null);
              const isMega  = e.type === "ORDER_ALERT" && crores >= 1000;
              const isHigh  = (e.value || 0) >= 70;
              return (
                <div className={`feed-card ${isMega ? "mega-value" : isHigh ? "high-value" : ""}`} key={i}>
                  <div className="fc-head">
                    <span className="co-name">{e.company}</span>
                    <Tag type={e.type} crores={crores} mcap={mcap} mcapPct={mcapPct} />
                  </div>
                  <div className="fc-text">{e.title}</div>
                  <div className="fc-foot">
                    <LiveAgo receivedAt={e.receivedAt} exchangeTime={e.time} />
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {e.value >= 50 && <span className="fc-value">Score {e.value}</span>}
                      {e.pdfUrl && <a href={e.pdfUrl} target="_blank" rel="noreferrer" className="plink">PDF ↗</a>}
                    </div>
                  </div>
                </div>
              );
            })
          }
        </div>

        {/* RIGHT PANEL */}
        <div className={`panel right-panel ${mobilePanel === "right" ? "mobile-active" : ""}`}>

          {/* MEGA ORDERS */}
          <div className="section-divider">
            🔥 Mega Orders <span className="count">{megaOrders.length}</span>
          </div>
          {megaOrders.length === 0
            ? <div className="empty">No mega orders yet</div>
            : megaOrders.map((o, i) => (
              <div className="mega-card" key={i}>
                <div className="mega-head">
                  <span className="co-name">{o.company}</span>
                  <span className="mega-val">
                    ₹{o.crores >= 1000 ? (o.crores / 1000).toFixed(1) + "K" : o.crores < 1 ? "<1" : o.crores}Cr
                  </span>
                </div>
                {o.periodLabel && <div className="mega-sub">{o.periodLabel} project{o.annualCrores && ` · ₹${o.annualCrores}Cr/yr`}</div>}
                {o.mcapRatio > 0 && <div className="mega-mcap">{o.mcapRatio}% of MCap</div>}
                <div className="mega-title">{o.title?.substring(0, 65)}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <LiveAgo receivedAt={o.receivedAt} exchangeTime={o.time} />
                  {o.pdfUrl && <a href={o.pdfUrl} target="_blank" rel="noreferrer" className="plink">PDF ↗</a>}
                </div>
              </div>
            ))
          }

          {/* OPPORTUNITIES */}
          <div className="section-divider" style={{ marginTop: 8 }}>
            💡 Opportunities <span className="count">{opportunities.length}</span>
          </div>
          {opportunities.length === 0
            ? <div className="empty">No opportunities yet</div>
            : opportunities.map((o, i) => (
              <div className="opp-card" key={i}>
                <div className="opp-row">
                  <span className="co-name">{o.company}</span>
                  <span className="opp-pct">{o.score}%</span>
                </div>
                <LiveAgo receivedAt={o.receivedAt} exchangeTime={o.time} />
              </div>
            ))
          }

          {/* SECTORS */}
          <div className="section-divider" style={{ marginTop: 8 }}>
            🏭 Sectors <span className="count">{sector.length}</span>
          </div>
          {sector.length === 0
            ? <div className="empty">No sector activity yet</div>
            : sector.map((s, i) => (
              <div className={`sec-card ${s.isBoom ? "boom" : ""}`} key={i}>
                <div className="sec-row">
                  <span className="sec-name">{s.isBoom ? "🔥 " : ""}{s.sector}</span>
                  <span className="sec-val">{s.totalValue > 0 ? `₹${s.totalValue >= 1000 ? `${(s.totalValue/1000).toFixed(1)}K` : s.totalValue.toFixed(0)}Cr` : `${s.orders} order${s.orders!==1?"s":""}`}
</span>     </div>
                <div className="sec-sub">
                  <span>{s.orders} order{s.orders !== 1 ? "s" : ""}</span>
                  <br />
                  <span style={{ color: "#1e5070" }}>{s.companies?.slice(0, 3).join(", ")}</span>
                </div>
              </div>
            ))
          }

          {/* ORDER BOOK */}
          <div className="section-divider" style={{ marginTop: 8 }}>
            📦 Order Book <span className="count">{orderBook.length}</span>
          </div>
          {orderBook.length === 0
            ? <div className="empty">No orders tracked yet</div>
            : orderBook.map((o, i) => (
              <div className="ord-card" key={i}>
                <div className="ord-top">
                  <span className="co-name">{o.company}</span>
                  <span className={`str-lbl ${((o.strength || "EARLY").toLowerCase())}`}>{o.strength || "EARLY"}</span>
                </div>
                <div className="ord-stats">
                  <span className="ord-val">
  {o.orderValue > 0
    ? `₹${o.orderValue >= 1000 ? `${(o.orderValue/1000).toFixed(1)}K` : o.orderValue}Cr`
    : "Order"}
</span>
                  {(o.quarterBook || o.currentOrderBook) > 0 && (
  <span className="ord-book">
    Q: ₹{(o.quarterBook || o.currentOrderBook || 0).toFixed(0)}Cr
  </span>
)}
                  {(o.estimatedOrderBook || o.currentOrderBook) && (
  <span className="ord-book">
    Est: ₹{((o.estimatedOrderBook || o.currentOrderBook || 0) / 100).toFixed(0)}K Cr
  </span>
)}
                </div>
                <div style={{ display: "flex", gap: "8px", fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", marginBottom: "3px", flexWrap: "wrap" }}>
                  {o.mcapRatio > 0 && <>
                    <span style={{ color: "#ff8844", fontWeight: 700 }}>{o.mcapRatio}% of MCap</span>
                    <span style={{ color: "#1a4060" }}>· {o.quarterOrders} orders this qtr</span>
                  </>}
                  {o.obToRevRatio && <span style={{ color: "#1a4a30" }}>OB/Rev {o.obToRevRatio}x</span>}
                </div>
                {o.periodLabel && <div className="ord-period">{o.periodLabel} project</div>}
                <LiveAgo receivedAt={o.receivedAt} exchangeTime={o.time} />
              </div>
            ))
          }

        </div>
      </div>
    </div>
  );
}