const results = [];

function saveResult(data) {
  results.unshift(data);
}

function getResults() {
  return results;
}

module.exports = { saveResult, getResults };