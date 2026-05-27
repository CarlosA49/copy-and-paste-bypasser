# Video Lecture Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Lecture Notes" sidebar tab that scrapes the Coursera video lecture transcript, generates topic-linked draft notes via local heuristics, and renders them with humanlike ghost-typed cadence (burstiness, hesitation, backspace), reusing the existing typing-engine. Strictly local — no network calls.

**Architecture:** Four new pure-logic modules in `lib/` follow the existing IIFE + `module.exports` + `window.ClipboardCleaner.<name>` pattern: a transcript scraper (DOM → ordered cues), a synthesizer (cues → ranked topics + draft prose with burstiness), a companion controller (video lifecycle → scrape → synth → emit), and a sidebar tab wiring (renders the draft using the existing TypingEngine ghost-typing into a textarea). Tests use `node:test` + jsdom, mirroring `tests/typing-engine.test.js` style.

**Tech Stack:** Vanilla JS (ES5/ES6 mix to match existing code), node:test, jsdom, Chrome Extension Manifest V3, Shadow DOM (sidebar). No new dependencies.

---

## File Structure

**Create:**
- `lib/transcript-scraper.js` — locates the Coursera video element + transcript container, returns `{ cues: [{ time, text }], lectureTitle, weekTitle, weekObjective }`.
- `lib/lecture-synthesizer.js` — pure functions: tokenization, keyword ranking (TF over the lecture, IDF-style downweight of common English words), topic clustering (group consecutive cues by shared keywords), and a prose generator that produces a "draft" string with burstiness (varied sentence length) and high-perplexity vocabulary swaps (synonym table).
- `lib/lecture-companion.js` — wires `transcript-scraper` + `lecture-synthesizer` + sidebar. Observes video element for `pause`/`ended`, debounces, triggers a draft.
- `tests/transcript-scraper.test.js`, `tests/lecture-synthesizer.test.js`, `tests/lecture-companion.test.js` — jsdom-based.

**Modify:**
- `lib/sidebar.js` — add "Lecture Notes" tab + panel HTML, wire a `setLectureDraft(text)` API that ghost-types into the draft textarea via the existing TypingEngine.
- `lib/sidebar.css` — add styles for the lecture panel (draft area, regenerate button, status).
- `manifest.json` — append the three new lib files to `content_scripts[0].js` in dependency order (scraper, synthesizer, companion before sidebar).
- `content.js` — on `DOMContentLoaded`, call `ClipboardCleaner.lectureCompanion.init()`.

---

## Task 1: Transcript scraper — Coursera DOM extraction

**Files:**
- Create: `lib/transcript-scraper.js`
- Test: `tests/transcript-scraper.test.js`

### Selectors (Coursera, as of 2026-05; tolerant fallbacks)

Transcript phrases sit in elements with classes containing `phrase`, `transcript-text`, or in `<div role="button">` cue rows inside a transcript container with `data-testid="transcript"` or class containing `rc-Transcript`. Lecture title is in an `<h1>` inside `.rc-VideoMiniPlayer` or `.rc-ItemHeader`. Week title is in the sidebar item with `aria-current="page"`'s ancestor week heading. The video element is the first `<video>` in the page.

The scraper MUST be tolerant: try selectors in order, return `null` for missing pieces rather than throwing.

- [ ] **Step 1: Write the failing test**

```js
// tests/transcript-scraper.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { scrapeTranscript, findVideoElement } = require('../lib/transcript-scraper.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('returns null cues when no transcript container present', () => {
  const d = dom('<div>no transcript</div>');
  const r = scrapeTranscript(d);
  assert.equal(r.cues, null);
});

test('extracts cues from data-testid transcript container', () => {
  const d = dom(
    '<div data-testid="transcript">' +
      '<div class="phrase" data-time="0">Welcome to gradient descent.</div>' +
      '<div class="phrase" data-time="4.2">It minimizes a loss function.</div>' +
    '</div>'
  );
  const r = scrapeTranscript(d);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text, 'Welcome to gradient descent.');
  assert.equal(r.cues[0].time, 0);
  assert.equal(r.cues[1].time, 4.2);
});

test('falls back to rc-Transcript class', () => {
  const d = dom(
    '<div class="rc-Transcript">' +
      '<span class="transcript-text">First sentence.</span>' +
      '<span class="transcript-text">Second sentence.</span>' +
    '</div>'
  );
  const r = scrapeTranscript(d);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text, 'First sentence.');
});

test('extracts lecture title from h1 inside rc-ItemHeader', () => {
  const d = dom(
    '<div class="rc-ItemHeader"><h1>Lesson 3.2: Backpropagation</h1></div>' +
    '<div data-testid="transcript"><div class="phrase">Body.</div></div>'
  );
  const r = scrapeTranscript(d);
  assert.equal(r.lectureTitle, 'Lesson 3.2: Backpropagation');
});

test('extracts week objective from current-page sidebar item', () => {
  const d = dom(
    '<nav><a aria-current="page" data-week-objective="Understand training dynamics">Lesson</a></nav>' +
    '<div data-testid="transcript"><div class="phrase">Body.</div></div>'
  );
  const r = scrapeTranscript(d);
  assert.equal(r.weekObjective, 'Understand training dynamics');
});

test('findVideoElement returns the first video', () => {
  const d = dom('<video src="x"></video><video src="y"></video>');
  assert.equal(findVideoElement(d).src.endsWith('x'), true);
});

test('findVideoElement returns null when no video', () => {
  const d = dom('<div>nope</div>');
  assert.equal(findVideoElement(d), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="transcript"`
