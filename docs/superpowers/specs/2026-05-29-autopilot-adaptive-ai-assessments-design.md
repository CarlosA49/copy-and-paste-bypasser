# Adaptive Autopilot + AI Assessment Answering — Design

**Status:** Approved (brainstorming session 2026-05-29). Ready for implementation planning.
**Approach:** ① Incremental hardening + shared adaptivity utilities (keep the existing IIFE / `window.ClipboardCleaner.*` structure and the 1253 passing tests; refactor brittle internals in place; add two small shared utilities + new handlers).

## Goal

Make the existing Coursera autopilot **work reliably and adapt to any Coursera course** — arbitrary numbers of modules, arbitrary lesson types and counts per module, and Coursera DOM variation — and give it the ability to **answer graded and practical assessments with AI**, behind an explicit toggle (off by default) that reuses the existing "Manage AI API Key" pipeline. The AI pipeline becomes **provider-agnostic** (OpenAI / Anthropic / Gemini / DeepSeek / custom OpenAI-compatible endpoint). Peer reviews get a dedicated auto-complete-and-submit path. The hard boundary is **Coursera only** — no generic "any learning site" layer, and the extension never acts on non-Coursera origins.

## Decisions log (from brainstorming)

| Question | Decision |
|---|---|
| Overall approach | ① Incremental hardening + shared adaptivity utilities. Preserve existing module structure, tests, and the IIFE pattern. |
| Provider model | **Provider-agnostic BYOK.** Pluggable adapter registry; the user picks a provider and supplies a key for it. DeepSeek becomes one adapter, not the hardcoded client. Providers: OpenAI, Anthropic, Gemini, DeepSeek, **+ custom OpenAI-compatible endpoint** (base URL + model). |
| Platform scope | **Coursera only, but adaptive across all of Coursera** (graded + practical). Never target non-Coursera sites. No generic LMS abstraction layer. |
| AI assessment answering | **Explicit toggle, OFF by default**, and **disabled until a key is configured**. |
| In-page quizzes/exams (graded or practical) | AI **fills answers, then PAUSES for the user's review**. Never auto-submits. |
| External LTI tools + programming labs | **Skip and continue** (logged; never silently missed). The extension cannot answer external-tool launches. |
| Peer reviews | **Special auto-complete path:** select the **highest-scoring rubric option** per criterion; fill every required comment from a pool of ~20 varied, human-sounding review comments (high perplexity/burstiness, varied wording + length, padded to satisfy minimum-length); then **auto-submit**. |
| Question-type scope | **Everything** — choice, numeric/math, free-text/essay, dropdown, matching, ordering, code, file upload. Honest semantics: choice/numeric/math/free-text/dropdown/matching/ordering are fully automatable; **code = best-effort then pause**; **file upload = always pause** (cannot fabricate a file). |
| Human vs Fast behavior | In **Human** mode, inject randomized multi-second pauses/jitter while filling and before submitting (assessments + peer reviews) so it does not look automated. **Fast** mode stays quick. |
| Key persistence | Unchanged from today (session-only by default; "Remember on this browser" persists to `chrome.storage.local`). No new default. |

## Background — current architecture (grounded in code + DOM extraction)

Chrome MV3 content-script app scoped to `coursera.org`. ~30 `lib/*.js` IIFE modules load in fixed order at `document_start` and attach to `window.ClipboardCleaner.*`. `content.js` orchestrates; `background.js` is the service worker with three `onMessage` listeners (`autopilot.state` authority, `ccp.ai.request` AI service, `ccp.ai.openOptions` nav).

Three subsystems:

1. **Autopilot core** — `module-autopilot.createAutopilot(opts)` walks a course: `start({scope})` → `module-scraper.scrapeModule(doc)` → `buildOrderedQueue` (drops completed; **tags every assessment `blocked:true`**) → fenced run lifecycle via `autopilot-authority` (single writer) reached cross-realm by `autopilot-messenger` → `runCurrentItem` picks `handlerForKind(kind)` → `item-handlers` → `completion-confirmer.waitForCompletion`.
2. **Answer engine** — `answer-applier.applyAnswers(rawText)` / `applyStructuredAnswers(list)` → `question-detector.detectQuestions` → fill via `answer-matcher`. `numbered-parser`/`answer-parser`/`value-normalize`/`math-normalize`/`html-cleaner` are helpers.
3. **AI pipeline (sidebar-only today)** — `ai-answer-controller` drives Scan→Generate→Apply: `ai-question-context.buildQuestionSnapshot` → messenger `generateAnswers` → `ai-background-service.readKey()` → `deepseek-client` POST to `api.deepseek.com` (key only in `Authorization: Bearer`). Validated by `ai-answer-validator` → `ai-answer-permissive` → raw-text fallback, applied via `answer-applier`.

