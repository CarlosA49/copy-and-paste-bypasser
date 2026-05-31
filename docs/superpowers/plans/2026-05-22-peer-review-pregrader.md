# Peer Review Pre-Grader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Peer Review" sidebar tab that scrapes the peer's submission + rubric from the page, analyzes the submission against each rubric criterion via local heuristics (strengths/weaknesses), and renders a feedback **draft** (never auto-submitted) in the user's learned voice. The user must read, edit, and copy/paste the draft into the actual feedback box themselves — that's the whole point.

**Architecture:** Five new pure-logic modules in `lib/` follow the existing IIFE + `module.exports` + `window.ClipboardCleaner.<name>` pattern: a submission scraper (DOM → `{submissionText, rubricCriteria}`), a rubric analyzer (criterion + text → `{strengths, weaknesses, evidence}`), a voice profile (chrome.storage CRUD over past drafts → numeric voice features), a feedback synthesizer (analysis + voice features → draft prose), and a controller (page detection → scrape → analyze → emit). The sidebar adds a Peer Review tab with a draft textarea and a "Save my edits" button that captures the user's final edits to grow the voice profile.

**Tech Stack:** Vanilla JS (matching existing style), `node:test` + jsdom, Chrome Extension Manifest V3, `chrome.storage.local` (fake in tests). No new dependencies.

---

## File Structure

**Create:**
- `lib/submission-scraper.js` — locates the peer submission body + rubric block in a Coursera peer-review page, returns `{submissionText, rubricCriteria: [{id, prompt, options}]}`.
- `lib/rubric-analyzer.js` — pure: for each criterion, scans submission text for strength/weakness signals (presence of evidence markers, counter-argument markers, length, hedging) and returns `{criterionId, strengths, weaknesses, evidenceSnippets}`.
- `lib/voice-profile.js` — async CRUD over an injected storage (chrome.storage.local in browser, in-memory in tests). Saves prior drafts, derives `{avgSentenceLen, hedgeRate, formality, contractionsOk, preferredOpeners}`.
- `lib/feedback-synthesizer.js` — pure: `{analyses, voice} → string` — composes one paragraph per criterion using voice features to pick sentence length, openers, hedging, and contractions.
- `lib/peer-review-controller.js` — wires scraper + analyzer + voice + synthesizer + sidebar. Detects the peer-review URL/route and emits a draft when the submission is on-screen.
- `tests/submission-scraper.test.js`, `tests/rubric-analyzer.test.js`, `tests/voice-profile.test.js`, `tests/feedback-synthesizer.test.js`, `tests/peer-review-controller.test.js`.

**Modify:**
- `lib/sidebar.js` — add "Peer Review" tab + panel with: a draft textarea (`data-role="review-draft"`), a "Regenerate" button, a "Save my edits to voice profile" button, and a status line. Expose `setReviewDraft(text, meta)` and `getReviewDraft()`.
- `manifest.json` — append `submission-scraper`, `rubric-analyzer`, `voice-profile`, `feedback-synthesizer`, `peer-review-controller` to `content_scripts[0].js` (before `sidebar.js`).
- `content.js` — on DOMContentLoaded, start the peer-review controller alongside the existing wiring.

---

## Task 1: Submission scraper — extract submission + rubric from DOM

**Files:**
- Create: `lib/submission-scraper.js`
- Test: `tests/submission-scraper.test.js`

### Selectors (Coursera peer review, tolerant fallbacks)

- Submission body: `[data-testid="submission-body"]`, `.rc-PeerReviewSubmission`, or any `<article>` inside a container whose class contains `Submission`.
- Rubric criteria container: `[data-testid="rubric"]`, `.rc-PeerReviewRubric`, or a section whose `aria-label` contains "Rubric".
- Each criterion: a child of the rubric container with `data-criterion-id` or `[role="group"]` with an `<h3>` prompt and `<label>` options.

Return `null` for either piece when missing — never throw.

- [ ] **Step 1: Write the failing test**

```js
// tests/submission-scraper.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { scrapeReviewPage } = require('../lib/submission-scraper.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('returns null pieces when nothing matches', () => {
  const r = scrapeReviewPage(dom('<div>nothing here</div>'));
  assert.equal(r.submissionText, null);
  assert.deepEqual(r.rubricCriteria, []);
});

test('extracts submission body via data-testid', () => {
  const d = dom('<div data-testid="submission-body"><p>The peer wrote this paragraph about gradient descent and its trade-offs.</p></div>');
  const r = scrapeReviewPage(d);
  assert.ok(r.submissionText.indexOf('gradient descent') !== -1);
});

test('falls back to article inside Submission container', () => {
  const d = dom('<div class="WrapperSubmissionThing"><article>Body text here.</article></div>');
  const r = scrapeReviewPage(d);
  assert.equal(r.submissionText, 'Body text here.');
});

test('extracts rubric criteria with prompt and options', () => {
  const d = dom(
    '<div data-testid="submission-body">Body.</div>' +
    '<section data-testid="rubric">' +
      '<div data-criterion-id="c1">' +
        '<h3>Use of evidence</h3>' +
        '<label>Strong</label><label>Adequate</label><label>Weak</label>' +
      '</div>' +
      '<div data-criterion-id="c2">' +
        '<h3>Counter-arguments addressed</h3>' +
        '<label>Yes</label><label>Partial</label><label>No</label>' +
      '</div>' +
    '</section>'
  );
  const r = scrapeReviewPage(d);
  assert.equal(r.rubricCriteria.length, 2);
  assert.equal(r.rubricCriteria[0].id, 'c1');
  assert.equal(r.rubricCriteria[0].prompt, 'Use of evidence');
  assert.deepEqual(r.rubricCriteria[0].options, ['Strong', 'Adequate', 'Weak']);
  assert.equal(r.rubricCriteria[1].id, 'c2');
});

test('falls back to role=group rubric items without explicit ids', () => {
  const d = dom(
    '<div data-testid="submission-body">Body.</div>' +
    '<section aria-label="Grading rubric">' +
      '<div role="group"><h3>Clarity</h3><label>High</label><label>Low</label></div>' +
    '</section>'
  );
  const r = scrapeReviewPage(d);
  assert.equal(r.rubricCriteria.length, 1);
  assert.equal(r.rubricCriteria[0].prompt, 'Clarity');
  assert.ok(r.rubricCriteria[0].id, 'generates id when missing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="submission|rubric criteria"`
Expected: FAIL with `Cannot find module '../lib/submission-scraper.js'`.

- [ ] **Step 3: Write the scraper**

