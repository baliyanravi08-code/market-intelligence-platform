const smartMoney = {};

function updateSmartMoney(deal) {

  const symbol = deal.company;

  if (!smartMoney[symbol]) {

    smartMoney[symbol] = {
      investors: new Set(),
      totalValue: 0
    };

  }

  smartMoney[symbol].investors.add(deal.investor);

  smartMoney[symbol].totalValue += deal.value;

  const investorsCount = smartMoney[symbol].investors.size;

  if (investorsCount >= 2 && smartMoney[symbol].totalValue >= 50) {

    return {
      type: "SMART_MONEY_ALERT",
      company: symbol,
      investors: investorsCount,
      value: smartMoney[symbol].totalValue
    };

  }

  return null;

}

module.exports = updateSmartMoney;