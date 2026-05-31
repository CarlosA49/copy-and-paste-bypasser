# Re-enable Scan / Generate / Apply on Graded or Blocked Assessment Pages — Design

**Status:** approved
**Date:** 2026-05-28
**Scope:** Chrome extension content script (sidebar + AI answer controller + AI question context) and the tests that pin the U11/U12/U13 lockdown.
**Out of scope:** Autopilot, options page, background service worker, manifest permissions, AI provider routing, commercial backend / managed credits.

---

## 1. Background

U11 (`2026-05-27`) added Manage AI API Key wiring + provider-neutral copy.

U12 (`2026-05-27-u12-blocked-scan-guard.md`) added a three-layer fail-closed lockdown:
- **Layer 1 — sidebar UI:** `_renderAiButtonStates()` disabled the Scan button when `_aiState.eligible === false`.
- **Layer 2 — controller:** `performScan`, `performGenerate`, `performApply` early-returned with a blocked-page status when `qc.isCurrentPageBlocked(loc, doc)` returned `{ blocked: true }`.
- **Layer 3 — question-context:** `buildQuestionSnapshot()` short-circuited and returned an empty ineligible snapshot when the page was classified blocked.

U13 (`2026-05-28-u13-scan-disable-live-diagnosis.md`) added a UI Revision label and diagnostic tests pinning the lockdown across realistic startup orderings.

**This change reverses U12 and U13's blocked-page lockdown** at the user's explicit request, while preserving U11 (Manage AI API Key wiring, sanitized open-options message, one-card visibility) and the U13 UI Revision label.

The classifier itself (`isCurrentPageBlocked`, `blockReasonFor`) stays exported from `lib/ai-question-context.js` but has no consumer in the sidebar, controller, or question-context paths after this change. Keeping it dormant preserves the option to re-introduce a soft warning later without rebuilding the detection logic.

---

## 2. Architecture

Three production files change, one new invariant:

- **`_aiState.eligible` is never set to `false` by any code path,** and no consumer in `lib/sidebar.js`, `lib/ai-answer-controller.js`, or `lib/ai-question-context.js` checks `=== false`.
- The status-pill copy `AI answer filling is disabled on graded or blocked assessment pages.` is no longer rendered.
- `buildQuestionSnapshot()` always returns a real snapshot from the live DOM.

### Affected files

| File | Change |
|---|---|
| `lib/sidebar.js` | `_renderAiButtonStates()` drops the `eligible === false` term from scan/generate/apply guards. Remove the U12 click-handler guard `if (scan.disabled) return;` inside `wireAiAnswer()`. Remove the status-text branch in `setAiPageEligibility` that renders the blocked-page message. |
| `lib/ai-answer-controller.js` | Delete the U12 blocked-page early-return blocks at the top of `performScan`, `performGenerate`, `performApply`. Also delete the `wire()` initial-eligibility call to `qc.isCurrentPageBlocked` (lines ~207-209); the first scan populates eligibility from the snapshot. The `fresh.page.eligible === false` dead branches in `performGenerate` (lines ~75-84) and `performApply` (lines ~127-130) become unreachable and are deleted with the rest. |
| `lib/ai-question-context.js` | Delete the `isCurrentPageBlocked` short-circuit at the top of `buildQuestionSnapshot`. Always build the snapshot from `detectQuestions`. Returned `page.eligible` is hard-set to `true` and `page.blockedReason` to `null`. |
| `tests/sidebar.test.js` | Delete U12-A1, A2, A3, A4. |
| `tests/ai-answer-controller.test.js` | Delete U12-B1..B5. Repurpose U12-B6 — drop its blocked-page precondition; assert Manage AI API Key click count is unaffected by `performScan` on any page. |
| `tests/ai-question-context.test.js` | Delete U12-C1, C2, C3, C4, **C6, C7, C8, C9, C10, C11** (visible-block markers). Keep C5 unchanged. |
| `tests/ai-answer-tab.test.js` | Delete U12-LIVE, U13-D1, U13-D2. Add one new positive-case test `U14-LIVE` (see Section 4). |

### Untouched

