// GannBadge.jsx
// client/src/components/GannBadge.jsx

/**
 * GannBadge — shows a compact Gann bias badge inline in the score card,
 * or a full badge with support/resistance levels in the Market Structure panel.
 *
 * Props:
 *   symbol    {string}  — active symbol, e.g. "NIFTY 50"
 *   gannMap   {object}  — map of symbol → { bias, support, resistance, angle }
 *   compact   {boolean} — true = pill badge only, false = full badge with levels
 */

const BIAS_STYLES = {
  STRONG_BULLISH: { color: "#00ff9c", bg: "#003318", border: "#00ff9c55", label: "STRONG BULL" },
  BULLISH:        { color: "#00ff9c", bg: "#002210", border: "#00ff9c33", label: "BULLISH"     },
  NEUTRAL:        { color: "#ffd54f", bg: "#1a1500", border: "#ffd54f33", label: "NEUTRAL"     },
  BEARISH:        { color: "#ef5350", bg: "#1a0000", border: "#ef535033", label: "BEARISH"     },
  STRONG_BEARISH: { color: "#ef5350", bg: "#280000", border: "#ef535055", label: "STRONG BEAR" },
};

function fmtInt(n) {
  if (n == null) return "—";
  return Math.round(Number(n)).toLocaleString("en-IN");
}

export default function GannBadge({ symbol, gannMap, compact = false }) {
  // Always return a valid element — never undefined/null at top level
  if (!symbol || !gannMap) {
    return compact ? null : <span />;
  }

  const entry = gannMap[symbol] || gannMap[symbol?.toUpperCase()] || null;

  if (!entry) {
    return compact ? null : <span />;
  }

  const bias  = entry.bias || "NEUTRAL";
  const style = BIAS_STYLES[bias] || BIAS_STYLES.NEUTRAL;

  // ── Compact pill (used in score card header) ─────────────────────────────
  if (compact) {
    return (
      <span style={{
        display:        "inline-flex",
        alignItems:     "center",
        gap:            3,
        fontSize:       7,
        fontFamily:     "IBM Plex Mono, monospace",
        fontWeight:     700,
        padding:        "1px 5px",
        borderRadius:   2,
        background:     style.bg,
        color:          style.color,
        border:         `1px solid ${style.border}`,
        whiteSpace:     "nowrap",
        letterSpacing:  0.5,
        flexShrink:     0,
      }}>
        <span style={{ fontSize: 8 }}>◤</span>
        {style.label}
        {entry.angle != null && (
          <span style={{ color: style.color, opacity: 0.7, marginLeft: 2 }}>
            {entry.angle.toFixed(1)}°
          </span>
        )}
      </span>
    );
  }

  // ── Full badge (used in Market Structure panel) ──────────────────────────
  return (
    <div style={{
      background:   style.bg,
      border:       `1px solid ${style.border}`,
      borderRadius: 4,
      padding:      "5px 8px",
    }}>
      {/* Header row */}
      <div style={{
        display:        "flex",
        alignItems:     "center",
        justifyContent: "space-between",
        marginBottom:   4,
      }}>
        <div style={{
          display:    "flex",
          alignItems: "center",
          gap:        5,
        }}>
          <span style={{ fontSize: 10, color: style.color }}>◤</span>
          <span style={{
            fontSize:      8,
            fontFamily:    "IBM Plex Mono, monospace",
            fontWeight:    700,
            color:         style.color,
            letterSpacing: 1,
          }}>
            GANN · {style.label}
          </span>
        </div>
        {entry.angle != null && (
          <span style={{
            fontSize:   7,
            fontFamily: "IBM Plex Mono, monospace",
            color:      style.color,
            opacity:    0.75,
          }}>
            {entry.angle.toFixed(1)}° on square
          </span>
        )}
      </div>

      {/* Support / Resistance row */}
      {(entry.support != null || entry.resistance != null) && (
        <div style={{ display: "flex", gap: 8 }}>
          {entry.support != null && (
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize:      6,
                color:         "#c8d8e8",
                fontFamily:    "IBM Plex Mono, monospace",
                letterSpacing: 0.8,
                marginBottom:  1,
              }}>
                SUPPORT
              </div>
              <div style={{
                fontSize:   9,
                fontWeight: 700,
                color:      "#00ff9c",
                fontFamily: "IBM Plex Mono, monospace",
              }}>
                ₹{fmtInt(entry.support)}
              </div>
            </div>
          )}
          {entry.resistance != null && (
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize:      6,
                color:         "#c8d8e8",
                fontFamily:    "IBM Plex Mono, monospace",
                letterSpacing: 0.8,
                marginBottom:  1,
              }}>
                RESISTANCE
              </div>
              <div style={{
                fontSize:   9,
                fontWeight: 700,
                color:      "#ef5350",
                fontFamily: "IBM Plex Mono, monospace",
              }}>
                ₹{fmtInt(entry.resistance)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
