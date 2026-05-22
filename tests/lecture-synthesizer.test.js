// tests/lecture-synthesizer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankKeywords, clusterTopics } = require('../lib/lecture-synthesizer.js');

test('rankKeywords drops stopwords and short tokens', () => {
  const cues = [
    { text: 'The cats and the dog are friends.' },
    { text: 'The cats eat the food.' },
  ];
  const top = rankKeywords(cues, 5);
  assert.ok(top.indexOf('the') === -1, 'stopword "the" excluded');
  assert.ok(top.indexOf('cats') !== -1, '"cats" should appear');
  assert.ok(top.indexOf('and') === -1, 'short token "and" excluded');
});

test('rankKeywords orders by frequency', () => {
  const cues = [
    { text: 'gradient gradient gradient descent loss loss' },
  ];
  const top = rankKeywords(cues, 3);
  assert.equal(top[0], 'gradient');
  assert.equal(top[1], 'loss');
  assert.equal(top[2], 'descent');
});

test('clusterTopics groups consecutive cues sharing keywords', () => {
  const cues = [
    { text: 'gradient descent updates weights using the gradient.' },
    { text: 'the gradient flows backwards through the network weights.' },
    { text: 'softmax produces probabilities over classes.' },
    { text: 'softmax outputs sum to one across all classes.' },
  ];
  const topics = clusterTopics(cues);
  assert.equal(topics.length, 2);
  assert.deepEqual(topics[0].cueIndexes, [0, 1]);
  assert.deepEqual(topics[1].cueIndexes, [2, 3]);
  assert.ok(topics[0].keywords.indexOf('gradient') !== -1);
  assert.ok(topics[1].keywords.indexOf('softmax') !== -1);
});

test('clusterTopics returns single topic for one cue', () => {
  const topics = clusterTopics([{ text: 'only one cue here about something.' }]);
  assert.equal(topics.length, 1);
  assert.deepEqual(topics[0].cueIndexes, [0]);
});

test('clusterTopics handles empty input', () => {
  assert.deepEqual(clusterTopics([]), []);
});