```js
// lib/submission-scraper.js
(function (root) {
  'use strict';

  const SUBMISSION_SELECTORS = [
    '[data-testid="submission-body"]',
    '.rc-PeerReviewSubmission',
    '[class*="Submission"] article',
    'article[class*="Submission"]',
  ];

  const RUBRIC_CONTAINER_SELECTORS = [
    '[data-testid="rubric"]',
    '.rc-PeerReviewRubric',
    'section[aria-label*="ubric"]',
  ];

  const CRITERION_SELECTORS = [
    '[data-criterion-id]',
    '[role="group"]',
  ];

  function firstMatching(root, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = root.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function allMatching(root, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const list = root.querySelectorAll(selectors[i]);
      if (list && list.length > 0) return Array.prototype.slice.call(list);
    }
    return [];
  }

  function textOf(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function scrapeSubmission(doc) {
    const el = firstMatching(doc, SUBMISSION_SELECTORS);
    if (!el) return null;
    const t = textOf(el);
    return t || null;
  }

  function scrapeCriteria(doc) {
    const container = firstMatching(doc, RUBRIC_CONTAINER_SELECTORS);
    if (!container) return [];
    const items = allMatching(container, CRITERION_SELECTORS);
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const id = el.getAttribute('data-criterion-id') || ('crit-' + (i + 1));
      const promptEl = el.querySelector('h3, h4, [class*="Prompt"]');
      const prompt = textOf(promptEl);
      if (!prompt) continue;
      const optionEls = el.querySelectorAll('label');
      const options = [];
      for (let j = 0; j < optionEls.length; j++) {
        const t = textOf(optionEls[j]);
        if (t) options.push(t);
      }
      out.push({ id: id, prompt: prompt, options: options });
    }
    return out;
  }

  function scrapeReviewPage(doc) {
    return {
      submissionText: scrapeSubmission(doc),
      rubricCriteria: scrapeCriteria(doc),
    };
  }

  const api = { scrapeReviewPage: scrapeReviewPage };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.submissionScraper = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="submission|rubric criteria"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/submission-scraper.js tests/submission-scraper.test.js
git commit -m "feat(peer-review): add tolerant scraper for submission and rubric"
```

---

## Task 2: Rubric analyzer — heuristic strengths/weaknesses

**Files:**
- Create: `lib/rubric-analyzer.js`
- Test: `tests/rubric-analyzer.test.js`

The analyzer is **pure**. For each criterion, score the submission against a small heuristic library:

- **Evidence markers** — presence of citations (`(Smith, 2020)`, `[1]`, `according to`, `studies show`, `data from`) → strength for any criterion whose prompt contains `evidence`, `data`, `support`, `source`.
- **Counter-argument markers** — `however`, `on the other hand`, `critics`, `one objection`, `alternatively` → strength for prompts containing `counter`, `objection`, `opposing`, `alternative`.
- **Structure markers** — paragraph count ≥ 3 AND avg sentence length 12–25 words → strength for `structure`, `clarity`, `organization`.
- **Length floor** — submission `< 80` words → universal weakness `"Submission is brief — consider expanding key claims."`.
- **Hedging excess** — count of `maybe`, `perhaps`, `kind of`, `sort of`, `I think` > 3 → weakness for `clarity`, `argument`, `position`.
- **No detected evidence** when criterion is evidence-focused → weakness `"No explicit sources or data references detected."`.

Returns `[{ criterionId, prompt, strengths: string[], weaknesses: string[], evidenceSnippets: string[] }]` — one per criterion.

`evidenceSnippets` is up to two short quoted spans (≤120 chars) lifted directly from the submission containing the matched marker, used by the synthesizer to ground feedback in the peer's own words.

- [ ] **Step 1: Write the failing tests**

```js
// tests/rubric-analyzer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRubric } = require('../lib/rubric-analyzer.js');

test('flags evidence strength when citations + evidence-focused criterion', () => {
  const submission = 'According to Smith (2020), gradient descent converges. Studies show this effect across networks. The data from the experiment supports this view.';
  const criteria = [{ id: 'c1', prompt: 'Use of evidence and sources', options: [] }];
  const out = analyzeRubric(submission, criteria);
  assert.equal(out.length, 1);
  assert.ok(out[0].strengths.join(' ').toLowerCase().indexOf('evidence') !== -1);
  assert.ok(out[0].evidenceSnippets.length > 0);
});

test('flags missing evidence weakness on evidence criterion', () => {
  const submission = 'Gradient descent is the best optimizer ever. It just works for everything.';
  const criteria = [{ id: 'c1', prompt: 'Use of evidence', options: [] }];
  const out = analyzeRubric(submission, criteria);
  assert.ok(out[0].weaknesses.join(' ').toLowerCase().indexOf('source') !== -1
    || out[0].weaknesses.join(' ').toLowerCase().indexOf('evidence') !== -1);
});

test('flags counter-argument strength when markers present', () => {
  const submission = 'Gradient descent works well. However, critics argue it gets stuck in local minima. One objection is that learning rate tuning is brittle.';
  const criteria = [{ id: 'c2', prompt: 'Addresses counter-arguments', options: [] }];
  const out = analyzeRubric(submission, criteria);
  assert.ok(out[0].strengths.join(' ').toLowerCase().indexOf('counter') !== -1);
});

test('flags length weakness on every criterion when submission is too short', () => {
  const submission = 'Short submission.';
  const criteria = [
    { id: 'c1', prompt: 'Evidence', options: [] },
    { id: 'c2', prompt: 'Clarity', options: [] },
  ];
  const out = analyzeRubric(submission, criteria);
  out.forEach(function (a) {
    assert.ok(a.weaknesses.join(' ').toLowerCase().indexOf('brief') !== -1);
  });
});

test('flags excess hedging on clarity/argument criteria', () => {
  const submission = 'I think gradient descent maybe works. Perhaps it is kind of useful. Sort of effective. I think the loss kind of goes down. ' +
    'It is also probably the best one to use here, more or less.';
  const criteria = [{ id: 'c1', prompt: 'Clarity of argument', options: [] }];
  const out = analyzeRubric(submission, criteria);
  assert.ok(out[0].weaknesses.join(' ').toLowerCase().indexOf('hedging') !== -1);
});

test('returns empty when no criteria given', () => {
  assert.deepEqual(analyzeRubric('text', []), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="analyzeRubric|rubric analyzer"`
Expected: FAIL with `Cannot find module '../lib/rubric-analyzer.js'`.

- [ ] **Step 3: Write the analyzer**

