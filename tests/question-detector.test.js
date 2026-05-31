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

test('detectQuestions skips question-like containers inside the extension sidebar (#ccp-host-root)', () => {
  const { detectQuestions } = require('../lib/question-detector.js');
  const d = dom(
    '<div id="ccp-host-root"><div class="ccp-host">' +
      '<div data-testid="cml-question-1"><h3>Question 1</h3>' +
        '<fieldset><input type="radio" name="ccp-behavior"></fieldset></div>' +
    '</div></div>' +
    '<main>' +
      '<div data-testid="cml-question-2"><h3>Question 1</h3>' +
        '<fieldset><input type="radio" name="real-q"><input type="radio" name="real-q"></fieldset></div>' +
    '</main>'
  );
  const qs = detectQuestions(d.body);
  // The sidebar's masquerading "Question 1" container must not be detected.
  assert.equal(qs.length, 1);
  assert.ok(qs[0].container.closest('#ccp-host-root') === null);
});

test('detectQuestions excludes a DISTINCT-numbered sidebar question that dedup cannot mask (load-bearing guard)', () => {
  // Distinct numbers so dedup-by-question-number cannot hide the sidebar entry.
  // Without the courseraDom exclusion guard, the sidebar's "Question 2" container
  // (header-only once answer-matcher excludes its ccp-behavior radio) is emitted
  // as a type:'unknown' question (classify() emits header-only containers). The
  // collectContainers guard must keep it out of the result entirely.
  const d = dom(
    '<div id="ccp-host-root"><div class="ccp-host">' +
      '<div data-testid="cml-question-9"><h3>Question 2</h3>' +
        '<fieldset><input type="radio" name="ccp-behavior"></fieldset></div>' +
    '</div></div>' +
    '<main>' +
      '<div data-testid="cml-question-1"><h3>Question 1</h3>' +
        '<fieldset><input type="radio" name="real-q"><input type="radio" name="real-q"></fieldset></div>' +
    '</main>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 1, 'only the real main question survives the guard');
  assert.equal(qs[0].questionNumber, 1);
  assert.equal(qs[0].type, 'single_choice');
  assert.ok(qs.every(function (q) { return q.container.closest('#ccp-host-root') === null; }),
    'no detected question may live inside the extension sidebar');
});

test('detectQuestions: numbers containers by ordinal when no literal "Question N"', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-a"><fieldset>' +
      '<label><input type="radio" name="qa"> Yes</label>' +
      '<label><input type="radio" name="qa"> No</label>' +
    '</fieldset></div>' +
    '<div data-testid="cml-question-b"><fieldset>' +
      '<label><input type="radio" name="qb"> True</label>' +
      '<label><input type="radio" name="qb"> False</label>' +
    '</fieldset></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const out = detectQuestions(j.window.document.body);
  assert.equal(out.length, 2);
  assert.equal(out[0].questionNumber, 1);
  assert.equal(out[1].questionNumber, 2);
});

test('detectQuestions: a headerless data-testid="question-meta" decoy with no inputs is NOT emitted', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="question-meta"><span>Points: 5</span></div>' +
    '<div data-testid="cml-question-a"><fieldset>' +
      '<label><input type="radio" name="qa"> Yes</label>' +
      '<label><input type="radio" name="qa"> No</label>' +
    '</fieldset></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const out = detectQuestions(j.window.document.body);
  assert.equal(out.length, 1, 'only the real radio question is emitted; the decoy is dropped');
  assert.equal(out[0].type, 'single_choice');
  assert.equal(out[0].questionNumber, 1, 'the kept question numbers as ordinal 1 (no gap from the dropped decoy)');
});

test('classify: detects dropdown, free_text, code, and file_upload types', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-1"><select><option>x</option><option>y</option></select></div>' +
    '<div data-testid="cml-question-2"><textarea></textarea></div>' +
    '<div data-testid="cml-question-3"><div data-testid="code-editor"><textarea></textarea></div></div>' +
    '<div data-testid="cml-question-4"><input type="file"></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const out = detectQuestions(j.window.document.body);
  const types = out.map(function (q) { return q.type; });
  assert.deepEqual(types, ['dropdown', 'free_text', 'code', 'file_upload']);
});
