// sample-source.js — fixture used by source-context tests
function heavyComputation(data) {
  let result = 0;
  for (let i = 0; i < data.length; i++) {
    result += data[i] * data[i]; // line 5
  }
  return result;
}

function processItems(items) {
  return items.map(item => heavyComputation(item)); // line 11
}

module.exports = { heavyComputation, processItems };