Expected: FAIL with `Cannot find module '../lib/transcript-scraper.js'`.

- [ ] **Step 3: Write the scraper**

```js
// lib/transcript-scraper.js
(function (root) {
  'use strict';

  // Selectors tried in order. First non-empty match wins.
  const TRANSCRIPT_CONTAINER_SELECTORS = [
    '[data-testid="transcript"]',
    '.rc-Transcript',
    '[class*="Transcript"]',
  ];

  const CUE_SELECTORS = [
    '.phrase',
    '.transcript-text',
    '[class*="phrase"]',
    '[role="button"][data-time]',
  ];

  const LECTURE_TITLE_SELECTORS = [
    '.rc-ItemHeader h1',
    '.rc-VideoMiniPlayer h1',
    'h1[class*="LectureTitle"]',
    'h1',
  ];

  const WEEK_OBJECTIVE_SELECTORS = [
    '[aria-current="page"][data-week-objective]',
  ];

  const WEEK_TITLE_SELECTORS = [
    '[aria-current="page"] [class*="WeekTitle"]',
    'h2[class*="Week"]',
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

  function parseTime(raw) {
    if (raw == null) return null;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    // Optional "MM:SS" fallback
    const m = String(raw).match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0);
    return null;
  }

  function scrapeCues(doc) {
    const container = firstMatching(doc, TRANSCRIPT_CONTAINER_SELECTORS);
    if (!container) return null;
    const cueEls = allMatching(container, CUE_SELECTORS);
    if (cueEls.length === 0) return null;
    const cues = [];
    for (let i = 0; i < cueEls.length; i++) {
      const el = cueEls[i];
      const text = (el.textContent || '').trim();
      if (!text) continue;
      cues.push({
        time: parseTime(el.getAttribute('data-time')),
        text: text,
      });
    }
    return cues.length > 0 ? cues : null;
  }

  function scrapeText(doc, selectors, attr) {
    const el = firstMatching(doc, selectors);
    if (!el) return null;
    if (attr) {
      const v = el.getAttribute(attr);
      return v ? v.trim() : null;
    }
    const t = (el.textContent || '').trim();
    return t || null;
  }

  function scrapeTranscript(doc) {
    const cues = scrapeCues(doc);
    const lectureTitle = scrapeText(doc, LECTURE_TITLE_SELECTORS);
    const weekTitle = scrapeText(doc, WEEK_TITLE_SELECTORS);
    const weekObjective = scrapeText(doc, WEEK_OBJECTIVE_SELECTORS, 'data-week-objective');
    return {
      cues: cues,
      lectureTitle: lectureTitle,
      weekTitle: weekTitle,
      weekObjective: weekObjective,
    };
  }

  function findVideoElement(doc) {
    return doc.querySelector('video') || null;
  }

  const api = {
    scrapeTranscript: scrapeTranscript,
    findVideoElement: findVideoElement,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.transcriptScraper = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="transcript"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/transcript-scraper.js tests/transcript-scraper.test.js
git commit -m "feat(lecture): add tolerant transcript scraper for Coursera DOM"
```

---

## Task 2: Lecture synthesizer — keyword ranking + topic clustering

**Files:**
- Create: `lib/lecture-synthesizer.js`
- Test: `tests/lecture-synthesizer.test.js`

The synthesizer is **pure** (no DOM). Inputs: `{ cues, lectureTitle, weekObjective }`. Output (this task only): `{ keywords: string[], topics: [{ keywords: string[], cueIndexes: number[] }] }`.

