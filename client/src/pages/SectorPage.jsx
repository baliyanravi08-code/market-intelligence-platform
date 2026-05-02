/**
 * SectorPage.jsx
 * client/src/pages/SectorPage.jsx
 *
 * Sector intelligence UI:
 *   - Scanner-powered sector health (% advancing/declining, avg change)
 *   - BSE filing order momentum per sector
 *   - Boom detection badge
 *   - Top gainers/losers per sector
 */

import { useEffect, useState } from "react";

const SECTOR_ICONS = {
  Infrastructure: "🏗️", Defence: "🛡️", Railway: "🚂", Renewable: "☀️",
  Power: "⚡", Banking: "🏦", IT: "💻", Pharma: "💊",
  Auto: "🚗", Metals: "⚙️", RealEstate: "🏠", FMCG: "🛒", Other: "📊",
};

function SentimentBadge({ sentiment }) {
  const cfg = {
    BULLISH: { color: "#00ff9c", bg: "#002210", label: "BULLISH" },
    BEARISH: { color: "#ff5c5c", bg: "#1a0008", label: "BEARISH" },
    MIXED:   { color: "#ffaa00", bg: "#1a1000", label: "MIXED"   },
  };
  const c = cfg[sentiment] || cfg.MIXED;
  return (
    <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "IBM Plex Mono, monospace", padding: "2px 6px", borderRadius: 3, background: c.bg, color: c.color, border: `1px solid ${c.color}33` }}>
      {c.label}
    </span>
  );
}

function MiniBar({ value, max, color }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ flex: 1, height: 3, background: "#0a1828", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, transition: "width 0.4s" }} />
    </div>
  );
}

