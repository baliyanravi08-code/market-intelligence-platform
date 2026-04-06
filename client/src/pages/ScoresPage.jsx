/**
 * ScoresPage.jsx
 * client/src/pages/ScoresPage.jsx
 *
 * Composite score leaderboard — flow-first intelligence fusion.
 * Receives: "composite-scores" (full board) and "composite-update" (single stock)
 */

import { useEffect, useState, useRef } from "react";

const GRADE_CONFIG = {
  A: { color: "#00ff88", bg: "rgba(0,255,136,0.12)", label: "ELITE" },
  B: { color: "#4fc3f7", bg: "rgba(79,195,247,0.12)", label: "STRONG" },
  C: { color: "#ffd54f", bg: "rgba(255,213,79,0.12)",  label: "MODERATE" },
  D: { color: "#ff8a65", bg: "rgba(255,138,101,0.12)", label: "WEAK" },
  F: { color: "#ef5350", bg: "rgba(239,83,80,0.12)",   label: "AVOID" },
};

const BIAS_CONFIG = {
  BULLISH: { color: "#00ff88", icon: "▲", bg: "rgba(0,255,136,0.10)" },
  BEARISH: { color: "#ef5350", icon: "▼", bg: "rgba(239,83,80,0.10)" },
  NEUTRAL: { color: "#90a4ae", icon: "●", bg: "rgba(144,164,174,0.10)" },
};

const SIGNAL_COLORS = {
  green: "#00ff88",
  amber: "#ffd54f",
  orange: "#ff8a65",
  red:   "#ef5350",
  gray:  "#546e7a",
};