Keyword ranking: lowercased token frequency, minus a stopword list, minus tokens shorter than 4 chars. Tokens are `[a-z]{4,}` runs.

Topic clustering: walk cues in order; a new topic starts when the top-3 keywords of the next cue share 0 keywords with the current topic's accumulated top-3.

- [ ] **Step 1: Write the failing test**

```js
// tests/lecture-synthesizer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankKeywords, clusterTopics } = require('../lib/lecture-synthesizer.js');

test('rankKeywords drops stopwords and short tokens', () => {
  const cues = [
    { text: 'The cats and the dog are friends.' },
    { text: 'The cats eat the food.' },
  ];
  const top = rankKeywords(cues, 5);
  assert.ok(top.indexOf('the') === -1, 'stopword "the" excluded');
  assert.ok(top.indexOf('cats') !== -1, '"cats" should appear');
  assert.ok(top.indexOf('and') === -1, 'short token "and" excluded');
});

test('rankKeywords orders by frequency', () => {
  const cues = [
    { text: 'gradient gradient gradient descent loss loss' },
  ];
  const top = rankKeywords(cues, 3);
  assert.equal(top[0], 'gradient');
  assert.equal(top[1], 'loss');
  assert.equal(top[2], 'descent');
});

test('clusterTopics groups consecutive cues sharing keywords', () => {
  const cues = [
    { text: 'gradient descent updates weights using the gradient.' },
    { text: 'the gradient flows backwards through the network weights.' },
    { text: 'softmax produces probabilities over classes.' },
    { text: 'softmax outputs sum to one across all classes.' },
  ];
  const topics = clusterTopics(cues);
  assert.equal(topics.length, 2);
  assert.deepEqual(topics[0].cueIndexes, [0, 1]);
  assert.deepEqual(topics[1].cueIndexes, [2, 3]);
  assert.ok(topics[0].keywords.indexOf('gradient') !== -1);
  assert.ok(topics[1].keywords.indexOf('softmax') !== -1);
});

test('clusterTopics returns single topic for one cue', () => {
  const topics = clusterTopics([{ text: 'only one cue here about something.' }]);
  assert.equal(topics.length, 1);
  assert.deepEqual(topics[0].cueIndexes, [0]);
});

test('clusterTopics handles empty input', () => {
  assert.deepEqual(clusterTopics([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="rankKeywords|clusterTopics"`
Expected: FAIL with `Cannot find module '../lib/lecture-synthesizer.js'`.

- [ ] **Step 3: Write the ranker + clusterer**

```js
// lib/lecture-synthesizer.js
(function (root) {
  'use strict';

  const STOPWORDS = new Set([
    'this','that','with','from','have','were','will','would','their','about','there',
    'they','them','then','than','what','when','where','which','while','your','yours',
    'into','onto','such','some','also','only','very','much','many','more','most','over',
    'just','here','been','being','these','those','because','through','before','after',
    'between','among','each','every','other','another','same','different','example',
    'because','since','though','although','still','again','really','actually','basically',
    'going','make','makes','made','take','takes','took','give','gives','says','said',
    'know','knows','knew','think','thinks','thought','look','looks','looked','want',
    'wants','wanted','need','needs','needed','use','uses','used','using','like','liked',
  ]);

  function tokenize(text) {
    if (!text) return [];
    return String(text).toLowerCase().match(/[a-z]{4,}/g) || [];
  }

  function rankKeywords(cues, limit) {
    const counts = new Map();
    for (let i = 0; i < cues.length; i++) {
      const toks = tokenize(cues[i].text);
      for (let j = 0; j < toks.length; j++) {
        const t = toks[j];
        if (STOPWORDS.has(t)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const arr = Array.from(counts.entries());
    arr.sort(function (a, b) {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    const max = (typeof limit === 'number' && limit > 0) ? limit : arr.length;
    return arr.slice(0, max).map(function (e) { return e[0]; });
  }

  function topKeywordsFor(cue, n) {
    const counts = new Map();
    const toks = tokenize(cue.text);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (STOPWORDS.has(t)) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    const arr = Array.from(counts.entries());
    arr.sort(function (a, b) { return b[1] - a[1]; });
    return arr.slice(0, n).map(function (e) { return e[0]; });
  }

  function shareKeyword(a, b) {
    for (let i = 0; i < a.length; i++) if (b.indexOf(a[i]) !== -1) return true;
    return false;
  }

  function clusterTopics(cues) {
    if (!cues || cues.length === 0) return [];
    const topics = [];
    let currentIdx = [0];
    let currentKw = topKeywordsFor(cues[0], 3);
    for (let i = 1; i < cues.length; i++) {
      const kw = topKeywordsFor(cues[i], 3);
      if (shareKeyword(kw, currentKw)) {
        currentIdx.push(i);
        for (let k = 0; k < kw.length; k++) {
          if (currentKw.indexOf(kw[k]) === -1) currentKw.push(kw[k]);
        }
      } else {
        topics.push({ keywords: currentKw.slice(0, 5), cueIndexes: currentIdx });
        currentIdx = [i];
        currentKw = kw;
      }
    }
    topics.push({ keywords: currentKw.slice(0, 5), cueIndexes: currentIdx });
    return topics;
  }

  const api = {
    tokenize: tokenize,
    rankKeywords: rankKeywords,
    clusterTopics: clusterTopics,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.lectureSynthesizer = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="rankKeywords|clusterTopics"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/lecture-synthesizer.js tests/lecture-synthesizer.test.js
git commit -m "feat(lecture): add keyword ranking and topic clustering"
```

