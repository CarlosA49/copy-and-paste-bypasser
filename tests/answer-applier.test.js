const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { applyAnswers } = require('../lib/answer-applier.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

function makeQuestion(n, inner) {
  return '<div data-testid="cml-question-' + n + '">' +
    '<h2>Question ' + n + '</h2>' + inner + '</div>';
}

test('11-question failure case is fully filled', () => {
  const html =
    makeQuestion(1, '<input type="text" id="q1">') +
    makeQuestion(2, '<input type="text" id="q2">') +
    makeQuestion(3, '<input type="text" id="q3">') +
    makeQuestion(4, '<input type="text" id="q4">') +
    makeQuestion(5, '<input type="text" id="q5">') +
    makeQuestion(6, '<input type="text" id="q6">') +
    makeQuestion(7, '<input type="text" id="q7">') +
    makeQuestion(8, '<input type="text" id="q8">') +
    makeQuestion(9, '<input type="text" id="q9">') +
    makeQuestion(10,
      '<fieldset>' +
        '<label><input type="radio" name="q10"> Paramagnetism</label>' +
        '<label><input type="radio" name="q10"> Diamagnetism</label>' +
        '<label><input type="radio" name="q10"> Ferromagnetism</label>' +
      '</fieldset>') +
    makeQuestion(11, '<input type="text" id="q11">');
  const d = dom(html);
  const raw =
    '1. 0.0539 \n' +
    '2. (2epsilon_oE_o/r)\n' +
    '3. 0\n' +
    '4. (-2k)\n' +
    '5. 0\n' +
    '6. 15058.7876 V\n' +
    '7. (3.7647\\times10^5) N/C\n' +
    '8. 8.0000 μC/m²\n' +
    '9. (3.9789\\times10^{-5}) C/m²\n' +
    '10. Diamagnetism\n' +
    '11. 300 m';

  const out = applyAnswers(raw, d.body, { verbose: false });

  assert.equal(out.detectedQuestions, 11);
  assert.equal(out.parsedAnswers, 11);
  assert.equal(out.summary.filled, 11);
  assert.equal(out.summary.failed, 0);

  assert.equal(d.getElementById('q1').value, '0.0539');
  assert.equal(d.getElementById('q2').value, '2*epsilon_o*E_o/r');
  assert.equal(d.getElementById('q3').value, '0');
  assert.equal(d.getElementById('q4').value, '-2*k');
  assert.equal(d.getElementById('q5').value, '0');
  assert.equal(d.getElementById('q6').value, '15058.7876');
  assert.equal(d.getElementById('q7').value, '3.7647E5');
  assert.equal(d.getElementById('q8').value, '8.0000');
  assert.equal(d.getElementById('q9').value, '3.9789E-5');
  assert.equal(d.getElementById('q11').value, '300');

  const radios = d.querySelectorAll('input[name="q10"]');
  assert.equal(radios[0].checked, false);
  assert.equal(radios[1].checked, true);
  assert.equal(radios[2].checked, false);
});

test('returns no-answer entry when a question has no matching answer', () => {
  const html = makeQuestion(1, '<input type="text">') + makeQuestion(2, '<input type="text">');
  const d = dom(html);
  const out = applyAnswers('1. only-one', d.body, { verbose: false });
  assert.equal(out.summary.filled, 1);
  const q2 = out.results.find(function (r) { return r.questionNumber === 2; });
  assert.equal(q2.status, 'no-answer');
});

test('returns nothing-to-do when no numbered answers parsed', () => {
  const html = makeQuestion(1, '<input type="text">');
  const d = dom(html);
  const out = applyAnswers('The answer is A', d.body, { verbose: false });
  assert.equal(out.parsedAnswers, 0);
});

test('matches radio answer case-insensitively', () => {
  const html = makeQuestion(1,
    '<fieldset>' +
      '<label><input type="radio" name="x"> Alpha</label>' +
      '<label><input type="radio" name="x"> Beta</label>' +
    '</fieldset>');
  const d = dom(html);
  const out = applyAnswers('1. beta', d.body, { verbose: false });
  assert.equal(out.summary.filled, 1);
  const radios = d.querySelectorAll('input[name="x"]');
  assert.equal(radios[0].checked, false);
  assert.equal(radios[1].checked, true);
});

test('letter answer A maps to first radio choice', () => {
  const html = makeQuestion(1,
    '<fieldset>' +
      '<label><input type="radio" name="x"> Alpha</label>' +
      '<label><input type="radio" name="x"> Beta</label>' +
    '</fieldset>');
  const d = dom(html);
  const out = applyAnswers('1. A', d.body, { verbose: false });
  assert.equal(out.summary.filled, 1);
  const radios = d.querySelectorAll('input[name="x"]');
  assert.equal(radios[0].checked, true);
});

test('multiple_choice "A, C" ticks the right boxes', () => {
  const html = makeQuestion(1,
    '<label><input type="checkbox" name="m"> Apples</label>' +
    '<label><input type="checkbox" name="m"> Bananas</label>' +
    '<label><input type="checkbox" name="m"> Cherries</label>');
  const d = dom(html);
  const out = applyAnswers('1. A, C', d.body, { verbose: false });
  assert.equal(out.summary.filled, 1);
  const boxes = d.querySelectorAll('input[name="m"]');
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false);
  assert.equal(boxes[2].checked, true);
});

