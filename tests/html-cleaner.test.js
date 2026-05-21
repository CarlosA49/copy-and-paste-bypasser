const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanSelectionHtml } = require('../lib/html-cleaner.js');

// Each test calls cleanSelectionHtml(htmlString) and asserts on both
// cleanHtml and cleanText. Subsequent tasks append more tests.

test('no-op: clean input with no junk and no math passes through structurally intact', () => {
  const input = '<p>Hello world.</p>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /^<p>Hello world\.<\/p>$/);
  assert.equal(cleanText, 'Hello world.');
});

// --- Pass 1: MathJax normalisation -----------------------------------------

test('MathJax v2 inline equation becomes math + mtext + annotation; plain text is $x = 5$', () => {
  const input =
    '<span class="MathJax_Preview"></span>' +
    '<span class="MathJax" id="MJ-1" tabindex="0">x = 5 (rendered noise)</span>' +
    '<script type="math/tex" id="MJ-1-src">x = 5</script>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /<math[^>]*display="inline"[^>]*>/);
  assert.match(cleanHtml, /<mtext>x = 5<\/mtext>/);
  assert.match(cleanHtml, /<annotation encoding="application\/x-tex">x = 5<\/annotation>/);
  // Visual MathJax span and source script are gone.
  assert.doesNotMatch(cleanHtml, /class="MathJax/);
  assert.doesNotMatch(cleanHtml, /<script/);
  // assert.equal(cleanText.trim(), '$x = 5$'); // TODO Task 6: enable when plain-text walker handles math
});

test('MathJax v2 display equation becomes math display="block"; plain text emits $$x = 5$$ on its own line', () => {
  const input =
    '<div class="MathJax_Display"><span class="MathJax">x = 5</span></div>' +
    '<script type="math/tex; mode=display">x = 5</script>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /<math[^>]*display="block"[^>]*>/);
  assert.match(cleanHtml, /<mtext>x = 5<\/mtext>/);
  assert.doesNotMatch(cleanHtml, /MathJax_Display/);
  // assert.match(cleanText, /\$\$x = 5\$\$/); // TODO Task 6
});

test('pre-existing <math> with annotation is preserved (real MathML, no mtext injection)', () => {
  const input =
    '<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><semantics>' +
    '<mrow><mi>x</mi><mo>=</mo><mn>5</mn></mrow>' +
    '<annotation encoding="application/x-tex">x = 5</annotation>' +
    '</semantics></math>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /<mrow>.*<mi>x<\/mi>.*<mo>=<\/mo>.*<mn>5<\/mn>.*<\/mrow>/);
  assert.match(cleanHtml, /<annotation encoding="application\/x-tex">x = 5<\/annotation>/);
  // No <mtext> injection when real MathML is present.
  assert.doesNotMatch(cleanHtml, /<mtext>/);
  // assert.equal(cleanText.trim(), '$x = 5$'); // TODO Task 6
});

// --- Pass 2: Block-level junk drop -----------------------------------------

test('a <div> whose text matches a junk pattern is removed; surrounding content survives', () => {
  const input =
    '<p>Keep one.</p>' +
    '<div>You are a helpful AI assistant; uphold Coursera academic integrity.</div>' +
    '<p>Keep two.</p>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.doesNotMatch(cleanHtml, /AI assistant/i);
  assert.doesNotMatch(cleanHtml, /Coursera/i);
  assert.match(cleanHtml, /<p>Keep one\.<\/p>/);
  assert.match(cleanHtml, /<p>Keep two\.<\/p>/);
  // assert.equal(cleanText, 'Keep one.\n\nKeep two.'); // TODO Task 6
});

test('junk inside a <section>: only the junk child block is removed, the section and other children survive', () => {
  const input =
    '<section>' +
    '  <p>Keep one.</p>' +
    '  <p>This material is from Coursera.</p>' +
    '  <p>Keep two.</p>' +
    '</section>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /<section>/);
  assert.match(cleanHtml, /<p>Keep one\.<\/p>/);
  assert.match(cleanHtml, /<p>Keep two\.<\/p>/);
  assert.doesNotMatch(cleanHtml, /Coursera/i);
});

// --- Pass 3: Attribute stripping -------------------------------------------

test('cosmetic attributes (class, style, id, data-*, aria-*, role) are stripped', () => {
  const input = '<p class="x" style="color:red" id="z" data-foo="bar" aria-hidden="true" role="text">Hi</p>';
  const { cleanHtml } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /^<p>Hi<\/p>$/);
});

test('allow-list attributes survive: <a href title>, <ol start>, <td colspan>, <img alt>', () => {
  const input =
    '<a href="/x" title="t" class="y">link</a>' +
    '<ol start="3" class="z"><li>a</li></ol>' +
    '<table><tr><td colspan="2" style="bold">cell</td></tr></table>' +
    '<img src="/i.png" alt="pic" width="10" height="20" data-x="y">';
  const { cleanHtml } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /<a href="\/x" title="t">link<\/a>/);
  assert.match(cleanHtml, /<ol start="3">/);
  assert.match(cleanHtml, /<td colspan="2">cell<\/td>/);
  assert.match(cleanHtml, /<img src="\/i\.png" alt="pic" width="10" height="20">/);
  assert.doesNotMatch(cleanHtml, /class=/);
  assert.doesNotMatch(cleanHtml, /style=/);
  assert.doesNotMatch(cleanHtml, /data-/);
});
