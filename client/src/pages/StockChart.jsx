import { useEffect, useRef, useState, useCallback } from "react";

const TF_OPTIONS = [
  { label: "5m",   value: "5min"  },
  { label: "15m",  value: "15min" },
  { label: "1H",   value: "1hour" },
  { label: "4H",   value: "4hour" },
  { label: "1D",   value: "1day"  },
  { label: "1W",   value: "1week" },
];

const TF_LIVE_MAP = { "5min": "5min", "15min": "15min", "1hour": "1hour", "4hour": "4hour" };
const TF_MS = {
  "5min":  5  * 60_000,
  "15min": 15 * 60_000,
  "1hour": 60 * 60_000,
  "4hour": 4  * 60 * 60_000,
};

const COLORS = {
  bg:    "#010812",
  grid:  "#0d1f35",
  text:  "#4a8adf",
  up:    "#00ff9c",
  down:  "#ff4466",
  label: "#b8cfe8",
};

export default function StockChart({ symbol, socket }) {
  const canvasRef    = useRef(null);
  const [tf, setTf]  = useState("1day");
  const [candles, setCandles]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [crosshair, setCrosshair] = useState(null);
  const [liveBlink, setLiveBlink] = useState(false);
  const candlesRef = useRef([]);
  const tfRef      = useRef("1day");
  const blinkTimer = useRef(null);

  // keep refs in sync
 
  // keep refs in sync so socket handlers always see latest values
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { tfRef.current = tf; }, [tf]);

  // ── Fetch candles ──────────────────────────────────────────────────────────
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
      if (!data.ok) { setError(data.error || "No data"); setCandles([]); return; }
      if (!data.candles?.length) { setError("No candle data returned"); setCandles([]); return; }
      setCandles(data.candles);
      candlesRef.current = data.candles;
    } catch (e) {
      setError("Fetch failed: " + e.message);
      setCandles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (symbol) {
      sessionStorage.removeItem("terminal_ltp");
      fetchCandles(symbol, tf);
    }
  }, [symbol, tf, fetchCandles]);

  // ── Live tick flash helper ─────────────────────────────────────────────────
  const flashBlink = useCallback(() => {
    setLiveBlink(true);
    clearTimeout(blinkTimer.current);
    blinkTimer.current = setTimeout(() => setLiveBlink(false), 800);
  }, []);

  // ── Socket: candle:tick + candle:closed + price:tick ──────────────────────
  useEffect(() => {
    if (!socket || !symbol) return;

    // join chart room for this symbol
    socket.emit("watch:chart", symbol);

    // subscribe live candles if intraday TF
    const isIntraday = (t) => !!TF_LIVE_MAP[t];
    if (isIntraday(tf)) {
      socket.emit("candle:subscribe", { symbol, tf: TF_LIVE_MAP[tf] });
    }

    function applyTick(candle) {
      const current = [...candlesRef.current];
      if (!current.length) return;
      const tfMs   = TF_MS[TF_LIVE_MAP[tfRef.current]] || 60_000;
      const period = Math.floor(candle.time / tfMs) * tfMs;
      const last   = current[current.length - 1];
      const lastPeriod = Math.floor(new Date(last.time).getTime() / tfMs) * tfMs;

      let updated;
      if (lastPeriod === period) {
        updated = [...current];
        updated[updated.length - 1] = {
          ...last,
          high:   Math.max(last.high,   candle.high   ?? candle.close),
          low:    Math.min(last.low,    candle.low    ?? candle.close),
          close:  candle.close,
          volume: (last.volume || 0) + (candle.volume || 0),
        };
      } else if (candle.time > last.time) {
        updated = [...current, {
          time:   candle.time,
          open:   candle.open,
          high:   candle.high,
          low:    candle.low,
          close:  candle.close,
          volume: candle.volume || 0,
        }];
        if (updated.length > 500) updated.splice(0, updated.length - 500);
      } else {
        return;
      }
      candlesRef.current = updated;
      setCandles(updated);
      flashBlink();
    }

    function onCandleTick({ symbol: sym, tf: evTf, candle }) {
      if (!sym || sym.toUpperCase() !== symbol.toUpperCase()) return;
      if (!TF_LIVE_MAP[tfRef.current] || evTf !== TF_LIVE_MAP[tfRef.current]) return;
      applyTick(candle);
    }

    function onCandleClosed({ symbol: sym, tf: evTf, candle }) {
      if (!sym || sym.toUpperCase() !== symbol.toUpperCase()) return;
      if (!TF_LIVE_MAP[tfRef.current] || evTf !== TF_LIVE_MAP[tfRef.current]) return;
      applyTick(candle);
    }

    // price:tick fires for ALL timeframes (1D/1W/1M too)
    function onPriceTick({ symbol: sym, ltp, price }) {
  ltp = ltp ?? price;
      if (!sym || sym.toUpperCase() !== symbol.toUpperCase()) return;
      if (!ltp || ltp <= 0) return;
      // for intraday, candle:tick handles it
      if (isIntraday(tfRef.current)) return;
      const current = [...candlesRef.current];
      if (!current.length) return;
      const updated = [...current];
      const last    = updated[updated.length - 1];
      updated[updated.length - 1] = {
        ...last,
        high:  Math.max(last.high, ltp),
        low:   Math.min(last.low, ltp),
        close: ltp,
      };
      candlesRef.current = updated;
      setCandles(updated);
      flashBlink();
    }

    socket.on("candle:tick",   onCandleTick);
    socket.on("candle:closed", onCandleClosed);
    socket.on("price:tick",    onPriceTick);

    return () => {
      socket.off("candle:tick",   onCandleTick);
      socket.off("candle:closed", onCandleClosed);
      socket.off("price:tick",    onPriceTick);
      if (isIntraday(tf)) {
        socket.emit("candle:unsubscribe", { symbol, tf: TF_LIVE_MAP[tf] });
      }
    };
  }, [socket, symbol, tf, flashBlink]);

  // ── Re-subscribe when TF changes ──────────────────────────────────────────
  useEffect(() => {
    if (!socket || !symbol) return;
    const isIntraday = (t) => !!TF_LIVE_MAP[t];
    if (isIntraday(tf)) {
      socket.emit("candle:subscribe", { symbol, tf: TF_LIVE_MAP[tf] });
    }
  }, [socket, symbol, tf]);

  // ── Draw chart ─────────────────────────────────────────────────────────────
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

    const highs  = data.map(c => c.high);
    const lows   = data.map(c => c.low);
    const maxP   = Math.max(...highs);
    const minP   = Math.min(...lows);
    const rangeP = maxP - minP || 1;
    const maxVol = Math.max(...data.map(c => c.volume)) || 1;

    const px = (price) => PAD.top + priceH - ((price - minP) / rangeP) * priceH;
    const vx = (vol)   => PAD.top + priceH + 10 + volH - (vol / maxVol) * volH;
    const cx = (i)     => PAD.left + i * gap + gap / 2;

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

    data.forEach((c, i) => {
      const x    = cx(i);
      const isUp = c.close >= c.open;
      const col  = isUp ? COLORS.up : COLORS.down;

      ctx.strokeStyle = col;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x, px(c.high));
      ctx.lineTo(x, px(c.low));
      ctx.stroke();

      const bodyTop = px(Math.max(c.open, c.close));
      const bodyBot = px(Math.min(c.open, c.close));
      const bodyH   = Math.max(1, bodyBot - bodyTop);

      // last candle glows if live
      if (i === n - 1 && liveBlink) {
        ctx.shadowBlur  = 8;
        ctx.shadowColor = col;
      }
      ctx.fillStyle = col;
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
      ctx.shadowBlur = 0;

      ctx.fillStyle   = col + "88";
      const volTop    = vx(c.volume);
      const volBottom = PAD.top + priceH + 10 + volH;
      ctx.fillRect(x - candleW / 2, volTop, candleW, volBottom - volTop);
    });

    // live price line
    const ltp = data[data.length - 1].close;
    const ly  = px(ltp);
    if (ly > 0 && ly < PAD.top + priceH) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(0,229,255,0.4)";
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, ly);
      ctx.lineTo(W - PAD.right, ly);
      ctx.stroke();
      ctx.setLineDash([]);
    }

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

    canvas._layout = { PAD, chartW, chartH, priceH, volH, gap, n, minP, maxP, rangeP, data, px, cx };
  }, [candles, tf, liveBlink]);

  // ── Crosshair ──────────────────────────────────────────────────────────────
  const handleMouseMove = (e) => {
    const canvas  = canvasRef.current;
    if (!canvas || !canvas._layout || candles.length === 0) return;
    const rect   = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const { PAD, gap, n, data, cx } = canvas._layout;
    const i = Math.round((mouseX - PAD.left) / gap - 0.5);
    if (i < 0 || i >= n) { setCrosshair(null); return; }
    setCrosshair({ candle: data[i], i });
  };

  const openFullChart = () => {
  if (!symbol) return;
  const last = candles[candles.length - 1];
  const ltp  = last?.close ?? null;
  sessionStorage.setItem("terminal_symbol", symbol);
  if (ltp) sessionStorage.setItem("terminal_ltp", String(ltp));
  window.open(`/StockTerminal.html?symbol=${symbol}${ltp ? `&ltp=${ltp}` : ""}`, "_blank");
};

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
          {liveBlink && (
            <span style={{ fontSize: 8, color: "#00ff9c", background: "#001a0a", border: "1px solid #00ff9c33", borderRadius: 2, padding: "1px 5px", fontFamily: "monospace", fontWeight: 700 }}>
              ⚡ LIVE
            </span>
          )}
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

        <div style={{ display: "flex", gap: 4 }}>
          {TF_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setTf(opt.value)}
              style={{
                padding: "3px 10px", borderRadius: 4, fontSize: 12, cursor: "pointer",
                fontFamily: "monospace",
                border:      `1px solid ${tf === opt.value ? "#00cfff" : "#0d2a45"}`,
                background:  tf === opt.value ? "#00cfff22" : "transparent",
                color:       tf === opt.value ? "#00cfff" : "#4a8adf",
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
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#010812cc", borderRadius: 6, zIndex: 10 }}>
            <span style={{ color: "#00cfff", fontFamily: "monospace" }}>Loading {tf} candles...</span>
          </div>
        )}
        {error && !loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#010812cc", borderRadius: 6, zIndex: 10, gap: 8 }}>
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

          <div
            onClick={openFullChart}
            style={{
              position: "absolute", top: 8, right: 8,
              background: "rgba(0,207,255,0.12)",
              border: "1px solid rgba(0,207,255,0.35)",
              borderRadius: 4, padding: "3px 10px",
              color: "#00cfff", fontSize: 10,
              fontFamily: "monospace", cursor: "pointer",
              zIndex: 5, userSelect: "none",
            }}
            title={`Open full chart for ${symbol}`}
          >
            ↗ Full Chart
          </div>
        </div>
      </div>

      <div style={{ marginTop: 6, fontFamily: "monospace", fontSize: 10, color: "#2a5a8c", textAlign: "right" }}>
        {candles.length > 0 ? `${candles.length} candles · ${tf} · Upstox` : ""}
      </div>
    </div>
  );
}