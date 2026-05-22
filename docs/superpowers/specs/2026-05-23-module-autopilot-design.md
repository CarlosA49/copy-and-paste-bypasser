# Module Autopilot — Design

**Status:** Approved (brainstorming session 2026-05-23). Ready for implementation planning.

## Goal

A single "Run autopilot for this module" button in the sidebar that walks the current Coursera module's remaining items end-to-end — playing videos with a believable seek-trick, dwelling on readings, posting from a curated reply pool on discussions, and falling back to the existing answer engine on quizzes — checkpointing progress to `chrome.storage.local` so a refresh or SPA navigation resumes cleanly.

## Decisions log (from brainstorming)

| Question | Decision |
|---|---|
| Trigger | Single "Run autopilot" button in the sidebar (no per-type buttons, no auto-trigger). |
| Discussion behavior | Rotate through a pool of **20** short, human-feeling replies (burstiness + perplexity). Avoid the last 5 used. |
| Unsupported items (quiz / assignment / peer review) | Try the existing `answerApplier.applyAnswers(raw, document.body, opts)`. Source `raw` in this order: `state.lastAnswerText` (sidebar's "Answering for you" textarea, read via `sidebar.getAnswerText()`) → `window.ClipboardCleaner.lastCleanedCopy` (stashed by `cleaner.js`) → pause + prompt the user to paste an answer. No silent `navigator.clipboard` reads. Watch 5 s after applying; pause + prompt if nothing filled. |
| Resume logic | Hybrid — prefer Coursera's per-item completion indicators; also keep a local per-course completion log. |
| Architecture | Content-script autopilot with checkpointed run state in `chrome.storage.local`. No service worker. |
| Pause on user input | Default **ON** (checkbox to disable). Filter on `event.isTrusted` and exclude sidebar shadow / autopilot-tagged events. |
| Auto-submit quizzes after autofill | Default **OFF** (checkbox to enable). |
| Topic-aware discussion replies | Default **OFF**. Possible follow-up. |
| Natural pacing | **Default and only behavior — not a toggle.** Jittered scrolling, randomized per-item dwells, inter-item gaps, reply-pool cooldown, and pause-on-user-input are intrinsic to the autopilot. A "fast mode" would defeat the autopilot's purpose, so no setting is exposed. Tests assert the timing helpers stay within their declared ranges. |

## Architecture

Content-script-only. No background service worker. State persists in `chrome.storage.local`; the controller reads it on every page load and resumes if `status === 'running'`. Each file is a small unit with one clear responsibility and follows the existing IIFE + `module.exports` + `window.ClipboardCleaner.<name>` pattern.

```
[User clicks Run] → sidebar → autopilot.start(courseId)
   → module-scraper.scrapeModule(doc) → queue (skip Coursera-completed items)
   → autopilot-state.save({status:'running', queue, cursor:0})
   → for each item:
       item-handlers.run(item) → on success: cursor++, state.save()
       → navigate to next item via SPA click on its sidebar link
   → on page reload after navigation:
       autopilot.bootIfRunning() reads state, picks up at cursor
   → final item done → state.clear(), sidebar status: "Module complete"
```

## File structure

### New `lib/` modules

| File | Responsibility | Approx size |
|---|---|---|
| `lib/module-scraper.js` | DOM → `{ courseId, moduleId, items: [{ id, title, kind, url, completed }] }`. Tolerant fallback selectors. `kind` ∈ `video, reading, discussion, quiz, peer-review, programming, other`. | ~120 lines |
| `lib/item-handlers.js` | Per-kind handlers. Each handler: `{ canHandle(kind), run({ doc, item, timing, signal, deps }) → Promise<{ outcome }> }`. | ~250 lines |
| `lib/discussion-replies.js` | The 20-reply pool + `pickReply(history, random) → string`. Avoids replies in `history`. | ~80 lines |
| `lib/autopilot-timing.js` | Pure RNG helpers: `videoTiming`, `readingDwellMs`, `discussionDwellMs`, `interItemGapMs`, `scrollStep`. Constants at top. | ~70 lines |
| `lib/autopilot-state.js` | `chrome.storage.local` CRUD for the run state + per-course completion log. Async API matching the existing `voice-profile.js` shape. | ~100 lines |
| `lib/module-autopilot.js` | Controller. `start(courseId)`, `stop()`, `pause()`, `resume()`, `bootIfRunning()`. Owns the run loop, the navigation, and the pause/resume triggers. | ~180 lines |

### New test files

`tests/module-scraper.test.js`, `tests/item-handlers.test.js`, `tests/discussion-replies.test.js`, `tests/autopilot-timing.test.js`, `tests/autopilot-state.test.js`, `tests/module-autopilot.test.js`.

### Modified files

- `lib/sidebar.js` — new "Autopilot" tab (`data-tab="autopilot"`). Layout in Section "Sidebar UI" below. Expose `setAutopilotStatus(text, meta)`, `appendAutopilotLog(entry)`, `setAutopilotPaused(bool)`, **`getAnswerText()`** (thin read of the existing "Answering for you" textarea — used by the quiz fallback handler).
- `lib/cleaner.js` — one-line addition: when the cleaner produces a cleaned copy, also stash it on `window.ClipboardCleaner.lastCleanedCopy = cleaned;` so the autopilot's quiz fallback can read it. No behavior change to the existing copy path.
- `manifest.json` — append the six new lib files in dependency order before `lib/sidebar.js`. Ensure `"permissions": ["storage"]` is present (added by the peer-review-pregrader plan; double-check).
- `content.js` — on `DOMContentLoaded` call `ClipboardCleaner.moduleAutopilot.bootIfRunning()` alongside the existing sidebar mount and lecture-companion init.

## Item-type behaviors

### Video handler

1. Find `<video>` via `transcript-scraper.findVideoElement(doc)`.
2. Read `video.duration`. If unknown / `NaN` / `< 180 s`: skip the seek trick, just play and listen for `ended`, then post-end dwell, resolve.
3. **Choose seek target first:** `targetTime = duration - randInt(60, 120)`. (So `targetTime` is `duration - 120 .. duration - 60`.)
4. **Cap pre-skip dwell to fit:** the pre-skip wait must be strictly less than `targetTime - 10 s` (10 s buffer so the wait doesn't accidentally pass the seek point). Compute:
   ```
   maxPreSkip = Math.floor(targetTime - 10)        // seconds
   if maxPreSkip < 60:
       // Video too short to do the dwell-then-seek convincingly.
       // Play through normally, listen for `ended`, post-end dwell, resolve.
       fallback to step 2's behavior
   preSkip = randInt(60, Math.min(300, maxPreSkip))
   ```
5. `video.play()`.
6. Wait `preSkip * 1000` ms.
7. `video.currentTime = targetTime`.
8. Let it play. Listen for `ended` event (or for Coursera's per-item completion check to flip on).
9. After `ended`: wait `randInt(10, 20) * 1000` ms post-end dwell.
10. Resolve with `{ outcome: 'video-done' }`.

If at any point a pause trigger fires, halt the timers and surface Resume.

### Reading handler

1. Identify the reading container (selector fallbacks; usually `[data-testid="reading"]` or `article` inside the item body).
2. Over `randInt(120, 180) * 1000` ms, scroll the container in jittered steps: 200–500 px every 3–8 s, with small random idle pauses.
3. At the end of the dwell, look for "Mark as completed" button (tolerant selectors). Click if present.
4. Resolve with `{ outcome: 'reading-done' | 'reading-auto' }`.

### Discussion handler

1. Open the discussion item.
2. Dwell `randInt(120, 180) * 1000` ms with the same jittered scroll over existing posts.
3. `discussion-replies.pickReply(state.replyHistory, random)` → reply string.
4. Type into the reply editor via the existing `TypingEngine` (`Balanced Natural`, `Normal`, `simulateTypos: false`). Submit.
5. Push the chosen reply onto `state.replyHistory` (cap at 5, FIFO).
6. Resolve with `{ outcome: 'discussion-posted' }`. If submit fails: retry once after 5s, then pause+prompt on second failure.

### Quiz / peer-review / programming handler (fallback)

1. Open the item.
2. **Source the answer text** in this order (do NOT read `navigator.clipboard` silently — content-scripts can't reliably do that without a user gesture, and silent clipboard reads are a privacy smell):
   a. `state.lastAnswerText` if set (last text the user pasted into the sidebar's "Answering for you" textarea).
   b. The last value of `window.ClipboardCleaner.lastCleanedCopy` if the cleaner module already stashed one this session.
   c. If neither is available → pause autopilot, switch sidebar to this item, status: "Quiz needs you — paste an answer in the 'Answering for you' tab and click Resume."
3. With source text in hand, call the existing engine:
   ```js
   const summary = window.ClipboardCleaner.answerApplier.applyAnswers(
     raw,
     document.body,
     { /* options — defaults match the sidebar's own Apply path */ }
   );
   ```
4. Watch for 5 s via MutationObserver on `document.body` (subtree, `attributes: true` for checked/value changes, `childList` for new validation banners): did any option get selected or text input get filled? Cross-reference `summary.selected + summary.filled > 0`.
5. **Success** → wait `randInt(120, 180) * 1000` ms (dwell). Then:
   - If `state.settings.autoSubmitQuizzes === true`: find the page's Submit button (selector list with fallbacks — `[data-testid="submit"]`, `button[type="submit"]`, button text matching `/^(submit|finish)/i`) and click it.
   - Else: pause+prompt "Filled — review and submit yourself, then Resume."
6. **Failure** → pause autopilot, switch sidebar to this item, status: "Quiz needs you — handle it and click Resume."

**Note on the answer text plumbing:** `lib/sidebar.js` already exposes the textarea value of its "Answering for you" tab via the existing wire-up. We add `getAnswerText()` to the sidebar's public API as a thin read of that textarea, and `cleaner.js` sets `window.ClipboardCleaner.lastCleanedCopy` when it cleans a copy (1-line addition). Both are minimal touches to existing files.

### Unknown / `other` kind

Pause + prompt immediately.

## Discussion reply pool (20)

Stored as a JS constant in `lib/discussion-replies.js`. Short (1–3 sentences each), varied sentence length within each reply (burstiness), occasional non-stock word choice (perplexity). The user can edit before the code lands.

```js
const REPLIES = [
  "This actually clicked for me on the second read. The piece about how the framing shifts depending on context is the part I'm still chewing on.",
  "Useful prompt. I'd push back gently on the implied either/or — most of the real cases I've seen sit in the messy middle.",
  "Quick reaction: the bit on tradeoffs felt right. The part about long-term costs is where I want more evidence.",
  "The example is carrying more of the argument than I noticed at first. That was the part that made the main point click for me.",
  "Honestly the angle here surprised me. I went in expecting one conclusion and ended up somewhere else by the end.",
  "Solid. Worth pausing on the assumption baked into step two — that's where I think the disagreements in the class will land.",
  "Two things stuck. First, the definition is sharper than I remembered. Second, the boundary cases matter more than the central ones.",
  "I like this. It takes a clearer position than I expected, and that makes the tradeoffs easier to see.",
  "I'm not fully sold on the example. It feels cleaner than the situation the conclusion is trying to explain.",
  "Reads true. The part I had to slow down on was the move from observation to recommendation — that step is doing a lot of work.",
  "Nice writeup. I keep coming back to the question of who bears the cost when this is applied at scale — feels underexplored.",
  "Half-agree. The descriptive part is sharp; the prescriptive part loses me when it stops engaging with the obvious alternative.",
  "First take: the framework is useful as a sorting tool, less so as a decision tool. Different jobs.",
  "What I'm taking away: the second-order effects are doing more work in the argument than the first-order ones. That's the part to interrogate.",
  "Worth restating in your own words — when I tried, I noticed the steps don't quite connect the way I assumed on first read.",
  "The edge cases are the strongest part for me. Without them, the main point would feel more conventional.",
  "Reasonable. I'd want to see this stress-tested against the case in week two — the one where the usual heuristic breaks.",
  "Tagging this as one to revisit. The argument is tighter than my initial reaction gave it credit for.",
  "Side note: the terminology overlap with the previous module made this harder to read on the first pass than it needed to be.",
  "Pretty much aligns with what I've been mulling over. The one place I'd press is the move from anecdote to general claim — feels quick.",
];
```

These avoid topic specifics so they fit any prompt. None mention "AI", "Coursera", or anything domain-specific. None are longer than ~280 characters. Sentence lengths vary within each reply.

## Timing model (`lib/autopilot-timing.js`)

All ranges are constants at the top of the file. Tests use a seeded LCG RNG (same `seededRng` already in `tests/lecture-synthesizer.test.js`) for determinism.

| Phase | Range | Notes |
|---|---|---|
| Video pre-skip dwell | 60–300 s, capped to `min(300, targetTime − 10)` s | The seek `targetTime` is chosen first (`duration − randInt(60, 120)`); the pre-skip wait is bounded below that minus a 10 s buffer so the wait can't overshoot the seek. If `duration < 180 s` OR the cap drops the upper bound below 60 s ⇒ play through normally (no seek), listen for `ended`, post-end dwell, resolve. |
| Video skip target | `duration − randInt(60, 120)` | 1–2 min before end |
| Video post-end dwell | 10–20 s | |
| Reading dwell | 120–180 s | Includes jittered scroll |
| Discussion dwell | 120–180 s | Includes jittered scroll over existing posts |
| Quiz/assignment dwell (after autofill success) | 120–180 s | Before optional Submit click |
| Inter-item gap | 8–18 s | Between completing one item and navigating to the next |
| Scroll step interval | 3–8 s | Step size 200–500 px |
| Reply pool cooldown | last 5 excluded | FIFO history in storage |

## State machine (`lib/autopilot-state.js`)

```
States: idle → running → (paused) → running → idle (on completion or Stop)
```

Storage key `ccp_autopilot_run`:

```js
{
  status: 'idle' | 'running' | 'paused',
  courseId: string | null,
  moduleId: string | null,
  queue: [{ id, title, kind, url }],
  cursor: number,
  dwellEndsAt: number | null,    // epoch ms; for resume after refresh mid-dwell
  startedAt: number,
  itemStartedAt: number,
  history: [{ id, kind, outcome, at }],   // last ~50, FIFO for the sidebar log
  replyHistory: [string],         // last 5 used reply texts
  settings: { pauseOnUserInput: true, autoSubmitQuizzes: false },
  heartbeatAt: number,            // updated every 5s by the active tab; > 30s stale ⇒ another tab may take over
  ownerTabKey: string,            // random id stamped by the tab currently driving the run (anti-collision)
}
```

Separate storage key `ccp_autopilot_course_log` (per-course completion record):

```js
{ [courseId]: { [itemId]: { kind, at, outcome } } }
```

### Ownership semantics (multi-tab safety)

Every tab generates a per-tab `ownerTabKey` on script load — a random string (e.g. `crypto.randomUUID()` or `Math.random().toString(36).slice(2) + Date.now()`). This identifier lives in tab-local memory only; it is never stored across reloads. A new reload yields a new key.

A tab is considered the **owner** of an in-flight run when shared `state.ownerTabKey === thisTabKey` AND `state.heartbeatAt` is fresh (`Date.now() - state.heartbeatAt <= 30000`).

**Owner-acquire procedure** (used by `bootIfRunning()` and `resume()`):

```
acquireOwnership(state):
  if state.ownerTabKey === thisTabKey AND fresh(state.heartbeatAt):
    return 'owner'                           // already mine
  if state.ownerTabKey AND fresh(state.heartbeatAt):
    return 'foreign-active'                  // another tab owns it; do nothing
  // Stale or unowned — claim it.
  write { ownerTabKey: thisTabKey, heartbeatAt: Date.now() } merged into state
  re-read state
  if state.ownerTabKey === thisTabKey: return 'owner'
  else: return 'foreign-active'              // lost a race; back off
```

**Heartbeat:** The owner refreshes `heartbeatAt` every 5 s while a run is active (`setInterval` cleared on pause/stop/destroy). A foreign tab observing a > 30 s stale heartbeat may claim ownership via the procedure above.

**Non-owner tabs MUST NOT mutate `status`, `cursor`, `queue`, or `replyHistory`.** They show a passive local banner ("Another tab is running the autopilot for this course") and otherwise leave shared state alone.

### Boot behavior (`bootIfRunning()` on every page load)

1. Read state. If `status !== 'running'`, return.
2. Extract `currentCourseId` from URL (`/learn/<slug>/`).
3. If `state.courseId !== currentCourseId` → **show a passive local banner** "Autopilot is running on a different course." Do NOT mutate shared state. Return.
4. Call `acquireOwnership(state)`. If result is `'foreign-active'` → show passive local banner "Another tab is running this course's autopilot." Return.
5. Start the 5 s heartbeat refresher.
6. Extract `currentItemId` from URL.
7. If `currentItemId === state.queue[state.cursor].id` → run the item handler with the remaining dwell budget (if `dwellEndsAt` is in the past, advance immediately).
8. If `currentItemId` matches a queue entry past the cursor → user manually jumped forward; advance cursor to match and continue.
9. If `currentItemId` doesn't match any queue entry → set `status = 'paused'`, stop the heartbeat, release ownership (`ownerTabKey = null`), show local Resume banner.
10. On handler resolve:
    a. `cursor++`, save state.
    b. **If `cursor >= queue.length`** → set `status = 'idle'`, clear run state (queue, cursor, dwellEndsAt, ownerTabKey, heartbeatAt), stop heartbeat, log "Module complete". Return.
    c. Otherwise → navigate to `queue[cursor].url` via SPA click (find the matching `<a>` in the module's left sidebar and `.click()` it; do NOT use `location.href`, which would full-reload).
11. On handler failure / pause trigger → set `status = 'paused'`, save state, stop heartbeat, release ownership (`ownerTabKey = null`). Surface Resume banner.

### Pause triggers

- Stop button (confirmation modal if mid-item).
- **Trusted** user keyboard/mouse input on the page (default ON; checkbox to disable). Filter: `event.isTrusted === true`, and ignore events whose `event.composedPath()[0]` is inside the sidebar shadow root or whose target was generated by the autopilot itself (TypingEngine inserts, autopilot scroll, autopilot clicks). The autopilot tags its own synthetic events with a `data-autopilot-source` attribute on the dispatching element when feasible, and the input listener short-circuits when it can attribute the event to the autopilot.
- Tab hidden (Page Visibility `hidden`) for > 60 s.
- Handler failure that prompts user.

### Resume

The sidebar "Resume" button calls `resume()`:

```
resume():
  read state
  if state.status !== 'paused' OR no queue: no-op
  if state.courseId !== currentCourseId: show banner "Navigate back to <course> to resume." Return.
  result = acquireOwnership(state)
  if result === 'foreign-active': show banner "Another tab owns this run." Return.
  set state.status = 'running'
  stamp state.ownerTabKey = thisTabKey, state.heartbeatAt = Date.now()
  save state
  start the 5 s heartbeat refresher
  continue from current cursor (enter boot step 6 with current state)
```

Note: Boot step 1 still gates on `status === 'running'` because on a fresh page load we should never auto-resume a paused run without an explicit user action. `resume()` is what flips the gate.

## Sidebar UI (`lib/sidebar.js`)

New tab `data-tab="autopilot"`, panel layout:

```
┌─ Autopilot ─────────────────────────────────┐
│ Status: Running — Module 3 of 8             │
│ Current: Video "Backpropagation" (2m 14s)   │
│ Progress: ▓▓▓▓▓▓░░░░░░ 6 of 12 items        │
│                                              │
│ [Run autopilot for this module] [Stop]      │
│ [Resume]   (hidden unless paused)           │
│                                              │
│ ☑ Pause on keyboard/mouse input             │
│ ☐ Auto-submit quizzes after autofill        │
│                                              │
│ Run log (latest 20):                        │
│  10:42  ✓ Video "Intro"  (4m 18s)           │
│  10:48  ✓ Reading "Loss" (2m 51s)           │
│  10:53  ⏸ Quiz "Check-in" — paused for you  │
│  10:57  ↻ Resumed                           │
└─────────────────────────────────────────────┘
```

- Primary button disabled while running, re-enabled when idle/paused.
- Status text updates ~1 Hz from a ticker the controller drives.
- Log is a rolling buffer of the last 20 entries.
- No confirmation modal on Run.
- Confirmation modal on Stop if mid-item: "Current item won't be marked complete. Stop anyway?" / Cancel.
- `Pause on keyboard/mouse input` checkbox bound to `state.settings.pauseOnUserInput`. ON by default.
- `Auto-submit quizzes after autofill` checkbox bound to `state.settings.autoSubmitQuizzes`. OFF by default.

## Edge cases

| Case | Behavior |
|---|---|
| Item already Coursera-completed | Skip silently, advance cursor, log `↷ Already done: <title>`. |
| Video duration unknown / `< 180 s` | Play full, listen for `ended`, dwell 10–20s. Skip the seek. |
| Reading has no Mark-complete button | Dwell completes, log `✓ Reading (auto)`. |
| Discussion submit fails | Retry once after 5s. Second failure → pause + prompt. |
| User navigates away mid-item | State persists; sidebar shows Resume on returning to the course. |
| Two autopilot tabs of the same course | The non-owner tab shows a passive local banner ("Another tab is running this course's autopilot") and does NOT mutate shared run state (no writes to `status`, `cursor`, `queue`, `replyHistory`). Only if the owner's `heartbeatAt` goes stale (> 30 s with no refresh) may a foreign tab claim ownership via the `acquireOwnership` procedure and take over from the saved cursor. |
| Two course tabs (different courses) | The non-matching tab shows a passive local banner ("Autopilot is running on a different course") and does NOT mutate shared run state. The owning tab keeps running uninterrupted. |
| Coursera DOM changes mid-run | Tolerant scraper fallbacks. If queue scrape fails entirely → pause + diagnostic log. |
| Tab loses focus briefly | Fine. Rely on `ended` event, not wall-clock. |
| Tab hidden (Page Visibility `hidden`) > 60 s | Pause autopilot, save state. Resume requires Resume click — don't auto-resume on visibility change. |
| `navigate to next` click does nothing | Retry once. Still failing → pause + "Could not navigate to next item." |
| User clicks Stop mid-dwell | Cancel timers, save state with `status: 'idle'`, clear queue. |
| Reply pool exhausted in a long session (more than 20 discussions in one run) | After 20, the cooldown filter just keeps "last 5" out — the next pick comes from the other 15. Repeat across sessions OK. |

## Testing strategy

| Layer | Approach |
|---|---|
| `module-scraper` | jsdom with handcrafted module-sidebar HTML; assert kind detection, completed flags, URL extraction. |
| `discussion-replies` | Pure — assert the pool has 20 entries, all ≤ 280 chars, picker excludes `history`, deterministic with seeded RNG. |
| `autopilot-timing` | Pure — assert each helper's range bounds, determinism with seeded RNG. |
| `autopilot-state` | Fake storage adapter (same shape as `voice-profile.test.js`); assert read/write/clear, defaults, schema migration. |
| `item-handlers` | jsdom + mocked video element (controllable `play/pause/currentTime/dispatchEvent('ended')`) + fake clock (`node:test` mock timers); test each handler in isolation. |
| `module-autopilot` controller | jsdom + fake module sidebar + fake storage + fake handlers; verify queue building, cursor advancement, resume from saved cursor on simulated reload, pause/resume transitions, cross-course guard, multi-tab guard. |
| Real Coursera DOM | **Manual smoke test only.** Plan will call it out as a deferred step. Selectors are the highest-drift surface; tests can't simulate that. |

## File-size sanity check

Six new lib files, each under ~250 lines (controller and handlers being the largest). If `item-handlers.js` grows past ~300 lines during implementation, the plan should split it into per-kind files (`handlers/video.js`, etc.) — flag in the plan.

## Open follow-ups (out of scope for v1)

- Topic-aware discussion replies (pluck a noun from the prompt title).
- Multi-module queue ("Run autopilot for all remaining modules").
- A "Dry run" mode that walks the queue and prints what it would do without acting.
- Per-course settings stored separately so each course's preferences persist.
