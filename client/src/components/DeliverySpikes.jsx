/**
 * DeliverySpikes.jsx
 * Frontend component — shows live delivery spike alerts.
 *
 * Place at: client/src/components/DeliverySpikes.jsx
 *
 * Usage in your main layout:
 *   import DeliverySpikes from './components/DeliverySpikes';
 *   <DeliverySpikes socket={socket} />
 */

import { useState, useEffect } from "react";

const STRENGTH_STYLE = {
  EXTREME:  { bg: "#2e0808", border: "#ff2222", text: "#ff6666", dot: "#ff2222" },
  STRONG:   { bg: "#1a1a08", border: "#ffaa00", text: "#ffcc44", dot: "#ffaa00" },
  MODERATE: { bg: "#0a1a0a", border: "#22cc55", text: "#44ee77", dot: "#22cc55" },
};

export default function DeliverySpikes({ socket }) {
  const [spikes, setSpikes] = useState([]);

  useEffect(() => {
    if (!socket) return;

    socket.on("delivery-spikes", (newSpikes) => {
      setSpikes((prev) => {
        // Merge — newest first, cap at 20
        const merged = [...newSpikes, ...prev];
        const seen   = new Set();
        return merged
          .filter((s) => {
            const key = s.symbol + s.timestamp;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 20);
      });
    });

    return () => socket.off("delivery-spikes");
  }, [socket]);

  if (spikes.length === 0) return null;

  return (
    <div style={{ padding: "10px 12px" }}>
      <div style={{
        fontSize: 9, letterSpacing: 2, color: "#3d5066",
        textTransform: "uppercase", marginBottom: 8
      }}>
        ⚡ Delivery Spikes
      </div>

      {spikes.map((spike, i) => {
        const style = STRENGTH_STYLE[spike.strength] || STRENGTH_STYLE.MODERATE;
        return (
          <div key={i} style={{
            background:   style.bg,
            border:       `1px solid ${style.border}`,
            borderRadius: 4,
            padding:      "8px 10px",
            marginBottom: 6,
          }}>

            {/* Header row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: style.dot, display: "inline-block"
                }} />
                <span style={{ color: style.text, fontSize: 12, fontWeight: "bold" }}>
                  {spike.symbol}
                </span>
              </div>
              <span style={{
                fontSize: 9, padding: "2px 6px", borderRadius: 2,
                background: style.border + "22",
                color: style.text,
                border: `1px solid ${style.border}44`,
              }}>
                {spike.strength}
              </span>
            </div>

            {/* Delivery bar */}
            <div style={{ marginBottom: 5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 3 }}>
                <span style={{ color: "#6b7a8d" }}>Avg {spike.avgPast}%</span>
                <span style={{ color: style.text, fontWeight: "bold" }}>
                  Now {spike.deliveryPct}% (+{spike.spikePts}pts)
                </span>
              </div>
              <div style={{ height: 4, background: "#1a1f26", borderRadius: 2, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width:  `${spike.deliveryPct}%`,
                  background: style.dot,
                  borderRadius: 2,
                  transition: "width 0.6s ease",
                }} />
              </div>
            </div>

            {/* Meta row */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7a8d" }}>
              <span>₹{spike.ltp} ({spike.change > 0 ? "+" : ""}{spike.change}%)</span>
              <span>Vol ₹{spike.tradedCr}Cr</span>
              <span style={{
                color: spike.action === "POSSIBLE_BREAKOUT" ? "#39d96a" : "#ffa500",
                fontSize: 9
              }}>
                {spike.action === "POSSIBLE_BREAKOUT" ? "▲ BREAKOUT" : "◈ ACCUMULATION"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
