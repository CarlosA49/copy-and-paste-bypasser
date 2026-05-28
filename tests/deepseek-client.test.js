'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../lib/deepseek-client.js');

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

test('missing key short-circuits before fetch', async () => {
  const f = makeFetch(function () { throw new Error('should not be called'); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, '');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing-key');
  assert.equal(f.calls.length, 0);
});

test('valid 200 response is normalized', async () => {
  const f = makeFetch(function () { return makeResponse(200, {
    choices: [{ message: { content: JSON.stringify({ answers: [
      { question_id: 'q1', answer: { type: 'text', value: '42' }, explanation: '', confidence: 'high' }
    ] }) } }]
  }); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-test');
  assert.equal(r.ok, true);
  assert.ok(r.raw && Array.isArray(r.raw.answers));
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('API key appears only in Authorization header and not in returned value', async () => {
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: '{"answers":[]}' }}]}); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-SUPER-SECRET');
  const sent = f.calls[0];
  assert.ok(sent.init.headers && sent.init.headers.Authorization === 'Bearer sk-SUPER-SECRET');
  // body must NOT contain the key
  assert.equal(String(sent.init.body || '').indexOf('sk-SUPER-SECRET'), -1);
  // result must NOT contain the key
  assert.equal(JSON.stringify(r).indexOf('sk-SUPER-SECRET'), -1);
});

test('401 maps to unauthorized', async () => {
  const f = makeFetch(function () { return makeResponse(401, { error: { message: 'bad key' } }); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unauthorized');
});

test('429 maps to rate-limit', async () => {
  const f = makeFetch(function () { return makeResponse(429, {}); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.reason, 'rate-limit');
});

test('500 maps to server-error', async () => {
  const f = makeFetch(function () { return makeResponse(500, {}); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.reason, 'server-error');
});

test('network error maps to network', async () => {
  const f = makeFetch(function () { return Promise.reject(new Error('socket reset')); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.reason, 'network');
});

test('abort signal yields reason=aborted', async () => {
  const f = makeFetch(function (url, init) {
    return new Promise(function (resolve, reject) {
      init.signal.addEventListener('abort', function () {
        var err = new Error('aborted'); err.name = 'AbortError'; reject(err);
      });
    });
  });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const ctrl = new AbortController();
  setTimeout(function () { ctrl.abort(); }, 10);
  const r = await c.generateAnswers(SNAP, 'sk-x', { signal: ctrl.signal });
  assert.equal(r.reason, 'aborted');
});

test('timeout fires when slow', async () => {
  const f = makeFetch(function () { return new Promise(function () {}); }); // never resolves
  const c = createClient({ fetchFn: f, model: 'deepseek-chat', timeoutMs: 30 });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.reason, 'timeout');
});

test('content that is not parseable JSON is returned with reason=invalid-response', async () => {
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: 'not json at all' } }] }); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  // Client returns raw content; validator's job is to decide invalid-json,
  // but client must surface a non-throwing result either way.
  // Accept either: ok:true with raw containing 'not json...' OR ok:false reason:'invalid-response'.
  if (r.ok) {
    assert.equal(typeof r.raw, 'object');
  } else {
    assert.equal(r.reason, 'invalid-response');
  }
});

test('user prompt contains snapshot but never an API key', async () => {
  const f = makeFetch(function (url, init) { return makeResponse(200, { choices: [{ message: { content: '{"answers":[]}' } }] }); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  await c.generateAnswers(SNAP, 'sk-XYZ');
  const body = JSON.parse(f.calls[0].init.body);
  const userMsg = body.messages.find(function (m) { return m.role === 'user'; });
  assert.ok(userMsg);
  assert.ok(userMsg.content.indexOf('"q1"') !== -1, 'snapshot must be in user prompt');
  assert.equal(userMsg.content.indexOf('sk-XYZ'), -1);
});

test('H9: createClient with no model option uses deepseek-v4-flash by default', async () => {
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: '{"answers":[]}' } }] }); });
  const c = createClient({ fetchFn: f });
  await c.generateAnswers(SNAP, 'sk-x');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.model, 'deepseek-v4-flash',
    'Default model must be deepseek-v4-flash. The legacy "deepseek-chat" alias is documented as deprecated 2026-07-24. Do not change the default unless official DeepSeek docs change.');
});

test('U15-P1: SYSTEM_PROMPT contains explicit math_input answer shape example', async () => {
  let captured = null;
  const f = makeFetch(function (url, init) {
    try { captured = JSON.parse(init.body); } catch (_) {}
    return makeResponse(200, { choices: [{ message: { content: JSON.stringify({ answers: [] }) } }] });
  });
  const c = createClient({ fetchFn: f });
  await c.generateAnswers(SNAP, 'sk-fake');
  assert.ok(captured, 'fetch must have been called with a body');
  const systemMsg = captured.messages[0];
  assert.equal(systemMsg.role, 'system');
  const content = systemMsg.content;
  assert.ok(content.indexOf('"type": "text"') !== -1 || content.indexOf('"type":"text"') !== -1,
    'system prompt must contain the {"type":"text",...} answer shape');
  assert.ok(content.indexOf('math_input') !== -1,
    'system prompt must mention math_input by name so the model maps the page type to the shape');
});

test('U15-P2: SYSTEM_PROMPT still contains "json" (DeepSeek JSON-mode requirement)', async () => {
  let captured = null;
  const f = makeFetch(function (url, init) {
    try { captured = JSON.parse(init.body); } catch (_) {}
    return makeResponse(200, { choices: [{ message: { content: JSON.stringify({ answers: [] }) } }] });
  });
  const c = createClient({ fetchFn: f });
  await c.generateAnswers(SNAP, 'sk-fake');
  const systemMsg = captured.messages[0];
  assert.ok(/\bjson\b/i.test(systemMsg.content),
    'system prompt MUST contain the word "json" for DeepSeek JSON mode');
});
