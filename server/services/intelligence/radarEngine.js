const radarMap = new Map();

function getIndianTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: true
  });
}

function updateRadar(company, signal) {
  if (!company) return;

  if (!radarMap.has(company)) {
    radarMap.set(company, {
      company,
      score: 0,
      signals: [],
      strength: "WEAK",
      pdfUrl: null,
      time: null,
      receivedAt: Date.now()  // ← timestamp for LiveAgo
    });
  }

  const data = radarMap.get(company);

  // Keep last 5 signals only
  data.signals.unshift(signal.type);
  if (data.signals.length > 5) data.signals = data.signals.slice(0, 5);

  // Score by signal type
  const scores = {
    ORDER_ALERT:      40,
    MERGER:           35,
    BLOCK_DEAL:       30,
    INSIDER_TRADE:    25,
    INSIDER_BUY:      25,
    CAPEX:            20,
    PARTNERSHIP:      15,
    CORPORATE_ACTION: 10,
    NEWS:              5
  };

  data.score = Math.min(100, data.score + (scores[signal.type] || 5));

  // Update metadata — receivedAt is NOW (when server got it)
  data.receivedAt = Date.now();
  data.time = signal.time || getIndianTime(); // exchange time for display
  if (signal.pdfUrl) data.pdfUrl = signal.pdfUrl;

  // Strength label
  if (data.score >= 70)      data.strength = "VERY STRONG";
  else if (data.score >= 40) data.strength = "STRONG";
  else if (data.score >= 20) data.strength = "MODERATE";
  else                       data.strength = "WEAK";
}

function getRadar() {
  return Array.from(radarMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 500);
}

module.exports = { updateRadar, getRadar };