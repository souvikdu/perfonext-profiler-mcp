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

function longFunctionWithDistantHotLines(data) {
  let acc = 0;
  // padding line 1
  // padding line 2
  // padding line 3
  // padding line 4
  // padding line 5
  // padding line 6
  // padding line 7
  // padding line 8
  // padding line 9
  // padding line 10
  // padding line 11
  for (let i = 0; i < data.length; i++) {
    acc += data[i] * data[i]; // line 28 - the actual hot line, well past the +/-10 default window
  }
  return acc;
}

module.exports = { heavyComputation, processItems, longFunctionWithDistantHotLines };
