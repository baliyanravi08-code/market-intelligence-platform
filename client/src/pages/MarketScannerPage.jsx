import { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";

// ── Socket singleton ──────────────────────────────────────────────────────────
let _socket = null;
function getSocket() {
  if (!_socket) _socket = io({ transports: ["websocket"] });
  return _socket;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (n, d = 2) => n == null ? "—" : Number(n).toFixed(d);
const fmtK = (n) => {
  if (!n) return "—";
  if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(2) + " L";
  return n.toLocaleString("en-IN");
};
const color = (v) => v > 0 ? "#00e676" : v < 0 ? "#ff4444" : "#888";
const arrow = (v) => v > 0 ? "▲" : v < 0 ? "▼" : "—";

// ── Timeframe config ──────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { id: "5min",   label: "5m"  },
  { id: "15min",  label: "15m" },
  { id: "1hour",  label: "1H"  },
  { id: "4hour",  label: "4H"  },
  { id: "1day",   label: "1D"  },
  { id: "1week",  label: "1W"  },
  { id: "1month", label: "1M"  },
];

// ── MA Signal badge ───────────────────────────────────────────────────────────
function MASigBadge({ signal }) {
  const map = {
    "STRONG BUY":  { bg: "#00e676", text: "#000" },
    "BUY":         { bg: "#1de9b6", text: "#000" },
    "NEUTRAL":     { bg: "#444",    text: "#ccc" },
    "SELL":        { bg: "#ff6b35", text: "#fff" },
    "STRONG SELL": { bg: "#ff1744", text: "#fff" },
    "N/A":         { bg: "#333",    text: "#666" },
  };
  const s = map[signal] || map["N/A"];
  return (
    <span style={{
      background: s.bg, color: s.text,
      fontSize: 9, fontWeight: 700, padding: "2px 6px",
      borderRadius: 3, letterSpacing: "0.5px", whiteSpace: "nowrap",
    }}>{signal}</span>
  );
}

// ── RSI bar ───────────────────────────────────────────────────────────────────
function RSIBar({ value }) {
  if (!value) return <span style={{ color: "#555" }}>—</span>;
  const c = value > 70 ? "#ff4444" : value < 30 ? "#00e676" : "#f9a825";
  const label = value > 70 ? "OB" : value < 30 ? "OS" : "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ width: 50, height: 4, background: "#222", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${value}%`, height: "100%", background: c, borderRadius: 2 }} />
      </div>
      <span style={{ color: c, fontSize: 11, fontWeight: 600 }}>{fmt(value, 1)}</span>
      {label && <span style={{ color: c, fontSize: 9 }}>{label}</span>}
    </div>
  );
}

// ── MACD badge ────────────────────────────────────────────────────────────────
function MACDBadge({ macd }) {
  if (!macd) return <span style={{ color: "#555" }}>—</span>;
  const bull = macd.crossover === "BULLISH";
  return (
    <div style={{ fontSize: 11 }}>
      <span style={{ color: bull ? "#00e676" : "#ff4444", fontWeight: 700 }}>
        {bull ? "▲" : "▼"} {fmt(macd.macd)}
      </span>
      <span style={{ color: "#555", marginLeft: 4 }}>H:{fmt(macd.histogram)}</span>
    </div>
  );
}

// ── Bollinger position ────────────────────────────────────────────────────────
function BBadge({ bb }) {
  if (!bb) return <span style={{ color: "#555" }}>—</span>;
  const map = {
    "ABOVE_UPPER": { c: "#ff4444", t: "Above BB" },
    "NEAR_UPPER":  { c: "#ff9800", t: "Near Upper" },
    "MIDDLE":      { c: "#888",    t: "Mid BB" },
    "NEAR_LOWER":  { c: "#29b6f6", t: "Near Lower" },
    "BELOW_LOWER": { c: "#00e676", t: "Below BB" },
  };
  const s = map[bb.position] || { c: "#555", t: bb.position };
  return (
    <span style={{ color: s.c, fontSize: 11, fontWeight: 600 }}>{s.t}</span>
  );
}

