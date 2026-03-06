const radar = {};

function updateRadar(company,signal){

  if(!company) return;

  if(!radar[company]){

    radar[company] = {
      company,
      score:0,
      signals:[],
      pdfUrl:null
    };

  }

  const label = signal.type || signal.signal;

  if(radar[company].signals.includes(label)){
    return;
  }

  radar[company].signals.push(label);

  if(signal.pdfUrl){
    radar[company].pdfUrl = signal.pdfUrl;
  }

  let score = 0;

  if(signal.type === "ORDER_ALERT") score = 40;
  if(signal.signal === "INSTITUTIONAL_DEAL") score = 25;
  if(signal.signal === "AI_EVENT") score = 10;

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