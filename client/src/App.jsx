import { useEffect, useState, useRef } from "react";
import { io as socketIO } from "socket.io-client";
import "./App.css";
import CircuitAlerts from "./components/CircuitAlerts";
import OptionChain from "./pages/OptionChain";
import ScoresPage from "./pages/ScoresPage";
import OptionsIntelligencePage from "./pages/OptionsIntelligencePage";
import GannBadge from "./components/GannBadge";

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

const MOBILE_TABS = [
  { key: "feed",         label: "📡 Feed"    },
  { key: "radar",        label: "🔍 Radar"   },
  { key: "data",         label: "📊 Data"    },
  { key: "intel",        label: "⚡ Intel"   },
  { key: "options-intel",label: "📐 OI Intel"},
];

function getCurrentQuarter() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  if (month >= 4  && month <= 6)  return { label: "Q1", range: "Apr–Jun", fyYear: year + 1 };
  if (month >= 7  && month <= 9)  return { label: "Q2", range: "Jul–Sep", fyYear: year + 1 };
  if (month >= 10 && month <= 12) return { label: "Q3", range: "Oct–Dec", fyYear: year + 1 };
  return { label: "Q4", range: "Jan–Mar", fyYear: year };
}

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

// ─── INTELLIGENCE ENGINE ──────────────────────────────────────────────────────

const RISK_REGISTRY = [
  { match: "indusind",  type: "GOVERNANCE", severity: "HIGH", desc: "CEO departure + RBI inquiry pending" },
  { match: "paytm",    type: "REGULATORY", severity: "HIGH", desc: "RBI payment bank restrictions" },
  { match: "adani",    type: "LEGAL",      severity: "HIGH", desc: "Ongoing DOJ indictment proceedings" },
  { match: "byju",     type: "INSOLVENCY", severity: "HIGH", desc: "NCLT insolvency proceedings active" },
  { match: "yes bank", type: "GOVERNANCE", severity: "MED",  desc: "Promoter pledge concerns" },
  { match: "vodafone", type: "DEBT",       severity: "MED",  desc: "AGR dues + spectrum debt pressure" },
];

function detectRiskFromText(title = "") {
  const t = title.toLowerCase();
  if (t.includes("fraud") || t.includes("insolvency") || t.includes("default"))
    return { type: "FRAUD/INSOLVENCY", severity: "HIGH", desc: "Fraud or insolvency mention in filing" };
  if (t.includes("nclt") || t.includes("liquidation"))
    return { type: "LEGAL", severity: "HIGH", desc: "NCLT / liquidation proceedings" };
  if (t.includes("penalty") && (t.includes("crore") || t.includes("lakh")))
    return { type: "PENALTY", severity: "MED", desc: "Regulatory penalty detected" };
  if (t.includes("sebi") && (t.includes("notice") || t.includes("order") || t.includes("show cause")))
    return { type: "REGULATORY", severity: "HIGH", desc: "SEBI enforcement action" };
  if (t.includes("rbi") && (t.includes("penalty") || t.includes("directive") || t.includes("action")))
    return { type: "REGULATORY", severity: "HIGH", desc: "RBI enforcement action" };
  if (t.includes("income tax") || t.includes("tax demand") || t.includes("assessment order"))
    return { type: "TAX", severity: "MED", desc: "Tax demand / assessment notice" };
  if (t.includes("promoter") && t.includes("sell"))
    return { type: "INSIDER", severity: "MED", desc: "Promoter selling detected" };
  return null;
}

function getRegistryRisk(companyName = "") {
  const c = companyName.toLowerCase();
  return RISK_REGISTRY.find(r => c.includes(r.match)) || null;
}

function getContradict(companyName, title) {
  const registryRisk = getRegistryRisk(companyName);
  if (registryRisk && registryRisk.severity === "HIGH") return registryRisk;
  const textRisk = detectRiskFromText(title);
  if (textRisk && textRisk.severity === "HIGH") return textRisk;
  return null;
}

function getSoftRisk(companyName, title) {
  const registryRisk = getRegistryRisk(companyName);
  if (registryRisk && registryRisk.severity === "MED") return registryRisk;
  const textRisk = detectRiskFromText(title);
  if (textRisk && textRisk.severity === "MED") return textRisk;
  return null;
}

