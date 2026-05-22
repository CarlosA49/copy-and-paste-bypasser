# Module Autopilot — Design

**Status:** Approved (brainstorming session 2026-05-23). Ready for implementation planning.

## Goal

A single "Run autopilot for this module" button in the sidebar that walks the current Coursera module's remaining items end-to-end — playing videos with a believable seek-trick, dwelling on readings, posting from a curated reply pool on discussions, and falling back to the existing answer engine on quizzes — checkpointing progress to `chrome.storage.local` so a refresh or SPA navigation resumes cleanly.

## Decisions log (from brainstorming)

| Question | Decision |
|---|---|
| Trigger | Single "Run autopilot" button in the sidebar (no per-type buttons, no auto-trigger). |
| Discussion behavior | Rotate through a pool of **20** short, human-feeling replies (burstiness + perplexity). Avoid the last 5 used. |
| Unsupported items (quiz / assignment / peer review) | Try the existing "Answering for you" engine with clipboard contents; pause + prompt if nothing matches in 5s. |
| Resume logic | Hybrid — prefer Coursera's per-item completion indicators; also keep a local per-course completion log. |
| Architecture | Content-script autopilot with checkpointed run state in `chrome.storage.local`. No service worker. |
| Pause on user input | Default **ON** (checkbox to disable). |
| Auto-submit quizzes after autofill | Default **OFF** (checkbox to enable). |
| Topic-aware discussion replies | Default **OFF**. Possible follow-up. |

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

- `lib/sidebar.js` — new "Autopilot" tab (`data-tab="autopilot"`). Layout in Section "Sidebar UI" below. Expose `setAutopilotStatus(text, meta)`, `appendAutopilotLog(entry)`, `setAutopilotPaused(bool)`.
- `manifest.json` — append the six new lib files in dependency order before `lib/sidebar.js`. Ensure `"permissions": ["storage"]` is present (added by the peer-review-pregrader plan; double-check).
- `content.js` — on `DOMContentLoaded` call `ClipboardCleaner.moduleAutopilot.bootIfRunning()` alongside the existing sidebar mount and lecture-companion init.

## Item-type behaviors

### Video handler

1. Find `<video>` via `transcript-scraper.findVideoElement(doc)`.
2. Read `video.duration`. If unknown or `< 180 s`: skip the seek trick, just play and listen for `ended`.
3. `video.play()`.
4. Wait `randInt(60, 300) * 1000` ms — the 1–5 minute "watching" window.
5. `video.currentTime = video.duration - randInt(60, 120)` — seek to 1–2 minutes before the end.
6. Let it play. Listen for `ended` event (or for Coursera's per-item completion check to flip on).
7. After `ended`: wait `randInt(10, 20) * 1000` ms post-watch dwell.
8. Resolve with `{ outcome: 'video-done' }`.

If at any point user-input pause fires, halt the timers and surface Resume.

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
2. If the system clipboard contains text, run `answer-applier.apply(...)` (existing engine).
3. Watch for 5 s: did any option get selected or text input get filled?
4. **Success** → wait `randInt(120, 180) * 1000` ms (dwell), then if **`autoSubmitQuizzes`** setting is ON, click the page's Submit button; else pause+prompt: "Filled — review and submit yourself, then Resume."
5. **Failure** → pause autopilot, switch sidebar to this item, status: "Quiz needs you — handle it and click Resume."

### Unknown / `other` kind

Pause + prompt immediately.

## Discussion reply pool (20)

Stored as a JS constant in `lib/discussion-replies.js`. Short (1–3 sentences each), varied sentence length within each reply (burstiness), occasional non-stock word choice (perplexity). The user can edit before the code lands.

```js
const REPLIES = [
  "This actually clicked for me on the second read. The piece about how the framing shifts depending on context is the part I'm still chewing on.",
  "Useful prompt. I'd push back gently on the implied either/or — most of the real cases I've seen sit in the messy middle.",
  "Quick reaction: the bit on tradeoffs felt right. The part about long-term costs is where I want more evidence.",
  "Reading this back, I think the key idea is doing more work than it first appears. The example load-bears most of the argument.",
  "Honestly the angle here surprised me. I went in expecting one conclusion and ended up somewhere else by the end.",
  "Solid. Worth pausing on the assumption baked into step two — that's where I think the disagreements in the class will land.",
  "Two things stuck. First, the definition is sharper than I remembered. Second, the boundary cases matter more than the central ones.",
  "I like this. The framing avoids the usual hedge and just commits to a position, which is harder than it looks.",
  "Counter-take: the example feels a bit too clean for the conclusion it's supporting. Would be curious to see the noisier version.",
  "Reads true. The part I had to slow down on was the move from observation to recommendation — that step is doing a lot of work.",
  "Nice writeup. I keep coming back to the question of who bears the cost when this is applied at scale — feels underexplored.",
  "Half-agree. The descriptive part is sharp; the prescriptive part loses me when it stops engaging with the obvious alternative.",
  "First take: the framework is useful as a sorting tool, less so as a decision tool. Different jobs.",
  "What I'm taking away: the second-order effects are doing more work in the argument than the first-order ones. That's the part to interrogate.",
  "Worth restating in your own words — when I tried, I noticed the steps don't quite connect the way I assumed on first read.",
  "The piece on edge cases is where this earns its keep for me. Strip those out and the rest is fairly conventional.",
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
| Video pre-skip dwell | 60–300 s | Skipped if `duration < 180 s` |
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

### Boot behavior (`bootIfRunning()` on every page load)

1. Read state. If `status !== 'running'`, return.
2. Extract `courseId` from URL (`/learn/<slug>/`).
3. If `state.courseId !== currentCourseId` → status = 'paused'. Sidebar banner: "Different course detected — Resume to continue the previous module."
4. Extract `currentItemId` from URL.
5. If `currentItemId === state.queue[state.cursor].id` → run the item handler with the remaining dwell budget (if `dwellEndsAt` is in the past, advance immediately).
6. If `currentItemId` matches a queue entry past the cursor → user manually jumped forward; advance cursor to match and continue.
7. If `currentItemId` doesn't match any queue entry → status = 'paused', show Resume banner.
8. On handler resolve: `cursor++`, save state, navigate to `queue[cursor].url` via SPA click (find the matching `<a>` in the module's left sidebar and `.click()` it; do NOT use `location.href`, which would full-reload).
9. `cursor === queue.length` → status = 'idle', clear run state, log "Module complete".

### Pause triggers

- Stop button (confirmation modal if mid-item).
- User keyboard/mouse input on the page (default ON; checkbox to disable).
- Tab hidden for > 60 s (Page Visibility API).
- Handler failure that prompts user.

### Resume

Big "Resume" button in the sidebar status panel. Re-enters boot flow step 1.

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
| Two autopilot tabs of the same course | The boot guard pauses the second tab (it reads `status: 'running'` but realizes another tab is already driving via a heartbeat timestamp in state; > 30s stale heartbeat ⇒ takeover). |
| Two course tabs (different courses) | Cross-course guard pauses the non-matching tab. |
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
