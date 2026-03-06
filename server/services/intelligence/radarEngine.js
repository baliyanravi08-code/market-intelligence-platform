const radar = {};

function updateRadar(company, signal){

  if(!company) return;

  if(!radar[company]){

    radar[company] = {
      company,
      score:0,
      signals:[]
    };

  }

  const label = signal.type || signal.signal;

  /* prevent duplicate signals */

  if(radar[company].signals.includes(label)){
    return;
  }

  radar[company].signals.push(label);

  let score = 0;

  if(signal.type === "ORDER_ALERT") score = 40;
  if(signal.signal === "ORDER_QUALITY") score = 35;
  if(signal.signal === "ORDER_MOMENTUM") score = 25;
  if(signal.signal === "ORDER_STRENGTH") score = 20;
  if(signal.signal === "SECTOR_BOOM") score = 20;
  if(signal.signal === "INSTITUTIONAL_DEAL") score = 25;

  radar[company].score += score;

}

function getRadar(){

  return Object.values(radar)
    .sort((a,b)=>b.score-a.score)
    .slice(0,20);

}

module.exports = {
  updateRadar,
  getRadar
};