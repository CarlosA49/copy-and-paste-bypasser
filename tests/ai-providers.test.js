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

test('openai buildRequest posts JSON to the chat completions URL with the key only in the Authorization header', () => {
  const a = aiProviders.get('openai');
  const req = a.buildRequest(SNAP, 'sk-SUPER-SECRET', { model: 'gpt-4o-mini' });
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.Authorization, 'Bearer sk-SUPER-SECRET');
  assert.equal(req.headers['Content-Type'], 'application/json');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.response_format.type, 'json_object');
  const userMsg = body.messages.find(function (m) { return m.role === 'user'; });
  assert.ok(userMsg.content.indexOf('"q1"') !== -1, 'snapshot must be in the user prompt');
  assert.equal(req.body.indexOf('sk-SUPER-SECRET'), -1);
});

test('openai parseResponse reads choices[0].message.content and JSON.parses it into raw.answers', () => {
  const a = aiProviders.get('openai');
  const r = a.parseResponse({ choices: [{ message: { content: JSON.stringify({ answers: [{ question_id: 'q1' }] }) } }] });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.raw.answers));
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('openai parseResponse returns {ok:true, raw:{_raw}} for non-JSON content', () => {
  const a = aiProviders.get('openai');
  const r = a.parseResponse({ choices: [{ message: { content: 'not json at all' } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw._raw, 'not json at all');
});

test('openai createClient end-to-end 200 normalizes and never leaks the key', async () => {
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: '{"answers":[{"question_id":"q1"}]}' } }] }); });
  const c = aiProviders.get('openai').createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-SUPER-SECRET');
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
  assert.equal(JSON.stringify(r).indexOf('sk-SUPER-SECRET'), -1);
  assert.equal(String(f.calls[0].init.body || '').indexOf('sk-SUPER-SECRET'), -1);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer sk-SUPER-SECRET');
});

test('deepseek buildRequest targets api.deepseek.com with json_object response_format and the key only in Authorization', () => {
  const a = aiProviders.get('deepseek');
  const req = a.buildRequest(SNAP, 'sk-DS-SECRET', { model: 'deepseek-chat' });
  assert.equal(req.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.Authorization, 'Bearer sk-DS-SECRET');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(req.body.indexOf('sk-DS-SECRET'), -1);
});

test('deepseek default model is deepseek-chat when no model option supplied', () => {
  const a = aiProviders.get('deepseek');
  const req = a.buildRequest(SNAP, 'sk-x', {});
  assert.equal(JSON.parse(req.body).model, 'deepseek-chat');
});

test('deepseek system prompt contains json, math_input, and the {"type":"text"} shape', () => {
  const a = aiProviders.get('deepseek');
  const body = JSON.parse(a.buildRequest(SNAP, 'sk-x', {}).body);
  const system = body.messages[0].content;
  assert.ok(/\bjson\b/i.test(system));
  assert.ok(system.indexOf('math_input') !== -1);
  assert.ok(system.indexOf('"type":"text"') !== -1 || system.indexOf('"type": "text"') !== -1);
});

test('deepseek parseResponse normalizes choices[0].message.content to raw.answers', () => {
  const a = aiProviders.get('deepseek');
  const r = a.parseResponse({ choices: [{ message: { content: JSON.stringify({ answers: [{ question_id: 'q1' }] }) } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('anthropic buildRequest sends the key in x-api-key (not Authorization) with anthropic-version header', () => {
  const a = aiProviders.get('anthropic');
  const req = a.buildRequest(SNAP, 'sk-ANT-SECRET', { model: 'claude-3-5-haiku-latest' });
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-api-key'], 'sk-ANT-SECRET');
  assert.ok(typeof req.headers['anthropic-version'] === 'string' && req.headers['anthropic-version'].length > 0);
  assert.equal(req.headers.Authorization, undefined, 'anthropic must NOT use a Bearer Authorization header');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'claude-3-5-haiku-latest');
  assert.ok(typeof body.system === 'string' && /\bjson\b/i.test(body.system));
  assert.ok(typeof body.max_tokens === 'number');
  const userMsg = body.messages.find(function (m) { return m.role === 'user'; });
  assert.ok(userMsg.content.indexOf('"q1"') !== -1);
  assert.equal(req.body.indexOf('sk-ANT-SECRET'), -1);
});

test('anthropic parseResponse reads content[0].text and JSON.parses into raw.answers', () => {
  const a = aiProviders.get('anthropic');
  const r = a.parseResponse({ content: [{ type: 'text', text: JSON.stringify({ answers: [{ question_id: 'q1' }] }) }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('anthropic parseResponse returns {ok:true, raw:{_raw}} for non-JSON text', () => {
  const a = aiProviders.get('anthropic');
  const r = a.parseResponse({ content: [{ type: 'text', text: 'plain words' }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw._raw, 'plain words');
});

test('anthropic createClient end-to-end never leaks the key into body or return', async () => {
  const f = makeFetch(function () { return makeResponse(200, { content: [{ type: 'text', text: '{"answers":[]}' }] }); });
  const c = aiProviders.get('anthropic').createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-ANT-SECRET');
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r).indexOf('sk-ANT-SECRET'), -1);
  assert.equal(String(f.calls[0].init.body || '').indexOf('sk-ANT-SECRET'), -1);
  assert.equal(f.calls[0].init.headers['x-api-key'], 'sk-ANT-SECRET');
});

test('gemini buildRequest puts the key in the x-goog-api-key header and NOT in the URL query', () => {
  const a = aiProviders.get('gemini');
  const req = a.buildRequest(SNAP, 'gem-SECRET-KEY', { model: 'gemini-1.5-flash' });
  assert.ok(req.url.indexOf('generativelanguage.googleapis.com') !== -1);
  assert.ok(req.url.indexOf('gemini-1.5-flash') !== -1);
  assert.equal(req.url.indexOf('gem-SECRET-KEY'), -1, 'key must NOT appear in the URL (no ?key=)');
  assert.equal(req.url.indexOf('key='), -1, 'no key= query param allowed');
  assert.equal(req.headers['x-goog-api-key'], 'gem-SECRET-KEY');
  const body = JSON.parse(req.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(JSON.stringify(body).indexOf('"q1"') !== -1, 'snapshot must be embedded');
  assert.equal(req.body.indexOf('gem-SECRET-KEY'), -1);
});

test('gemini parseResponse reads candidates[0].content.parts[0].text into raw.answers', () => {
  const a = aiProviders.get('gemini');
  const r = a.parseResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answers: [{ question_id: 'q1' }] }) }] } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('gemini parseResponse returns {ok:true, raw:{_raw}} for non-JSON parts text', () => {
  const a = aiProviders.get('gemini');
  const r = a.parseResponse({ candidates: [{ content: { parts: [{ text: 'free text' }] } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw._raw, 'free text');
});

test('gemini createClient end-to-end never leaks the key into URL, body, or return', async () => {
  const f = makeFetch(function () { return makeResponse(200, { candidates: [{ content: { parts: [{ text: '{"answers":[]}' }] } }] }); });
  const c = aiProviders.get('gemini').createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'gem-SECRET-KEY');
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r).indexOf('gem-SECRET-KEY'), -1);
  assert.equal(String(f.calls[0].url || '').indexOf('gem-SECRET-KEY'), -1);
  assert.equal(String(f.calls[0].init.body || '').indexOf('gem-SECRET-KEY'), -1);
  assert.equal(f.calls[0].init.headers['x-goog-api-key'], 'gem-SECRET-KEY');
});