**The critical seam:** the autopilot core and the AI pipeline are completely decoupled. The only autopilot→answer bridge is `ctx.getAnswerText()` / `ctx.getLastCleanedCopy()` (`module-autopilot.js:1089-1090`) feeding `item-handlers.fallback` (`item-handlers.js:509-526`) with **manually pasted** text — never AI.

**The load-bearing enabler:** the background `generateAnswers` command is **un-gated** (`ai-background-service.js:142`) and reads the key entirely server-side. A content script only ever passes a sanitized snapshot and receives raw model JSON — it never sees the key. **So the autopilot run loop can reuse the exact Manage-API-Key pipeline with zero new key exposure and no new auth surface.**

### Stable DOM invariants (proven by `Study the files/dom-extraction-ex_mpqxgj5l_aneblp.json`)

- **URL grammar:** `/learn/{courseSlug}/{kind}/{id}/{itemSlug}` where `kind ∈ {home, lecture(=Video), supplement(=Reading), ungradedWidget(=Ungraded Plugin), gradedLti(=Graded App Item/LTI), quiz, exam, peer, assignment, …}`.
- **`accessibleName` grammar** on each item link: `"Kind, Title, Status[, lock reason], Duration"` — e.g. `"Reading, Recommended Textbook, Completed, 10 min"`, `"Video, Scripts, Not submitted, 4 min"`, `"Reading, Solution to valid_date, Locked, Complete previous item to unlock, 10 min"`. Status vocabulary: `Completed | Not submitted | Locked`.
- **Outline nav:** a `role=navigation` landmark; each module is a `role=region` `"Module N Title"` with a `role=heading` level-3 toggle button (`interactions: ['clickable','expandable']`); items are `<a role=link>` with stable `href` in `ul>li>div>a`. In-body progression: `role=button` `"Go to next item"`.
- **Design system:** Coursera controls carry `cds-` / `rc-` class **prefixes** (e.g. `cds-checkboxAndRadio-input`, `cds-button-primary`); hashed suffixes (`css-0`, `cds-NN`) and `react-aria` generated ids are **volatile**. Semantic ids exist occasionally (`#agreement-checkbox-base`). Chrome controls expose `data-testid` (`drawer-toggle-button`, `coach-chat-launcher-button`, …).
- **gradedLti body shape:** an honor-code checkbox + a `role=form` `"Launch App"` posting to an external tool (`learningtool.mathworks.com/lti/oidc`). **No in-page answer inputs.** Must branch on URL kind / presence of a Launch-App form, not on `heuristicPageType` (which mis-classified this page as "dashboard").
- **Contamination (critical):** the page DOM contains the extension's **own** sidebar (`ccp-host`: radios `name=ccp-behavior`, checkboxes, `"Paste an answer"` textarea) and the **Boost support chat** (`#boostai-chat-panel-composer`, `Boost-ChatPanel-*`, `Send`). These masquerade as quiz radios/checkboxes/textareas/submit buttons and **must be hard-excluded** before any scan/fill/submit.

### What is broken today (the "fix" half)

