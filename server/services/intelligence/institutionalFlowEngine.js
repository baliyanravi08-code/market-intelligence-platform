const flows = {};

/*
TRACK INSTITUTIONAL FLOW
*/

function institutionalFlowEngine(activity){

  const company = activity.company;

  if(!company) return null;

  if(!flows[company]){

    flows[company] = {
      company,
      totalValue:0,
      deals:0
    };

  }

  const data = flows[company];

  data.deals += 1;
  data.totalValue += activity.value || 0;

  /*
  TRIGGER SIGNAL
  */

  if(data.totalValue >= 100){

    return {
      signal:"SMART_MONEY",
      company,
      deals:data.deals,
      value:data.totalValue
    };

  }

  return null;

}

module.exports = institutionalFlowEngine;