function ScoreBar({ score, grade }) {
  const cfg = GRADE_CONFIG[grade] || GRADE_CONFIG.F;
  return (
    <div style={{ width: "100%", position: "relative" }}>
      <div style={{
        height: 4,
        background: "rgba(255,255,255,0.06)",
        borderRadius: 2,
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${score}%`,
          background: `linear-gradient(90deg, ${cfg.color}88, ${cfg.color})`,
          borderRadius: 2,
          transition: "width 0.6s cubic-bezier(.4,0,.2,1)",
          boxShadow: `0 0 8px ${cfg.color}60`,
        }} />
      </div>
    </div>
  );
}

function GradeBadge({ grade }) {
  const cfg = GRADE_CONFIG[grade] || GRADE_CONFIG.F;
  return (
    <div style={{
      width: 32, height: 32,
      borderRadius: "50%",
      background: cfg.bg,
      border: `1.5px solid ${cfg.color}60`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 700,
      fontSize: 13,
      color: cfg.color,
      flexShrink: 0,
      boxShadow: `0 0 12px ${cfg.color}30`,
    }}>
      {grade}
    </div>
  );
}

function BiasPill({ bias }) {
  const cfg = BIAS_CONFIG[bias] || BIAS_CONFIG.NEUTRAL;
  return (
    <span style={{
      padding: "2px 8px",
      borderRadius: 3,
      background: cfg.bg,
      border: `1px solid ${cfg.color}40`,
      color: cfg.color,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 700,
      letterSpacing: "0.05em",
    }}>
      {cfg.icon} {bias}
    </span>
  );
}

function SignalDot({ score }) {
  const color = score >= 70 ? "#00ff88" : score >= 40 ? "#ffd54f" : "#546e7a";
  return (
    <div style={{
      width: 8, height: 8, borderRadius: "50%",
      background: color,
      boxShadow: `0 0 6px ${color}80`,
      flexShrink: 0,
    }} />
  );
}

function DrillDown({ stock, onClose }) {
  if (!stock) return null;
  const gradeCfg = GRADE_CONFIG[stock.grade] || GRADE_CONFIG.F;

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.75)",
      backdropFilter: "blur(8px)",
      zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }} onClick={onClose}>
      <div style={{
        background: "#0d1117",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: 28,
        width: "100%",
        maxWidth: 560,
        boxShadow: `0 0 60px ${gradeCfg.color}20`,
        position: "relative",
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
          <GradeBadge grade={stock.grade} />
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 16, fontWeight: 700,
              color: "#e8eaed",
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "0.03em",
            }}>
              {stock.symbol}
            </div>
            <div style={{ fontSize: 11, color: "#546e7a", marginTop: 2 }}>
              {stock.company || stock.symbol}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{
              fontSize: 36, fontWeight: 800,
              color: gradeCfg.color,
              fontFamily: "'JetBrains Mono', monospace",
              lineHeight: 1,
            }}>
              {stock.finalScore}
            </div>
            <div style={{ fontSize: 10, color: "#546e7a", marginTop: 4 }}>
              COMPOSITE SCORE
            </div>
          </div>
        </div>

        {/* Score bar */}
        <div style={{ marginBottom: 20 }}>
          <ScoreBar score={stock.finalScore} grade={stock.grade} />
        </div>

        {/* Bias */}
        <div style={{ marginBottom: 20, display: "flex", gap: 8, alignItems: "center" }}>
          <BiasPill bias={stock.bias} />
          <span style={{ fontSize: 11, color: "#546e7a" }}>
            {gradeCfg.label} · {stock.signals?.length || 0} active signal{stock.signals?.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Signal breakdown */}
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: "#546e7a",
            letterSpacing: "0.1em", marginBottom: 10,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            SIGNAL BREAKDOWN
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(stock.allReasons || stock.top3Reasons || []).map((r, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 10,
                padding: "10px 12px",
                background: "rgba(255,255,255,0.03)",
                borderRadius: 8,
                border: `1px solid rgba(255,255,255,0.05)`,
              }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>{r.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700,
                      color: SIGNAL_COLORS[r.color] || "#90a4ae",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}>
                      {r.label}
                    </span>
                    <span style={{
                      fontSize: 13, fontWeight: 700,
                      color: SIGNAL_COLORS[r.color] || "#90a4ae",
                      fontFamily: "'JetBrains Mono', monospace",
                    }}>
                      {r.score}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: "#546e7a", marginTop: 3 }}>
                    {r.detail}
                  </div>
                  {/* Mini score bar */}
                  <div style={{
                    height: 2, background: "rgba(255,255,255,0.06)",
                    borderRadius: 1, marginTop: 6, overflow: "hidden",
                  }}>
                    <div style={{
                      height: "100%",
                      width: `${r.score}%`,
                      background: SIGNAL_COLORS[r.color] || "#546e7a",
                      borderRadius: 1,
                    }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Raw data */}
        {stock.raw && (
          <div style={{
            padding: "10px 12px",
            background: "rgba(255,255,255,0.02)",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.04)",
            fontSize: 11,
            color: "#546e7a",
            fontFamily: "'JetBrains Mono', monospace",
            marginBottom: 20,
          }}>
            {stock.raw.circuit && (
              <div>CIRCUIT: {stock.raw.circuit.tier} · {stock.raw.circuit.side} · {stock.raw.circuit.distPct}% away · LTP ₹{stock.raw.circuit.ltp}</div>
            )}
            {stock.raw.smartMoney && (
              <div>FLOW: ₹{stock.raw.smartMoney.value}Cr · {stock.raw.smartMoney.deals} deals</div>
            )}
            {stock.raw.opportunity && (
              <div>ORDER: ₹{stock.raw.opportunity.orderValue}Cr · {stock.raw.opportunity.score?.toFixed(1)}% of MCap</div>
            )}
            {stock.raw.credibility && (
              <div>CREDIBILITY: {stock.raw.credibility.score}/100 · {stock.raw.credibility.label}</div>
            )}
          </div>
        )}

        <div style={{ fontSize: 10, color: "#2d3748", textAlign: "right" }}>
          Updated {stock.updatedAt ? new Date(stock.updatedAt).toLocaleTimeString() : "—"}
        </div>

        <button onClick={onClose} style={{
          position: "absolute", top: 16, right: 16,
          background: "none", border: "none",
          color: "#546e7a", fontSize: 18, cursor: "pointer",
          lineHeight: 1, padding: 4,
        }}>✕</button>
      </div>
    </div>
  );
}

function HeatmapView({ scores }) {
  const [selected, setSelected] = useState(null);
  if (!scores.length) return (
    <div style={{ textAlign: "center", padding: 60, color: "#546e7a", fontSize: 13 }}>
      Waiting for signals…
    </div>
  );

  return (
    <>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
        gap: 6,
        padding: "16px 0",
      }}>
        {scores.map(stock => {
          const cfg  = GRADE_CONFIG[stock.grade] || GRADE_CONFIG.F;
          const bias = BIAS_CONFIG[stock.bias] || BIAS_CONFIG.NEUTRAL;
          return (
            <div key={stock.symbol}
              onClick={() => setSelected(stock)}
              style={{
                padding: "10px 8px",
                borderRadius: 8,
                background: cfg.bg,
                border: `1px solid ${cfg.color}30`,
                cursor: "pointer",
                textAlign: "center",
                transition: "transform 0.15s, box-shadow 0.15s",
                position: "relative",
              }}
              onMouseEnter={e => {
                e.currentTarget.style.transform = "scale(1.04)";
                e.currentTarget.style.boxShadow = `0 0 20px ${cfg.color}30`;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.transform = "scale(1)";
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              <div style={{
                fontSize: 9, color: bias.color,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700, marginBottom: 4,
              }}>
                {bias.icon}
              </div>
              <div style={{
                fontSize: 10, fontWeight: 700,
                color: "#e8eaed",
                fontFamily: "'JetBrains Mono', monospace",
                overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap", marginBottom: 4,
              }}>
                {stock.symbol}
              </div>
              <div style={{
                fontSize: 18, fontWeight: 800,
                color: cfg.color,
                fontFamily: "'JetBrains Mono', monospace",
                lineHeight: 1,
              }}>
                {stock.finalScore}
              </div>
              <div style={{
                fontSize: 9, color: cfg.color,
                fontFamily: "'JetBrains Mono', monospace",
                marginTop: 2, opacity: 0.7,
              }}>
                {stock.grade}
              </div>
            </div>
          );
        })}
      </div>
      {selected && <DrillDown stock={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function LeaderboardView({ scores }) {
  const [selected, setSelected] = useState(null);
  const [filter, setFilter]     = useState("ALL");

  const filtered = filter === "ALL" ? scores
    : filter === "BULLISH" || filter === "BEARISH" || filter === "NEUTRAL"
      ? scores.filter(s => s.bias === filter)
      : scores.filter(s => s.grade === filter);

  return (
    <>
      {/* Filter pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {["ALL", "BULLISH", "BEARISH", "A", "B", "C"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "4px 10px",
            borderRadius: 4,
            border: `1px solid ${filter === f ? "#4fc3f7" : "rgba(255,255,255,0.08)"}`,
            background: filter === f ? "rgba(79,195,247,0.12)" : "transparent",
            color: filter === f ? "#4fc3f7" : "#546e7a",
            fontSize: 11, fontWeight: 700, cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {f}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#546e7a", alignSelf: "center" }}>
          {filtered.length} stocks
        </span>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", overflowY: "visible" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["#", "STOCK", "SCORE", "GRADE", "BIAS", "TOP SIGNAL", "SIGNALS"].map(h => (
                <th key={h} style={{
                  padding: "6px 10px", textAlign: "left",
                  fontSize: 10, fontWeight: 700,
                  color: "#546e7a", letterSpacing: "0.1em",
                  fontFamily: "'JetBrains Mono', monospace",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((stock, idx) => {
              const gradeCfg = GRADE_CONFIG[stock.grade] || GRADE_CONFIG.F;
              const top = stock.top3Reasons?.[0];
              return (
                <tr key={stock.symbol}
                  onClick={() => setSelected(stock)}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  <td style={{ padding: "10px 10px", fontSize: 11, color: "#2d3748", fontFamily: "'JetBrains Mono', monospace" }}>
                    {idx + 1}
                  </td>
                  <td style={{ padding: "10px 10px" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#e8eaed", fontFamily: "'JetBrains Mono', monospace" }}>
                      {stock.symbol}
                    </div>
                    <div style={{ fontSize: 10, color: "#546e7a", marginTop: 1 }}>
                      {(stock.company || "").slice(0, 22)}
                    </div>
                  </td>
                  <td style={{ padding: "10px 10px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 80 }}>
                      <span style={{
                        fontSize: 16, fontWeight: 800,
                        color: gradeCfg.color,
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>
                        {stock.finalScore}
                      </span>
                      <ScoreBar score={stock.finalScore} grade={stock.grade} />
                    </div>
                  </td>
                  <td style={{ padding: "10px 10px" }}>
                    <GradeBadge grade={stock.grade} />
                  </td>
                  <td style={{ padding: "10px 10px" }}>
                    <BiasPill bias={stock.bias} />
                  </td>
                  <td style={{ padding: "10px 10px", maxWidth: 200 }}>
                    {top && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13 }}>{top.icon}</span>
                        <div>
                          <div style={{ fontSize: 10, color: SIGNAL_COLORS[top.color] || "#90a4ae", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
                            {top.label}
                          </div>
                          <div style={{ fontSize: 10, color: "#546e7a", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>
                            {top.detail}
                          </div>
                        </div>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "10px 10px" }}>
                    <div style={{ display: "flex", gap: 4 }}>
                      {(stock.signals || []).map(s => (
                        <SignalDot key={s.key} score={s.score} />
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && (
          <div style={{ textAlign: "center", padding: 40, color: "#546e7a", fontSize: 13 }}>
            No stocks match filter
          </div>
        )}
      </div>

      {selected && <DrillDown stock={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────
function StatsBar({ scores }) {
  const bullish = scores.filter(s => s.bias === "BULLISH").length;
  const bearish = scores.filter(s => s.bias === "BEARISH").length;
  const gradeA  = scores.filter(s => s.grade === "A").length;
  const avg     = scores.length
    ? Math.round(scores.reduce((s, d) => s + d.finalScore, 0) / scores.length)
    : 0;

  const stats = [
    { label: "TOTAL STOCKS", value: scores.length, color: "#90a4ae" },
    { label: "BULLISH",      value: bullish,        color: "#00ff88" },
    { label: "BEARISH",      value: bearish,        color: "#ef5350" },
    { label: "GRADE A",      value: gradeA,         color: "#00ff88" },
    { label: "AVG SCORE",    value: avg,            color: "#4fc3f7" },
  ];

  return (
    <div style={{
      display: "flex", gap: 0,
      borderRadius: 8,
      overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.06)",
      marginBottom: 16,
    }}>
      {stats.map((s, i) => (
        <div key={s.label} style={{
          flex: 1, padding: "10px 14px",
          borderRight: i < stats.length - 1 ? "1px solid rgba(255,255,255,0.06)" : "none",
          background: "rgba(255,255,255,0.02)",
        }}>
          <div style={{
            fontSize: 18, fontWeight: 800,
            color: s.color,
            fontFamily: "'JetBrains Mono', monospace",
            lineHeight: 1,
          }}>
            {s.value}
          </div>
          <div style={{
            fontSize: 9, color: "#546e7a",
            fontFamily: "'JetBrains Mono', monospace",
            marginTop: 4, letterSpacing: "0.08em",
          }}>
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ScoresPage({ socket }) {
  const [scores,    setScores]    = useState([]);
  const [view,      setView]      = useState("leaderboard"); // "leaderboard" | "heatmap"
  const [lastUpdate, setLastUpdate] = useState(null);

  useEffect(() => {
    if (!socket) return;

    socket.on("composite-scores", (data) => {
      setScores(Array.isArray(data) ? data : []);
      setLastUpdate(Date.now());
    });

    socket.on("composite-update", (update) => {
      if (!update?.symbol) return;
      setScores(prev => {
        const idx = prev.findIndex(s => s.symbol === update.symbol);
        if (idx === -1) return [update, ...prev].sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
        const next = [...prev];
        next[idx] = update;
        return next.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
      });
      setLastUpdate(Date.now());
    });

    // Request initial data
    socket.emit("get-composite-scores");

    return () => {
      socket.off("composite-scores");
      socket.off("composite-update");
    };
  }, [socket]);

  return (
    <div style={{
      background: "#060a0f",
      color: "#e8eaed",
      fontFamily: "'JetBrains Mono', monospace",
      padding: "0 0 40px",
    }}>
      {/* Header */}
      <div style={{
        padding: "16px 20px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        display: "flex", alignItems: "center", gap: 12,
        flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>⚡</span>
          <span style={{
            fontSize: 13, fontWeight: 700,
            color: "#e8eaed", letterSpacing: "0.12em",
          }}>
            COMPOSITE SCORES
          </span>
        </div>

        <div style={{
          fontSize: 10, color: "#546e7a",
          padding: "3px 8px",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 4,
        }}>
          FLOW-FIRST · SMART MONEY 35% · CIRCUIT 25% · OPPORTUNITY 20% · CREDIBILITY 20%
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {lastUpdate && (
            <span style={{ fontSize: 10, color: "#2d3748" }}>
              {new Date(lastUpdate).toLocaleTimeString()}
            </span>
          )}
          {/* View toggle */}
          <div style={{
            display: "flex",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 6, overflow: "hidden",
          }}>
            {[["leaderboard", "≡ LIST"], ["heatmap", "⊞ MAP"]].map(([v, label]) => (
              <button key={v} onClick={() => setView(v)} style={{
                padding: "5px 12px",
                background: view === v ? "rgba(79,195,247,0.12)" : "transparent",
                color: view === v ? "#4fc3f7" : "#546e7a",
                border: "none", cursor: "pointer",
                fontSize: 10, fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "0.05em",
              }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: "16px 20px" }}>
        <StatsBar scores={scores} />
        {view === "leaderboard"
          ? <LeaderboardView scores={scores} />
          : <HeatmapView scores={scores} />
        }
      </div>
    </div>
  );
}
