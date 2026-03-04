const radar = {};

function updateRadar(symbol, signal) {

  if (!radar[symbol]) {
    radar[symbol] = {
      score: 0,
      signals: []
    };
  }

  let points = 0;

  if (signal.type === "ORDER_ALERT") {

    const value = signal.newOrder || 0;

    if (value >= 50) points = 40;
    else if (value >= 10) points = 25;
    else points = 10;

  }

  if (signal.type === "INSTITUTIONAL_DEAL") {
    points = 20;
  }

  if (signal.type === "SMART_MONEY_ALERT") {
    points = 30;
  }

  if (signal.type === "SECTOR_MOMENTUM") {
    points = 15;
  }

  if (signal.type === "AI_EVENT") {
    points = 10;
  }

  radar[symbol].score += points;

  radar[symbol].signals.push(signal.type);

  return radar[symbol];

}

function getTopRadar() {

  const list = Object.entries(radar)
    .map(([symbol, data]) => ({
      symbol,
      score: data.score,
      signals: data.signals
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return list;

}

module.exports = {
  updateRadar,
  getTopRadar
};