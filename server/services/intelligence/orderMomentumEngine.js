const momentumStore = new Map();

function orderMomentumEngine(signal) {

  if (signal.type !== "ORDER_ALERT") return null;

  const code = signal.code;

  if (!momentumStore.has(code)) {
    momentumStore.set(code, []);
  }

  const orders = momentumStore.get(code);

  orders.push({
    value: signal.value,
    time: Date.now()
  });

  const tenDays = 10 * 24 * 60 * 60 * 1000;

  const recentOrders = orders.filter(
    o => Date.now() - o.time < tenDays
  );

  momentumStore.set(code, recentOrders);

  if (recentOrders.length >= 3) {

    const totalValue = recentOrders.reduce(
      (sum, o) => sum + o.value,
      0
    );

    return {
      company: signal.company,
      code,
      orders: recentOrders.length,
      totalValue,
      signal: "ORDER_MOMENTUM"
    };

  }

  return null;

}

module.exports = orderMomentumEngine;