`manifest.json`, `background.js`, `lib/sidebar.css`, `lib/ui-revision.js`, `options.html`, `options.js`, all `lib/autopilot-*.js` / `lib/module-*.js` / `lib/item-handlers.js` / `lib/completion-confirmer.js`, `lib/ai-options-controller.js`, `lib/ai-background-service.js`, `lib/ai-content-listeners.js`, `lib/ai-open-options-content.js`, `lib/ai-open-options-background.js`, `lib/answer-applier.js`, `lib/question-detector.js`, `lib/deepseek-client.js`, `lib/managed-client.js`, and all their tests.

---

## 3. Per-file diffs

### 3.1 `lib/sidebar.js`

Replace `_renderAiButtonStates()` (currently around lines 1059–1081):

```js
function _renderAiButtonStates() {
  if (!shadow) return;
  const scan = shadow.querySelector('[data-action="ai-scan"]');
  const gen = shadow.querySelector('[data-action="ai-generate"]');
  const cancel = shadow.querySelector('[data-action="ai-cancel"]');
  const apply = shadow.querySelector('[data-action="ai-apply"]');
  if (scan) {
    scan.disabled = !!_aiState.inFlight;
  }
  if (gen) {
    var actionable = _aiState.snapshot ? (_aiState.snapshot.actionableCount || 0) : 0;
    gen.disabled = !!(
      !_aiState.keyPresent ||
      !_aiState.snapshot ||
      actionable === 0 ||
      _aiState.inFlight
    );
  }
  if (cancel) {
    cancel.hidden = !_aiState.inFlight;
    cancel.disabled = !_aiState.inFlight;
  }
  if (apply) apply.disabled = !(
    _aiState.suggestions && _aiState.suggestions.length > 0
  );
}
```

Remove the U12 click-handler guard added at `lib/sidebar.js:1103` inside `wireAiAnswer()`:

```js
// DELETE this block:
//   if (scan.disabled) return;
```

The existing `if (_aiState.inFlight) return;` further down the handler still prevents re-entry during a generate.

Remove the blocked-page status-text branch inside `setAiPageEligibility`. The function still accepts the call (controller still calls it after each scan) and still updates `_aiState.eligible`, but the value is always `true` in practice and the status-pill text reverts to the normal `Click Scan questions...` / `N supported question(s)...` flow.

### 3.2 `lib/ai-answer-controller.js`

Delete the U12 guard at the top of `performScan` (lines ~37–50 currently). The function reverts to its pre-U12 body — directly calls `qc.buildQuestionSnapshot(doc.body, loc, doc)`, sets `_activeSnapshot`, calls `sidebar.setAiPageEligibility({...})` with the snapshot's `eligible: true` / `blockedReason: null`, calls `sidebar.setAiScanResult(snap)`, `sidebar.setAiSuggestions(null)`, `sidebar.setAiApplyResult(null)`.

Delete the equivalent U12 guards at the top of `performGenerate` and `performApply`. The remaining `if (!_activeSnapshot) return;` / `if (!_activeSnapshot || !_activeSuggestions) return;` guards stay.

The controller no longer needs to call `qc.isCurrentPageBlocked` at all. Remove any unused local helper variables.

### 3.3 `lib/ai-question-context.js`

Delete the short-circuit at the top of `buildQuestionSnapshot` (currently around line 229):

```js
// DELETE:
//   var blockState = isCurrentPageBlocked(location, doc);
//   if (blockState.blocked) {
//     return { questions: [], supportedCount: 0, unsupportedCount: 0, actionableCount: 0,
//              localGuard: [], page: { eligible: false, blockedReason: blockState.reason },
//              token: 'snap_blocked_' + djb2(...) };
//   }
```

The function proceeds straight to `detectQuestions` and builds the snapshot normally. In the returned snapshot, hard-set `page.eligible = true` and `page.blockedReason = null` (no other code path produces `false` after this change).

`isCurrentPageBlocked` and `blockReasonFor` stay exported and unchanged. They have no in-tree caller after this change.

`sanitizeForRequest` is unchanged.

---

## 4. Test changes

### 4.1 Deletions

- `tests/sidebar.test.js` — U12-A1, U12-A2, U12-A3, U12-A4.
- `tests/ai-answer-controller.test.js` — U12-B1, B2, B3, B4, B5.
- `tests/ai-question-context.test.js` — U12-C1, C2, C3, C4. (Keep C5 unchanged.)
- `tests/ai-answer-tab.test.js` — entire `U12-LIVE` test, `U13-D1`, `U13-D2`.

