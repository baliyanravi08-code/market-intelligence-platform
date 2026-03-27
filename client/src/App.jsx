import { useEffect, useState, useRef } from "react";
import "./App.css";

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

const NOISE_WORDS = [
  "trading window", "postal ballot", "scrutinizer", "voting result", "esg",
  "analyst meeting", "closure of trading", "book closure", "intimation of board meeting",
  "change in director", "change of address", "regulation 30", "compliance officer",
  "closure of board meeting", "trading window closure", "sebi pit",
  "unpaid dividend", "investor grievance", "loss of share certificate",
  "closure of trading window", "intimation for closure",
  "reg 30", "reg. 30", "lodr", "disclosure of material",
  "find the attached", "find attached", "enclosed herewith",
  "take this on record", "take on record", "intimation is enclosed",
  "please find", "kindly find", "outcome of the meeting",
  "outcome of board meeting", "intimation under regulation",
  "pursuant to regulation", "intimation pursuant"
];

// --- Utilities ---
function formatTime(raw) {
  if (!raw) return null;
  try {
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

function parseExchangeTime(raw) {
  if (!raw) return null;
  if (typeof raw === "number") return raw < 2e10 ? raw * 1000 : raw;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

function toAgo(ms) {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 0)  return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${sec}s ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

function extractAmount(text) {
  const match = text?.match(/(\d+(?:\.\d+)?)\s?(crore|cr)/i);
  return match ? parseFloat(match[1]) : 0;
}

// --- Components ---

function LiveAgo({ exchangeTime, receivedAt }) {
  const exMs = parseExchangeTime(exchangeTime);
  const [agoEx,  setAgoEx]  = useState(() => toAgo(exMs));
  const [agoRec, setAgoRec] = useState(() => toAgo(receivedAt));

  useEffect(() => {
    const tick = () => {
      setAgoEx(toAgo(exMs));
      setAgoRec(toAgo(receivedAt));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [exMs, receivedAt]);

  const delay = (exMs && receivedAt) ? Math.floor((receivedAt - exMs) / 1000) : null;
  const delayColor = delay === null ? null : delay < 30 ? "#00ff9c" : delay < 120 ? "#ffaa00" : "#ff5c5c";

  return (
    <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
      {exchangeTime && (
        <span style={{ fontSize: "9px", color: "#4a8adf", fontFamily: "IBM Plex Mono, monospace" }}>
          🕐 {formatTime(exchangeTime)} · {agoEx}
        </span>
      )}
      {receivedAt && (
        <span style={{ fontSize: "9px", color: "#ff9c00", fontFamily: "IBM Plex Mono, monospace" }}>
          ⬇ {agoRec}
        </span>
      )}
      {delay !== null && delay > 0 && delay < 86400 && (
        <span style={{ fontSize: "9px", color: delayColor, fontFamily: "IBM Plex Mono, monospace" }}>
          Δ {delay}s
        </span>
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
    <span style={{
      fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", fontWeight: 700,
      color: "#00ff9c", background: "#001a0a",
      border: "1px solid #00ff9c33", borderRadius: "3px", padding: "1px 6px"
    }}>
      ● LIVE
    </span>
  );
}

// ── Badge: upstox=green | connecting=blue | disconnected=amber | error=red ──
function DataSourceBadge({ source }) {
  if (source === "upstox") {
    return (
      <span style={{
        fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", fontWeight: 700,
        color: "#00ff9c", background: "#001a0a",
        border: "1px solid #00ff9c33", borderRadius: "3px", padding: "1px 6px", marginLeft: 4
      }}>
        ⚡ UPSTOX LIVE
      </span>
    );
  }
  if (source === "connecting" || !source) {
    return (
      <span style={{
        fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", fontWeight: 700,
        color: "#4a8adf", background: "#0a1020",
        border: "1px solid #4a8adf33", borderRadius: "3px", padding: "1px 6px", marginLeft: 4
      }}>
        ◌ CONNECTING...
      </span>
    );
  }
  // disconnected or error — both are clickable to open auth
  const isError = source === "error";
  return (
    <span
      style={{
        fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", fontWeight: 700,
        color:      isError ? "#ff5c5c" : "#ffaa00",
        background: isError ? "#1a0000" : "#1a1000",
        border:     `1px solid ${isError ? "#ff5c5c33" : "#ffaa0033"}`,
        borderRadius: "3px", padding: "1px 6px", marginLeft: 4,
        cursor: "pointer", textDecoration: "underline"
      }}
      title="Click to connect Upstox"
      onClick={() => window.open("/auth/upstox", "_blank")}
    >
      {isError ? "⚠ UPSTOX ERROR — reconnect" : "○ DISCONNECTED — connect Upstox"}
    </span>
  );
}

function LiveClock() {
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    })
  );
  useEffect(() => {
    const t = setInterval(() => {
      setTime(new Date().toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      }));
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

function TickerBar({ indices, assets, dataSource, tickerStale }) {
  const session = getSession();
  return (
    <div className="ticker-bar">
      {indices.map((m, i) => {
        const isUp   = m.up === true;
        const isDown = m.up === false;
        const cls    = isUp ? "up" : isDown ? "down" : "flat";
        const isDash = m.price === "—";
        return (
          <div className="ticker-item" key={`idx-${i}`} style={isDash ? { opacity: 0.4 } : {}}>
            <span className="ticker-name">{m.name}</span>
            <span className="ticker-price">{m.price}</span>
            <span className={`ticker-change ${cls}`}>
              {isUp ? "▲" : isDown ? "▼" : "●"} {m.change} ({m.pct})
            </span>
          </div>
        );
      })}
      {assets.length > 0 && <div className="ticker-sep">│</div>}
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
        {tickerStale && (
          <span style={{
            fontSize: "9px", color: "#ff5c5c", fontFamily: "IBM Plex Mono, monospace",
            background: "#1a0000", border: "1px solid #ff5c5c33",
            borderRadius: "3px", padding: "1px 6px", marginRight: 4
          }}>
            ⚠ STALE
          </span>
        )}
        <DataSourceBadge source={dataSource} />
        <LiveClock />
        <span className={`ticker-session ${session.cls}`}>{session.label}</span>
      </div>
    </div>
  );
}

const MOBILE_TABS = [
  { key: "feed",  label: "📡 Feed"  },
  { key: "radar", label: "🔍 Radar" },
  { key: "data",  label: "📊 Data"  },
  { key: "intel", label: "⚡ Intel" },
];

export default function App() {
  const [marketIndices, setMarketIndices] = useState([
    { name: "NIFTY 50",   price: "—", change: "—", pct: "—", up: null },
    { name: "SENSEX",     price: "—", change: "—", pct: "—", up: null },
    { name: "BANK NIFTY", price: "—", change: "—", pct: "—", up: null },
  ]);
  // "connecting" | "upstox" | "disconnected" | "error"
  const [tickerSource,   setTickerSource]   = useState("connecting");
  const [tickerLastOk,   setTickerLastOk]   = useState(null);
  const [tickerStale,    setTickerStale]    = useState(false);

  const [bseEvents,      setBseEvents]      = useState([]);
  const [nseEvents,      setNseEvents]      = useState([]);
  const [sector,         setSector]         = useState([]);
  const [orderBook,      setOrderBook]      = useState([]);
  const [radarQuery,     setRadarQuery]     = useState("");
  const [activeTab,      setActiveTab]      = useState("bse");
  const [feedFilter,     setFeedFilter]     = useState("ALL");
  const [mobilePanelTab, setMobilePanelTab] = useState("feed");
  const [cryptoAssets,   setCryptoAssets]   = useState([]);

  // ── Stale watchdog ────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      if (tickerLastOk && Date.now() - tickerLastOk > 90000) setTickerStale(true);
    }, 10000);
    return () => clearInterval(t);
  }, [tickerLastOk]);

  // ── Fetch BTC / PI / Gold / Silver ───────────────────────────────────────
  // Note: Silver still uses Yahoo Finance (SI=F) — Upstox doesn't carry commodities
  useEffect(() => {
    const fmt = (n, prefix = "$") => {
      if (!n && n !== 0) return "—";
      if (n >= 1000) return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
      if (n >= 1)    return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
      return prefix + n.toFixed(4);
    };

    const fetchAssets = async () => {
      const assets = [];
      try {
        const cgRes = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,pi-network,tether-gold&vs_currencies=usd&include_24hr_change=true",
          { headers: { "Accept": "application/json" } }
        );
        const cg = await cgRes.json();
        if (cg?.bitcoin) assets.push({
          name: "BTC", icon: "₿", type: "crypto",
          price: fmt(cg.bitcoin.usd), change24h: cg.bitcoin.usd_24h_change || 0
        });
        if (cg?.["pi-network"]) assets.push({
          name: "PI", icon: "π", type: "crypto",
          price: fmt(cg["pi-network"].usd), change24h: cg["pi-network"].usd_24h_change || 0
        });
        if (cg?.["tether-gold"]) assets.push({
          name: "GOLD", icon: "Au", type: "gold",
          price: fmt(cg["tether-gold"].usd), change24h: cg["tether-gold"].usd_24h_change || 0
        });
      } catch (e) {
        console.error("CoinGecko error:", e);
        assets.push({ name: "BTC",  icon: "₿",  type: "crypto", price: "—", change24h: 0 });
        assets.push({ name: "PI",   icon: "π",  type: "crypto", price: "—", change24h: 0 });
        assets.push({ name: "GOLD", icon: "Au", type: "gold",   price: "—", change24h: 0 });
      }

      // Silver — Yahoo Finance only source for this commodity
      let silverPrice = 33.50, silverChange = 0;
      try {
        const r = await fetch(
          "https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=2d",
          { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
        );
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice && meta.regularMarketPrice > 5) {
          silverPrice = meta.regularMarketPrice;
          const prev = meta.previousClose || meta.chartPreviousClose;
          if (prev) silverChange = ((silverPrice - prev) / prev) * 100;
        }
      } catch (e) {
        console.warn("Silver fetch failed, using fallback:", e.message);
      }
      assets.push({ name: "SILVER", icon: "Ag", type: "silver", price: fmt(silverPrice), change24h: silverChange });
      setCryptoAssets(assets);
    };

    fetchAssets();
    const interval = setInterval(fetchAssets, 60000);
    return () => clearInterval(interval);
  }, []);

  // ── Fetch events every 15s ────────────────────────────────────────────────
  useEffect(() => {
    const fetchEvents = () => {
      fetch("/api/events")
        .then(r => r.json())
        .then(data => {
          setBseEvents(data.bse       || []);
          setNseEvents(data.nse       || []);
          setOrderBook(data.orderBook || []);
          setSector(data.sectors      || []);
          window._mcapDb = data.mcapDb || [];
        })
        .catch(err => console.log("Events fetch error:", err));
    };
    fetchEvents();
    const interval = setInterval(fetchEvents, 15000);
    return () => clearInterval(interval);
  }, []);

  // ── Market indices — Upstox only, self-scheduling retry loop ─────────────
  // Success (upstox)      → schedule next poll in 30s, reset backoff
  // Disconnected / error  → retry with backoff: 3s→6s→12s→24s→30s cap
  // Network error         → same backoff, sets source to "error"
  // AbortController       → prevents stale responses after unmount
  const retryRef   = useRef(null);
  const retryDelay = useRef(3000);
  const abortRef   = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const doFetch = async () => {
      if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();

      try {
        const res  = await fetch("/api/market", { signal: abortRef.current.signal });
        const data = await res.json();
        if (cancelled) return;

        if (Array.isArray(data)) {
          const indices    = data.filter(d => d.name && !d._source);
          const sourceMeta = data.find(d => d._source);
          const src        = sourceMeta?._source || "disconnected";

          setTickerSource(src);

          if (src === "upstox") {
            if (indices.length) setMarketIndices(indices);
            setTickerLastOk(Date.now());
            setTickerStale(false);
            retryDelay.current = 3000;
            retryRef.current = setTimeout(doFetch, 30000); // normal 30s poll
          } else {
            // disconnected or error — keep retrying fast until connected
            console.log(`Upstox ${src} — retry in ${retryDelay.current / 1000}s`);
            retryRef.current = setTimeout(doFetch, retryDelay.current);
            retryDelay.current = Math.min(retryDelay.current * 2, 30000);
          }
        }
      } catch (e) {
        if (cancelled || e.name === "AbortError") return;
        console.warn(`Market fetch network error, retry in ${retryDelay.current / 1000}s:`, e.message);
        setTickerSource("error");
        retryRef.current = setTimeout(doFetch, retryDelay.current);
        retryDelay.current = Math.min(retryDelay.current * 2, 30000);
      }
    };

    doFetch();

    return () => {
      cancelled = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // ── Deduplicated + filtered feed ─────────────────────────────────────────
  const seenFeedKeys = new Set();
  const filteredFeed = (activeTab === "bse" ? bseEvents : nseEvents).filter(e => {
    const t = (e?.title || "").toLowerCase();
    if (NOISE_WORDS.some(w => t.includes(w))) return false;
    const key = `${e.company}||${(e.title || "").substring(0, 60)}`;
    if (seenFeedKeys.has(key)) return false;
    seenFeedKeys.add(key);
    if (feedFilter === "ALL") return true;
    if (feedFilter === ">50") return (e._orderInfo?.crores || extractAmount(e.title || "")) >= 50;
    return (e.type || "NEWS").toUpperCase().includes(feedFilter);
  });

  // ── computedRadar ─────────────────────────────────────────────────────────
  const seenRadarKeys = new Set();
  const computedRadar = [
    ...(bseEvents || []).map(e => ({ ...e, _exchange: "BSE" })),
    ...(nseEvents  || []).map(e => ({ ...e, _exchange: "NSE" }))
  ]
    .filter(e => {
      const t = (e?.title || "").toLowerCase();
      if (NOISE_WORDS.some(w => t.includes(w))) return false;
      const key = `${e.company}||${(e.title || "").substring(0, 60)}`;
      if (seenRadarKeys.has(key)) return false;
      seenRadarKeys.add(key);
      return true;
    })
    .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))
    .slice(0, 100)
    .map(e => {
      const t = (e?.title || "").toLowerCase();
      let type = "NEWS", score = 10;
      const isNonOrder = (
        t.includes("solar") || t.includes("renewable") || t.includes("green energy") ||
        t.includes("spv")   || t.includes("equity stake") || t.includes("power purchase") ||
        t.includes("subscribe") || t.includes("invest") ||
        t.includes("income tax") || t.includes("assessment") || t.includes("tax demand") ||
        t.includes("penalty") || t.includes("nclt")
      );
      if (t.includes("fraud") || t.includes("insolvency") || t.includes("default")) {
        type = "RISK"; score = 95;
      } else if (t.includes("penalty") || t.includes("nclt")) {
        type = "RISK"; score = 85;
      } else if (
        t.includes("solar") || t.includes("renewable") || t.includes("green energy") ||
        t.includes("power purchase") || t.includes("spv") ||
        (t.includes("equity stake") || (t.includes("subscribe") && t.includes("equity"))) ||
        t.includes("capex") || t.includes("greenfield") || t.includes("brownfield") ||
        t.includes("expansion") ||
        (t.includes("invest") && !t.includes("investor") && !t.includes("investment in"))
      ) {
        type = "CAPEX"; score = 75;
      } else if (
        t.includes("purchase order") || t.includes("work order") ||
        t.includes("supply order")   || t.includes("receipt of order") ||
        t.includes("order received") || t.includes("order secured") ||
        t.includes("major order")    || t.includes("letter of acceptance") ||
        t.includes("rate contract")  || t.includes("bagged") ||
        t.includes("contract awarded") || t.includes("loa") ||
        (t.includes("order") &&
          (t.includes("crore") || t.includes("lakh") || t.includes("₹") || t.includes("rs.")) &&
          !isNonOrder)
      ) {
        type = "ORDER"; score = 90;
      } else if (
        t.includes("merger") || t.includes("amalgamation") ||
        (t.includes("acquisition") && !t.includes("solar") && !t.includes("invest") &&
         !t.includes("subscribe") && !t.includes("equity shares of") &&
         !t.includes("spv") && !t.includes("stake") && !t.includes("power"))
      ) {
        type = "MERGER"; score = 80;
      } else if (t.includes("buyback")) {
        type = "BUYBACK"; score = 78;
      } else if (t.includes("result") || t.includes("quarterly")) {
        type = "RESULT"; score = 65;
      } else if (t.includes("insider") || t.includes("promoter") || t.includes("bulk deal")) {
        type = "INSIDER"; score = 70;
      } else if (t.includes("dividend")) {
        type = "DIVIDEND"; score = 60;
      } else if (t.includes("partnership") || t.includes("joint venture") || t.includes("mou")) {
        type = "PARTNERSHIP"; score = 72;
      }
      return {
        company:    e?.company || "Unknown",
        score, type,
        exchange:   e._exchange || "BSE",
        receivedAt: e?.receivedAt,
        time:       e?.time,
        pdfUrl:     e?.pdfUrl || e?.attachment || null,
        orderValue: extractAmount(e?.title)
      };
    });

  // ── Mega orders ───────────────────────────────────────────────────────────
  const computedMegaOrders = (bseEvents || []).filter(e => {
    const t = (e?.title || "").toLowerCase();
    const isRealOrder =
      (t.includes("order") || t.includes("contract")) &&
      (t.includes("crore") || t.includes("₹") || t.includes("rs")) &&
      !t.includes("solar") && !t.includes("renewable") && !t.includes("invest") &&
      !t.includes("spv") && !t.includes("equity") && !t.includes("subscribe") &&
      !t.includes("income tax") && !t.includes("penalty") && !t.includes("nclt");
    if (!isRealOrder) return false;
    const cr = e._orderInfo?.crores || extractAmount(e.title);
    if (!cr) return false;
    const mcapEntry = window._mcapDb?.find?.(m =>
      (m.company || "").toLowerCase() === (e.company || "").toLowerCase()
    );
    const mcap = mcapEntry?.mcap || 0;
    return cr >= 500 || (mcap > 0 && (cr / mcap) >= 0.08);
  })
    .sort((a, b) =>
      (b._orderInfo?.crores || extractAmount(b.title)) -
      (a._orderInfo?.crores || extractAmount(a.title))
    )
    .slice(0, 10)
    .map(e => ({
      company: e.company,
      crores:  e._orderInfo?.crores || extractAmount(e.title),
      receivedAt: e.receivedAt,
      time:    e.time
    }));

  // ── Opportunities ─────────────────────────────────────────────────────────
  const seenOpp = new Set();
  const computedOpportunities = computedRadar
    .filter(r => {
      if (r.score < 70) return false;
      const key = `${r.company}||${r.type}`;
      if (seenOpp.has(key)) return false;
      seenOpp.add(key);
      return true;
    })
    .slice(0, 5)
    .map(r => ({ company: r.company, score: r.score, type: r.type, receivedAt: r.receivedAt, time: r.time }));

  const filteredRadar = computedRadar.filter(r =>
    !radarQuery ||
    r.company.toLowerCase().includes(radarQuery.toLowerCase()) ||
    r.type.toLowerCase().includes(radarQuery.toLowerCase())
  );

  // ── RADAR PANEL ───────────────────────────────────────────────────────────
  const RadarPanel = () => (
    <div className="panel radar-panel">
      <div className="panel-header">
        <span className="panel-title">📡 Radar <span className="count">{filteredRadar.length}</span></span>
      </div>
      <div className="search-wrap">
        <span className="search-icon">⌕</span>
        <input
          type="text" className="radar-search"
          placeholder="Search company, type..."
          value={radarQuery}
          onChange={e => setRadarQuery(e.target.value)}
        />
        {radarQuery && <button className="clear-btn" onClick={() => setRadarQuery("")}>✕</button>}
      </div>
      {filteredRadar.length === 0 ? (
        <div className="empty">No matches for "{radarQuery}"</div>
      ) : filteredRadar.map((r, i) => (
        <div className="radar-card" key={i}>
          <div className="rc-top">
            <span className="co-name">{r.company}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{
                fontSize: "9px", fontWeight: 700, padding: "1px 5px", borderRadius: "3px",
                background: r.exchange === "BSE" ? "#1a2a4a" : "#1a3a2a",
                color:      r.exchange === "BSE" ? "#4a9eff" : "#00ff9c",
                border:     r.exchange === "BSE" ? "1px solid #4a9eff44" : "1px solid #00ff9c44"
              }}>{r.exchange}</span>
              <span style={{
                background:   r.score >= 80 ? "#ff2d5522" : r.score >= 60 ? "#ff9c0022" : "#ffffff11",
                color:        r.score >= 80 ? "#ff2d55"   : r.score >= 60 ? "#ff9c00"   : "#666",
                border:       r.score >= 80 ? "1px solid #ff2d5544" : r.score >= 60 ? "1px solid #ff9c0044" : "1px solid #333",
                borderRadius: "3px", padding: "1px 6px", fontSize: "10px", fontWeight: 700
              }}>{r.score}</span>
            </div>
          </div>
          <div className="tag-row">
            <span className={`type type-${r.type}`}>{r.type}</span>
            {r.orderValue > 0 && <span className="order-val">₹{r.orderValue}Cr</span>}
            {r.pdfUrl && <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="filing-link">📄 Filing</a>}
          </div>
          <LiveAgo exchangeTime={r.time} receivedAt={r.receivedAt} />
        </div>
      ))}
    </div>
  );

  // ── FEED PANEL ────────────────────────────────────────────────────────────
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
      ) : filteredFeed.map((e, i) => {
        const cardClass = ["feed-card",
          e.type?.includes("ORDER")   ? "fc-order"   :
          e.type?.includes("MERGER")  ? "fc-merger"  :
          e.type?.includes("RESULT")  ? "fc-result"  :
          e.type?.includes("INSIDER") ? "fc-insider" :
          e.type?.includes("CAPEX")   ? "fc-capex"   : "fc-news"
        ].join(" ");
        const hotWords = ["crore","cr","lakh","order","contract","merger","acquisition","fraud","penalty","rs"];
        const pdfUrl = e.pdfUrl || e.attachment || e.url || null;
        return (
          <div className={cardClass} key={i}
            onClick={() => pdfUrl && window.open(pdfUrl, "_blank", "noopener")}
            style={{ cursor: pdfUrl ? "pointer" : "default" }}
          >
            <div className="fc-head">
              <span className="fc-company">
                {e.company}
                {e.type === "NEWS" && <span className="fc-tag-news">NEWS</span>}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                {e.type !== "NEWS" && <Tag type={e.type} crores={e._orderInfo?.crores || extractAmount(e.title)} />}
                {pdfUrl && (
                  <a href={pdfUrl} target="_blank" rel="noreferrer" className="filing-link"
                    onClick={ev => ev.stopPropagation()}>📄 Filing</a>
                )}
              </div>
            </div>
            <div className="fc-text">
              {(e.title || "").split(" ").map((word, wi) => {
                const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
                const isHot = hotWords.indexOf(w) !== -1 || /[0-9]{2,}/.test(word) || word.indexOf("₹") !== -1;
                return <span key={wi} className={isHot ? "fc-word-hot" : "fc-word"}>{word}{" "}</span>;
              })}
            </div>
            <LiveAgo exchangeTime={e.time} receivedAt={e.receivedAt} />
          </div>
        );
      })}
    </div>
  );

  // ── RIGHT / DATA PANEL ────────────────────────────────────────────────────
  const RightPanel = () => (
    <div className="panel right-panel">
      <div className="section">
        <div className="section-divider">🔥 Mega Orders <span className="count">{computedMegaOrders.length}</span></div>
        {computedMegaOrders.length === 0 ? <div className="empty">No mega orders yet</div> : (
          <div className="mega-grid">
            {computedMegaOrders.slice(0, 10).map((o, i) => {
              const mcapEntry = window._mcapDb?.find?.(m =>
                (m.company || "").toLowerCase() === (o.company || "").toLowerCase()
              );
              const mcap = mcapEntry?.mcap || 0;
              const pct  = mcap > 0 ? ((o.crores / mcap) * 100).toFixed(1) : null;
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
        {computedOpportunities.length === 0 ? <div className="empty">No opportunities yet</div>
          : computedOpportunities.map((o, i) => (
          <div className="opp-card" key={i}>
            <div className="opp-row" style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="co-name">{o.company}</span>
              <span className="opp-pct">{o.score}%</span>
            </div>
            <span className={`type type-${o.type}`} style={{ fontSize: "8px", marginTop: 2 }}>{o.type}</span>
            <div className="time-label" style={{ marginTop: 3 }}>{formatTime(o.time) || "—"}</div>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-divider">🏭 Sectors <span className="count">{sector.length}</span></div>
        {sector.length === 0 ? <div className="empty">No sector activity yet</div>
          : sector.map((s, i) => (
          <div className="sec-card" key={i}>
            <div className="sec-row">
              <span className="sec-name">{s.sector}</span>
              <span className="sec-val">
                {s.totalValue ? `₹${s.totalValue}Cr` : s.count ? `${s.count} filing${s.count > 1 ? "s" : ""}` : "—"}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="section">
        <div className="section-divider">📦 Order Book <span className="count">{orderBook.length}</span></div>
        {orderBook.length === 0 ? <div className="empty">No orders tracked yet</div>
          : orderBook.map((o, i) => (
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

  // ── INTELLIGENCE PANEL ────────────────────────────────────────────────────
  const IntelPanel = () => {
    const srcLabel =
      tickerSource === "upstox"       ? "⚡ Upstox Live"  :
      tickerSource === "disconnected" ? "○ Disconnected"  :
      tickerSource === "error"        ? "⚠ Error"         :
                                        "◌ Connecting...";
    const srcColor =
      tickerSource === "upstox" ? "#00ff9c" :
      tickerSource === "error"  ? "#ff5c5c" : "#ffaa00";
    return (
      <div className="panel intelligence-panel">
        <div className="section">
          <div className="section-divider">🔔 Alerts</div>
          {computedRadar.slice(0, 5).map((e, i) => (
            <div key={i} className="mini-card">
              <span style={{ color: "#d8eeff" }}>{e.company}</span>
              <span style={{ color: "#4a7090" }}> → </span>
              <span className={`type type-${e.type}`} style={{ fontSize: "8px", padding: "1px 4px" }}>{e.type}</span>
            </div>
          ))}
        </div>
        <div className="section">
          <div className="section-divider">⚡ Pulse</div>
          <div className="mini-card" style={{ color: "#4a8adf" }}>Orders Tracked: {orderBook.length}</div>
          <div className="mini-card" style={{ color: "#4a8adf" }}>Active Signals: {computedRadar.length}</div>
          <div className="mini-card" style={{ color: "#4a8adf" }}>BSE Events: {bseEvents.length}</div>
          <div className="mini-card" style={{ color: "#4a8adf" }}>NSE Events: {nseEvents.length}</div>
          <div className="mini-card" style={{ color: srcColor }}>Index Feed: {srcLabel}</div>
        </div>
      </div>
    );
  };

  const needsConnect = tickerSource === "disconnected" || tickerSource === "error";

  return (
    <div className="terminal">
      <div className="header">
        <div className="header-left">
          <span className="star">★</span>
          <span className="title">Market Intelligence</span>
          <MarketStatus />
          {needsConnect && (
            <span
              style={{
                fontSize: "9px", fontFamily: "IBM Plex Mono, monospace",
                color: "#ffaa00", cursor: "pointer", marginLeft: 6,
                textDecoration: "underline"
              }}
              onClick={() => window.open("/auth/upstox", "_blank")}
              title="Click to connect Upstox for real-time NIFTY / SENSEX data"
            >
              Connect Upstox →
            </span>
          )}
        </div>
      </div>

      <TickerBar
        indices={marketIndices}
        assets={cryptoAssets}
        dataSource={tickerSource}
        tickerStale={tickerStale}
      />

      <div className="layout desktop-layout">
        <RadarPanel />
        <FeedPanel />
        <RightPanel />
        <IntelPanel />
      </div>

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