// ── Stock row ─────────────────────────────────────────────────────────────────
function StockRow({ stock, rank, onSelect, selected, tech }) {
  const pct = stock.changePct;
  return (
    <tr
      onClick={() => onSelect(stock.symbol)}
      style={{
        cursor: "pointer",
        background: selected ? "rgba(0,230,118,0.06)" : "transparent",
        borderBottom: "1px solid #1a1a1a",
        transition: "background 0.15s",
      }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
      onMouseLeave={e => e.currentTarget.style.background = selected ? "rgba(0,230,118,0.06)" : "transparent"}
    >
      <td style={{ padding: "7px 8px", color: "#444", fontSize: 11, width: 32 }}>{rank}</td>
      <td style={{ padding: "7px 8px" }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: "#e8f4fd", letterSpacing: "0.3px" }}>{stock.symbol}</div>
        <div style={{ fontSize: 10, color: "#555", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stock.name}</div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right" }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "#e8f4fd" }}>₹{fmt(stock.ltp)}</div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right" }}>
        <div style={{ color: color(pct), fontWeight: 700, fontSize: 12 }}>
          {arrow(pct)} {fmt(Math.abs(pct))}%
        </div>
        <div style={{ color: color(stock.change), fontSize: 10 }}>
          {stock.change > 0 ? "+" : ""}{fmt(stock.change)}
        </div>
      </td>
      <td style={{ padding: "7px 8px", textAlign: "right", color: "#666", fontSize: 11 }}>
        {fmtK(stock.volume)}
      </td>
      <td style={{ padding: "7px 8px" }}>
        <span style={{
          fontSize: 10, padding: "2px 6px", borderRadius: 3, fontWeight: 600,
          background: stock.mcapBucket === "largecap" ? "#1a237e33" :
                      stock.mcapBucket === "midcap"   ? "#1b5e2033" :
                      stock.mcapBucket === "smallcap" ? "#4a148c33" : "#212121",
          color:      stock.mcapBucket === "largecap" ? "#7986cb" :
                      stock.mcapBucket === "midcap"   ? "#66bb6a" :
                      stock.mcapBucket === "smallcap" ? "#ce93d8" : "#888",
        }}>{stock.mcapLabel || "—"}</span>
      </td>
      <td style={{ padding: "7px 8px" }}>
        {tech ? <RSIBar value={tech.rsi} /> : <span style={{ color: "#333", fontSize: 11 }}>—</span>}
      </td>
      <td style={{ padding: "7px 8px" }}>
        {tech ? <MACDBadge macd={tech.macd} /> : <span style={{ color: "#333", fontSize: 11 }}>—</span>}
      </td>
      <td style={{ padding: "7px 8px" }}>
        {tech ? <BBadge bb={tech.bollingerBands} /> : <span style={{ color: "#333", fontSize: 11 }}>—</span>}
      </td>
      <td style={{ padding: "7px 8px" }}>
        {tech ? <MASigBadge signal={tech.maSummary?.summary} /> : <span style={{ color: "#333", fontSize: 11 }}>—</span>}
      </td>
    </tr>
  );
}

// ── Technical Detail Panel ────────────────────────────────────────────────────
function TechPanel({ symbol, tech, timeframe, onTimeframeChange, onClose }) {
  if (!symbol) return null;

  return (
    <div style={{
      position: "fixed", right: 0, top: 0, width: 360, height: "100vh",
      background: "#0d1117", borderLeft: "1px solid #1e2a3a",
      overflowY: "auto", zIndex: 100, padding: "20px 16px",
      boxShadow: "-8px 0 40px rgba(0,0,0,0.6)",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#e8f4fd", letterSpacing: "1px" }}>{symbol}</div>
          <div style={{ fontSize: 11, color: "#555" }}>Technical Analysis</div>
        </div>
        <button onClick={onClose} style={{
          background: "#1a1a1a", border: "1px solid #333", color: "#888",
          width: 28, height: 28, borderRadius: 4, cursor: "pointer", fontSize: 14,
        }}>✕</button>
      </div>

      {/* ── Timeframe selector ── */}
      <div style={{
        display: "flex", gap: 3, marginBottom: 16,
        background: "#080d14", padding: "4px", borderRadius: 6,
        border: "1px solid #1e2a3a",
      }}>
        {TIMEFRAMES.map(tf => (
          <button
            key={tf.id}
            onClick={() => onTimeframeChange(tf.id)}
            style={{
              flex: 1, padding: "5px 0", fontSize: 10, fontWeight: 700,
              borderRadius: 4, cursor: "pointer", border: "none",
              background: timeframe === tf.id ? "#7986cb" : "transparent",
              color:      timeframe === tf.id ? "#fff"    : "#555",
              transition: "all 0.15s", letterSpacing: "0.3px",
            }}
          >{tf.label}</button>
        ))}
      </div>

      {/* Loading state */}
      {!tech ? (
        <div style={{ color: "#555", textAlign: "center", marginTop: 60 }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
          <div>Loading {timeframe} data…</div>
        </div>
      ) : (
        <>
          {/* Tech Score */}
          <div style={{
            background: "#111", border: "1px solid #1e2a3a", borderRadius: 8,
            padding: "14px 16px", marginBottom: 16, textAlign: "center",
          }}>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>
              TECH SCORE · {timeframe.toUpperCase()}
            </div>
            <div style={{
              fontSize: 36, fontWeight: 900,
              color: tech.techScore >= 60 ? "#00e676" : tech.techScore <= 40 ? "#ff4444" : "#f9a825",
            }}>{tech.techScore}</div>
            <div style={{
              fontSize: 13, fontWeight: 700,
              color: tech.bias === "BULLISH" ? "#00e676" : tech.bias === "BEARISH" ? "#ff4444" : "#888",
            }}>{tech.bias}</div>
          </div>

          {/* Moving Averages */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "#555", fontWeight: 700, letterSpacing: "1px", marginBottom: 8 }}>MOVING AVERAGES</div>
            {[
              ["EMA 5",   tech.emas?.ema5],
              ["EMA 9",   tech.emas?.ema9],
              ["EMA 21",  tech.emas?.ema21],
              ["EMA 50",  tech.emas?.ema50],
              ["EMA 200", tech.emas?.ema200],
            ].map(([label, val]) => {
              const sig = !val ? "N/A" : tech.ltp > val * 1.001 ? "BUY" : tech.ltp < val * 0.999 ? "SELL" : "NEUTRAL";
              return (
                <div key={label} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "5px 0", borderBottom: "1px solid #141414",
                }}>
                  <span style={{ color: "#888", fontSize: 12 }}>{label}</span>
                  <span style={{ color: "#ccc", fontSize: 12 }}>₹{fmt(val)}</span>
                  <MASigBadge signal={sig} />
                </div>
              );
            })}
          </div>

          {/* RSI */}
          <div style={{
            background: "#111", border: "1px solid #1e2a3a", borderRadius: 8,
            padding: "12px 14px", marginBottom: 12,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: "#888", fontWeight: 700 }}>RSI (14)</span>
              <span style={{
                fontSize: 14, fontWeight: 800,
                color: tech.rsi > 70 ? "#ff4444" : tech.rsi < 30 ? "#00e676" : "#f9a825",
              }}>{fmt(tech.rsi, 1)}</span>
            </div>
            <div style={{ background: "#1a1a1a", height: 6, borderRadius: 3, overflow: "hidden" }}>
              <div style={{
                width: `${tech.rsi || 0}%`, height: "100%", borderRadius: 3,
                background: tech.rsi > 70 ? "#ff4444" : tech.rsi < 30 ? "#00e676" : "#f9a825",
              }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 10, color: "#333" }}>0 OS</span>
              <span style={{ fontSize: 10, color: "#333" }}>30</span>
              <span style={{ fontSize: 10, color: "#333" }}>70</span>
              <span style={{ fontSize: 10, color: "#333" }}>OB 100</span>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: tech.rsi > 70 ? "#ff4444" : tech.rsi < 30 ? "#00e676" : "#888" }}>
              {tech.rsi > 70 ? "⚠️ Overbought — potential reversal zone" :
               tech.rsi < 30 ? "✅ Oversold — potential bounce zone" :
               "RSI in neutral zone"}
            </div>
          </div>

          {/* MACD */}
          <div style={{
            background: "#111", border: "1px solid #1e2a3a", borderRadius: 8,
            padding: "12px 14px", marginBottom: 12,
          }}>
            <div style={{ fontSize: 12, color: "#888", fontWeight: 700, marginBottom: 8 }}>MACD (12,26,9)</div>
            {tech.macd ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: "#666" }}>MACD Line</span>
                  <span style={{ fontSize: 12, color: "#ccc" }}>{fmt(tech.macd.macd)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: "#666" }}>Signal</span>
                  <span style={{ fontSize: 12, color: "#ccc" }}>{fmt(tech.macd.signal)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: "#666" }}>Histogram</span>
                  <span style={{
                    fontSize: 12, fontWeight: 700,
                    color: tech.macd.histogram > 0 ? "#00e676" : "#ff4444",
                  }}>{fmt(tech.macd.histogram)}</span>
                </div>
                <div style={{
                  padding: "4px 10px", borderRadius: 4, textAlign: "center",
                  background: tech.macd.crossover === "BULLISH" ? "#00e67622" : "#ff444422",
                  color: tech.macd.crossover === "BULLISH" ? "#00e676" : "#ff4444",
                  fontSize: 12, fontWeight: 700,
                }}>
                  {tech.macd.crossover === "BULLISH" ? "▲ BULLISH CROSSOVER" : "▼ BEARISH CROSSOVER"}
                </div>
              </>
            ) : <span style={{ color: "#444" }}>Insufficient data</span>}
          </div>

          {/* Bollinger Bands */}
          <div style={{
            background: "#111", border: "1px solid #1e2a3a", borderRadius: 8,
            padding: "12px 14px", marginBottom: 12,
          }}>
            <div style={{ fontSize: 12, color: "#888", fontWeight: 700, marginBottom: 8 }}>BOLLINGER BANDS (20,2)</div>
            {tech.bollingerBands ? (
              <>
                {[
                  ["Upper", tech.bollingerBands.upper, "#ff4444"],
                  ["Middle (SMA20)", tech.bollingerBands.middle, "#888"],
                  ["Lower", tech.bollingerBands.lower, "#00e676"],
                ].map(([label, val, c]) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: c }}>{label}</span>
                    <span style={{ fontSize: 12, color: "#ccc" }}>₹{fmt(val)}</span>
                  </div>
                ))}
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 11, color: "#666", marginBottom: 3 }}>%B (Position)</div>
                  <div style={{ background: "#1a1a1a", height: 4, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      width: `${Math.max(0, Math.min(100, tech.bollingerBands.percentB || 0))}%`,
                      height: "100%", background: "#7986cb", borderRadius: 2,
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    <span style={{ fontSize: 10, color: "#333" }}>0%</span>
                    <span style={{ fontSize: 10, color: "#888" }}>{tech.bollingerBands.percentB}%</span>
                    <span style={{ fontSize: 10, color: "#333" }}>100%</span>
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <BBadge bb={tech.bollingerBands} />
                  <span style={{ fontSize: 10, color: "#555", marginLeft: 8 }}>BW: {tech.bollingerBands.bandwidth}%</span>
                </div>
              </>
            ) : <span style={{ color: "#444" }}>Insufficient data</span>}
          </div>

          {/* MA Summary */}
          <div style={{
            background: "#111", border: "1px solid #1e2a3a", borderRadius: 8,
            padding: "12px 14px", marginBottom: 12,
          }}>
            <div style={{ fontSize: 12, color: "#888", fontWeight: 700, marginBottom: 10 }}>MA SUMMARY</div>
            {tech.maSummary ? (
              <>
                <div style={{
                  textAlign: "center", padding: "8px", borderRadius: 6, marginBottom: 10,
                  background: tech.maSummary.summary?.includes("BUY")  ? "#00e67611" :
                              tech.maSummary.summary?.includes("SELL") ? "#ff444411" : "#f9a82511",
                  border: `1px solid ${
                    tech.maSummary.summary?.includes("BUY")  ? "#00e67633" :
                    tech.maSummary.summary?.includes("SELL") ? "#ff444433" : "#f9a82533"
                  }`,
                }}>
                  <div style={{ fontSize: 16, fontWeight: 900,
                    color: tech.maSummary.summary?.includes("BUY")  ? "#00e676" :
                           tech.maSummary.summary?.includes("SELL") ? "#ff4444" : "#f9a825",
                  }}>{tech.maSummary.summary}</div>
                  <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>
                    {tech.maSummary.buy}B · {tech.maSummary.sell}S · {tech.maSummary.neutral}N
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px" }}>
                  {tech.maSummary.signals && Object.entries(tech.maSummary.signals).map(([key, s]) => (
                    <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                      <span style={{ fontSize: 10, color: "#555", textTransform: "uppercase" }}>{key}</span>
                      <MASigBadge signal={s.signal} />
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

// ── Gainers/Losers Card ───────────────────────────────────────────────────────
function GainLossCard({ title, stocks, onSelect, color: cardColor, onViewAll }) {
  return (
    <div style={{
      background: "#0a0f16", border: "1px solid #1e2a3a", borderRadius: 10,
      overflow: "hidden", flex: 1,
    }}>
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid #1a1a1a",
        background: `linear-gradient(90deg, ${cardColor}11, transparent)`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontWeight: 800, fontSize: 12, color: cardColor, letterSpacing: "0.8px" }}>{title}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, color: "#444" }}>{stocks.length} stocks</span>
          <button
            onClick={onViewAll}
            style={{
              fontSize: 9, color: cardColor, background: `${cardColor}18`,
              border: `1px solid ${cardColor}44`, borderRadius: 3,
              padding: "2px 7px", cursor: "pointer", fontWeight: 700,
              letterSpacing: "0.5px",
            }}
          >VIEW ALL ↓</button>
        </div>
      </div>
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        {stocks.slice(0, 15).map((s) => (
          <div key={s.symbol} onClick={() => onSelect(s.symbol)}
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "7px 14px", borderBottom: "1px solid #111", cursor: "pointer",
              transition: "background 0.12s",
            }}
            onMouseEnter={e => e.currentTarget.style.background = "#ffffff08"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 12, color: "#ddd" }}>{s.symbol}</div>
              <div style={{ fontSize: 10, color: "#444" }}>₹{fmt(s.ltp)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ color: cardColor, fontWeight: 800, fontSize: 13 }}>
                {s.changePct > 0 ? "+" : ""}{fmt(s.changePct)}%
              </div>
              <div style={{ fontSize: 10, color: "#444" }}>Vol: {fmtK(s.volume)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Sector bar ────────────────────────────────────────────────────────────────
function SectorBar({ sector }) {
  const pct   = sector.avgChange;
  const bull  = pct >= 0;
  const width = Math.min(Math.abs(pct) * 15, 100);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "5px 0", borderBottom: "1px solid #111",
    }}>
      <div style={{ width: 130, fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {sector.sector}
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4 }}>
        <div style={{ width: 80, height: 4, background: "#1a1a1a", borderRadius: 2 }}>
          <div style={{
            width: `${width}%`, height: "100%", borderRadius: 2,
            background: bull ? "#00e676" : "#ff4444",
            marginLeft: bull ? 0 : "auto",
          }} />
        </div>
        <span style={{ color: color(pct), fontWeight: 700, fontSize: 12, width: 52, textAlign: "right" }}>
          {pct > 0 ? "+" : ""}{fmt(pct)}%
        </span>
      </div>
      <span style={{ fontSize: 10, color: "#444", width: 50, textAlign: "right" }}>
        {sector.advancing}↑ {sector.declining}↓
      </span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MarketScannerPage() {
  const [data,        setData]        = useState(null);
  const dataRef = useRef(null);

  const [selectedSym, setSelectedSym] = useState(null);
  const [tech,        setTech]        = useState(null);
  const [techLoading, setTechLoading] = useState(false);
  const [activeTF,    setActiveTF]    = useState("1day");   // ← active timeframe
  const [tab,         setTab]         = useState("gainers");
  const [sortBy,      setSortBy]      = useState("gainers");
  const [searchQ,     setSearchQ]     = useState("");
  const [updatedAt,   setUpdatedAt]   = useState(null);

  const socketRef      = useRef(null);
  const techCacheRef   = useRef({});      // keyed "SYMBOL:timeframe"
  const tabRef         = useRef(tab);
  const tableRef       = useRef(null);
  const selectedSymRef = useRef(null);
  const activeTFRef    = useRef(activeTF);

  // Keep refs in sync
  useEffect(() => { tabRef.current   = tab;      }, [tab]);
  useEffect(() => { activeTFRef.current = activeTF; }, [activeTF]);

  // Derive stocks from data + tab
  const getStocksForTab = useCallback((d, t) => {
    if (!d) return [];
    if (t === "gainers")  return d.gainers          || [];
    if (t === "losers")   return d.losers           || [];
    if (t === "largecap") return d.byMcap?.largecap || [];
    if (t === "midcap")   return d.byMcap?.midcap   || [];
    if (t === "smallcap") return d.byMcap?.smallcap || [];
    if (t === "microcap") return d.byMcap?.microcap || [];
    return [];
  }, []);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    socket.on("scanner-update", (d) => {
      dataRef.current = d;
      setData(d);
      setUpdatedAt(new Date(d.updatedAt));
    });

    return () => { socket.off("scanner-update"); };
  }, []);

  // ── Select symbol + load technicals ──────────────────────────────────────────
  // Accepts optional timeframe — defaults to activeTFRef so it's always current
  const handleSelect = useCallback(async (symbol, timeframe) => {
    const tf = timeframe || activeTFRef.current || "1day";
    const cacheKey = `${symbol}:${tf}`;

    selectedSymRef.current = symbol;
    setSelectedSym(symbol);

    // Serve from cache instantly if available
    if (techCacheRef.current[cacheKey]) {
      setTech(techCacheRef.current[cacheKey]);
      setTechLoading(false);
      return;
    }

    setTech(null);
    setTechLoading(true);
    try {
      const res  = await fetch(`/api/scanner/technicals/${symbol}?timeframe=${tf}`);
      const data = await res.json();
      if (data && !data.error) {
        techCacheRef.current[cacheKey] = data;
        if (selectedSymRef.current === symbol) {
          setTech(data);
          setTechLoading(false);
        }
      } else {
        if (selectedSymRef.current === symbol) setTechLoading(false);
      }
    } catch (e) {
      console.error("Technicals fetch failed:", e);
      if (selectedSymRef.current === symbol) setTechLoading(false);
    }
  }, []);

  // ── Timeframe change handler ──────────────────────────────────────────────────
  const handleTimeframeChange = useCallback((tf) => {
    setActiveTF(tf);
    activeTFRef.current = tf;
    if (selectedSymRef.current) {
      handleSelect(selectedSymRef.current, tf);
    }
  }, [handleSelect]);

  // ── View All: switch tab + scroll to table ────────────────────────────────────
  const handleViewAll = useCallback((tabId) => {
    setTab(tabId);
    setSortBy(tabId === "losers" ? "losers" : "gainers");
    setTimeout(() => {
      tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }, []);

  // Current stock list
  const stocks = getStocksForTab(data, tab);

  const filtered = searchQ
    ? stocks.filter(s =>
        s.symbol.includes(searchQ.toUpperCase()) ||
        (s.name || "").toLowerCase().includes(searchQ.toLowerCase())
      )
    : stocks;

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "gainers")  return b.changePct - a.changePct;
    if (sortBy === "losers")   return a.changePct - b.changePct;
    if (sortBy === "volume")   return b.volume - a.volume;
    if (sortBy === "value")    return b.totalValue - a.totalValue;
    return 0;
  });

  const TABS = [
    { id: "gainers",  label: "Top Gainers",  color: "#00e676" },
    { id: "losers",   label: "Top Losers",   color: "#ff4444" },
    { id: "largecap", label: "Large Cap",    color: "#7986cb" },
    { id: "midcap",   label: "Mid Cap",      color: "#66bb6a" },
    { id: "smallcap", label: "Small Cap",    color: "#ce93d8" },
    { id: "microcap", label: "Micro Cap",    color: "#888" },
    { id: "sector",   label: "Sectors",      color: "#f9a825" },
  ];

  return (
    <div style={{
      background: "#060a10", minHeight: "100vh", color: "#e8f4fd",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
    }}>
      {/* ── Header ── */}
      <div style={{
        background: "#080d14", borderBottom: "1px solid #1e2a3a",
        padding: "12px 20px", display: "flex", alignItems: "center", gap: 16,
        flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, color: "#e8f4fd", letterSpacing: "1px" }}>
            📊 MARKET SCANNER
          </div>
          <div style={{ fontSize: 10, color: "#555" }}>NSE · BSE · Live + Historical</div>
        </div>

        {data?.market && (
          <div style={{ display: "flex", gap: 8, marginLeft: 8 }}>
            <div style={{ background: "#00e67611", border: "1px solid #00e67633", borderRadius: 20, padding: "3px 12px", fontSize: 11, color: "#00e676", fontWeight: 700 }}>
              ▲ {data.market.advancing}
            </div>
            <div style={{ background: "#ff444411", border: "1px solid #ff444433", borderRadius: 20, padding: "3px 12px", fontSize: 11, color: "#ff4444", fontWeight: 700 }}>
              ▼ {data.market.declining}
            </div>
            <div style={{ background: "#33333311", border: "1px solid #333", borderRadius: 20, padding: "3px 12px", fontSize: 11, color: "#666" }}>
              — {data.market.unchanged}
            </div>
          </div>
        )}

        <div style={{ marginLeft: "auto", fontSize: 10, color: "#444" }}>
          {updatedAt ? `Updated ${updatedAt.toLocaleTimeString("en-IN")}` : "Loading…"}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding: "16px 20px 40px" }}>

        {/* Top strip: gainers + losers */}
        {data && (
          <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
            <GainLossCard
              title="TOP GAINERS"
              stocks={data.gainers || []}
              onSelect={(sym) => handleSelect(sym, activeTFRef.current)}
              color="#00e676"
              onViewAll={() => handleViewAll("gainers")}
            />
            <GainLossCard
              title="TOP LOSERS"
              stocks={data.losers || []}
              onSelect={(sym) => handleSelect(sym, activeTFRef.current)}
              color="#ff4444"
              onViewAll={() => handleViewAll("losers")}
            />
          </div>
        )}

        {/* Tabs */}
        <div ref={tableRef} style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "5px 14px", borderRadius: 4, fontSize: 11, fontWeight: 700,
              cursor: "pointer", border: "1px solid",
              borderColor: tab === t.id ? t.color : "#1e2a3a",
              background:  tab === t.id ? `${t.color}18` : "#0a0f16",
              color:       tab === t.id ? t.color : "#555",
              transition: "all 0.15s", letterSpacing: "0.5px",
            }}>{t.label}</button>
          ))}
        </div>

        {/* Sector view */}
        {tab === "sector" ? (
          <div style={{ background: "#0a0f16", border: "1px solid #1e2a3a", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, color: "#555", fontWeight: 700, letterSpacing: "1px", marginBottom: 10 }}>
              SECTOR PERFORMANCE — NSE 500
            </div>
            {(data?.bySector || []).map(s => (
              <SectorBar key={s.sector} sector={s} />
            ))}
          </div>
        ) : (
          <>
            {/* Search + sort bar */}
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
              <input
                placeholder="Search symbol or name…"
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                style={{
                  background: "#0a0f16", border: "1px solid #1e2a3a", borderRadius: 6,
                  color: "#ccc", padding: "6px 12px", fontSize: 12, width: 220,
                  outline: "none", fontFamily: "inherit",
                }}
              />
              <div style={{ display: "flex", gap: 4 }}>
                {[
                  { id: "gainers", label: "% Chg ↑" },
                  { id: "losers",  label: "% Chg ↓" },
                  { id: "volume",  label: "Volume" },
                  { id: "value",   label: "Value" },
                ].map(s => (
                  <button key={s.id} onClick={() => setSortBy(s.id)} style={{
                    padding: "5px 10px", fontSize: 10, borderRadius: 4, cursor: "pointer",
                    border: "1px solid", fontWeight: 700,
                    borderColor: sortBy === s.id ? "#7986cb" : "#1e2a3a",
                    background:  sortBy === s.id ? "#7986cb22" : "#0a0f16",
                    color:       sortBy === s.id ? "#7986cb" : "#555",
                  }}>{s.label}</button>
                ))}
              </div>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#444" }}>
                {sorted.length} stocks
              </span>
            </div>

            {/* Stock table */}
            {!data ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#444" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📡</div>
                <div>Fetching market data…</div>
                <div style={{ fontSize: 11, color: "#333", marginTop: 4 }}>NSE 500 live feed loading</div>
              </div>
            ) : sorted.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#444" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                <div>No stocks in this category yet</div>
                <div style={{ fontSize: 11, color: "#333", marginTop: 4 }}>
                  Scanner may still be loading this segment
                </div>
              </div>
            ) : (
              <div style={{ background: "#0a0f16", border: "1px solid #1e2a3a", borderRadius: 10, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#080d14", borderBottom: "1px solid #1e2a3a" }}>
                      {["#", "Symbol", "LTP", "Change", "Volume", "Cap", "RSI", "MACD", "Bollinger", "MA Signal"].map(h => (
                        <th key={h} style={{
                          padding: "8px 8px", fontSize: 10, color: "#444", fontWeight: 700,
                          textAlign: h === "#" || h === "Symbol" ? "left" : h === "LTP" || h === "Change" || h === "Volume" ? "right" : "left",
                          letterSpacing: "0.5px",
                          position: "sticky", top: 0, background: "#080d14", zIndex: 1,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.slice(0, 100).map((s, i) => (
                      <StockRow
                        key={s.symbol}
                        stock={s}
                        rank={i + 1}
                        onSelect={(sym) => handleSelect(sym, activeTFRef.current)}
                        selected={selectedSym === s.symbol}
                        tech={techCacheRef.current[`${s.symbol}:${activeTF}`] || null}
                      />
                    ))}
                  </tbody>
                </table>
                {sorted.length > 100 && (
                  <div style={{ textAlign: "center", padding: "10px", fontSize: 11, color: "#444", borderTop: "1px solid #111" }}>
                    Showing 100 of {sorted.length} — use search to filter
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Tech Panel ── */}
      {selectedSym && (
        <TechPanel
          symbol={selectedSym}
          tech={techLoading ? null : tech}
          timeframe={activeTF}
          onTimeframeChange={handleTimeframeChange}
          onClose={() => {
            selectedSymRef.current = null;
            setSelectedSym(null);
            setTech(null);
            setActiveTF("1day");
            activeTFRef.current = "1day";
          }}
        />
      )}
    </div>
  );
}