function estimatePriceImpact(type, crores, companyTitle = "") {
  const t = companyTitle.toLowerCase();
  let base = 0;
  if (type === "ORDER")   base = crores >= 500 ? 4.5 : crores >= 100 ? 2.8 : 1.5;
  if (type === "MERGER")  base = 8.0;
  if (type === "CAPEX")   base = 2.2;
  if (type === "RESULT")  base = t.includes("profit") ? 3.5 : t.includes("loss") ? -4.0 : 1.0;
  if (type === "INSIDER") base = t.includes("buy") ? 2.5 : -2.0;
  if (type === "RISK")    base = -6.5;
  return base;
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

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

// ─── COMPOSITE SCORE BADGE ────────────────────────────────────────────────────

function CompositeScoreBadge({ symbol, compositeMap }) {
  if (!symbol || !compositeMap) return null;
  const score = compositeMap[symbol] || compositeMap[symbol?.toUpperCase()];
  if (!score) return null;

  const colors = { A: "#00ff88", B: "#4fc3f7", C: "#ffd54f", D: "#ff8a65", F: "#ef5350" };
  const color  = colors[score.grade] || "#546e7a";

  return (
    <span
      title={`Composite: ${score.finalScore} · ${score.bias} · ${score.top3Reasons?.[0]?.label || ""}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        padding: "1px 6px", borderRadius: 3,
        background: `${color}18`,
        border: `1px solid ${color}40`,
        fontSize: 10, fontWeight: 700, color,
        fontFamily: "'IBM Plex Mono', monospace",
        cursor: "default", flexShrink: 0,
      }}
    >
      ⚡{score.finalScore}
      <span style={{ fontSize: 9, opacity: 0.7 }}>{score.grade}</span>
    </span>
  );
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function LiveAgo({ exchangeTime, receivedAt }) {
  const exMs = parseExchangeTime(exchangeTime);
  const [agoEx, setAgoEx] = useState(() => toAgo(exMs));

  useEffect(() => {
    const tick = () => setAgoEx(toAgo(exMs));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [exMs]);

  const delay = (exMs && receivedAt)
    ? Math.floor((receivedAt - exMs) / 1000) : null;
  const delayColor = delay === null ? null
    : delay < 30 ? "#00ff9c" : delay < 120 ? "#ffaa00" : "#ff5c5c";

  return (
    <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "9px", color: "#2a7090", marginLeft: "auto", flexShrink: 0 }}>
      {exchangeTime && `${formatTime(exchangeTime)} · ${agoEx}`}
      {delay !== null && delay > 0 && delay < 86400 && (
        <span style={{ color: delayColor, marginLeft: 5 }}>Δ{delay}s</span>
      )}
    </span>
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
  return <span className="live-badge">● LIVE</span>;
}

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

// ─── TICKER MODAL — FIXED ─────────────────────────────────────────────────────
// ONLY CHANGE: replaced broken Upstox redirect (type:"upstox") with embedded
// TradingView iframe for all Indian indices. Everything else is identical.

function TickerModal({ item, onClose }) {
  if (!item) return null;

  // ── FIX: unified TV symbol map (replaces the old getChartConfig) ──────────
  const TV_SYMBOLS = {
  "NIFTY 50":   "NIFTY_INDEX:NIFTY50",
  "SENSEX":     "NIFTY_INDEX:SENSEX",
  "BANK NIFTY": "NIFTY_INDEX:BANKNIFTY",
  "BTC":        "BINANCE:BTCUSDT",
  "GOLD":       "TVC:GOLD",
  "SILVER":     "TVC:SILVER",
};
  const tvSymbol = TV_SYMBOLS[item.name] || null;
  const isPI     = item.name === "PI";
  // ─────────────────────────────────────────────────────────────────────────

  const isUp   = item.up === true  || (item.change24h ?? 0) > 0;
  const isDown = item.up === false || (item.change24h ?? 0) < 0;
  const color  = isUp ? "#00ff9c" : isDown ? "#ff5c5c" : "#4a9abb";
  const arrow  = isUp ? "▲" : isDown ? "▼" : "●";
  const changeTxt = item.change && item.change !== "—"
    ? `${item.change}${item.pct && item.pct !== "—" ? ` (${item.pct})` : ""}`
    : item.change24h != null ? `${Math.abs(item.change24h).toFixed(2)}%` : "";

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)", backdropFilter: "blur(4px)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "#030e1e", border: "1px solid #0d3560", borderRadius: 10, width: "94vw", maxWidth: 760, maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 0 60px rgba(0,150,255,0.18)", overflow: "hidden" }}
      >
        {/* Header — unchanged */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "14px 16px 12px", borderBottom: "1px solid #0a2540", background: "linear-gradient(90deg, #020d1f, #041828)", flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 13, fontWeight: 700, color: "#00cfff" }}>{item.name}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
              <span style={{ fontSize: 20, fontWeight: 700, color, fontFamily: "IBM Plex Mono, monospace" }}>{item.price}</span>
              {changeTxt && <span style={{ fontSize: 11, color, fontFamily: "IBM Plex Mono, monospace" }}>{arrow} {changeTxt}</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#2a5070", fontSize: 18, cursor: "pointer", padding: "0 0 0 12px", flexShrink: 0 }}>✕</button>
        </div>

        {/* Chart body — FIXED: all known symbols now render a TV iframe */}
        <div style={{ flex: 1, minHeight: 420, flexShrink: 0 }}>
          {tvSymbol && (
            <iframe
              key={tvSymbol}
              src={
                "https://s.tradingview.com/widgetembed/?frameElementId=tv_chart" +
                "&symbol=" + encodeURIComponent(tvSymbol) +
                "&interval=5" +
                "&hidesidetoolbar=0&hidetoptoolbar=0&symboledit=0&saveimage=0" +
                "&toolbarbg=020c1a&theme=dark&style=1&timezone=Asia%2FKolkata" +
                "&withdateranges=1&showpopupbutton=1&locale=en"
              }
              style={{ width: "100%", height: "100%", border: "none", display: "block", minHeight: 420 }}
              allowFullScreen
              title={item.name + " Chart"}
            />
          )}

          {/* PI network — no TV widget */}
          {isPI && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 420, color: "#2a6070", fontFamily: "IBM Plex Mono, monospace", fontSize: 12, gap: 8 }}>
              <span style={{ fontSize: 32 }}>π</span>
              <span>Chart not available for {item.name}</span>
              <a href="https://coinmarketcap.com/currencies/pi-network/" target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: "#00cfff", fontSize: 10 }}>View on CoinMarketCap ↗</a>
            </div>
          )}

          {/* Unknown ticker */}
          {!tvSymbol && !isPI && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 420, color: "#2a6070", fontFamily: "IBM Plex Mono, monospace", fontSize: 12, gap: 8 }}>
              <span style={{ fontSize: 32 }}>📊</span>
              <span>Chart not available for {item.name}</span>
            </div>
          )}
        </div>

        {/* Footer — unchanged */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderTop: "1px solid #0a2540", background: "#020b18", flexShrink: 0 }}>
          <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9, color: "#1a4060" }}>
            {tvSymbol
              ? "TradingView · 5-min chart · NIFTY Index data"
              : isPI
              ? "π PI Network · CoinMarketCap"
              : ""}
          </span>
          {tvSymbol && (
            <a
              href={"https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(tvSymbol)}
              target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 9, color: "#00cfff", textDecoration: "none", opacity: 0.8 }}
            >
              Open Full Chart ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── TICKER BAR ───────────────────────────────────────────────────────────────

function TickerBar({ indices, assets, dataSource, tickerStale, onTickerClick }) {
  const session = getSession();
  return (
    <div className="ticker-bar">
      {indices.map((m, i) => {
        const isUp   = m.up === true;
        const isDown = m.up === false;
        const cls    = isUp ? "up" : isDown ? "down" : "flat";
        const isDash = m.price === "—";
        return (
          <div className="ticker-item ticker-clickable" key={`idx-${i}`} style={isDash ? { opacity: 0.4 } : {}} onClick={() => !isDash && onTickerClick(m)} title={`Click to view ${m.name} chart`}>
            <span className="ticker-name">{m.name}</span>
            <span key={m._ts || m.price} className={`ticker-price${m._ts ? " blink" : ""}`}>{m.price}</span>
            <span className={`ticker-change ${cls}`}>{isUp ? "▲" : isDown ? "▼" : "●"} {m.change} ({m.pct})</span>
          </div>
        );
      })}
      {assets.length > 0 && <div className="ticker-sep">│</div>}
      {assets.map((a, i) => {
        const isUp   = a.change24h > 0;
        const isDown = a.change24h < 0;
        const cls    = isUp ? "up" : isDown ? "down" : "flat";
        const isDash = !a.price || a.price === "—" || a.price === "$0.0000";
        return (
          <div className={`ticker-item secondary${isDash ? "" : " ticker-clickable"}`} key={`asset-${i}`} style={isDash ? { opacity: 0.4, cursor: "default" } : { cursor: "pointer" }} onClick={() => !isDash && onTickerClick(a)} title={isDash ? `${a.name} — loading...` : `Click to view ${a.name} chart`}>
            <span className={`ticker-asset-icon ${a.type}`}>{a.icon}</span>
            <span className="ticker-name">{a.name}</span>
            <span key={a._ts || a.price} className={`ticker-price${a._ts ? " blink" : ""}`}>{isDash ? "—" : a.price}</span>
            {!isDash && <span className={`ticker-change ${cls}`}>{isUp ? "▲" : isDown ? "▼" : "●"} {Math.abs(a.change24h).toFixed(2)}%</span>}
          </div>
        );
      })}
      <div className="ticker-right">
        {tickerStale && (
          <span style={{ fontSize: "9px", color: "#ff5c5c", fontFamily: "IBM Plex Mono, monospace", background: "#1a0000", border: "1px solid #ff5c5c33", borderRadius: "3px", padding: "1px 6px", marginRight: 4 }}>⚠ STALE</span>
        )}
        <DataSourceBadge source={dataSource} />
        <LiveClock />
        <span className={`ticker-session ${session.cls}`}>{session.label}</span>
      </div>
    </div>
  );
}

// ─── INTELLIGENCE BADGE COMPONENTS ───────────────────────────────────────────

function ConflictBadge({ risk }) {
  if (!risk) return null;
  return <span style={{ fontSize: "8px", fontWeight: 700, fontFamily: "IBM Plex Mono, monospace", padding: "1px 5px", borderRadius: "3px", letterSpacing: 0.4, background: "#1a0008", color: "#ff5c5c", border: "1px solid #ff5c5c44", whiteSpace: "nowrap" }}>⚠ {risk.type}</span>;
}

function CautionBadge({ risk }) {
  if (!risk) return null;
  return <span style={{ fontSize: "8px", fontWeight: 700, fontFamily: "IBM Plex Mono, monospace", padding: "1px 5px", borderRadius: "3px", letterSpacing: 0.4, background: "#1a1000", color: "#ffaa00", border: "1px solid #ffaa0044", whiteSpace: "nowrap" }}>⚡ {risk.type}</span>;
}

function PriceImpactBadge({ impact }) {
  if (!impact) return null;
  const pos = impact > 0;
  return <span style={{ fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, color: pos ? "#00ff9c" : "#ff5c5c", background: pos ? "#002210" : "#1a0008", border: `1px solid ${pos ? "#00ff9c33" : "#ff5c5c33"}`, padding: "1px 5px", borderRadius: "3px" }}>{pos ? "+" : ""}{impact.toFixed(1)}% est.</span>;
}

function IntelSummaryBar({ blocked, clean, cautioned }) {
  return (
    <div style={{ display: "flex", gap: 6, padding: "5px 8px", background: "#010a18", border: "1px solid #0c2240", borderRadius: 4, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: "8px", fontFamily: "IBM Plex Mono, monospace", color: "#1a5070", letterSpacing: 1 }}>INTEL ENGINE</span>
      <span style={{ fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", color: "#00ff9c" }}>✓ {clean} clean</span>
      {cautioned > 0 && <span style={{ fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", color: "#ffaa00" }}>⚡ {cautioned} caution</span>}
      {blocked > 0 && <span style={{ fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", color: "#ff5c5c" }}>✗ {blocked} blocked</span>}
    </div>
  );
}

// ─── GLOBAL SEARCH ────────────────────────────────────────────────────────────

function GlobalSearch({ onSelectCompany }) {
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);
  const wrapRef     = useRef(null);

  useEffect(() => {
    const handleClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleChange = (e) => {
    const q = e.target.value;
    setQuery(q);
    clearTimeout(debounceRef.current);
    if (q.length < 2) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search/${encodeURIComponent(q)}`);
        const data = await res.json();
        setResults(data.results || []);
        setOpen(true);
      } catch (_) {}
      setLoading(false);
    }, 280);
  };

  const handleSelect = (company) => { setQuery(""); setResults([]); setOpen(false); onSelectCompany(company); };

  return (
    <div className="gs-wrap" ref={wrapRef}>
      <span className="gs-icon">⌕</span>
      <input className="gs-input" type="text" placeholder="Search company..." value={query} onChange={handleChange} onFocus={() => results.length > 0 && setOpen(true)} />
      {loading && <span className="gs-spinner" />}
      {query && <button className="gs-clear" onClick={() => { setQuery(""); setResults([]); setOpen(false); }}>✕</button>}
      {open && results.length > 0 && (
        <div className="gs-dropdown">
          {results.map((r, i) => (
            <div key={i} className="gs-result" onClick={() => handleSelect(r)}>
              <span className="gs-name">{r.name}</span>
              <span className="gs-meta">{r.code}{r.sector ? ` · ${r.sector}` : ""}</span>
            </div>
          ))}
        </div>
      )}
      {open && results.length === 0 && !loading && query.length >= 2 && (
        <div className="gs-dropdown"><div className="gs-empty">No results for "{query}"</div></div>
      )}
    </div>
  );
}

