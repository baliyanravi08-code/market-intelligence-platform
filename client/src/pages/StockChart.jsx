import { useEffect, useRef, useState, useCallback } from "react";

const TF_OPTIONS = [
  { label: "5m",   value: "5min"  },
  { label: "15m",  value: "15min" },
  { label: "1H",   value: "1hour" },
  { label: "4H",   value: "4hour" },
  { label: "1D",   value: "1day"  },
  { label: "1W",   value: "1week" },
];

const COLORS = {
  bg:       "#010812",
  grid:     "#0d1f35",
  text:     "#4a8adf",
  up:       "#00ff9c",
  down:     "#ff4466",
  volume:   "#1a3a5c",
  wick:     "#2a5a8c",
  cross:    "#4a8adf55",
  label:    "#b8cfe8",
};

export default function StockChart({ symbol }) {
  const canvasRef    = useRef(null);
  const overlayRef   = useRef(null);
  const [tf, setTf]  = useState("1day");
  const [candles, setCandles]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [crosshair, setCrosshair] = useState(null);
  const dataRef = useRef([]);

  // ── Fetch candles from server ─────────────────────────────────────────────
  const fetchCandles = useCallback(async (sym, timeframe) => {
    if (!sym) return;
    setLoading(true);
    setError(null);
    try {
      const days = ["5min","15min","1hour"].includes(timeframe) ? 10
                 : timeframe === "4hour" ? 30
                 : timeframe === "1week" ? 365
                 : 180;
      const res  = await fetch(`/api/candles/${sym}?tf=${timeframe}&days=${days}`);
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "No data");
        setCandles([]);
        return;
      }
      if (!data.candles || data.candles.length === 0) {
        setError("No candle data returned");
        setCandles([]);
        return;
      }
      setCandles(data.candles);
      dataRef.current = data.candles;
    } catch (e) {
      setError("Fetch failed: " + e.message);
      setCandles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── FIX: clear stale ltp from previous symbol so terminal inherits correct price ──
  useEffect(() => {
    if (symbol) {
      sessionStorage.removeItem("terminal_ltp");
      fetchCandles(symbol, tf);
    }
  }, [symbol, tf, fetchCandles]);

  // ── Draw chart ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || candles.length === 0) return;

    const ctx    = canvas.getContext("2d");
    const W      = canvas.width;
    const H      = canvas.height;
    const PAD    = { top: 20, right: 60, bottom: 60, left: 10 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;
    const volH   = Math.floor(chartH * 0.18);
    const priceH = chartH - volH - 10;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const data    = candles;
    const n       = data.length;
    const candleW = Math.max(1, Math.floor(chartW / n) - 1);
    const gap     = Math.max(1, Math.floor(chartW / n));

    // Price range
    const highs  = data.map(c => c.high);
    const lows   = data.map(c => c.low);
    const maxP   = Math.max(...highs);
    const minP   = Math.min(...lows);
    const rangeP = maxP - minP || 1;
    const maxVol = Math.max(...data.map(c => c.volume)) || 1;

    const px = (price) => PAD.top + priceH - ((price - minP) / rangeP) * priceH;
    const vx = (vol)   => PAD.top + priceH + 10 + volH - (vol / maxVol) * volH;
    const cx = (i)     => PAD.left + i * gap + gap / 2;

    // Grid lines
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth   = 0.5;
    for (let g = 0; g <= 5; g++) {
      const y = PAD.top + (priceH / 5) * g;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
      const price = maxP - (rangeP / 5) * g;
      ctx.fillStyle  = COLORS.text;
      ctx.font       = "11px monospace";
      ctx.textAlign  = "left";
      ctx.fillText(price.toFixed(0), W - PAD.right + 4, y + 4);
    }

    // Candles
    data.forEach((c, i) => {
      const x    = cx(i);
      const isUp = c.close >= c.open;
      const col  = isUp ? COLORS.up : COLORS.down;

      // Wick
      ctx.strokeStyle = col;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x, px(c.high));
      ctx.lineTo(x, px(c.low));
      ctx.stroke();

      // Body
      const bodyTop = px(Math.max(c.open, c.close));
      const bodyBot = px(Math.min(c.open, c.close));
      const bodyH   = Math.max(1, bodyBot - bodyTop);
      ctx.fillStyle = col;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);

      // Volume bar
      ctx.fillStyle   = col + "88";
      const volTop    = vx(c.volume);
      const volBottom = PAD.top + priceH + 10 + volH;
      ctx.fillRect(x - candleW / 2, volTop, candleW, volBottom - volTop);
    });

    // X-axis time labels
    ctx.fillStyle = COLORS.label;
    ctx.font      = "10px monospace";
    ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(n / 8));
    for (let i = 0; i < n; i += step) {
      const d   = new Date(data[i].time);
      const lbl = ["5min","15min","1hour","4hour"].includes(tf)
        ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
      ctx.fillText(lbl, cx(i), H - 10);
    }

    // Store layout for crosshair
    canvas._layout = { PAD, chartW, chartH, priceH, volH, gap, n, minP, maxP, rangeP, data, px, cx };

  }, [candles, tf]);

  // ── Crosshair ─────────────────────────────────────────────────────────────
  const handleMouseMove = (e) => {
    const canvas  = canvasRef.current;
    if (!canvas || !canvas._layout || candles.length === 0) return;

    const rect   = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const { PAD, gap, n, data, px, cx } = canvas._layout;

    const i = Math.round((mouseX - PAD.left) / gap - 0.5);
    if (i < 0 || i >= n) { setCrosshair(null); return; }

    const c = data[i];
    setCrosshair({ x: cx(i), y: mouseY, candle: c, i });
  };

  // ── FIX: Open full terminal — pass live ltp so chart renders correct price ─
  const openFullChart = () => {
    if (!symbol) return;

    // Use last known close as the seed price for StockTerminal
    const last = candles[candles.length - 1];
    const ltp  = last?.close ?? null;

    sessionStorage.setItem("terminal_symbol", symbol);
    if (ltp) sessionStorage.setItem("terminal_ltp", String(ltp));

    window.dispatchEvent(
      new CustomEvent("open-terminal", {
        detail: { symbol, ltp },
      })
    );
  };

  // ── Summary stats ─────────────────────────────────────────────────────────
  const last   = candles[candles.length - 1];
  const first  = candles[0];
  const chg    = last && first ? last.close - first.open : 0;
  const chgPct = first?.open > 0 ? (chg / first.open) * 100 : 0;
  const isUp   = chg >= 0;

  return (
    <div style={{ background: COLORS.bg, border: "1px solid #0d2a45", borderRadius: 8, padding: 12, userSelect: "none" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "#00cfff", fontFamily: "monospace", fontWeight: "bold", fontSize: 15 }}>
            {symbol}
          </span>
          {last && (
            <>
              <span style={{ color: "#e8f4ff", fontFamily: "monospace", fontSize: 14 }}>
                ₹{last.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </span>
              <span style={{ color: isUp ? COLORS.up : COLORS.down, fontFamily: "monospace", fontSize: 13 }}>
                {isUp ? "+" : ""}{chg.toFixed(2)} ({isUp ? "+" : ""}{chgPct.toFixed(2)}%)
              </span>
            </>
          )}
        </div>

        {/* Timeframe selector */}
        <div style={{ display: "flex", gap: 4 }}>
          {TF_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setTf(opt.value)}
              style={{
                padding:      "3px 10px",
                borderRadius: 4,
                border:       `1px solid ${tf === opt.value ? "#00cfff" : "#0d2a45"}`,
                background:   tf === opt.value ? "#00cfff22" : "transparent",
                color:        tf === opt.value ? "#00cfff" : "#4a8adf",
                fontFamily:   "monospace",
                fontSize:     12,
                cursor:       "pointer",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Crosshair tooltip */}
      {crosshair && (
        <div style={{
          fontFamily: "monospace", fontSize: 11, color: COLORS.label,
          marginBottom: 6, display: "flex", gap: 16,
          background: "#0d1f35", padding: "4px 10px", borderRadius: 4,
        }}>
          <span>O: <b style={{ color: "#e8f4ff" }}>{crosshair.candle.open.toFixed(2)}</b></span>
          <span>H: <b style={{ color: COLORS.up }}>{crosshair.candle.high.toFixed(2)}</b></span>
          <span>L: <b style={{ color: COLORS.down }}>{crosshair.candle.low.toFixed(2)}</b></span>
          <span>C: <b style={{ color: "#e8f4ff" }}>{crosshair.candle.close.toFixed(2)}</b></span>
          <span>V: <b style={{ color: "#4a8adf" }}>{(crosshair.candle.volume / 1e5).toFixed(2)}L</b></span>
          <span style={{ color: "#4a8adf" }}>
            {new Date(crosshair.candle.time).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
          </span>
        </div>
      )}

      {/* Canvas */}
      <div style={{ position: "relative" }}>
        {loading && (
          <div style={{
            position: "absolute", inset: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "#010812cc", borderRadius: 6, zIndex: 10,
          }}>
            <span style={{ color: "#00cfff", fontFamily: "monospace" }}>Loading {tf} candles...</span>
          </div>
        )}
        {error && !loading && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            background: "#010812cc", borderRadius: 6, zIndex: 10, gap: 8,
          }}>
            <span style={{ color: "#ff4466", fontFamily: "monospace", fontSize: 13 }}>⚠️ {error}</span>
            {error.includes("token") || error.includes("auth") ? (
              <a href="/auth/upstox" style={{ color: "#00cfff", fontFamily: "monospace", fontSize: 12 }}>
                Click here to connect Upstox →
              </a>
            ) : (
              <button
                onClick={() => fetchCandles(symbol, tf)}
                style={{ color: "#00cfff", background: "transparent", border: "1px solid #00cfff44", padding: "4px 12px", borderRadius: 4, fontFamily: "monospace", cursor: "pointer" }}
              >
                Retry
              </button>
            )}
          </div>
        )}

        <div style={{ position: "relative" }}>
          <canvas
            ref={canvasRef}
            width={820}
            height={420}
            style={{ width: "100%", height: "auto", borderRadius: 6, cursor: "crosshair", display: "block" }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setCrosshair(null)}
          />

          {/* Full Chart button — fires open-terminal with correct symbol + ltp */}
          <div
            onClick={openFullChart}
            style={{
              position:   "absolute", top: 8, right: 8,
              background: "rgba(0,207,255,0.12)",
              border:     "1px solid rgba(0,207,255,0.35)",
              borderRadius: 4, padding: "3px 10px",
              color:      "#00cfff", fontSize: 10,
              fontFamily: "monospace", cursor: "pointer",
              zIndex: 5, userSelect: "none",
              transition: "background 0.15s",
            }}
            title={`Open full chart for ${symbol}`}
          >
            ↗ Full Chart
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ marginTop: 6, fontFamily: "monospace", fontSize: 10, color: "#2a5a8c", textAlign: "right" }}>
        {candles.length > 0 ? `${candles.length} candles · ${tf} · Upstox` : ""}
      </div>
    </div>
  );
}