### 4.2 Repurposing U12-B6

`U12-B6` originally asserted Manage AI API Key remained independent of `performScan` on a blocked page. After this change, drop the blocked-page precondition and rename the test:

```js
test('U14-B6: performScan does not affect Manage AI API Key click counting (independent of any page)', () => {
  // questionContext stub returns a benign empty snapshot (page.eligible: true).
  // ctrl.performScan(); then sidebar onOpenOptions click; openOptionsCalls === 1.
});
```

This preserves the integration assertion that the open-options path is decoupled from the scan path, without depending on the deleted blocked-page semantics.

### 4.3 New positive-case test

Append to `tests/ai-answer-tab.test.js`:

```js
test('U14-LIVE: rendered sidebar on /assignment-submission/.../attempt detects questions and Scan/Generate/Apply are enabled', async () => {
  // Mount the production sidebar + controller + question-context against the
  // same URL and five-question DOM that U12-LIVE used.
  // Assert:
  //   - shadow [data-action="ai-scan"]   .disabled === false
  //   - shadow [data-action="ai-generate"].disabled depends only on keyPresent + actionable
  //   - shadow [data-role="ai-status"] text does NOT contain
  //       'disabled on graded or blocked assessment pages'
  //   - native click on Scan renders >= 1 <li> into [data-role="ai-scan-preview"]
  //   - after performScan, snap.questions.length >= 1, snap.page.eligible === true
  //   - clicking Manage AI API Key still issues exactly one
  //       {type:'ccp.ai.openOptions'} message (U11 invariant preserved)
});
```

The U11 one-card visibility invariant is already covered by existing tests outside `U12-LIVE` (search `data-card="ai-card-managed"` in the test suite); no need to duplicate it here.

### 4.4 Regression target

After the changes:
- `npm test` is green.
- Net test count change: roughly -28 (deleted U12/U13 assertions, including six visible-block C-tests) +1 (U14-LIVE) +0 (U12-B6 renamed in-place to U14-B6).
- No Autopilot, `ui-revision`, or AI-options/background/listeners test is touched.

---

## 5. Order of operations

1. Delete U12/U13 tests per §4.1 so `npm test` doesn't break loudly during production edits.
2. Edit `lib/ai-question-context.js` per §3.3. Run `node --test tests/ai-question-context.test.js` — green.
3. Edit `lib/ai-answer-controller.js` per §3.2. Run `node --test tests/ai-answer-controller.test.js` — green.
4. Edit `lib/sidebar.js` per §3.1. Run `node --test tests/sidebar.test.js` — green.
5. Repurpose U12-B6 → U14-B6 per §4.2.
6. Add `U14-LIVE` test per §4.3. Run it — green.
7. Run `npm test` — every file green.
8. Live verification: reload extension at `chrome://extensions`, navigate to
   `https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt`,
   confirm Scan / Generate / Apply are enabled, Scan renders question prompts into the preview, and (with a configured key) Generate sends a request.

---

## 6. Risks (named, accepted)

- **Privacy.** Prompt text from any visited page, including real graded assessments, will be sent to the configured AI provider when Generate is clicked. U11/U12 treated this as a hard non-negotiable; the user has explicitly chosen to accept it.
- **Policy.** Coursera's Honor Code prohibits using AI on graded work. Enabling the buttons does not authorize the conduct; that concern lies outside this code change.
- **Coverage loss.** Deleting `U12-LIVE` removes the only cross-cutting end-to-end test that exercised sidebar + controller + question-context on a realistic URL. The new `U14-LIVE` covers the positive case but does not assert "no `generateAnswers` command leaks during scan" the way U12-LIVE did. Unit tests on each layer remain the safety net.
- **Reversibility.** Clean. `isCurrentPageBlocked` / `blockReasonFor` remain exported, so a future plan can re-introduce a soft warning banner (the rejected Option A from brainstorming) in well under 50 lines.

---

## 7. Hard non-goals

- No change to the AI provider, model, request shape, or any network endpoint.
- No new `manifest.json` permissions / host_permissions / CSP / web_accessible_resources.
- No change to Autopilot, `lib/answer-applier.js`, `lib/question-detector.js`, `lib/module-scraper.js`, options page, background service worker.
- No commercial backend / managed credits / portal / ledger / pricing / payment work.
- No real API key entered or embedded.
