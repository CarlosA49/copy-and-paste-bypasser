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
