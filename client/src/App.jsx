import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io(window.location.origin);

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

function bestTsRadar(e) {
  if (e.savedAt) return e.savedAt;
  const et = exchangeToTs(e.time);
  if (et) return et;
  return Date.now();
}

function bestTsFeed(e) {
  const et = exchangeToTs(e.time);
  if (et && !isNaN(et)) return et;
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

function Tag({ type, crores }) {
  const c = SIGNAL_COLOR[type] || { bg: "#0d3060", fg: "#fff" };
  const label = (type === "ORDER_ALERT" && crores)
    ? `ORDER ₹${crores >= 1000 ? (crores / 1000).toFixed(1) + "K" : crores}Cr`
    : type;
  return <span className="tag" style={{ background: c.bg, color: c.fg }}>{label}</span>;
}

function ExBadge({ exchange }) {
  return <span className={`ex-badge ex-${exchange.toLowerCase()}`}>{exchange}</span>;
}

export default function App() {
  const [bseEvents,     setBseEvents]     = useState([]);
  const [nseEvents,     setNseEvents]     = useState([]);
  const [radar,         setRadar]         = useState([]);
  const [sector,        setSector]        = useState([]);
  const [orderBook,     setOrderBook]     = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [megaOrders,    setMegaOrders]    = useState([]);
  const [bseStatus,     setBseStatus]     = useState("connecting");
  const [nseStatus,     setNseStatus]     = useState("connecting");
  const [activeTab,     setActiveTab]     = useState("bse");
  const [feedFilter,    setFeedFilter]    = useState("ALL");
  const [flash,         setFlash]         = useState(false);
  const [radarSearch,   setRadarSearch]   = useState("");
  const [mobilePanel,   setMobilePanel]   = useState("radar");
  const [windowInfo,    setWindowInfo]    = useState({ hours: 24, label: "24h" });
  const flashTimer = useRef(null);

  function triggerFlash() {
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 600);
  }

  function playAlert(freq1 = 880, freq2 = 1100) {
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
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
    } catch(e) {}
  }

  // ── Load historical events on mount via REST API ──
  useEffect(() => {
    fetch("/api/events")
      .then(r => r.json())
      .then(data => {
        if (data.bse?.length) {
          const stamped = data.bse.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
          setBseEvents(stamped.slice(0, 500));
        }
        if (data.nse?.length) {
          const stamped = data.nse.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
          setNseEvents(stamped.slice(0, 500));
        }
        if (data.windowHours) {
          setWindowInfo({ hours: data.windowHours, label: data.windowLabel });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    socket.on("bse_status", s => setBseStatus(s));
    socket.on("nse_status", s => setNseStatus(s));

    socket.on("window_info", info => setWindowInfo(info));

    socket.on("radar_update", data => {
      setRadar(prev => {
        const prevMap = Object.fromEntries(prev.map(r => [r.company, r]));
        return data.map(r => ({
          ...r,
          receivedAt: prevMap[r.company]?.score === r.score
            ? (prevMap[r.company]?.receivedAt || bestTsRadar(r))
            : bestTsRadar(r)
        }));
      });
    });

    socket.on("bse_events", data => {
      triggerFlash();
      const stamped = data.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
      const high = stamped.find(e => (e.value || 0) >= 70);
      if (high) playAlert(660, 880);
      setBseEvents(prev => {
        const ids   = new Set(prev.map(e => e.company + e.time));
        const fresh = stamped.filter(e => !ids.has(e.company + e.time));
        return [...fresh, ...prev].slice(0, 500);
      });
    });

    socket.on("nse_events", data => {
      const stamped = data.map(e => ({ ...e, receivedAt: bestTsFeed(e) }));
      setNseEvents(prev => {
        const ids   = new Set(prev.map(e => e.company + e.time));
        const fresh = stamped.filter(e => !ids.has(e.company + e.time));
        return [...fresh, ...prev].slice(0, 500);
      });
    });

    socket.on("order_book_update", data => {
      setOrderBook(prev => [
        { ...data, receivedAt: bestTsFeed(data) },
        ...prev.filter(o => o.company !== data.company)
      ].slice(0, 20));
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

    return () => socket.removeAllListeners();
  }, []);

  const feedEvents    = activeTab === "bse" ? bseEvents : nseEvents;
  const filteredFeed  = feedEvents.filter(e => filterEvent(e, feedFilter));
  const filteredRadar = radarSearch
    ? radar.filter(r => r.company.toLowerCase().includes(radarSearch.toLowerCase()))
    : radar;

  const isWeekend = windowInfo.hours > 24;

  return (
    <div className="terminal">

      {/* ── HEADER ── */}
      <div className="header">
        <div className="header-left">
          <span className="star">★</span>
          <span className="title">Market Intelligence</span>
          {isWeekend && (
            <span style={{
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: "9px",
              color: "#ffaa00",
              background: "#1a0800",
              border: "1px solid #ff440033",
              borderRadius: "3px",
              padding: "1px 6px",
              fontWeight: 700,
              letterSpacing: "0.5px",
              flexShrink: 0
            }}>
              ⏱ {windowInfo.label}
            </span>
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

      {/* ── MOBILE TABS ── */}
      <div className="mobile-tabs">
        <button className={`mobile-tab ${mobilePanel === "radar" ? "active" : ""}`}
          onClick={() => setMobilePanel("radar")}>📡 Radar</button>
        <button className={`mobile-tab ${mobilePanel === "feed" ? "active" : ""}`}
          onClick={() => setMobilePanel("feed")}>📋 Feed</button>
        <button className={`mobile-tab ${mobilePanel === "right" ? "active" : ""}`}
          onClick={() => setMobilePanel("right")}>📊 Data</button>
      </div>

      <div className="layout">

        {/* ══ RADAR PANEL ══ */}
        <div className={`panel radar-panel ${mobilePanel === "radar" ? "mobile-active" : ""}`}>
          <div className="panel-header">
            <span className="panel-title">
              📡 Radar
              <span className="count">{filteredRadar.length}</span>
            </span>
            {isWeekend && (
              <span style={{
                fontSize: "9px",
                color: "#ffaa00",
                fontFamily: "IBM Plex Mono, monospace"
              }}>
                Fri–Mon data
              </span>
            )}
          </div>

          <input
            className="radar-search"
            placeholder="Search company..."
            value={radarSearch}
            onChange={e => setRadarSearch(e.target.value)}
          />

          {filteredRadar.length === 0
            ? <div className="empty">
                {isWeekend
                  ? "Weekend mode — showing last 96h\nMarket opens Mon 9:15 AM"
                  : "Waiting for signals…\nMarket opens Mon 9:15 AM"
                }
              </div>
            : filteredRadar.map((r, i) => {
              const isMega = r.signals?.includes("ORDER_ALERT") && r.score >= 85;
              return (
                <div
                  className={`radar-card ${isMega ? "mega" : r.score >= 60 ? "high-score" : ""}`}
                  key={i}
                >
                  <div className="rc-top">
                    <span className="co-name">{r.company}</span>
                    <div className="rc-badges">
                      {(r.exchanges || []).map((ex, j) => <ExBadge key={j} exchange={ex} />)}
                      <span className={`score ${scoreClass(r.score)}`}>{r.score}</span>
                    </div>
                  </div>
                  <div className="sbar">
                    <div className="sfill" style={{
                      width: `${Math.min(r.score, 100)}%`,
                      background: scoreBg(r.score)
                    }} />
                  </div>
                  <div className="tags">
                    {[...new Set(r.signals)].slice(0, 3).map((s, j) => (
                      <Tag key={j} type={s} />
                    ))}
                  </div>
                  <div className="rc-foot">
                    {r.pdfUrl
                      ? <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="plink">Filing ↗</a>
                      : <span />
                    }
                    <LiveAgo receivedAt={r.receivedAt} exchangeTime={r.time} />
                  </div>
                </div>
              );
            })
          }
        </div>

        {/* ══ FEED PANEL ══ */}
        <div className={`panel feed-panel ${flash ? "flash" : ""} ${mobilePanel === "feed" ? "mobile-active" : ""}`}>

          <div className="panel-header">
            <div style={{ display: "flex", gap: 4 }}>
              <button className={`tbtn ${activeTab === "bse" ? "active" : ""}`}
                onClick={() => setActiveTab("bse")}>
                BSE <span className="count">{bseEvents.length}</span>
              </button>
              <button className={`tbtn ${activeTab === "nse" ? "active" : ""}`}
                onClick={() => setActiveTab("nse")}>
                NSE <span className="count">{nseEvents.length}</span>
              </button>
            </div>
            <span style={{
              fontSize: "9px",
              color: isWeekend ? "#ffaa00" : "#1a4a60",
              fontFamily: "IBM Plex Mono, monospace"
            }}>
              {isWeekend ? `⏱ ${windowInfo.label}` : `${filteredFeed.length} shown`}
            </span>
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

          {filteredFeed.length === 0
            ? <div className="empty">
                {isWeekend
                  ? "Weekend — no new filings\nFriday orders shown above"
                  : "No signals match filter"
                }
              </div>
            : filteredFeed.map((e, i) => {
              const crores = e._orderInfo?.crores || null;
              const isMega = e.type === "ORDER_ALERT" && crores >= 1000;
              const isHigh = (e.value || 0) >= 70;
              return (
                <div
                  className={`feed-card ${isMega ? "mega-value" : isHigh ? "high-value" : ""}`}
                  key={i}
                >
                  <div className="fc-head">
                    <span className="co-name">{e.company}</span>
                    <Tag type={e.type} crores={crores} />
                  </div>
                  <div className="fc-text">{e.title}</div>
                  <div className="fc-foot">
                    <LiveAgo receivedAt={e.receivedAt} exchangeTime={e.time} />
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {e.value >= 50 && (
                        <span className="fc-value">Score {e.value}</span>
                      )}
                      {e.pdfUrl &&
                        <a href={e.pdfUrl} target="_blank" rel="noreferrer" className="plink">PDF ↗</a>
                      }
                    </div>
                  </div>
                </div>
              );
            })
          }
        </div>

        {/* ══ RIGHT PANEL ══ */}
        <div className={`panel right-panel ${mobilePanel === "right" ? "mobile-active" : ""}`}>

          {/* MEGA ORDERS */}
          {megaOrders.length > 0 && <>
            <div className="section-divider">
              🚨 Mega Orders
              <span className="count">{megaOrders.length}</span>
            </div>
            {megaOrders.map((o, i) => (
              <div className="mega-card" key={i}>
                <div className="mega-head">
                  <span className="co-name">{o.company}</span>
                  <span className="mega-val">
                    ₹{o.crores >= 1000 ? (o.crores / 1000).toFixed(1) + "K" : o.crores}Cr
                  </span>
                </div>
                {o.periodLabel && (
                  <div className="mega-sub">
                    {o.periodLabel} project
                    {o.annualCrores && ` · ₹${o.annualCrores}Cr/yr`}
                  </div>
                )}
                {o.mcapRatio > 0 && (
                  <div className="mega-mcap">{o.mcapRatio}% of MCap</div>
                )}
                <div className="mega-title">{o.title?.substring(0, 65)}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <LiveAgo receivedAt={o.receivedAt} exchangeTime={o.time} />
                  {o.pdfUrl &&
                    <a href={o.pdfUrl} target="_blank" rel="noreferrer" className="plink">PDF ↗</a>
                  }
                </div>
              </div>
            ))}
          </>}

          {/* MULTIBAGGER */}
          {opportunities.length > 0 && <>
            <div className="section-divider" style={{ marginTop: megaOrders.length > 0 ? 8 : 0 }}>
              🎯 Multibagger
              <span className="count">{opportunities.length}</span>
            </div>
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

          {/* SECTOR */}
          <div className="section-divider" style={{ marginTop: 8 }}>
            🏭 Sectors
            <span className="count">{sector.length}</span>
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

          {/* ORDER BOOK */}
          <div className="section-divider" style={{ marginTop: 8 }}>
            📦 Order Book
            <span className="count">{orderBook.length}</span>
          </div>
          {orderBook.length === 0
            ? <div className="empty">No orders tracked yet</div>
            : orderBook.map((o, i) => (
              <div className="ord-card" key={i}>
                <div className="ord-top">
                  <span className="co-name">{o.company}</span>
                  <span className={`str-lbl ${(o.strength || "early").toLowerCase().replace(" ", "-")}`}>
                    {o.strength}
                  </span>
                </div>
                <div className="ord-stats">
                  <span className="ord-val">₹{o.orderValue}Cr</span>
                  {o.quarterBook > 0 && (
                    <span className="ord-book">Q: ₹{o.quarterBook?.toFixed(0)}Cr</span>
                  )}
                  {o.estimatedOrderBook && (
                    <span className="ord-book">
                      Est: ₹{(o.estimatedOrderBook / 100).toFixed(0)}K Cr
                    </span>
                  )}
                </div>
                {o.periodLabel && (
                  <div className="ord-period">{o.periodLabel} project</div>
                )}
                {o.mcapRatio > 0 && (
                  <div className="ord-pct">{o.mcapRatio}% MCap · {o.quarterOrders} this qtr</div>
                )}
                {o.obToRevRatio && (
                  <div className="ord-pct">OB/Rev {o.obToRevRatio}x</div>
                )}
                <LiveAgo receivedAt={o.receivedAt} exchangeTime={o.time} />
              </div>
            ))
          }

        </div>
      </div>
    </div>
  );
}