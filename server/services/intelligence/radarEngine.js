const opportunities = {};

function updateOpportunity(company, signal){

  if(!opportunities[company]){
    opportunities[company] = {
      company,
      score:0,
      signals:[],
      lastUpdate: Date.now()
    };
  }

  const weights = {
    ORDER_ALERT:40,
    ORDER_QUALITY:30,
    ORDER_MOMENTUM:25,
    INSTITUTIONAL_DEAL:20,
    SMART_MONEY:50,
    SECTOR_BOOM:15
  };

  const label = signal.type || signal.signal;

  const score = weights[label] || 0;

  opportunities[company].score += score;
  opportunities[company].lastUpdate = Date.now();

  if(label && !opportunities[company].signals.includes(label)){
    opportunities[company].signals.push(label);
  }
}

function decayScores(){
  for(const c in opportunities){
    opportunities[c].score *= 0.97;
  }
}

function getOpportunities(){
  return Object.values(opportunities)
  .filter(o => o.score >= 60)
  .sort((a,b)=>b.score-a.score)
  .slice(0,10);
}

module.exports = {
  updateOpportunity,
  getOpportunities,
  decayScores
};