```js
// lib/rubric-analyzer.js
(function (root) {
  'use strict';

  const EVIDENCE_PATTERNS = [
    /\([A-Z][a-zA-Z]+,\s*\d{4}\)/,            // (Smith, 2020)
    /\[\d+\]/,                                  // [1]
    /\baccording to\b/i,
    /\bstudies show\b/i,
    /\bdata (?:from|in|of)\b/i,
    /\bresearch (?:shows|finds|by)\b/i,
    /\bsource[s]?:\s*\S/i,
  ];

  const COUNTER_PATTERNS = [
    /\bhowever\b/i,
    /\bon the other hand\b/i,
    /\bcritics?\b/i,
    /\bone objection\b/i,
    /\balternatively\b/i,
    /\bdespite\b/i,
    /\bsome (?:argue|say|claim)\b/i,
  ];

  const HEDGE_PATTERNS = [
    /\bmaybe\b/i,
    /\bperhaps\b/i,
    /\bkind of\b/i,
    /\bsort of\b/i,
    /\bI think\b/i,
    /\bprobably\b/i,
    /\bmore or less\b/i,
  ];

  function wordCount(s) { return (String(s).match(/\S+/g) || []).length; }

  function splitSentences(s) {
    return String(s).split(/(?<=[.!?])\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function countMatches(text, patterns) {
    let n = 0;
    for (let i = 0; i < patterns.length; i++) {
      const m = text.match(new RegExp(patterns[i].source, 'gi'));
      if (m) n += m.length;
    }
    return n;
  }

  function snippetsAround(text, patterns, max) {
    const out = [];
    for (let i = 0; i < patterns.length && out.length < max; i++) {
      const r = new RegExp(patterns[i].source, 'i');
      const m = text.match(r);
      if (!m) continue;
      const idx = m.index;
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + m[0].length + 60);
      let snip = text.slice(start, end).replace(/\s+/g, ' ').trim();
      if (snip.length > 120) snip = snip.slice(0, 117) + '…';
      out.push(snip);
    }
    return out;
  }

  function promptHas(prompt, words) {
    const p = String(prompt).toLowerCase();
    for (let i = 0; i < words.length; i++) if (p.indexOf(words[i]) !== -1) return true;
    return false;
  }

  function analyzeOne(submission, criterion) {
    const strengths = [];
    const weaknesses = [];
    const evidenceSnippets = [];
    const isEvidence = promptHas(criterion.prompt, ['evidence', 'data', 'support', 'source', 'cite']);
    const isCounter  = promptHas(criterion.prompt, ['counter', 'objection', 'opposing', 'alternative']);
    const isStructure = promptHas(criterion.prompt, ['structure', 'clarity', 'organization', 'organisation', 'flow']);
    const isArgument  = promptHas(criterion.prompt, ['argument', 'position', 'clarity', 'reasoning']);

    const evidenceCount = countMatches(submission, EVIDENCE_PATTERNS);
    const counterCount  = countMatches(submission, COUNTER_PATTERNS);
    const hedgeCount    = countMatches(submission, HEDGE_PATTERNS);
    const words = wordCount(submission);
    const sentences = splitSentences(submission);
    const avgLen = sentences.length ? words / sentences.length : 0;
    const paragraphCount = submission.split(/\n\s*\n/).filter(function (p) { return p.trim(); }).length;

    if (isEvidence) {
      if (evidenceCount >= 1) {
        strengths.push('Good use of evidence — concrete sources are referenced.');
        const snips = snippetsAround(submission, EVIDENCE_PATTERNS, 2);
        for (let i = 0; i < snips.length; i++) evidenceSnippets.push(snips[i]);
      } else {
        weaknesses.push('No explicit sources or data references detected.');
      }
    }

    if (isCounter) {
      if (counterCount >= 1) {
        strengths.push('Counter-arguments are acknowledged.');
        const snips = snippetsAround(submission, COUNTER_PATTERNS, 1);
        for (let i = 0; i < snips.length; i++) evidenceSnippets.push(snips[i]);
      } else {
        weaknesses.push('No counter-argument or opposing view considered.');
      }
    }

    if (isStructure) {
      if (paragraphCount >= 3 && avgLen >= 12 && avgLen <= 25) {
        strengths.push('Structure is clear — paragraphs flow at a readable cadence.');
      } else if (paragraphCount < 2) {
        weaknesses.push('Consider breaking the submission into more paragraphs.');
      }
    }

    if (isArgument && hedgeCount > 3) {
      weaknesses.push('Excessive hedging weakens the argument — commit to stronger claims.');
    }

    if (words < 80) {
      weaknesses.push('Submission is brief — consider expanding key claims.');
    }

    return {
      criterionId: criterion.id,
      prompt: criterion.prompt,
      strengths: strengths,
      weaknesses: weaknesses,
      evidenceSnippets: evidenceSnippets,
    };
  }

  function analyzeRubric(submission, criteria) {
    if (!criteria || criteria.length === 0) return [];
    const out = [];
    for (let i = 0; i < criteria.length; i++) out.push(analyzeOne(submission || '', criteria[i]));
    return out;
  }

  const api = { analyzeRubric: analyzeRubric };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.rubricAnalyzer = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="analyzeRubric|rubric analyzer"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/rubric-analyzer.js tests/rubric-analyzer.test.js
git commit -m "feat(peer-review): heuristic rubric analyzer with strengths and weaknesses"
```

---

## Task 3: Voice profile — storage + feature derivation

**Files:**
- Create: `lib/voice-profile.js`
- Test: `tests/voice-profile.test.js`

The profile module takes an injected storage adapter shaped like `chrome.storage.local`:

```js
{
  get(keys, cb): cb({ key: value })
  set(items, cb): cb()
}
```

API:
- `createProfile(storage)` returns `{ recordDraft(text, callback), getVoice(callback), clear(callback) }`.
- `recordDraft` appends the text (and current timestamp) to a bounded ring buffer (max 20 entries) under key `ccp_voice_drafts`.
- `getVoice` reads the buffer and returns:

```js
{
  sampleCount,
  avgSentenceLen,        // avg words per sentence across all drafts
  hedgeRate,             // hedge markers per 100 words
  contractionsOk,        // true if contractions appear in ≥30% of drafts
  formality,             // 'casual' | 'neutral' | 'formal' bucket from features
  preferredOpeners,      // up to 5 most frequent first-sentence openers (3-word prefixes)
}
```

A `null`-ish voice (no samples yet) is `{ sampleCount: 0, ... }` with sensible defaults: `avgSentenceLen=18, hedgeRate=1.0, contractionsOk=true, formality='neutral', preferredOpeners: []`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/voice-profile.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProfile } = require('../lib/voice-profile.js');

function fakeStorage() {
  const store = {};
  return {
    _store: store,
    get: function (keys, cb) {
      const out = {};
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach(function (k) { out[k] = store[k]; });
      cb(out);
    },
    set: function (items, cb) {
      Object.keys(items).forEach(function (k) { store[k] = items[k]; });
      cb && cb();
    },
  };
}

function awaitCb(fn) {
  return new Promise(function (resolve) { fn(resolve); });
}

test('getVoice returns defaults when no samples exist', async () => {
  const p = createProfile(fakeStorage());
  const v = await awaitCb(p.getVoice);
  assert.equal(v.sampleCount, 0);
  assert.equal(v.formality, 'neutral');
  assert.equal(v.contractionsOk, true);
  assert.deepEqual(v.preferredOpeners, []);
});

test('recordDraft increases sampleCount', async () => {
  const p = createProfile(fakeStorage());
  await awaitCb(function (done) { p.recordDraft('First draft. Short and casual. It\'s ok.', done); });
  const v = await awaitCb(p.getVoice);
  assert.equal(v.sampleCount, 1);
});

test('avgSentenceLen reflects multi-draft average', async () => {
  const p = createProfile(fakeStorage());
  await awaitCb(function (d) { p.recordDraft('Short one. Two words.', d); });
  await awaitCb(function (d) { p.recordDraft('A considerably longer sentence with many many words. Another long sentence with more verbose construction overall.', d); });
  const v = await awaitCb(p.getVoice);
  assert.ok(v.avgSentenceLen > 3, 'avgSentenceLen reflects both samples');
});

