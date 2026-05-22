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

const { generateDraft } = require('../lib/lecture-synthesizer.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('generateDraft includes lecture title heading when provided', () => {
  const draft = generateDraft({
    cues: [{ text: 'gradient descent updates weights.' }],
    lectureTitle: 'Lesson 1: Gradient Descent',
    weekObjective: null,
    random: seededRng(7),
  });
  assert.ok(draft.indexOf('# Lesson 1: Gradient Descent') === 0, 'starts with heading');
});

test('generateDraft links to week objective when provided', () => {
  const draft = generateDraft({
    cues: [{ text: 'gradient descent updates weights.' }],
    lectureTitle: 'L1',
    weekObjective: 'Train a neural network',
    random: seededRng(7),
  });
  assert.ok(draft.indexOf("Train a neural network") !== -1);
});

test('generateDraft produces one paragraph per topic', () => {
  const cues = [
    { text: 'gradient descent updates weights using the gradient.' },
    { text: 'the gradient flows backwards through the weights.' },
    { text: 'softmax produces probabilities over classes.' },
    { text: 'softmax outputs sum to one across the classes.' },
  ];
  const draft = generateDraft({ cues: cues, lectureTitle: null, weekObjective: null, random: seededRng(3) });
  const paras = draft.split(/\n\n+/).filter(function (p) { return p.trim() && p.indexOf('_') !== 0 && p.indexOf('#') !== 0; });
  // 2 topic paragraphs + hedge line is its own paragraph
  assert.ok(paras.length >= 2, 'at least two topic paragraphs');
});

test('generateDraft is deterministic for a given seed', () => {
  const cues = [{ text: 'gradient descent updates weights.' }];
  const a = generateDraft({ cues: cues, lectureTitle: 'L', weekObjective: null, random: seededRng(42) });
  const b = generateDraft({ cues: cues, lectureTitle: 'L', weekObjective: null, random: seededRng(42) });
  assert.equal(a, b);
});

test('generateDraft varies with seed (burstiness/perplexity)', () => {
  const cues = [
    { text: 'gradient descent updates weights through repeated steps.' },
    { text: 'gradient values flow backwards through the network.' },
  ];
  const a = generateDraft({ cues: cues, lectureTitle: 'L', weekObjective: null, random: seededRng(1) });
  const b = generateDraft({ cues: cues, lectureTitle: 'L', weekObjective: null, random: seededRng(999) });
  assert.notEqual(a, b);
});

test('generateDraft ends with a hedge line', () => {
  const cues = [{ text: 'gradient descent updates weights.' }];
  const draft = generateDraft({ cues: cues, lectureTitle: null, weekObjective: null, random: seededRng(11) });
  const HEDGES = ['Still chewing on this.', 'Need to revisit — not fully solid yet.', 'Tagging this for the next review pass.'];
  const trimmed = draft.trim();
  const ok = HEDGES.some(function (h) { return trimmed.endsWith(h); });
  assert.ok(ok, 'ends with a known hedge line — got: ' + JSON.stringify(trimmed.slice(-80)));
});

test('generateDraft returns empty string for no cues', () => {
  const draft = generateDraft({ cues: [], lectureTitle: 'L', weekObjective: null, random: seededRng(1) });
  assert.equal(draft, '');
});