test('11-question bare un-numbered format is fully filled', () => {
  const html =
    makeQuestion(1, '<input type="text" id="q1">') +
    makeQuestion(2, '<input type="text" id="q2">') +
    makeQuestion(3, '<input type="text" id="q3">') +
    makeQuestion(4, '<input type="text" id="q4">') +
    makeQuestion(5, '<input type="text" id="q5">') +
    makeQuestion(6, '<input type="text" id="q6">') +
    makeQuestion(7, '<input type="text" id="q7">') +
    makeQuestion(8, '<input type="text" id="q8">') +
    makeQuestion(9, '<input type="text" id="q9">') +
    makeQuestion(10,
      '<fieldset>' +
        '<label><input type="radio" name="q10"> Paramagnetism</label>' +
        '<label><input type="radio" name="q10"> Diamagnetism</label>' +
        '<label><input type="radio" name="q10"> Ferromagnetism</label>' +
      '</fieldset>') +
    makeQuestion(11, '<input type="text" id="q11">');
  const d = dom(html);
  const raw =
    '0.0539\n' +
    '2*epsilon_o*E_o/r\n' +
    '0\n' +
    '-2k\n' +
    '0\n' +
    '15058.7876 V\n' +
    '3.7647×10^5 N/C\n' +
    '8.0000 μC/m²\n' +
    '3.9789×10^-5 C/m²\n' +
    'Diamagnetism\n' +
    '300 m';

  const out = applyAnswers(raw, d.body, { verbose: false });

  assert.equal(out.detectedQuestions, 11);
  assert.equal(out.parsedAnswers, 11);
  assert.equal(out.summary.filled, 11);
  assert.equal(out.summary.failed, 0);
  assert.equal(out.mode, 'ordered-lines');

  assert.equal(d.getElementById('q7').value, '3.7647E5', 'Q7 decimal must not be mis-parsed as numbered list item');
  assert.equal(d.getElementById('q8').value, '8.0000', 'Q8 must not be corrupted to 00000');
  assert.equal(d.getElementById('q9').value, '3.9789E-5');
  assert.equal(d.getElementById('q11').value, '300');

  const radios = d.querySelectorAll('input[name="q10"]');
  assert.equal(radios[1].checked, true, 'Q10 Diamagnetism must be selected');
});

test('11-question "Final answers:" header + "Based on..." trailer is fully filled', () => {
  const html =
    makeQuestion(1, '<input type="text" id="q1">') +
    makeQuestion(2, '<input type="text" id="q2">') +
    makeQuestion(3, '<input type="text" id="q3">') +
    makeQuestion(4, '<input type="text" id="q4">') +
    makeQuestion(5, '<input type="text" id="q5">') +
    makeQuestion(6, '<input type="text" id="q6">') +
    makeQuestion(7, '<input type="text" id="q7">') +
    makeQuestion(8, '<input type="text" id="q8">') +
    makeQuestion(9, '<input type="text" id="q9">') +
    makeQuestion(10,
      '<fieldset>' +
        '<label><input type="radio" name="q10"> Paramagnetism</label>' +
        '<label><input type="radio" name="q10"> Diamagnetism</label>' +
        '<label><input type="radio" name="q10"> Ferromagnetism</label>' +
      '</fieldset>') +
    makeQuestion(11, '<input type="text" id="q11">');
  const d = dom(html);
  const raw =
    'Final answers:\n\n' +
    '0.0539\n' +
    '2*epsilon_o*E_o/r\n' +
    '0\n' +
    '-2k\n' +
    '0\n' +
    '15058.7876 V\n' +
    '3.7647×10^5 N/C\n' +
    '8.0000 μC/m²\n' +
    '3.9789×10^-5 C/m²\n' +
    'Diamagnetism\n' +
    '300 m\n\n' +
    'Based on the uploaded question set.';

  const out = applyAnswers(raw, d.body, { verbose: false });

  assert.equal(out.detectedQuestions, 11);
  assert.equal(out.parsedAnswers, 11);
  assert.equal(out.summary.filled, 11);
  assert.equal(out.summary.failed, 0);
  assert.equal(out.mode, 'ordered-lines');

  assert.equal(d.getElementById('q8').value, '8.0000');
  assert.equal(d.getElementById('q9').value, '3.9789E-5');
  assert.equal(d.querySelectorAll('input[name="q10"]')[1].checked, true);
  assert.equal(d.getElementById('q11').value, '300');
});