test('formality bucket reflects contraction + hedge use', async () => {
  const p = createProfile(fakeStorage());
  await awaitCb(function (d) { p.recordDraft("I think it's pretty solid. Honestly, I'd just tweak the intro a bit.", d); });
  await awaitCb(function (d) { p.recordDraft("Maybe lean into the counter-argument more. Could be stronger.", d); });
  const v = await awaitCb(p.getVoice);
  assert.equal(v.contractionsOk, true);
  assert.equal(v.formality, 'casual');
});

test('formality is formal when no contractions and no hedging', async () => {
  const p = createProfile(fakeStorage());
  await awaitCb(function (d) { p.recordDraft('The submission presents a structured argument. Evidence is well sourced.', d); });
  await awaitCb(function (d) { p.recordDraft('The author addresses counter-arguments thoroughly. Conclusions follow from the evidence.', d); });
  const v = await awaitCb(p.getVoice);
  assert.equal(v.contractionsOk, false);
  assert.equal(v.formality, 'formal');
});

test('preferredOpeners returns top 3-word prefixes', async () => {
  const p = createProfile(fakeStorage());
  await awaitCb(function (d) { p.recordDraft('Nice work overall. Solid foundation.', d); });
  await awaitCb(function (d) { p.recordDraft('Nice work overall. Worth tightening.', d); });
  const v = await awaitCb(p.getVoice);
  assert.ok(v.preferredOpeners.length >= 1);
  assert.equal(v.preferredOpeners[0], 'nice work overall');
});

test('ring buffer caps at 20 entries', async () => {
  const p = createProfile(fakeStorage());
  for (let i = 0; i < 25; i++) {
    await awaitCb(function (d) { p.recordDraft('Draft ' + i + ' words here.', d); });
  }
  const v = await awaitCb(p.getVoice);
  assert.equal(v.sampleCount, 20);
});

