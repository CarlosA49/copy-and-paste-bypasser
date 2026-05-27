'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachAiContentListeners } = require('../lib/ai-content-listeners.js');

function fakeRuntime() {
  var listeners = [];
  return {
    onMessage: {
      addListener: function (fn) { listeners.push(fn); },
    },
    _emit: function (msg) { listeners.forEach(function (l) { l(msg); }); },
    _listenerCount: function () { return listeners.length; },
  };
}

test('U10-2: ccp.ai.keyStatusChanged calls controller.refreshKeyStatus()', () => {
  const runtime = fakeRuntime();
  let refreshCalls = 0;
  const controller = { refreshKeyStatus: function () { refreshCalls++; } };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  runtime._emit({ type: 'ccp.ai.keyStatusChanged' });
  assert.equal(refreshCalls, 1);
});

test('U10-2: ccp.ai.accessModeChanged ALSO calls controller.refreshKeyStatus()', () => {
  const runtime = fakeRuntime();
  let refreshCalls = 0;
  const controller = { refreshKeyStatus: function () { refreshCalls++; } };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  runtime._emit({ type: 'ccp.ai.accessModeChanged' });
  assert.equal(refreshCalls, 1, 'access-mode broadcast must trigger refreshKeyStatus');
});

test('U10-2: unrelated message types do NOT call refreshKeyStatus', () => {
  const runtime = fakeRuntime();
  let refreshCalls = 0;
  const controller = { refreshKeyStatus: function () { refreshCalls++; } };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  runtime._emit({ type: 'autopilot.state' });
  runtime._emit({ type: 'random.other' });
  runtime._emit(null);
  runtime._emit(undefined);
  assert.equal(refreshCalls, 0);
});

test('U10-2: throwing controller.refreshKeyStatus does not propagate to the message bus', () => {
  const runtime = fakeRuntime();
  const controller = { refreshKeyStatus: function () { throw new Error('boom'); } };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  assert.doesNotThrow(function () { runtime._emit({ type: 'ccp.ai.accessModeChanged' }); });
});

test('U10-2: exactly one listener is registered per attach call', () => {
  const runtime = fakeRuntime();
  const controller = { refreshKeyStatus: function () {} };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  assert.equal(runtime._listenerCount(), 1, 'helper must register exactly one listener');
});

test('U10-2: missing runtime or controller is a no-op (no throw, no listener)', () => {
  assert.doesNotThrow(function () { attachAiContentListeners({}); });
  assert.doesNotThrow(function () { attachAiContentListeners({ runtime: fakeRuntime() }); });
  assert.doesNotThrow(function () { attachAiContentListeners({ controller: { refreshKeyStatus: function () {} } }); });
  const runtime = fakeRuntime();
  attachAiContentListeners({ runtime: runtime, controller: null });
  assert.equal(runtime._listenerCount(), 0);
});

test('U10-2: integration — simulated options switch to managed-credits flips the sidebar to managed card without page reload or key Save/Clear', () => {
  // Sidebar starts in personal-key mode, then receives the accessModeChanged
  // broadcast (as if dispatched from a successful options-page setAccessMode).
  // The controller's refreshKeyStatus must re-query the background and the
  // sidebar must reflect the new access mode.
  const runtime = fakeRuntime();
  let currentMode = 'personal-key';
  let renderedMode = null;
  const stubController = {
    refreshKeyStatus: function () {
      // emulate controller: asks bg for keyStatus, renders accessMode
      renderedMode = currentMode;
    }
  };
  attachAiContentListeners({ runtime: runtime, controller: stubController });
  // Initial render
  stubController.refreshKeyStatus();
  assert.equal(renderedMode, 'personal-key');
  // Options page switches mode in storage and emits the broadcast
  currentMode = 'managed-credits';
  runtime._emit({ type: 'ccp.ai.accessModeChanged' });
  assert.equal(renderedMode, 'managed-credits',
    'sidebar must reflect the new mode after accessModeChanged');
});

test('U10-2: integration — reverse switch (managed → personal) also rerenders', () => {
  const runtime = fakeRuntime();
  let currentMode = 'managed-credits';
  let renderedMode = null;
  const stubController = { refreshKeyStatus: function () { renderedMode = currentMode; } };
  attachAiContentListeners({ runtime: runtime, controller: stubController });
  stubController.refreshKeyStatus();
  assert.equal(renderedMode, 'managed-credits');
  currentMode = 'personal-key';
  runtime._emit({ type: 'ccp.ai.accessModeChanged' });
  assert.equal(renderedMode, 'personal-key');
});
