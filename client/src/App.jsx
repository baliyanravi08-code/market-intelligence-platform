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
  ORDER_ALERT:         { bg: "#00ff9c", fg: "#000" },
  MERGER:              { bg: "#ff9c00", fg: "#000" },
  CAPEX:               { bg: "#00cfff", fg: "#000" },
  INSIDER_BUY:         { bg: "#ff5cff", fg: "#000" },
  INSIDER_TRADE:       { bg: "#ff5cff", fg: "#000" },
  PARTNERSHIP:         { bg: "#ffe14d", fg: "#000" },
  CORPORATE_ACTION:    { bg: "#1a3040", fg: "#6090aa" },
  SMART_MONEY:         { bg: "#ff9c00", fg: "#000" },
  RESULT:              { bg: "#0088dd", fg: "#fff" },
  BANK_RESULT:         { bg: "#8833cc", fg: "#fff" },
  MULTIBAGGER_SIGNAL: { bg: "#ff2d55", fg: "#fff" },
  NEWS:                { bg: "#081828", fg: "#2a5a7a" }
};

const FEED_FILTERS = ["ALL", "ORDER", "MERGER", "CAPEX", "RESULT", "INSIDER", ">50"];

// --- Utilities ---
function formatTime(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw).replace("T", " ").substring(0, 16);
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
  } catch { return String(raw).substring(0, 16); }
}

function toAgo(ts) {
  if (!ts) return "just now";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function extractAmount(text) {
  const match = text?.match(/(\d+(?:\.\d+)?)\s?(crore|cr)/i);
  return match ? parseFloat(match[1]) : 0;
}
// --- Components ---
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
  return <span className="tag" style={{ background: c.bg, color: c.fg }}>{type === "ORDER_ALERT" && crores ? `ORDER ₹${crores}Cr` : type}</span>;
}

function MarketStatus() {
  const [status, setStatus] = useState({ open: true, label: "LIVE" });
  return (
    <span style={{ fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, color: "#00ff9c", background: "#001a0a", border: "1px solid #00ff9c33", borderRadius: "3px", padding: "1px 6px" }}>
      ● {status.label}
    </span>
  );
}

