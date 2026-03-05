const radar = new Map();

function updateRadar(company, signal) {

  if (!radar.has(company)) {
    radar.set(company, {
      score: 0,
      signals: []
    });
  }

  const data = radar.get(company);

  if (signal.type === "ORDER_ALERT") {
    data.score += 30;
  }

  if (signal.type === "AI_EVENT") {
    data.score += 10;
  }

  data.signals.push(signal);

  radar.set(company, data);

  return {
    company,
    score: data.score,
    signals: data.signals
  };

}

function getRadar() {
  return Array.from(radar.entries());
}

module.exports = {
  updateRadar,
  getRadar
};