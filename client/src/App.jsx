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
  MULTIBAGGER_SIGNAL:  { bg: "#ff2d55", fg: "#fff" },
  NEWS:                { bg: "#081828", fg: "#2a5a7a" }
};

const FEED_FILTERS = ["ALL", "ORDER", "MERGER", "CAPEX", "RESULT", "INSIDER", ">50"];

// --- Utilities ---
function formatTime(raw) {
  if (!raw) return null;
  try {
    // Auto-detect seconds vs ms
    const ms = (typeof raw === "number" && raw < 2e10) ? raw * 1000 : raw;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return String(raw).replace("T", " ").substring(0, 16);
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit",
      hour12: true
    });
  } catch { return String(raw).substring(0, 16); }
}

function toAgo(ts) {
  if (!ts) return "just now";
  // Auto-detect: if ts looks like seconds (< 2e10), convert to ms
  const ms = ts < 2e10 ? ts * 1000 : ts;
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 0)   return "just now";
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24)  return rm > 0 ? `${h}h ${rm}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

function extractAmount(text) {
  const match = text?.match(/(\d+(?:\.\d+)?)\s?(crore|cr)/i);
  return match ? parseFloat(match[1]) : 0;
}

// --- Components ---
function LiveAgo({ receivedAt, exchangeTime }) {
  const [ago, setAgo] = useState(() => toAgo(receivedAt));

  useEffect(() => {
    const tick = () => setAgo(toAgo(receivedAt));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [receivedAt]);

  return (
    <div className="time-row">
      <span className="ago">{ago}</span>
      {exchangeTime && (
        <span className="time-label">{formatTime(exchangeTime)}</span>
      )}
    </div>
  );
}

function Tag({ type, crores }) {
  const c = SIGNAL_COLOR[type] || { bg: "#0d3060", fg: "#fff" };
  return (
    <span className="tag" style={{ background: c.bg, color: c.fg }}>
      {type === "ORDER_ALERT" && crores ? `ORDER ₹${crores}Cr` : type}
    </span>
  );
}

function MarketStatus() {
  return (
    <span style={{ fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, color: "#00ff9c", background: "#001a0a", border: "1px solid #00ff9c33", borderRadius: "3px", padding: "1px 6px" }}>
      ● LIVE
    </span>
  );
}

// Live IST clock
function LiveClock() {
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  );
  useEffect(() => {
    const t = setInterval(() => {
      setTime(new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="ticker-clock">{time} IST</span>;
}

function getSession() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes();
  const mins = h * 60 + m;
  const day = ist.getDay();
  if (day === 0 || day === 6) return { label: "CLOSED", cls: "closed" };
  if (mins >= 9 * 60 + 15 && mins < 15 * 60 + 30) return { label: "MARKET OPEN", cls: "open" };
  if (mins >= 9 * 60 && mins < 9 * 60 + 15)       return { label: "PRE-OPEN", cls: "pre" };
  return { label: "CLOSED", cls: "closed" };
}

function TickerBar({ indices, assets }) {
  const session = getSession();
  return (
    <div className="ticker-bar">
      {/* NSE Indices */}
      {indices.map((m, i) => {
        const isUp   = m.up === true;
        const isDown = m.up === false;
        const cls    = isUp ? "up" : isDown ? "down" : "flat";
        return (
          <div className="ticker-item" key={`idx-${i}`}>
            <span className="ticker-name">{m.name}</span>
            <span className="ticker-price">{m.price}</span>
            <span className={`ticker-change ${cls}`}>
              {isUp ? "▲" : isDown ? "▼" : "●"} {m.change} ({m.pct})
            </span>
          </div>
        );
      })}

      {/* Divider */}
      {assets.length > 0 && <div className="ticker-sep">│</div>}

      {/* Crypto & Commodities */}
      {assets.map((a, i) => {
        const isUp   = a.change24h > 0;
        const isDown = a.change24h < 0;
        const cls    = isUp ? "up" : isDown ? "down" : "flat";
        return (
          <div className="ticker-item secondary" key={`asset-${i}`}>
            <span className={`ticker-asset-icon ${a.type}`}>{a.icon}</span>
            <span className="ticker-name">{a.name}</span>
            <span className="ticker-price">{a.price}</span>
            <span className={`ticker-change ${cls}`}>
              {isUp ? "▲" : isDown ? "▼" : "●"} {Math.abs(a.change24h).toFixed(2)}%
            </span>
          </div>
        );
      })}

      <div className="ticker-right">
        <LiveClock />
        <span className={`ticker-session ${session.cls}`}>{session.label}</span>
      </div>
    </div>
  );
}

// Mobile bottom nav tabs
const MOBILE_TABS = [
  { key: "feed",  label: "📡 Feed"   },
  { key: "radar", label: "🔍 Radar"  },
  { key: "data",  label: "📊 Data"   },
  { key: "intel", label: "⚡ Intel"  },
];

export default function App() {
  const [marketIndices, setMarketIndices] = useState([
    { name: "NIFTY 50",   price: "—", change: "—", pct: "—", up: null },
    { name: "SENSEX",     price: "—", change: "—", pct: "—", up: null },
    { name: "BANK NIFTY", price: "—", change: "—", pct: "—", up: null },
  ]);
  const [bseEvents, setBseEvents] = useState([]);
  const [nseEvents, setNseEvents] = useState([]);
  const [sector, setSector] = useState([]);
  const [orderBook, setOrderBook] = useState([]);
  const [radarQuery, setRadarQuery] = useState('');
  const [activeTab, setActiveTab] = useState("bse");
  const [feedFilter, setFeedFilter] = useState("ALL");
  // Mobile panel switcher (only active on mobile via CSS)
  const [mobilePanelTab, setMobilePanelTab] = useState("feed");
  const [cryptoAssets, setCryptoAssets] = useState([]);

  // Fetch BTC, PI, Gold, Silver
  useEffect(() => {
    const fetchAssets = async () => {
      try {
        const fmt = (n, prefix="$") => {
          if (!n && n !== 0) return "—";
          if (n >= 1000) return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
          if (n >= 1)    return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
          return prefix + n.toFixed(4);
        };

        const assets = [];

        // CoinGecko: BTC + PI + Gold (XAUT)
        try {
          const cgRes = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,pi-network,tether-gold&vs_currencies=usd&include_24hr_change=true",
            { headers: { "Accept": "application/json" } }
          );
          const cg = await cgRes.json();

          if (cg.bitcoin) assets.push({
            name: "BTC", icon: "₿", type: "crypto",
            price: fmt(cg.bitcoin.usd),
            change24h: cg.bitcoin.usd_24h_change || 0
          });

          if (cg["pi-network"]) assets.push({
            name: "PI", icon: "π", type: "crypto",
            price: fmt(cg["pi-network"].usd),
            change24h: cg["pi-network"].usd_24h_change || 0
          });

          if (cg["tether-gold"]) assets.push({
            name: "GOLD", icon: "Au", type: "gold",
            price: fmt(cg["tether-gold"].usd),
            change24h: cg["tether-gold"].usd_24h_change || 0
          });
        } catch(e) { console.error("CoinGecko error:", e); }

        // Silver via Metals-API free tier (frankfurter-style open endpoint)
        // Fallback: use CoinGecko's silver token "silver" id
        try {
          const svRes = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=silver&vs_currencies=usd&include_24hr_change=true"
          );
          const sv = await svRes.json();
          if (sv.silver && sv.silver.usd) {
            assets.push({
              name: "SILVER", icon: "Ag", type: "silver",
              price: fmt(sv.silver.usd),
              change24h: sv.silver.usd_24h_change || 0
            });
          } else {
            // Fallback: open metals price from metals.live (no key needed)
            const mlRes = await fetch("https://api.metals.live/v1/spot/silver");
            const ml = await mlRes.json();
            const price = ml?.[0]?.price || ml?.price;
            if (price) {
              assets.push({
                name: "SILVER", icon: "Ag", type: "silver",
                price: fmt(price),
                change24h: 0
              });
            }
          }
        } catch(e) { console.error("Silver fetch error:", e); }

        if (assets.length > 0) setCryptoAssets(assets);
      } catch(err) {
        console.error("Asset fetch error:", err);
      }
    };
    fetchAssets();
    const interval = setInterval(fetchAssets, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchEvents = () => {
      fetch("/api/events")
        .then(res => res.json())
        .then(data => {
          setBseEvents(data.bse || []);
          setNseEvents(data.nse || []);
          setOrderBook(data.orderBook || []);
          setSector(data.sectors || []);
        })
        .catch(err => console.log("API error:", err));
    };
    fetchEvents();
    const interval = setInterval(fetchEvents, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchMarket = async () => {
      try {
        const data = await fetch("/api/market").then(r => r.json());
        if (Array.isArray(data)) setMarketIndices(data);
      } catch(err) {
        console.error("Market fetch error:", err);
      }
    };
    fetchMarket();
    const interval = setInterval(fetchMarket, 30000);
    return () => clearInterval(interval);
  }, []);

  const filteredFeed = (activeTab === "bse" ? bseEvents : nseEvents).filter(e => {
    if (feedFilter === "ALL") return true;
    if (feedFilter === ">50") return (e._orderInfo?.crores || extractAmount(e.title || "")) >= 50;
    return (e.type || "NEWS").toUpperCase().includes(feedFilter);
  });

  // ===== FRONTEND INTELLIGENCE =====
  const computedRadar = (bseEvents || [])
    .filter(e => {
      const t = (e?.title || "").toLowerCase();
      if (
        t.includes("trading window") ||
        t.includes("postal ballot") ||
        t.includes("scrutinizer") ||
        t.includes("voting result") ||
        t.includes("esg") ||
        t.includes("analyst meeting") ||
        t.includes("closure of trading") ||
        t.includes("book closure") ||
        t.includes("intimation of board meeting") ||
        t.includes("change in director") ||
        t.includes("change of address") ||
        t.includes("regulation 30") ||
        t.includes("compliance officer")
      ) return false;
      return true;
    })
    .slice(0, 50)
    .map(e => {
      const t = (e?.title || "").toLowerCase();
      let type = "NEWS";
      let score = 10;

      // Noise keywords that should never be ORDER
      const isNonOrder = (
        t.includes("solar") || t.includes("renewable") || t.includes("green energy") ||
        t.includes("spv") || t.includes("equity stake") || t.includes("power purchase") ||
        t.includes("subscribe") || t.includes("invest") ||
        t.includes("income tax") || t.includes("assessment") || t.includes("tax demand") ||
        t.includes("penalty") || t.includes("nclt")
      );

      // RISK — highest priority
      if (t.includes("fraud") || t.includes("insolvency") || t.includes("default")) {
        type = "RISK"; score = 95;
      }
      else if (t.includes("penalty") || t.includes("nclt")) {
        type = "RISK"; score = 85;
      }

      // CAPEX / INVESTMENT — before ORDER so solar invest doesn't get misclassified
      else if (
        t.includes("solar") || t.includes("renewable") || t.includes("green energy") ||
        t.includes("power purchase") || t.includes("spv") ||
        (t.includes("equity stake") || (t.includes("subscribe") && t.includes("equity"))) ||
        t.includes("capex") || t.includes("greenfield") || t.includes("brownfield") ||
        t.includes("expansion") ||
        (t.includes("invest") && !t.includes("investor") && !t.includes("investment in"))
      ) { type = "CAPEX"; score = 75; }

      // PURCHASE ORDER — strict, no solar/invest crossover
      else if (
        t.includes("purchase order") || t.includes("work order") ||
        t.includes("supply order") || t.includes("receipt of order") ||
        t.includes("order received") || t.includes("order secured") ||
        t.includes("major order") || t.includes("letter of acceptance") ||
        t.includes("rate contract") || t.includes("bagged") ||
        t.includes("contract awarded") || t.includes("loa") ||
        (
          t.includes("order") &&
          (t.includes("crore") || t.includes("lakh") || t.includes("₹") || t.includes("rs.")) &&
          !isNonOrder
        )
      ) { type = "ORDER"; score = 90; }

      // MERGER — strict, no equity stake / SPV / invest
      else if (
        t.includes("merger") || t.includes("amalgamation") ||
        (t.includes("acquisition") && !t.includes("solar") && !t.includes("invest") &&
         !t.includes("subscribe") && !t.includes("equity shares of") &&
         !t.includes("spv") && !t.includes("stake") && !t.includes("power"))
      ) { type = "MERGER"; score = 80; }

      else if (t.includes("result") || t.includes("quarterly")) { type = "RESULT";      score = 65; }
      else if (t.includes("insider") || t.includes("promoter") || t.includes("bulk deal")) { type = "INSIDER"; score = 70; }
      else if (t.includes("buyback"))    { type = "BUYBACK";     score = 78; }
      else if (t.includes("dividend"))   { type = "DIVIDEND";    score = 60; }
      else if (t.includes("partnership") || t.includes("joint venture") || t.includes("mou")) { type = "PARTNERSHIP"; score = 72; }

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
    // Must be a real purchase/supply order, not solar invest or tax order
    const isRealOrder = (t.includes("order") || t.includes("contract")) &&
      (t.includes("crore") || t.includes("₹") || t.includes("rs")) &&
      !t.includes("solar") && !t.includes("renewable") && !t.includes("invest") &&
      !t.includes("spv") && !t.includes("equity") && !t.includes("subscribe") &&
      !t.includes("income tax") && !t.includes("penalty") && !t.includes("nclt");
    if (!isRealOrder) return false;
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

  const filteredRadar = computedRadar.filter(r =>
    !radarQuery ||
    r.company.toLowerCase().includes(radarQuery.toLowerCase()) ||
    r.type.toLowerCase().includes(radarQuery.toLowerCase())
  );

  // ===== RADAR PANEL =====
  const RadarPanel = () => (
    <div className="panel radar-panel">
      <div className="panel-header">
        <span className="panel-title">
          📡 Radar <span className="count">{filteredRadar.length}</span>
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
      {filteredRadar.length === 0 ? (
        <div className="empty">No matches for "{radarQuery}"</div>
      ) : (
        filteredRadar.map((r, i) => (
          <div className="radar-card" key={i}>
            <div className="rc-top">
              <span className="co-name">{r.company}</span>
              <span className="score score-high">{r.score}</span>
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
            <LiveAgo receivedAt={r.receivedAt} exchangeTime={r.time} />
          </div>
        ))
      )}
    </div>
  );

  // ===== FEED PANEL =====
  const FeedPanel = () => (
    <div className="panel feed-panel">
      <div className="panel-header">
        <div style={{ display: "flex", gap: 4 }}>
          <button className={`tbtn ${activeTab === "bse" ? "active" : ""}`} onClick={() => setActiveTab("bse")}>BSE</button>
          <button className={`tbtn ${activeTab === "nse" ? "active" : ""}`} onClick={() => setActiveTab("nse")}>NSE</button>
        </div>
      </div>
      <div className="filter-bar">
        {FEED_FILTERS.map(f => (
          <button key={f} className={`fbtn ${feedFilter === f ? "active" : ""}`} onClick={() => setFeedFilter(f)}>{f}</button>
        ))}
      </div>
      {filteredFeed.length === 0 ? (
        <div className="empty">No signals match filter</div>
      ) : (
        filteredFeed.map((e, i) => {
          const cardClass = [
            "feed-card",
            e.type?.includes("ORDER")   ? "fc-order"  :
            e.type?.includes("MERGER")  ? "fc-merger" :
            e.type?.includes("RESULT")  ? "fc-result" :
            e.type?.includes("INSIDER") ? "fc-insider":
            e.type?.includes("CAPEX")   ? "fc-capex"  : "fc-news"
          ].join(" ");
          const hotWords = ["crore","cr","lakh","order","contract","merger","acquisition","fraud","penalty","rs"];
          return (
            <div className={cardClass} key={i}>
              <div className="fc-head">
                <span className="fc-company">
                  {e.company}
                  {e.type === "NEWS" && <span className="fc-tag-news">NEWS</span>}
                </span>
                {e.type !== "NEWS" && (
                  <Tag type={e.type} crores={e._orderInfo?.crores || extractAmount(e.title)} />
                )}
              </div>
              <div className="fc-text">
                {(e.title || "").split(" ").map((word, wi) => {
                  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
                  const isHot =
                    hotWords.indexOf(w) !== -1 ||
                    /[0-9]{2,}/.test(word) ||
                    word.indexOf("₹") !== -1;
                  return (
                    <span key={wi} className={isHot ? "fc-word-hot" : "fc-word"}>
                      {word}{" "}
                    </span>
                  );
                })}
              </div>
              <LiveAgo receivedAt={e.receivedAt} exchangeTime={e.time} />
            </div>
          );
        })
      )}
    </div>
  );

  // ===== RIGHT / DATA PANEL =====
  const RightPanel = () => (
    <div className="panel right-panel">
      <div className="section">
        <div className="section-divider">🔥 Mega Orders <span className="count">{computedMegaOrders.length}</span></div>
        {computedMegaOrders.length === 0 ? (
          <div className="empty">No mega orders yet</div>
        ) : (
          <div className="mega-grid">
            {computedMegaOrders.slice(0, 10).map((o, i) => {
              const mcapEntry = window._mcapDb?.find?.(m =>
                (m.company || "").toLowerCase() === (o.company || "").toLowerCase()
              );
              const mcap = mcapEntry?.mcap || 0;
              const pct = mcap > 0 ? ((o.crores / mcap) * 100).toFixed(1) : null;
              return (
                <div className="mega-card-grid" key={i}>
                  <div className="mega-company">{o.company}</div>
                  <div className="mega-val">₹{o.crores}Cr</div>
                  {pct && <div className="mega-pct">{pct}% of MCap</div>}
                  <div className="mega-time">{formatTime(o.time) || "—"}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-divider">💡 Opportunities <span className="count">{computedOpportunities.length}</span></div>
        {computedOpportunities.length === 0 ? (
          <div className="empty">No opportunities yet</div>
        ) : computedOpportunities.map((o, i) => (
          <div className="opp-card" key={i}>
            <div className="opp-row" style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="co-name">{o.company}</span>
              <span className="opp-pct">{o.score}%</span>
            </div>
            <div className="time-label">{formatTime(o.time) || "—"}</div>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-divider">🏭 Sectors <span className="count">{sector.length}</span></div>
        {sector.length === 0 ? (
          <div className="empty">No sector activity yet</div>
        ) : sector.map((s, i) => (
          <div className="sec-card" key={i}>
            <div className="sec-row">
              <span className="sec-name">{s.sector}</span>
              <span className="sec-val">₹{s.totalValue}Cr</span>
            </div>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-divider">📦 Order Book <span className="count">{orderBook.length}</span></div>
        {orderBook.length === 0 ? (
          <div className="empty">No orders tracked yet</div>
        ) : orderBook.map((o, i) => (
          <div className="ord-card" key={i}>
            <div className="ord-top">
              <span className="co-name">{o.company}</span>
              <span className="str-lbl building">BUILDING</span>
            </div>
            <div className="ord-stats"><span className="ord-val">₹{o.orderValue}Cr</span></div>
            <div className="time-label">{o.time || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );

  // ===== INTELLIGENCE PANEL =====
  const IntelPanel = () => (
    <div className="panel intelligence-panel">
      <div className="section">
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
  );

  return (
    <div className="terminal">
      <div className="header">
        <div className="header-left">
          <span className="star">★</span>
          <span className="title">Market Intelligence</span>
          <MarketStatus />
        </div>
      </div>

      {/* TICKER BAR — spans full width below header */}
      <TickerBar indices={marketIndices} assets={cryptoAssets} />

      {/* DESKTOP: All 4 panels in grid. MOBILE: hidden, controlled by mobilePanelTab */}
      <div className="layout desktop-layout">
        <RadarPanel />
        <FeedPanel />
        <RightPanel />
        <IntelPanel />
      </div>

      {/* MOBILE ONLY: tab-switched single panel view */}
      <div className="mobile-layout">
        <div className="mobile-tab-bar">
          {MOBILE_TABS.map(t => (
            <button
              key={t.key}
              className={`mobile-tab-btn ${mobilePanelTab === t.key ? "active" : ""}`}
              onClick={() => setMobilePanelTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="mobile-panel-wrap">
          {mobilePanelTab === "radar" && <RadarPanel />}
          {mobilePanelTab === "feed"  && <FeedPanel />}
          {mobilePanelTab === "data"  && <RightPanel />}
          {mobilePanelTab === "intel" && <IntelPanel />}
        </div>
      </div>
    </div>
  );
}
