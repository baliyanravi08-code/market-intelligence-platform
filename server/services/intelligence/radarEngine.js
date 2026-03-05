const radar = {};

function updateRadar(company, signal) {

  if (!radar[company]) {

    radar[company] = {
      company,
      score: 0,
      signals: []
    };

  }

  let score = 0;

  if (signal.type === "ORDER_ALERT") score = 40;
  if (signal.type === "AI_EVENT") score = 10;
  if (signal.signal === "ORDER_MOMENTUM") score = 25;
  if (signal.signal === "ORDER_QUALITY") score = 30;

  radar[company].score += score;

  if (signal.type) {
    radar[company].signals.push(signal.type);
  }

  if (signal.signal) {
    radar[company].signals.push(signal.signal);
  }

}

function getRadar() {

  const list = Object.values(radar);

  return list
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

}

module.exports = {
  updateRadar,
  getRadar
};