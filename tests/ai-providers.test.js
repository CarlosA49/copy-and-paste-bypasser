'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aiProviders } = require('../lib/ai-providers.js');

function makeFetch(impl) {
  const calls = [];
  const fn = function (url, init) { calls.push({ url: url, init: init }); return impl(url, init); };
  fn.calls = calls;
  return fn;
}

function makeResponse(status, jsonBody) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    text: function () { return Promise.resolve(JSON.stringify(jsonBody)); },
  });
}

const SNAP = { page: { urlOrigin: 'https://www.coursera.org', eligible: true }, questions: [{ id: 'q1', type: 'math_input', prompt: 'p', order: 1 }], token: 'snap_x' };

test('registry exposes get and list functions', () => {
  assert.equal(typeof aiProviders.get, 'function');
  assert.equal(typeof aiProviders.list, 'function');
});

test('list returns the five known providers with id/label/models/defaultModel', () => {
  const ids = aiProviders.list().map(function (p) { return p.id; }).sort();
  assert.deepEqual(ids, ['anthropic', 'custom', 'deepseek', 'gemini', 'openai']);
  aiProviders.list().forEach(function (p) {
    assert.equal(typeof p.label, 'string');
    assert.ok(p.label.length > 0);
    assert.ok(Array.isArray(p.models));
    assert.equal(typeof p.defaultModel, 'string');
  });
});

test('get returns null for an unknown provider id', () => {
  assert.equal(aiProviders.get('nope'), null);
});
