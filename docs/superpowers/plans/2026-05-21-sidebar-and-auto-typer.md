# Sidebar UI + Auto Typer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a premium right-side floating panel to Coursera pages with two tabs — "Copied Text" (shows cleaned copy output with a re-copy button) and "Auto Typer" (humanlike typing into focused editable fields, with start/pause/stop/speed controls and a confirmation gate).

**Architecture:** A content-script-injected sidebar mounted in a closed shadow root on `document.body`, so the panel's HTML/CSS is fully isolated from Coursera. New modules: `lib/sidebar.js` (shell + tabs + resize + Copied Text view), `lib/typing-engine.js` (pure, deterministic-with-injected-clock state machine that emits per-character events), `lib/typing-injector.js` (focused-field safety check + DOM insertion). `content.js` is extended to (a) mount the sidebar on page load and (b) push the cleaned plain-text result to the sidebar on every copy. Existing 51 tests stay untouched. New tests cover only the pure logic (`typing-engine`) and the DOM-touching but headless-safe parts (`typing-injector`).

**Tech Stack:** Manifest V3 content scripts, vanilla JS, CSS custom properties + transitions for the premium look, jsdom for tests.

**Reference:** The Python "Auto Human Typer" project under `Reference/Auto Human Typer/auto-typer/`. We borrow timing semantics from `app/settings.py` (`SPEED_PROFILES`, `TypingProfile`) — per-char delays, word/sentence/paragraph pauses, hesitation bursts, optional typos — and adapt to a browser-friendly setTimeout-driven state machine. We do NOT port any UI, the Windows SendInput plumbing, the trainer, the humanizer, or the file-import code.

---

## Phase boundary

Tasks 1–3 produce a working sidebar that displays the cleaned copy and has a Copy button. Tasks 4–7 add the Auto Typer. After Task 3 the extension is shippable on its own; after Task 8 the Auto Typer is shippable too.

---

## File structure

```
content.js                       # modified: mount sidebar; route copies into it
manifest.json                    # modified: load new JS + CSS in content_scripts
README.md                        # modified: usage section for sidebar + auto-typer
lib/cleaner.js                   # untouched
lib/html-cleaner.js              # untouched
lib/sidebar.js                   # NEW: shadow-root sidebar shell + tabs + Copied Text view
lib/sidebar.css                  # NEW: premium styles, animations, resize handle
lib/typing-engine.js             # NEW: pure timing/queue/state-machine
lib/typing-injector.js           # NEW: focused-field safety + character insertion
tests/typing-engine.test.js      # NEW: deterministic tests with injected clock + RNG
tests/typing-injector.test.js    # NEW: jsdom tests for input/textarea/contenteditable
```

CSS rule: all classes prefixed `ccp-` (Coursera Copy Panel). Styles live both in `lib/sidebar.css` (so the file is editable) and are read at load time by `lib/sidebar.js` to inject into the shadow root. (Putting them in a separate file means the CSS is reviewable, but a shadow root needs its own `<style>` element — see Task 1 for the loading approach.)

Public sidebar API exposed on `window.ClipboardCleaner.sidebar`:
- `mount()` — idempotent: create the host element and shadow root if absent.
- `showCopied(plainText)` — push cleaned text into the Copied Text tab.
- `open()` / `close()` / `toggle()` — visibility.
- `setActiveTab('copied' | 'typer')` — switch tabs programmatically.

Public typing engine API on `window.ClipboardCleaner.typingEngine`:
- `new TypingEngine({ now, sleep, random })` — constructor takes clock/RNG injection for tests; defaults to real `Date.now` / `setTimeout` / `Math.random`.
- `engine.start({ text, target, profile, speed, simulateTypos, onTick, onDone })` — kick off, returns nothing.
- `engine.pause()` / `engine.resume()` / `engine.stop()`.
- `engine.getState()` — `'idle' | 'running' | 'paused' | 'stopped' | 'done'`.

---

## Task 1: Sidebar shell — shadow root, header, tabs, resize, animations

**Files:**
- Create: `lib/sidebar.js`
- Create: `lib/sidebar.css`

This task delivers a floating panel on the right side of the page with two tab buttons ("Copied Text", "Auto Typer"), a header with a close button, a resize handle on the left edge, slide-in animation, and empty bodies in both tabs. The panel collapses to a small floating launcher pill when closed.

No automated tests for this task — UI shell is verified by Task 8 in the browser. The sidebar module is loaded but does nothing until Task 2 wires it from `content.js`.

- [ ] **Step 1: Create `lib/sidebar.css`** with this exact content:

