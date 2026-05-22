// tests/lecture-companion.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createCompanion } = require('../lib/lecture-companion.js');

function setup(html) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>');
  return dom.window.document;
}

test('emits a draft after video pause', async () => {
  const doc = setup(
    '<video></video>' +
    '<div data-testid="transcript">' +
      '<div class="phrase">Gradient descent updates weights.</div>' +
      '<div class="phrase">The gradient flows backwards through the network.</div>' +
    '</div>'
  );
  const drafts = [];
  const companion = createCompanion({
    document: doc,
    onDraft: function (t) { drafts.push(t); },
    debounceMs: 0,
    random: function () { return 0.5; },
  });
  companion.init();
  const video = doc.querySelector('video');
  video.dispatchEvent(new doc.defaultView.Event('pause'));
  await new Promise(function (r) { setTimeout(r, 5); });
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].length > 0);
});

test('does not emit when no transcript is present', async () => {
  const doc = setup('<video></video><div>no transcript</div>');
  const drafts = [];
  const companion = createCompanion({
    document: doc,
    onDraft: function (t) { drafts.push(t); },
    debounceMs: 0,
    random: function () { return 0.5; },
  });
  companion.init();
  doc.querySelector('video').dispatchEvent(new doc.defaultView.Event('pause'));
  await new Promise(function (r) { setTimeout(r, 5); });
  assert.equal(drafts.length, 0);
});

test('debounces rapid pause events into one draft', async () => {
  const doc = setup(
    '<video></video>' +
    '<div data-testid="transcript"><div class="phrase">Some cue text here.</div></div>'
  );
  const drafts = [];
  const companion = createCompanion({
    document: doc,
    onDraft: function (t) { drafts.push(t); },
    debounceMs: 20,
    random: function () { return 0.5; },
  });
  companion.init();
  const v = doc.querySelector('video');
  v.dispatchEvent(new doc.defaultView.Event('pause'));
  v.dispatchEvent(new doc.defaultView.Event('pause'));
  v.dispatchEvent(new doc.defaultView.Event('pause'));
  await new Promise(function (r) { setTimeout(r, 50); });
  assert.equal(drafts.length, 1);
});

test('attaches to a later-inserted video via observer', async () => {
  const doc = setup(
    '<div data-testid="transcript"><div class="phrase">Cue.</div></div>'
  );
  const drafts = [];
  const companion = createCompanion({
    document: doc,
    onDraft: function (t) { drafts.push(t); },
    debounceMs: 0,
    random: function () { return 0.5; },
  });
  companion.init();
  // Insert a video later
  const v = doc.createElement('video');
  doc.body.appendChild(v);
  await new Promise(function (r) { setTimeout(r, 10); });
  v.dispatchEvent(new doc.defaultView.Event('pause'));
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.equal(drafts.length, 1);
});
