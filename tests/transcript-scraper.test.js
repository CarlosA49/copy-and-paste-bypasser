const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { scrapeTranscript, findVideoElement } = require('../lib/transcript-scraper.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('returns null cues when no transcript container present', () => {
  const d = dom('<div>no transcript</div>');
  const r = scrapeTranscript(d);
  assert.equal(r.cues, null);
});

test('extracts cues from data-testid transcript container', () => {
  const d = dom(
    '<div data-testid="transcript">' +
      '<div class="phrase" data-time="0">Welcome to gradient descent.</div>' +
      '<div class="phrase" data-time="4.2">It minimizes a loss function.</div>' +
    '</div>'
  );
  const r = scrapeTranscript(d);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text, 'Welcome to gradient descent.');
  assert.equal(r.cues[0].time, 0);
  assert.equal(r.cues[1].time, 4.2);
});

test('falls back to rc-Transcript class', () => {
  const d = dom(
    '<div class="rc-Transcript">' +
      '<span class="transcript-text">First sentence.</span>' +
      '<span class="transcript-text">Second sentence.</span>' +
    '</div>'
  );
  const r = scrapeTranscript(d);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text, 'First sentence.');
});

test('extracts lecture title from h1 inside rc-ItemHeader', () => {
  const d = dom(
    '<div class="rc-ItemHeader"><h1>Lesson 3.2: Backpropagation</h1></div>' +
    '<div data-testid="transcript"><div class="phrase">Body.</div></div>'
  );
  const r = scrapeTranscript(d);
  assert.equal(r.lectureTitle, 'Lesson 3.2: Backpropagation');
});

test('extracts week objective from current-page sidebar item', () => {
  const d = dom(
    '<nav><a aria-current="page" data-week-objective="Understand training dynamics">Lesson</a></nav>' +
    '<div data-testid="transcript"><div class="phrase">Body.</div></div>'
  );
  const r = scrapeTranscript(d);
  assert.equal(r.weekObjective, 'Understand training dynamics');
});

test('findVideoElement returns the first video', () => {
  const d = dom('<video src="x"></video><video src="y"></video>');
  assert.equal(findVideoElement(d).src.endsWith('x'), true);
});

test('findVideoElement returns null when no video', () => {
  const d = dom('<div>nope</div>');
  assert.equal(findVideoElement(d), null);
});