// ─── COMPANY PANEL ────────────────────────────────────────────────────────────

function OBBarChart({ history }) {
  if (!history || history.length === 0) return null;
  const max = Math.max(...history.map(q => q.confirmedOrderBook || 0), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 48, marginTop: 8 }}>
      {[...history].slice(-6).map((q, i) => {
        const pct = Math.max(((q.confirmedOrderBook || 0) / max) * 100, 2);
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <div style={{ width: "100%", height: `${pct}%`, background: "linear-gradient(180deg, #00cfff, #004a6a)", borderRadius: "2px 2px 0 0", minHeight: 2 }} />
            <span style={{ fontSize: "7px", color: "#2a5070", fontFamily: "IBM Plex Mono", whiteSpace: "nowrap" }}>{q.quarter?.replace("FY", "")?.slice(-4) || ""}</span>
          </div>
        );
      })}
    </div>
  );
}

function CompanyPanel({ company, onClose }) {
  const [profile, setProfile] = useState(null);
  const [ob,      setOb]      = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!company) return;
    setProfile(null); setOb(null); setLoading(true);
    const code = company.code;
    const nse  = company.nseSymbol || "";
    fetch(`/api/company/${code}${nse ? `?nse=${nse}` : ""}`)
      .then(r => r.json()).catch(() => null)
      .then(prof => { setProfile(prof); setOb(prof); setLoading(false); });
  }, [company]);

  if (!company) return null;

  const p   = profile?.profile || {};
  const f   = profile?.financials || {};
  const ob_ = profile?.orderBook || ob?.orderBook || null;
  const filings = profile?.recentFilings || [];

  return (
    <>
      <div className="cp-overlay" onClick={onClose} />
      <div className="cp-panel">
        <div className="cp-header">
          <div>
            <div className="cp-company">{company.name}</div>
            <div className="cp-meta">BSE: {company.code}{company.nseSymbol ? ` · NSE: ${company.nseSymbol}` : ""}{company.sector ? ` · ${company.sector}` : ""}</div>
          </div>
          <button className="cp-close" onClick={onClose}>✕</button>
        </div>
        <div className="cp-body">
          {loading && <div className="cp-loading"><div className="ai-spinner" /><span>Loading company data...</span></div>}
          {!loading && (
            <>
              <div className="cp-stats-grid">
                {(p.price || p.lastPrice) && <div className="cp-stat"><div className="cp-stat-val" style={{ color: "#00ff9c" }}>₹{p.price || p.lastPrice}</div><div className="cp-stat-label">Price</div></div>}
                {(p.mcap || p.marketCap) && <div className="cp-stat"><div className="cp-stat-val">₹{((p.mcap || p.marketCap) >= 1000 ? ((p.mcap || p.marketCap)/1000).toFixed(1) + "K" : (p.mcap || p.marketCap))}Cr</div><div className="cp-stat-label">Market Cap</div></div>}
                {p.high52 && <div className="cp-stat"><div className="cp-stat-val" style={{ fontSize: "10px" }}>₹{p.high52} / ₹{p.low52}</div><div className="cp-stat-label">52W High / Low</div></div>}
                {f.pe && <div className="cp-stat"><div className="cp-stat-val">{f.pe}</div><div className="cp-stat-label">P/E</div></div>}
                {f.bookValue && <div className="cp-stat"><div className="cp-stat-val">₹{f.bookValue}</div><div className="cp-stat-label">Book Value</div></div>}
                {f.roe && <div className="cp-stat"><div className="cp-stat-val">{f.roe}%</div><div className="cp-stat-label">ROE</div></div>}
              </div>
              <div className="cp-section-label">ORDER BOOK</div>
              {ob_ ? (
                <div className="cp-ob-card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "#d8eeff", fontWeight: 700 }}>₹{(ob_.currentOrderBook || 0).toLocaleString("en-IN")}Cr</span>
                    {ob_.obToRevRatio && <span style={{ fontSize: "10px", color: "#00cfff", fontFamily: "IBM Plex Mono" }}>{ob_.obToRevRatio}x OB/Rev</span>}
                  </div>
                  <div style={{ fontSize: "9px", color: "#4a9abb", marginTop: 4 }}>Confirmed: ₹{(ob_.confirmed || 0).toLocaleString("en-IN")}Cr ({ob_.confirmedQuarter || "—"}){ob_.newOrders > 0 && ` · +₹${ob_.newOrders.toLocaleString("en-IN")}Cr new`}</div>
                  {ob_.quarterHistory && <OBBarChart history={ob_.quarterHistory} />}
                  {ob_.lastOrderTitle && <div style={{ fontSize: "9px", color: "#2a5070", marginTop: 6, fontStyle: "italic" }}>Latest: {ob_.lastOrderTitle}</div>}
                </div>
              ) : (
                <div className="cp-empty">Populates on ORDER_ALERT filings</div>
              )}
              {filings.length > 0 && (
                <>
                  <div className="cp-section-label">RECENT FILINGS</div>
                  {filings.slice(0, 8).map((f_, i) => {
                    const url = f_.pdfUrl || f_.attachment || f_.url || null;
                    return (
                      <div key={i} className="cp-filing" onClick={() => url && window.open(url, "_blank", "noopener")} style={{ cursor: url ? "pointer" : "default" }}>
                        <span className="cp-filing-title">{f_.title || "Filing"}</span>
                        <span className="cp-filing-time">{formatTime(f_.time) || "—"}</span>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ─── PANELS ───────────────────────────────────────────────────────────────────

function PanelHeaderBar({ children }) {
  return (
    <div style={{ margin: "-10px -10px 10px -10px", padding: "7px 10px", background: "linear-gradient(90deg, #020d1f 0%, #031428 100%)", borderBottom: "1px solid #0d3560", borderRadius: "5px 5px 0 0", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
      {children}
    </div>
  );
}

function IntelPanel({ computedRadar, orderBook, bseEvents, nseEvents, tickerSource, intelStats, socket }) {
  const srcLabel = tickerSource === "upstox" ? "⚡ Upstox Live" : tickerSource === "disconnected" ? "○ Disconnected" : tickerSource === "error" ? "⚠ Error" : "◌ Connecting...";
  const srcColor = tickerSource === "upstox" ? "#00ff9c" : tickerSource === "error" ? "#ff5c5c" : "#ffaa00";

  return (
    <div className="panel intelligence-panel">
      <PanelHeaderBar>
        <span style={{ color: "#ffaa00", fontSize: "12px" }}>🔔</span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "10px", fontWeight: 700, color: "#00cfff", textTransform: "uppercase", letterSpacing: "1px" }}>Alerts</span>
        {computedRadar.filter(e => e.conflict || e.score >= 80).length > 0 && <span className="count">{computedRadar.filter(e => e.conflict || e.score >= 80).length}</span>}
      </PanelHeaderBar>
      <div className="section">
        {computedRadar.filter(e => e.conflict || e.score >= 80).slice(0, 6).length === 0
          ? <div className="empty">No active alerts</div>
          : computedRadar.filter(e => e.conflict || e.score >= 80).slice(0, 6).map((e, i) => (
          <div key={i} className="mini-card" style={{ borderLeft: e.conflict ? "3px solid #ff5c5c" : e.score >= 80 ? "3px solid #ff9c00" : undefined, background: e.conflict ? "#0c0208" : undefined }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="mini-card-name" style={{ color: e.conflict ? "#ff7070" : undefined }}>{e.company}</span>
              {e.conflict ? <span className="mini-card-blocked">BLOCKED</span> : <span className="mini-card-score">{e.score}</span>}
            </div>
            <div style={{ display: "flex", gap: 5, marginTop: 3, alignItems: "center" }}>
              <span className={`type type-${e.type}`} style={{ fontSize: "8px" }}>{e.type}</span>
              {e.conflict && <ConflictBadge risk={e.conflict} />}
            </div>
          </div>
        ))}
      </div>
      <div className="section">
        <div className="section-divider">🔔 Circuit Alerts</div>
        <CircuitAlerts socket={socket} />
      </div>
      <div className="section">
        <div className="section-divider">⚡ Pulse</div>
        <div className="mini-card" style={{ color: "#4a8adf" }}>Orders Tracked: {orderBook.length}</div>
        <div className="mini-card" style={{ color: "#4a8adf" }}>Active Signals: {computedRadar.length}</div>
        <div className="mini-card" style={{ color: "#4a8adf" }}>BSE Events: {bseEvents.length}</div>
        <div className="mini-card" style={{ color: "#4a8adf" }}>NSE Events: {nseEvents.length}</div>
        <div className="mini-card" style={{ color: srcColor }}>Index Feed: {srcLabel}</div>
      </div>
      <div className="section">
        <div className="section-divider">🧠 Intelligence Engine</div>
        <div className="mini-card" style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: "10px", color: "#1a5070" }}>Contradiction filter</span><span style={{ fontSize: "9px", color: "#00ff9c", fontFamily: "IBM Plex Mono,monospace" }}>ACTIVE</span></div>
        <div className="mini-card" style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: "10px", color: "#1a5070" }}>Clean signals</span><span style={{ fontSize: "9px", color: "#00ff9c", fontFamily: "IBM Plex Mono,monospace" }}>{intelStats.clean}</span></div>
        <div className="mini-card" style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: "10px", color: "#1a5070" }}>Blocked (HIGH risk)</span><span style={{ fontSize: "9px", color: "#ff5c5c", fontFamily: "IBM Plex Mono,monospace" }}>{intelStats.blocked}</span></div>
        <div className="mini-card" style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: "10px", color: "#1a5070" }}>Cautioned (MED risk)</span><span style={{ fontSize: "9px", color: "#ffaa00", fontFamily: "IBM Plex Mono,monospace" }}>{intelStats.cautioned}</span></div>
        <div className="mini-card" style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: "10px", color: "#1a5070" }}>Risk registry</span><span style={{ fontSize: "9px", color: "#4a9abb", fontFamily: "IBM Plex Mono,monospace" }}>{RISK_REGISTRY.length} entities</span></div>
      </div>
    </div>
  );
}