---

## Task 3: Synthesizer — draft prose with burstiness + perplexity

**Files:**
- Modify: `lib/lecture-synthesizer.js` (append `generateDraft`)
- Modify: `tests/lecture-synthesizer.test.js` (append draft tests)

`generateDraft({ cues, lectureTitle, weekObjective, random })` returns a string. The `random` parameter is an injected RNG (`() => [0,1)`); tests use a seeded RNG so output is deterministic.

Structure:
1. A heading line: `# <lectureTitle>` (omit if missing).
2. Optional one-liner: `_Tied to this week's goal — <weekObjective>._` (omit if missing).
3. One paragraph per topic. Within a paragraph:
   - One **short sentence** (≤8 words) summarizing the topic by its top keyword: e.g. `Gradient descent — the load-bearing idea.`
   - Two or three **medium/long sentences** (12–25 words) pulled from the topic's cues, joined with the RNG selecting connectors from a varied list (`Specifically,`, `In other words,`, `What this really means:`, `Worth pausing on:`).
   - One **perplexity swap**: replace at most one high-frequency content word per paragraph with a synonym from a small fixed table (e.g. `important` → `load-bearing`, `simple` → `unfussy`, `complex` → `tangled`, `useful` → `worth keeping`).
4. A final hedge line: one of `Still chewing on this.`, `Need to revisit — not fully solid yet.`, `Tagging this for the next review pass.` chosen via RNG.

Burstiness = the short/medium/long sentence mix per paragraph.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lecture-synthesizer.test.js`:

```js
const { generateDraft } = require('../lib/lecture-synthesizer.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('generateDraft includes lecture title heading when provided', () => {
  const draft = generateDraft({
    cues: [{ text: 'gradient descent updates weights.' }],
    lectureTitle: 'Lesson 1: Gradient Descent',
    weekObjective: null,
    random: seededRng(7),
  });
  assert.ok(draft.indexOf('# Lesson 1: Gradient Descent') === 0, 'starts with heading');
});

test('generateDraft links to week objective when provided', () => {
  const draft = generateDraft({
    cues: [{ text: 'gradient descent updates weights.' }],
    lectureTitle: 'L1',
    weekObjective: 'Train a neural network',
    random: seededRng(7),
  });
  assert.ok(draft.indexOf("Train a neural network") !== -1);
});

test('generateDraft produces one paragraph per topic', () => {
  const cues = [
    { text: 'gradient descent updates weights using the gradient.' },
    { text: 'the gradient flows backwards through the weights.' },
    { text: 'softmax produces probabilities over classes.' },
    { text: 'softmax outputs sum to one across the classes.' },
  ];
  const draft = generateDraft({ cues: cues, lectureTitle: null, weekObjective: null, random: seededRng(3) });
  const paras = draft.split(/\n\n+/).filter(function (p) { return p.trim() && p.indexOf('_') !== 0 && p.indexOf('#') !== 0; });
  // 2 topic paragraphs + hedge line is its own paragraph
  assert.ok(paras.length >= 2, 'at least two topic paragraphs');
});

test('generateDraft is deterministic for a given seed', () => {
  const cues = [{ text: 'gradient descent updates weights.' }];
  const a = generateDraft({ cues: cues, lectureTitle: 'L', weekObjective: null, random: seededRng(42) });
  const b = generateDraft({ cues: cues, lectureTitle: 'L', weekObjective: null, random: seededRng(42) });
  assert.equal(a, b);
});