1. **`ungradedWidget` items vanish:** `module-scraper` `KIND_BY_SEGMENT` has no `ungradedWidget` entry; `extractItemId` returns `null` for unmapped segments → real lessons silently dropped from the queue.
2. **All assessments structurally excluded:** `isBlockedAssessmentItem` (`BLOCKED_KINDS` + `BLOCKED_URL_PATTERNS`) forces every quiz/exam/peer/programming/gradedLti item to `blocked:true`; `buildOrderedQueue` keeps them only as skip placeholders.
3. **Zero AI wiring in autopilot:** the only quiz handler (`fallback`) sources answers from pasted text; no snapshot build, no `generateAnswers`.
4. **Completion detection is fragile:** `page-fallback` `MARK_COMPLETE_RE`/`NEXT_ITEM_RE`/`PROGRESS_RE` require exact English whole-string matches; `module-scraper` falls back to a hardcoded green-RGB heuristic. The real signal lives in the `accessibleName` status token + nav progressbar.
5. **Navigation assumes `/learn/` anchors + 100ms pushState:** `navigate()`/`navigateAndConfirm()` match `a[href*="/learn/"]` with a 100ms URL-change timeout; LTI launches and "Go to next item" are buttons; slow SPA routes fall through.
6. **No body-shape branching:** `item-handlers.assignment` ticks the agreement checkbox and pauses but never recognizes "this is an external LTI launch, not an answerable quiz."
7. **No exclusion of extension UI / support chat** in `question-detector` / `answer-matcher` / `ai-question-context`.
8. **Question routing number-coupled + ceiling-capped:** `HEAD_RE` requires literal English `"Question N"` (≤99); `numbered-parser` rejects n>50, `answer-parser` rejects n>20 (inconsistent). Single-question pages, localized labels, sub-parts (1a/1b), and >50-question exams break.
9. **Choice/math detection split-brained:** `answer-matcher.findOptionGroups` needs native inputs or `role=radio`; `cds-` options are often label-wrapped divs/buttons. `question-detector.findEditableTargets` includes `.mq-editable-field` but `answer-matcher.findTextInputs` does not (MathQuill fields undetectable to the matcher).
10. **Blanket math normalization corrupts plain text:** `answer-applier` runs `normalizeMathAnswer()` on every non-textarea single-target input, mangling short word/acronym answers.
11. **Provider/model/prompt locked to DeepSeek** with an "ungraded practice form" system prompt and only 3 question types.

## Architecture overview (after this work)

```
[Autopilot run loop]                         [AI pipeline — provider-agnostic]
module-autopilot.runCurrentItem(item)
  ├─ coursera-dom: classify kind from URL + accessibleName  (NEW shared util)
  ├─ handlerForKind(kind)
  │    ├─ video / reading / discussion        (existing, hardened)
  │    ├─ assessment-ai  (NEW)  ── ctx.aiGenerate(snapshot) ──► chrome.runtime.sendMessage
  │    │     build snapshot (ai-question-context, scoped+excluded)        {ccp.ai.request,
  │    │     validate → permissive → raw fallback                          generateAnswers}
  │    │     apply (answer-applier, typed per question-type)                     │
  │    │     PAUSE for review                                                    ▼
  │    ├─ peer-review   (NEW)  highest rubric option + pooled comments    ai-background-service
  │    │     → AUTO-SUBMIT                                                  readKey() (server-side)
  │    └─ lti/programming → SKIP + continue                                        │
  └─ completion-confirmer (accessibleName status + progressbar)            ai-providers.get(provider)  (NEW)
                                                                             ├─ openai / anthropic / gemini
                                                                             ├─ deepseek (refactored)
                                                                             └─ custom (OpenAI-compatible)
```

Two new shared utilities: **`lib/coursera-dom.js`** (DOM scope/exclusion + Coursera URL & `accessibleName` parsers + role/region locators) and **`lib/ai-providers.js`** (provider adapter registry). Everything else is hardening of existing modules + two new handlers + one new pool module.

---

## WS-A — Adaptive Coursera DOM layer

### New module `lib/coursera-dom.js`
Pure, DOM-reading helpers (testable in jsdom), used by `module-scraper`, `question-detector`, `answer-matcher`, `ai-question-context`, `page-fallback`, and `module-autopilot`.

