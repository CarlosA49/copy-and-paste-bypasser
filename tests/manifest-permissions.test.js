'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
}

test('PB-M1: manifest is valid JSON and manifest_version 3', () => {
  const m = manifest();
  assert.equal(m.manifest_version, 3);
});

test('PB-M2: host_permissions include deepseek, openai, anthropic, and gemini API hosts', () => {
  const hp = manifest().host_permissions;
  ['https://api.deepseek.com/*', 'https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://generativelanguage.googleapis.com/*']
    .forEach(function (h) { assert.ok(hp.indexOf(h) !== -1, 'missing host_permission: ' + h); });
});

test('PB-M3: optional_host_permissions requests https://*/* for the custom endpoint (not in always-on host_permissions)', () => {
  const m = manifest();
  assert.ok(Array.isArray(m.optional_host_permissions), 'optional_host_permissions must be an array');
  assert.ok(m.optional_host_permissions.indexOf('https://*/*') !== -1, 'must request https://*/* optionally');
  assert.equal(m.host_permissions.indexOf('https://*/*'), -1, 'broad grant must NOT ship as an always-on host_permission');
});

test('PB-M4: content_scripts.matches remain restricted to Coursera (hard boundary unchanged)', () => {
  const matches = manifest().content_scripts[0].matches.sort();
  // Boundary unchanged from before Phase B: the real manifest scopes to the
  // wildcard subdomain + the bare apex host.
  assert.deepEqual(matches, ['https://*.coursera.org/*', 'https://coursera.org/*']);
});