// ─── RADAR PANEL — now accepts gannMap ───────────────────────────────────────

function RadarPanel({ filteredRadar, radarQuery, setRadarQuery, compositeMap, gannMap }) {
  return (
    <div className="panel radar-panel">
      <div className="panel-header">
        <span className="panel-title">📡 Radar <span className="count">{filteredRadar.length}</span></span>
      </div>
      <div className="search-wrap">
        <span className="search-icon">⌕</span>
        <input type="text" className="radar-search" placeholder="Search company, type..." value={radarQuery} onChange={e => setRadarQuery(e.target.value)} />
        {radarQuery && <button className="clear-btn" onClick={() => setRadarQuery("")}>✕</button>}
      </div>
      {filteredRadar.length === 0 ? (
        <div className="empty">No matches for "{radarQuery}"</div>
      ) : filteredRadar.map((r, i) => (
        <div className="radar-card" key={i} style={{ borderLeft: r.conflict ? "3px solid #ff5c5c" : r.caution ? "3px solid #ffaa00" : "3px solid #0c3060", background: r.conflict ? "linear-gradient(145deg,#0d0208,#020c1a)" : undefined }}>
          <div className="rc-top">
            <span className="co-name" style={{ color: r.conflict ? "#ff7070" : undefined }}>{r.company}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <CompositeScoreBadge symbol={r.code || r.company} compositeMap={compositeMap} />
              <GannBadge symbol={r.code || r.company} gannMap={gannMap} compact={true} />
              {r.conflict && <ConflictBadge risk={r.conflict} />}
              {!r.conflict && r.caution && <CautionBadge risk={r.caution} />}
              <span className={`type type-${r.type}`}>{r.type}</span>
            </div>
          </div>
          <div className="tag-row">
            <span style={{ fontSize: "9px", fontWeight: 700, padding: "1px 5px", borderRadius: "3px", background: r.exchange === "BSE" ? "#1a2a4a" : "#1a3a2a", color: r.exchange === "BSE" ? "#4a9eff" : "#00ff9c", border: r.exchange === "BSE" ? "1px solid #4a9eff44" : "1px solid #00ff9c44", flexShrink: 0 }}>{r.exchange}</span>
            {r.orderValue > 0 && <span className="order-val" style={{ flexShrink: 0 }}>₹{r.orderValue}Cr</span>}
            {r.pdfUrl && <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="filing-link" onClick={ev => ev.stopPropagation()} style={{ flexShrink: 0 }}>📄</a>}
            <LiveAgo exchangeTime={r.time} receivedAt={r.receivedAt} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FeedPanel({ filteredFeed, activeTab, setActiveTab, feedFilter, setFeedFilter }) {
  return (
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
        const cardClass = ["feed-card", e.type?.includes("ORDER") ? "fc-order" : e.type?.includes("MERGER") ? "fc-merger" : e.type?.includes("RESULT") ? "fc-result" : e.type?.includes("INSIDER") ? "fc-insider" : e.type?.includes("CAPEX") ? "fc-capex" : "fc-news"].join(" ");
        const hotWords = ["crore","cr","lakh","order","contract","merger","acquisition","fraud","penalty","rs"];
        const pdfUrl = e.pdfUrl || e.attachment || e.url || null;
        return (
          <div className={cardClass} key={i} onClick={() => pdfUrl && window.open(pdfUrl, "_blank", "noopener")} style={{ cursor: pdfUrl ? "pointer" : "default" }}>
            <div className="fc-head">
              <span className="fc-company">{e.company}{e.type === "NEWS" && <span className="fc-tag-news">NEWS</span>}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                {e.type !== "NEWS" && <Tag type={e.type} crores={e._orderInfo?.crores || extractAmount(e.title)} />}
                {pdfUrl && <a href={pdfUrl} target="_blank" rel="noreferrer" className="filing-link" onClick={ev => ev.stopPropagation()}>📄 Filing</a>}
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
}

function RightPanel({ computedMegaOrders, computedOpportunities, sector, orderBook, intelStats, liveOrderBook, obExpanded, setObExpanded, obSearch, setObSearch }) {
  return (
    <div className="panel right-panel">
      <div className="section">
        <div className="section-divider">🔥 Mega Orders <span className="count">{computedMegaOrders.length}</span></div>
        {computedMegaOrders.length === 0 ? <div className="empty">No mega orders yet</div> : (
          <div className="mega-grid">
            {computedMegaOrders.slice(0, 10).map((o, i) => {
              const mcapEntry = window._mcapDb?.find?.(m => (m.company || "").toLowerCase() === (o.company || "").toLowerCase());
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
        <IntelSummaryBar blocked={intelStats.blocked} clean={intelStats.clean} cautioned={intelStats.cautioned} />
        {computedOpportunities.length === 0 ? <div className="empty">No opportunities yet</div>
          : computedOpportunities.map((o, i) => (
          <div className="opp-card" key={i} style={{ borderLeft: o.caution ? "3px solid #ffaa00" : "3px solid #0c2240" }}>
            <div className="opp-row" style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="co-name">{o.company}</span>
              <span className="opp-pct">{o.score}%</span>
            </div>
            <div style={{ display: "flex", gap: 5, marginTop: 3, flexWrap: "wrap", alignItems: "center" }}>
              <span className={`type type-${o.type}`} style={{ fontSize: "8px" }}>{o.type}</span>
              {o.caution && <CautionBadge risk={o.caution} />}
              {o.priceImpact !== undefined && <PriceImpactBadge impact={o.priceImpact} />}
            </div>
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
              <span className="sec-val">{s.totalValue ? `₹${s.totalValue}Cr` : s.count ? `${s.count} filing${s.count > 1 ? "s" : ""}` : "—"}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="section">
        <div className="section-divider">
          📦 Order Book Tracker
          <span className="count" style={{ marginLeft: 6 }}>{liveOrderBook.length}</span>
          <span style={{ fontSize: "8px", color: "#1a5070", marginLeft: 6 }}>{getCurrentQuarter().label} {getCurrentQuarter().range}</span>
        </div>
        <div style={{ position: "relative", marginBottom: 6 }}>
          <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#1a5070", fontSize: "11px", pointerEvents: "none" }}>⌕</span>
          <input type="text" placeholder="Search order book..." value={obSearch} onChange={e => setObSearch(e.target.value)} style={{ width: "100%", background: "#010a18", border: "1px solid #0c2240", borderRadius: 4, padding: "5px 8px 5px 24px", color: "#d8eeff", fontSize: "10px", fontFamily: "IBM Plex Mono, monospace", outline: "none", boxSizing: "border-box" }} />
          {obSearch && <button onClick={() => setObSearch("")} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#1a5070", cursor: "pointer", fontSize: "12px" }}>✕</button>}
        </div>
        {liveOrderBook.length === 0 ? <div className="empty">No order book data yet</div>
          : liveOrderBook.filter(o => !obSearch || (o.company || "").toLowerCase().includes(obSearch.toLowerCase())).map((o, i) => {
          const isOpen  = obExpanded === o.code;
          const obToRev = o.obToRevRatio ? parseFloat(o.obToRevRatio) : null;
          const obColor = obToRev === null ? "#4a9abb" : obToRev >= 3 ? "#00ff9c" : obToRev >= 1.5 ? "#ffaa00" : "#ff5c5c";
          const maxOB   = Math.max(...liveOrderBook.map(x => x.currentOrderBook || 0), 1);
          const barPct  = Math.round(((o.currentOrderBook || 0) / maxOB) * 100);
          return (
            <div key={i} className="ord-card" style={{ cursor: "pointer", borderLeft: `3px solid ${obColor}` }} onClick={() => setObExpanded(isOpen ? null : o.code)}>
              <div className="ord-top">
                <span className="co-name">{o.company}</span>
                <span className="ord-val">₹{(o.currentOrderBook || 0).toLocaleString("en-IN")}Cr</span>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                <span style={{ fontSize: "9px", color: "#4a9abb", fontFamily: "IBM Plex Mono, monospace" }}>Base: ₹{(o.confirmed || 0).toLocaleString("en-IN")}Cr ({o.confirmedQuarter || "—"})</span>
                {o.newOrders > 0 && <span style={{ fontSize: "9px", color: "#00ff9c", fontFamily: "IBM Plex Mono, monospace" }}>+₹{o.newOrders.toLocaleString("en-IN")}Cr new</span>}
                {obToRev && <span style={{ fontSize: "9px", color: obColor, fontFamily: "IBM Plex Mono, monospace" }}>{o.obToRevRatio}x rev</span>}
              </div>
              <div className="ob-bar"><div className="ob-bar-fill" style={{ width: `${barPct}%` }} /></div>
              {isOpen && o.quarterHistory && o.quarterHistory.length > 0 && (
                <div style={{ marginTop: 8, borderTop: "1px solid #0c2240", paddingTop: 6 }}>
                  <div style={{ fontSize: "9px", color: "#00cfff", marginBottom: 4, fontWeight: 700 }}>QUARTER HISTORY</div>
                  {[...o.quarterHistory].reverse().map((q, qi) => (
                    <div key={qi} style={{ display: "flex", justifyContent: "space-between", fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", padding: "3px 0", borderBottom: "1px solid #0a1828" }}>
                      <span style={{ color: "#7ab0d0" }}>{q.quarter}</span>
                      <span style={{ color: "#d8eeff" }}>₹{(q.confirmedOrderBook || 0).toLocaleString("en-IN")}Cr</span>
                      {q.addedOrders > 0 && <span style={{ color: "#00ff9c" }}>+₹{q.addedOrders.toLocaleString("en-IN")}Cr</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── NAV HEADER ───────────────────────────────────────────────────────────────

function AppHeader({ currentPage, setCurrentPage, darkMode, setDarkMode, needsConnect, onSelectCompany }) {
  const isOptions      = currentPage === "options";
  const isScores       = currentPage === "scores";
  const isOptionsIntel = currentPage === "options-intel";
  const isAltPage      = isOptions || isScores || isOptionsIntel;

  return (
    <div className="header">
      <div className="header-left">
        <span className="star">★</span>
        <span className="title">Market Intelligence</span>
        <MarketStatus />

        {/* Options page button */}
        <button
          className={`options-nav-btn${isOptions ? " active" : ""}`}
          onClick={() => setCurrentPage(isOptions ? "dashboard" : "options")}
          title="Option Chain OI Heatmap"
        >
          <span className="options-nav-icon">⚡</span>
          <span className="options-nav-label">{isOptions ? "Dashboard" : "Options"}</span>
          {isOptions && <span className="options-nav-back">←</span>}
        </button>

        {/* Scores page button */}
        <button
          className={`options-nav-btn${isScores ? " active" : ""}`}
          onClick={() => setCurrentPage(isScores ? "dashboard" : "scores")}
          title="Composite Score Leaderboard"
          style={{ marginLeft: 4 }}
        >
          <span className="options-nav-icon">🏆</span>
          <span className="options-nav-label">{isScores ? "Dashboard" : "Scores"}</span>
          {isScores && <span className="options-nav-back">←</span>}
        </button>

        {/* Options Intelligence page button — NEW */}
        <button
          className={`options-nav-btn${isOptionsIntel ? " active" : ""}`}
          onClick={() => setCurrentPage(isOptionsIntel ? "dashboard" : "options-intel")}
          title="Options Intelligence — Greeks, GEX, IV Rank, OI"
          style={{ marginLeft: 4 }}
        >
          <span className="options-nav-icon">📐</span>
          <span className="options-nav-label">{isOptionsIntel ? "Dashboard" : "OI Intel"}</span>
          {isOptionsIntel && <span className="options-nav-back">←</span>}
        </button>

        {needsConnect && !isAltPage && (
          <span
            style={{ fontSize: "9px", fontFamily: "IBM Plex Mono, monospace", color: "#ffaa00", cursor: "pointer", marginLeft: 6, textDecoration: "underline" }}
            onClick={() => window.open("/auth/upstox", "_blank")}
          >
            Connect Upstox →
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {!isAltPage && <GlobalSearch onSelectCompany={onSelectCompany} />}
        {isAltPage && (
          <button
            className="back-to-dashboard-btn"
            onClick={() => setCurrentPage("dashboard")}
          >
            ← Dashboard
          </button>
        )}
      </div>

      <button
        className="mode-toggle"
        onClick={() => setDarkMode(d => !d)}
        title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
      >
        {darkMode ? "☀ Light" : "🌙 Dark"}
      </button>
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [currentPage, setCurrentPage] = useState("dashboard");

  const [marketIndices,  setMarketIndices]  = useState([
    { name: "NIFTY 50",   price: "—", change: "—", pct: "—", up: null },
    { name: "SENSEX",     price: "—", change: "—", pct: "—", up: null },
    { name: "BANK NIFTY", price: "—", change: "—", pct: "—", up: null },
  ]);
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
  const [liveOrderBook,  setLiveOrderBook]  = useState([]);
  const [obExpanded,     setObExpanded]     = useState(null);
  const [obSearch,       setObSearch]       = useState("");
  const [selectedCompany,  setSelectedCompany]  = useState(null);
  const [selectedTicker,   setSelectedTicker]   = useState(null);
  const [socket,           setSocket]           = useState(null);

  // Composite scores: map of symbol → score object for badge lookups
  const [compositeScores, setCompositeScores] = useState([]);
  const compositeMap = {};
  compositeScores.forEach(s => { compositeMap[s.symbol] = s; });

  // Gann signals: map of symbol → gann signal object — NEW
  const [gannSignals, setGannSignals] = useState([]);
  const gannMap = {};
  gannSignals.forEach(g => { gannMap[g.symbol] = g; });

  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem("mi-theme");
    if (saved) return saved === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.body.setAttribute("data-theme", darkMode ? "dark" : "light");
    localStorage.setItem("mi-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => { if (!localStorage.getItem("mi-theme")) setDarkMode(e.matches); };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const sock = socketIO({ transports: ["websocket", "polling"] });
    setSocket(sock);

    sock.on("connect", () => {
      console.log("Socket.io connected");
      sock.emit("get-composite-scores");
    });

    sock.on("market-tick", (updates) => {
      if (!Array.isArray(updates)) return;
      setMarketIndices(prev => prev.map(idx => { const update = updates.find(u => u.name === idx.name); if (!update) return idx; return { ...update, _ts: Date.now() }; }));
      setTickerSource("upstox");
      setTickerLastOk(Date.now());
      setTickerStale(false);
    });

    sock.on("composite-scores", (scores) => {
      if (Array.isArray(scores)) setCompositeScores(scores);
    });

    sock.on("composite-update", (update) => {
      if (!update?.symbol) return;
      setCompositeScores(prev => {
        const next = prev.filter(s => s.symbol !== update.symbol);
        return [update, ...next];
      });
    });

    // Gann signals — NEW
    sock.on("gann-signal", (signal) => {
      if (!signal?.symbol) return;
      setGannSignals(prev => {
        const next = prev.filter(g => g.symbol !== signal.symbol);
        return [signal, ...next];
      });
    });

    sock.on("upstox-status", ({ connected }) => { if (!connected) setTickerSource("connecting"); });
    sock.on("nse_events", (events) => {
  if (!Array.isArray(events)) return;
  setNseEvents(prev => {
    const combined = [...events, ...prev];
    const seen = new Set();
    return combined.filter(e => {
      const key = `${e.company}||${(e.title||"").substring(0,60)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 200);
  });
});

sock.on("bse_events", (events) => {
  if (!Array.isArray(events)) return;
  setBseEvents(prev => {
    const combined = [...events, ...prev];
    const seen = new Set();
    return combined.filter(e => {
      const key = `${e.company}||${(e.title||"").substring(0,60)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 200);
  });
});
    sock.on("disconnect", () => { setTickerSource("error"); });

    return () => sock.disconnect();
  }, []);

  useEffect(() => {
    fetch("/api/market").then(r => r.json()).then(data => {
      if (!Array.isArray(data)) return;
      const indices    = data.filter(d => d.name && !d._source);
      const sourceMeta = data.find(d => d._source);
      const src        = sourceMeta?._source || "disconnected";
      if (indices.length) setMarketIndices(indices);
      if (src !== "upstox") setTickerSource(src);
      else { setTickerSource("upstox"); setTickerLastOk(Date.now()); }
    }).catch(() => setTickerSource("disconnected"));
  }, []);

  useEffect(() => {
    const t = setInterval(() => { if (tickerLastOk && Date.now() - tickerLastOk > 90000) setTickerStale(true); }, 10000);
    return () => clearInterval(t);
  }, [tickerLastOk]);

  const btcWsRef    = useRef(null);
  const btcReconRef = useRef(null);
  const btc24hRef   = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const fetch24h = async () => {
      try {
        const r = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT");
        const d = await r.json();
        btc24hRef.current = parseFloat(d.priceChangePercent) || 0;
      } catch (e) { console.warn("BTC 24h fetch failed:", e.message); }
    };
    fetch24h();
    const hourly = setInterval(fetch24h, 3600000);
    const connectWS = () => {
      if (cancelled) return;
      if (btcWsRef.current) { try { btcWsRef.current.close(); } catch (e) {} }
      const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@aggTrade");
      btcWsRef.current = ws;
      ws.onmessage = (evt) => {
        if (cancelled) return;
        try {
          const msg   = JSON.parse(evt.data);
          const price = parseFloat(msg.p);
          if (!price || isNaN(price)) return;
          const change24h = btc24hRef.current;
          const formatted = "$" + price.toLocaleString("en-US", { maximumFractionDigits: 0 });
          setCryptoAssets(prev => {
            const next = [...prev];
            const idx  = next.findIndex(a => a.name === "BTC");
            const entry = { name: "BTC", icon: "₿", type: "crypto", price: formatted, change24h, _ts: Date.now() };
            if (idx >= 0) next[idx] = entry; else next.unshift(entry);
            return next;
          });
        } catch (e) {}
      };
      ws.onerror  = (e) => { console.warn("BTC WebSocket error:", e.message || e); };
      ws.onclose  = () => { if (cancelled) return; btcReconRef.current = setTimeout(connectWS, 2000); };
    };
    connectWS();
    return () => {
      cancelled = true;
      clearInterval(hourly);
      if (btcReconRef.current) clearTimeout(btcReconRef.current);
      if (btcWsRef.current) { btcWsRef.current.onclose = null; try { btcWsRef.current.close(); } catch (e) {} }
    };
  }, []);

  useEffect(() => {
    const fmt = (n, prefix = "$") => {
      if (!n && n !== 0) return "—";
      if (n >= 1000) return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
      if (n >= 1)    return prefix + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
      return prefix + n.toFixed(4);
    };
    const fetchCommodities = async () => {
      const updates = {};
      try {
        const res  = await fetch("/api/commodities");
        const data = await res.json();
        if (data?.GOLD?.price)   updates["GOLD"]   = { name: "GOLD",   icon: "Au", type: "gold",   price: fmt(data.GOLD.price),   change24h: data.GOLD.change24h   || 0, _ts: Date.now() };
        if (data?.SILVER?.price) updates["SILVER"] = { name: "SILVER", icon: "Ag", type: "silver", price: fmt(data.SILVER.price), change24h: data.SILVER.change24h || 0, _ts: Date.now() };
      } catch (e) { console.warn("Commodities fetch failed:", e.message); }
      try {
        const cgRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=pi-network&vs_currencies=usd&include_24hr_change=true", { headers: { "Accept": "application/json" } });
        const cg = await cgRes.json();
        if (cg?.["pi-network"]?.usd) updates["PI"] = { name: "PI", icon: "π", type: "crypto", price: fmt(cg["pi-network"].usd), change24h: cg["pi-network"].usd_24h_change || 0, _ts: Date.now() };
      } catch (e) { console.warn("PI fetch failed:", e.message); }
      if (Object.keys(updates).length > 0) {
        setCryptoAssets(prev => {
          const map = {};
          prev.forEach(a => { map[a.name] = a; });
          Object.assign(map, updates);
          return ["BTC", "PI", "GOLD", "SILVER"].map(n => map[n]).filter(Boolean);
        });
      }
    };
    fetchCommodities();
    const interval = setInterval(fetchCommodities, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchOB = () => { fetch("/api/orderbook").then(r => r.json()).then(data => setLiveOrderBook(data.orderBook || [])).catch(e => console.log("OB fetch error:", e)); };
    fetchOB();
    const iv = setInterval(fetchOB, 60000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const fetchEvents = () => {
      fetch("/api/events").then(r => r.json()).then(data => {
        setBseEvents(data.bse || []); setNseEvents(data.nse || []);
        setOrderBook(data.orderBook || []); setSector(data.sectors || []);
      }).catch(err => console.log("Events fetch error:", err));
    };
    fetchEvents();
    const interval = setInterval(fetchEvents, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    fetch("/api/mcap").then(r => r.json()).then(data => { if (Array.isArray(data) && data.length > 0) window._mcapDb = data; }).catch(() => {});
  }, []);

  // ── Computed data ─────────────────────────────────────────────────────────
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
      const isNonOrder = (t.includes("solar") || t.includes("renewable") || t.includes("green energy") || t.includes("spv") || t.includes("equity stake") || t.includes("power purchase") || t.includes("subscribe") || t.includes("invest") || t.includes("income tax") || t.includes("assessment") || t.includes("tax demand") || t.includes("penalty") || t.includes("nclt"));
      if (t.includes("fraud") || t.includes("insolvency") || t.includes("default"))   { type = "RISK";   score = 95; }
      else if (t.includes("penalty") || t.includes("nclt"))                            { type = "RISK";   score = 85; }
      else if (t.includes("solar") || t.includes("renewable") || t.includes("capex") || t.includes("greenfield") || t.includes("brownfield") || t.includes("expansion") || t.includes("power purchase") || t.includes("spv") || (t.includes("equity stake") || (t.includes("subscribe") && t.includes("equity"))) || (t.includes("invest") && !t.includes("investor") && !t.includes("investment in"))) { type = "CAPEX"; score = 75; }
      else if (t.includes("purchase order") || t.includes("work order") || t.includes("supply order") || t.includes("receipt of order") || t.includes("order received") || t.includes("order secured") || t.includes("major order") || t.includes("letter of acceptance") || t.includes("rate contract") || t.includes("bagged") || t.includes("contract awarded") || t.includes("loa") || (t.includes("order") && (t.includes("crore") || t.includes("lakh") || t.includes("₹") || t.includes("rs.")) && !isNonOrder)) { type = "ORDER"; score = 90; }
      else if (t.includes("merger") || t.includes("amalgamation") || (t.includes("acquisition") && !t.includes("solar") && !t.includes("invest") && !t.includes("subscribe") && !t.includes("equity shares of") && !t.includes("spv") && !t.includes("stake") && !t.includes("power"))) { type = "MERGER"; score = 80; }
      else if (t.includes("buyback"))   { type = "BUYBACK"; score = 78; }
      else if (t.includes("result") || t.includes("quarterly")) { type = "RESULT"; score = 65; }
      else if (t.includes("insider") || t.includes("promoter") || t.includes("bulk deal")) { type = "INSIDER"; score = 70; }
      else if (t.includes("dividend")) { type = "DIVIDEND"; score = 60; }
      else if (t.includes("partnership") || t.includes("joint venture") || t.includes("mou")) { type = "PARTNERSHIP"; score = 72; }
      return {
        company: e?.company || "Unknown", score, type,
        exchange: e._exchange || "BSE",
        receivedAt: e?.receivedAt, time: e?.time,
        pdfUrl: e?.pdfUrl || e?.attachment || null,
        orderValue: extractAmount(e?.title),
        conflict:    getContradict(e?.company || "", e?.title || ""),
        caution:     !getContradict(e?.company || "", e?.title || "") ? getSoftRisk(e?.company || "", e?.title || "") : null,
        priceImpact: estimatePriceImpact(type, extractAmount(e?.title || ""), e?.title || ""),
      };
    });

  const computedMegaOrders = (bseEvents || []).filter(e => {
    const t = (e?.title || "").toLowerCase();
    const isRealOrder = (t.includes("order") || t.includes("contract")) && (t.includes("crore") || t.includes("₹") || t.includes("rs")) && !t.includes("solar") && !t.includes("renewable") && !t.includes("invest") && !t.includes("spv") && !t.includes("equity") && !t.includes("subscribe") && !t.includes("income tax") && !t.includes("penalty") && !t.includes("nclt");
    if (!isRealOrder) return false;
    const cr = e._orderInfo?.crores || extractAmount(e.title);
    if (!cr) return false;
    const mcapEntry = window._mcapDb?.find?.(m => (m.company || "").toLowerCase() === (e.company || "").toLowerCase());
    const mcap = mcapEntry?.mcap || 0;
    return cr >= 500 || (mcap > 0 && (cr / mcap) >= 0.08);
  }).sort((a, b) => (b._orderInfo?.crores || extractAmount(b.title)) - (a._orderInfo?.crores || extractAmount(a.title))).slice(0, 10).map(e => ({ company: e.company, crores: e._orderInfo?.crores || extractAmount(e.title), receivedAt: e.receivedAt, time: e.time }));

  const seenOpp = new Set();
  const computedOpportunities = computedRadar.filter(r => {
    if (r.conflict) return false;
    if (r.score < 70) return false;
    const key = `${r.company}||${r.type}`;
    if (seenOpp.has(key)) return false;
    seenOpp.add(key);
    return true;
  }).slice(0, 5).map(r => ({ company: r.company, score: r.score, type: r.type, receivedAt: r.receivedAt, time: r.time, caution: r.caution, priceImpact: r.priceImpact }));

  const intelStats = {
    blocked:   computedRadar.filter(r => !!r.conflict).length,
    cautioned: computedRadar.filter(r => !r.conflict && !!r.caution).length,
    clean:     computedRadar.filter(r => !r.conflict && !r.caution && r.score >= 60).length,
  };

  const filteredRadar = computedRadar.filter(r =>
    !radarQuery ||
    r.company.toLowerCase().includes(radarQuery.toLowerCase()) ||
    r.type.toLowerCase().includes(radarQuery.toLowerCase())
  );

  const needsConnect = tickerSource === "disconnected" || tickerSource === "error";

  const sharedHeader = (
    <AppHeader
      currentPage={currentPage}
      setCurrentPage={setCurrentPage}
      darkMode={darkMode}
      setDarkMode={setDarkMode}
      needsConnect={needsConnect}
      onSelectCompany={setSelectedCompany}
    />
  );

  const sharedTicker = (
    <TickerBar
      indices={marketIndices}
      assets={cryptoAssets}
      dataSource={tickerSource}
      tickerStale={tickerStale}
      onTickerClick={setSelectedTicker}
    />
  );

  // ── Options page ───────────────────────────────────────────────────────────
  if (currentPage === "options") {
    return (
      <div className="terminal" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        {sharedHeader}
        {sharedTicker}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          <OptionChain onBack={() => setCurrentPage("dashboard")} />
        </div>
        <TickerModal item={selectedTicker} onClose={() => setSelectedTicker(null)} />
      </div>
    );
  }

  // ── Scores page ────────────────────────────────────────────────────────────
  if (currentPage === "scores") {
    return (
      <div className="terminal" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        {sharedHeader}
        {sharedTicker}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          <ScoresPage socket={socket} compositeScores={compositeScores} gannMap={gannMap} />
        </div>
        <TickerModal item={selectedTicker} onClose={() => setSelectedTicker(null)} />
      </div>
    );
  }

  // ── Options Intelligence page — NEW ────────────────────────────────────────
  if (currentPage === "options-intel") {
    return (
      <div className="terminal" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        {sharedHeader}
        {sharedTicker}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          <OptionsIntelligencePage socket={socket} />
        </div>
        <TickerModal item={selectedTicker} onClose={() => setSelectedTicker(null)} />
      </div>
    );
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────
  return (
    <div className="terminal">
      {sharedHeader}
      {sharedTicker}

      <div className="layout desktop-layout">
        <IntelPanel  computedRadar={computedRadar} orderBook={orderBook} bseEvents={bseEvents} nseEvents={nseEvents} tickerSource={tickerSource} intelStats={intelStats} socket={socket} />
        <RadarPanel  filteredRadar={filteredRadar} radarQuery={radarQuery} setRadarQuery={setRadarQuery} compositeMap={compositeMap} gannMap={gannMap} />
        <FeedPanel   filteredFeed={filteredFeed} activeTab={activeTab} setActiveTab={setActiveTab} feedFilter={feedFilter} setFeedFilter={setFeedFilter} />
        <RightPanel  computedMegaOrders={computedMegaOrders} computedOpportunities={computedOpportunities} sector={sector} orderBook={orderBook} intelStats={intelStats} liveOrderBook={liveOrderBook} obExpanded={obExpanded} setObExpanded={setObExpanded} obSearch={obSearch} setObSearch={setObSearch} />
      </div>

      <div className="mobile-layout">
        <div className="mobile-tab-bar">
          {MOBILE_TABS.map(t => (
            <button key={t.key} className={`mobile-tab-btn ${mobilePanelTab === t.key ? "active" : ""}`} onClick={() => setMobilePanelTab(t.key)}>{t.label}</button>
          ))}
          <button className="mobile-tab-btn" onClick={() => setCurrentPage("options")}>⚡ OI</button>
          <button className="mobile-tab-btn" onClick={() => setCurrentPage("scores")}>🏆 SCR</button>
          <button className="mobile-tab-btn" onClick={() => setCurrentPage("options-intel")}>📐 OI Intel</button>
        </div>
        <div className="mobile-panel-wrap">
          {mobilePanelTab === "intel"        && <IntelPanel computedRadar={computedRadar} orderBook={orderBook} bseEvents={bseEvents} nseEvents={nseEvents} tickerSource={tickerSource} intelStats={intelStats} socket={socket} />}
          {mobilePanelTab === "radar"        && <RadarPanel filteredRadar={filteredRadar} radarQuery={radarQuery} setRadarQuery={setRadarQuery} compositeMap={compositeMap} gannMap={gannMap} />}
          {mobilePanelTab === "feed"         && <FeedPanel filteredFeed={filteredFeed} activeTab={activeTab} setActiveTab={setActiveTab} feedFilter={feedFilter} setFeedFilter={setFeedFilter} />}
          {mobilePanelTab === "data"         && <RightPanel computedMegaOrders={computedMegaOrders} computedOpportunities={computedOpportunities} sector={sector} orderBook={orderBook} intelStats={intelStats} liveOrderBook={liveOrderBook} obExpanded={obExpanded} setObExpanded={setObExpanded} obSearch={obSearch} setObSearch={setObSearch} />}
          {mobilePanelTab === "options-intel" && <OptionsIntelligencePage socket={socket} />}
        </div>
      </div>

      <CompanyPanel company={selectedCompany} onClose={() => setSelectedCompany(null)} />
      <TickerModal  item={selectedTicker}    onClose={() => setSelectedTicker(null)} />
    </div>
  );
}
