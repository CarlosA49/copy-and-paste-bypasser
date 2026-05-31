'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createManagedClient } = require('../lib/managed-client.js');

test('Stage 2: createManagedClient returns an object with generateAnswers', () => {
  const c = createManagedClient({});
  assert.equal(typeof c.generateAnswers, 'function');
});

test('Stage 2: generateAnswers returns managed-not-implemented WITHOUT calling fetchFn', async () => {
  let called = false;
  const fetchFn = function () { called = true; throw new Error('must not be called'); };
  const c = createManagedClient({ fetchFn: fetchFn, backendBaseUrl: 'https://placeholder.invalid' });
  const r = await c.generateAnswers({ page: {}, questions: [], token: 't' }, 'session-token-stub', { signal: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'managed-not-implemented');
  assert.equal(called, false, 'fetchFn must NOT be invoked in Stage 2 mock');
});

test('Stage 2: returned response carries no key/credential/session-token fields', async () => {
  const c = createManagedClient({ backendBaseUrl: 'https://placeholder.invalid' });
  const r = await c.generateAnswers({}, 'sk-LEAK-DO-NOT-EXPOSE-1234567', {});
  assert.equal(JSON.stringify(r).indexOf('sk-LEAK-DO-NOT-EXPOSE'), -1);
  assert.equal(JSON.stringify(r).indexOf('session-token-stub'), -1);
});
