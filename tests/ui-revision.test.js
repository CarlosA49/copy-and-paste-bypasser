'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { CCP_UI_REVISION, populateUiRevisionTag } = require('../lib/ui-revision.js');

test('U13-R1: CCP_UI_REVISION equals "U13" (source-controlled constant)', () => {
  assert.equal(CCP_UI_REVISION, 'U13');
});

test('U13-R2: populateUiRevisionTag writes "UI Revision: U13" into any [data-role="ccp-ui-revision"] element under the given root', () => {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div data-role="ccp-ui-revision">placeholder</div>'
    + '<section><div data-role="ccp-ui-revision">UI Revision: —</div></section>'
    + '</body></html>');
  populateUiRevisionTag(dom.window.document);
  const elements = dom.window.document.querySelectorAll('[data-role="ccp-ui-revision"]');
  assert.equal(elements.length, 2);
  for (var i = 0; i < elements.length; i++) {
    assert.equal(elements[i].textContent, 'UI Revision: U13');
  }
});

test('U13-R3: populateUiRevisionTag is a safe no-op when root is null/undefined or has no matching elements', () => {
  assert.doesNotThrow(function () { populateUiRevisionTag(null); });
  assert.doesNotThrow(function () { populateUiRevisionTag(undefined); });
  const dom = new JSDOM('<!doctype html><html><body><div>no marker</div></body></html>');
  assert.doesNotThrow(function () { populateUiRevisionTag(dom.window.document); });
});
