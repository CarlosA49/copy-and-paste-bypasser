const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const guard = require('../lib/autopilot-input-guard.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window;
}

// jsdom 29+ marks isTrusted as non-configurable on constructed events.
// Use a Proxy to fake isTrusted=true without redefining it.
function makeTrusted(ev, overrides) {
  return new Proxy(ev, {
    get: function (target, prop) {
      if (prop === 'isTrusted') return true;
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

test('shouldPauseFor: returns false when settings.pauseOnUserInput is false', () => {
  const w = dom('<input id="x">');
  const input = w.document.getElementById('x');
  const raw = new w.KeyboardEvent('keydown', { bubbles: true });
  const ev = makeTrusted(raw, { composedPath: function () { return [input]; } });
  assert.equal(guard.shouldPauseFor(ev, { pauseOnUserInput: false }), false);
});

test('shouldPauseFor: returns true on trusted keydown when setting is enabled', () => {
  const w = dom('<input id="x">');
  const input = w.document.getElementById('x');
  const raw = new w.KeyboardEvent('keydown', { bubbles: true });
  const ev = makeTrusted(raw, { composedPath: function () { return [input]; } });
  assert.equal(guard.shouldPauseFor(ev, { pauseOnUserInput: true }), true);
});

test('shouldPauseFor: ignores untrusted (synthetic) events even when setting enabled', () => {
  const w = dom('<input id="x">');
  const ev = new w.KeyboardEvent('keydown', { bubbles: true });
  // isTrusted defaults to false on jsdom-constructed events; do not override.
  assert.equal(guard.shouldPauseFor(ev, { pauseOnUserInput: true }), false);
});

test('shouldPauseFor: returns false when composed path contains the sidebar host id', () => {
  const w = dom('<div id="ccp-host-root"><input id="x"></div>');
  const host = w.document.getElementById('ccp-host-root');
  const input = w.document.getElementById('x');
  const raw = new w.KeyboardEvent('keydown', { bubbles: true });
  const ev = makeTrusted(raw, { composedPath: function () { return [input, host]; } });
  assert.equal(guard.shouldPauseFor(ev, { pauseOnUserInput: true }), false);
});

test('shouldPauseFor: accepts pointerdown and mousedown event types', () => {
  const w = dom('<button id="b">');
  const btn = w.document.getElementById('b');
  const mk = function (type) {
    const raw = new w.Event(type, { bubbles: true });
    return makeTrusted(raw, { composedPath: function () { return [btn]; } });
  };
  assert.equal(guard.shouldPauseFor(mk('pointerdown'), { pauseOnUserInput: true }), true);
  assert.equal(guard.shouldPauseFor(mk('mousedown'), { pauseOnUserInput: true }), true);
});

test('attachInputListeners: invokes onPause once on trusted keydown when enabled', () => {
  const w = dom('<input id="x">');
  let calls = 0;
  const detach = guard.attachInputListeners(
    w.document,
    function () { return { pauseOnUserInput: true }; },
    function (el) { return false; },
    function () { calls += 1; }
  );
  // Dispatch a real trusted-looking event via the document directly.
  // jsdom does not set isTrusted=true for programmatically dispatched events,
  // so we call the internal handler logic by dispatching on the element and
  // relying on the capture listener to pick it up.
  // Instead, directly invoke shouldPauseFor with a proxied event to confirm
  // the listener integrates correctly — and separately test the wiring.
  //
  // For the wiring test: we need an actually-dispatched event. jsdom 29 marks
  // isTrusted=false for dispatchEvent, so we patch the handler to accept
  // events that pass our fake-trusted proxy check. Dispatch to document directly.
  const raw = new w.KeyboardEvent('keydown', { bubbles: true });
  // Simulate what the capture handler sees — it receives the real event.
  // Since we can't make jsdom dispatch a trusted event, we instead test that
  // the capture listener is wired and calls onPause when shouldPauseFor returns true.
  // We override shouldPauseFor temporarily on the guard's closure by patching
  // the exported function. Because the module is loaded, we instead inject
  // a synthetic trusted event object directly into the capture handler.
  //
  // Approach: monkey-patch document.addEventListener to intercept our capture handler,
  // then call it directly with a trusted proxy event.
  const origAdd = w.document.addEventListener.bind(w.document);
  let captureHandler = null;
  w.document.addEventListener = function (type, fn, capture) {
    if (type === 'keydown' && capture === true) captureHandler = fn;
    return origAdd(type, fn, capture);
  };
  // Re-attach so we capture the handler reference.
  const detach2 = guard.attachInputListeners(
    w.document,
    function () { return { pauseOnUserInput: true }; },
    null,
    function () { calls += 1; }
  );
  if (captureHandler) {
    const input = w.document.getElementById('x');
    const fakeEv = makeTrusted(raw, { composedPath: function () { return [input]; } });
    captureHandler(fakeEv);
  }
  assert.equal(calls, 1);
  detach();
  detach2();
});

test('attachInputListeners: does not invoke onPause when setting disabled', () => {
  const w = dom('<input id="x">');
  let calls = 0;
  const origAdd = w.document.addEventListener.bind(w.document);
  let captureHandler = null;
  w.document.addEventListener = function (type, fn, capture) {
    if (type === 'keydown' && capture === true) captureHandler = fn;
    return origAdd(type, fn, capture);
  };
  const detach = guard.attachInputListeners(
    w.document,
    function () { return { pauseOnUserInput: false }; },
    function () { return false; },
    function () { calls += 1; }
  );
  if (captureHandler) {
    const input = w.document.getElementById('x');
    const raw = new w.KeyboardEvent('keydown', { bubbles: true });
    const fakeEv = makeTrusted(raw, { composedPath: function () { return [input]; } });
    captureHandler(fakeEv);
  }
  assert.equal(calls, 0);
  detach();
});
