// GannBadge.jsx
// compact=true  → tiny inline badge (Radar cards)
// compact=false → expanded block card (Scores page)

export default function GannBadge({ symbol, gannMap, compact = true }) {
  if (!symbol || !gannMap) return null;
  const g = gannMap[symbol] || gannMap[symbol?.toUpperCase()];
  if (!g) return null;

  const bias    = g.bias || g.signal || "NEUTRAL";
  const support = g.support ?? g.s1 ?? null;
  const resist  = g.resistance ?? g.r1 ?? null;
  const angle   = g.angle ?? g.gannAngle ?? null;

  const palette = {
    STRONG_BULLISH: { color: "#00ff9c", bg: "#003318", border: "#00ff9c66" },
    BULLISH:        { color: "#00ff9c", bg: "#002210", border: "#00ff9c44" },
    NEUTRAL:        { color: "#ffd54f", bg: "#1a1500", border: "#ffd54f44" },
    BEARISH:        { color: "#ef5350", bg: "#1a0000", border: "#ef535044" },
    STRONG_BEARISH: { color: "#ef5350", bg: "#280000", border: "#ef535066" },
  };
  const c = palette[bias] || palette.NEUTRAL;
  const shortBias = bias.replace("STRONG_", "S·").replace(/_/g, "");
  const tooltip = ["Gann: " + bias, support ? "S: " + Number(support).toFixed(0) : null, resist ? "R: " + Number(resist).toFixed(0) : null, angle ? angle + "°" : null].filter(Boolean).join(" · ");

  if (compact) {
    return (
      <span title={tooltip} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 6px", borderRadius: 3, background: c.bg, border: "1px solid " + c.border, fontSize: 10, fontWeight: 700, color: c.color, fontFamily: "'IBM Plex Mono', monospace", cursor: "default", flexShrink: 0 }}>
        📐{shortBias}
        {angle != null && <span style={{ fontSize: 8, opacity: 0.7 }}>{angle}°</span>}
      </span>
    );
  }

  return (
    <div style={{ background: c.bg, border: "1px solid " + c.border, borderRadius: 6, padding: "8px 10px", display: "inline-flex", flexDirection: "column", gap: 4, minWidth: 110 }}>
      <div style={{ fontSize: 8, color: "#1a5070", fontFamily: "IBM Plex Mono,monospace", letterSpacing: 1 }}>GANN</div>
      <div style={{ fontSize: 11, fontWeight: 700, color: c.color, fontFamily: "IBM Plex Mono,monospace" }}>
        📐 {bias.replace(/_/g, " ")}
        {angle != null && <span style={{ fontSize: 9, marginLeft: 5, opacity: 0.7 }}>{angle}°</span>}
      </div>
      {(support != null || resist != null) && (
        <div style={{ display: "flex", gap: 10, fontSize: 9, fontFamily: "IBM Plex Mono,monospace" }}>
          {support != null && <span style={{ color: "#00ff9c" }}>S {Number(support).toFixed(0)}</span>}
          {resist  != null && <span style={{ color: "#ef5350" }}>R {Number(resist).toFixed(0)}</span>}
        </div>
      )}
    </div>
  );
}