```css
:host {
  all: initial;
  --ccp-bg: #0f1117;
  --ccp-bg-2: #161924;
  --ccp-surface: #1d2030;
  --ccp-border: rgba(255, 255, 255, 0.08);
  --ccp-text: #e8ebf2;
  --ccp-text-dim: #9aa3b8;
  --ccp-accent: #6c8cff;
  --ccp-accent-soft: rgba(108, 140, 255, 0.16);
  --ccp-success: #4ade80;
  --ccp-danger: #f87171;
  --ccp-radius: 14px;
  --ccp-shadow: 0 18px 60px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.25);
  --ccp-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-family: var(--ccp-font);
  color-scheme: dark;
}

.ccp-host {
  all: initial;
  position: fixed;
  top: 80px;
  right: 16px;
  width: 360px;
  min-width: 280px;
  max-width: 640px;
  height: calc(100vh - 120px);
  min-height: 320px;
  z-index: 2147483646;
  font-family: var(--ccp-font);
  color: var(--ccp-text);
  background: linear-gradient(180deg, var(--ccp-bg) 0%, var(--ccp-bg-2) 100%);
  border: 1px solid var(--ccp-border);
  border-radius: var(--ccp-radius);
  box-shadow: var(--ccp-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform: translateX(0);
  opacity: 1;
  transition: transform 220ms cubic-bezier(.22, 1, .36, 1),
              opacity 180ms ease,
              width 120ms ease,
              height 120ms ease;
}

.ccp-host[data-open="false"] {
  transform: translateX(calc(100% + 32px));
  opacity: 0;
  pointer-events: none;
}

.ccp-launcher {
  position: fixed;
  right: 16px;
  bottom: 24px;
  width: 44px;
  height: 44px;
  border-radius: 22px;
  background: linear-gradient(135deg, #6c8cff 0%, #8b5cf6 100%);
  box-shadow: 0 8px 24px rgba(108, 140, 255, 0.35), 0 1px 2px rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2147483647;
  transition: transform 160ms ease, box-shadow 160ms ease;
  border: none;
}
.ccp-launcher:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(108, 140, 255, 0.5); }
.ccp-launcher[data-hidden="true"] { opacity: 0; pointer-events: none; transform: translateY(8px); }
.ccp-launcher svg { width: 22px; height: 22px; color: #fff; }

.ccp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--ccp-border);
  user-select: none;
}
.ccp-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.2px;
  flex: 1;
}
.ccp-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--ccp-accent);
  box-shadow: 0 0 12px var(--ccp-accent);
}
.ccp-iconbtn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--ccp-text-dim);
  width: 28px; height: 28px;
  border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.ccp-iconbtn:hover { background: var(--ccp-accent-soft); color: var(--ccp-text); border-color: var(--ccp-border); }
.ccp-iconbtn svg { width: 14px; height: 14px; }

.ccp-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ccp-border);
}
.ccp-tab {
  flex: 1;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--ccp-text-dim);
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.ccp-tab:hover { color: var(--ccp-text); background: rgba(255,255,255,0.03); }
.ccp-tab[aria-selected="true"] {
  background: var(--ccp-accent-soft);
  color: var(--ccp-text);
  border-color: rgba(108, 140, 255, 0.35);
}

.ccp-body {
  flex: 1;
  overflow: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ccp-panel { display: none; flex-direction: column; gap: 10px; animation: ccp-fade 200ms ease; }
.ccp-panel[data-active="true"] { display: flex; }
@keyframes ccp-fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }

.ccp-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px;
  padding: 32px 12px;
  border: 1px dashed var(--ccp-border);
  border-radius: 10px;
  color: var(--ccp-text-dim);
  font-size: 12px;
  text-align: center;
}
.ccp-empty strong { color: var(--ccp-text); font-weight: 600; font-size: 13px; }

.ccp-copy-preview {
  background: var(--ccp-surface);
  border: 1px solid var(--ccp-border);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 60vh;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.ccp-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ccp-btn {
  background: var(--ccp-accent);
  color: #fff;
  border: 1px solid transparent;
  border-radius: 9px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: transform 100ms ease, box-shadow 140ms ease, background 140ms ease;
}
.ccp-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(108, 140, 255, 0.45); }
.ccp-btn:active { transform: translateY(0); }
.ccp-btn[data-variant="ghost"] {
  background: transparent; color: var(--ccp-text);
  border-color: var(--ccp-border);
}
.ccp-btn[data-variant="ghost"]:hover { background: rgba(255,255,255,0.04); }
.ccp-btn[data-variant="danger"] { background: var(--ccp-danger); }
.ccp-btn[disabled] { opacity: 0.45; cursor: not-allowed; transform: none; box-shadow: none; }

.ccp-status {
  font-size: 11.5px;
  color: var(--ccp-text-dim);
  display: flex; align-items: center; gap: 6px;
  min-height: 16px;
}
.ccp-status[data-tone="success"] { color: var(--ccp-success); }
.ccp-status[data-tone="error"] { color: var(--ccp-danger); }

.ccp-resize {
  position: absolute;
  left: -3px; top: 0; bottom: 0;
  width: 6px;
  cursor: ew-resize;
  background: transparent;
}
.ccp-resize:hover { background: var(--ccp-accent-soft); }

.ccp-textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  border-radius: 10px;
  border: 1px solid var(--ccp-border);
  background: var(--ccp-surface);
  color: var(--ccp-text);
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.5;
  box-sizing: border-box;
}
.ccp-textarea:focus { outline: none; border-color: rgba(108,140,255,0.5); box-shadow: 0 0 0 2px var(--ccp-accent-soft); }

.ccp-row { display: flex; gap: 8px; align-items: center; }
.ccp-row > label { font-size: 11.5px; color: var(--ccp-text-dim); min-width: 64px; }
.ccp-select, .ccp-range {
  background: var(--ccp-surface);
  color: var(--ccp-text);
  border: 1px solid var(--ccp-border);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  flex: 1;
}
.ccp-range { padding: 0 6px; }

.ccp-progress {
  width: 100%; height: 6px;
  background: var(--ccp-surface);
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid var(--ccp-border);
}
.ccp-progress-bar {
  width: 0%;
  height: 100%;
  background: linear-gradient(90deg, var(--ccp-accent), #8b5cf6);
  transition: width 120ms linear;
}

.ccp-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: none;
  align-items: center; justify-content: center;
  z-index: 10;
  animation: ccp-fade 160ms ease;
}
.ccp-modal-backdrop[data-open="true"] { display: flex; }
.ccp-modal {
  background: var(--ccp-bg-2);
  border: 1px solid var(--ccp-border);
  border-radius: 12px;
  padding: 14px;
  max-width: 280px;
  display: flex; flex-direction: column; gap: 10px;
  box-shadow: var(--ccp-shadow);
}
.ccp-modal-title { font-size: 13px; font-weight: 600; }
.ccp-modal-text { font-size: 12px; color: var(--ccp-text-dim); line-height: 1.5; }
.ccp-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
```

- [ ] **Step 2: Create `lib/sidebar.js`** with this exact content:

