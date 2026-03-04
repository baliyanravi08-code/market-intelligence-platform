function detectOrder(text) {

  if (!text) return null;

  const lower = text.toLowerCase();

  const patterns = [

    /₹?\s?([\d,.]+)\s?crore/i,
    /₹?\s?([\d,.]+)\s?cr/i,
    /rs\.?\s?([\d,.]+)\s?crore/i

  ];

  for (const p of patterns) {

    const match = lower.match(p);

    if (!match) continue;

    const value = parseFloat(match[1].replace(/,/g, ""));

    if (!isNaN(value) && value >= 1) {

      return {
        orderValueCrore: value
      };

    }

  }

  return null;

}

module.exports = detectOrder;