test('numbered format still reports mode=numbered (regression guard)', () => {
  const html =
    makeQuestion(1, '<input type="text" id="q1">') +
    makeQuestion(2, '<input type="text" id="q2">');
  const d = dom(html);
  const out = applyAnswers('1. a\n2. b', d.body, { verbose: false });
  assert.equal(out.mode, 'numbered');
});

test('count mismatch falls through to legacy (parsedAnswers stays 0)', () => {
  const html =
    makeQuestion(1, '<input type="text">') +
    makeQuestion(2, '<input type="text">');
  const d = dom(html);
  // 'a','b','c' are single chars: layerLineFallback rejects them (length<2 guard),
  // so parseNumberedAnswers returns []. Then parseOrderedLines sees 3 lines vs
  // 2 detected questions (count mismatch) and also returns []. parsedAnswers stays 0.
  const out = applyAnswers('a\nb\nc', d.body, { verbose: false });
  assert.equal(out.parsedAnswers, 0);
});

// === structured-input entry tests (Let AI answer for you feature) ===

const { applyStructuredAnswers } = require('../lib/answer-applier.js');

function makeRadio(qNum, choices) {
  let s = '<section><h3>Question ' + qNum + '</h3><p>Pick</p>';
  for (let i = 0; i < choices.length; i++) {
    s += '<label><input type="radio" name="r' + qNum + '">' + choices[i] + '</label>';
  }
  return s + '</section>';
}

function makeCheckbox(qNum, choices) {
  let s = '<section><h3>Question ' + qNum + '</h3><p>Pick many</p>';
  for (let i = 0; i < choices.length; i++) {
    s += '<label><input type="checkbox" name="c' + qNum + '">' + choices[i] + '</label>';
  }
  return s + '</section>';
}

function makeText(qNum) {
  return '<section><h3>Question ' + qNum + '</h3><p>Enter value</p><input type="text" id="t' + qNum + '"></section>';
}

test('applyStructuredAnswers: single-choice selects radio by choice text', () => {
  const d = dom(makeRadio(1, ['Alpha', 'Beta', 'Gamma']));
  const out = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'single_choice', choiceText: 'Beta' }],
    d.body, { verbose: false }
  );
  assert.equal(out.summary.filled, 1);
  const inputs = d.querySelectorAll('input[type="radio"]');
  assert.equal(inputs[1].checked, true);
});

test('applyStructuredAnswers: multiple-choice ticks the named checkboxes', () => {
  const d = dom(makeCheckbox(1, ['A', 'B', 'C', 'D']));
  const out = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'multiple_choice', choiceTexts: ['A', 'C'] }],
    d.body, { verbose: false }
  );
  assert.equal(out.summary.filled, 1);
  const cb = d.querySelectorAll('input[type="checkbox"]');
  assert.equal(cb[0].checked, true);
  assert.equal(cb[1].checked, false);
  assert.equal(cb[2].checked, true);
  assert.equal(cb[3].checked, false);
});

test('applyStructuredAnswers: text/math input fills value', () => {
  const d = dom(makeText(1));
  const out = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'math_input', value: '0.0352' }],
    d.body, { verbose: false }
  );
  assert.equal(out.summary.filled, 1);
  assert.equal(d.getElementById('t1').value, '0.0352');
});

test('applyStructuredAnswers: maps by questionNumber even when input order differs from DOM order', () => {
  const d = dom(makeText(1) + makeText(2));
  const out = applyStructuredAnswers([
    { questionNumber: 2, type: 'math_input', value: '2.0' },
    { questionNumber: 1, type: 'math_input', value: '1.0' },
  ], d.body, { verbose: false });
  assert.equal(out.summary.filled, 2);
  assert.equal(d.getElementById('t1').value, '1.0');
  assert.equal(d.getElementById('t2').value, '2.0');
});