export default function App() {
  const [marketIndices, setMarketIndices] = useState([
  { name: "NIFTY 50",    price: "—", change: "—", pct: "—", up: null },
  { name: "SENSEX",      price: "—", change: "—", pct: "—", up: null },
  { name: "BANK NIFTY",  price: "—", change: "—", pct: "—", up: null },
]);

useEffect(() => {
  const symbols = ["^NSEI", "^BSESN", "^NSEBANK"];
  const names   = ["NIFTY 50", "SENSEX", "BANK NIFTY"];

  const fetchMarket = async () => {
    try {
      const results = await Promise.all(symbols.map(sym =>
        fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`)
          .then(r => r.json())
      ));

      const updated = results.map((data, i) => {
        const meta   = data?.chart?.result?.[0]?.meta;
        if (!meta) return { name: names[i], price: "—", change: "—", pct: "—", up: null };
        const price  = meta.regularMarketPrice;
        const prev   = meta.previousClose || meta.chartPreviousClose;
        const diff   = price - prev;
        const pct    = ((diff / prev) * 100);
        const up     = diff >= 0;
        return {
          name:   names[i],
          price:  price.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
          change: (up ? "+" : "") + diff.toFixed(2),
          pct:    (up ? "+" : "") + pct.toFixed(2) + "%",
          up
        };
      });

      setMarketIndices(updated);
    } catch(e) {
      console.log("Market fetch error:", e);
    }
  };

  fetchMarket();
  const interval = setInterval(fetchMarket, 5000); // refresh every 5s
  return () => clearInterval(interval);
}, []);
  const socketRef = useRef(null);
  const [bseEvents, setBseEvents] = useState([]);
  const [nseEvents, setNseEvents] = useState([]);
  const [radar, setRadar] = useState([]);
  const [sector, setSector] = useState([]);
  const [orderBook, setOrderBook] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [radarQuery, setRadarQuery] = useState('');
  const [megaOrders, setMegaOrders] = useState([]);
  const [activeTab, setActiveTab] = useState("bse");
  const [feedFilter, setFeedFilter] = useState("ALL");

 
  useEffect(() => {
    fetch("/api/events")
      .then(res => res.json())
      .then(data => {
        console.log("API DATA:", data);
        setBseEvents(data.bse || []);
        setNseEvents(data.nse || []);
        setOrderBook(data.orderBook || []);
        setSector(data.sectors || []);
        setMegaOrders(data.megaOrders || []);
      })
      .catch(err => console.log("API error:", err));
  }, []);

  const filteredFeed = (activeTab === "bse" ? bseEvents : nseEvents).filter(e => feedFilter === "ALL" || (e.type || "").includes(feedFilter));

  // ===== FRONTEND INTELLIGENCE =====
  const isSignal = (e) => {
    const text = (e?.title || "").toLowerCase();
    const type = (e?.type || "").toUpperCase();
    return (
      type.includes("ORDER") ||
      type.includes("MERGER") ||
      text.includes("order") ||
      text.includes("contract") ||
      text.includes("merger") ||
      text.includes("acquisition") ||
      text.includes("fraud") ||
      text.includes("penalty") ||
      text.includes("default") ||
      text.includes("insolvency") ||
      text.includes("nclt")
    );
  };

  const computedRadar = (bseEvents || [])
    .filter(e => {
      const t = (e?.title || "").toLowerCase();
      if (
        t.includes("trading window") ||
        t.includes("postal ballot") ||
        t.includes("scrutinizer") ||
        t.includes("voting result") ||
        t.includes("esg") ||
        t.includes("analyst meeting")
      ) return false;
      return isSignal(e);
    })
    .slice(0, 50)
    .map(e => {
      const t = (e?.title || "").toLowerCase();
      let type = "NEWS";
      let score = 10;
      if (t.includes("order") || t.includes("contract")) { type = "ORDER"; score = 90; }
      else if (t.includes("merger") || t.includes("acquisition")) { type = "MERGER"; score = 80; }
      else if (t.includes("fraud") || t.includes("penalty")) { type = "RISK"; score = 95; }
      return {
        company: e?.company || "Unknown",
        score,
        type,
        receivedAt: e?.receivedAt,
        time: e?.time,
        pdfUrl: e?.pdfUrl || e?.attachment || null,
        orderValue: extractAmount(e?.title)
      };
    });

  const computedMegaOrders = (bseEvents || []).filter(e => {
  const t = (e?.title || "").toLowerCase();
  const isOrder = (t.includes("order") || t.includes("contract")) &&
    (t.includes("crore") || t.includes("₹") || t.includes("rs"));
  if (!isOrder) return false;
  const cr = e._orderInfo?.crores || extractAmount(e.title);
  if (!cr) return false;
  const above500 = cr >= 500;
  const mcapEntry = window._mcapDb?.find?.(m =>
    (m.company || "").toLowerCase() === (e.company || "").toLowerCase()
  );
  const mcap = mcapEntry?.mcap || 0;
  const pctTrigger = mcap > 0 && (cr / mcap) >= 0.08;
  return above500 || pctTrigger;
}).sort((a, b) =>
  (b._orderInfo?.crores || extractAmount(b.title)) -
  (a._orderInfo?.crores || extractAmount(a.title))
).slice(0, 10).map(e => ({
  company: e.company,
  crores: e._orderInfo?.crores || extractAmount(e.title),
  receivedAt: e.receivedAt,
  time: e.time
}));
  const computedOpportunities = computedRadar
    .filter(r => r.score >= 70)
    .slice(0, 5)
    .map(r => ({
      company: r.company,
      score: r.score,
      receivedAt: r.receivedAt,
      time: r.time
    }));

  return (
    <div className="terminal">
      <div className="header">
        <div className="header-left">
          <span className="star">★</span>
          <span className="title">Market Intelligence</span>
          <MarketStatus />
        </div>
      </div>

      {/* ✅ FIX: .layout wrapper added — this was missing, causing black screen */}
      <div className="layout">

        {/* COL 1: RADAR */}
        <div className="panel radar-panel">
  <div className="panel-header">
    <span className="panel-title">
      📡 Radar <span className="count">{computedRadar.filter(r => !radarQuery || r.company.toLowerCase().includes(radarQuery.toLowerCase()) || r.type.toLowerCase().includes(radarQuery.toLowerCase())).length}</span>
    </span>
  </div>

  <div className="search-wrap">
    <span className="search-icon">⌕</span>
    <input
      type="text"
      className="radar-search"
      placeholder="Search company, type..."
      value={radarQuery}
      onChange={e => setRadarQuery(e.target.value)}
    />
    {radarQuery && <button className="clear-btn" onClick={() => setRadarQuery('')}>✕</button>}
  </div>

  {computedRadar.filter(r =>
    !radarQuery ||
    r.company.toLowerCase().includes(radarQuery.toLowerCase()) ||
    r.type.toLowerCase().includes(radarQuery.toLowerCase())
  ).length === 0 ? (
    <div className="empty">No matches for "{radarQuery}"</div>
  ) : (
    computedRadar
      .filter(r =>
        !radarQuery ||
        r.company.toLowerCase().includes(radarQuery.toLowerCase()) ||
        r.type.toLowerCase().includes(radarQuery.toLowerCase())
      )
      .map((r, i) => (
        <div className="radar-card" key={i}>
          <div className="rc-top">
  <span className="co-name">{r.company}</span>
  <div>
    <span className="score score-high">{r.score}</span>
    {r.orderValue > 0 && (
      <span className="order-val">₹{r.orderValue}Cr</span>
    )}
  </div>
</div>
          <div className="tag-row">
  <span className={`type type-${r.type}`}>{r.type}</span>
  {r.orderValue > 0 && <span className="order-val">₹{r.orderValue}Cr</span>}
  {r.pdfUrl && (
    <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="filing-link">
      ▪ Filing
    </a>
  )}
</div>
<div className="compact-time">{formatTime(r.time)}</div>
        </div>
      ))
  )}
</div>

        {/* COL 2: FEED */}
        <div className="panel feed-panel">
          <div className="panel-header">
            <div style={{ display: "flex", gap: 4 }}>
              <button className={`tbtn ${activeTab === "bse" ? "active" : ""}`} onClick={() => setActiveTab("bse")}>BSE</button>
              <button className={`tbtn ${activeTab === "nse" ? "active" : ""}`} onClick={() => setActiveTab("nse")}>NSE</button>
            </div>
          </div>
          <div className="filter-bar">{FEED_FILTERS.map(f => <button key={f} className={`fbtn ${feedFilter === f ? "active" : ""}`} onClick={() => setFeedFilter(f)}>{f}</button>)}</div>
          {filteredFeed.length === 0 ? <div className="empty">No signals match filter</div> : filteredFeed.map((e, i) => (
            <div className={`feed-card ${
  e.type?.includes("ORDER") ? "fc-order" :
  e.type?.includes("MERGER") ? "fc-merger" :
  e.type?.includes("RESULT") ? "fc-result" :
  e.type?.includes("INSIDER") ? "fc-insider" :
  e.type?.includes("CAPEX") ? "fc-capex" : "fc-news"
}`} key={i}>
              <div className="fc-head">
  <span className="fc-company">{e.company}
    {e.type === "NEWS" && <span className="fc-tag-news">NEWS</span>}
  </span>
  {e.type !== "NEWS" && <Tag type={e.type} crores={e._orderInfo?.crores || extractAmount(e.title)} />}
</div>
<div className="fc-text">{e.title}</div>
<div className="fc-time">{formatTime(e.time) || "—"}</div>
            </div>
          ))}
        </div>

        {/* COL 3: DATA */}
        <div className="panel right-panel">
          <div className="section">
            <div className="section-divider">🔥 Mega Orders <span className="count">{computedMegaOrders.length}</span></div>
            {computedMegaOrders.length === 0 ? <div className="empty">No mega orders yet</div> : computedMegaOrders.map((o, i) => (
              <div className="mega-card" key={i}>
                <div className="mega-head"><span className="co-name">{o.company}</span><span className="mega-val">₹{o.crores}Cr</span></div>
                <div className="time-label">{formatTime(o.time) || "—"}</div>
              </div>
            ))}
          </div>

          <div className="section">
            <div className="section-divider">💡 Opportunities <span className="count">{computedOpportunities.length}</span></div>
            {computedOpportunities.length === 0 ? <div className="empty">No opportunities yet</div> : computedOpportunities.map((o, i) => (
              <div className="opp-card" key={i}>
                <div className="opp-row"><span className="co-name">{o.company}</span><span className="opp-pct">{o.score}%</span></div>
                <div className="time-label">{formatTime(o.time) || "—"}</div>
              </div>
            ))}
          </div>

          <div className="section">
            <div className="section-divider">🏭 Sectors <span className="count">{sector.length}</span></div>
            {sector.length === 0 ? <div className="empty">No sector activity yet</div> : sector.map((s, i) => (
              <div className="sec-card" key={i}>
                <div className="sec-row"><span className="sec-name">{s.sector}</span><span className="sec-val">₹{s.totalValue}Cr</span></div>
              </div>
            ))}
          </div>

          <div className="section">
            <div className="section-divider">📦 Order Book <span className="count">{orderBook.length}</span></div>
            {orderBook.length === 0 ? <div className="empty">No orders tracked yet</div> : orderBook.map((o, i) => (
              <div className="ord-card" key={i}>
                <div className="ord-top"><span className="co-name">{o.company}</span><span className="str-lbl building">BUILDING</span></div>
                <div className="ord-stats"><span className="ord-val">₹{o.orderValue}Cr</span></div>
                <div className="time-label">{o.time || "—"}</div>
              </div>
            ))}
          </div>
        </div>

        {/* COL 4: INTELLIGENCE PANEL */}
        <div className="panel intelligence-panel">
          <div className="section">
            <div className="section-divider">⚡ Market</div>
            {marketIndices.map((m, i) => (
  <div key={i} className="mini-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
    <span style={{ fontSize: "10px", fontWeight: 600 }}>{m.name}</span>
    <div style={{ textAlign: "right" }}>
      <div style={{ color: "#fff", fontWeight: 700, fontSize: "11px", fontFamily: "IBM Plex Mono" }}>{m.price}</div>
      <div style={{
        color: m.up === null ? "#555" : m.up ? "#00ff9c" : "#ff5c5c",
        fontSize: "9px", fontFamily: "IBM Plex Mono"
      }}>
        {m.change} ({m.pct})
      </div>
    </div>
  </div>
))}
          </div>
          <div className="section">
            <div className="section-divider">🔔 Alerts</div>
            {(bseEvents || []).slice(0, 5).map((e, i) => (
              <div key={i} className="mini-card">
                {e.company} → {e.type || "NEWS"}
              </div>
            ))}
          </div>
          <div className="section">
            <div className="section-divider">⚡ Pulse</div>
            <div className="mini-card" style={{ color: "#4a8adf" }}>Orders Tracked: {orderBook.length}</div>
            <div className="mini-card" style={{ color: "#4a8adf" }}>Active Signals: {computedRadar.length}</div>
          </div>
        </div>

      </div> {/* ✅ end .layout */}
    </div>
  );
}
