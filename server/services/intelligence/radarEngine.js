const radar = {};

/*
UPDATE RADAR
*/
function updateRadar(company, signal){

  if(!company) return;

  if(!radar[company]){

    radar[company] = {
      company,
      score:0,
      signals:[],
      opportunity:"LOW"
    };

  }

  let score = 0;

  if(signal.type === "ORDER_ALERT") score = 40;

  if(signal.signal === "ORDER_QUALITY") score = 35;

  if(signal.signal === "ORDER_MOMENTUM") score = 25;

  if(signal.signal === "ORDER_STRENGTH") score = 20;

  if(signal.signal === "SECTOR_BOOM") score = 20;

  if(signal.signal === "INSTITUTIONAL_DEAL") score = 25;

  if(signal.signal === "SMART_MONEY") score = 50;

  radar[company].score += score;

  const label = signal.type || signal.signal;

  if(label && !radar[company].signals.includes(label)){
    radar[company].signals.push(label);
  }

  const s = radar[company].score;

  if(s >= 100){
    radar[company].opportunity = "VERY_HIGH";
  }
  else if(s >= 70){
    radar[company].opportunity = "HIGH";
  }
  else if(s >= 40){
    radar[company].opportunity = "MEDIUM";
  }
  else{
    radar[company].opportunity = "LOW";
  }

}

/*
GET RADAR DATA
*/
function getRadar(){

  return Object.values(radar)
    .filter(r => r.score > 0)
    .sort((a,b)=>b.score-a.score)
    .slice(0,20);

}

module.exports = {
  updateRadar,
  getRadar
};