test('applyStructuredAnswers: unknown questionNumber is skipped; other answers still applied', () => {
  const d = dom(makeText(1));
  const out = applyStructuredAnswers([
    { questionNumber: 99, type: 'math_input', value: 'ghost' },
    { questionNumber: 1, type: 'math_input', value: 'real' },
  ], d.body, { verbose: false });
  assert.equal(d.getElementById('t1').value, 'real');
  // 99 has no matching question — skipped in summary, not a thrown error.
  assert.ok(out.summary.filled >= 1);
});

test('applyStructuredAnswers: never clicks submit/continue/check buttons', () => {
  const d = dom(makeText(1)
    + '<button id="submit">Submit</button>'
    + '<button id="continue">Continue</button>'
    + '<button id="check">Check</button>'
  );
  let clicked = false;
  ['submit','continue','check'].forEach(function (id) {
    d.getElementById(id).addEventListener('click', function () { clicked = true; });
  });
  applyStructuredAnswers([{ questionNumber: 1, type: 'math_input', value: 'x' }], d.body, { verbose: false });
  assert.equal(clicked, false);
});

test('regression: short letter-only option labels do NOT substring-match long answer prose (all-A bug)', () => {
  const dom2 = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>P</p>'
    + '<label><input type="radio" name="r1" value="A">A</label>'
    + '<label><input type="radio" name="r1" value="B">B</label>'
    + '<label><input type="radio" name="r1" value="C">C</label>'
    + '</section>'
    + '</body></html>'
  );
  // Use numbered prefix so the answer is routed through pickChoice.
  // Without the guard, the substring fallback finds "a" inside the prose and
  // incorrectly selects option A (the all-A bug).
  const raw = '1. (A) uncertainty, (B) fair, (C) 1';
  applyAnswers(raw, dom2.window.document.body, { verbose: false });
  const radios = dom2.window.document.querySelectorAll('input[type="radio"]');
  assert.equal(radios[0].checked, false, 'option A must NOT be selected');
  assert.equal(radios[1].checked, false);
  assert.equal(radios[2].checked, false);
});

test('7-question "Final answers:" block with mixed text/radio/scientific is fully filled', () => {
  // Q3 ("the capacitor") and Q5 ("increase the frequency") are single-choice
  // radio groups in this mock — the spec says these should select their
  // matching option, not become a text fill.
  const html =
    makeQuestion(1, '<input type="text" id="q1">') +
    makeQuestion(2, '<input type="text" id="q2">') +
    makeQuestion(3,
      '<fieldset>' +
        '<label><input type="radio" name="q3"> the inductor</label>' +
        '<label><input type="radio" name="q3"> the capacitor</label>' +
        '<label><input type="radio" name="q3"> the resistor</label>' +
      '</fieldset>') +
    makeQuestion(4, '<input type="text" id="q4">') +
    makeQuestion(5,
      '<fieldset>' +
        '<label><input type="radio" name="q5"> decrease the frequency</label>' +
        '<label><input type="radio" name="q5"> keep the frequency</label>' +
        '<label><input type="radio" name="q5"> increase the frequency</label>' +
      '</fieldset>') +
    makeQuestion(6, '<input type="text" id="q6">') +
    makeQuestion(7, '<input type="text" id="q7">');
  const d = dom(html);
  const raw =
    'Final answers:\n\n' +
    '1. 9795.3096 Hz\n' +
    '2. 0 A\n' +
    '3. the capacitor\n' +
    '4. 0.0006665 A\n' +
    '5. increase the frequency\n' +
    '6. 3.7699×10^-8 C\n' +
    '7. 5.6250×10^-6 C/m²';

  const out = applyAnswers(raw, d.body, { verbose: false });

  assert.equal(out.detectedQuestions, 7);
  assert.equal(out.parsedAnswers, 7);
  assert.equal(out.summary.filled, 7);
  assert.equal(out.summary.failed, 0);

  // Numeric / math_input fields:
  assert.equal(d.getElementById('q1').value, '9795.3096');
  assert.equal(d.getElementById('q2').value, '0');
  assert.equal(d.getElementById('q4').value, '0.0006665');
  assert.equal(d.getElementById('q6').value, '3.7699E-8', 'Q6 must be E notation');
  assert.equal(d.getElementById('q7').value, '5.6250E-6', 'Q7 must be E notation');

  // Radio selections:
  const q3 = d.querySelectorAll('input[name="q3"]');
  assert.equal(q3[0].checked, false);
  assert.equal(q3[1].checked, true, 'Q3 "the capacitor" must be selected');
  assert.equal(q3[2].checked, false);

  const q5 = d.querySelectorAll('input[name="q5"]');
  assert.equal(q5[0].checked, false);
  assert.equal(q5[1].checked, false);
  assert.equal(q5[2].checked, true, 'Q5 "increase the frequency" must be selected');
});