```
window.ClipboardCleaner.courseraDom = {
  // URL grammar
  parseLearnUrl(url) -> { courseSlug, kind, id, itemSlug } | null   // /learn/{slug}/{kind}/{id}/{itemSlug}
  classifyKind(urlOrSegment, accessibleName?) -> kind               // URL segment first, accessibleName cross-check
  // accessibleName grammar: "Kind, Title, Status[, lock reason], Duration"
  parseItemAccessibleName(name) -> { kindToken, title, status, lockReason, durationText }
  itemStatus(name|element) -> 'completed' | 'not-submitted' | 'locked' | 'unknown'
  // scope + exclusion
  isExcludedNode(el) -> boolean        // under #ccp-host-root, /html/div outside body, Boost-ChatPanel, #boostai-chat-panel-composer
  assessmentRoot(doc) -> Element       // the Coursera app root region, excluding nav/aside/extension/chat
  withinAssessment(el) -> boolean
  // role/region locators
  findOutlineNav(doc) -> Element|null
  findModuleRegions(doc) -> [{ region, title, headingToggle, expanded }]
  findItemLinks(regionOrDoc) -> [a]    // ul>li>div>a, href + accessibleName
  findNextItemButton(doc) -> Element|null   // role=button "Go to next item" (locale-tolerant)
  // launch detection
  isExternalLaunchPage(doc, url) -> boolean // gradedLti OR role=form "Launch App"/"Launch app"
}
```

**Design rules baked in:**
- **URL grammar is the source of truth.** `KIND_BY_SEGMENT` extended to include `ungradedWidget` (→ kind `plugin`, treated like reading), `home`, `quiz`, `exam`, `peer`, `assignment`, `programming`, `gradedLti`. **Unknown segments map to kind `other` and KEEP the id** (never `null`) so new/renamed segments stay in the queue.
- **`accessibleName` parsing is locale-tolerant** (comma tokenization + numeric extraction; status matched by a small multilingual set with English default, plus an aria-state fallback). Completion read from the status token and the nav progressbar — **the green-RGB heuristic is retained only as a last-resort fallback.**
- **`isExcludedNode` is applied before every scan/fill/submit** in `question-detector`, `answer-matcher` (`findOptionGroups`/`findTextInputs`), and `ai-question-context`.
- **Locators prefer role + `accessibleName` + `cds-`/`rc-` prefixes**, never hashed suffixes / `react-aria` ids / nth-of-type. Navigate by stable `href`; resolve items within their module region (titles repeat across modules).

### Hardening of existing modules (WS-A)
- `module-scraper.js`: use `coursera-dom` for kind/id/completion; extend segment map; expand-all keys off `role=region` heading toggles with `aria-expanded`; add lazy-load/virtualized tolerance in `pairHeaderWithPanel`.
- `page-fallback.js` / `completion-confirmer.js`: replace whole-string English regexes with substring/aria-first matching via `coursera-dom`; treat `Locked` as skip-without-error.
- `module-autopilot.js`: navigate by href + recognize "Go to next item"; widen `navigateUrlChangeTimeoutMs` with interstitial tolerance and confirm by URL + expected item id; branch on `coursera-dom.isExternalLaunchPage`.

---

## WS-B — Provider-agnostic AI

### New module `lib/ai-providers.js`
Background-safe (no DOM). A registry of adapters with a common interface:

```
adapter = {
  id,                 // 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'custom'
  label,              // human label for the options UI
  defaultModel,
  models,             // suggested model list (free-text override allowed)
  endpoint(opts),     // resolves request URL (custom: from stored base URL)
  buildRequest(sanitizedSnapshot, apiKey, opts) -> { url, method, headers, body },
  parseResponse(json) -> { ok, raw }   // normalize to the existing {ok, raw} contract
}
window.ClipboardCleaner.aiProviders = { get(id) -> adapter, list() -> [{id,label,models,defaultModel}] }
```

- **`deepseek-client.js` is refactored into the `deepseek` adapter.** Its request/response shape and the existing `{ok, raw}` contract are preserved so `ai-answer-controller` / validators are untouched.
- **`openai`, `anthropic`, `gemini`** adapters implement each provider's chat/JSON API. **`custom`** is an OpenAI-compatible adapter taking a user-supplied base URL + model.
- **System prompt is generalized** beyond "ungraded practice form" and beyond 3 question types — it requests a **typed answer schema** (see WS-C question-type system). The JSON-mode requirement (literal word "json" + example schema) is preserved per adapter where the provider needs it.

