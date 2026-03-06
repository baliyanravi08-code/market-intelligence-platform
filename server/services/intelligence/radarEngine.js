const radar = {};

function updateRadar(company, signal){

  if(!radar[company]){

    radar[company] = {
      company,
      score:0,
      signals:[]
    };

  }

  let score = 0;

  if(signal.type === "ORDER_ALERT") score = 40;

  if(signal.signal === "ORDER_QUALITY") score = 30;

  if(signal.signal === "ORDER_MOMENTUM") score = 25;

  if(signal.signal === "INSTITUTIONAL_DEAL") score = 20;

  if(signal.signal === "SMART_MONEY") score = 50;

  if(signal.type === "AI_EVENT") score = 10;

  radar[company].score += score;

  const label = signal.type || signal.signal;

  if(label && !radar[company].signals.includes(label)){
    radar[company].signals.push(label);
  }

}

function getRadar(){

  const list = Object.values(radar);

  return list
    .filter(r => r.score > 0)
    .sort((a,b)=>b.score-a.score)
    .slice(0,15);

}

module.exports = {
  updateRadar,
  getRadar
};