const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { detectQuestions } = require('../lib/question-detector.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('detects a single text-input question with question number', () => {
  const d = dom(
    '<div data-testid="cml-question-1">' +
      '<h2>Question 1</h2>' +
      '<p>Compute X</p>' +
      '<input type="text" />' +
    '</div>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].questionNumber, 1);
  assert.equal(qs[0].type, 'math_input');
  assert.equal(qs[0].targets.length, 1);
  assert.equal(qs[0].targets[0].tagName.toLowerCase(), 'input');
});

test('detects a single_choice radio question and lists choices', () => {
  const d = dom(
    '<div data-testid="cml-question-10">' +
      '<h2>Question 10</h2>' +
      '<fieldset>' +
        '<label><input type="radio" name="q10"> Paramagnetism</label>' +
        '<label><input type="radio" name="q10"> Diamagnetism</label>' +
        '<label><input type="radio" name="q10"> Ferromagnetism</label>' +
      '</fieldset>' +
    '</div>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].questionNumber, 10);
  assert.equal(qs[0].type, 'single_choice');
  assert.equal(qs[0].choices.length, 3);
  assert.equal(qs[0].choices[1].text, 'Diamagnetism');
});

test('detects multiple questions in order', () => {
  const d = dom(
    '<div><h2>Question 1</h2><input type="text"></div>' +
    '<div><h2>Question 2</h2><input type="text"></div>' +
    '<div><h2>Question 3</h2><textarea></textarea></div>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 3);
  assert.deepEqual(qs.map(function(q){return q.questionNumber;}), [1,2,3]);
});

test('detects mixed text + radio + text page (the 11-question failure shape)', () => {
  const make = function (n, inner) {
    return '<div><h2>Question ' + n + '</h2>' + inner + '</div>';
  };
  const html =
    make(1, '<input type="text">') +
    make(2, '<input type="text">') +
    make(3, '<input type="text">') +
    make(4, '<input type="text">') +
    make(5, '<input type="text">') +
    make(6, '<input type="text">') +
    make(7, '<input type="text">') +
    make(8, '<input type="text">') +
    make(9, '<input type="text">') +
    make(10,
      '<fieldset>' +
        '<label><input type="radio" name="q10"> Paramagnetism</label>' +
        '<label><input type="radio" name="q10"> Diamagnetism</label>' +
        '<label><input type="radio" name="q10"> Ferromagnetism</label>' +
      '</fieldset>') +
    make(11, '<input type="text">');
  const d = dom(html);
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 11);
  assert.equal(qs[9].type, 'single_choice');
  assert.equal(qs[9].questionNumber, 10);
  assert.equal(qs[10].type, 'math_input');
  assert.equal(qs[10].questionNumber, 11);
});

test('prefers visible contenteditable over hidden mirror input', () => {
  const d = dom(
    '<div><h2>Question 1</h2>' +
      '<input type="hidden" value="">' +
      '<div contenteditable="true">type here</div>' +
    '</div>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].type, 'math_input');
  assert.equal(qs[0].targets[0].getAttribute('contenteditable'), 'true');
});

test('returns [] when no question headers present', () => {
  const d = dom('<p>nothing here</p>');
  assert.deepEqual(detectQuestions(d.body), []);
});