### Background changes
- `background.js` / `ai-background-service.js`: `clientFactory` → `aiProviders.get(storedProvider)`. New storage key `ccp.ai.provider` (default `deepseek` for back-compat) + per-provider model key `ccp.ai.model.{provider}` (`chrome.storage.local`). `generateAnswers` reads provider + model + key server-side; key handling unchanged.

### Options UI (`options.html` / `ai-options-controller.js`)
- Add a **provider `<select>`**, a **model field** (datalist of suggested models, free-text allowed), and a **custom base-URL field** (shown only when provider = custom). Reuse the existing key field / Remember / Save / Clear and the `setSessionKey`/`setAccessMode` gating. New command `setProvider` (gated by `canManageSecretsStrict`, like the other mutators).

### Manifest
- Add `host_permissions` for `https://api.openai.com/*`, `https://api.anthropic.com/*`, `https://generativelanguage.googleapis.com/*` (keep `https://api.deepseek.com/*`).
- Add **`optional_host_permissions: ["https://*/*"]`** for the custom endpoint, requested at runtime via `chrome.permissions.request` when the user saves a custom base URL (so we don't ship a broad always-on grant).

---

## WS-C — AI-driven assessment answering (the headline feature)

### Sidebar toggle (Autopilot tab)
- New control **"Answer graded & practical assessments with AI"** — **off by default**, **disabled unless `setAiKeyStatus` reports `keyPresent: true`**, with a visible warning line ("AI answers can be wrong; graded answers are filled for your review, never submitted automatically").
- Persisted as `settings.aiAnswerAssessments` in `autopilot-state` `defaults()`/migration and threaded through `autopilot-authority`'s run-state shape (the authority drops unknown run fields — must be added explicitly).

### Un-block gating (`module-autopilot.js` / `module-scraper.js`)
- `buildOrderedQueue` / `blockReasonLabel` / `isBlockedAssessmentItem` become **conditional**: when `settings.aiAnswerAssessments === true` AND a key is present, route **answerable** items to the AI handler; route `peer` to the peer-review handler; keep external-launch and `programming` **skipped**. When the toggle is OFF, behavior is exactly as today (all assessments skipped).
- **Answerability rule (kind-agnostic, body-shape-driven):** an item is *answerable* iff `coursera-dom.isExternalLaunchPage` is **false** AND the assessment region contains at least one answerable input after exclusion. This correctly separates in-page **Graded Assignment** items (e.g. "Graded Assignment, Lesson 2 Wrap-up") and `quiz`/`exam` items — which are answerable — from **Graded App Item / gradedLti** external launches (e.g. the MATLAB MathWorks tool) — which are not. We do not rely on the URL segment alone to decide answerability, only to pre-classify; the body shape is authoritative.

### Submit-policy interaction (removes ambiguity)
- **AI-answered in-page assessments ALWAYS fill-then-pause and never auto-submit**, regardless of the existing `autoSubmitQuizzes` setting. This is the user's explicit Q1 choice.
- The pre-existing **`autoSubmitQuizzes`** toggle continues to govern only the **legacy manual-paste fallback** path (`item-handlers.fallback`) — it is left unchanged and does not affect the AI path.
- **Peer review** is the single deliberate exception that auto-submits (WS-D), driven by the `aiAnswerAssessments` toggle, not by `autoSubmitQuizzes`.

### AI generate channel into `ctx`
- `createAutopilot` accepts an injected **`aiGenerate(snapshot) -> Promise<{ok, raw}>`** (wraps `chrome.runtime.sendMessage({type:'ccp.ai.request', command:'generateAnswers', params:{snapshot}})`). `content.js` already builds this exact messenger in `setupAiAnswerController`; **share it** rather than duplicate. `ctx.aiGenerate` is exposed alongside `getAnswerText`. MV3 worker eviction / errors surface as a **recoverable pause**, not a crash.

### AI assessment handler (`item-handlers.js`)
Flow for an answerable in-page assessment:
1. Confirm not an external launch (`coursera-dom.isExternalLaunchPage` false) and the assessment region has answerable inputs.
2. Build snapshot via `ai-question-context.buildQuestionSnapshot` + `sanitizeForRequest` (scoped to `assessmentRoot`, excluding extension/chat nodes).
3. `ctx.aiGenerate(snapshot)` → `{ok, raw}`.
4. Validate: `ai-answer-validator` → `ai-answer-permissive` → raw-text fallback (same chain as the manual path).
5. Apply via `answer-applier.applyStructuredAnswers` (typed) / `applyAnswers`.
6. **PAUSE for review** (outcome `assessment-ai-answered-paused`). Never auto-submit.
7. **Human-mode timing:** if `behaviorMode === 'human'`, add randomized inter-field and pre-pause dwell from `autopilot-timing`.

### Extensible question-type system
The detector classifies each in-region question into a **type**; the AI prompt requests a **typed answer**; the applier has a per-type strategy.

| Type | Detect | Apply | Status |
|---|---|---|---|
| `single_choice` | radio group / single-select `cds-` option group | tick one | full |
| `multiple_choice` | checkbox group | tick all matches | full |
| `numeric` / `math` | numeric input / `.mq-editable-field` (MathQuill) | set value (math-normalize **only here**) | full |
| `free_text` / `essay` | `textarea` / contenteditable | type generated text | full |
| `dropdown` | `<select>` / `cds-` listbox | choose option by text | full |
| `matching` | paired control groups | map left→right | full |
| `ordering` | reorderable list / rank inputs | set order | full |
| `code` | code editor / code textarea | fill generated code, **then pause** (correctness not guaranteed) | best-effort |
| `file_upload` | `input[type=file]` | **always pause** — cannot fabricate a file | pause-only |

- New `answer-applier`/`answer-matcher`/`question-detector` capabilities to support the added types; **math-normalization is scoped to `numeric`/`math` only** (fixes plain-text corruption); `.mq-editable-field` added to `answer-matcher.findTextInputs`; a **label-wrapped clickable fallback** added to `findOptionGroups` for `cds-` options lacking `role=radio`; questions detected **by container ordinal** when no literal "Question N"; parser ceilings unified.
- Any question the system cannot confidently answer (low-confidence type, `code`, `file_upload`) is left for the user and the handler still **pauses for review** rather than submitting a guess.

---

## WS-D — Peer-review auto-complete

### New modules
- **`lib/peer-review.js`** — the handler + rubric/comment detection (scoped via `coursera-dom`, excluding extension/chat nodes).
- **`lib/peer-review-replies.js`** — a pool of **~20** generic, domain-neutral, human-sounding review comments. Varied sentence length (burstiness), occasional non-stock word choice (perplexity), none mentioning a specific topic/AI/Coursera. `pickComment(history, minLength, random) -> string` avoids recent picks and **pads to `minLength`** by appending another varied pool sentence when the page enforces a minimum.

### Handler flow
1. Detect rubric criteria within the peer-review region.
2. For each criterion, **select the highest-scoring option**: parse a numeric score from each option's text/aria (e.g. `"2 points"`, `"Excellent"` mapped where points are adjacent); pick max. If no numeric points are detectable, fall back to the last option (Coursera typically orders highest last) and **log the fallback as low-confidence** so the user can see what was chosen.
3. For each required comment/text box, `peer-review-replies.pickComment(history, detectedMinLength, rng)`; type it (TypingEngine in Human mode; direct set in Fast mode); push to history (FIFO cap).
4. **Auto-submit** the peer review (locate the submit control by role + `cds-` button prefix + locale-tolerant text). Outcome `peer-review-submitted`.
5. **Human-mode timing:** randomized inter-criterion / inter-field dwell + a pre-submit pause when `behaviorMode === 'human'`.

> Note: peer-review auto-submit is the deliberate exception to WS-C's fill-and-pause rule, per the user's explicit instruction. The rubric-scoring decisions are surfaced in the run log.

---

## Cross-cutting

### Settings / state schema additions
- `autopilot-state` `defaults().settings`: add `aiAnswerAssessments: false` (existing `pauseOnUserInput`, `autoSubmitQuizzes`, `behaviorMode` unchanged). Migration leaves it `false` for existing stored state.
- `autopilot-authority` run-state shape: thread `aiAnswerAssessments` through `_runDefaults`/`_writeRun` so it is not silently dropped.
- New storage keys (AI): `ccp.ai.provider`, `ccp.ai.model.{provider}`.

### Outcome tokens + redaction
- Add to `isFailureOutcome` / `FAILURE_REASON_TEXT`: `assessment-ai-answered-paused`, `assessment-ai-no-answer`, `assessment-skipped-lti`, `assessment-skipped-programming`, `peer-review-submitted`, `peer-review-needs-user`. Non-failure outcomes must not be treated as generic failures.
- Add any new answer/prompt/snapshot fields to `autopilot-debug` `FORBIDDEN_KEYS` so they stay redacted from the Diagnostics report.

### Run log transparency
- Log lines for: each AI-answered question count + "paused for review", each peer-review criterion selection (with low-confidence flags), each skip (LTI/programming) with reason.

## Data flow — AI answer during autopilot

```
runCurrentItem(item: quiz/exam)
  → assessment-ai handler
     → ai-question-context.buildQuestionSnapshot(assessmentRoot, excludeFn)   [content]
     → ctx.aiGenerate(snapshot)
         → chrome.runtime.sendMessage {ccp.ai.request, generateAnswers, {snapshot}}
            → ai-background-service: readAccessMode → readKey (session|local)   [background]
            → aiProviders.get(ccp.ai.provider).buildRequest(snapshot, key, {model})
            → fetch provider endpoint (Authorization/x-api-key header only)
            → parseResponse → {ok, raw}
         ← {ok, raw}                                                            [content]
     → validate (validator → permissive → raw fallback)
     → answer-applier.applyStructuredAnswers (typed, scoped, excluded)
     → PAUSE (outcome: assessment-ai-answered-paused)
```
The API key never leaves the background worker. The content script only sends a sanitized snapshot and receives normalized JSON.

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Toggle ON but no key | Toggle is disabled; if somehow on, assessment handler logs `assessment-ai-no-answer` and pauses with "Configure an AI API Key (Manage AI API Key)". |
| MV3 worker evicted / `generateAnswers` error | Recoverable pause, not crash; Resume retries. |
| External LTI launch / programming lab | Skip + continue; log reason. |
| `ungradedWidget` / unknown segment | Stays in queue (kind `plugin`/`other`); reading-style/no-op handling, never the quiz path. |
| Locked item | Skip-without-error. |
| Question with no answerable input | Pause for review; never guess. |
| `code` / `file_upload` question | `code`: fill best-effort then pause. `file_upload`: always pause. |
| Peer-review min-length not met | `pickComment` pads from the pool until min-length satisfied. |
| Peer-review no detectable point values | Fallback to last option, flagged low-confidence in the log. |
| Extension UI / Boost chat controls present | Hard-excluded from all detection/fill/submit. |
| Provider returns malformed JSON | Validator chain → permissive → raw-text fallback → if still nothing, `assessment-ai-no-answer` + pause. |
| Custom endpoint without host permission | Save flow requests `optional_host_permissions`; if denied, custom provider disabled with a clear message. |
| Non-Coursera origin | Content scripts never match; open-options gate rejects. No behavior. |

## Security / privacy / ethics

- API key stays server-side (background worker → provider `Authorization`/`x-api-key` header). Never returned to, stored in, or visible to any content script or the sidebar. `setProvider`/`setSessionKey`/`setAccessMode` remain gated by `canManageSecretsStrict` (options-page origin only).
- AI answering is **off by default**, **key-gated**, and **fills-then-pauses** for graded work. The user makes the submit decision for assessments; peer-review auto-submit is an explicit opt-in via the same toggle and is fully logged.
- Diagnostics redaction extended to new answer/prompt/snapshot fields.
- Coursera is the hard boundary in both the manifest matches and the open-options gate.

## Testing strategy

| Layer | Approach |
|---|---|
| `coursera-dom` | jsdom unit tests for URL grammar, `accessibleName` parsing (incl. localized + lock-reason + duration variants), exclusion (`ccp-host`, Boost chat), region/heading discovery, launch detection. |
| Real-DOM fixtures | Build jsdom fixtures **from the captured extraction** (gradedLti launch page, `ungradedWidget` item, region/heading outline, `accessibleName` grammar, `ccp-host` + Boost contamination). Assert: exclusion, kind mapping (incl. `ungradedWidget`), completion parsing, LTI-vs-quiz branching. **First cross-course ground-truth tests.** |
| `ai-providers` | Pure tests per adapter: `buildRequest` shape (URL/headers/body) and `parseResponse` → `{ok, raw}` normalization; custom adapter base-URL handling. Mocked `fetch`. |
| Question-type system | Per-type detect + apply tests with handcrafted + fixture HTML; math-normalize scoped-to-numeric regression; MathQuill target; label-wrapped `cds-` option fallback; ordinal detection without "Question N". |
| AI assessment handler | jsdom + mocked `aiGenerate` returning typed answers; assert apply + **pause** (no submit), exclusion, no-key path, error→pause. |
| Peer-review handler | jsdom rubric fixtures: highest-option selection (with/without point values + low-confidence flag), comment pool (count, length, history avoidance, min-length padding), **auto-submit** click, human-mode timing within range (seeded RNG). |
| Autopilot controller | Existing suite + new: un-block gating on/off, routing assessment→AI / peer→peer / LTI→skip, new outcome tokens not treated as failures, `aiAnswerAssessments` threaded through authority. |
| Regression | All 1253 existing tests must stay green. Real Coursera DOM remains **manual smoke test** (called out in the plan as a deferred step). |

## File manifest

**New:** `lib/coursera-dom.js`, `lib/ai-providers.js`, `lib/peer-review.js`, `lib/peer-review-replies.js`, plus matching `tests/*.test.js` for each, plus fixture-based additions to `tests/module-scraper.test.js`, `tests/answer-applier.test.js`, `tests/item-handlers.test.js`, `tests/module-autopilot.test.js`.

**Modified (in place):**
- WS-A: `lib/module-scraper.js`, `lib/page-fallback.js`, `lib/completion-confirmer.js`, `lib/module-autopilot.js`, `lib/question-detector.js`, `lib/answer-matcher.js`, `lib/ai-question-context.js`.
- WS-B: `lib/deepseek-client.js` (→ deepseek adapter), `background.js`, `lib/ai-background-service.js`, `lib/ai-options-controller.js`, `options.html`, `manifest.json`.
- WS-C: `lib/item-handlers.js`, `lib/module-autopilot.js`, `lib/answer-applier.js`, `lib/answer-matcher.js`, `lib/question-detector.js`, `lib/autopilot-state.js`, `lib/autopilot-authority.js`, `lib/autopilot-debug.js`, `lib/sidebar.js`, `content.js`.
- WS-D: `lib/item-handlers.js` (route), `lib/autopilot-timing.js`, `lib/sidebar.js` (log), `manifest.json` (load order for new modules).

`manifest.json` content-script `js[]` gains the new modules in dependency order: `coursera-dom.js` early (before scraper), `ai-providers.js` (background + content as needed), `peer-review-replies.js` before `peer-review.js` before `item-handlers.js`.

## Sequencing (implementation phases)

- **Phase A — Adaptive Coursera DOM layer.** `coursera-dom.js` + scraper/completion/navigation hardening + exclusion + fixtures. Ship-able and testable on its own; fixes "drops real lessons" and brittle completion. No behavior change to AI.
- **Phase B — Provider-agnostic AI.** `ai-providers.js` + deepseek refactor + background/options/manifest. Manual AI Answers path now works across providers. Independent of A.
- **Phase C — AI assessment answering.** Toggle + un-block gating + `ctx.aiGenerate` + assessment handler + question-type system + answer-engine fixes. Depends on A (scope/exclusion/detection) and B (provider channel).
- **Phase D — Peer-review auto-complete.** `peer-review.js` + pool + rubric scoring + auto-submit + human timing. Depends on A; reuses B's channel only if AI-authored comments are added later (v1 uses the pool, no AI needed for comments).

Each phase is TDD (tests first), reviewable as a focused diff, and must keep the full suite green.

## Open follow-ups (out of scope for v1)

- AI-authored (vs pooled) peer-review comments.
- Topic-aware discussion/peer replies.
- Managed-credits hosted-AI path (still a stub).
- Per-course / per-module persisted settings.
- Arbitrary module-range run scope (beyond current-module / all-modules).
- Playwright/real-browser CI against live Coursera (manual smoke only for now).
