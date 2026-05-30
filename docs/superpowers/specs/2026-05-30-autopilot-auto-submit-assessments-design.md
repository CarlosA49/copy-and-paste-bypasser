# Autopilot: Auto-Submit AI-Answered Assessments + Typed Text + Auto-Resume

**Date:** 2026-05-30
**Status:** Design — awaiting user review
**Topic:** Make "Auto-submit quizzes after autofill" actually open, AI-answer, type, submit, and continue through graded/ungraded assessments and peer reviews; add a green-check auto-resume for manual-answer pauses; improve AI accuracy and reduce stuck pauses.

---

## 1. Problem

The user enabled **"Auto-submit quizzes after autofill"** expecting the autopilot to open graded/ungraded assessments it would otherwise skip, answer them via the configured AI API key, type any free-text answers through the auto-typer, submit them, and continue — falling back to a manual pause (with auto-resume on completion) when no key is configured. Today none of that happens for AI-answered assessments:

- The AI handler **always fills and pauses** and **explicitly ignores** `autoSubmitQuizzes` (`lib/item-handlers.js:637` — *"ALWAYS pause for review — never auto-submit (ignores autoSubmitQuizzes)"*).
- Free-text answers are set **instantly via `.value`** (`lib/answer-applier.js:95` → `lib/answer-matcher.js:481`), never typed.
- The typing engine has a **`Fast` speed profile** (`lib/typing-engine.js:7-11`, `delayMul 0.72`) but **every caller hardcodes `Normal`**; fast mode skips typing entirely (direct assignment).
- The no-key path returns a **generic** `assessment-ai-no-answer` pause; there is **no auto-resume** — Resume is always manual (`resume()`, `lib/module-autopilot.js:1970`).
- **Peer reviews are still skipped in the live queue.** The Phase D `peerReview` handler is built and green in tests, but `buildOrderedQueue` never un-blocks peer-review (`lib/module-autopilot.js:121-122`, `!peerReview`); the Phase D tests bypass queue-building by seeding items directly (`tests/module-autopilot.test.js:7070`). So the handler is effectively unreachable in production.

> **Correction to project memory:** "Phase D peer-review auto-complete complete" is accurate for the *handler + outcome routing*, but the **live queue integration was never wired** — peer-review is still blocked in `buildOrderedQueue`. This spec closes that gap.

---

## 2. Goals / Non-goals

**Goals**
1. With `aiAnswerAssessments` on (key gated) **and** `autoSubmitQuizzes` on: open → AI-answer → type free-text → submit → continue, for quizzes/exams **and** peer reviews.
2. With `aiAnswerAssessments` on and `autoSubmitQuizzes` off: open → AI-answer/fill → **pause for review** (current behavior preserved).
3. **Free-text** answers (textarea / plain contenteditable — what `typing-injector.isEditable` accepts) are **typed via the auto-typer**: `Fast` speed in fast mode, `Normal` (unchanged) in human mode. Same for peer-review comments. Numeric/math/dropdown/single/multiple-choice keep the existing reliable direct-set/click path — char-by-char typing into MathQuill fields is unreliable and would hurt the accuracy goal.
4. **No API key** (or AI produced no answer) → pause with a clear manual-answer message, and **auto-resume** when the item shows complete (green check), then continue.
5. Targeted quality wins: **more accurate AI answers** (one retry pass for unmapped questions) and **fewer stuck pauses** (a graded-results completion signal).

**Non-goals**
- No changes to dwell-time ranges, inter-item gaps, or human-mode pacing (`lib/autopilot-timing.js`). "Faster fast mode" was de-prioritized; leaving these alone keeps regression risk low.
- No AI-generated peer-review comments — keep the canned pool (`lib/peer-review-replies.js`).
- No managed-credits work; personal-key path only.
- No new sidebar controls (only warning-text copy updates).

---

## 3. Behavior model (two toggles, combined)

**Un-block (open) rules:**
- **Quiz / exam** un-block when `aiAnswerAssessments` is on (key-gated capability; needs the API key to answer).
- **Peer review** un-blocks when **`aiAnswerAssessments` OR `autoSubmitQuizzes`** is on (canned comments need no key — **D1: either-toggle**).
- `autoSubmitQuizzes` then decides **submit + continue** vs **fill + pause-for-review** for both kinds.