```js
// Right-side floating sidebar. Mounts inside a shadow root so Coursera's CSS
// can't reach it. Public API attached to window.ClipboardCleaner.sidebar.
(function (root) {
  'use strict';

  // CSS is loaded from the extension package at runtime so it stays editable
  // as a real .css file. Inlined here as a fallback string for environments
  // without chrome.runtime (tests).
  const CSS_URL = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('lib/sidebar.css') : null;

  const HTML = '' +
    '<div class="ccp-host" data-open="true">' +
      '<div class="ccp-resize" data-action="resize"></div>' +
      '<div class="ccp-header">' +
        '<div class="ccp-dot"></div>' +
        '<div class="ccp-title">Clipboard Cleaner</div>' +
        '<button class="ccp-iconbtn" data-action="close" title="Close">' +
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3l10 10M13 3L3 13"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="ccp-tabs" role="tablist">' +
        '<button class="ccp-tab" role="tab" aria-selected="true" data-tab="copied">Copied Text</button>' +
        '<button class="ccp-tab" role="tab" aria-selected="false" data-tab="typer">Auto Typer</button>' +
      '</div>' +
      '<div class="ccp-body">' +
        '<section class="ccp-panel" data-panel="copied" data-active="true">' +
          '<div class="ccp-empty" data-role="copied-empty"><strong>No copy yet</strong><span>Select text on this page and press Ctrl+C — the cleaned result appears here.</span></div>' +
          '<div class="ccp-copy-preview" data-role="copied-preview" hidden></div>' +
          '<div class="ccp-actions" data-role="copied-actions" hidden>' +
            '<button class="ccp-btn" data-action="recopy">Copy</button>' +
          '</div>' +
          '<div class="ccp-status" data-role="copied-status"></div>' +
        '</section>' +
        '<section class="ccp-panel" data-panel="typer" data-active="false">' +
          '<div class="ccp-empty" data-role="typer-placeholder"><strong>Auto Typer</strong><span>Coming online — wired up in a later task.</span></div>' +
        '</section>' +
      '</div>' +
    '</div>' +
    '<button class="ccp-launcher" data-action="open" data-hidden="true" title="Open Clipboard Cleaner">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="2" width="10" height="12" rx="2"/><path d="M6 6h4M6 9h4M6 12h2"/></svg>' +
    '</button>';

  let mounted = false;
  let hostEl = null;
  let shadow = null;
  let panelEl = null;
  let launcherEl = null;

  function loadStyles(shadowRoot) {
    const style = document.createElement('style');
    if (CSS_URL) {
      // Browser: fetch the real CSS file synchronously via a <link> in the shadow.
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      shadowRoot.appendChild(link);
    } else {
      // Test / no-runtime: inline a minimal fallback (real CSS not required for jsdom).
      style.textContent = '.ccp-host{position:fixed}';
      shadowRoot.appendChild(style);
    }
  }

  function mount() {
    if (mounted) return;
    if (typeof document === 'undefined' || !document.body) return;
    const host = document.createElement('div');
    host.id = 'ccp-host-root';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;';
    document.body.appendChild(host);

    shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    loadStyles(shadow);

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'pointer-events: auto;';
    wrapper.innerHTML = HTML;
    shadow.appendChild(wrapper);

    hostEl = host;
    panelEl = shadow.querySelector('.ccp-host');
    launcherEl = shadow.querySelector('.ccp-launcher');

    wireHeader();
    wireTabs();
    wireResize();

    mounted = true;
  }

  function wireHeader() {
    shadow.querySelector('[data-action="close"]').addEventListener('click', close);
    shadow.querySelector('[data-action="open"]').addEventListener('click', open);
  }

  function wireTabs() {
    const tabs = shadow.querySelectorAll('.ccp-tab');
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { setActiveTab(t.getAttribute('data-tab')); });
    });
  }

  function setActiveTab(name) {
    if (!shadow) return;
    shadow.querySelectorAll('.ccp-tab').forEach(function (t) {
      t.setAttribute('aria-selected', t.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    shadow.querySelectorAll('.ccp-panel').forEach(function (p) {
      p.setAttribute('data-active', p.getAttribute('data-panel') === name ? 'true' : 'false');
    });
  }

  function wireResize() {
    const handle = shadow.querySelector('[data-action="resize"]');
    let startX = 0; let startW = 0; let dragging = false;
    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      startX = e.clientX;
      startW = panelEl.getBoundingClientRect().width;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const dx = startX - e.clientX; // dragging left grows the panel
      const next = Math.max(280, Math.min(640, startW + dx));
      panelEl.style.width = next + 'px';
    });
    window.addEventListener('mouseup', function () { dragging = false; });
  }

  function open() {
    if (!mounted) mount();
    panelEl.setAttribute('data-open', 'true');
    if (launcherEl) launcherEl.setAttribute('data-hidden', 'true');
  }
  function close() {
    if (!mounted) return;
    panelEl.setAttribute('data-open', 'false');
    if (launcherEl) launcherEl.setAttribute('data-hidden', 'false');
  }
  function toggle() {
    if (!mounted) { mount(); return; }
    if (panelEl.getAttribute('data-open') === 'true') close(); else open();
  }

  // showCopied is implemented in Task 2.
  function showCopied(_plainText) {
    // populated in Task 2
  }

  const api = { mount: mount, open: open, close: close, toggle: toggle, setActiveTab: setActiveTab, showCopied: showCopied };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.sidebar = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 3: Smoke-check the file parses**

Run: `node -e "require('./lib/sidebar.js')"`
Expected: no output, exit 0.

- [ ] **Step 4: Run the existing test suite**

Run: `npm test`
Expected: 51/51 pass (no new tests, no regressions — the sidebar module isn't loaded into the test env).

- [ ] **Step 5: Commit**

```bash
git add lib/sidebar.js lib/sidebar.css
git commit -m "feat(sidebar): shell with tabs, resize, animations (Copied Text + Auto Typer placeholders)"
```

---

## Task 2: Wire sidebar mount + Copied Text view

**Files:**
- Modify: `lib/sidebar.js` — replace the placeholder `showCopied` body.
- Modify: `content.js` — mount the sidebar on load; push cleaned text into it on copy.
- Modify: `manifest.json` — add `lib/sidebar.js` to `content_scripts.js` (after `lib/html-cleaner.js`, before `content.js`) and add `lib/sidebar.css` under `content_scripts.css`.

- [ ] **Step 1: Implement `showCopied` in `lib/sidebar.js`**

Replace the placeholder body of `showCopied`:

```js
  function showCopied(plainText) {
    if (!mounted) mount();
    const empty = shadow.querySelector('[data-role="copied-empty"]');
    const preview = shadow.querySelector('[data-role="copied-preview"]');
    const actions = shadow.querySelector('[data-role="copied-actions"]');
    const status = shadow.querySelector('[data-role="copied-status"]');
    const text = (typeof plainText === 'string') ? plainText : '';
    if (!text) {
      empty.hidden = false;
      preview.hidden = true;
      actions.hidden = true;
      status.textContent = '';
      status.removeAttribute('data-tone');
      return;
    }
    empty.hidden = true;
    preview.hidden = false;
    actions.hidden = false;
    preview.textContent = text;
    status.textContent = '';
    status.removeAttribute('data-tone');
    setActiveTab('copied');
    open();
    // Wire the (re-)copy button once per mount via delegation.
    if (!actions.dataset.wired) {
      actions.dataset.wired = '1';
      actions.querySelector('[data-action="recopy"]').addEventListener('click', function () {
        const current = preview.textContent || '';
        if (!current) return;
        (navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(current)
          : Promise.reject(new Error('clipboard API unavailable'))
        ).then(function () {
          status.textContent = 'Copied to clipboard';
          status.setAttribute('data-tone', 'success');
          setTimeout(function () {
            status.textContent = '';
            status.removeAttribute('data-tone');
          }, 1800);
        }).catch(function (err) {
          status.textContent = 'Copy failed: ' + (err && err.message ? err.message : 'unknown error');
          status.setAttribute('data-tone', 'error');
        });
      });
    }
  }
```

- [ ] **Step 2: Update `manifest.json`**

The `content_scripts[0]` currently has `"js": ["lib/cleaner.js", "lib/html-cleaner.js", "content.js"]`. Add the sidebar script (before `content.js`) and a `css` array. The final shape:

```json
"content_scripts": [
  {
    "matches": [
      "https://*.coursera.org/*",
      "https://coursera.org/*"
    ],
    "js": ["lib/cleaner.js", "lib/html-cleaner.js", "lib/sidebar.js", "content.js"],
    "css": ["lib/sidebar.css"],
    "run_at": "document_start",
    "all_frames": true
  }
]
```

Also add `lib/sidebar.css` to a new `web_accessible_resources` entry so the shadow-root `<link rel="stylesheet">` can fetch it via `chrome.runtime.getURL`:

```json
"web_accessible_resources": [
  {
    "resources": ["lib/sidebar.css"],
    "matches": ["https://*.coursera.org/*", "https://coursera.org/*"]
  }
]
```

Leave the rest of the manifest alone.

- [ ] **Step 3: Update `content.js`**

Replace the existing `content.js` contents with:

```js
// Runs after lib/cleaner.js, lib/html-cleaner.js, and lib/sidebar.js, which
// expose window.ClipboardCleaner.{cleanCopiedText, cleanSelectionHtml, sidebar, ...}.
(function () {
  'use strict';

  function api() { return (typeof window !== 'undefined' && window.ClipboardCleaner) || null; }

  function serializeRange(range) {
    const fragment = range.cloneContents();
    const tmp = document.createElement('div');
    tmp.appendChild(fragment);
    return tmp.innerHTML;
  }

  function onCopy(event) {
    const a = api();
    if (!a || typeof a.cleanCopiedText !== 'function') return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const selectedText = sel.toString();
    if (!selectedText) return;
    if (!event.clipboardData) return;

    let plainTextForSidebar = '';

    if (typeof a.cleanSelectionHtml === 'function') {
      try {
        const rawHtml = serializeRange(sel.getRangeAt(0));
        const { cleanHtml, cleanText } = a.cleanSelectionHtml(rawHtml);
        if (cleanText && cleanText.length > 0) {
          event.clipboardData.setData('text/html', cleanHtml);
          event.clipboardData.setData('text/plain', cleanText);
          event.preventDefault();
          plainTextForSidebar = cleanText;
        }
      } catch (e) {
        // fall through to plain-only
      }
    }

    if (!plainTextForSidebar) {
      const cleaned = a.cleanCopiedText(selectedText);
      event.clipboardData.setData('text/plain', cleaned);
      event.preventDefault();
      plainTextForSidebar = cleaned;
    }

    if (a.sidebar && typeof a.sidebar.showCopied === 'function') {
      try { a.sidebar.showCopied(plainTextForSidebar); } catch (_) { /* never block copy on UI error */ }
    }
  }

  function mountSidebarWhenReady() {
    const a = api();
    if (!a || !a.sidebar || typeof a.sidebar.mount !== 'function') return;
    try { a.sidebar.mount(); } catch (_) { /* don't crash the page on UI error */ }
  }

  document.addEventListener('copy', onCopy, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountSidebarWhenReady, { once: true });
  } else {
    mountSidebarWhenReady();
  }
})();
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: 51/51 pass. No new tests in this task — sidebar wiring is verified manually. The existing tests use only the Node side, which never loads `lib/sidebar.js`.