test('clear resets the profile', async () => {
  const p = createProfile(fakeStorage());
  await awaitCb(function (d) { p.recordDraft('Something.', d); });
  await awaitCb(p.clear);
  const v = await awaitCb(p.getVoice);
  assert.equal(v.sampleCount, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="voice|formality|preferredOpeners|ring buffer"`
Expected: FAIL with `Cannot find module '../lib/voice-profile.js'`.

- [ ] **Step 3: Write the profile**

```js
// lib/voice-profile.js
(function (root) {
  'use strict';

  const STORE_KEY = 'ccp_voice_drafts';
  const MAX_DRAFTS = 20;

  const HEDGE = /\b(?:maybe|perhaps|kind of|sort of|I think|probably|more or less)\b/gi;
  const CONTRACTION = /\b\w+'\w+\b/;

  function wordCount(s) { return (String(s).match(/\S+/g) || []).length; }
  function splitSentences(s) {
    return String(s).split(/(?<=[.!?])\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function firstSentence(s) { const arr = splitSentences(s); return arr[0] || ''; }
  function openerOf(sentence) {
    const tokens = String(sentence).toLowerCase().match(/[a-z']+/g) || [];
    return tokens.slice(0, 3).join(' ');
  }

  function defaults() {
    return {
      sampleCount: 0,
      avgSentenceLen: 18,
      hedgeRate: 1.0,
      contractionsOk: true,
      formality: 'neutral',
      preferredOpeners: [],
    };
  }

  function deriveVoice(drafts) {
    if (!drafts || drafts.length === 0) return defaults();
    let totalWords = 0;
    let totalSentences = 0;
    let totalHedges = 0;
    let draftsWithContractions = 0;
    const openerCounts = new Map();
    for (let i = 0; i < drafts.length; i++) {
      const text = drafts[i].text || '';
      const w = wordCount(text);
      const sents = splitSentences(text);
      totalWords += w;
      totalSentences += sents.length;
      const hm = text.match(HEDGE);
      totalHedges += hm ? hm.length : 0;
      if (CONTRACTION.test(text)) draftsWithContractions += 1;
      const op = openerOf(firstSentence(text));
      if (op) openerCounts.set(op, (openerCounts.get(op) || 0) + 1);
    }
    const avgSentenceLen = totalSentences ? (totalWords / totalSentences) : 18;
    const hedgeRate = totalWords ? (totalHedges / totalWords) * 100 : 0;
    const contractionsOk = (draftsWithContractions / drafts.length) >= 0.3;
    let formality = 'neutral';
    if (contractionsOk && hedgeRate >= 1.0) formality = 'casual';
    else if (!contractionsOk && hedgeRate < 0.5) formality = 'formal';
    const openers = Array.from(openerCounts.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 5)
      .map(function (e) { return e[0]; });
    return {
      sampleCount: drafts.length,
      avgSentenceLen: avgSentenceLen,
      hedgeRate: hedgeRate,
      contractionsOk: contractionsOk,
      formality: formality,
      preferredOpeners: openers,
    };
  }

  function createProfile(storage) {
    function load(cb) {
      storage.get([STORE_KEY], function (got) {
        const arr = (got && Array.isArray(got[STORE_KEY])) ? got[STORE_KEY] : [];
        cb(arr);
      });
    }
    function recordDraft(text, cb) {
      if (typeof text !== 'string' || !text.trim()) { cb && cb(); return; }
      load(function (drafts) {
        drafts.push({ text: text, at: Date.now() });
        while (drafts.length > MAX_DRAFTS) drafts.shift();
        const items = {};
        items[STORE_KEY] = drafts;
        storage.set(items, function () { cb && cb(); });
      });
    }
    function getVoice(cb) {
      load(function (drafts) { cb(deriveVoice(drafts)); });
    }
    function clear(cb) {
      const items = {};
      items[STORE_KEY] = [];
      storage.set(items, function () { cb && cb(); });
    }
    return { recordDraft: recordDraft, getVoice: getVoice, clear: clear };
  }

  function chromeStorageOrNull() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return {
        get: function (keys, cb) { chrome.storage.local.get(keys, cb); },
        set: function (items, cb) { chrome.storage.local.set(items, cb); },
      };
    }
    return null;
  }

  const api = {
    createProfile: createProfile,
    deriveVoice: deriveVoice,
    chromeStorageOrNull: chromeStorageOrNull,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.voiceProfile = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="voice|formality|preferredOpeners|ring buffer"`
Expected: PASS (8 tests).

- [ ] **Step 5: Add `chrome.storage` to manifest permissions**

Edit `manifest.json` — add a `permissions` key at the top level (it does not exist yet):

```json
  "permissions": ["storage"],
```

Place it between `description` and `icons`.

- [ ] **Step 6: Commit**

```bash
git add lib/voice-profile.js tests/voice-profile.test.js manifest.json
git commit -m "feat(peer-review): voice profile with bounded draft history"
```

---

## Task 4: Feedback synthesizer — analysis + voice → draft

**Files:**
- Create: `lib/feedback-synthesizer.js`
- Test: `tests/feedback-synthesizer.test.js`

Pure. `generateFeedback({ analyses, voice, random })` returns a string draft. Structure:

1. **Opener** — if `voice.preferredOpeners.length > 0`, capitalize and reuse the top opener as the first sentence. Otherwise pick a default from `['Nice work overall.', 'Solid first pass.', 'A few thoughts.']` via RNG.
2. **One paragraph per analysis**, in input order:
   - First sentence states the criterion (e.g. `On use of evidence:`).
   - Strengths sentences, then weaknesses sentences. The connector and sentence length depend on `voice.formality`:
     - `casual`: short, contractions allowed (`That's working well.`), hedge connectors (`I think`, `maybe`).
     - `neutral`: medium, no contractions, no hedges (`This works well.`).
     - `formal`: longer, third-person phrasing (`The author demonstrates X.`).
   - When `analysis.evidenceSnippets.length > 0`, append one quoted snippet at the end of the paragraph: `e.g. "<snippet>".`
3. **Closer** — `voice.formality === 'casual'` → `Hope this helps!`; `'neutral'` → `Hope this is useful.`; `'formal'` → `I hope these observations are helpful.`

Deterministic per RNG seed.

- [ ] **Step 1: Write the failing tests**

```js
// tests/feedback-synthesizer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateFeedback } = require('../lib/feedback-synthesizer.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const VOICE_NEUTRAL = { sampleCount: 0, avgSentenceLen: 18, hedgeRate: 0.5, contractionsOk: false, formality: 'neutral', preferredOpeners: [] };
const VOICE_CASUAL  = { sampleCount: 3, avgSentenceLen: 12, hedgeRate: 1.5, contractionsOk: true, formality: 'casual', preferredOpeners: ['nice work overall'] };
const VOICE_FORMAL  = { sampleCount: 3, avgSentenceLen: 22, hedgeRate: 0.0, contractionsOk: false, formality: 'formal', preferredOpeners: [] };

test('opens with preferred opener when available', () => {
  const out = generateFeedback({
    analyses: [{ criterionId: 'c1', prompt: 'Use of evidence', strengths: [], weaknesses: [], evidenceSnippets: [] }],
    voice: VOICE_CASUAL,
    random: seededRng(1),
  });
  assert.ok(out.indexOf('Nice work overall') === 0);
});

test('formal voice uses third-person phrasing and avoids contractions', () => {
  const out = generateFeedback({
    analyses: [{
      criterionId: 'c1',
      prompt: 'Evidence',
      strengths: ['Good use of evidence — concrete sources are referenced.'],
      weaknesses: [],
      evidenceSnippets: [],
    }],
    voice: VOICE_FORMAL,
    random: seededRng(2),
  });
  assert.ok(out.indexOf("'") === -1 || out.match(/\w+'\w+/) === null, 'no contractions');
  assert.ok(out.toLowerCase().indexOf('the author') !== -1
         || out.toLowerCase().indexOf('the submission') !== -1);
});

test('casual voice may include contractions', () => {
  const out = generateFeedback({
    analyses: [{
      criterionId: 'c1',
      prompt: 'Evidence',
      strengths: ['Good use of evidence — concrete sources are referenced.'],
      weaknesses: [],
      evidenceSnippets: [],
    }],
    voice: VOICE_CASUAL,
    random: seededRng(3),
  });
  // Casual closer: "Hope this helps!"
  assert.ok(out.trim().endsWith('Hope this helps!'));
});

test('quotes evidence snippet when present', () => {
  const out = generateFeedback({
    analyses: [{
      criterionId: 'c1',
      prompt: 'Evidence',
      strengths: ['Strong evidence used.'],
      weaknesses: [],
      evidenceSnippets: ['according to Smith (2020), gradient descent converges'],
    }],
    voice: VOICE_NEUTRAL,
    random: seededRng(4),
  });
  assert.ok(out.indexOf('according to Smith (2020)') !== -1);
});

test('produces one paragraph per analysis', () => {
  const out = generateFeedback({
    analyses: [
      { criterionId: 'c1', prompt: 'Evidence', strengths: ['Good evidence.'], weaknesses: [], evidenceSnippets: [] },
      { criterionId: 'c2', prompt: 'Counter-arguments', strengths: [], weaknesses: ['No opposing view.'], evidenceSnippets: [] },
    ],
    voice: VOICE_NEUTRAL,
    random: seededRng(5),
  });
  const paras = out.split(/\n\n+/);
  // opener + 2 criterion paragraphs + closer = 4
  assert.equal(paras.length, 4);
  assert.ok(paras[1].toLowerCase().indexOf('evidence') !== -1);
  assert.ok(paras[2].toLowerCase().indexOf('counter') !== -1);
});

test('returns empty string when no analyses', () => {
  assert.equal(generateFeedback({ analyses: [], voice: VOICE_NEUTRAL, random: seededRng(1) }), '');
});

test('deterministic with same seed', () => {
  const args = {
    analyses: [{ criterionId: 'c1', prompt: 'Clarity', strengths: ['Clear writing.'], weaknesses: ['Some hedging.'], evidenceSnippets: [] }],
    voice: VOICE_NEUTRAL,
  };
  const a = generateFeedback(Object.assign({}, args, { random: seededRng(99) }));
  const b = generateFeedback(Object.assign({}, args, { random: seededRng(99) }));
  assert.equal(a, b);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="generateFeedback|feedback synthesizer"`
Expected: FAIL with `Cannot find module '../lib/feedback-synthesizer.js'`.

- [ ] **Step 3: Write the synthesizer**

```js
// lib/feedback-synthesizer.js
(function (root) {
  'use strict';

  const DEFAULT_OPENERS = ['Nice work overall.', 'Solid first pass.', 'A few thoughts.'];

  const CLOSERS = {
    casual: 'Hope this helps!',
    neutral: 'Hope this is useful.',
    formal: 'I hope these observations are helpful.',
  };

  function pick(arr, random) { return arr[Math.floor(random() * arr.length)]; }

  function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function decontract(s) {
    // Strip apostrophe contractions for formal mode.
    return String(s)
      .replace(/\bit's\b/gi, 'it is')
      .replace(/\bthat's\b/gi, 'that is')
      .replace(/\bdon't\b/gi, 'do not')
      .replace(/\bdoesn't\b/gi, 'does not')
      .replace(/\bisn't\b/gi, 'is not')
      .replace(/\bI'd\b/g, 'I would')
      .replace(/\bI'll\b/g, 'I will')
      .replace(/\bI've\b/g, 'I have')
      .replace(/\bcan't\b/gi, 'cannot')
      .replace(/\bwon't\b/gi, 'will not');
  }

  function thirdPerson(s) {
    return String(s)
      .replace(/\bGood use of evidence\b/i, 'The author demonstrates strong use of evidence')
      .replace(/\bGood evidence\b/i, 'The author demonstrates strong use of evidence')
      .replace(/\bClear writing\b/i, 'The submission presents its argument clearly')
      .replace(/\bCounter-arguments are acknowledged\b/i, 'The author acknowledges counter-arguments')
      .replace(/\bStructure is clear\b/i, 'The submission is well structured');
  }

  function casualize(s) {
    return String(s)
      .replace(/\bThis works well\b/i, "That's working well")
      .replace(/\bGood use of\b/i, "Nice use of")
      .replace(/\bConsider expanding\b/i, "I'd expand");
  }

  function applyVoice(sentence, voice) {
    if (!sentence) return sentence;
    if (voice.formality === 'formal') return decontract(thirdPerson(sentence));
    if (voice.formality === 'casual') return casualize(sentence);
    return sentence;
  }

  function paragraphFor(analysis, voice, random) {
    const prompt = (analysis.prompt || '').replace(/\.$/, '');
    const lead = 'On ' + prompt.charAt(0).toLowerCase() + prompt.slice(1) + ':';
    const parts = [lead];
    for (let i = 0; i < analysis.strengths.length; i++) {
      parts.push(applyVoice(analysis.strengths[i], voice));
    }
    for (let i = 0; i < analysis.weaknesses.length; i++) {
      parts.push(applyVoice(analysis.weaknesses[i], voice));
    }
    if (analysis.evidenceSnippets && analysis.evidenceSnippets.length > 0) {
      parts.push('e.g. "' + analysis.evidenceSnippets[0] + '".');
    }
    return parts.join(' ');
  }

  function openerFor(voice, random) {
    if (voice.preferredOpeners && voice.preferredOpeners.length > 0) {
      const raw = voice.preferredOpeners[0];
      const cap = raw.split(' ').map(function (w, i) { return i === 0 ? capitalize(w) : w; }).join(' ');
      return cap + '.';
    }
    return pick(DEFAULT_OPENERS, random);
  }

  function generateFeedback(opts) {
    opts = opts || {};
    const analyses = opts.analyses || [];
    if (analyses.length === 0) return '';
    const voice = opts.voice || { formality: 'neutral', preferredOpeners: [], contractionsOk: true };
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const out = [openerFor(voice, random)];
    for (let i = 0; i < analyses.length; i++) {
      out.push(paragraphFor(analyses[i], voice, random));
    }
    out.push(CLOSERS[voice.formality] || CLOSERS.neutral);
    return out.join('\n\n');
  }

  const api = { generateFeedback: generateFeedback };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.feedbackSynthesizer = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="generateFeedback|feedback synthesizer"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/feedback-synthesizer.js tests/feedback-synthesizer.test.js
git commit -m "feat(peer-review): voice-shaped feedback synthesizer"
```

---

## Task 5: Sidebar — "Peer Review" tab + draft state

**Files:**
- Modify: `lib/sidebar.js`
- Modify: `lib/sidebar.css` (only if styling needed; the existing classes should cover this)

Add a fifth tab `Peer Review`. Panel layout:

- An empty state explaining the user has not opened a peer submission yet.
- A read-only `Submission preview` block (first 400 chars) inside `.ccp-copy-preview`.
- A `Draft feedback` textarea (`data-role="review-draft"`) — **editable**, this is where the draft lands.
- Actions row:
  - `Regenerate` — re-runs synthesis from the last cached analysis/voice.
  - `Copy draft` — copies the textarea content to the clipboard so the user can paste it into Coursera's real feedback box.
  - `Save my edits to voice profile` — sends the current textarea text to the voice profile's `recordDraft`.
- Status line.

Expose:
- `setReviewDraft(text, meta)` where `meta = { submissionText, analyses, voice }` — populates the panel, switches tab, opens. The draft is **set verbatim** (no ghost-typing — the peer-review workflow is about review-and-edit, not visual mimicry).
- `getReviewDraft()` — returns the current textarea content.

- [ ] **Step 1: Add tab + panel HTML in `lib/sidebar.js`**

Append a tab button in the tabs row (after the lecture tab from Plan 1 if applied, otherwise after the answer tab):

```html
'<button class="ccp-tab" role="tab" aria-selected="false" data-tab="review">Peer Review</button>' +
```

Append a panel after the lecture panel:

```html
'<section class="ccp-panel" data-panel="review" data-active="false">' +
  '<div class="ccp-empty" data-role="review-empty"><strong>No submission open</strong><span>Open a Coursera peer-review submission. The draft feedback will appear here for you to edit and copy.</span></div>' +
  '<div class="ccp-copy-preview" data-role="review-submission-preview" hidden></div>' +
  '<textarea class="ccp-textarea" data-role="review-draft" placeholder="Draft feedback will appear here when a submission is detected…" hidden></textarea>' +
  '<div class="ccp-actions" data-role="review-actions" hidden>' +
    '<button class="ccp-btn" data-action="review-regenerate">Regenerate</button>' +
    '<button class="ccp-btn" data-action="review-copy">Copy draft</button>' +
    '<button class="ccp-btn" data-variant="ghost" data-action="review-save-voice">Save my edits to voice profile</button>' +
  '</div>' +
  '<div class="ccp-status" data-role="review-status"></div>' +
'</section>' +
```

- [ ] **Step 2: Wire the review tab in `lib/sidebar.js`**

Inside `mount()`, after the existing `wire*` calls, add `wireReview();`. Then add:

```js
  let _reviewMeta = null;

  function setReviewStatus(text, tone) {
    const s = shadow.querySelector('[data-role="review-status"]');
    if (!s) return;
    s.textContent = text || '';
    if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
  }

  function wireReview() {
    const regen  = shadow.querySelector('[data-action="review-regenerate"]');
    const copy   = shadow.querySelector('[data-action="review-copy"]');
    const save   = shadow.querySelector('[data-action="review-save-voice"]');
    const ta     = shadow.querySelector('[data-role="review-draft"]');
    if (regen) {
      regen.addEventListener('click', function () {
        if (!_reviewMeta) return;
        const synth = window.ClipboardCleaner && window.ClipboardCleaner.feedbackSynthesizer;
        if (!synth) { setReviewStatus('Synthesizer unavailable.', 'error'); return; }
        const text = synth.generateFeedback({
          analyses: _reviewMeta.analyses || [],
          voice: _reviewMeta.voice || { formality: 'neutral' },
          random: Math.random,
        });
        ta.value = text;
        setReviewStatus('Regenerated', 'success');
      });
    }
    if (copy) {
      copy.addEventListener('click', function () {
        const current = ta.value || '';
        if (!current) { setReviewStatus('Nothing to copy.', 'error'); return; }
        (navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(current)
          : Promise.reject(new Error('clipboard API unavailable'))
        ).then(function () { setReviewStatus('Copied to clipboard', 'success'); })
         .catch(function (e) { setReviewStatus('Copy failed: ' + (e && e.message || 'unknown'), 'error'); });
      });
    }
    if (save) {
      save.addEventListener('click', function () {
        const current = ta.value || '';
        const vp = window.ClipboardCleaner && window.ClipboardCleaner.voiceProfile;
        if (!current.trim()) { setReviewStatus('Draft is empty.', 'error'); return; }
        if (!vp || !vp.createProfile) { setReviewStatus('Voice profile unavailable.', 'error'); return; }
        const storage = vp.chromeStorageOrNull();
        if (!storage) { setReviewStatus('Storage unavailable.', 'error'); return; }
        const profile = vp.createProfile(storage);
        profile.recordDraft(current, function () { setReviewStatus('Saved to voice profile', 'success'); });
      });
    }
  }

  function setReviewDraft(text, meta) {
    if (!mounted) mount();
    _reviewMeta = meta || null;
    const empty   = shadow.querySelector('[data-role="review-empty"]');
    const prev    = shadow.querySelector('[data-role="review-submission-preview"]');
    const ta      = shadow.querySelector('[data-role="review-draft"]');
    const actions = shadow.querySelector('[data-role="review-actions"]');
    if (empty) empty.hidden = true;
    if (prev) {
      prev.hidden = false;
      const src = (meta && meta.submissionText) || '';
      prev.textContent = src.length > 400 ? src.slice(0, 400) + '…' : src;
    }
    if (ta) { ta.hidden = false; ta.value = text || ''; }
    if (actions) actions.hidden = false;
    setActiveTab('review');
    open();
    setReviewStatus('Draft ready — read, edit, then Copy.', 'success');
  }

  function getReviewDraft() {
    if (!shadow) return '';
    const ta = shadow.querySelector('[data-role="review-draft"]');
    return ta ? (ta.value || '') : '';
  }
```

Update the exported `api`:

```js
  const api = {
    mount: mount, open: open, close: close, toggle: toggle,
    setActiveTab: setActiveTab, showCopied: showCopied,
    setLectureDraft: setLectureDraft,  // present if Plan 1 was applied; keep
    setReviewDraft: setReviewDraft,
    getReviewDraft: getReviewDraft,
  };
```

> If Plan 1 (Video Lecture Companion) has NOT been applied, omit the `setLectureDraft` line — adding an undefined reference would throw at load time.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): add Peer Review tab with editable draft + copy + save-voice"
```

---

## Task 6: Peer review controller — page detection + emit

**Files:**
- Create: `lib/peer-review-controller.js`
- Test: `tests/peer-review-controller.test.js`

The controller:
- Exposes `createController({ document, window, scraper, analyzer, voiceProfile, synthesizer, onDraft, storage, debounceMs, random })`.
- `init()` mounts a MutationObserver on `document.body`. When both submission text AND ≥1 rubric criterion are detected, debounce, then:
  1. Scrape (`scraper.scrapeReviewPage`).
  2. Analyze (`analyzer.analyzeRubric`).
  3. Read voice (`voiceProfile.createProfile(storage).getVoice`).
  4. Synthesize (`synthesizer.generateFeedback`).
  5. Emit via `onDraft(text, { submissionText, analyses, voice })`.
- Re-emits only if the submission text has changed since the last emission (avoid noisy regenerations as Coursera mounts).

- [ ] **Step 1: Write the failing tests**

```js
// tests/peer-review-controller.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const scraper = require('../lib/submission-scraper.js');
const analyzer = require('../lib/rubric-analyzer.js');
const voiceProfile = require('../lib/voice-profile.js');
const synthesizer = require('../lib/feedback-synthesizer.js');
const { createController } = require('../lib/peer-review-controller.js');

function fakeStorage() {
  const store = {};
  return {
    get: function (k, cb) {
      const list = Array.isArray(k) ? k : [k];
      const out = {}; list.forEach(function (x) { out[x] = store[x]; }); cb(out);
    },
    set: function (items, cb) {
      Object.keys(items).forEach(function (x) { store[x] = items[x]; }); cb && cb();
    },
  };
}

function setupPage(html) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>');
  return dom;
}

test('emits a draft when submission + rubric are present', async () => {
  const dom = setupPage(
    '<div data-testid="submission-body">According to Smith (2020), gradient descent converges. ' +
      'However, critics argue that local minima remain a problem. ' +
      'Data from recent papers supports both views. ' +
      'In conclusion, the topic is more nuanced than it first appears.</div>' +
    '<section data-testid="rubric">' +
      '<div data-criterion-id="c1"><h3>Use of evidence</h3><label>Strong</label></div>' +
      '<div data-criterion-id="c2"><h3>Counter-arguments addressed</h3><label>Yes</label></div>' +
    '</section>'
  );
  const drafts = [];
  const ctrl = createController({
    document: dom.window.document,
    window: dom.window,
    scraper: scraper, analyzer: analyzer,
    voiceProfile: voiceProfile, synthesizer: synthesizer,
    storage: fakeStorage(),
    onDraft: function (text, meta) { drafts.push({ text: text, meta: meta }); },
    debounceMs: 0,
    random: function () { return 0.5; },
  });
  ctrl.init();
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].text.length > 0);
  assert.ok(drafts[0].meta.analyses.length === 2);
});

test('does not emit when only submission OR only rubric present', async () => {
  const dom = setupPage('<div data-testid="submission-body">Some text.</div>');
  const drafts = [];
  const ctrl = createController({
    document: dom.window.document, window: dom.window,
    scraper: scraper, analyzer: analyzer, voiceProfile: voiceProfile, synthesizer: synthesizer,
    storage: fakeStorage(),
    onDraft: function (t) { drafts.push(t); },
    debounceMs: 0, random: function () { return 0.5; },
  });
  ctrl.init();
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.equal(drafts.length, 0);
});

test('does not re-emit when submission text is unchanged', async () => {
  const html =
    '<div data-testid="submission-body">According to Smith (2020), data shows the effect persists.</div>' +
    '<section data-testid="rubric"><div data-criterion-id="c1"><h3>Use of evidence</h3><label>Strong</label></div></section>';
  const dom = setupPage(html);
  const drafts = [];
  const ctrl = createController({
    document: dom.window.document, window: dom.window,
    scraper: scraper, analyzer: analyzer, voiceProfile: voiceProfile, synthesizer: synthesizer,
    storage: fakeStorage(),
    onDraft: function (t) { drafts.push(t); },
    debounceMs: 0, random: function () { return 0.5; },
  });
  ctrl.init();
  await new Promise(function (r) { setTimeout(r, 10); });
  // Trigger an unrelated mutation
  dom.window.document.body.appendChild(dom.window.document.createElement('div'));
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.equal(drafts.length, 1);
});

test('re-emits when submission text changes', async () => {
  const html =
    '<div data-testid="submission-body" id="sub">First content with at least eighty words ' +
    Array(20).fill('extra').join(' ') + ' to clear the length floor easily.</div>' +
    '<section data-testid="rubric"><div data-criterion-id="c1"><h3>Use of evidence</h3><label>Strong</label></div></section>';
  const dom = setupPage(html);
  const drafts = [];
  const ctrl = createController({
    document: dom.window.document, window: dom.window,
    scraper: scraper, analyzer: analyzer, voiceProfile: voiceProfile, synthesizer: synthesizer,
    storage: fakeStorage(),
    onDraft: function (t) { drafts.push(t); },
    debounceMs: 0, random: function () { return 0.5; },
  });
  ctrl.init();
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.equal(drafts.length, 1);
  // Mutate submission text
  dom.window.document.getElementById('sub').textContent =
    'Completely different content here. ' +
    'According to Jones (2021), the gradient flows backwards. ' +
    Array(20).fill('words').join(' ') + ' to exceed the floor.';
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.equal(drafts.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="peer-review|peer review controller|emits a draft"`
Expected: FAIL with `Cannot find module '../lib/peer-review-controller.js'`.

- [ ] **Step 3: Write the controller**

```js
// lib/peer-review-controller.js
(function (root) {
  'use strict';

  function createController(opts) {
    opts = opts || {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const win = opts.window || (typeof window !== 'undefined' ? window : null);
    const scraper = opts.scraper;
    const analyzer = opts.analyzer;
    const voiceProfile = opts.voiceProfile;
    const synthesizer = opts.synthesizer;
    const storage = opts.storage;
    const onDraft = typeof opts.onDraft === 'function' ? opts.onDraft : function () {};
    const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 500;
    const random = typeof opts.random === 'function' ? opts.random : Math.random;

    let timer = null;
    let observer = null;
    let lastSubmissionText = null;

    function trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!doc || !scraper || !analyzer || !voiceProfile || !synthesizer || !storage) return;
        const page = scraper.scrapeReviewPage(doc);
        if (!page.submissionText || !page.rubricCriteria || page.rubricCriteria.length === 0) return;
        if (page.submissionText === lastSubmissionText) return;
        const analyses = analyzer.analyzeRubric(page.submissionText, page.rubricCriteria);
        const profile = voiceProfile.createProfile(storage);
        profile.getVoice(function (voice) {
          const text = synthesizer.generateFeedback({ analyses: analyses, voice: voice, random: random });
          if (!text) return;
          lastSubmissionText = page.submissionText;
          onDraft(text, { submissionText: page.submissionText, analyses: analyses, voice: voice });
        });
      }, debounceMs);
    }

    function init() {
      if (!doc || !win) return;
      trigger();
      if (!win.MutationObserver) return;
      observer = new win.MutationObserver(function () { trigger(); });
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    }

    function destroy() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (observer) { observer.disconnect(); observer = null; }
    }

    return { init: init, destroy: destroy, _trigger: trigger };
  }

  const api = { createController: createController };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.peerReviewController = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="peer-review|peer review controller|emits a draft"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/peer-review-controller.js tests/peer-review-controller.test.js
git commit -m "feat(peer-review): controller observes page and emits drafts on change"
```

---

## Task 7: Manifest + content.js wiring

**Files:**
- Modify: `manifest.json`
- Modify: `content.js`

- [ ] **Step 1: Append new scripts to `manifest.json`**

Inside `content_scripts[0].js`, insert the five new files BEFORE `sidebar.js` (preserve all existing entries). If Plan 1 has been applied, place them after the lecture entries:

```json
        "lib/submission-scraper.js",
        "lib/rubric-analyzer.js",
        "lib/voice-profile.js",
        "lib/feedback-synthesizer.js",
        "lib/peer-review-controller.js",
```

If you haven't already, ensure the top-level `permissions` array exists (added in Task 3, Step 5):

```json
  "permissions": ["storage"],
```

- [ ] **Step 2: Wire the controller in `content.js`**

Append inside the existing IIFE:

```js
  function startPeerReview() {
    const a = api();
    if (!a || !a.peerReviewController || typeof a.peerReviewController.createController !== 'function') return;
    if (!a.sidebar || typeof a.sidebar.setReviewDraft !== 'function') return;
    const storage = a.voiceProfile && a.voiceProfile.chromeStorageOrNull
      ? a.voiceProfile.chromeStorageOrNull() : null;
    if (!storage) return; // chrome.storage missing — skip silently
    const ctrl = a.peerReviewController.createController({
      document: document,
      window: window,
      scraper: a.submissionScraper,
      analyzer: a.rubricAnalyzer,
      voiceProfile: a.voiceProfile,
      synthesizer: a.feedbackSynthesizer,
      storage: storage,
      onDraft: function (text, meta) {
        try { a.sidebar.setReviewDraft(text, meta); } catch (_) { /* ignore */ }
      },
    });
    ctrl.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPeerReview, { once: true });
  } else {
    startPeerReview();
  }
```

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Smoke-load the extension**

Manually: reload the unpacked extension at `chrome://extensions`, open a Coursera **peer review** page where you have a submission to review, then open the sidebar → **Peer Review** tab. Confirm a draft appears within ~500 ms with one paragraph per rubric criterion. Edit a sentence, click **Save my edits to voice profile**, reload, open a different submission, confirm the new draft's opener reflects the saved style (`preferredOpeners` kicks in after ≥1 saved draft sharing a 3-word opener prefix). If no draft appears, the selectors may have shifted — inspect with DevTools and report; do NOT widen selectors blindly.

- [ ] **Step 5: Commit**

```bash
git add manifest.json content.js
git commit -m "chore(peer-review): wire controller in manifest + content.js"
```

---

## Self-Review

**Spec coverage:**
- "Trigger: user opens a peer's submission to review" → Task 6 MutationObserver fires `trigger` on every page change; emits only when both submission + rubric exist.
- "Analyzes submission against the grading rubric (strengths, weaknesses)" → Task 2 returns `{strengths, weaknesses, evidenceSnippets}` per criterion using heuristic signal libraries (evidence patterns, counter-argument markers, length, hedging).
- "Output in the Voice of the user (Casual / Formal / Technical)" → Voice has three buckets (`casual`, `neutral`, `formal`); Task 4's synthesizer applies `casualize`, `decontract` + `thirdPerson` accordingly. "Technical" maps to `formal` (concrete distinct templates) — if the user later wants a separate `technical` bucket, add a fourth branch in `applyVoice`.
- "Voice learned from past drafts" → Tasks 3 + 5 store user drafts (max 20 ring buffer) and derive voice features. The "Save my edits to voice profile" button is the explicit learning loop.
- "Draft State — text appears in a draft area, not the final submission box, forces user to read/edit/paste" → Task 5's textarea is in the extension sidebar (separate from Coursera's submission box). `Copy draft` puts it on the clipboard; the user must paste themselves. No code path writes to the real form.

**Placeholder scan:** No TBDs, no "add appropriate error handling", every step is runnable.

**Type consistency:**
- `scrapeReviewPage` → `{submissionText, rubricCriteria}` consumed identically in controller + tests.
- `analyzeRubric(submission, criteria)` → array of `{criterionId, prompt, strengths, weaknesses, evidenceSnippets}` — consumed unchanged by `generateFeedback` and the sidebar `_reviewMeta`.
- `createProfile(storage)` → `{recordDraft, getVoice, clear}` — same surface in tests + controller + sidebar Save button.
- `generateFeedback({analyses, voice, random})` — same arg shape in all callers.
- `setReviewDraft(text, meta)` and `getReviewDraft()` — signatures match `content.js`'s `onDraft` call.