| `aiAnswerAssessments` | `autoSubmitQuizzes` | Quiz / Exam | Peer review |
|---|---|---|---|
| off | off | skipped (blocked) | skipped (blocked) |
| off | on | skipped (needs key) | open → canned comments (typed) → **submit → continue** |
| on (key present) | off | open → AI fill / type → **pause for review** | open → select + type comments → **pause for review** |
| on (key present) | on | open → AI fill / type → **submit → continue** | open → select + type comments → **submit → continue** |
| on (no key) | off | open → **pause: needs-key** → auto-resume on green-check | open → select + type comments → **pause for review** |
| on (no key) | on | open → **pause: needs-key** → auto-resume on green-check | open → select + type comments → **submit → continue** |

> `aiAnswerAssessments` can be `true` in storage while no key is present (the sidebar unchecks the box on key-clear but doesn't rewrite storage — `setAiKeyStatus` gotcha). The handler handles this at runtime via the `missing-key` path, hence the "on (no key)" rows.

---

## 4. Outcome taxonomy changes

New handler outcomes and their classification in `isFailureOutcome` (`lib/module-autopilot.js:71`) and `FAILURE_REASON_TEXT` (`:169`):

| Outcome | Failure? (pause) | Arms auto-resume watcher? | User message |
|---|---|---|---|
| `assessment-ai-submitted` | **no** (advance, run confirmer) | — | — |
| `assessment-ai-needs-key` | yes | **yes** | "No AI API Key — answer it manually or via the *Answering for you* tab. I'll resume automatically when it's marked complete." |
| `assessment-ai-no-answer` (existing) | yes | **yes** | "No AI answer produced — answer manually or via *Answering for you*; I'll resume when it's complete." (updated copy) |
| `assessment-ai-no-submit-button` | yes | **yes** (D2) | "Answers filled — I couldn't find the Submit button. Click Submit and I'll continue once it's marked complete." |
| `assessment-ai-answered-paused` (existing) | yes | no | "AI filled the answers — review and submit, then Resume." (unchanged; review pause, **not** auto-resumed per user choice) |
| `peer-review-submitted` (existing) | no | — | — |
| `peer-review-filled-paused` | yes | no | "Peer review filled — review and submit, then Resume." |
| `peer-review-needs-user` (existing) | yes | **yes** | "Peer review needs you — complete it manually. I'll resume once it's marked complete." |

**Watcher-armed outcomes:** `{ assessment-ai-needs-key, assessment-ai-no-answer, assessment-ai-no-submit-button, peer-review-needs-user }`.

**Messaging requirement:** every watcher-armed pause MUST surface a clear, actionable on-screen message — what the user must do (click Submit / answer manually / use the *Answering for you* tab) **and** that the autopilot will auto-resume once the item is marked complete. This reuses the existing pause UI only: `sidebar.setAutopilotPaused(true, message)` for the banner plus a `sidebar.appendAutopilotLog(...)` line when the watcher arms (e.g. `"⏳ Waiting for you to complete this — I'll resume automatically when it's marked done"`). No new UI machinery. The messages above (in `FAILURE_REASON_TEXT`) already encode the "I'll continue once it's marked complete" hint; the needs-key / no-answer copy in the table gets the same hint appended.

---

## 5. Component design

### 5.1 Queue un-block — `lib/module-autopilot.js` `buildOrderedQueue` (:110)
- Read both flags from `settings`: `aiOn = !!settings.aiAnswerAssessments`, `autoSubmitOn = !!settings.autoSubmitQuizzes` (the full settings object is already passed via `_settingsForGate`, `:712`/`:929`).
- **Quiz / exam:** un-block + `aiAnswerable:true` tag when `aiOn` (unchanged).
- **Peer review (D1, either-toggle):** un-block when `aiOn || autoSubmitOn` — remove the `!peerReview` exclusion. No `aiAnswerable` tag (peer-review isn't AI-routed); it routes via `handlerForKind('peer-review')` → `handlers.peerReview`.
- Hard-skips (`_isHardSkipBlock`: programming/assignment/LTI) stay blocked regardless.

### 5.2 Applier `deferText` mode — `lib/answer-applier.js` `applyStructuredAnswers` (:327)
- Add `options.deferText` (default false → fully backward compatible; manual tab and quiz fallback don't pass it).
- When `deferText` is true: resolve `single_choice` / `multiple_choice` / `dropdown` / `math_input` / `numerical` / `input` / `code` **exactly as today** (direct-set/click — correctness for math/numeric). **Only `free_text`** is deferred: instead of `fillTextOnce(target, val)`, push `{ el: target, value: val, type:'free_text', questionNumber }` to a returned `pendingText` array and record a `status:'deferred-text'` result (not counted in `filled`).
- Return shape becomes `{ ...existing, pendingText }` (existing callers ignore `pendingText`).
- `summary.filled` continues to count choices/dropdowns/math; the handler adds `pendingText.length` after typing to compute total filled.

### 5.3 Typing helper — `lib/item-handlers.js`
- Add `typeIntoElement(el, value, mode, signal)` mirroring peer-review's `fillComment` (`lib/peer-review.js:162`): instantiate `TypingEngine`, `start({ text, target:el, profile:'Balanced Natural', speed: mode==='fast' ? 'Fast' : 'Normal', onTick → typingInjector.insertOrBackspace(el,event), onDone → resolve })`, dispatch `input`/`change` on completion, reject/resolve cleanly on `signal` abort. Returns a promise.
- `typingEngine` + `typingInjector` are already injected into `createHandlers`.

### 5.4 `assessmentAi` handler — `lib/item-handlers.js:579`
Replace the unconditional pause (step 7, `:637`) with:
1. **Missing-key distinction:** when `aiGenerate` resolves `{ ok:false, reason:'missing-key' }`, return `assessment-ai-needs-key` (instead of the generic `assessment-ai-no-answer`). All other non-ok / no-raw / no-mappable cases stay `assessment-ai-no-answer`.
2. **Accuracy retry (one pass):** after the validate → permissive chain, if `mappedCount < snapshot.actionableCount`, re-issue `aiGenerate` once for **only the unmapped question subset** (rebuild a sanitized snapshot containing just those questions) and merge any newly-mapped suggestions. Bounded to a single retry; failures are non-fatal (keep what we have).
3. **Apply + type:** call `answerApplier.applyStructuredAnswers(structured, region, { verbose:false, deferText:true })`. For each `pendingText` entry (free_text only), `await typeIntoElement(el, value, ctx.behaviorMode, ctx.signal)`, counting successes. Apply human-mode pre-fill dwell exactly as today (`:631`). `totalFilled = summary.filled + (typed free_text count)`.
4. **Submit branch:**
   - `ctx.autoSubmitQuizzes && totalFilled > 0`: find submit via `SUBMIT_SELECTORS` (`:510`). Found → click → return `{ outcome:'assessment-ai-submitted', filled: totalFilled }`. Not found → `{ outcome:'assessment-ai-no-submit-button', filled: totalFilled }`.
   - else → `{ outcome:'assessment-ai-answered-paused', filled: totalFilled }` (current behavior).
- Abort-safe: if `ctx.signal` aborts mid-typing, bail without submitting (the controller's `isCancelled()` guards already cover the post-handler path).

### 5.5 Peer-review — `lib/peer-review.js`
- `fillComment` (:162): in **fast** mode, type via `TypingEngine` at `speed:'Fast'` instead of direct assignment; **human** mode unchanged (`Normal`). Always dispatch `input`/`change`.
- Main handler (:219): honor `ctx.autoSubmitQuizzes`. When **on** → after filling, **submit → `peer-review-submitted`** (as today). When **off** (the default) → skip submit → **`peer-review-filled-paused`**. This intentionally changes today's *always-submit* behavior: peer reviews now pause-for-review unless auto-submit is on, consistent with the combined model. The `findSubmitControl` safety gate (:120, :245) still runs first; if no submit found → `peer-review-needs-user` (unchanged).
- Thread `autoSubmitQuizzes` from `ctx` into the handler (the controller already passes it in `ctx`, `lib/module-autopilot.js:1196`).
- **Test impact:** existing fast-mode peer-review tests assert direct-assign and unconditional submit — update them for typed-fast + `autoSubmitQuizzes` gating.

### 5.6 Auto-resume watcher — `lib/module-autopilot.js`
- Controller state: `_resumeWatcherTimer`, `_resumeWatcherItemId`.
- `_armResumeWatcher(itemId)`: clears any existing; starts a ~1500ms interval that checks completion evidence for `itemId` via a shared helper (`scraperMod.findGreenCompletionIconInRow(doc, itemId)` OR `courseraDom.itemStatus` of the row anchor === `'completed'`). On detection: disarm, `appendAutopilotLog('▶ Detected completion — resuming')`, call `resume()`. Guards: bail if `destroyed`, generation changed, or persisted status no longer `paused`.
- `_disarmResumeWatcher()`: clears timer + id. Called at: top of `runCurrentItem`, `stop()`, manual `pause()`, `resume()` entry, `destroy()`.
- **Install point:** in `runCurrentItem`'s failure-outcome pause path (`:1260-1285`), after persisting `paused` and calling `setAutopilotPaused(true, reasonText)`, if `WATCHER_ARMED_OUTCOMES[outcome.outcome]` (= `{assessment-ai-needs-key, assessment-ai-no-answer, assessment-ai-no-submit-button, peer-review-needs-user}`) → emit the waiting log line and `_armResumeWatcher(item.id)`. The banner text itself comes from `FAILURE_REASON_TEXT` (§4), which already encodes the actionable instruction + auto-resume hint for each of these outcomes.
- Resume correctness: `resume()` → `runCurrentItem` at same cursor → `alreadyCompleteIndicator` green-check check (`:1125-1127`) sees the now-complete item and advances. No special-case needed.

### 5.7 Completion robustness — `lib/completion-confirmer.js` + `lib/module-autopilot.js` + `lib/page-fallback.js`
- **Pass `courseraDom` into the confirmer (high-value, low-risk).** The confirmer already supports `accessible-status` + `nav-progressbar` evidence (`:56-88`) but the controller's two `confirmer.waitForCompletion({...})` calls (`module-autopilot.js:1313`, `:1405`) **omit `courseraDom`**, so those checks never run in production. Add `courseraDom: courseraDom` to both call sites. This alone materially reduces post-submit stalls.
- **Graded-results evidence (conservative):** add `pageFallback.findGradedResultsIndicator(doc)` matching a tight set of submitted/graded banners (e.g. an element whose trimmed accessible text matches `/grade received|your (?:latest )?grade|submission received/i`). In the confirmer loop, check it **only when `itemKind === 'quiz' || itemKind === 'exam'`**, ordered last (fallback) → low false-positive risk. Emits `evidence:'graded-results'`.

### 5.8 UI copy — `lib/sidebar.js`
- Update the AI-answer warning note (`data-role="autopilot-ai-answer-warning"`, ~:101) to: *"AI answers can be wrong. With Auto-submit off, answers are filled for your review. With Auto-submit on, the autopilot submits and continues. Without an API key, it pauses and resumes automatically once you complete the item."* No new controls.

---

## 6. Data flow (auto-submit, key present)

```
queue: aiAnswerable quiz → runCurrentItem
  → assessmentAi(ctx)
      buildQuestionSnapshot → sanitize → aiGenerate(key, server-side)
      validate → permissive → [retry unmapped once]
      applyStructuredAnswers(deferText) → choices/dropdowns set; pendingText returned
      for each pendingText: typeIntoElement (Fast|Normal)
      autoSubmit && filled>0 → click submit → 'assessment-ai-submitted'
  → isFailureOutcome=false → confirmer.waitForCompletion (incl. graded-results evidence)
  → advance cursor → navigate next
```

## 6b. Data flow (no key)

```
  → assessmentAi → aiGenerate {ok:false, reason:'missing-key'} → 'assessment-ai-needs-key'
  → isFailureOutcome=true → persist paused + message → _armResumeWatcher(item.id)
  → user answers manually / via "Answering for you" tab → submits → green check
  → watcher detects completion → resume() → runCurrentItem → already-complete → advance
```

---

## 7. Edge cases

- **Empty fill:** never submit when `totalFilled === 0` → `assessment-ai-no-answer` (then watcher).
- **Signal abort mid-typing:** `typeIntoElement` stops the engine and resolves; controller `isCancelled()` prevents submit/advance.
- **User manually pauses while watcher armed:** manual `pause()` disarms the watcher (we don't want to auto-resume a deliberately paused run).
- **Navigation while paused/no-key:** watcher keys off the **outline row** completion icon for `itemId`, robust to the visible page changing.
- **Multi-page quizzes:** out of scope — `SUBMIT_SELECTORS` targets the final submit; if a "Next" instead of "Submit" is present, no submit found → `assessment-ai-no-submit-button` (pause). Documented limitation.
- **Long free-text in fast mode:** typed char-by-char at `Fast` speed (slower than instant). Accepted per requirement ("type … but faster"); short math/numeric answers dominate in practice.
- **Retry pass loops:** strictly one retry; no recursion.

---

## 8. Testing strategy

Unit / integration (Node test runner, jsdom), mirroring existing suites:
- `buildOrderedQueue`: peer-review **un-blocked** when `aiAnswerAssessments` on; still blocked when off; programming/LTI stay blocked.
- `answer-applier`: `deferText` returns `pendingText` and does **not** set text values; choices/dropdowns still applied; default path unchanged.
- `item-handlers` `assessmentAi`: `missing-key` → `assessment-ai-needs-key`; auto-submit on + filled → `assessment-ai-submitted` + submit clicked; auto-submit off → `assessment-ai-answered-paused`; no submit button → `assessment-ai-no-submit-button`; text answers routed through `typeIntoElement`; `Fast` speed selected in fast mode, `Normal` in human; retry pass fires only when `mapped < actionable` and merges.
- `peer-review`: fast mode types (not direct-assign) at `Fast`; `autoSubmitQuizzes` off → `peer-review-filled-paused`; on → `peer-review-submitted`. Update existing fast-mode tests.
- `module-autopilot`: `assessment-ai-submitted` advances + runs confirmer; new pause outcomes classified correctly + reason text; **watcher** arms only for manual-answer outcomes, polls completion, calls `resume()`, advances; disarms on stop/manual-pause/navigation.
- `completion-confirmer`: graded-results evidence detected; no false positives on non-assessment pages.
- Full suite must stay green (baseline per memory: 1440 tests, 0 fail) and remain ≥ that count.

Verification discipline (per project memory): run tests redirected to a file and Read the file; confirm every commit landed; never trust batched/echoed tool output.

---

## 9. Files touched

- `lib/module-autopilot.js` — queue un-block, outcome taxonomy, watcher, install point.
- `lib/item-handlers.js` — `assessmentAi` rewrite (submit/type/needs-key/retry), `typeIntoElement` helper.
- `lib/answer-applier.js` — `deferText` mode.
- `lib/peer-review.js` — fast-mode typing, `autoSubmitQuizzes` gating, `peer-review-filled-paused`.
- `lib/completion-confirmer.js` — graded-results evidence; consume `courseraDom`/`itemKind`.
- `lib/page-fallback.js` — `findGradedResultsIndicator`.
- `lib/sidebar.js` — warning copy.
- `tests/*` — new + updated tests across the above.

## 10. Decisions (resolved)

- **D1 (peer-review gating): RESOLVED → either-toggle.** Peer-review un-blocks when `aiAnswerAssessments || autoSubmitQuizzes` (canned comments need no key). Quizzes/exams still require the key (gated on `aiAnswerAssessments`).
- **D2 (no-submit-button watcher): RESOLVED → yes.** `assessment-ai-no-submit-button` arms the auto-resume watcher (same "tool got stuck, not a pause I chose" case). Every watcher-armed pause shows an actionable banner + auto-resume hint via the existing pause UI (§4 messaging requirement).