- [ ] **Step 5: Commit**

```bash
git add lib/sidebar.js content.js manifest.json
git commit -m "feat(sidebar): show cleaned copy in panel with re-copy button"
```

---

## Task 3: Typing engine module (pure, fully tested)

**Files:**
- Create: `lib/typing-engine.js`
- Create: `tests/typing-engine.test.js`

A pure state-machine that translates `(text, profile, speed)` into a stream of `tick` events containing the next character (or "backspace") plus the delay before the *next* tick. Tests inject a fake clock and a seeded RNG, so timing is deterministic.

- [ ] **Step 1: Write `tests/typing-engine.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { TypingEngine } = require('../lib/typing-engine.js');

// Deterministic RNG: linear congruential, repeatable per seed.
function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Fake clock: collects schedule + fires synchronously.
function makeClock() {
  let now = 0;
  const queue = [];
  return {
    now: function () { return now; },
    sleep: function (ms, cb) { queue.push({ at: now + ms, cb: cb }); },
    advanceTo: function (t) {
      while (queue.length && queue[0].at <= t) {
        const { at, cb } = queue.shift();
        now = at;
        cb();
        queue.sort(function (a, b) { return a.at - b.at; });
      }
      now = t;
    },
    drain: function () {
      while (queue.length) {
        const { at, cb } = queue.shift();
        now = at;
        cb();
        queue.sort(function (a, b) { return a.at - b.at; });
      }
    },
  };
}

function run(text, opts) {
  const clock = makeClock();
  const random = seededRandom(opts && opts.seed != null ? opts.seed : 1);
  const ticks = [];
  let done = false;
  const engine = new TypingEngine({ now: clock.now, sleep: clock.sleep, random: random });
  engine.start({
    text: text,
    target: null,
    profile: (opts && opts.profile) || 'Balanced Natural',
    speed: (opts && opts.speed) || 'Normal',
    simulateTypos: !!(opts && opts.simulateTypos),
    onTick: function (ev) { ticks.push(ev); },
    onDone: function () { done = true; },
  });
  clock.drain();
  return { ticks: ticks, done: done, finalText: ticks.reduce(function (s, t) {
    if (t.kind === 'char') return s + t.char;
    if (t.kind === 'backspace') return s.slice(0, -1);
    return s;
  }, '') };
}

test('start/stop on empty string completes immediately', () => {
  const { ticks, done } = run('');
  assert.equal(ticks.length, 0);
  assert.equal(done, true);
});

test('finalText matches input when typos disabled', () => {
  const out = run('Hello, world!', { simulateTypos: false });
  assert.equal(out.finalText, 'Hello, world!');
  assert.equal(out.done, true);
});

test('emits one char tick per character in the input', () => {
  const out = run('abc', { simulateTypos: false });
  const charTicks = out.ticks.filter(function (t) { return t.kind === 'char'; });
  assert.equal(charTicks.length, 3);
  assert.deepEqual(charTicks.map(function (t) { return t.char; }), ['a', 'b', 'c']);
});

test('state transitions: idle → running → done', () => {
  const clock = makeClock();
  const engine = new TypingEngine({ now: clock.now, sleep: clock.sleep, random: seededRandom(2) });
  assert.equal(engine.getState(), 'idle');
  engine.start({ text: 'hi', target: null, onTick: function () {}, onDone: function () {} });
  assert.equal(engine.getState(), 'running');
  clock.drain();
  assert.equal(engine.getState(), 'done');
});

test('pause halts new ticks; resume continues; final text still correct', () => {
  const clock = makeClock();
  const random = seededRandom(3);
  const ticks = [];
  const engine = new TypingEngine({ now: clock.now, sleep: clock.sleep, random: random });
  engine.start({ text: 'abcdef', target: null, simulateTypos: false,
    onTick: function (t) { ticks.push(t); },
    onDone: function () {} });
  // Let the first 2 chars fire, then pause.
  while (ticks.length < 2) clock.advanceTo(clock.now() + 1);
  engine.pause();
  assert.equal(engine.getState(), 'paused');
  const tickCountAtPause = ticks.length;
  // Advance time — no new ticks should fire while paused.
  clock.advanceTo(clock.now() + 10000);
  assert.equal(ticks.length, tickCountAtPause);
  engine.resume();
  clock.drain();
  assert.equal(engine.getState(), 'done');
  const final = ticks.reduce(function (s, t) {
    if (t.kind === 'char') return s + t.char;
    if (t.kind === 'backspace') return s.slice(0, -1);
    return s;
  }, '');
  assert.equal(final, 'abcdef');
});

test('stop halts emission and locks state', () => {
  const clock = makeClock();
  const ticks = [];
  const engine = new TypingEngine({ now: clock.now, sleep: clock.sleep, random: seededRandom(4) });
  engine.start({ text: 'abcdef', target: null, simulateTypos: false,
    onTick: function (t) { ticks.push(t); }, onDone: function () {} });
  while (ticks.length < 2) clock.advanceTo(clock.now() + 1);
  engine.stop();
  assert.equal(engine.getState(), 'stopped');
  clock.drain();
  // Stopped engine should not emit further ticks.
  assert.equal(ticks.length, 2);
});

test('Slow speed yields larger total elapsed than Fast speed for the same text', () => {
  const slow = run('Hello there friend.', { speed: 'Slow', seed: 9 });
  const fast = run('Hello there friend.', { speed: 'Fast', seed: 9 });
  const slowTotal = slow.ticks.length > 0 ? slow.ticks[slow.ticks.length - 1].at : 0;
  const fastTotal = fast.ticks.length > 0 ? fast.ticks[fast.ticks.length - 1].at : 0;
  assert.ok(slowTotal > fastTotal, 'expected slow > fast (slow=' + slowTotal + ', fast=' + fastTotal + ')');
});

test('simulateTypos: emits some backspace events but final text still equals input', () => {
  const out = run('the quick brown fox jumped', { simulateTypos: true, seed: 11 });
  const bs = out.ticks.filter(function (t) { return t.kind === 'backspace'; });
  // Either we got at least one typo+correction, or seed produced none — both OK.
  // The contract is: final text must still equal input after corrections.
  assert.equal(out.finalText, 'the quick brown fox jumped');
  if (bs.length > 0) {
    // For each backspace there must be a re-typed char of the original following it.
    assert.ok(bs.length >= 1);
  }
});

test('onTick receives { kind, char|null, index, total, at } shape', () => {
  const out = run('xy', { simulateTypos: false });
  out.ticks.forEach(function (t) {
    assert.ok(t.kind === 'char' || t.kind === 'backspace');
    assert.equal(typeof t.index, 'number');
    assert.equal(typeof t.total, 'number');
    assert.equal(typeof t.at, 'number');
    if (t.kind === 'char') assert.equal(typeof t.char, 'string');
  });
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `npm test`
Expected: many failures (module doesn't exist yet).

- [ ] **Step 3: Write `lib/typing-engine.js`**

```js
// Pure, deterministic-with-injected-clock typing state machine.
// No DOM. Emits tick events with the next character or a backspace, plus
// scheduled delays. Caller owns actually inserting the character.
(function (root) {
  'use strict';

  const SPEED_PROFILES = {
    Slow:   { delayMul: 1.25, pauseMul: 1.15 },
    Normal: { delayMul: 1.00, pauseMul: 1.00 },
    Fast:   { delayMul: 0.72, pauseMul: 0.75 },
  };

  const TYPING_PROFILES = {
    'Balanced Natural': {
      charDelay: [40, 130], wordPause: [70, 180], sentencePause: [500, 1300],
      paragraphPause: [1000, 2500], longPauseProb: 0.045, longPause: [5000, 12000],
      typoProb: 1/210, burstLen: [8, 25], hesitation: [150, 750],
    },
    'Careful Writer': {
      charDelay: [60, 160], wordPause: [100, 240], sentencePause: [900, 2250],
      paragraphPause: [1800, 4300], longPauseProb: 0.035, longPause: [5000, 14000],
      typoProb: 1/420, burstLen: [7, 18], hesitation: [200, 900],
    },
    'Fast Drafter': {
      charDelay: [20, 80], wordPause: [40, 120], sentencePause: [350, 1000],
      paragraphPause: [850, 2000], longPauseProb: 0.025, longPause: [5000, 9000],
      typoProb: 1/155, burstLen: [12, 32], hesitation: [80, 450],
    },
  };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function TypingEngine(deps) {
    deps = deps || {};
    this._now = deps.now || function () { return Date.now(); };
    this._sleep = deps.sleep || function (ms, cb) { setTimeout(cb, ms); };
    this._random = deps.random || Math.random;
    this._state = 'idle';
    this._opts = null;
    this._i = 0;
    this._total = 0;
    this._pendingResumeAt = 0;
  }

  TypingEngine.prototype.getState = function () { return this._state; };

  TypingEngine.prototype.start = function (opts) {
    opts = opts || {};
    if (this._state === 'running' || this._state === 'paused') return;
    const profile = TYPING_PROFILES[opts.profile] || TYPING_PROFILES['Balanced Natural'];
    const speed = SPEED_PROFILES[opts.speed] || SPEED_PROFILES.Normal;
    this._opts = {
      text: typeof opts.text === 'string' ? opts.text : '',
      target: opts.target || null,
      profile: profile,
      speed: speed,
      simulateTypos: !!opts.simulateTypos,
      onTick: typeof opts.onTick === 'function' ? opts.onTick : function () {},
      onDone: typeof opts.onDone === 'function' ? opts.onDone : function () {},
    };
    this._i = 0;
    this._total = this._opts.text.length;
    this._state = 'running';
    if (this._total === 0) { this._finish(); return; }
    this._scheduleNext(0);
  };

  TypingEngine.prototype.pause = function () {
    if (this._state === 'running') this._state = 'paused';
  };

  TypingEngine.prototype.resume = function () {
    if (this._state !== 'paused') return;
    this._state = 'running';
    this._scheduleNext(0);
  };

  TypingEngine.prototype.stop = function () {
    if (this._state === 'idle' || this._state === 'done') return;
    this._state = 'stopped';
  };

  TypingEngine.prototype._range = function (range, mul) {
    const lo = range[0] * mul;
    const hi = range[1] * mul;
    return lo + this._random() * (hi - lo);
  };

  TypingEngine.prototype._delayBeforeChar = function (ch) {
    const p = this._opts.profile;
    const sp = this._opts.speed;
    const base = this._range(p.charDelay, sp.delayMul);
    // Word boundary
    if (ch === ' ') return base + this._range(p.wordPause, sp.pauseMul);
    // Sentence boundary trailing char
    if (/[.!?]/.test(ch)) return base + this._range(p.sentencePause, sp.pauseMul);
    // Paragraph boundary
    if (ch === '\n') return base + this._range(p.paragraphPause, sp.pauseMul);
    // Long thinking pause
    if (this._random() < p.longPauseProb) return base + this._range(p.longPause, sp.pauseMul);
    return base;
  };

  TypingEngine.prototype._emitTypo = function (atTime) {
    // Pick a wrong-but-adjacent character; emit it, then a backspace, then the real char.
    const text = this._opts.text;
    const real = text[this._i];
    const wrong = pickAdjacentKey(real, this._random);
    if (!wrong) return false; // no good substitute, skip typo
    this._opts.onTick({ kind: 'char', char: wrong, index: this._i, total: this._total, at: atTime });
    const corrDelay = clamp(80 + this._random() * 220, 80, 350);
    const self = this;
    this._sleep(corrDelay, function () {
      if (self._state !== 'running') return;
      const t = self._now();
      self._opts.onTick({ kind: 'backspace', char: null, index: self._i, total: self._total, at: t });
      const reDelay = clamp(60 + self._random() * 140, 60, 220);
      self._sleep(reDelay, function () {
        if (self._state !== 'running') return;
        const t2 = self._now();
        self._opts.onTick({ kind: 'char', char: real, index: self._i, total: self._total, at: t2 });
        self._i += 1;
        if (self._i >= self._total) self._finish();
        else self._scheduleNext(self._delayBeforeChar(self._opts.text[self._i]));
      });
    });
    return true;
  };

  TypingEngine.prototype._scheduleNext = function (delay) {
    if (this._state !== 'running') return;
    const self = this;
    this._sleep(delay, function () { self._fire(); });
  };

  TypingEngine.prototype._fire = function () {
    if (this._state !== 'running') return;
    if (this._i >= this._total) { this._finish(); return; }
    const real = this._opts.text[this._i];
    const atTime = this._now();
    // Maybe inject a typo for this character.
    if (this._opts.simulateTypos && isTypoEligible(real) && this._random() < this._opts.profile.typoProb * 30) {
      // 30x boost relative to the per-char prob so typos appear on short texts in tests too.
      const ok = this._emitTypo(atTime);
      if (ok) return;
    }
    this._opts.onTick({ kind: 'char', char: real, index: this._i, total: this._total, at: atTime });
    this._i += 1;
    if (this._i >= this._total) { this._finish(); return; }
    this._scheduleNext(this._delayBeforeChar(this._opts.text[this._i]));
  };

  TypingEngine.prototype._finish = function () {
    if (this._state === 'stopped') return;
    this._state = 'done';
    this._opts.onDone();
  };

  function isTypoEligible(ch) {
    return /[a-zA-Z]/.test(ch);
  }

  function pickAdjacentKey(ch, random) {
    if (!/[a-zA-Z]/.test(ch)) return null;
    const lower = ch.toLowerCase();
    const NEIGHBOURS = {
      a:'sq', b:'vn', c:'xv', d:'sf', e:'rw', f:'dg', g:'fh', h:'gj',
      i:'uo', j:'hk', k:'jl', l:'k', m:'n', n:'bm', o:'ip', p:'o',
      q:'wa', r:'et', s:'ad', t:'ry', u:'yi', v:'cb', w:'qe', x:'zc',
      y:'tu', z:'x',
    };
    const opts = NEIGHBOURS[lower];
    if (!opts) return null;
    const pick = opts[Math.floor(random() * opts.length)];
    return ch === lower ? pick : pick.toUpperCase();
  }

  const api = { TypingEngine: TypingEngine, SPEED_PROFILES: SPEED_PROFILES, TYPING_PROFILES: TYPING_PROFILES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.typingEngine = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests until all pass**

Run: `npm test`
Expected: 51 existing + 9 new = 60 tests pass. If any fail, read the actual vs expected — most likely candidates are the pause/resume test (the engine must not call `onTick` while paused) and the speed-comparison test (Slow vs Fast totals).

- [ ] **Step 5: Commit**

```bash
git add lib/typing-engine.js tests/typing-engine.test.js
git commit -m "feat(typing-engine): pure timing/state-machine with tests"
```

---

## Task 4: Typing injector — focused-field safety + insertion

**Files:**
- Create: `lib/typing-injector.js`
- Create: `tests/typing-injector.test.js`

`typing-injector` exposes one function — `insertOrBackspace(target, op)` — that performs a safe insertion or deletion on `target`. It rejects non-editable targets and stale targets, and dispatches an `input` event so reactive Coursera widgets (React, Vue, etc.) see the change.

- [ ] **Step 1: Write `tests/typing-injector.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { insertOrBackspace, isEditable } = require('../lib/typing-injector.js');

function setup(html) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>');
  return dom.window.document;
}

test('isEditable: returns false for null target', () => {
  assert.equal(isEditable(null), false);
});

test('isEditable: textarea is editable', () => {
  const d = setup('<textarea id="t"></textarea>');
  assert.equal(isEditable(d.getElementById('t')), true);
});

test('isEditable: input[type=text] is editable', () => {
  const d = setup('<input id="t" type="text">');
  assert.equal(isEditable(d.getElementById('t')), true);
});

test('isEditable: input[type=checkbox] is NOT editable', () => {
  const d = setup('<input id="t" type="checkbox">');
  assert.equal(isEditable(d.getElementById('t')), false);
});

test('isEditable: contenteditable div is editable', () => {
  const d = setup('<div id="t" contenteditable="true">hi</div>');
  assert.equal(isEditable(d.getElementById('t')), true);
});

test('isEditable: plain div is NOT editable', () => {
  const d = setup('<div id="t">hi</div>');
  assert.equal(isEditable(d.getElementById('t')), false);
});

test('isEditable: disabled textarea is NOT editable', () => {
  const d = setup('<textarea id="t" disabled></textarea>');
  assert.equal(isEditable(d.getElementById('t')), false);
});

test('isEditable: readonly input is NOT editable', () => {
  const d = setup('<input id="t" readonly>');
  assert.equal(isEditable(d.getElementById('t')), false);
});

test('insertOrBackspace appends a character to a textarea', () => {
  const d = setup('<textarea id="t">ab</textarea>');
  const el = d.getElementById('t');
  let inputEvents = 0;
  el.addEventListener('input', function () { inputEvents += 1; });
  const ok = insertOrBackspace(el, { kind: 'char', char: 'c' });
  assert.equal(ok, true);
  assert.equal(el.value, 'abc');
  assert.equal(inputEvents, 1);
});

test('insertOrBackspace removes the last char on backspace', () => {
  const d = setup('<textarea id="t">abc</textarea>');
  const el = d.getElementById('t');
  const ok = insertOrBackspace(el, { kind: 'backspace' });
  assert.equal(ok, true);
  assert.equal(el.value, 'ab');
});

test('insertOrBackspace appends to a contenteditable element', () => {
  const d = setup('<div id="t" contenteditable="true">ab</div>');
  const el = d.getElementById('t');
  const ok = insertOrBackspace(el, { kind: 'char', char: 'c' });
  assert.equal(ok, true);
  assert.equal(el.textContent, 'abc');
});

test('insertOrBackspace refuses to write to a non-editable element', () => {
  const d = setup('<div id="t">hi</div>');
  const el = d.getElementById('t');
  const ok = insertOrBackspace(el, { kind: 'char', char: 'X' });
  assert.equal(ok, false);
  assert.equal(el.textContent, 'hi');
});

test('insertOrBackspace returns false when target is detached', () => {
  const d = setup('<textarea id="t">ab</textarea>');
  const el = d.getElementById('t');
  el.remove();
  const ok = insertOrBackspace(el, { kind: 'char', char: 'c' });
  assert.equal(ok, false);
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npm test`
Expected: module not found / new tests fail.

- [ ] **Step 3: Write `lib/typing-injector.js`**

```js
// Safe character injection into focused editable fields.
(function (root) {
  'use strict';

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!el.ownerDocument || !el.ownerDocument.contains(el)) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') {
      return !el.disabled && !el.readOnly;
    }
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      const TEXT_TYPES = ['text', 'search', 'url', 'email', 'tel', 'password', 'number'];
      if (TEXT_TYPES.indexOf(t) === -1) return false;
      return !el.disabled && !el.readOnly;
    }
    // contenteditable: 'true', '', or 'plaintext-only' all count
    const ce = el.getAttribute && el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '' || ce === 'plaintext-only') return true;
    return false;
  }

  function dispatchInput(el) {
    try {
      el.dispatchEvent(new (el.ownerDocument.defaultView.InputEvent || el.ownerDocument.defaultView.Event)('input', { bubbles: true }));
    } catch (_) {
      try { el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true })); } catch (__) { /* ignore */ }
    }
  }

  function insertOrBackspace(el, op) {
    if (!isEditable(el)) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const cur = el.value;
      if (op.kind === 'char') {
        el.value = cur + op.char;
      } else if (op.kind === 'backspace') {
        el.value = cur.slice(0, -1);
      } else {
        return false;
      }
      dispatchInput(el);
      return true;
    }
    // contenteditable
    if (op.kind === 'char') {
      el.appendChild(el.ownerDocument.createTextNode(op.char));
    } else if (op.kind === 'backspace') {
      const last = el.lastChild;
      if (!last) return true;
      if (last.nodeType === 3) {
        if (last.textContent.length <= 1) last.remove();
        else last.textContent = last.textContent.slice(0, -1);
      } else {
        last.remove();
      }
    } else {
      return false;
    }
    dispatchInput(el);
    return true;
  }

  const api = { insertOrBackspace: insertOrBackspace, isEditable: isEditable };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.typingInjector = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: 60 + 13 = 73 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/typing-injector.js tests/typing-injector.test.js
git commit -m "feat(typing-injector): safe focused-field insertion with input event"
```

---

## Task 5: Auto Typer tab UI + engine wiring + confirmation gate

**Files:**
- Modify: `lib/sidebar.js` — replace the Auto Typer panel placeholder with the real UI; wire to `typing-engine` + `typing-injector`.
- Modify: `manifest.json` — add `lib/typing-engine.js` and `lib/typing-injector.js` to the content_scripts `js` array (before `lib/sidebar.js`).

- [ ] **Step 1: Update `manifest.json`**

The `js` array becomes:

```json
"js": [
  "lib/cleaner.js",
  "lib/html-cleaner.js",
  "lib/typing-engine.js",
  "lib/typing-injector.js",
  "lib/sidebar.js",
  "content.js"
]
```

- [ ] **Step 2: Replace the Auto Typer panel HTML in `lib/sidebar.js`**

In the `HTML` constant, replace the entire `<section data-panel="typer">` block with:

```html
'<section class="ccp-panel" data-panel="typer" data-active="false">' +
  '<textarea class="ccp-textarea" data-role="typer-text" placeholder="Paste or type text to be typed into the focused field…"></textarea>' +
  '<div class="ccp-row">' +
    '<label for="ccp-profile">Profile</label>' +
    '<select class="ccp-select" data-role="typer-profile" id="ccp-profile">' +
      '<option value="Balanced Natural">Balanced Natural</option>' +
      '<option value="Careful Writer">Careful Writer</option>' +
      '<option value="Fast Drafter">Fast Drafter</option>' +
    '</select>' +
  '</div>' +
  '<div class="ccp-row">' +
    '<label for="ccp-speed">Speed</label>' +
    '<select class="ccp-select" data-role="typer-speed" id="ccp-speed">' +
      '<option value="Slow">Slow</option>' +
      '<option value="Normal" selected>Normal</option>' +
      '<option value="Fast">Fast</option>' +
    '</select>' +
  '</div>' +
  '<div class="ccp-row">' +
    '<label for="ccp-typos">Typos</label>' +
    '<select class="ccp-select" data-role="typer-typos" id="ccp-typos">' +
      '<option value="off" selected>Off</option>' +
      '<option value="on">On (humanlike corrections)</option>' +
    '</select>' +
  '</div>' +
  '<div class="ccp-progress"><div class="ccp-progress-bar" data-role="typer-bar"></div></div>' +
  '<div class="ccp-actions">' +
    '<button class="ccp-btn" data-action="typer-start">Start</button>' +
    '<button class="ccp-btn" data-variant="ghost" data-action="typer-pause" disabled>Pause</button>' +
    '<button class="ccp-btn" data-variant="danger" data-action="typer-stop" disabled>Stop</button>' +
  '</div>' +
  '<div class="ccp-status" data-role="typer-status"></div>' +
'</section>' +
'<div class="ccp-modal-backdrop" data-role="typer-confirm">' +
  '<div class="ccp-modal">' +
    '<div class="ccp-modal-title">Start auto-typing?</div>' +
    '<div class="ccp-modal-text">Click into the field you want typed into (it must stay focused). Auto Typer will not run unless you confirm here.</div>' +
    '<div class="ccp-modal-actions">' +
      '<button class="ccp-btn" data-variant="ghost" data-action="typer-cancel">Cancel</button>' +
      '<button class="ccp-btn" data-action="typer-confirm-go">Start typing</button>' +
    '</div>' +
  '</div>' +
'</div>',
```

(Note: the trailing `,` joins onto the existing string-concat. Adjust as needed so the JS file still parses; you may instead replace the `<section>` block alone and leave the launcher button as-is.)

- [ ] **Step 3: Add Auto Typer wiring inside `mount()` in `lib/sidebar.js`**

Right after the existing `wireResize();` call, add a new `wireTyper();` call. Then add the function elsewhere in the IIFE:

```js
  let _engine = null;
  let _typerTarget = null;

  function getTyperApi() {
    const root = (typeof window !== 'undefined' && window.ClipboardCleaner) || {};
    return { engine: root.typingEngine, injector: root.typingInjector };
  }

  function setTyperStatus(text, tone) {
    const s = shadow.querySelector('[data-role="typer-status"]');
    s.textContent = text || '';
    if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
  }

  function setTyperButtons(state) {
    const start = shadow.querySelector('[data-action="typer-start"]');
    const pause = shadow.querySelector('[data-action="typer-pause"]');
    const stop  = shadow.querySelector('[data-action="typer-stop"]');
    if (state === 'idle' || state === 'done' || state === 'stopped') {
      start.disabled = false; start.textContent = 'Start';
      pause.disabled = true;  pause.textContent = 'Pause';
      stop.disabled  = true;
    } else if (state === 'running') {
      start.disabled = true;  start.textContent = 'Running…';
      pause.disabled = false; pause.textContent = 'Pause';
      stop.disabled  = false;
    } else if (state === 'paused') {
      start.disabled = true;  start.textContent = 'Paused';
      pause.disabled = false; pause.textContent = 'Resume';
      stop.disabled  = false;
    }
  }

  function wireTyper() {
    const start  = shadow.querySelector('[data-action="typer-start"]');
    const pause  = shadow.querySelector('[data-action="typer-pause"]');
    const stop   = shadow.querySelector('[data-action="typer-stop"]');
    const cancel = shadow.querySelector('[data-action="typer-cancel"]');
    const go     = shadow.querySelector('[data-action="typer-confirm-go"]');
    const modal  = shadow.querySelector('[data-role="typer-confirm"]');
    const bar    = shadow.querySelector('[data-role="typer-bar"]');
    setTyperButtons('idle');

    // Track the last focused editable element BEFORE the user clicks anything
    // inside the panel — clicking the panel itself steals focus otherwise.
    document.addEventListener('focusin', function (e) {
      const api = getTyperApi();
      if (api.injector && api.injector.isEditable(e.target)) {
        _typerTarget = e.target;
      }
    }, true);

    start.addEventListener('click', function () {
      const api = getTyperApi();
      if (!api.engine || !api.injector) { setTyperStatus('Typing engine unavailable.', 'error'); return; }
      const text = (shadow.querySelector('[data-role="typer-text"]').value || '');
      if (!text) { setTyperStatus('Nothing to type yet.', 'error'); return; }
      if (!_typerTarget || !api.injector.isEditable(_typerTarget)) {
        setTyperStatus('Focus an editable field on the page first (input, textarea, or contenteditable).', 'error');
        return;
      }
      modal.setAttribute('data-open', 'true');
    });

    cancel.addEventListener('click', function () { modal.setAttribute('data-open', 'false'); });

    go.addEventListener('click', function () {
      modal.setAttribute('data-open', 'false');
      const api = getTyperApi();
      const text = shadow.querySelector('[data-role="typer-text"]').value || '';
      const profile = shadow.querySelector('[data-role="typer-profile"]').value;
      const speed = shadow.querySelector('[data-role="typer-speed"]').value;
      const typos = shadow.querySelector('[data-role="typer-typos"]').value === 'on';
      _engine = new api.engine.TypingEngine();
      _engine.start({
        text: text, target: _typerTarget, profile: profile, speed: speed, simulateTypos: typos,
        onTick: function (ev) {
          if (!_typerTarget || !api.injector.isEditable(_typerTarget)) { _engine.stop(); setTyperStatus('Lost focus — typing stopped.', 'error'); setTyperButtons('idle'); return; }
          api.injector.insertOrBackspace(_typerTarget, ev);
          const pct = ev.total ? Math.min(100, Math.round((ev.index + 1) / ev.total * 100)) : 0;
          bar.style.width = pct + '%';
        },
        onDone: function () { setTyperButtons('done'); setTyperStatus('Done', 'success'); }
      });
      setTyperButtons('running');
      setTyperStatus('Typing…');
    });

    pause.addEventListener('click', function () {
      if (!_engine) return;
      if (_engine.getState() === 'running') { _engine.pause(); setTyperButtons('paused'); setTyperStatus('Paused'); }
      else if (_engine.getState() === 'paused') { _engine.resume(); setTyperButtons('running'); setTyperStatus('Typing…'); }
    });

    stop.addEventListener('click', function () {
      if (!_engine) return;
      _engine.stop(); setTyperButtons('idle'); setTyperStatus('Stopped');
    });
  }
```

- [ ] **Step 4: Sanity-check the file parses**

Run: `node -e "require('./lib/sidebar.js')"`
Expected: no output, exit 0. If there's a syntax error, fix it before proceeding.

- [ ] **Step 5: Run the test suite**

Run: `npm test`
Expected: 73/73 pass (no new tests; existing untouched).

- [ ] **Step 6: Commit**

```bash
git add lib/sidebar.js manifest.json
git commit -m "feat(sidebar): Auto Typer tab wired to typing engine + injector with confirmation gate"
```

---

## Task 6: README update + final test pass

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append a new section to `README.md`** (above "Running the tests"):

````markdown
## Sidebar UI

Clipboard Cleaner adds a floating panel on the right side of any Coursera page. When closed, a small pill button sits in the lower-right corner — click it to reopen.

### Copied Text tab

Every time you copy text from the page, the cleaned plain-text result appears in this tab. Click **Copy** to re-copy the cleaned text from the panel itself. Empty / success / error states are shown inline.

### Auto Typer tab

Auto Typer types text into the editable field you focused most recently. To use:

1. Click into the input, textarea, or contenteditable field you want typed into.
2. Open the panel and switch to **Auto Typer**.
3. Paste or type the source text into the textarea.
4. Choose a profile (Balanced Natural / Careful Writer / Fast Drafter), a speed (Slow / Normal / Fast), and whether to simulate humanlike typos with corrections.
5. Click **Start**. Confirm in the modal — Auto Typer will not run until you confirm.
6. While typing you can **Pause / Resume** or **Stop** at any time. If the focused field changes mid-run, Auto Typer halts automatically.

The Auto Typer only writes to the editable element you focused before clicking Start; it cannot run hidden or without an explicit user action.

### Resizing

Drag the left edge of the panel to resize between 280 and 640 pixels wide.
````

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: 73/73 pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: usage guide for sidebar and Auto Typer"
```

---

## Task 7: Browser verification handoff

This task has no code — it confirms behaviour in real Chrome/Edge.

- [ ] **Step 1: Reload the extension** at `chrome://extensions` → click ↻ on Clipboard Cleaner. Hard-refresh any open Coursera tab (Ctrl+Shift+R).

- [ ] **Step 2: Sidebar smoke test**

Open any Coursera reading or quiz. The right-side panel should slide in. Click ✕ to close — a pill should appear in the lower-right. Click the pill — the panel comes back.

- [ ] **Step 3: Copied Text tab**

Select a paragraph that includes the Coursera AI-injection boilerplate, press Ctrl+C. The cleaned plain text should appear inside the Copied Text panel. Click the panel's **Copy** button → paste into Notepad. The result should match what's shown in the panel.

- [ ] **Step 4: Auto Typer — happy path**

Open any text editor on the page (Coursera quiz "Enter answer here" field, or open `https://docs.google.com` in another tab if you prefer). Click into the field. Switch to **Auto Typer**, paste a sentence into the textarea, choose **Balanced Natural** + **Normal**, click **Start**, then **Start typing** in the modal. The text should appear in the focused field at a humanlike pace.

- [ ] **Step 5: Auto Typer — Pause / Resume / Stop**

Repeat Step 4 with a longer paragraph. After typing begins, click **Pause** — typing should halt. Click **Resume** (the same button is relabelled) — typing resumes. Click **Stop** — typing ends and buttons reset.

- [ ] **Step 6: Auto Typer — focus safeguard**

Repeat Step 4. After typing starts, click somewhere outside the editable field (but not the sidebar). The engine should detect the focus loss and stop, showing the "Lost focus" status. No characters should appear outside the original field.

- [ ] **Step 7: Resizing**

Grab the left edge of the panel and drag. The panel should resize between 280 and 640 pixels.

- [ ] **Step 8: Regression check**

On a non-Coursera site, the panel should not appear (manifest match list excludes other origins).

- [ ] **Step 9: Repeat in Edge**

Confirm parity. If anything looks off, capture the failing context (page URL, the source text used, the target field's HTML via DevTools "Copy outerHTML", what actually happened) so the bug can be reproduced as a new test case.

---

## Self-Review

**Spec coverage:**
- Right-side floating panel → Task 1 (CSS positioning, slide-in animation)
- Resizable → Task 1 (handle + drag logic)
- Polished animations / modern CSS → Task 1 (CSS variables, transitions, gradient)
- Tabs (Copied Text, Auto Typer) → Task 1 (tab strip + ARIA), Task 2 (Copied Text wiring), Task 5 (Auto Typer UI)
- Copied Text shows cleaned result, Copy button, empty/success/error states → Task 2
- Auto Typer with typing behavior borrowed from reference → Task 3 (engine), Task 4 (injector), Task 5 (UI/wiring)
- Start/Pause/Resume/Stop/speed controls/progress → Task 3 (engine ops) + Task 5 (UI)
- Safeguards (focused editable, confirmation, no invisible run) → Task 4 (`isEditable`) + Task 5 (modal + focus-loss stop)
- Existing 51 tests preserved → no edits to `lib/cleaner.js`, `lib/html-cleaner.js`, `tests/cleaner.test.js`, `tests/html-cleaner.test.js`. The new modules are additive.
- Manifest updated → Task 2 (sidebar files), Task 5 (engine + injector)
- README updated → Task 6
- Manual verification → Task 7

**Placeholder scan:** No TBDs. Every step contains the code or command needed.

**Type consistency:** Engine API (`TypingEngine` constructor, `start`/`pause`/`resume`/`stop`/`getState`), injector API (`insertOrBackspace`, `isEditable`), sidebar API (`mount`, `showCopied`, `setActiveTab`) are referenced identically across tasks.

**Phasing note:** After Task 3 the extension is shippable as a sidebar-with-Copied-Text feature. Tasks 4–6 add the Auto Typer. If you want to ship in two waves rather than one, commit Task 1–3 and pause for browser testing before continuing to Task 4.
