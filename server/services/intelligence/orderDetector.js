function detectOrder(text) {

  if (!text) return null;

  const patterns = [
    /₹?\s?([\d,.]+)\s?crore/i,
    /₹?\s?([\d,.]+)\s?cr/i,
    /₹?\s?([\d,.]+)\s?million/i
  ];

  for (const p of patterns) {

    const match = text.match(p);

    if (match) {

      const value = parseFloat(match[1].replace(/,/g, ""));

      if (value >= 1) {

        return {
          orderValueCrore: value
        };

      }

    }

  }

  return null;
}

module.exports = detectOrder;