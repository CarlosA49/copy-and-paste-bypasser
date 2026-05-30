// tests/coursera-dom-api-shape.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const courseraDom = require('../lib/coursera-dom.js');

test('courseraDom exposes exactly the 12 spec-frozen methods', () => {
  const keys = Object.keys(courseraDom).sort();
  const expected = [
    'assessmentRoot',
    'classifyKind',
    'findItemLinks',
    'findModuleRegions',
    'findNextItemButton',
    'findOutlineNav',
    'isExcludedNode',
    'isExternalLaunchPage',
    'itemStatus',
    'parseItemAccessibleName',
    'parseLearnUrl',
    'withinAssessment',
  ].sort();
  assert.deepEqual(keys, expected);
  expected.forEach(function (k) { assert.equal(typeof courseraDom[k], 'function', k + ' must be a function'); });
});
