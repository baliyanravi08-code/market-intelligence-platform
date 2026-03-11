import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io(window.location.origin);

const STATUS_COLOR = {
  connected: "#00ff9c",
  disconnected: "#ff5c5c",
  unavailable: "#ffaa00",
  connecting: "#888"
};

const SIGNAL_COLOR = {
  ORDER_ALERT:        { bg: "#00ff9c", fg: "#000" },
  MERGER:             { bg: "#ff9c00", fg: "#000" },
  CAPEX:              { bg: "#00cfff", fg: "#000" },
  INSIDER_BUY:        { bg: "#ff5cff", fg: "#000" },
  INSIDER_TRADE:      { bg: "#ff5cff", fg: "#000" },
  PARTNERSHIP:        { bg: "#ffe14d", fg: "#000" },
  CORPORATE_ACTION:   { bg: "#334455", fg: "#aac" },
  SMART_MONEY:        { bg: "#ff9c00", fg: "#000" },
  MULTIBAGGER_SIGNAL: { bg: "#ff2d55", fg: "#fff" },
  NEWS:               { bg: "#0d2a4a", fg: "#6aaaf0" }
};

function formatTime(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d)) return String(raw).replace("T", " ").substring(0, 16);
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

function bestTs(e) {
  if (e.savedAt)  return e.savedAt;
  const et = exchangeToTs(e.time);
  if (et)         return et;
  return Date.now();
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

function Tag({ type }) {
  const c = SIGNAL_COLOR[type] || { bg: "#0d5bd1", fg: "#fff" };
  return <span className="tag" style={{ background: c.bg, color: c.fg }}>{type}</span>;
}

function ExBadge({ exchange }) {
  return (
    <span className={`ex-badge ex-${exchange.toLowerCase()}`}>{exchange}</span>
  );
}

export default function App() {
  const [bseEvents,     setBseEvents]     = useState([]);
  const [nseEvents,     setNseEvents]     = useState([]);
  const [radar,         setRadar]         = useState([]);
  const [sector,        setSector]        = useState([]);
  const [orderBook,     setOrderBook]     = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [bseStatus,     setBseStatus]     = useState("connecting");
  const [nseStatus,     setNseStatus]     = useState("connecting");
  const [activeTab,     setActiveTab]     = useState("bse");
  const [flash,         setFlash]         = useState(false);
  const [radarSearch,   setRadarSearch]   = useState("");
  const flashTimer = useRef(null);

  function triggerFlash() {
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 400);
  }

  useEffect(() => {
    socket.on("bse_status", s => setBseStatus(s));
    socket.on("nse_status", s => setNseStatus(s));

    socket.on("radar_update", data => {
      setRadar(prev => {
        const prevMap = Object.fromEntries(prev.map(r => [r.company, r]));
        return data.map(r => ({
          ...r,
          receivedAt: prevMap[r.company]?.score === r.score
            ? (prevMap[r.company]?.receivedAt || bestTs(r))
            : bestTs(r)
        }));
      });
    });

    socket.on("bse_events", data => {
      triggerFlash();
      const stamped = data.map(e => ({ ...e, receivedAt: bestTs(e) }));
      setBseEvents(prev => {
        const existingIds = new Set(prev.map(e => e.company + e.time));
        const fresh = stamped.filter(e => !existingIds.has(e.company + e.time));
        return [...fresh, ...prev].slice(0, 500);
      });
    });

    socket.on("nse_events", data => {
      const stamped = data.map(e => ({ ...e, receivedAt: bestTs(e) }));
      setNseEvents(prev => {
        const existingIds = new Set(prev.map(e => e.company + e.time));
        const fresh = stamped.filter(e => !existingIds.has(e.company + e.time));
        return [...fresh, ...prev].slice(0, 500);
      });
    });

    socket.on("order_book_update", data => {
      setOrderBook(prev => [
        { ...data, receivedAt: bestTs(data) },
        ...prev.filter(o => o.company !== data.company)
      ].slice(0, 20));
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
      setOpportunities(prev => [{ ...data, receivedAt: bestTs(data) }, ...prev].slice(0, 10));
    });

    return () => socket.removeAllListeners();
  }, []);

  const feedEvents = activeTab === "bse" ? bseEvents : nseEvents;
  const filteredRadar = radarSearch
    ? radar.filter(r => r.company.toLowerCase().includes(radarSearch.toLowerCase()))
    : radar;

  return (
    <div className="terminal">
      <div className="header">
        <span className="star">★</span>
        <span className="title">Market Intelligence Terminal</span>
        <div className="status-row">
          <span className="dot" style={{ background: STATUS_COLOR[bseStatus] }} />
          <span style={{ color: STATUS_COLOR[bseStatus] }}>BSE: {bseStatus}</span>
          <span className="dot" style={{ background: STATUS_COLOR[nseStatus] }} />
          <span style={{ color: STATUS_COLOR[nseStatus] }}>NSE: {nseStatus}</span>
        </div>
      </div>

      <div className="layout">

        {/* RADAR */}
        <div className="panel radar-panel">
          <div className="panel-title">
            RADAR <span className="count">{filteredRadar.length}</span>
          </div>
          <input
            className="radar-search"
            placeholder="Search company..."
            value={radarSearch}
            onChange={e => setRadarSearch(e.target.value)}
          />
          {filteredRadar.length === 0 && <div className="empty">Waiting for signals…</div>}
          {filteredRadar.map((r, i) => (
            <div className={`radar-card ${r.score >= 60 ? "hl" : ""}`} key={i}>
              <div className="rc-top">
                <span className="co-name">{r.company}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {(r.exchanges || []).map((ex, j) => (
                    <ExBadge key={j} exchange={ex} />
                  ))}
                  <span className="score">{r.score}</span>
                </div>
              </div>
              <div className="sbar"><div className="sfill" style={{
                width: `${Math.min(r.score, 100)}%`,
                background: r.score >= 70 ? "#00ff9c" : r.score >= 40 ? "#ffaa00" : "#0d5bd1"
              }} /></div>
              <div className="tags">
                {[...new Set(r.signals)].slice(0, 3).map((s, j) => <Tag key={j} type={s} />)}
              </div>
              <div className="rc-foot">
                {r.pdfUrl && <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="plink">Filing ↗</a>}
                <LiveAgo receivedAt={r.receivedAt} exchangeTime={r.time} />
              </div>
            </div>
          ))}
        </div>

        {/* FEED */}
        <div className={`panel feed-panel ${flash ? "flash" : ""}`}>
          <div className="panel-title">
            <button className={`tbtn ${activeTab === "bse" ? "active" : ""}`} onClick={() => setActiveTab("bse")}>
              BSE <span className="count">{bseEvents.length}</span>
            </button>
            <button className={`tbtn ${activeTab === "nse" ? "active" : ""}`} onClick={() => setActiveTab("nse")}>
              NSE <span className="count">{nseEvents.length}</span>
            </button>
          </div>
          {feedEvents.length === 0 && <div className="empty">Waiting for alerts…</div>}
          {feedEvents.map((e, i) => (
            <div className="feed-card" key={i}>
              <div className="fc-head">
                <span className="co-name">{e.company}</span>
                <Tag type={e.type} />
              </div>
              <div className="fc-text">{e.title}</div>
              <div className="fc-foot">
                <LiveAgo receivedAt={e.receivedAt} exchangeTime={e.time} />
                {e.pdfUrl && <a href={e.pdfUrl} target="_blank" rel="noreferrer" className="plink">Filing ↗</a>}
              </div>
            </div>
          ))}
        </div>

        {/* RIGHT */}
        <div className="panel right-panel">

          {opportunities.length > 0 && <>
            <div className="panel-title">MULTIBAGGER <span className="count">{opportunities.length}</span></div>
            {opportunities.map((o, i) => (
              <div className="opp-card" key={i}>
                <div className="opp-row">
                  <span className="co-name">{o.company}</span>
                  <span className="opp-pct">{o.score}%</span>
                </div>
                <LiveAgo receivedAt={o.receivedAt} exchangeTime={o.time} />
              </div>
            ))}
          </>}

          <div className="panel-title" style={{ marginTop: opportunities.length > 0 ? 8 : 0 }}>
            SECTOR <span className="count">{sector.length}</span>
          </div>
          {sector.length === 0
            ? <div className="empty">No sector activity yet</div>
            : sector.map((s, i) => (
              <div className={`sec-card ${s.isBoom ? "boom" : ""}`} key={i}>
                <div className="sec-row">
                  <span className="sec-name">{s.isBoom ? "🔥 " : ""}{s.sector}</span>
                  <span className="sec-val">₹{s.totalValue?.toFixed(0)}Cr</span>
                </div>
                <div className="sec-sub">{s.orders} orders · {s.companies?.slice(0, 3).join(", ")}</div>
              </div>
            ))
          }

          <div className="panel-title" style={{ marginTop: 8 }}>
            ORDER BOOK <span className="count">{orderBook.length}</span>
          </div>
          {orderBook.length === 0
            ? <div className="empty">No orders tracked yet</div>
            : orderBook.map((o, i) => (
              <div className="ord-card" key={i}>
                <div className="ord-top">
                  <span className="co-name">{o.company}</span>
                  <span className={`str-lbl ${(o.strength || "").toLowerCase().replace(" ", "-")}`}>{o.strength}</span>
                </div>
                <div className="ord-stats">
                  <span className="ord-val">₹{o.orderValue}Cr</span>
                  <span>Total ₹{o.totalOrderBook?.toFixed(0)}Cr</span>
                  <span>{o.orders} orders</span>
                </div>
                {o.percentage > 0 && <div className="ord-pct">{o.percentage}% of MCap</div>}
                <LiveAgo receivedAt={o.receivedAt} exchangeTime={o.time} />
              </div>
            ))
          }

        </div>
      </div>
    </div>
  );
}