test('multi-segment answer on single_choice with letter-only options → failed with diagnostic reason', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>P</p>'
    + '<label><input type="radio" name="r1" value="A">A</label>'
    + '<label><input type="radio" name="r1" value="B">B</label>'
    + '<label><input type="radio" name="r1" value="C">C</label>'
    + '</section>'
    + '</body></html>'
  );
  const raw = '1. (A) uncertainty, (B) fair, (C) 1';
  const r = applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'failed');
  assert.equal(r.results[0].reason, 'multi-segment-not-single-choice');
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.filled, 0);
});

test('multi-target text question: letter segments fill each sub-input positionally', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>Multi-blank prompt</p>'
    + '<label>(A) <input type="text" id="ta" /></label>'
    + '<label>(B) <input type="text" id="tb" /></label>'
    + '<label>(C) <input type="text" id="tc" /></label>'
    + '</section>'
    + '</body></html>'
  );
  const raw = '1. (A) uncertainty, (B) fair, (C) 1';
  const r = applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(dom.window.document.getElementById('ta').value, 'uncertainty');
  assert.equal(dom.window.document.getElementById('tb').value, 'fair');
  assert.equal(dom.window.document.getElementById('tc').value, '1');
  assert.equal(r.summary.filled, 1, 'one question fully filled');
});

test('multi-target text question: sequence segments fill positionally', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>Order:</p>'
    + '<input type="text" id="t1" /><input type="text" id="t2" /><input type="text" id="t3" />'
    + '</section>'
    + '</body></html>'
  );
  const raw = '1. first – second – third';
  applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(dom.window.document.getElementById('t1').value, 'first');
  assert.equal(dom.window.document.getElementById('t2').value, 'second');
  assert.equal(dom.window.document.getElementById('t3').value, 'third');
});

test('multi-target text question: segment count > target count fills min(L,R) and reports partial', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>P</p>'
    + '<input type="text" id="ta" /><input type="text" id="tb" />'
    + '</section>'
    + '</body></html>'
  );
  const raw = '1. (A) one, (B) two, (C) three';
  const r = applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(dom.window.document.getElementById('ta').value, 'one');
  assert.equal(dom.window.document.getElementById('tb').value, 'two');
  assert.equal(r.results[0].status, 'partial');
  assert.equal(r.results[0].reason, 'segment-count-mismatch');
});

test('single-target text question with no segments: prose fills the one input (passthrough)', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>P</p>'
    + '<textarea id="ta"></textarea>'
    + '</section>'
    + '</body></html>'
  );
  const raw = '1. If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.';
  applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(
    dom.window.document.getElementById('ta').value,
    'If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.'
  );
});

test('E2E: user-reported paste fills multi-target questions, refuses single-letter choices, fills prose', () => {
  const { JSDOM } = require('jsdom');
  const html = ''
    + '<section><h3>Question 1</h3><p>Multi-blank</p>'
    + '<input type="text" id="q1a" /><input type="text" id="q1b" /><input type="text" id="q1c" />'
    + '</section>'
    + '<section><h3>Question 2</h3><p>Pick one</p>'
    + '<label><input type="radio" name="r2" value="A">A</label>'
    + '<label><input type="radio" name="r2" value="B">B</label>'
    + '<label><input type="radio" name="r2" value="C">C</label>'
    + '</section>'
    + '<section><h3>Question 3</h3><p>Explain</p>'
    + '<textarea id="q3"></textarea>'
    + '</section>';
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>');
  const raw =
    '1. (A) uncertainty, (B) fair, (C) 1\n'
    + '2. (A) MCS, (B) CQI, (C) AMC\n'
    + '3. If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.';
  const r = applyAnswers(raw, dom.window.document.body, { verbose: false });

  // Q1: multi-blank fills positionally
  assert.equal(dom.window.document.getElementById('q1a').value, 'uncertainty');
  assert.equal(dom.window.document.getElementById('q1b').value, 'fair');
  assert.equal(dom.window.document.getElementById('q1c').value, '1');

  // Q2: multi-segment-not-single-choice → no radio selected
  const r2 = dom.window.document.querySelectorAll('input[name="r2"]');
  assert.equal(r2[0].checked, false, 'A must not be selected (regression for all-A bug)');
  assert.equal(r2[1].checked, false);
  assert.equal(r2[2].checked, false);

  // Q3: prose fills the textarea
  assert.equal(
    dom.window.document.getElementById('q3').value,
    'If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.'
  );

  assert.equal(r.summary.filled, 2, 'Q1 and Q3 filled');
  assert.equal(r.summary.failed, 1, 'Q2 refused');
});
