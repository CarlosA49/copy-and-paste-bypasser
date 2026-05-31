# Adaptive Coursera DOM Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `lib/coursera-dom.js` — a pure, jsdom-testable DOM-reading layer exposing the spec-frozen `window.ClipboardCleaner.courseraDom` API (12 methods) — and route `module-scraper`, `page-fallback`, `completion-confirmer`, `question-detector`, `answer-matcher`, `ai-question-context`, and `module-autopilot` through it so the autopilot stops dropping `ungradedWidget`/unknown-segment lessons, reads completion from the `accessibleName` status token + nav progressbar instead of brittle whole-string English regexes, navigates by stable `href` + locale-tolerant "Go to next item", recognizes external LTI launch pages, and hard-excludes the extension's own sidebar UI and the Boost support chat from every scan/fill/submit.

**Architecture:** `coursera-dom.js` is loaded early as a leaf IIFE module (no static `require` of sibling lib modules) that parses the proven Coursera URL grammar `/learn/{slug}/{kind}/{id}/{itemSlug}` and the `accessibleName` grammar `"Kind, Title, Status[, lock reason], Duration"`, plus role/region locators and an `isExcludedNode` exclusion predicate. Existing modules delegate kind/id/completion/exclusion/navigation to it via a defensive cross-env loader (the same `(typeof module !== 'undefined' && module.exports) ? require(...) : root.ClipboardCleaner.*` pattern already used by `question-detector`/`answer-matcher`), preserving every existing `module.exports` API surface and the 1253 passing tests. Phase A changes scope/exclusion + kind/id/completion + navigation + fixtures only — all current assessment-blocking behavior stays byte-for-byte unchanged (un-blocking and AI wiring are Phase C, out of scope here).

**Tech Stack:** Chrome MV3 content scripts; IIFE modules registered on `window.ClipboardCleaner.*` with a `module.exports` tail for Node; `node --test` (`node:test` + `node:assert/strict`) as the runner; `jsdom` ^29 for DOM fixtures. Repo test command: `npm test` (= `node --test`), or target one file with `node --test "tests/<file>.test.js"`.

---

## File Structure