function SectorCard({ sector, maxOrders }) {
  const [expanded, setExpanded] = useState(false);
  const icon = SECTOR_ICONS[sector.sector] || "📊";
  const scan = sector.scanner;

  const hasFilings = sector.orders > 0;
  const hasScan    = scan && scan.count > 0;
  const isBoom     = sector.isBoom && hasFilings;

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      style={{
        background: isBoom ? "#0d1a0d" : "#010c18",
        border: `1px solid ${isBoom ? "#00ff9c44" : "#0d2540"}`,
        borderLeft: `3px solid ${isBoom ? "#00ff9c" : scan?.sentiment === "BULLISH" ? "#4fc3f7" : scan?.sentiment === "BEARISH" ? "#ff5c5c" : "#0d3060"}`,
        borderRadius: 6, padding: "12px 14px", marginBottom: 8,
        cursor: "pointer", transition: "all 0.15s",
      }}
    >
      {/* Top row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>{icon}</span>
          <div>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, fontSize: 13, color: "#d8eeff" }}>
              {sector.sector}
            </span>
            {isBoom && (
              <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "#002210", color: "#00ff9c", border: "1px solid #00ff9c44" }}>
                🔥 {sector.boomType || "SECTOR BOOM"}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {scan && <SentimentBadge sentiment={scan.sentiment} />}
          <span style={{ fontSize: 9, color: "#2a5070" }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
        {hasScan && (
          <>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace" }}>AVG</span>
              <span style={{ fontSize: 11, fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, color: scan.avgChange >= 0 ? "#00ff9c" : "#ff5c5c" }}>
                {scan.avgChange >= 0 ? "+" : ""}{scan.avgChange}%
              </span>
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 9, color: "#00ff9c", fontFamily: "IBM Plex Mono, monospace" }}>▲{scan.advancing}</span>
              <span style={{ fontSize: 9, color: "#ff5c5c", fontFamily: "IBM Plex Mono, monospace" }}>▼{scan.declining}</span>
              <span style={{ fontSize: 9, color: "#4a7090", fontFamily: "IBM Plex Mono, monospace" }}>/{scan.count}</span>
            </div>
          </>
        )}
        {hasFilings && (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace" }}>BSE ORDERS</span>
            <span style={{ fontSize: 11, fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, color: "#ffd54f" }}>
              {sector.orders}
            </span>
            {sector.totalValue > 0 && (
              <span style={{ fontSize: 10, fontFamily: "IBM Plex Mono, monospace", color: "#ff9c00" }}>
                ₹{sector.totalValue >= 1000 ? (sector.totalValue / 1000).toFixed(1) + "K" : Math.round(sector.totalValue)}Cr
              </span>
            )}
          </div>
        )}
      </div>

      {/* Order bar */}
      {hasFilings && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <MiniBar value={sector.orders} max={maxOrders || 5} color={isBoom ? "#00ff9c" : "#ffd54f"} />
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #0d2040" }}>
          {scan?.topGainers?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace", marginBottom: 4 }}>TOP GAINERS</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {scan.topGainers.map((g, i) => (
                  <span key={i} style={{ fontSize: 10, fontFamily: "IBM Plex Mono, monospace", padding: "2px 6px", borderRadius: 3, background: "#002210", color: "#00ff9c", border: "1px solid #00ff9c33" }}>
                    {g.symbol} +{g.change?.toFixed(2)}%
                  </span>
                ))}
              </div>
            </div>
          )}
          {scan?.topLosers?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace", marginBottom: 4 }}>TOP LOSERS</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {scan.topLosers.map((l, i) => (
                  <span key={i} style={{ fontSize: 10, fontFamily: "IBM Plex Mono, monospace", padding: "2px 6px", borderRadius: 3, background: "#1a0008", color: "#ff5c5c", border: "1px solid #ff5c5c33" }}>
                    {l.symbol} {l.change?.toFixed(2)}%
                  </span>
                ))}
              </div>
            </div>
          )}
          {sector.companies?.length > 0 && (
            <div>
              <div style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace", marginBottom: 4 }}>BSE FILING COMPANIES</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {sector.companies.slice(0, 6).map((c, i) => (
                  <span key={i} style={{ fontSize: 9, fontFamily: "IBM Plex Mono, monospace", padding: "1px 5px", borderRadius: 3, background: "#0a1828", color: "#7ab0d0", border: "1px solid #0d2040" }}>
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SectorPage({ socket }) {
  const [sectors,   setSectors]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [sortBy,    setSortBy]    = useState("momentum"); // momentum | orders | change
  const [connected, setConnected] = useState(false);

  // Fetch sector snapshot from API
  const fetchSectors = () => {
    fetch("/api/sectors")
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setSectors(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchSectors();
    const iv = setInterval(fetchSectors, 30_000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!socket) return;
    setConnected(socket.connected);
    socket.on("connect",      () => setConnected(true));
    socket.on("disconnect",   () => setConnected(false));
    socket.on("sector-update", (boom) => {
      setSectors(prev => {
        const next = prev.filter(s => s.sector !== boom.sector);
        return [{ ...boom }, ...next];
      });
    });
    return () => {
      socket.off("sector-update");
      socket.off("connect");
      socket.off("disconnect");
    };
  }, [socket]);

  const sorted = [...sectors].sort((a, b) => {
    if (sortBy === "orders") return (b.orders || 0) - (a.orders || 0);
    if (sortBy === "change") return (Math.abs(b.scanner?.avgChange || 0)) - (Math.abs(a.scanner?.avgChange || 0));
    // momentum = orders + advancing count
    return ((b.orders || 0) + (b.scanner?.advancing || 0)) - ((a.orders || 0) + (a.scanner?.advancing || 0));
  });

  const maxOrders = Math.max(...sectors.map(s => s.orders || 0), 1);
  const boomCount = sectors.filter(s => s.isBoom).length;
  const bullish   = sectors.filter(s => s.scanner?.sentiment === "BULLISH").length;
  const bearish   = sectors.filter(s => s.scanner?.sentiment === "BEARISH").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#010812", color: "#d8eeff" }}>

      {/* Header */}
      <div style={{ padding: "12px 16px", background: "linear-gradient(90deg, #020d1f, #041828)", borderBottom: "1px solid #0d3560", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, fontWeight: 700, color: "#00cfff", letterSpacing: 1 }}>
              🏭 SECTOR INTELLIGENCE
            </div>
            <div style={{ fontSize: 10, color: "#2a7090", marginTop: 2 }}>
              Scanner data + BSE filing signals · Auto-refreshes every 30s
            </div>
          </div>
          <span style={{ fontSize: 9, fontFamily: "IBM Plex Mono, monospace", color: connected ? "#00ff9c" : "#ff5c5c" }}>
            {connected ? "● LIVE" : "○ OFFLINE"}
          </span>
        </div>

        {/* Stats */}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {[
            { label: "Sectors",  value: sectors.length,  color: "#4a9abb" },
            { label: "Booming",  value: boomCount,        color: "#00ff9c" },
            { label: "Bullish",  value: bullish,          color: "#00ff9c" },
            { label: "Bearish",  value: bearish,          color: "#ff5c5c" },
          ].map(s => (
            <div key={s.label} style={{ fontSize: 9, fontFamily: "IBM Plex Mono, monospace", padding: "2px 8px", borderRadius: 3, background: `${s.color}12`, border: `1px solid ${s.color}33`, color: s.color }}>
              <span style={{ fontWeight: 700 }}>{s.value}</span> {s.label}
            </div>
          ))}
        </div>

        {/* Sort */}
        <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "#1a5070", fontFamily: "IBM Plex Mono, monospace" }}>SORT:</span>
          {[["momentum", "Momentum"], ["orders", "BSE Orders"], ["change", "Avg Change"]].map(([key, label]) => (
            <button key={key} onClick={() => setSortBy(key)} style={{
              fontSize: 9, fontFamily: "IBM Plex Mono, monospace", padding: "2px 8px", borderRadius: 3, cursor: "pointer",
              background: sortBy === key ? "#0d3060" : "transparent",
              border: sortBy === key ? "1px solid #4a9abb" : "1px solid #0d2040",
              color: sortBy === key ? "#d8eeff" : "#4a7090",
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {loading ? (
          <div style={{ textAlign: "center", color: "#1a5070", padding: "60px 20px", fontFamily: "IBM Plex Mono, monospace" }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>⟳</div>Loading sector data...
          </div>
        ) : sorted.length === 0 ? (
          <div style={{ textAlign: "center", color: "#1a5070", padding: "60px 20px", fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🏭</div>
            No sector data yet. Scanner and BSE listener populate this during market hours.
          </div>
        ) : sorted.map(s => (
          <SectorCard key={s.sector} sector={s} maxOrders={maxOrders} />
        ))}
      </div>
    </div>
  );
}