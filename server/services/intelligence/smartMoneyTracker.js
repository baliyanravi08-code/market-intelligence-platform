const flows = {};

function smartMoney(signal) {
  const validTypes = ["INSTITUTIONAL_DEAL", "BLOCK_DEAL", "INSIDER_BUY", "INSIDER_TRADE"];
  if (!validTypes.includes(signal.type)) return null;

  const c = signal.company;
  if (!c) return null;

  if (!flows[c]) {
    flows[c] = { value: 0, deals: 0 };
  }

  flows[c].deals++;
  flows[c].value += signal.value || 0;

  if (flows[c].deals >= 2 || flows[c].value > 100) {
    return {
      company: c,
      value: flows[c].value,
      deals: flows[c].deals,
      signal: "SMART_MONEY",
      time: signal.time
    };
  }

  return null;
}

module.exports = smartMoney;