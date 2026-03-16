import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io(window.location.origin);

const STATUS_COLOR = {
  connected: "#00ff9c",
  disconnected: "#ff5c5c",
  unavailable: "#ffaa00",
  connecting: "#555"
};

const SIGNAL_COLOR = {
  ORDER_ALERT: { bg: "#00ff9c", fg: "#000" },
  MERGER: { bg: "#ff9c00", fg: "#000" },
  CAPEX: { bg: "#00cfff", fg: "#000" },
  INSIDER_BUY: { bg: "#ff5cff", fg: "#000" },
  INSIDER_TRADE: { bg: "#ff5cff", fg: "#000" },
  PARTNERSHIP: { bg: "#ffe14d", fg: "#000" },
  CORPORATE_ACTION: { bg: "#1a3040", fg: "#6090aa" },
  SMART_MONEY: { bg: "#ff9c00", fg: "#000" },
  RESULT: { bg: "#0088dd", fg: "#fff" },
  BANK_RESULT: { bg: "#8833cc", fg: "#fff" },
  MULTIBAGGER_SIGNAL: { bg: "#ff2d55", fg: "#fff" },
  NEWS: { bg: "#081828", fg: "#2a5a7a" }
};

const FEED_FILTERS = ["ALL", "ORDER", "MERGER", "CAPEX", "RESULT", "INSIDER", ">50"];

function formatTime(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d)) return String(raw).replace("T", " ").substring(0, 16);
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
  } catch {
    return String(raw).substring(0, 16);
  }
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
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
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
  if (filter === "ALL") return true;
  if (filter === "ORDER") return e.type === "ORDER_ALERT";
  if (filter === "MERGER") return e.type === "MERGER";
  if (filter === "CAPEX") return e.type === "CAPEX";
  if (filter === "RESULT") return e.type === "RESULT" || e.type === "BANK_RESULT";
  if (filter === "INSIDER") return e.type === "INSIDER_BUY" || e.type === "INSIDER_TRADE";
  if (filter === ">50") return (e.value || 0) >= 50;
  return true;
}

function mergeEvents(incoming, existing) {
  const merged = [...incoming, ...existing];
  const deduped = Object.values(
    merged.reduce((acc, e) => {
      const key = (e.company || "") + (e.time || "") + (e.title || "").substring(0, 20);
      if (!acc[key]) acc[key] = e;
      return acc;
    }, {})
  );
  return deduped.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 500);
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

/* FIXED TAG COMPONENT */

function Tag({ type, crores, mcap, mcapPct }) {
  const c = SIGNAL_COLOR[type] || { bg: "#0d3060", fg: "#fff" };

  if (type === "ORDER_ALERT" && crores) {
    const crLabel = crores >= 1000 ? `₹${(crores / 1000).toFixed(1)}K` : `₹${crores}Cr`;

    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "3px" }}>
        <span className="tag" style={{ background: c.bg, color: c.fg }}>
          ORDER {crLabel}
        </span>

        {mcap && (
          <span
            style={{
              fontSize: "9px",
              fontFamily: "IBM Plex Mono, monospace",
              color: "#2a6060",
              whiteSpace: "nowrap"
            }}
          >
            MCap ₹{mcap >= 1000 ? `${(mcap / 1000).toFixed(1)}K` : mcap?.toFixed(0)}Cr

            {mcapPct && (
              <span
                style={{
                  marginLeft: 5,
                  fontWeight: 700,
                  color:
                    parseFloat(mcapPct) >= 10
                      ? "#ff6622"
                      : parseFloat(mcapPct) >= 5
                      ? "#ffaa00"
                      : "#4488aa"
                }}
              >
                · {mcapPct}%
              </span>
            )}
          </span>
        )}
      </div>
    );
  }

  return (
    <span className="tag" style={{ background: c.bg, color: c.fg }}>
      {type}
    </span>
  );
}

function ExBadge({ exchange }) {
  return <span className={`ex-badge ex-${exchange.toLowerCase()}`}>{exchange}</span>;
}

/* EVERYTHING BELOW REMAINS EXACTLY SAME */

export default function App() {
  const [bseEvents, setBseEvents] = useState([]);
  const [nseEvents, setNseEvents] = useState([]);
  const [radar, setRadar] = useState([]);

  const [bseStatus, setBseStatus] = useState("connecting");
  const [nseStatus, setNseStatus] = useState("connecting");

  const [activeTab, setActiveTab] = useState("bse");
  const [feedFilter, setFeedFilter] = useState("ALL");

  const flashTimer = useRef(null);

  useEffect(() => {
    socket.on("bse_status", setBseStatus);
    socket.on("nse_status", setNseStatus);

    socket.on("radar_update", data => {
      setRadar(data.map(r => ({ ...r, receivedAt: bestTsRadar(r) })));
    });

    socket.on("bse_events", data => {
      const stamped = data.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
      setBseEvents(prev => mergeEvents(stamped, prev));
    });

    socket.on("nse_events", data => {
      const stamped = data.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
      setNseEvents(prev => mergeEvents(stamped, prev));
    });

    return () => socket.removeAllListeners();
  }, []);

  const feedEvents = activeTab === "bse" ? bseEvents : nseEvents;
  const filteredFeed = feedEvents.filter(e => filterEvent(e, feedFilter));

  return (
    <div className="terminal">

      {/* HEADER */}

      <div className="header">
        <div className="header-left">
          <span className="star">★</span>
          <span className="title">Market Intelligence</span>
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

      {/* FEED */}

      <div className="panel feed-panel">

        <div className="panel-header">
          <button
            className={`tbtn ${activeTab === "bse" ? "active" : ""}`}
            onClick={() => setActiveTab("bse")}
          >
            BSE
          </button>

          <button
            className={`tbtn ${activeTab === "nse" ? "active" : ""}`}
            onClick={() => setActiveTab("nse")}
          >
            NSE
          </button>
        </div>

        <div className="filter-bar">
          {FEED_FILTERS.map(f => (
            <button
              key={f}
              className={`fbtn ${feedFilter === f ? "active" : ""}`}
              onClick={() => setFeedFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>

        {filteredFeed.map((e, i) => {

          const crores = e._orderInfo?.crores || null;
          const mcap = e._orderInfo?.mcap || null;
          const mcapPct = e._orderInfo?.mcapPct || null;

          return (
            <div className="feed-card" key={i}>

              <div className="fc-head">
                <span className="co-name">{e.company}</span>

                <Tag
                  type={e.type}
                  crores={crores}
                  mcap={mcap}
                  mcapPct={mcapPct}
                />
              </div>

              <div className="fc-text">{e.title}</div>

              <div className="fc-foot">
                <LiveAgo receivedAt={e.receivedAt} exchangeTime={e.time} />

                {e.pdfUrl && (
                  <a href={e.pdfUrl} target="_blank" rel="noreferrer" className="plink">
                    PDF ↗
                  </a>
                )}
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}