test('generateDraft varies with seed (burstiness/perplexity)', () => {
  const cues = [
    { text: 'gradient descent updates weights through repeated steps.' },
    { text: 'gradient values flow backwards through the network.' },
  ];
  const a = generateDraft({ cues: cues, lectureTitle: 'L', weekObjective: null, random: seededRng(1) });
  const b = generateDraft({ cues: cues, lectureTitle: 'L', weekObjective: null, random: seededRng(999) });
  assert.notEqual(a, b);
});

test('generateDraft ends with a hedge line', () => {
  const cues = [{ text: 'gradient descent updates weights.' }];
  const draft = generateDraft({ cues: cues, lectureTitle: null, weekObjective: null, random: seededRng(11) });
  const HEDGES = ['Still chewing on this.', 'Need to revisit — not fully solid yet.', 'Tagging this for the next review pass.'];
  const trimmed = draft.trim();
  const ok = HEDGES.some(function (h) { return trimmed.endsWith(h); });
  assert.ok(ok, 'ends with a known hedge line — got: ' + JSON.stringify(trimmed.slice(-80)));
});

test('generateDraft returns empty string for no cues', () => {
  const draft = generateDraft({ cues: [], lectureTitle: 'L', weekObjective: null, random: seededRng(1) });
  assert.equal(draft, '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="generateDraft"`
Expected: FAIL with `generateDraft is not a function`.

- [ ] **Step 3: Append `generateDraft` to `lib/lecture-synthesizer.js`**

Insert these helpers and `generateDraft` BEFORE the `const api = { ... }` line, then add `generateDraft` to the exported `api`.

```js
  const CONNECTORS = [
    'Specifically,',
    'In other words,',
    'What this really means:',
    'Worth pausing on:',
    'Put another way,',
    'The catch:',
  ];

  const HEDGES = [
    'Still chewing on this.',
    'Need to revisit — not fully solid yet.',
    'Tagging this for the next review pass.',
  ];

  const SYNONYMS = {
    important: 'load-bearing',
    simple: 'unfussy',
    complex: 'tangled',
    useful: 'worth keeping',
    common: 'everyday',
    basic: 'starter',
    advanced: 'higher-order',
    final: 'last-mile',
  };

  function pick(arr, random) {
    return arr[Math.floor(random() * arr.length)];
  }

  function trimSentence(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function wordCount(s) {
    return (String(s).match(/\S+/g) || []).length;
  }

  function splitSentences(text) {
    return String(text).split(/(?<=[.!?])\s+/).map(trimSentence).filter(Boolean);
  }

  function shortSummaryFor(topic) {
    const k = (topic.keywords && topic.keywords[0]) || 'this';
    const cap = k.charAt(0).toUpperCase() + k.slice(1);
    return cap + ' — the load-bearing idea.';
  }

  function applyPerplexitySwap(sentence, random) {
    const words = sentence.split(/\b/);
    const swapKeys = Object.keys(SYNONYMS);
    for (let i = 0; i < words.length; i++) {
      const lower = words[i].toLowerCase();
      if (swapKeys.indexOf(lower) !== -1 && random() < 0.5) {
        const repl = SYNONYMS[lower];
        words[i] = (words[i][0] === words[i][0].toUpperCase())
          ? repl.charAt(0).toUpperCase() + repl.slice(1)
          : repl;
        break;
      }
    }
    return words.join('');
  }

  function paragraphFor(topic, cues, random) {
    const parts = [shortSummaryFor(topic)];
    const topicCues = topic.cueIndexes.map(function (i) { return cues[i]; });
    const sentences = [];
    for (let i = 0; i < topicCues.length; i++) {
      const s = splitSentences(topicCues[i].text);
      for (let j = 0; j < s.length; j++) sentences.push(s[j]);
    }
    const mediumOrLong = sentences.filter(function (s) {
      const w = wordCount(s);
      return w >= 6 && w <= 40;
    });
    const target = Math.min(3, Math.max(1, mediumOrLong.length));
    let perplexUsed = false;
    for (let i = 0; i < target; i++) {
      const base = mediumOrLong[i] || sentences[i] || '';
      if (!base) continue;
      const connector = (i === 0) ? '' : pick(CONNECTORS, random) + ' ';
      let body = base;
      if (!perplexUsed) {
        const swapped = applyPerplexitySwap(body, random);
        if (swapped !== body) { body = swapped; perplexUsed = true; }
      }
      parts.push(connector + body);
    }
    return parts.join(' ');
  }

  function generateDraft(opts) {
    opts = opts || {};
    const cues = opts.cues || [];
    if (cues.length === 0) return '';
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const topics = clusterTopics(cues);
    const out = [];
    if (opts.lectureTitle) out.push('# ' + opts.lectureTitle);
    if (opts.weekObjective) out.push("_Tied to this week's goal — " + opts.weekObjective + '._');
    for (let i = 0; i < topics.length; i++) {
      out.push(paragraphFor(topics[i], cues, random));
    }
    out.push(pick(HEDGES, random));
    return out.join('\n\n');
  }
```

Then update the export line:

```js
  const api = {
    tokenize: tokenize,
    rankKeywords: rankKeywords,
    clusterTopics: clusterTopics,
    generateDraft: generateDraft,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="generateDraft"`
Expected: PASS (7 tests). If the "ends with hedge" test fails because `applyPerplexitySwap` mutated the hedge, confirm `out.push(pick(HEDGES, random))` is the last entry and `applyPerplexitySwap` is only called inside `paragraphFor`. The hedge is appended raw.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: All tests pass — no regressions in pre-existing files.

- [ ] **Step 6: Commit**

```bash
git add lib/lecture-synthesizer.js tests/lecture-synthesizer.test.js
git commit -m "feat(lecture): generate draft prose with burstiness and perplexity swaps"
```

---

## Task 4: Lecture companion controller — video lifecycle wiring

**Files:**
- Create: `lib/lecture-companion.js`
- Test: `tests/lecture-companion.test.js`

The controller does:
- `init(doc)` — finds the video element; if none, sets up a MutationObserver to retry. Attaches `pause` and `ended` listeners.
- On `pause`/`ended`, debounces 400 ms, scrapes the transcript, calls `generateDraft`, emits via injected `onDraft(text)` callback.
- Skips emission if no cues were found (no transcript loaded yet).

Dependencies are injected so the test does not need to monkey-patch globals.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="companion"`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Write the companion**

```js
// lib/lecture-companion.js
(function (root) {
  'use strict';

  function getScraper(rootRef) {
    if (typeof require !== 'undefined') {
      try { return require('./transcript-scraper.js'); } catch (_) { /* browser */ }
    }
    const r = (rootRef && rootRef.ClipboardCleaner) || {};
    return r.transcriptScraper;
  }

  function getSynthesizer(rootRef) {
    if (typeof require !== 'undefined') {
      try { return require('./lecture-synthesizer.js'); } catch (_) { /* browser */ }
    }
    const r = (rootRef && rootRef.ClipboardCleaner) || {};
    return r.lectureSynthesizer;
  }

  function createCompanion(opts) {
    opts = opts || {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const onDraft = typeof opts.onDraft === 'function' ? opts.onDraft : function () {};
    const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 400;
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const scraper = opts.scraper || getScraper(typeof window !== 'undefined' ? window : null);
    const synth = opts.synthesizer || getSynthesizer(typeof window !== 'undefined' ? window : null);

    let timer = null;
    let attachedVideo = null;
    let observer = null;

    function trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!scraper || !synth) return;
        const t = scraper.scrapeTranscript(doc);
        if (!t || !t.cues || t.cues.length === 0) return;
        const draft = synth.generateDraft({
          cues: t.cues,
          lectureTitle: t.lectureTitle,
          weekObjective: t.weekObjective,
          random: random,
        });
        if (draft) onDraft(draft);
      }, debounceMs);
    }

    function attach(video) {
      if (!video || attachedVideo === video) return;
      attachedVideo = video;
      video.addEventListener('pause', trigger);
      video.addEventListener('ended', trigger);
    }

    function init() {
      if (!doc) return;
      const v = scraper && scraper.findVideoElement ? scraper.findVideoElement(doc) : doc.querySelector('video');
      if (v) { attach(v); return; }
      if (typeof doc.defaultView === 'undefined' || !doc.defaultView.MutationObserver) return;
      observer = new doc.defaultView.MutationObserver(function () {
        const v2 = scraper && scraper.findVideoElement ? scraper.findVideoElement(doc) : doc.querySelector('video');
        if (v2) {
          attach(v2);
          if (observer) { observer.disconnect(); observer = null; }
        }
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }

    function destroy() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (observer) { observer.disconnect(); observer = null; }
      if (attachedVideo) {
        attachedVideo.removeEventListener('pause', trigger);
        attachedVideo.removeEventListener('ended', trigger);
        attachedVideo = null;
      }
    }

    return { init: init, destroy: destroy, _trigger: trigger };
  }

  const api = { createCompanion: createCompanion };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.lectureCompanion = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="companion"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/lecture-companion.js tests/lecture-companion.test.js
git commit -m "feat(lecture): add companion controller for pause/ended trigger"
```

---

## Task 5: Sidebar — "Lecture Notes" tab + ghost-type the draft

**Files:**
- Modify: `lib/sidebar.js`
- Modify: `lib/sidebar.css`

Add a third-and-a-half tab (it becomes the fourth tab — sidebar tabs scroll horizontally already, see existing CSS line 113). Tab name: `Lecture Notes`. Panel: a textarea (`data-role="lecture-draft"`), a `Regenerate` ghost button, and a status line.

The sidebar exposes a new API `setLectureDraft(text)`:
1. Switches the active tab to `lecture`.
2. Opens the panel.
3. Clears the textarea.
4. Uses the existing `TypingEngine` (via `window.ClipboardCleaner.typingEngine.TypingEngine`) to ghost-type `text` into the textarea — `Balanced Natural` profile, `Normal` speed, typos OFF (we want hesitation + sentence pauses, not corrections).
5. Sets status to `Typing draft…`, then `Draft ready` on completion.

No confirmation modal — typing into the in-extension textarea (not the page) doesn't need user gating.

- [ ] **Step 1: Add tab + panel HTML in `lib/sidebar.js`**

Edit the `HTML` constant. In the tabs row (after the `Answering for you` tab button), insert:

```html
'<button class="ccp-tab" role="tab" aria-selected="false" data-tab="lecture">Lecture Notes</button>' +
```

After the `answer` panel `</section>`, insert a new `lecture` panel:

```html
'<section class="ccp-panel" data-panel="lecture" data-active="false">' +
  '<div class="ccp-empty" data-role="lecture-empty"><strong>No draft yet</strong><span>Pause or finish a Coursera video lecture — a draft summary will appear here.</span></div>' +
  '<textarea class="ccp-textarea" data-role="lecture-draft" placeholder="Draft will be typed here when the lecture pauses…" hidden></textarea>' +
  '<div class="ccp-actions" data-role="lecture-actions" hidden>' +
    '<button class="ccp-btn" data-action="lecture-regenerate">Regenerate</button>' +
    '<button class="ccp-btn" data-variant="ghost" data-action="lecture-stop">Stop typing</button>' +
  '</div>' +
  '<div class="ccp-status" data-role="lecture-status"></div>' +
'</section>' +
```

- [ ] **Step 2: Wire the lecture tab in `lib/sidebar.js`**

Inside the `mount()` function, after `wireAnswer();`, add `wireLecture();`. Then define `wireLecture` and add `setLectureDraft` to the API:

```js
  let _lectureEngine = null;
  let _lectureLastSource = null; // remember last draft input to support Regenerate

  function setLectureStatus(text, tone) {
    const s = shadow.querySelector('[data-role="lecture-status"]');
    if (!s) return;
    s.textContent = text || '';
    if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
  }

  function wireLecture() {
    const regen = shadow.querySelector('[data-action="lecture-regenerate"]');
    const stopBtn = shadow.querySelector('[data-action="lecture-stop"]');
    if (regen) {
      regen.addEventListener('click', function () {
        if (_lectureLastSource) setLectureDraft(_lectureLastSource);
      });
    }
    if (stopBtn) {
      stopBtn.addEventListener('click', function () {
        if (_lectureEngine) _lectureEngine.stop();
        setLectureStatus('Stopped');
      });
    }
  }

  function setLectureDraft(text) {
    if (!mounted) mount();
    if (typeof text !== 'string' || text.length === 0) return;
    _lectureLastSource = text;
    const empty = shadow.querySelector('[data-role="lecture-empty"]');
    const ta = shadow.querySelector('[data-role="lecture-draft"]');
    const actions = shadow.querySelector('[data-role="lecture-actions"]');
    if (empty) empty.hidden = true;
    if (ta) { ta.hidden = false; ta.value = ''; }
    if (actions) actions.hidden = false;
    setActiveTab('lecture');
    open();

    const tApi = (window.ClipboardCleaner && window.ClipboardCleaner.typingEngine) || null;
    const inj  = (window.ClipboardCleaner && window.ClipboardCleaner.typingInjector) || null;
    if (!tApi || !inj || !ta) {
      // Fallback: dump the text in if the typing engine isn't loaded.
      if (ta) ta.value = text;
      setLectureStatus('Draft ready', 'success');
      return;
    }
    if (_lectureEngine) { try { _lectureEngine.stop(); } catch (_) {} }
    _lectureEngine = new tApi.TypingEngine();
    setLectureStatus('Typing draft…');
    _lectureEngine.start({
      text: text,
      target: ta,
      profile: 'Balanced Natural',
      speed: 'Normal',
      simulateTypos: false,
      onTick: function (ev) { inj.insertOrBackspace(ta, ev); },
      onDone: function () { setLectureStatus('Draft ready', 'success'); },
    });
  }
```

Finally, expose `setLectureDraft` in the public API and pass it through both export paths:

```js
  const api = {
    mount: mount, open: open, close: close, toggle: toggle,
    setActiveTab: setActiveTab, showCopied: showCopied,
    setLectureDraft: setLectureDraft,
  };
```

- [ ] **Step 3: Run all tests to confirm no regressions**

Run: `npm test`
Expected: All tests pass. (Sidebar has no dedicated test file; behavior change is additive.)

- [ ] **Step 4: Commit**

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): add Lecture Notes tab with ghost-typed draft"
```

---

## Task 6: Manifest + content.js wiring

**Files:**
- Modify: `manifest.json`
- Modify: `content.js`

- [ ] **Step 1: Update manifest to include new scripts in dependency order**

Edit `manifest.json` — replace the `js` array in `content_scripts[0]` with this exact array (adds three entries after `sidebar.js`; companion must come **after** sidebar because content.js will call into both):

```json
      "js": [
        "lib/cleaner.js",
        "lib/math-flatten.js",
        "lib/html-cleaner.js",
        "lib/typing-engine.js",
        "lib/typing-injector.js",
        "lib/value-normalize.js",
        "lib/answer-parser.js",
        "lib/answer-matcher.js",
        "lib/math-normalize.js",
        "lib/numbered-parser.js",
        "lib/question-detector.js",
        "lib/answer-applier.js",
        "lib/transcript-scraper.js",
        "lib/lecture-synthesizer.js",
        "lib/lecture-companion.js",
        "lib/sidebar.js",
        "content.js"
      ],
```

- [ ] **Step 2: Wire companion init in `content.js`**

Append inside the existing IIFE, after `mountSidebarWhenReady` is defined and the readyState block:

```js
  function startLectureCompanion() {
    const a = api();
    if (!a || !a.lectureCompanion || typeof a.lectureCompanion.createCompanion !== 'function') return;
    if (!a.sidebar || typeof a.sidebar.setLectureDraft !== 'function') return;
    const companion = a.lectureCompanion.createCompanion({
      document: document,
      onDraft: function (text) {
        try { a.sidebar.setLectureDraft(text); } catch (_) { /* ignore UI error */ }
      },
    });
    companion.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startLectureCompanion, { once: true });
  } else {
    startLectureCompanion();
  }
```

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Smoke-load the extension**

Manually: open `chrome://extensions`, reload the unpacked extension, then open a Coursera video lecture page. Open DevTools → Console. Confirm no errors from the new files. Play the video briefly, pause it, open the sidebar → `Lecture Notes` tab. Confirm a draft begins ghost-typing within ~400 ms of pause. (If no draft appears, transcript selectors may have shifted — check the scraper fallbacks first; do NOT widen them blindly. Report any selector miss as a follow-up.)

- [ ] **Step 5: Commit**

```bash
git add manifest.json content.js
git commit -m "chore(lecture): wire companion in manifest + content.js"
```

---

## Self-Review

**Spec coverage:**
- "Trigger: user opens a video lecture" → Task 4 attaches listeners to the video element (mounted or later-inserted).
- "Active listener processing the transcript" → Task 1 scrapes cues from the DOM.
- "Topic-Linked Notes connected to the week's learning objective" → Task 3 emits `# title` + `_Tied to this week's goal — <objective>._` + topic-clustered paragraphs.
- "Ghost Mode Logic (visual): typing pause/backspace mimicking a student" → Task 5 reuses TypingEngine (`Balanced Natural` already emits hesitation + sentence pauses; typos OFF avoids correction churn but the engine still produces natural cadence).
- "Draft Summary in side panel, burstiness + high perplexity" → Task 3 mixes short/medium/long sentences and applies one synonym-table swap per paragraph.

**Placeholder scan:** No TBDs, no "add appropriate error handling", every step has runnable code or commands.

**Type consistency:** `scrapeTranscript` returns `{cues, lectureTitle, weekTitle, weekObjective}` everywhere it is consumed; `generateDraft` takes `{cues, lectureTitle, weekObjective, random}` everywhere it is consumed; `createCompanion` returns `{init, destroy}` everywhere it is consumed. `setLectureDraft` signature matches the call in `content.js`.