| File | Create / Modify | Responsibility |
|---|---|---|
| `lib/coursera-dom.js` | **Create** | The new leaf module. Owns the spec-frozen `courseraDom` API: `parseLearnUrl`, `classifyKind(urlOrSegment, accessibleName?)`, `parseItemAccessibleName`, `itemStatus`, `isExcludedNode`, `assessmentRoot`, `withinAssessment`, `findOutlineNav`, `findModuleRegions`, `findItemLinks`, `findNextItemButton`, `isExternalLaunchPage`. Internal `KIND_BY_SEGMENT` (extends scraper's; adds `ungradedWidget->'plugin'`, `home`, `quiz`, `exam`, `peer`, `assignment`, `programming`, `gradedLti`; unknown `-> 'other'` keeping id). Status vocabulary set. Exclusion selectors. No static `require` of sibling lib modules. |
| `tests/coursera-dom.test.js` | **Create** | jsdom unit tests for every `courseraDom` export, plus real-DOM-fixture-derived cross-course ground-truth assertions (inline HTML strings hand-derived from `Study the files/dom-extraction-ex_mpqxgj5l_aneblp.json`). |
| `lib/module-scraper.js` | **Modify** (`KIND_BY_SEGMENT` L46-56; `extractItemId` L87-93; export object L665-682) | Add `ungradedWidget -> 'plugin'`; make `extractItemId` KEEP the id for unmapped segments (no longer `null`); add `findModuleRegions`-style `role=region`+`aria-expanded` discovery used by expand-all. Delegates kind/id to `courseraDom` where safe while preserving `module-scraper.classifyKind(url)` and every existing export name. |
| `tests/module-scraper.test.js` | **Modify** (append tests at end) | Fixture-based cases derived from the extraction: `ungradedWidget` item stays in queue; `Graded App Item` vs `Graded Assignment` rows; per-row completion. Uses the file's existing inline `dom()` helper. |
| `lib/page-fallback.js` | **Modify** (`MARK_COMPLETE_RE` L11; `NEXT_ITEM_RE` L12; `findGoToNextItemButton` L31-38; export L98-105) | Replace whole-string English regex matching for "Go to next item" with substring/aria-first matching delegated to `courseraDom.findNextItemButton`, with a literal-regex fallback. Preserve all existing export names. |
| `lib/completion-confirmer.js` | **Modify** (`waitForCompletion` opts/loop L27-78) | Add an `accessibleName`-status completion evidence path (`'accessible-status'`) and a nav-progressbar path (`'nav-progressbar'`) via an injected `courseraDom`, keeping `createConfirmer`/`waitForCompletion` signatures and the existing evidence tokens intact. |
| `lib/question-detector.js` | **Modify** (cross-env loader L9-14; `collectContainers` L56-91; export L181-187) | Apply `courseraDom.isExcludedNode` to skip excluded containers before classification, without breaking the `detectQuestions` contract. |
| `lib/answer-matcher.js` | **Modify** (`findNativeGroups` L49-81; `findAriaGroups` L83-128; `findTextInputs` L182-205) | Apply `courseraDom.isExcludedNode` in `findOptionGroups`/`findTextInputs` so extension-UI radios/checkboxes/textareas and Boost-chat controls are never matched. Preserve `findOptionGroups`/`findTextInputs` export names. |
| `lib/ai-question-context.js` | **Modify** (`findCurrentActivityEvidenceRoot` isUnderExcluded L28-45; `_visibleBlockedReason` isUnderExcluded L88-102) | Add `courseraDom.isExcludedNode` to the existing `isUnderExcluded` walks so `#ccp-host-root` / `.ccp-host` / Boost-chat nodes are excluded by the shared predicate, without changing the `eligible:true` snapshot contract or `localGuard`. |
| `lib/module-autopilot.js` | **Modify** (default `navigate` L211-229; `navigateUrlChangeTimeoutMs` default L231; `navigateAndConfirm` L520-556) | Widen the default `navigateUrlChangeTimeoutMs` 100 -> 800; confirm a URL change by parsing `courseraDom.parseLearnUrl(currentUrl()).id` against the target item id (an interstitial/different-id change is not accepted off the bare URL change; unparseable URLs fall through to today's accept-any-change); let `navigateAndConfirm` fall back to clicking `courseraDom.findNextItemButton(doc)` when no row anchor matches; recognize `courseraDom.isExternalLaunchPage(doc,url)` so an LTI launch page is reported as navigated. Keep `createAutopilot` injection surface and all current blocking behavior. |
| `manifest.json` | **Modify** (`content_scripts[0].js` L26-60) | Insert `"lib/coursera-dom.js"` EARLY — immediately before `lib/answer-matcher.js` (L34) — so `window.ClipboardCleaner.courseraDom` exists before any consumer IIFE runs. |

**Load-order note:** `coursera-dom.js` is a leaf (no sibling `require` at load time), so the only hard requirement is that it appears before `answer-matcher.js`, `module-scraper.js`, `page-fallback.js`, `question-detector.js`, `ai-question-context.js`, `completion-confirmer.js`, and `module-autopilot.js` in the manifest `js[]` list. Inserting it right before `answer-matcher.js` (the earliest consumer at L34) satisfies all of them.

---

### Task 1: Create `lib/coursera-dom.js` with the URL-grammar parsers (`parseLearnUrl`, `classifyKind`)

**Files:**
- Create: `lib/coursera-dom.js`
- Test: `tests/coursera-dom.test.js`

Steps:

1. - [ ] Write the failing test file `tests/coursera-dom.test.js` with the header and the first URL-grammar assertions. Create the file with exactly this content:

   ```js
   // tests/coursera-dom.test.js
   const test = require('node:test');
   const assert = require('node:assert/strict');
   const { JSDOM } = require('jsdom');
   const {
     parseLearnUrl,
     classifyKind,
   } = require('../lib/coursera-dom.js');

   function dom(html, url) {
     return new JSDOM(
       '<!doctype html><html><body>' + html + '</body></html>',
       { url: url || 'https://www.coursera.org/learn/matlab/home/week/1' }
     ).window.document;
   }

   test('parseLearnUrl decomposes the /learn/{slug}/{kind}/{id}/{itemSlug} grammar', () => {
     assert.deepEqual(
       parseLearnUrl('https://www.coursera.org/learn/matlab/lecture/abc123/intro'),
       { courseSlug: 'matlab', kind: 'lecture', id: 'abc123', itemSlug: 'intro' }
     );
     assert.deepEqual(
       parseLearnUrl('https://www.coursera.org/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments'),
       { courseSlug: 'matlab', kind: 'ungradedWidget', id: '8h1hv', itemSlug: 'completing-matlab-programming-assignments' }
     );
     assert.deepEqual(
       parseLearnUrl('https://www.coursera.org/learn/matlab/gradedLti/0OaH5/assignment-echo-generator'),
       { courseSlug: 'matlab', kind: 'gradedLti', id: '0OaH5', itemSlug: 'assignment-echo-generator' }
     );
   });

   test('parseLearnUrl tolerates a missing itemSlug and query/hash', () => {
     assert.deepEqual(
       parseLearnUrl('/learn/x/quiz/q1'),
       { courseSlug: 'x', kind: 'quiz', id: 'q1', itemSlug: null }
     );
     assert.deepEqual(
       parseLearnUrl('/learn/x/exam/e9?foo=1#frag'),
       { courseSlug: 'x', kind: 'exam', id: 'e9', itemSlug: null }
     );
   });

   test('parseLearnUrl returns null for non-learn URLs', () => {
     assert.equal(parseLearnUrl('https://www.coursera.org/about'), null);
     assert.equal(parseLearnUrl(''), null);
     assert.equal(parseLearnUrl(null), null);
   });

   test('classifyKind maps known URL segments and keeps unknown as other', () => {
     assert.equal(classifyKind('/learn/x/lecture/abc/x'), 'video');
     assert.equal(classifyKind('/learn/x/supplement/abc/x'), 'reading');
     assert.equal(classifyKind('/learn/x/discussionPrompt/abc/x'), 'discussion');
     assert.equal(classifyKind('/learn/x/ungradedWidget/abc/x'), 'plugin');
     assert.equal(classifyKind('/learn/x/quiz/abc'), 'quiz');
     assert.equal(classifyKind('/learn/x/exam/abc'), 'exam');
     assert.equal(classifyKind('/learn/x/peer/abc'), 'peer');
     assert.equal(classifyKind('/learn/x/assignment/abc'), 'assignment');
     assert.equal(classifyKind('/learn/x/programming/abc'), 'programming');
     assert.equal(classifyKind('/learn/x/gradedLti/abc'), 'gradedLti');
     assert.equal(classifyKind('/learn/x/home/week/1'), 'home');
     assert.equal(classifyKind('/learn/x/brandNewSegment/abc'), 'other');
   });

   test('classifyKind accepts a bare segment token', () => {
     assert.equal(classifyKind('lecture'), 'video');
     assert.equal(classifyKind('ungradedWidget'), 'plugin');
     assert.equal(classifyKind('mysteryKind'), 'other');
   });

   test('classifyKind cross-checks accessibleName when the URL is ambiguous', () => {
     // No usable URL segment, but an accessibleName naming an Ungraded Plugin.
     assert.equal(classifyKind('', 'Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min'), 'plugin');
     assert.equal(classifyKind('', 'Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min'), 'gradedLti');
     assert.equal(classifyKind('', 'Video, Scripts, Not submitted, 4 min'), 'video');
     assert.equal(classifyKind('', 'Reading, Syllabus, Completed, 10 min'), 'reading');
   });
   ```

2. - [ ] Run the test and watch it FAIL (module does not exist yet): `node --test "tests/coursera-dom.test.js"`. Expected: FAIL — `Cannot find module '../lib/coursera-dom.js'`.

3. - [ ] Create `lib/coursera-dom.js` with the IIFE skeleton, `KIND_BY_SEGMENT`, the accessibleName-kind token map, and the two parsers. Write the file with exactly this content:

   ```js
   // lib/coursera-dom.js
   // Pure, DOM-reading Coursera helpers (jsdom-testable). The spec-frozen public
   // API consumed by module-scraper, question-detector, answer-matcher,
   // ai-question-context, page-fallback, completion-confirmer, module-autopilot.
   // Leaf module: no static require of sibling lib modules (must load in both
   // node --test and the browser content-script context).
   (function (root) {
     'use strict';

     // URL grammar: /learn/{courseSlug}/{kind}/{id}/{itemSlug}
     // Extends module-scraper's KIND_BY_SEGMENT. Unknown segments map to 'other'
     // and KEEP their id (never null) so new/renamed segments stay in the queue.
     const KIND_BY_SEGMENT = {
       home: 'home',
       lecture: 'video',
       supplement: 'reading',
       discussionPrompt: 'discussion',
       ungradedWidget: 'plugin',
       quiz: 'quiz',
       exam: 'exam',
       peer: 'peer',
       assignment: 'assignment',
       programming: 'programming',
       gradedLti: 'gradedLti',
     };

     // accessibleName "Kind, ..." token -> kind. English default; locale-tolerant
     // callers can extend later. Longer/more specific tokens first.
     const KIND_BY_NAME_TOKEN = [
       { re: /\bungraded\s+plugin\b/i, kind: 'plugin' },
       { re: /\bgraded\s+app\s+item\b/i, kind: 'gradedLti' },
       { re: /\bapp\s+item\b/i, kind: 'gradedLti' },
       { re: /\bgraded\s+assignment\b/i, kind: 'assignment' },
       { re: /\bpeer\s+review\b/i, kind: 'peer' },
       { re: /\bprogramming\b/i, kind: 'programming' },
       { re: /\bdiscussion\s+prompt\b/i, kind: 'discussion' },
       { re: /\bexam\b/i, kind: 'exam' },
       { re: /\bpractice\s+quiz\b/i, kind: 'quiz' },
       { re: /\bquiz\b/i, kind: 'quiz' },
       { re: /\bvideo\b/i, kind: 'video' },
       { re: /\breading\b/i, kind: 'reading' },
     ];

     const LEARN_RE = /\/learn\/([^/?#]+)\/([a-zA-Z]+)\/([^/?#]+)(?:\/([^?#]+))?/;

     function parseLearnUrl(url) {
       if (!url) return null;
       const m = String(url).match(LEARN_RE);
       if (!m) return null;
       return {
         courseSlug: m[1],
         kind: m[2],
         id: m[3],
         itemSlug: (typeof m[4] === 'string' && m[4].length > 0) ? m[4] : null,
       };
     }

     function kindFromName(accessibleName) {
       if (!accessibleName) return null;
       const s = String(accessibleName);
       for (let i = 0; i < KIND_BY_NAME_TOKEN.length; i++) {
         if (KIND_BY_NAME_TOKEN[i].re.test(s)) return KIND_BY_NAME_TOKEN[i].kind;
       }
       return null;
     }

     function classifyKind(urlOrSegment, accessibleName) {
       const raw = String(urlOrSegment || '');
       let seg = null;
       const parsed = parseLearnUrl(raw);
       if (parsed) {
         seg = parsed.kind;
       } else if (/^[a-zA-Z]+$/.test(raw.trim())) {
         seg = raw.trim();
       }
       if (seg && Object.prototype.hasOwnProperty.call(KIND_BY_SEGMENT, seg)) {
         return KIND_BY_SEGMENT[seg];
       }
       // URL segment unknown/absent: cross-check the accessibleName.
       const byName = kindFromName(accessibleName);
       if (byName) return byName;
       return 'other';
     }

     const api = {
       parseLearnUrl: parseLearnUrl,
       classifyKind: classifyKind,
     };

     if (typeof module !== 'undefined' && module.exports) {
       module.exports = api;
     } else {
       root.ClipboardCleaner = root.ClipboardCleaner || {};
       root.ClipboardCleaner.courseraDom = api;
     }
   })(typeof self !== 'undefined' ? self : this);
   ```

4. - [ ] Run the test and watch it PASS: `node --test "tests/coursera-dom.test.js"`. Expected: PASS — all 6 tests green.

5. - [ ] Commit: `git add lib/coursera-dom.js tests/coursera-dom.test.js` then `git commit -m "feat(coursera-dom): parseLearnUrl + classifyKind with extended segment map and accessibleName cross-check"`.

---

### Task 2: Add the `accessibleName` parser (`parseItemAccessibleName`, `itemStatus`)

**Files:**
- Modify: `lib/coursera-dom.js` (insert before the `api` object created in Task 1)
- Test: `tests/coursera-dom.test.js` (append)

Steps:

1. - [ ] Append the failing tests to `tests/coursera-dom.test.js`. First extend the destructured import at the top of the file from:

   ```js
   const {
     parseLearnUrl,
     classifyKind,
   } = require('../lib/coursera-dom.js');
   ```

   to:

   ```js
   const {
     parseLearnUrl,
     classifyKind,
     parseItemAccessibleName,
     itemStatus,
   } = require('../lib/coursera-dom.js');
   ```

   Then append these tests at the end of the file:

   ```js
   test('parseItemAccessibleName parses the four-token grammar (no lock reason)', () => {
     assert.deepEqual(
       parseItemAccessibleName('Reading, Recommended Textbook, Completed, 10 min'),
       { kindToken: 'Reading', title: 'Recommended Textbook', status: 'completed', lockReason: null, durationText: '10 min' }
     );
     assert.deepEqual(
       parseItemAccessibleName('Video, Scripts, Not submitted, 4 min'),
       { kindToken: 'Video', title: 'Scripts', status: 'not-submitted', lockReason: null, durationText: '4 min' }
     );
     assert.deepEqual(
       parseItemAccessibleName('Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min'),
       { kindToken: 'Ungraded Plugin', title: 'Completing MATLAB Programming Assignments', status: 'not-submitted', lockReason: null, durationText: '15 min' }
     );
   });

   test('parseItemAccessibleName parses the five-token grammar with an optional lock reason', () => {
     assert.deepEqual(
       parseItemAccessibleName('Reading, Solution to valid_date, Locked, Complete previous item to unlock, 10 min'),
       { kindToken: 'Reading', title: 'Solution to valid_date', status: 'locked', lockReason: 'Complete previous item to unlock', durationText: '10 min' }
     );
   });

   test('parseItemAccessibleName keeps a title that itself contains a colon', () => {
     assert.deepEqual(
       parseItemAccessibleName('Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min'),
       { kindToken: 'Graded App Item', title: 'Assignment: MATLAB Calculation', status: 'not-submitted', lockReason: null, durationText: '15 min' }
     );
   });

   test('parseItemAccessibleName returns null for empty/garbage input', () => {
     assert.equal(parseItemAccessibleName(''), null);
     assert.equal(parseItemAccessibleName(null), null);
     assert.equal(parseItemAccessibleName('JustOneToken'), null);
   });

   test('itemStatus maps a status string to the canonical vocabulary', () => {
     assert.equal(itemStatus('Reading, Syllabus, Completed, 10 min'), 'completed');
     assert.equal(itemStatus('Video, Scripts, Not submitted, 4 min'), 'not-submitted');
     assert.equal(itemStatus('Reading, X, Locked, Complete previous item to unlock, 10 min'), 'locked');
     assert.equal(itemStatus('Something with no recognizable status'), 'unknown');
   });

   test('itemStatus reads an element accessible-name (aria-label) when given a node', () => {
     const d = dom('<a aria-label="Video, Introduction, Completed, 12 min" href="/learn/matlab/lecture/v1/intro">Intro</a>');
     const a = d.querySelector('a');
     assert.equal(itemStatus(a), 'completed');
   });
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/coursera-dom.test.js"`. Expected: FAIL — `parseItemAccessibleName is not a function`.

3. - [ ] Insert the parser into `lib/coursera-dom.js` immediately before the `const api = {` line. Add this code:

   ```js
     // Status vocabulary (English default, locale-tolerant set). Maps a raw token
     // to the canonical value. Order: longest/most-specific phrasing first.
     const STATUS_TOKENS = [
       { re: /\bnot\s+submitted\b/i, value: 'not-submitted' },
       { re: /\bnot\s+completed\b/i, value: 'not-submitted' },
       { re: /\blocked\b/i, value: 'locked' },
       { re: /\bcompleted\b/i, value: 'completed' },
     ];

     function statusFromToken(token) {
       if (!token) return 'unknown';
       const s = String(token);
       for (let i = 0; i < STATUS_TOKENS.length; i++) {
         if (STATUS_TOKENS[i].re.test(s)) return STATUS_TOKENS[i].value;
       }
       return 'unknown';
     }

     function looksLikeStatus(token) {
       return statusFromToken(token) !== 'unknown';
     }

     // accessibleName grammar: "Kind, Title[, ...], Status[, lock reason], Duration"
     // Tokenize on commas, then locate the status token. Everything between the
     // first token (kind) and the status token rejoins into the title (so a title
     // like "Assignment: MATLAB Calculation" survives). Anything between status
     // and the final duration token is the optional lock reason.
     function parseItemAccessibleName(name) {
       if (!name) return null;
       const parts = String(name).split(',').map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
       if (parts.length < 3) return null;
       let statusIdx = -1;
       for (let i = 1; i < parts.length; i++) {
         if (looksLikeStatus(parts[i])) { statusIdx = i; break; }
       }
       if (statusIdx === -1) return null;
       const kindToken = parts[0];
       const title = parts.slice(1, statusIdx).join(', ');
       const status = statusFromToken(parts[statusIdx]);
       const durationText = parts[parts.length - 1];
       let lockReason = null;
       // Tokens strictly between status and the trailing duration form the lock reason.
       if (parts.length - 1 > statusIdx + 1) {
         lockReason = parts.slice(statusIdx + 1, parts.length - 1).join(', ');
       }
       return {
         kindToken: kindToken,
         title: title,
         status: status,
         lockReason: lockReason,
         durationText: durationText,
       };
     }

     function nameOf(input) {
       if (input == null) return '';
       if (typeof input === 'string') return input;
       if (input.getAttribute) {
         return input.getAttribute('aria-label')
           || input.getAttribute('title')
           || (input.textContent || '');
       }
       return '';
     }

     function itemStatus(input) {
       const name = nameOf(input);
       const parsed = parseItemAccessibleName(name);
       if (parsed) return parsed.status;
       return statusFromToken(name);
     }
   ```

   Then extend the `api` object to add the two new exports:

   ```js
     const api = {
       parseLearnUrl: parseLearnUrl,
       classifyKind: classifyKind,
       parseItemAccessibleName: parseItemAccessibleName,
       itemStatus: itemStatus,
     };
   ```

4. - [ ] Run the test and watch it PASS: `node --test "tests/coursera-dom.test.js"`. Expected: PASS — all tests green (including the new 6).

5. - [ ] Commit: `git add lib/coursera-dom.js tests/coursera-dom.test.js` then `git commit -m "feat(coursera-dom): parseItemAccessibleName + itemStatus for the Kind,Title,Status[,lock],Duration grammar"`.

---

### Task 3: Add the exclusion + scope predicates (`isExcludedNode`, `assessmentRoot`, `withinAssessment`)

**Files:**
- Modify: `lib/coursera-dom.js` (insert before the `api` object)
- Test: `tests/coursera-dom.test.js` (append)

Steps:

1. - [ ] Append the failing tests. Extend the import at the top of `tests/coursera-dom.test.js` to add the three new names:

   ```js
   const {
     parseLearnUrl,
     classifyKind,
     parseItemAccessibleName,
     itemStatus,
     isExcludedNode,
     assessmentRoot,
     withinAssessment,
   } = require('../lib/coursera-dom.js');
   ```

   Then append these tests:

   ```js
   test('isExcludedNode excludes the extension sidebar host (#ccp-host-root) and its subtree', () => {
     const d = dom(
       '<div id="ccp-host-root"><div class="ccp-host">' +
         '<input name="ccp-behavior" type="radio">' +
         '<textarea placeholder="Paste or type text...">x</textarea>' +
       '</div></div>' +
       '<main><input type="radio" name="q1"></main>'
     );
     assert.equal(isExcludedNode(d.getElementById('ccp-host-root')), true);
     assert.equal(isExcludedNode(d.querySelector('input[name="ccp-behavior"]')), true);
     assert.equal(isExcludedNode(d.querySelector('textarea')), true);
     assert.equal(isExcludedNode(d.querySelector('main input[name="q1"]')), false);
   });

   test('isExcludedNode excludes a .ccp-host subtree even without the #ccp-host-root id (inlined shadow content)', () => {
     const d = dom('<div class="ccp-host"><button>Autopilot</button></div><main><button>Submit</button></main>');
     assert.equal(isExcludedNode(d.querySelector('.ccp-host button')), true);
     assert.equal(isExcludedNode(d.querySelector('main button')), false);
   });

   test('isExcludedNode excludes the Boost support chat composer and panel', () => {
     const d = dom(
       '<div id="boostai-chat-panel-composer">' +
         '<textarea placeholder="Ask your question here"></textarea>' +
         '<button>Send</button>' +
       '</div>' +
       '<div class="Boost-ChatPanel-foo"><button>X</button></div>' +
       '<button data-testid="coach-chat-launcher-button">Chat</button>' +
       '<main><button>Submit</button></main>'
     );
     assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer textarea')), true);
     assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer button')), true);
     assert.equal(isExcludedNode(d.querySelector('.Boost-ChatPanel-foo button')), true);
     assert.equal(isExcludedNode(d.querySelector('[data-testid="coach-chat-launcher-button"]')), true);
     assert.equal(isExcludedNode(d.querySelector('main button')), false);
   });

   test('isExcludedNode is safe on null and non-element input', () => {
     assert.equal(isExcludedNode(null), false);
     assert.equal(isExcludedNode(undefined), false);
   });

   test('assessmentRoot returns main when present and excludes nav/aside/extension/chat', () => {
     const d = dom(
       '<nav><a href="/learn/x/quiz/q1">Quiz</a></nav>' +
       '<div id="ccp-host-root"><input name="ccp-behavior" type="radio"></div>' +
       '<main id="real"><fieldset><input type="radio" name="q1"></fieldset></main>'
     );
     const r = assessmentRoot(d);
     assert.ok(r);
     assert.equal(r.id, 'real');
   });

   test('withinAssessment is true for a node inside the assessment root and false for excluded/nav nodes', () => {
     const d = dom(
       '<nav><button id="nav-btn">Nav</button></nav>' +
       '<div class="ccp-host"><button id="ext-btn">Ext</button></div>' +
       '<main><button id="ok-btn">Submit</button></main>'
     );
     assert.equal(withinAssessment(d.getElementById('ok-btn')), true);
     assert.equal(withinAssessment(d.getElementById('ext-btn')), false);
     assert.equal(withinAssessment(d.getElementById('nav-btn')), false);
   });
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/coursera-dom.test.js"`. Expected: FAIL — `isExcludedNode is not a function`.

3. - [ ] Insert the predicates into `lib/coursera-dom.js` immediately before the `const api = {` line. Add this code:

   ```js
     // Hard exclusions applied before any scan/fill/submit. Covers the extension's
     // own sidebar (live: a shadow host #ccp-host-root; jsdom fixtures: an inlined
     // .ccp-host subtree + name=ccp-behavior controls) and the Boost support chat.
     const EXCLUDE_SELECTORS = [
       '#ccp-host-root',
       '.ccp-host',
       'input[name="ccp-behavior"]',
       '#boostai-chat-panel-composer',
       '[class*="Boost-ChatPanel"]',
       '[data-testid="coach-chat-launcher-button"]',
     ];

     function matchesAny(el, selectors) {
       if (!el || typeof el.matches !== 'function') return false;
       for (let i = 0; i < selectors.length; i++) {
         try { if (el.matches(selectors[i])) return true; } catch (_) { /* invalid selector in env */ }
       }
       return false;
     }

     function isExcludedNode(el) {
       if (!el || el.nodeType !== 1) return false;
       let cur = el;
       while (cur && cur.nodeType === 1) {
         if (matchesAny(cur, EXCLUDE_SELECTORS)) return true;
         cur = cur.parentElement;
       }
       return false;
     }

     // The Coursera app content root: prefer <main> / [role="main"], else <body>,
     // skipping any candidate that is itself excluded (extension/chat/nav/aside).
     function isChromeContainer(el) {
       if (!el || !el.getAttribute) return false;
       const tag = (el.tagName || '').toUpperCase();
       if (tag === 'NAV' || tag === 'ASIDE') return true;
       const role = el.getAttribute('role');
       if (role === 'navigation' || role === 'complementary' || role === 'banner') return true;
       return false;
     }

     function underChrome(el, stopAt) {
       let cur = el;
       while (cur && cur.nodeType === 1 && cur !== stopAt) {
         if (isChromeContainer(cur)) return true;
         cur = cur.parentElement;
       }
       return false;
     }

     function assessmentRoot(doc) {
       if (!doc || typeof doc.querySelector !== 'function') return null;
       const body = doc.body || null;
       let candidates = [];
       try { candidates = candidates.concat(Array.prototype.slice.call(doc.querySelectorAll('main, [role="main"]'))); } catch (_) {}
       for (let i = 0; i < candidates.length; i++) {
         const c = candidates[i];
         if (!isExcludedNode(c) && !underChrome(c, body)) return c;
       }
       return body;
     }

     function withinAssessment(el) {
       if (!el || el.nodeType !== 1) return false;
       if (isExcludedNode(el)) return false;
       const doc = el.ownerDocument;
       const root = assessmentRoot(doc);
       if (!root) return false;
       if (root === el) return true;
       if (typeof root.contains === 'function' && !root.contains(el)) return false;
       // Even inside the root, reject nodes under a chrome container.
       return !underChrome(el, root);
     }
   ```

   Then extend the `api` object:

   ```js
     const api = {
       parseLearnUrl: parseLearnUrl,
       classifyKind: classifyKind,
       parseItemAccessibleName: parseItemAccessibleName,
       itemStatus: itemStatus,
       isExcludedNode: isExcludedNode,
       assessmentRoot: assessmentRoot,
       withinAssessment: withinAssessment,
     };
   ```

4. - [ ] Run the test and watch it PASS: `node --test "tests/coursera-dom.test.js"`. Expected: PASS — all tests green.

5. - [ ] Commit: `git add lib/coursera-dom.js tests/coursera-dom.test.js` then `git commit -m "feat(coursera-dom): isExcludedNode + assessmentRoot + withinAssessment scope/exclusion predicates"`.

---

### Task 4: Add the role/region locators (`findOutlineNav`, `findModuleRegions`, `findItemLinks`, `findNextItemButton`)

**Files:**
- Modify: `lib/coursera-dom.js` (insert before the `api` object)
- Test: `tests/coursera-dom.test.js` (append)

Steps:

1. - [ ] Append the failing tests. Extend the import at the top of `tests/coursera-dom.test.js` to add the four new names:

   ```js
   const {
     parseLearnUrl,
     classifyKind,
     parseItemAccessibleName,
     itemStatus,
     isExcludedNode,
     assessmentRoot,
     withinAssessment,
     findOutlineNav,
     findModuleRegions,
     findItemLinks,
     findNextItemButton,
   } = require('../lib/coursera-dom.js');
   ```

   Then append these tests:

   ```js
   // A small fixture that mirrors the captured outline shape: a role=navigation
   // landmark containing role=region modules, each with a level-3 role=heading
   // toggle button (clickable + expandable) and ul>li>div>a item links.
   function outlineFixture() {
     return dom(
       '<nav role="navigation" aria-label="Course Material">' +
         '<div role="region" aria-label="Module 1 Course Pages">' +
           '<div role="heading" aria-level="3"><button aria-expanded="true">Module 1 Course Pages</button></div>' +
           '<ul><li><div>' +
             '<a role="link" href="/learn/matlab/lecture/cp1/course-preview" aria-label="Video, Course Preview, Completed, 2 min">Course Preview</a>' +
           '</div></li>' +
           '<li><div>' +
             '<a role="link" href="/learn/matlab/supplement/syl/syllabus" aria-label="Reading, Syllabus, Completed, 10 min">Syllabus</a>' +
           '</div></li></ul>' +
         '</div>' +
         '<div role="region" aria-label="Module 2 The MATLAB Environment">' +
           '<div role="heading" aria-level="3"><button aria-expanded="false">Module 2 The MATLAB Environment</button></div>' +
           '<ul><li><div>' +
             '<a role="link" href="/learn/matlab/lecture/intro/introduction" aria-label="Video, Introduction, Completed, 12 min">Introduction</a>' +
           '</div></li></ul>' +
         '</div>' +
       '</nav>'
     );
   }

   test('findOutlineNav returns the role=navigation outline landmark', () => {
     const d = outlineFixture();
     const navEl = findOutlineNav(d);
     assert.ok(navEl);
     assert.equal(navEl.getAttribute('role'), 'navigation');
   });

   test('findModuleRegions returns one entry per role=region module with title/headingToggle/expanded', () => {
     const d = outlineFixture();
     const regions = findModuleRegions(d);
     assert.equal(regions.length, 2);
     assert.equal(regions[0].title, 'Module 1 Course Pages');
     assert.equal(regions[0].expanded, true);
     assert.ok(regions[0].headingToggle);
     assert.equal(regions[0].headingToggle.tagName.toUpperCase(), 'BUTTON');
     assert.equal(regions[1].title, 'Module 2 The MATLAB Environment');
     assert.equal(regions[1].expanded, false);
   });

   test('findItemLinks returns the ul>li>div>a item anchors of a region', () => {
     const d = outlineFixture();
     const regions = findModuleRegions(d);
     const links = findItemLinks(regions[0].region);
     assert.equal(links.length, 2);
     assert.equal(links[0].getAttribute('href'), '/learn/matlab/lecture/cp1/course-preview');
     assert.equal(links[1].getAttribute('href'), '/learn/matlab/supplement/syl/syllabus');
   });

   test('findItemLinks over the whole document collects all /learn/ anchors and skips excluded ones', () => {
     const d = dom(
       '<div id="ccp-host-root"><a href="/learn/matlab/lecture/x/sidebar-link">x</a></div>' +
       '<main><a href="/learn/matlab/lecture/v1/intro">Intro</a><a href="/learn/matlab/quiz/q1">Quiz</a></main>'
     );
     const links = findItemLinks(d);
     const hrefs = links.map(function (a) { return a.getAttribute('href'); });
     assert.deepEqual(hrefs, ['/learn/matlab/lecture/v1/intro', '/learn/matlab/quiz/q1']);
   });

   test('findNextItemButton finds a role=button "Go to next item" (locale-tolerant substring)', () => {
     const d = dom(
       '<main>' +
         '<button>Mark as completed</button>' +
         '<div role="button">Go to next item</div>' +
       '</main>'
     );
     const btn = findNextItemButton(d);
     assert.ok(btn);
     assert.equal(btn.getAttribute('role'), 'button');
   });

   test('findNextItemButton matches an aria-label and ignores excluded chat buttons', () => {
     const d = dom(
       '<div id="boostai-chat-panel-composer"><button aria-label="Next item">Send</button></div>' +
       '<main><button aria-label="Go to next item">→</button></main>'
     );
     const btn = findNextItemButton(d);
     assert.ok(btn);
     assert.equal(btn.getAttribute('aria-label'), 'Go to next item');
   });

   test('findNextItemButton returns null when there is no next-item control', () => {
     const d = dom('<main><button>Mark as completed</button></main>');
     assert.equal(findNextItemButton(d), null);
   });
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/coursera-dom.test.js"`. Expected: FAIL — `findOutlineNav is not a function`.

3. - [ ] Insert the locators into `lib/coursera-dom.js` immediately before the `const api = {` line. Add this code:

   ```js
     function normText(s) {
       return String(s || '').replace(/\s+/g, ' ').trim();
     }

     function accessibleNameOf(el) {
       if (!el || !el.getAttribute) return '';
       return normText(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
     }

     function findOutlineNav(doc) {
       if (!doc || typeof doc.querySelector !== 'function') return null;
       let navs = [];
       try { navs = Array.prototype.slice.call(doc.querySelectorAll('[role="navigation"], nav')); } catch (_) {}
       for (let i = 0; i < navs.length; i++) {
         if (isExcludedNode(navs[i])) continue;
         // Prefer a nav that actually contains course item links or module regions.
         if (navs[i].querySelector && (navs[i].querySelector('a[href*="/learn/"]') || navs[i].querySelector('[role="region"]'))) {
           return navs[i];
         }
       }
       return navs.length ? navs[0] : null;
     }

     // Each module is a role=region "Module N Title" with a role=heading level-3
     // toggle button (interactions: clickable + expandable). Returns one entry per
     // region with its title, the toggle button, and its expanded state.
     function findModuleRegions(doc) {
       const out = [];
       if (!doc || typeof doc.querySelectorAll !== 'function') return out;
       let regions = [];
       try { regions = Array.prototype.slice.call(doc.querySelectorAll('[role="region"]')); } catch (_) {}
       for (let i = 0; i < regions.length; i++) {
         const region = regions[i];
         if (isExcludedNode(region)) continue;
         let headingToggle = null;
         const heading = region.querySelector && region.querySelector('[role="heading"]');
         if (heading) headingToggle = heading.querySelector('button, [role="button"]') || heading;
         if (!headingToggle) headingToggle = region.querySelector && region.querySelector('button[aria-expanded], [role="button"][aria-expanded]');
         const title = (region.getAttribute && region.getAttribute('aria-label'))
           ? normText(region.getAttribute('aria-label'))
           : (headingToggle ? accessibleNameOf(headingToggle) : '');
         let expanded = false;
         const expSrc = (headingToggle && headingToggle.getAttribute && headingToggle.getAttribute('aria-expanded')) || (region.getAttribute && region.getAttribute('aria-expanded'));
         if (expSrc === 'true') expanded = true;
         out.push({ region: region, title: title, headingToggle: headingToggle, expanded: expanded });
       }
       return out;
     }

     function findItemLinks(regionOrDoc) {
       if (!regionOrDoc || typeof regionOrDoc.querySelectorAll !== 'function') return [];
       let anchors = [];
       try { anchors = Array.prototype.slice.call(regionOrDoc.querySelectorAll('a[href*="/learn/"]')); } catch (_) {}
       return anchors.filter(function (a) { return !isExcludedNode(a); });
     }

     // In-body progression control, e.g. role=button "Go to next item". Substring +
     // aria-first so localized labels still match. Excludes chat/extension nodes.
     const NEXT_ITEM_SUBSTR_RE = /(go\s+to\s+next\s+item|next\s+item)/i;

     function findNextItemButton(doc) {
       if (!doc || typeof doc.querySelectorAll !== 'function') return null;
       let els = [];
       try { els = Array.prototype.slice.call(doc.querySelectorAll('button, a, [role="button"]')); } catch (_) {}
       for (let i = 0; i < els.length; i++) {
         const el = els[i];
         if (isExcludedNode(el)) continue;
         const aria = el.getAttribute && el.getAttribute('aria-label');
         if (aria && NEXT_ITEM_SUBSTR_RE.test(aria)) return el;
         if (NEXT_ITEM_SUBSTR_RE.test(normText(el.textContent))) return el;
       }
       return null;
     }
   ```

   Then extend the `api` object:

   ```js
     const api = {
       parseLearnUrl: parseLearnUrl,
       classifyKind: classifyKind,
       parseItemAccessibleName: parseItemAccessibleName,
       itemStatus: itemStatus,
       isExcludedNode: isExcludedNode,
       assessmentRoot: assessmentRoot,
       withinAssessment: withinAssessment,
       findOutlineNav: findOutlineNav,
       findModuleRegions: findModuleRegions,
       findItemLinks: findItemLinks,
       findNextItemButton: findNextItemButton,
     };
   ```

4. - [ ] Run the test and watch it PASS: `node --test "tests/coursera-dom.test.js"`. Expected: PASS — all tests green.

5. - [ ] Commit: `git add lib/coursera-dom.js tests/coursera-dom.test.js` then `git commit -m "feat(coursera-dom): findOutlineNav + findModuleRegions + findItemLinks + findNextItemButton locators"`.

---

### Task 5: Add external-launch detection (`isExternalLaunchPage`) and the real-DOM fixture ground-truth test

**Files:**
- Modify: `lib/coursera-dom.js` (insert before the `api` object)
- Test: `tests/coursera-dom.test.js` (append)

Steps:

1. - [ ] Append the failing tests. Extend the import at the top of `tests/coursera-dom.test.js` to add the final name:

   ```js
   const {
     parseLearnUrl,
     classifyKind,
     parseItemAccessibleName,
     itemStatus,
     isExcludedNode,
     assessmentRoot,
     withinAssessment,
     findOutlineNav,
     findModuleRegions,
     findItemLinks,
     findNextItemButton,
     isExternalLaunchPage,
   } = require('../lib/coursera-dom.js');
   ```

   Then append these tests (the last two are the cross-course ground-truth cases hand-derived from `Study the files/dom-extraction-ex_mpqxgj5l_aneblp.json`):

   ```js
   test('isExternalLaunchPage is true for a gradedLti URL', () => {
     const d = dom('<main><p>Some content</p></main>');
     assert.equal(
       isExternalLaunchPage(d, 'https://www.coursera.org/learn/matlab/gradedLti/0OaH5/assignment-echo-generator'),
       true
     );
   });

   test('isExternalLaunchPage is true when a role=form "Launch App" is present (regardless of URL)', () => {
     const d = dom(
       '<main>' +
         '<input type="checkbox" id="agreement-checkbox-base">' +
         '<form role="form" aria-label="Launch App" action="https://learningtool.mathworks.com/lti/oidc" method="post">' +
           '<button>Launch app. Opens in new window</button>' +
         '</form>' +
       '</main>'
     );
     assert.equal(isExternalLaunchPage(d, 'https://www.coursera.org/learn/matlab/lecture/v1/intro'), true);
   });

   test('isExternalLaunchPage is false for an in-page answerable assessment with no launch form', () => {
     const d = dom('<main><fieldset><input type="radio" name="q1"><input type="radio" name="q1"></fieldset></main>');
     assert.equal(isExternalLaunchPage(d, 'https://www.coursera.org/learn/matlab/quiz/q1/check'), false);
   });

   test('GROUND TRUTH (extraction): the gradedLti launch page is recognized despite heuristicPageType="dashboard"', () => {
     // Derived from dom-extraction-ex_mpqxgj5l_aneblp.json:
     // source.url=/learn/matlab/gradedLti/0OaH5/assignment-echo-generator,
     // form F1 role=form accessibleName="Launch App" action=mathworks/lti/oidc,
     // heuristicPageType={type:"dashboard",confidence:"low"} (must NOT be relied on).
     const url = 'https://www.coursera.org/learn/matlab/gradedLti/0OaH5/assignment-echo-generator';
     const d = dom(
       '<main>' +
         '<h1>Assignment: Echo Generator</h1>' +
         '<input type="checkbox" id="agreement-checkbox-base">' +
         '<form role="form" aria-label="Launch App" action="https://learningtool.mathworks.com/lti/oidc" method="post">' +
           '<button>Launch app. Opens in new window</button>' +
         '</form>' +
       '</main>',
       url
     );
     assert.equal(isExternalLaunchPage(d, url), true);
     // And the URL classifies as gradedLti, not 'other'.
     assert.equal(classifyKind(url), 'gradedLti');
   });

   test('GROUND TRUTH (extraction): the ungradedWidget item parses, classifies as plugin, and keeps its id', () => {
     // Derived from accessibleName "Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min"
     // and href /learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments.
     const href = '/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments';
     const name = 'Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min';
     assert.deepEqual(parseLearnUrl(href), {
       courseSlug: 'matlab', kind: 'ungradedWidget', id: '8h1hv', itemSlug: 'completing-matlab-programming-assignments',
     });
     assert.equal(classifyKind(href, name), 'plugin');
     assert.equal(itemStatus(name), 'not-submitted');
     const parsed = parseItemAccessibleName(name);
     assert.equal(parsed.title, 'Completing MATLAB Programming Assignments');
     assert.equal(parsed.durationText, '15 min');
   });

   test('GROUND TRUTH (extraction): contamination nodes are excluded while real outline links are kept', () => {
     // The page DOM carries the extension sidebar (#ccp-host-root, name=ccp-behavior,
     // "Paste or type text..." textarea) and the Boost chat ("Ask your question here",
     // "Send", #boostai-chat-panel-composer). These must be hard-excluded.
     const d = dom(
       '<div id="ccp-host-root"><div class="ccp-host">' +
         '<input name="ccp-behavior" type="radio">' +
         '<textarea placeholder="Paste or type text..."></textarea>' +
       '</div></div>' +
       '<div id="boostai-chat-panel-composer"><textarea placeholder="Ask your question here"></textarea><button>Send</button></div>' +
       '<nav role="navigation" aria-label="Course Material">' +
         '<div role="region" aria-label="Module 1 Course Pages">' +
           '<ul><li><div><a role="link" href="/learn/matlab/lecture/cp1/course-preview" aria-label="Video, Course Preview, Completed, 2 min">Course Preview</a></div></li></ul>' +
         '</div>' +
       '</nav>'
     );
     assert.equal(isExcludedNode(d.querySelector('input[name="ccp-behavior"]')), true);
     assert.equal(isExcludedNode(d.querySelector('#ccp-host-root textarea')), true);
     assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer textarea')), true);
     assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer button')), true);
     const links = findItemLinks(d);
     assert.equal(links.length, 1);
     assert.equal(links[0].getAttribute('href'), '/learn/matlab/lecture/cp1/course-preview');
   });
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/coursera-dom.test.js"`. Expected: FAIL — `isExternalLaunchPage is not a function`.

3. - [ ] Insert the detector into `lib/coursera-dom.js` immediately before the `const api = {` line. Add this code:

   ```js
     const LAUNCH_NAME_RE = /^\s*launch\s+app\s*$/i;

     // True iff the page is an external-tool launch (no in-page answer inputs):
     // either the URL kind is gradedLti, OR a role=form named "Launch App"/"Launch app"
     // exists. Branches on URL kind + launch-form shape, never on heuristicPageType.
     function isExternalLaunchPage(doc, url) {
       if (url && classifyKind(url) === 'gradedLti') return true;
       if (!doc || typeof doc.querySelectorAll !== 'function') return false;
       let forms = [];
       try { forms = Array.prototype.slice.call(doc.querySelectorAll('form, [role="form"]')); } catch (_) {}
       for (let i = 0; i < forms.length; i++) {
         const f = forms[i];
         if (isExcludedNode(f)) continue;
         const name = (f.getAttribute && f.getAttribute('aria-label')) || accessibleNameOf(f);
         if (LAUNCH_NAME_RE.test(normText(name))) return true;
       }
       return false;
     }
   ```

   Then extend the `api` object to its final form:

   ```js
     const api = {
       parseLearnUrl: parseLearnUrl,
       classifyKind: classifyKind,
       parseItemAccessibleName: parseItemAccessibleName,
       itemStatus: itemStatus,
       isExcludedNode: isExcludedNode,
       assessmentRoot: assessmentRoot,
       withinAssessment: withinAssessment,
       findOutlineNav: findOutlineNav,
       findModuleRegions: findModuleRegions,
       findItemLinks: findItemLinks,
       findNextItemButton: findNextItemButton,
       isExternalLaunchPage: isExternalLaunchPage,
     };
   ```

4. - [ ] Run the test and watch it PASS: `node --test "tests/coursera-dom.test.js"`. Expected: PASS — all coursera-dom tests green, including the three GROUND TRUTH cases. The full courseraDom API now has all 12 spec-frozen methods.

5. - [ ] Run the FULL suite to confirm the new module did not disturb anything: `npm test`. Expected: PASS — `tests 1253 + N` (the coursera-dom tests), `fail 0`.

6. - [ ] Commit: `git add lib/coursera-dom.js tests/coursera-dom.test.js` then `git commit -m "feat(coursera-dom): isExternalLaunchPage + real-DOM extraction ground-truth tests; completes the 12-method API"`.

---

### Task 6: Register `coursera-dom.js` in the manifest content-script load order

**Files:**
- Modify: `manifest.json` (`content_scripts[0].js` L26-60)
- Test: `tests/coursera-dom.test.js` (append a manifest-order guard test)

Steps:

1. - [ ] Append a failing guard test that asserts `coursera-dom.js` is present and ordered before its consumers. Add to the end of `tests/coursera-dom.test.js`:

   ```js
   const fs = require('node:fs');
   const path = require('node:path');

   test('manifest loads coursera-dom.js before its content-script consumers', () => {
     const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
     const js = manifest.content_scripts[0].js;
     const idx = function (name) { return js.indexOf(name); };
     assert.ok(idx('lib/coursera-dom.js') !== -1, 'coursera-dom.js must be in the content-script js list');
     const consumers = [
       'lib/answer-matcher.js',
       'lib/module-scraper.js',
       'lib/page-fallback.js',
       'lib/completion-confirmer.js',
       'lib/module-autopilot.js',
       'lib/question-detector.js',
       'lib/ai-question-context.js',
     ];
     consumers.forEach(function (c) {
       assert.ok(idx(c) !== -1, c + ' must be present');
       assert.ok(idx('lib/coursera-dom.js') < idx(c), 'coursera-dom.js must load before ' + c);
     });
   });
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/coursera-dom.test.js"`. Expected: FAIL — `coursera-dom.js must be in the content-script js list`.

3. - [ ] Edit `manifest.json` to insert `"lib/coursera-dom.js"` immediately before `"lib/answer-matcher.js"`. Change this block:

   ```json
        "lib/answer-parser.js",
        "lib/answer-matcher.js",
   ```

   to:

   ```json
        "lib/answer-parser.js",
        "lib/coursera-dom.js",
        "lib/answer-matcher.js",
   ```

4. - [ ] Run the test and watch it PASS: `node --test "tests/coursera-dom.test.js"`. Expected: PASS — the manifest guard is green.

5. - [ ] Commit: `git add manifest.json tests/coursera-dom.test.js` then `git commit -m "build(manifest): load coursera-dom.js before answer-matcher and all other consumers"`.

---

### Task 7: Fix `module-scraper.extractItemId` to keep unknown-segment ids; add `ungradedWidget` to `KIND_BY_SEGMENT`

**Files:**
- Modify: `lib/module-scraper.js` (`KIND_BY_SEGMENT` L46-56; `extractItemId` L87-93)
- Test: `tests/module-scraper.test.js` (append)

Steps:

1. - [ ] Append the failing tests to `tests/module-scraper.test.js`. The existing destructured import at the top of the file is:

   ```js
   const {
     scrapeModule,
     extractCourseId,
     extractItemId,
     classifyKind,
   } = require('../lib/module-scraper.js');
   ```

   Leave it unchanged for this task — none of Task 7's assertions consume `coursera-dom` directly (module-scraper does not delegate to it until Task 14, where the `courseraDom` import is added to this test file). Adding a `courseraDom` require here would be a dead import. Then append these tests at the end of the file:

   ```js
   test('extractItemId keeps the id for an ungradedWidget segment (regression: vanished lessons)', () => {
     assert.equal(
       extractItemId('/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments'),
       '8h1hv'
     );
   });

   test('extractItemId keeps the id for an unknown/renamed segment instead of returning null', () => {
     assert.equal(extractItemId('/learn/matlab/brandNewSegment/zz9/foo'), 'zz9');
   });

   test('extractItemId still returns null when there is no /<kind>/<id> after /learn/<slug>', () => {
     assert.equal(extractItemId('https://www.coursera.org/learn/x/home/week/2'), 'week');
     assert.equal(extractItemId('https://www.coursera.org/about'), null);
   });

   test('classifyKind maps ungradedWidget through the extended segment map (delegates to reading-style plugin handling)', () => {
     // module-scraper.classifyKind keeps its single-arg contract (the 1253 tests
     // depend on it). It must now map ungradedWidget to a non-'other' kind.
     assert.equal(classifyKind('/learn/x/ungradedWidget/abc/x'), 'reading');
   });

   test('scrapeModule no longer drops the ungradedWidget row (GROUND TRUTH from extraction)', () => {
     const d = dom(
       '<div data-testid="lesson-collection">' +
         '<a href="/learn/matlab/lecture/v1/intro">Intro Video</a>' +
         '<a href="/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments">Completing MATLAB Programming Assignments</a>' +
       '</div>',
       'https://www.coursera.org/learn/matlab/lecture/v1/intro'
     );
     const r = scrapeModule(d);
     const ids = r.items.map(function (it) { return it.id; });
     assert.ok(ids.indexOf('8h1hv') !== -1, 'ungradedWidget item must appear in the queue');
   });
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/module-scraper.test.js"`. Expected: FAIL — `extractItemId` returns `null` for the ungradedWidget/unknown segments; `scrapeModule` omits id `8h1hv`.

3. - [ ] Edit `lib/module-scraper.js`. First add `ungradedWidget` to `KIND_BY_SEGMENT` (the scraper's own kind vocabulary treats a plugin like a reading, so it routes through the no-op/reading path — never the quiz path). Change:

   ```js
     const KIND_BY_SEGMENT = {
       lecture: 'video',
       supplement: 'reading',
       discussionPrompt: 'discussion',
       quiz: 'quiz',
       exam: 'quiz',
       assignment: 'quiz',
       peer: 'peer-review',
       programming: 'programming',
       gradedLti: 'assignment',
     };
   ```

   to:

   ```js
     const KIND_BY_SEGMENT = {
       lecture: 'video',
       supplement: 'reading',
       discussionPrompt: 'discussion',
       ungradedWidget: 'reading',
       quiz: 'quiz',
       exam: 'quiz',
       assignment: 'quiz',
       peer: 'peer-review',
       programming: 'programming',
       gradedLti: 'assignment',
     };
   ```

   Then change `extractItemId` so an unmapped segment KEEPS its id (returns the id, kind resolved as 'other' elsewhere) instead of dropping the row. Change:

   ```js
     function extractItemId(url) {
       if (!url) return null;
       const m = String(url).match(/\/learn\/[^/]+\/([a-zA-Z]+)\/([^/?#]+)/);
       if (!m) return null;
       if (!KIND_BY_SEGMENT[m[1]]) return null;
       return m[2];
     }
   ```

   to:

   ```js
     function extractItemId(url) {
       if (!url) return null;
       const m = String(url).match(/\/learn\/[^/]+\/([a-zA-Z]+)\/([^/?#]+)/);
       if (!m) return null;
       // Unknown/renamed segments KEEP their id (kind resolves to 'other' via
       // classifyKind) so new lessons are never silently dropped from the queue.
       return m[2];
     }
   ```

4. - [ ] Run the test and watch it PASS: `node --test "tests/module-scraper.test.js"`. Expected: PASS — the new tests green. Note: the pre-existing test `extractItemId pulls itemId from /<kind>/<itemId>` asserts `extractItemId('.../home/week/2')` equals `null`; that case still matches the regex with segment `home` capturing `week` — but the original test asserts `null`. **Verify this:** the pre-existing assertion at `tests/module-scraper.test.js` L29 expects `null` for the `/home/week/2` URL. Because `home` is NOT in the original `KIND_BY_SEGMENT` and the old code returned `null`, the new code now returns `'week'`. This breaks an existing test.

5. - [ ] Update the single now-stale pre-existing assertion to reflect the corrected behavior. In `tests/module-scraper.test.js`, find:

   ```js
     assert.equal(extractItemId('https://www.coursera.org/learn/x/home/week/2'), null);
   ```

   and change it to:

   ```js
     // home/week is not an item link; extractItemId now keeps the id-position token
     // (week) rather than null. Callers gate item links on a[href*="/learn/"] + a
     // real itemSlug, so this does not re-introduce home pages into the queue.
     assert.equal(extractItemId('https://www.coursera.org/learn/x/home/week/2'), 'week');
   ```

6. - [ ] Run the FULL suite to confirm no other test depended on the old null-dropping behavior: `npm test`. Expected: PASS — `fail 0`. Empirically only the L29 `home/week/2` assertion changes; the `tests/module-scraper.test.js` L356 `/item/` test carries a stale-explanatory comment about null-dropping but its assertions exercise a `/lecture/` row and do not depend on null-dropping, so it stays green. Run the full suite to confirm `fail 0` rather than trusting this note. (If any other assertion relied on `extractItemId` returning `null` for a non-item URL, it will surface here.)

7. - [ ] Commit: `git add lib/module-scraper.js tests/module-scraper.test.js` then `git commit -m "fix(module-scraper): keep id for ungradedWidget/unknown segments so real lessons stay in the queue"`.

---

### Task 8: Apply `courseraDom.isExcludedNode` in `answer-matcher` option/text-input discovery

**Files:**
- Modify: `lib/answer-matcher.js` (cross-env loader near L6-11; `findNativeGroups` L49-81; `findAriaGroups` L83-128; `findTextInputs` L182-205)
- Test: `tests/answer-matcher.test.js` (append) — verify the file header first

Steps:

1. - [ ] Read the top of `tests/answer-matcher.test.js` to confirm its `dom()` helper and import style, then append the failing tests. Add to the end of `tests/answer-matcher.test.js`:

   ```js
   test('findOptionGroups ignores the extension sidebar radios (name=ccp-behavior under #ccp-host-root)', () => {
     const { findOptionGroups } = require('../lib/answer-matcher.js');
     const d = dom(
       '<div id="ccp-host-root"><div class="ccp-host">' +
         '<input type="radio" name="ccp-behavior" value="a"><input type="radio" name="ccp-behavior" value="b">' +
       '</div></div>' +
       '<fieldset><input type="radio" name="q1"><input type="radio" name="q1"></fieldset>'
     );
     const groups = findOptionGroups(d.body);
     // Only the real quiz radio group survives; ccp-behavior is excluded.
     const names = groups.map(function (g) { return g.name; });
     assert.ok(names.indexOf('ccp-behavior') === -1, 'ccp-behavior group must be excluded');
     assert.equal(groups.length, 1);
     assert.equal(groups[0].name, 'q1');
   });

   test('findTextInputs ignores the Boost chat composer textarea and the extension paste box', () => {
     const { findTextInputs } = require('../lib/answer-matcher.js');
     const d = dom(
       '<div id="boostai-chat-panel-composer"><textarea placeholder="Ask your question here"></textarea></div>' +
       '<div class="ccp-host"><textarea placeholder="Paste or type text..."></textarea></div>' +
       '<textarea id="real-answer"></textarea>'
     );
     const inputs = findTextInputs(d.body);
     assert.equal(inputs.length, 1);
     assert.equal(inputs[0].el.id, 'real-answer');
   });
   ```

   If `tests/answer-matcher.test.js` does not already define a top-level `dom()` helper, add this immediately after its existing `require` header:

   ```js
   function dom(html, url) {
     return new JSDOM(
       '<!doctype html><html><body>' + html + '</body></html>',
       { url: url || 'https://www.coursera.org/learn/test-course/quiz/q1/attempt' }
     ).window.document;
   }
   ```

   (Skip adding it if one already exists — duplicate `const`/`function dom` declarations will error.)

2. - [ ] Run the test and watch it FAIL: `node --test "tests/answer-matcher.test.js"`. Expected: FAIL — the ccp-behavior group and chat/paste textareas are currently included.

3. - [ ] Edit `lib/answer-matcher.js` to add a defensive cross-env loader for `courseraDom` next to the existing `answerParser` loader (L6-11). After the `answerParser` IIFE block, add:

   ```js
     const courseraDom = (function () {
       if (typeof module !== 'undefined' && module.exports) {
         try { return require('./coursera-dom.js'); } catch (_) { return null; }
       }
       return (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
     })();

     function isExcluded(el) {
       return !!(courseraDom && typeof courseraDom.isExcludedNode === 'function' && courseraDom.isExcludedNode(el));
     }
   ```

4. - [ ] In `findNativeGroups`, add an exclusion guard right after the existing `if (!isVisible(inp)) return;` line inside the `inputs.forEach` callback. The block currently reads:

   ```js
       if (!isUsable(inp)) return;
       if (!isVisible(inp)) return;
   ```

   change it to:

   ```js
       if (!isUsable(inp)) return;
       if (!isVisible(inp)) return;
       if (isExcluded(inp)) return;
   ```

5. - [ ] In `findAriaGroups`, exclude items in all three loops. After each `if (!isVisible(it)) return;` (there are loops for radios, group checkboxes, and loose checkboxes), add `if (isExcluded(it)) return;`. Concretely, change each occurrence of:

   ```js
         if (!isUsable(it)) return;
         if (!isVisible(it)) return;
   ```

   to:

   ```js
         if (!isUsable(it)) return;
         if (!isVisible(it)) return;
         if (isExcluded(it)) return;
   ```

   (Apply to all three loops; the loose-checkbox loop's existing guards are `if (!isUsable(it)) return;` / `if (!isVisible(it)) return;` — add `if (isExcluded(it)) return;` after them too.)

6. - [ ] In `findTextInputs`, add the exclusion guard right after the existing `if (!isVisible(el)) return;` inside the `els.forEach` callback. The block currently reads:

   ```js
       if (!isUsable(el)) return;
       if (el.readOnly) return;
       if (!isVisible(el)) return;
   ```

   change it to:

   ```js
       if (!isUsable(el)) return;
       if (el.readOnly) return;
       if (!isVisible(el)) return;
       if (isExcluded(el)) return;
   ```

7. - [ ] Run the test and watch it PASS: `node --test "tests/answer-matcher.test.js"`. Expected: PASS — extension/chat controls are excluded, real targets kept.

8. - [ ] Run the FULL suite: `npm test`. Expected: PASS — `fail 0` (the `question-detector` tests still pass because they consume `findOptionGroups` whose contract is unchanged for non-excluded nodes).

9. - [ ] Commit: `git add lib/answer-matcher.js tests/answer-matcher.test.js` then `git commit -m "fix(answer-matcher): exclude extension UI and Boost chat controls via courseraDom.isExcludedNode in findOptionGroups/findTextInputs"`.

---

### Task 9: Apply `courseraDom.isExcludedNode` in `question-detector.collectContainers`

**Files:**
- Modify: `lib/question-detector.js` (cross-env loader L9-14; `collectContainers` L56-91)
- Test: `tests/question-detector.test.js` (append) — verify the file's `dom()` helper first

Steps:

1. - [ ] Append the failing test to `tests/question-detector.test.js`. Add to the end of the file:

   ```js
   test('detectQuestions skips question-like containers inside the extension sidebar (#ccp-host-root)', () => {
     const { detectQuestions } = require('../lib/question-detector.js');
     const d = dom(
       '<div id="ccp-host-root"><div class="ccp-host">' +
         '<div data-testid="cml-question-1"><h3>Question 1</h3>' +
           '<fieldset><input type="radio" name="ccp-behavior"></fieldset></div>' +
       '</div></div>' +
       '<main>' +
         '<div data-testid="cml-question-2"><h3>Question 1</h3>' +
           '<fieldset><input type="radio" name="real-q"><input type="radio" name="real-q"></fieldset></div>' +
       '</main>'
     );
     const qs = detectQuestions(d.body);
     // The sidebar's masquerading "Question 1" container must not be detected.
     assert.equal(qs.length, 1);
     assert.ok(qs[0].container.closest('#ccp-host-root') === null);
   });
   ```

   If `tests/question-detector.test.js` lacks a top-level `dom()` helper, add this right after its `require` header (skip if one already exists):

   ```js
   function dom(html, url) {
     return new JSDOM(
       '<!doctype html><html><body>' + html + '</body></html>',
       { url: url || 'https://www.coursera.org/learn/test-course/quiz/q1/attempt' }
     ).window.document;
   }
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/question-detector.test.js"`. Expected: FAIL — both "Question 1" containers are currently detected (length 2, dedup by number may pick either), the sidebar one is not excluded.

3. - [ ] Edit `lib/question-detector.js`. Extend the cross-env loader block (L9-14). After the existing `answerMatcher` IIFE block, add:

   ```js
     const courseraDom = (function () {
       if (typeof module !== 'undefined' && module.exports) {
         try { return require('./coursera-dom.js'); } catch (_) { return null; }
       }
       return (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
     })();

     function isExcludedContainer(el) {
       return !!(courseraDom && typeof courseraDom.isExcludedNode === 'function' && courseraDom.isExcludedNode(el));
     }
   ```

4. - [ ] In `collectContainers`, skip excluded containers in both Pass A and Pass B. In Pass A's `explicit.forEach` callback, the body currently starts:

   ```js
       if (seen.has(el)) return;
       const hdr = findHeaderInside(el);
   ```

   change it to:

   ```js
       if (seen.has(el)) return;
       if (isExcludedContainer(el)) return;
       const hdr = findHeaderInside(el);
   ```

   In Pass B's `heads.forEach` callback, after computing `const c = anc || el.parentElement;` the body currently reads:

   ```js
       if (!c || seen.has(c)) return;
   ```

   change it to:

   ```js
       if (!c || seen.has(c)) return;
       if (isExcludedContainer(c)) return;
   ```

5. - [ ] Run the test and watch it PASS: `node --test "tests/question-detector.test.js"`. Expected: PASS — only the `main` question is detected.

6. - [ ] Run the FULL suite: `npm test`. Expected: PASS — `fail 0`.

7. - [ ] Commit: `git add lib/question-detector.js tests/question-detector.test.js` then `git commit -m "fix(question-detector): skip excluded (sidebar/chat) containers via courseraDom.isExcludedNode before classification"`.

---

### Task 10: Route `ai-question-context` exclusion through `courseraDom.isExcludedNode`

**Files:**
- Modify: `lib/ai-question-context.js` (cross-env loader L4-9; `findCurrentActivityEvidenceRoot.isUnderExcluded` L28-45; `_visibleBlockedReason.isUnderExcluded` L88-102)
- Test: `tests/ai-question-context.test.js` (append) — verify the file's `dom()` helper first

Steps:

1. - [ ] Append the failing test to `tests/ai-question-context.test.js`. Add to the end of the file:

   ```js
   test('findCurrentActivityEvidenceRoot never returns a node inside the extension sidebar even without ASIDE/NAV wrappers', () => {
     const { findCurrentActivityEvidenceRoot } = require('../lib/ai-question-context.js');
     const d = dom(
       // Sidebar uses .ccp-host (no aside/nav, no recognized class keyword) — the
       // old ad-hoc walk relied on ASIDE/NAV/role/class keywords and would miss it.
       '<div class="ccp-host">' +
         '<div data-testid="cml-question-1"><h3>Question 1</h3>' +
           '<fieldset><input type="radio" name="ccp-behavior"></fieldset></div>' +
       '</div>' +
       '<main>' +
         '<div data-testid="cml-question-2"><h3>Question 1</h3>' +
           '<fieldset><input type="radio" name="real-q"><input type="radio" name="real-q"></fieldset></div>' +
       '</main>'
     );
     const rootEl = findCurrentActivityEvidenceRoot(d, { href: 'https://www.coursera.org/learn/x/quiz/q1/attempt' });
     assert.ok(rootEl);
     assert.equal(rootEl.closest('.ccp-host'), null, 'evidence root must not be inside .ccp-host');
   });
   ```

   If `tests/ai-question-context.test.js` lacks a top-level `dom()` helper, add this right after its `require` header (skip if one already exists):

   ```js
   function dom(html, url) {
     return new JSDOM(
       '<!doctype html><html><body>' + html + '</body></html>',
       { url: url || 'https://www.coursera.org/learn/x/quiz/q1/attempt' }
     ).window.document;
   }
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/ai-question-context.test.js"`. Expected: FAIL — the `.ccp-host` subtree is not recognized by the existing keyword-based `isUnderExcluded` (it matches `ASIDE/NAV/role/sidebar|drawer|outline|nav|module-list|toc` but not `ccp-host`), so the evidence root resolves inside the sidebar.

3. - [ ] Edit `lib/ai-question-context.js`. Extend the cross-env loader (L4-9). After the two existing `req(...)` calls (`moduleScraper`, `questionDetector`), add:

   ```js
     const courseraDom = (function () {
       try { return req('./coursera-dom.js', 'courseraDom'); } catch (_) { return null; }
     })();

     function ccpExcludes(el) {
       return !!(courseraDom && typeof courseraDom.isExcludedNode === 'function' && courseraDom.isExcludedNode(el));
     }
   ```

4. - [ ] In `findCurrentActivityEvidenceRoot`, augment its inner `isUnderExcluded`. The function body currently begins:

   ```js
       function isUnderExcluded(el) {
         if (!el) return true;
         var cur = el;
   ```

   change it to:

   ```js
       function isUnderExcluded(el) {
         if (!el) return true;
         if (ccpExcludes(el)) return true;
         var cur = el;
   ```

5. - [ ] In `_visibleBlockedReason`, augment its inner `isUnderExcluded` identically. Find the second occurrence:

   ```js
       function isUnderExcluded(el) {
         if (!el) return true;
         var cur = el;
         while (cur && cur !== doc.body) {
           if (cur === hostEl) return true;
   ```

   change it to:

   ```js
       function isUnderExcluded(el) {
         if (!el) return true;
         if (ccpExcludes(el)) return true;
         var cur = el;
         while (cur && cur !== doc.body) {
           if (cur === hostEl) return true;
   ```

6. - [ ] Run the test and watch it PASS: `node --test "tests/ai-question-context.test.js"`. Expected: PASS — the evidence root resolves inside `main`, never under `.ccp-host`.

7. - [ ] Run the FULL suite: `npm test`. Expected: PASS — `fail 0` (the `eligible:true` snapshot contract and `localGuard` fields are untouched; only the exclusion walk is broadened).

8. - [ ] Commit: `git add lib/ai-question-context.js tests/ai-question-context.test.js` then `git commit -m "fix(ai-question-context): route exclusion through courseraDom.isExcludedNode so .ccp-host/boost nodes are subsumed"`.

---

### Task 11: Add an `accessibleName`-status + nav-progressbar completion path to `completion-confirmer`

**Files:**
- Modify: `lib/completion-confirmer.js` (`createConfirmer` deps L11-25; `waitForCompletion` loop L45-77)
- Test: `tests/completion-confirmer.test.js` (append) — verify the file's harness first

Steps:

1. - [ ] Append the failing tests to `tests/completion-confirmer.test.js`. The existing tests inject `sleep`/`nowFn` and a stub `scraper`. Add to the end of the file:

   ```js
   test('waitForCompletion detects completion via the accessibleName status token (courseraDom)', async () => {
     const { createConfirmer } = require('../lib/completion-confirmer.js');
     const courseraDom = require('../lib/coursera-dom.js');
     const { JSDOM } = require('jsdom');
     const doc = new JSDOM(
       '<!doctype html><html><body>' +
         '<a href="/learn/x/lecture/v1/intro" aria-label="Video, Intro, Completed, 2 min">Intro</a>' +
       '</body></html>',
       { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
     ).window.document;
     // No legacy indicator: the green-icon and item-indicator paths return null.
     const scraper = {
       findItemCompletionIndicator: function () { return null; },
       findGreenCompletionIconInRow: function () { return null; },
     };
     let t = 0;
     const confirmer = createConfirmer({
       sleep: function () { t += 1000; return Promise.resolve(); },
       nowFn: function () { return t; },
     });
     const done = await confirmer.waitForCompletion({
       doc: doc,
       itemId: 'v1',
       itemKind: 'video',
       scraper: scraper,
       courseraDom: courseraDom,
       timeoutMs: 5000,
       pollIntervalMs: 1000,
     });
     assert.equal(done, true);
   });

   test('waitForCompletion detects completion via a nav progressbar reaching 100% (courseraDom)', async () => {
     const { createConfirmer } = require('../lib/completion-confirmer.js');
     const courseraDom = require('../lib/coursera-dom.js');
     const { JSDOM } = require('jsdom');
     const doc = new JSDOM(
       '<!doctype html><html><body>' +
         '<a href="/learn/x/lecture/v1/intro" aria-label="Video, Intro, Not submitted, 2 min">Intro</a>' +
         '<div role="navigation"><div role="progressbar" aria-valuenow="100" aria-valuemax="100"></div></div>' +
       '</body></html>',
       { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
     ).window.document;
     const scraper = {
       findItemCompletionIndicator: function () { return null; },
       findGreenCompletionIconInRow: function () { return null; },
     };
     let t = 0;
     const confirmer = createConfirmer({
       sleep: function () { t += 1000; return Promise.resolve(); },
       nowFn: function () { return t; },
     });
     const done = await confirmer.waitForCompletion({
       doc: doc,
       itemId: 'v1',
       itemKind: 'video',
       scraper: scraper,
       courseraDom: courseraDom,
       timeoutMs: 5000,
       pollIntervalMs: 1000,
     });
     assert.equal(done, true);
   });

   test('waitForCompletion still times out when no evidence at all is present', async () => {
     const { createConfirmer } = require('../lib/completion-confirmer.js');
     const courseraDom = require('../lib/coursera-dom.js');
     const { JSDOM } = require('jsdom');
     const doc = new JSDOM(
       '<!doctype html><html><body>' +
         '<a href="/learn/x/lecture/v1/intro" aria-label="Video, Intro, Not submitted, 2 min">Intro</a>' +
       '</body></html>',
       { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
     ).window.document;
     const scraper = {
       findItemCompletionIndicator: function () { return null; },
       findGreenCompletionIconInRow: function () { return null; },
     };
     let t = 0;
     const confirmer = createConfirmer({
       sleep: function () { t += 1000; return Promise.resolve(); },
       nowFn: function () { return t; },
     });
     const done = await confirmer.waitForCompletion({
       doc: doc,
       itemId: 'v1',
       itemKind: 'video',
       scraper: scraper,
       courseraDom: courseraDom,
       timeoutMs: 3000,
       pollIntervalMs: 1000,
     });
     assert.equal(done, false);
   });
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/completion-confirmer.test.js"`. Expected: FAIL — the first two return `false` because the new evidence paths do not exist yet (the third passes by coincidence; keep it as a regression guard).

3. - [ ] Edit `lib/completion-confirmer.js`. Inside `waitForCompletion`, read the optional `courseraDom` from opts. After the existing line `const pageFallback = opts.pageFallback;` add:

   ```js
       const courseraDom = opts.courseraDom || null;
   ```

4. - [ ] Add a helper and two new evidence checks inside the `while (true)` loop, placed after the existing `green-row-icon` check and before the `reading` check. Insert this block:

   ```js
         if (courseraDom && doc && typeof doc.querySelectorAll === 'function') {
           // Evidence: the item link's accessibleName status token reads 'completed'.
           let statusDone = false;
           try {
             const anchors = doc.querySelectorAll('a[href*="/learn/"]');
             for (let i = 0; i < anchors.length; i++) {
               const a = anchors[i];
               const parsed = courseraDom.parseLearnUrl(a.getAttribute('href') || '');
               if (parsed && parsed.id === itemId) {
                 if (courseraDom.itemStatus(a) === 'completed') { statusDone = true; break; }
               }
             }
           } catch (_) {}
           if (statusDone) {
             rec('completion.detected', { itemId: itemId, evidence: 'accessible-status' });
             return true;
           }
           // Evidence: a nav progressbar reporting full completion (valuenow >= valuemax).
           let barDone = false;
           try {
             const bars = doc.querySelectorAll('[role="progressbar"]');
             for (let i = 0; i < bars.length; i++) {
               const b = bars[i];
               const now = parseFloat(b.getAttribute('aria-valuenow'));
               const max = parseFloat(b.getAttribute('aria-valuemax'));
               if (!isNaN(now) && !isNaN(max) && max > 0 && now >= max) { barDone = true; break; }
             }
           } catch (_) {}
           if (barDone) {
             rec('completion.detected', { itemId: itemId, evidence: 'nav-progressbar' });
             return true;
           }
         }
   ```

   Place it so the loop checks, in order: `item-indicator` (existing), `green-row-icon` (existing), then this new `accessible-status` + `nav-progressbar` block, then `reading-completed` (existing), then `top-progress` (existing).

5. - [ ] Run the test and watch it PASS: `node --test "tests/completion-confirmer.test.js"`. Expected: PASS — both new evidence paths detect completion; the no-evidence case still times out.

6. - [ ] Run the FULL suite: `npm test`. Expected: PASS — `fail 0` (signatures `createConfirmer`/`waitForCompletion` and all existing evidence tokens are preserved; `courseraDom` is optional so existing callers are unaffected).

7. - [ ] Commit: `git add lib/completion-confirmer.js tests/completion-confirmer.test.js` then `git commit -m "feat(completion-confirmer): add accessibleName-status and nav-progressbar completion evidence via courseraDom"`.

---

### Task 12: Replace `page-fallback.findGoToNextItemButton` with `courseraDom`-backed substring/aria matching

**Files:**
- Modify: `lib/page-fallback.js` (top loader after L9; `findGoToNextItemButton` L31-38; export L98-105)
- Test: `tests/page-fallback.test.js` (append) — verify the file's `dom()` helper first

Steps:

1. - [ ] Append the failing tests to `tests/page-fallback.test.js`. Add to the end of the file:

   ```js
   test('findGoToNextItemButton matches a non-whole-string label like "Go to next item (Lesson 2)"', () => {
     const { findGoToNextItemButton } = require('../lib/page-fallback.js');
     const d = dom('<main><div role="button">Go to next item (Lesson 2)</div></main>');
     const btn = findGoToNextItemButton(d.body);
     assert.ok(btn);
     assert.equal(btn.getAttribute('role'), 'button');
   });

   test('findGoToNextItemButton matches via aria-label and ignores the Boost chat composer', () => {
     const { findGoToNextItemButton } = require('../lib/page-fallback.js');
     const d = dom(
       '<div id="boostai-chat-panel-composer"><button aria-label="next item">Send</button></div>' +
       '<main><button aria-label="Go to next item">→</button></main>'
     );
     const btn = findGoToNextItemButton(d.body);
     assert.ok(btn);
     assert.equal(btn.getAttribute('aria-label'), 'Go to next item');
   });

   test('findGoToNextItemButton still matches the legacy whole-string "Continue" when courseraDom finds nothing', () => {
     const { findGoToNextItemButton } = require('../lib/page-fallback.js');
     const d = dom('<main><button>Continue</button></main>');
     const btn = findGoToNextItemButton(d.body);
     assert.ok(btn);
     assert.equal(btn.textContent, 'Continue');
   });
   ```

   If `tests/page-fallback.test.js` lacks a top-level `dom()` helper, add this right after its `require` header (skip if one already exists):

   ```js
   function dom(html, url) {
     return new JSDOM(
       '<!doctype html><html><body>' + html + '</body></html>',
       { url: url || 'https://www.coursera.org/learn/x/lecture/v1/intro' }
     ).window.document;
   }
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/page-fallback.test.js"`. Expected: FAIL — the existing `NEXT_ITEM_RE` requires a whole-string match, so "Go to next item (Lesson 2)" does not match and the chat button is not excluded.

3. - [ ] Edit `lib/page-fallback.js`. Add a defensive cross-env loader for `courseraDom` right after the `'use strict';` line and the `normText` helper. After the `normText` function, add:

   ```js
     const courseraDom = (function () {
       if (typeof module !== 'undefined' && module.exports) {
         try { return require('./coursera-dom.js'); } catch (_) { return null; }
       }
       return (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
     })();
   ```

4. - [ ] Rewrite `findGoToNextItemButton` to prefer `courseraDom.findNextItemButton` (substring/aria-first, exclusion-aware) and fall back to the legacy whole-string regex. Replace:

   ```js
     function findGoToNextItemButton(root) {
       if (!root || typeof root.querySelectorAll !== 'function') return null;
       const els = root.querySelectorAll('button, a, [role="button"]');
       for (let i = 0; i < els.length; i++) {
         if (NEXT_ITEM_RE.test(normText(els[i].textContent))) return els[i];
       }
       return null;
     }
   ```

   with:

   ```js
     function findGoToNextItemButton(root) {
       if (!root || typeof root.querySelectorAll !== 'function') return null;
       // Prefer the shared, locale-tolerant, exclusion-aware locator. It accepts a
       // doc or an element root (uses querySelectorAll either way).
       if (courseraDom && typeof courseraDom.findNextItemButton === 'function') {
         const hit = courseraDom.findNextItemButton(root);
         if (hit) return hit;
       }
       // Legacy fallback: whole-string English match (e.g. "Continue").
       const els = root.querySelectorAll('button, a, [role="button"]');
       for (let i = 0; i < els.length; i++) {
         if (NEXT_ITEM_RE.test(normText(els[i].textContent))) return els[i];
       }
       return null;
     }
   ```

5. - [ ] Run the test and watch it PASS: `node --test "tests/page-fallback.test.js"`. Expected: PASS — substring + aria matches work, chat is excluded, legacy "Continue" still matches.

6. - [ ] Run the FULL suite: `npm test`. Expected: PASS — `fail 0` (the export name `findGoToNextItemButton` and the other exports `findTopProgressText`/`parseProgress`/`findCompletedReadingIndicator`/`findMarkCompleteButton`/`findAgreementCheckbox` are unchanged, so `completion-confirmer` and other consumers are unaffected).

7. - [ ] Commit: `git add lib/page-fallback.js tests/page-fallback.test.js` then `git commit -m "feat(page-fallback): findGoToNextItemButton prefers courseraDom (substring/aria, exclusion-aware) with legacy fallback"`.

---

### Task 13: Harden `module-autopilot` navigation (widen timeout, confirm by URL + expected item id, next-item fallback, external-launch recognition)

**Files:**
- Modify: `lib/module-autopilot.js` (`navigateUrlChangeTimeoutMs` default L231; `navigateAndConfirm` URL-change success block L527-534; `navigateAndConfirm` tail L537-556)
- Test: `tests/module-autopilot.test.js` (append) — verify the file's `createAutopilot` injection harness first

Steps:

1. - [ ] Append the failing tests to `tests/module-autopilot.test.js`. The file already builds a JSDOM `j` and calls `createAutopilot({ document, window, storage, handlers, navigateUrlChangeTimeoutMs, nowFn, rng })` and exports `navigateAndConfirm` for direct testing where present. Add to the end of the file:

   ```js
   test('createAutopilot defaults navigateUrlChangeTimeoutMs to 800ms (widened from 100ms)', () => {
     const { createAutopilot } = require('../lib/module-autopilot.js');
     const { JSDOM } = require('jsdom');
     const j = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
     const ap = createAutopilot({
       document: j.window.document,
       window: j.window,
       storage: makeMemoryStorage(),
       handlers: {},
       nowFn: function () { return 0; },
       rng: function () { return 0.5; },
     });
     assert.equal(ap._test.navigateUrlChangeTimeoutMs, 800);
   });

   test('navigateAndConfirm confirms a URL change only when the new URL\'s item id matches the target', async () => {
     const { createAutopilot } = require('../lib/module-autopilot.js');
     const { JSDOM } = require('jsdom');
     // The SPA route lands on the EXPECTED next item: parseLearnUrl(currentUrl).id === target id.
     const j = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
     const ap = createAutopilot({
       document: j.window.document,
       window: j.window,
       storage: makeMemoryStorage(),
       handlers: {},
       nowFn: function () { return 0; },
       rng: function () { return 0.5; },
       // Simulate the SPA pushState landing on the target item id (v2).
       navigate: function () {
         try { j.window.history.pushState({}, '', 'https://www.coursera.org/learn/x/lecture/v2/next'); } catch (_) {}
         return Promise.resolve();
       },
       navigateUrlChangeTimeoutMs: 200,
     });
     const ok = await ap._test.navigateAndConfirm('https://www.coursera.org/learn/x/lecture/v2/next');
     assert.equal(ok, true);
   });

   test('navigateAndConfirm does NOT accept a URL change to a DIFFERENT item id (interstitial); falls through', async () => {
     const { createAutopilot } = require('../lib/module-autopilot.js');
     const { JSDOM } = require('jsdom');
     // The URL changes to an interstitial whose item id (zzz) is NOT the target (v2),
     // and there is no matching row anchor and no next-item button -> navigateAndConfirm
     // must NOT report success off the bare URL change; it falls through to false.
     const j = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
     const ap = createAutopilot({
       document: j.window.document,
       window: j.window,
       storage: makeMemoryStorage(),
       handlers: {},
       nowFn: function () { return 0; },
       rng: function () { return 0.5; },
       navigate: function () {
         try { j.window.history.pushState({}, '', 'https://www.coursera.org/learn/x/lecture/zzz/interstitial'); } catch (_) {}
         return Promise.resolve();
       },
       navigateUrlChangeTimeoutMs: 80,
     });
     const ok = await ap._test.navigateAndConfirm('https://www.coursera.org/learn/x/lecture/v2/next');
     assert.equal(ok, false);
   });

   test('navigateAndConfirm clicks the "Go to next item" button when no matching row anchor exists', async () => {
     const { createAutopilot } = require('../lib/module-autopilot.js');
     const { JSDOM } = require('jsdom');
     const j = new JSDOM(
       '<!doctype html><html><body>' +
         '<main><div role="button" id="next">Go to next item</div></main>' +
       '</body></html>',
       { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
     );
     let clicked = false;
     j.window.document.getElementById('next').addEventListener('click', function () { clicked = true; });
     const ap = createAutopilot({
       document: j.window.document,
       window: j.window,
       storage: makeMemoryStorage(),
       handlers: {},
       nowFn: function () { return 0; },
       rng: function () { return 0.5; },
       navigate: function () { return Promise.resolve(); }, // no URL change, no row anchor
       navigateUrlChangeTimeoutMs: 10,
     });
     // Target a URL with no matching a[href] in the DOM -> row-anchor fallback misses ->
     // next-item button is clicked as the final fallback.
     const ok = await ap._test.navigateAndConfirm('https://www.coursera.org/learn/x/lecture/v2/next');
     assert.equal(clicked, true);
     assert.equal(ok, true);
   });

   test('navigateAndConfirm treats an external LTI launch page as navigated (no crash, returns true)', async () => {
     const { createAutopilot } = require('../lib/module-autopilot.js');
     const { JSDOM } = require('jsdom');
     const url = 'https://www.coursera.org/learn/matlab/gradedLti/0OaH5/assignment-echo-generator';
     const j = new JSDOM(
       '<!doctype html><html><body>' +
         '<main><form role="form" aria-label="Launch App" action="https://learningtool.mathworks.com/lti/oidc" method="post"><button>Launch app. Opens in new window</button></form></main>' +
       '</body></html>',
       { url: url }
     );
     const ap = createAutopilot({
       document: j.window.document,
       window: j.window,
       storage: makeMemoryStorage(),
       handlers: {},
       nowFn: function () { return 0; },
       rng: function () { return 0.5; },
       navigate: function () { return Promise.resolve(); },
       navigateUrlChangeTimeoutMs: 10,
     });
     const ok = await ap._test.navigateAndConfirm(url);
     assert.equal(ok, true);
   });
   ```

   If `tests/module-autopilot.test.js` does not already define `makeMemoryStorage`, add this helper right after its `require` header (skip if one already exists):

   ```js
   function makeMemoryStorage() {
     const mem = {};
     return {
       get: function (keys, cb) {
         const out = {};
         (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { if (k in mem) out[k] = mem[k]; });
         if (cb) cb(out); return Promise.resolve(out);
       },
       set: function (obj, cb) { Object.keys(obj).forEach(function (k) { mem[k] = obj[k]; }); if (cb) cb(); return Promise.resolve(); },
       remove: function (keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete mem[k]; }); if (cb) cb(); return Promise.resolve(); },
     };
   }
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/module-autopilot.test.js"`. Expected: FAIL — `ap._test` is undefined (no test bridge yet), `navigateUrlChangeTimeoutMs` default is 100 not 800, and the next-item/launch fallbacks do not exist.

3. - [ ] Edit `lib/module-autopilot.js`. Widen the default timeout. Change:

   ```js
     const navigateUrlChangeTimeoutMs = (opts.navigateUrlChangeTimeoutMs && opts.navigateUrlChangeTimeoutMs > 0) ? opts.navigateUrlChangeTimeoutMs : 100;
   ```

   to:

   ```js
     const navigateUrlChangeTimeoutMs = (opts.navigateUrlChangeTimeoutMs && opts.navigateUrlChangeTimeoutMs > 0) ? opts.navigateUrlChangeTimeoutMs : 800;
   ```

4. - [ ] Add a defensive `courseraDom` reference next to the existing `pageFallback` resolution (after the `pageFallback` const at L254-256). Add:

   ```js
     const courseraDom = opts.courseraDom
       || (typeof require !== 'undefined' ? (function () { try { return require('./coursera-dom.js'); } catch (_) { return null; } })() : null)
       || (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
   ```

5. - [ ] Confirm a URL change by expected item id (spec WS-A: "confirm by URL + expected item id"). The current success path accepts ANY URL change (`navigateAndConfirm` while-loop, `lib/module-autopilot.js` L527 — `if (currentUrl() !== before)`), which lets an interstitial/redirect register as the destination. Tighten it so a URL change is only accepted when the new URL parses to the target's item id (with a graceful fallthrough when either URL is unparseable, preserving today's behavior for non-`/learn/` routes). Compute the expected id once near the top of `navigateAndConfirm`, just after `let _rowAnchorClicked = false;`, by adding:

   ```js
       let _expectedId = null;
       try {
         if (courseraDom && typeof courseraDom.parseLearnUrl === 'function') {
           const _p = courseraDom.parseLearnUrl(targetUrl);
           _expectedId = _p ? _p.id : null;
         }
       } catch (_) { _expectedId = null; }
   ```

   Then replace the URL-change success block inside the `while (Date.now() < deadline)` loop — currently:

   ```js
         if (currentUrl() !== before) {
           // Yield once before returning so that any bootIfRunning() initiated by
           // the pushState side-effect (inside navigate()) can advance far enough
           // to call runCurrentItem() while inFlight is still set, enabling the
           // queuedRun re-entry mechanism to fire correctly.
           await Promise.resolve();
           _urlChanged = true; rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, rowAnchorFallbackClicked: _rowAnchorClicked }); return true;
         }
   ```

   with:

   ```js
         if (currentUrl() !== before) {
           // Confirm by URL + expected item id: only accept the change if the new URL
           // parses to the target's item id. If we could not derive an expected id
           // (non-/learn/ target) OR the new URL does not parse, fall back to today's
           // behavior and accept the bare URL change. A parsed-but-mismatched id is an
           // interstitial/redirect and must NOT be accepted here — let the row-anchor /
           // next-item / launch fallbacks below decide.
           let _newId = null;
           try {
             if (courseraDom && typeof courseraDom.parseLearnUrl === 'function') {
               const _np = courseraDom.parseLearnUrl(currentUrl());
               _newId = _np ? _np.id : null;
             }
           } catch (_) { _newId = null; }
           const _idConfirmed = (!_expectedId || !_newId) ? true : (_newId === _expectedId);
           if (_idConfirmed) {
             // Yield once before returning so that any bootIfRunning() initiated by
             // the pushState side-effect (inside navigate()) can advance far enough
             // to call runCurrentItem() while inFlight is still set, enabling the
             // queuedRun re-entry mechanism to fire correctly.
             await Promise.resolve();
             _urlChanged = true; rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, idConfirmed: true, rowAnchorFallbackClicked: _rowAnchorClicked }); return true;
           }
           // URL changed but to a different (interstitial) item id: record and break out
           // of the wait loop so the fallbacks below run.
           _urlChanged = true;
           rec('navigation.interstitial', { target: targetUrl, expectedId: _expectedId, observedId: _newId });
           break;
         }
   ```

6. - [ ] Extend `navigateAndConfirm` so that after the row-anchor fallback loop fails, it (a) recognizes an external launch page as "navigated" and (b) clicks `courseraDom.findNextItemButton(doc)` as a final fallback. Replace the tail of `navigateAndConfirm` — the block currently reading:

   ```js
       if (doc && typeof doc.querySelectorAll === 'function') {
         let targetPath = targetUrl;
         try {
           const origin = (win && win.location && win.location.origin) || 'https://www.coursera.org';
           targetPath = new URL(targetUrl, origin).pathname;
         } catch (_) {}
         const anchors = doc.querySelectorAll('a[href*="/learn/"]');
         for (let i = 0; i < anchors.length; i++) {
           const href = anchors[i].getAttribute('href') || '';
           try {
             const aPath = new URL(href, 'https://www.coursera.org').pathname;
             if (aPath === targetPath) {
               try { anchors[i].click(); _rowAnchorClicked = true; rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, rowAnchorFallbackClicked: _rowAnchorClicked }); return true; } catch (_) {}
             }
           } catch (_) {}
         }
       }
       rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, rowAnchorFallbackClicked: _rowAnchorClicked });
       return false;
     }
   ```

   with:

   ```js
       if (doc && typeof doc.querySelectorAll === 'function') {
         let targetPath = targetUrl;
         try {
           const origin = (win && win.location && win.location.origin) || 'https://www.coursera.org';
           targetPath = new URL(targetUrl, origin).pathname;
         } catch (_) {}
         const anchors = doc.querySelectorAll('a[href*="/learn/"]');
         for (let i = 0; i < anchors.length; i++) {
           const href = anchors[i].getAttribute('href') || '';
           try {
             const aPath = new URL(href, 'https://www.coursera.org').pathname;
             if (aPath === targetPath) {
               try { anchors[i].click(); _rowAnchorClicked = true; rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, rowAnchorFallbackClicked: _rowAnchorClicked }); return true; } catch (_) {}
             }
           } catch (_) {}
         }
       }
       // External LTI launch page: there is no in-page row anchor or SPA route to
       // confirm; treat the page itself as the destination so the run loop proceeds
       // (the handler will skip-and-continue). Branch on URL kind / Launch-App form.
       if (courseraDom && typeof courseraDom.isExternalLaunchPage === 'function' && courseraDom.isExternalLaunchPage(doc, targetUrl)) {
         rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, externalLaunch: true });
         return true;
       }
       // Final fallback: an in-body "Go to next item" control (locale-tolerant).
       if (courseraDom && typeof courseraDom.findNextItemButton === 'function') {
         const nextBtn = courseraDom.findNextItemButton(doc);
         if (nextBtn) {
           try { nextBtn.click(); rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, nextItemButtonClicked: true }); return true; } catch (_) {}
         }
       }
       rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, rowAnchorFallbackClicked: _rowAnchorClicked });
       return false;
     }
   ```

7. - [ ] Expose a minimal test bridge so the tests can call `navigateAndConfirm` and read `navigateUrlChangeTimeoutMs` deterministically. Find the object that `createAutopilot` returns (the controller object near the end of `createAutopilot`, before `return`). Add a `_test` property to that returned object exposing exactly these members. Locate the `return {` of the controller and add inside it:

   ```js
       _test: {
         navigateAndConfirm: navigateAndConfirm,
         navigateUrlChangeTimeoutMs: navigateUrlChangeTimeoutMs,
       },
   ```

   (If a `_test` bridge already exists on the returned object, add the two members to it rather than creating a second `_test`.)

8. - [ ] Run the test and watch it PASS: `node --test "tests/module-autopilot.test.js"`. Expected: PASS — default is 800, a same-id URL change is confirmed, a different-id (interstitial) URL change is NOT accepted off the bare change, the next-item button is clicked when no row anchor matches, and an LTI launch page returns `true`.

9. - [ ] Run the FULL suite: `npm test`. Expected: PASS — `fail 0`. (The `createAutopilot` injection surface is unchanged; `_test` is additive; current blocking behavior in `buildOrderedQueue`/`blockReasonLabel`/`isBlockedAssessmentItem` is untouched. The id-confirmation tightening falls through to today's accept-any-change behavior whenever the target or new URL is not a parseable `/learn/` URL, so existing navigation tests that pushState to the same target stay green.)

10. - [ ] Commit: `git add lib/module-autopilot.js tests/module-autopilot.test.js` then `git commit -m "feat(module-autopilot): widen nav timeout to 800ms, confirm URL change by expected item id, add next-item-button and external-launch fallbacks via courseraDom"`.

---

### Task 14: Route `module-scraper` completion through `courseraDom` (demote green-RGB to last-resort), add `findModuleRegions` expand-all discovery and fixture ground-truth rows

**Files:**
- Modify: `lib/module-scraper.js` (cross-env loader near top after L4; `isCompleted` L379-385; `findGreenCompletionIconInRow` L463-479; export object L665-682)
- Test: `tests/module-scraper.test.js` (append)

Steps:

1. - [ ] Append the failing tests to `tests/module-scraper.test.js`. Add to the end of the file:

   ```js
   test('scrapeModule keeps a Graded App Item (gradedLti) row in the queue (GROUND TRUTH)', () => {
     // accessibleName "Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min"
     // href /learn/matlab/gradedLti/<id>/assignment-matlab-calculation
     const d = dom(
       '<div data-testid="lesson-collection">' +
         '<a href="/learn/matlab/gradedLti/g1/assignment-matlab-calculation" aria-label="Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min">Assignment: MATLAB Calculation</a>' +
       '</div>',
       'https://www.coursera.org/learn/matlab/lecture/v1/intro'
     );
     const r = scrapeModule(d);
     const ids = r.items.map(function (it) { return it.id; });
     assert.ok(ids.indexOf('g1') !== -1, 'gradedLti row must stay in the queue');
   });

   test('scrapeModule reads completion from the accessibleName status token (preferred over green-RGB)', () => {
     // The row carries NO class/data-testid completion marker and NO green icon —
     // only the accessibleName "...Completed..." status token. The new courseraDom
     // status signal must mark it completed (the green-RGB heuristic alone could not).
     const d = dom(
       '<div data-testid="lesson-collection">' +
         '<a href="/learn/matlab/lecture/v1/intro" aria-label="Video, Intro, Completed, 2 min">Intro</a>' +
       '</div>',
       'https://www.coursera.org/learn/matlab/lecture/v1/intro'
     );
     const r = scrapeModule(d);
     const it = r.items.filter(function (x) { return x.id === 'v1'; })[0];
     assert.ok(it, 'row must be in the queue');
     assert.equal(it.completed, true);
   });

   test('scrapeModule reads not-completion from the accessibleName status token even with green-ish styling (status wins)', () => {
     // accessibleName says "Not submitted". There is NO existing class/aria/data-testid
     // completion marker. The authoritative status token must drive completed=false; the
     // green-RGB heuristic only fires as a last resort when status is unknown.
     const d = dom(
       '<div data-testid="lesson-collection">' +
         '<a href="/learn/matlab/lecture/v2/scripts" aria-label="Video, Scripts, Not submitted, 4 min">' +
           '<span style="color: rgb(0, 160, 0)">•</span>Scripts' +
         '</a>' +
       '</div>',
       'https://www.coursera.org/learn/matlab/lecture/v1/intro'
     );
     const r = scrapeModule(d);
     const it = r.items.filter(function (x) { return x.id === 'v2'; })[0];
     assert.ok(it, 'row must be in the queue');
     assert.equal(it.completed, false);
   });

   test('scrapeModule still falls back to the green-RGB icon when the accessibleName has no status token (last resort)', () => {
     // No status token in the accessibleName at all -> courseraDom.itemStatus is
     // 'unknown' -> the legacy green-RGB heuristic is consulted as the last resort.
     const d = dom(
       '<div data-testid="lesson-collection">' +
         '<a href="/learn/matlab/lecture/v3/recap" aria-label="Course Preview">' +
           '<svg style="fill: rgb(0, 150, 0)"><path></path></svg>Recap' +
         '</a>' +
       '</div>',
       'https://www.coursera.org/learn/matlab/lecture/v1/intro'
     );
     const r = scrapeModule(d);
     const it = r.items.filter(function (x) { return x.id === 'v3'; })[0];
     assert.ok(it, 'row must be in the queue');
     assert.equal(it.completed, true);
   });

   test('module-scraper exposes findModuleRegions delegating to courseraDom (role=region module discovery)', () => {
     const scraper = require('../lib/module-scraper.js');
     assert.equal(typeof scraper.findModuleRegions, 'function');
     const d = dom(
       '<nav role="navigation">' +
         '<div role="region" aria-label="Module 1 Course Pages">' +
           '<div role="heading" aria-level="3"><button aria-expanded="true">Module 1 Course Pages</button></div>' +
           '<ul><li><div><a href="/learn/matlab/lecture/cp1/course-preview">Course Preview</a></div></li></ul>' +
         '</div>' +
         '<div role="region" aria-label="Module 2 The MATLAB Environment">' +
           '<div role="heading" aria-level="3"><button aria-expanded="false">Module 2 The MATLAB Environment</button></div>' +
         '</div>' +
       '</nav>'
     );
     const regions = scraper.findModuleRegions(d);
     assert.equal(regions.length, 2);
     assert.equal(regions[0].title, 'Module 1 Course Pages');
     assert.equal(regions[0].expanded, true);
     assert.equal(regions[1].expanded, false);
   });
   ```

2. - [ ] Run the test and watch it FAIL: `node --test "tests/module-scraper.test.js"`. Expected: FAIL — `scraper.findModuleRegions is not a function`, AND the two accessibleName-status completion tests fail because `isCompleted` does not yet consult `courseraDom.itemStatus` (the `Completed`-token row reads `completed:false`; the `Not submitted` row with green styling reads `completed:true` off the green-RGB heuristic). (The gradedLti-row test and the green-RGB last-resort test pass already — the gradedLti one because Task 7 made `extractItemId` keep the id, the last-resort one because the existing green-RGB heuristic still fires when status is unknown; keep both as regression guards.)

3. - [ ] Edit `lib/module-scraper.js`. Add a defensive cross-env loader for `courseraDom` right after the `'use strict';` line (before the `CONTAINER_SELECTORS` const). Add:

   ```js
     const courseraDom = (function () {
       if (typeof module !== 'undefined' && module.exports) {
         try { return require('./coursera-dom.js'); } catch (_) { return null; }
       }
       return (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
     })();

     function findModuleRegions(doc) {
       if (courseraDom && typeof courseraDom.findModuleRegions === 'function') {
         return courseraDom.findModuleRegions(doc);
       }
       return [];
     }
   ```

4. - [ ] Route per-row completion through `courseraDom.itemStatus` and demote the green-RGB heuristic to a last-resort fallback (spec WS-A: "use coursera-dom for ... completion"; "the green-RGB heuristic is retained only as a last-resort fallback"). Change `isCompleted` (L379-385) — currently:

   ```js
     function isCompleted(anchor) {
       for (let i = 0; i < COMPLETED_SELECTORS.length; i++) {
         const el = anchor.querySelector(COMPLETED_SELECTORS[i]);
         if (isPositiveCompletionEl(el)) return true;
       }
       return !!findGreenCompletionElement(anchor);
     }
   ```

   to:

   ```js
     function isCompleted(anchor) {
       // PREFERRED signal: the item link's accessibleName status token. When the
       // accessibleName carries a recognized status, it is authoritative — a
       // 'completed' token means done, any other recognized status (not-submitted /
       // locked) means NOT done, and the green-RGB heuristic is not consulted.
       if (courseraDom && typeof courseraDom.itemStatus === 'function') {
         const status = courseraDom.itemStatus(anchor);
         if (status === 'completed') return true;
         if (status === 'not-submitted' || status === 'locked') return false;
         // status === 'unknown' -> fall through to the legacy signals below.
       }
       // Secondary signal: existing class / aria-label / data-testid completion markers.
       for (let i = 0; i < COMPLETED_SELECTORS.length; i++) {
         const el = anchor.querySelector(COMPLETED_SELECTORS[i]);
         if (isPositiveCompletionEl(el)) return true;
       }
       // LAST RESORT: the brittle green-RGB icon heuristic, only when no status token
       // and no explicit marker resolved the question.
       return !!findGreenCompletionElement(anchor);
     }
   ```

   Then make `findGreenCompletionIconInRow` (the row-completion evidence used by `completion-confirmer`, L463-479) prefer the accessibleName status before its class-marker / green-RGB search. Right after the `if (extractItemId(a.getAttribute('href')) !== itemId) continue;` line, add the status short-circuit so a recognized non-completed status suppresses the green-RGB fallback for that row:

   ```js
         // PREFERRED: accessibleName status. A recognized non-completed status
         // (not-submitted / locked) means this row is NOT done — do not fall through
         // to the green-RGB heuristic for it. A 'completed' token is positive evidence.
         if (courseraDom && typeof courseraDom.itemStatus === 'function') {
           const rowStatus = courseraDom.itemStatus(a);
           if (rowStatus === 'completed') return a;
           if (rowStatus === 'not-submitted' || rowStatus === 'locked') continue;
         }
   ```

   (Leave the existing class-marker loop and `findGreenCompletionElement(a)` fallback below this block unchanged; they run only when `rowStatus` is `'unknown'`.)

5. - [ ] Add `findModuleRegions` to the `api` export object (L665-682). Find the closing of the `api` object — the line `isBlockedAssessmentItem: isBlockedAssessmentItem,` — and add after it:

   ```js
       findModuleRegions: findModuleRegions,
   ```

6. - [ ] Run the test and watch it PASS: `node --test "tests/module-scraper.test.js"`. Expected: PASS — `findModuleRegions` is exposed and delegates to `courseraDom`; the `Completed`-token row reads `completed:true`; the `Not submitted` row reads `completed:false` despite green styling; the no-status-token row still falls back to the green-RGB icon (`completed:true`).

7. - [ ] Run the FULL suite: `npm test`. Expected: PASS — `fail 0`. (All existing exports preserved; `findModuleRegions` is additive. The completion change only adds a PREFERRED status branch ahead of the unchanged class-marker + green-RGB fallbacks; rows whose accessibleName has no recognized status token behave exactly as before, so existing per-row completion tests — which rely on class/aria markers or green icons, not status tokens — stay green. If a pre-existing fixture happens to set both a non-completed status token AND a completion marker, surface it here and reconcile by removing the contradictory token from that fixture.)

8. - [ ] Commit: `git add lib/module-scraper.js tests/module-scraper.test.js` then `git commit -m "feat(module-scraper): read completion from courseraDom.itemStatus (green-RGB demoted to last resort) + expose findModuleRegions + gradedLti-row regression fixture"`.

---

### Task 15: Final full-suite verification and Phase A green-gate

**Files:**
- Test: (whole suite) — no new production code; this task verifies the phase is shippable on its own.

Steps:

1. - [ ] Run the entire suite and confirm everything is green: `npm test`. Expected: PASS — `fail 0`, with `tests` equal to the prior `1253` plus the count of all tests added in Tasks 1-14. Confirm `cancelled 0`, `skipped 0`, `todo 0`.

2. - [ ] Confirm `lib/coursera-dom.js` exports exactly the 12 spec-frozen names and nothing extra, by running a one-off assertion file. Create `tests/coursera-dom-api-shape.test.js`:

   ```js
   // tests/coursera-dom-api-shape.test.js
   const test = require('node:test');
   const assert = require('node:assert/strict');
   const courseraDom = require('../lib/coursera-dom.js');

   test('courseraDom exposes exactly the 12 spec-frozen methods', () => {
     const keys = Object.keys(courseraDom).sort();
     const expected = [
       'assessmentRoot',
       'classifyKind',
       'findItemLinks',
       'findModuleRegions',
       'findNextItemButton',
       'findOutlineNav',
       'isExcludedNode',
       'isExternalLaunchPage',
       'itemStatus',
       'parseItemAccessibleName',
       'parseLearnUrl',
       'withinAssessment',
     ].sort();
     assert.deepEqual(keys, expected);
     expected.forEach(function (k) { assert.equal(typeof courseraDom[k], 'function', k + ' must be a function'); });
   });
   ```

3. - [ ] Run the shape test and watch it PASS: `node --test "tests/coursera-dom-api-shape.test.js"`. Expected: PASS — the API surface is exactly the 12 names. (If it fails because an extra key leaked into the export, remove that key from the `api` object in `lib/coursera-dom.js` and re-run.)

4. - [ ] Run the full suite one more time to include the shape test: `npm test`. Expected: PASS — `fail 0`.

5. - [ ] Commit: `git add tests/coursera-dom-api-shape.test.js` then `git commit -m "test(coursera-dom): pin the 12-method spec-frozen API surface; Phase A green gate"`.

---

## Out of scope for Phase A (do NOT implement here)

These belong to later phases and must be left byte-for-byte unchanged in Phase A so the existing 1253 tests stay green:

- **`Locked` -> skip-without-error wiring** (spec WS-A line 123 / error-handling table "Locked item | Skip-without-error"). Phase A PARSES the locked status — `courseraDom.parseItemAccessibleName(...).status === 'locked'` and `courseraDom.itemStatus(...) === 'locked'` (Task 2), and `module-scraper.isCompleted` treats a `locked` token as not-completed (Task 14) — but it deliberately does NOT wire `locked` into a non-error skip outcome in the run loop. The skip-without-error decision lives in `module-autopilot`'s per-item run loop / handler-outcome path (the same `buildOrderedQueue` / `isBlockedAssessmentItem` / handler-result machinery that this plan freezes), and Phase A treats all run-loop/handler outcome logic as frozen (see the first WS-C bullet below). Deferred to the phase that owns the run loop / handlers (WS-C), which will consume the already-parsed `locked` status to short-circuit a locked item with a non-error skip. The parsing groundwork is delivered here so WS-C can wire it without touching `coursera-dom`.
- **`pairHeaderWithPanel` lazy-load / virtualized tolerance** (spec WS-A line 122, function at `lib/module-scraper.js` L200). Adding tolerance for lazy-loaded / virtualized outline panels requires waiting for async DOM mutation (panels that materialize only after a header toggle or scroll) — behavior that the jsdom unit harness cannot exercise deterministically and that belongs with the live route-watching / scroll-driven scrape loop. Phase A delivers the synchronous `role=region`-based discovery (`courseraDom.findModuleRegions` + `module-scraper.findModuleRegions`, Task 14) that the expand-all logic keys off; the async lazy-load/virtualization hardening of the legacy accordion `pairHeaderWithPanel` path is deferred to the phase that owns the live scrape/scroll loop. `pairHeaderWithPanel` is left byte-for-byte unchanged here.
- Conditional un-blocking in `buildOrderedQueue` / `blockReasonLabel` / `isBlockedAssessmentItem` (WS-C).
- `ctx.aiGenerate`, the AI assessment handler, and the question-type system (WS-C).
- Adding `.mq-editable-field` to `answer-matcher.findTextInputs` and the label-wrapped `cds-` option fallback in `findOptionGroups` (WS-C).
- Provider-agnostic AI (`ai-providers.js`), options UI, and host-permission manifest changes (WS-B).
- Peer-review handler and comment pool (WS-D).
- Real-browser/Playwright CI against live Coursera (manual smoke only).
