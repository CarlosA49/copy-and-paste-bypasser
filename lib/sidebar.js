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
        '<button class="ccp-tab" role="tab" aria-selected="false" data-tab="answer">Answering for you</button>' +
        '<button class="ccp-tab" role="tab" aria-selected="false" data-tab="autopilot">Autopilot</button>' +
        '<button class="ccp-tab" role="tab" aria-selected="false" data-tab="diagnostics">Diagnostics</button>' +
        '<button class="ccp-tab" role="tab" aria-selected="false" data-tab="ai-answer">AI Answers</button>' +
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
        '<section class="ccp-panel" data-panel="answer" data-active="false">' +
          '<textarea class="ccp-textarea" data-role="answer-text" placeholder="Paste an answer (e.g. \'The answer is A and C\' or quoted option text) — Apply will tick the matching options on the page."></textarea>' +
          '<div class="ccp-answer-summary" data-role="answer-summary"></div>' +
          '<div class="ccp-actions">' +
            '<button class="ccp-btn" data-action="answer-apply">Apply to page</button>' +
            '<button class="ccp-btn" data-variant="ghost" data-action="answer-clear">Clear</button>' +
          '</div>' +
          '<div class="ccp-status" data-role="answer-status"></div>' +
        '</section>' +
        '<section class="ccp-panel" data-panel="autopilot" data-active="false">' +
          '<div class="ccp-autopilot-status" data-role="autopilot-status">Idle</div>' +
          '<div class="ccp-autopilot-current" data-role="autopilot-current"></div>' +
          '<div class="ccp-progress"><div class="ccp-progress-bar" data-role="autopilot-bar"></div></div>' +
          '<div class="ccp-actions">' +
            '<button class="ccp-btn" data-action="autopilot-run">Finish current module</button>' +
            '<button class="ccp-btn" data-action="autopilot-run-all">Finish all modules</button>' +
            '<button class="ccp-btn" data-variant="danger" data-action="autopilot-stop" disabled>Stop</button>' +
            '<button class="ccp-btn" data-action="autopilot-resume" hidden>Resume</button>' +
            '<button class="ccp-btn" data-action="autopilot-takeover" hidden>Take over this tab</button>' +
          '</div>' +
          '<div class="ccp-row">' +
            '<label><input type="checkbox" data-role="autopilot-pause-on-input"> Pause on keyboard/mouse input</label>' +
          '</div>' +
          '<div class="ccp-row">' +
            '<label><input type="checkbox" data-role="autopilot-auto-submit-quizzes"> Auto-submit quizzes after autofill</label>' +
          '</div>' +
          '<div class="ccp-row" style="margin-top:6px;">' +
            '<span class="ccp-label">Behavior:</span>' +
            '<label><input type="radio" name="ccp-behavior" data-role="autopilot-behavior-fast" value="fast" checked> Fast</label>' +
            '<label><input type="radio" name="ccp-behavior" data-role="autopilot-behavior-human" value="human"> Human</label>' +
          '</div>' +
          '<div class="ccp-autopilot-log" data-role="autopilot-log"></div>' +
          '<div class="ccp-status" data-role="autopilot-banner"></div>' +
        '</section>' +
        '<section class="ccp-panel" data-panel="diagnostics" data-active="false">' +
          '<div class="ccp-diag-build" data-role="ccp-build">Build: —</div>' +
          '<div class="ccp-diag-revision" data-role="ccp-ui-revision">UI Revision: —</div>' +
          '<div class="ccp-diag-header">' +
            '<div><strong>Status:</strong> <span data-role="diag-status">idle</span></div>' +
            '<div><strong>Mode:</strong> <span data-role="diag-mode">fast</span> &nbsp; <strong>Scope:</strong> <span data-role="diag-scope">module</span></div>' +
            '<div><strong>Cursor:</strong> <span data-role="diag-cursor">0</span> / <span data-role="diag-queue-size">0</span></div>' +
            '<div><strong>Current:</strong> <span data-role="diag-current"></span></div>' +
          '</div>' +
          '<div class="ccp-actions">' +
            '<button class="ccp-btn" data-action="diag-copy">Copy debug report</button>' +
            '<button class="ccp-btn" data-variant="ghost" data-action="diag-clear">Clear</button>' +
          '</div>' +
          '<div class="ccp-status" data-role="diag-status-line"></div>' +
          '<div class="ccp-diag-events" data-role="diag-events" style="overflow:auto; max-height:380px; font-family:monospace; font-size:11px;"></div>' +
        '</section>' +
        '<section class="ccp-panel" data-panel="ai-answer" data-active="false">' +
          '<div class="ccp-ai-card" data-card="ai-card-key">' +
            '<div class="ccp-ai-card-header">AI API Key</div>' +
            '<div class="ccp-ai-status-pill" data-role="ai-key-state">No AI API Key configured.</div>' +
            '<div class="ccp-ai-note" data-role="ai-key-note">Your AI API Key is entered only in extension settings, never on Coursera.</div>' +
            '<div class="ccp-ai-row">' +
              '<button class="ccp-btn" data-action="ai-key-configure">Manage AI API Key</button>' +
            '</div>' +
            '<div class="ccp-ai-status-line" data-role="ai-open-options-status" data-tone="warn" hidden></div>' +
          '</div>' +
          '<div class="ccp-ai-card" data-card="ai-card-managed" hidden>' +
            '<div class="ccp-ai-card-header">AI Credits</div>' +
            '<div class="ccp-ai-status-pill" data-role="ai-managed-state">Managed AI Credits are not yet available in this build.</div>' +
            '<div class="ccp-ai-note">No API key required. Credits will power generation through a hosted service once available.</div>' +
            '<div class="ccp-ai-row">' +
              '<button class="ccp-btn" data-action="ai-open-portal" disabled>Get AI Credits</button>' +
            '</div>' +
          '</div>' +
          '<div class="ccp-ai-card" data-card="ai-card-scan">' +
            '<div class="ccp-ai-card-header">Page status</div>' +
            '<div class="ccp-ai-status-line" data-role="ai-status">Click Scan questions to detect supported unanswered questions on this page.</div>' +
          '</div>' +
          '<div class="ccp-ai-actions" data-card="ai-actions-primary">' +
            '<button class="ccp-btn" data-action="ai-scan">Scan questions</button>' +
            '<button class="ccp-btn" data-action="ai-generate">Generate suggestions</button>' +
          '</div>' +
          '<div class="ccp-ai-actions" data-card="ai-actions-secondary">' +
            '<button class="ccp-btn" data-action="ai-apply">Apply answers</button>' +
            '<button class="ccp-btn" data-variant="ghost" data-action="ai-clear-suggestions">Clear suggestions</button>' +
          '</div>' +
          '<div class="ccp-ai-actions" data-card="ai-actions-inflight">' +
            '<button class="ccp-btn" data-variant="danger" data-action="ai-cancel" hidden>Cancel request</button>' +
          '</div>' +
          '<div class="ccp-ai-previews" data-card="ai-previews">' +
            '<div class="ccp-ai-preview-block" data-role="ai-scan-preview"></div>' +
            '<div class="ccp-ai-preview-block" data-role="ai-suggestion-preview"></div>' +
            '<div class="ccp-ai-preview-block" data-role="ai-apply-result"></div>' +
          '</div>' +
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
        '</div>' +
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

  let _debugRecorder = null;
  // After Stop, the autopilot state is cleared and the content-script poller
  // pushes an idle/empty context. We remember the most recent ACTIVE context
  // separately so the copied debug report still surfaces the last useful
  // queue/scope/cursor instead of an empty header. Cleared on the Clear
  // button so a stale report cannot be shown.
  let _lastActiveRunContext = null;
  let _debugUnsubscribe = null;
  let _lastRunContext = null;

  // Translate machine-readable skip-reason codes from applyTextMatches into
  // user-facing phrases for the Apply status line.
  const HUMAN_REASONS = {
    'detached': 'field not editable',
    'no-variants': 'no matching value',
    'rejected-empty': 'rejected characters',
    'rejected-throw': 'value rejected by field',
    'value-did-not-stick': 'value did not stick',
  };

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
    wireTyper();
    wireAnswer();
    wireAutopilot();
    wireDiagnostics();
    wireAiAnswer();
    populateBuildTag();
    try {
      var helper = (typeof self !== 'undefined' && self.ClipboardCleaner && self.ClipboardCleaner.uiRevision) ? self.ClipboardCleaner.uiRevision : null;
      if (!helper && typeof require === 'function') { try { helper = require('../lib/ui-revision.js'); } catch (_) {} }
      if (helper && typeof helper.populateUiRevisionTag === 'function') helper.populateUiRevisionTag(shadow);
    } catch (_) { /* never let revision label rendering crash mount() */ }

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

  let _engine = null;
  let _typerTarget = null;

  function getTyperApi() {
    const r = (typeof window !== 'undefined' && window.ClipboardCleaner) || {};
    return { engine: r.typingEngine, injector: r.typingInjector };
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
      const tApi = getTyperApi();
      if (tApi.injector && tApi.injector.isEditable(e.target)) {
        _typerTarget = e.target;
      }
    }, true);

    start.addEventListener('click', function () {
      const tApi = getTyperApi();
      if (!tApi.engine || !tApi.injector) { setTyperStatus('Typing engine unavailable.', 'error'); return; }
      const text = (shadow.querySelector('[data-role="typer-text"]').value || '');
      if (!text) { setTyperStatus('Nothing to type yet.', 'error'); return; }
      if (!_typerTarget || !tApi.injector.isEditable(_typerTarget)) {
        setTyperStatus('Focus an editable field on the page first (input, textarea, or contenteditable).', 'error');
        return;
      }
      modal.setAttribute('data-open', 'true');
    });

    cancel.addEventListener('click', function () { modal.setAttribute('data-open', 'false'); });

    go.addEventListener('click', function () {
      modal.setAttribute('data-open', 'false');
      const tApi = getTyperApi();
      const text = shadow.querySelector('[data-role="typer-text"]').value || '';
      const profile = shadow.querySelector('[data-role="typer-profile"]').value;
      const speed = shadow.querySelector('[data-role="typer-speed"]').value;
      const typos = shadow.querySelector('[data-role="typer-typos"]').value === 'on';
      _engine = new tApi.engine.TypingEngine();
      _engine.start({
        text: text, target: _typerTarget, profile: profile, speed: speed, simulateTypos: typos,
        onTick: function (ev) {
          if (!_typerTarget || !tApi.injector.isEditable(_typerTarget)) { _engine.stop(); setTyperStatus('Lost focus — typing stopped.', 'error'); setTyperButtons('idle'); return; }
          tApi.injector.insertOrBackspace(_typerTarget, ev);
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

  function getAnswerApi() {
    const r = (typeof window !== 'undefined' && window.ClipboardCleaner) || {};
    return { parser: r.answerParser, matcher: r.answerMatcher };
  }

  function setAnswerStatus(text, tone) {
    const s = shadow.querySelector('[data-role="answer-status"]');
    if (!s) return;
    s.textContent = text || '';
    if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
  }

  function renderAnswerSummary(parsed) {
    const box = shadow.querySelector('[data-role="answer-summary"]');
    if (!box) return;
    box.textContent = '';
    if (!parsed) return;
    const chips = [];
    (parsed.letters || []).forEach(function (l) { chips.push('Letter ' + l); });
    (parsed.numbers || []).forEach(function (n) { chips.push('#' + n); });
    (parsed.quotedSnippets || []).forEach(function (s) {
      const trimmed = s.length > 30 ? s.slice(0, 27) + '…' : s;
      chips.push('"' + trimmed + '"');
    });
    (parsed.computedValues || []).forEach(function (cv) {
      const cleaner = (window.ClipboardCleaner && window.ClipboardCleaner.answerParser && window.ClipboardCleaner.answerParser.cleanFillValue)
        || function (s) { return (typeof s === 'string' ? s.trim() : ''); };
      const display = cleaner(cv.raw) || cv.raw;
      chips.push(display);
    });
    const doc = box.ownerDocument || document;
    chips.forEach(function (txt) {
      const span = doc.createElement('span');
      span.className = 'ccp-chip';
      span.textContent = txt;
      box.appendChild(span);
    });
  }

  function wireAnswer() {
    const apply = shadow.querySelector('[data-action="answer-apply"]');
    const clear = shadow.querySelector('[data-action="answer-clear"]');
    const ta    = shadow.querySelector('[data-role="answer-text"]');
    if (!apply || !clear || !ta) return;

    // Live preview of parsed candidates as the user pastes/edits.
    ta.addEventListener('input', function () {
      const { parser } = getAnswerApi();
      if (!parser) return;
      try { renderAnswerSummary(parser.parseAnswerText(ta.value || '')); } catch (_) { /* ignore */ }
    });

    apply.addEventListener('click', function () {
      const { parser, matcher } = getAnswerApi();
      if (!parser || !matcher) { setAnswerStatus('Answer engine unavailable.', 'error'); return; }
      const raw = ta.value || '';
      if (!raw.trim()) { setAnswerStatus('Paste an answer first.', 'error'); return; }
      const parsed = parser.parseAnswerText(raw);
      renderAnswerSummary(parsed);
      const hasAnyCandidate = parsed.letters.length + parsed.numbers.length + parsed.quotedSnippets.length + (parsed.computedValues ? parsed.computedValues.length : 0);
      if (!hasAnyCandidate) {
        setAnswerStatus('No answer candidates found in the pasted text.', 'error');
        return;
      }
      const groups = matcher.findOptionGroups(document.body);
      const matches = (groups.length > 0) ? matcher.matchCandidates(groups, parsed) : [];
      const optionSummary = (matches.length > 0)
        ? matcher.applyMatches(matches)
        : { selected: 0, skipped: 0 };

      const textInputs = matcher.findTextInputs ? matcher.findTextInputs(document.body) : [];
      const textMatches = matcher.matchTextInputs
        ? matcher.matchTextInputs(textInputs, parsed)
        : [];
      const textSummary = (textMatches.length > 0 && matcher.applyTextMatches)
        ? matcher.applyTextMatches(textMatches)
        : { filled: 0, skipped: 0 };

      const did = optionSummary.selected + textSummary.filled;
      if (did === 0) {
        setAnswerStatus('No options matched the parsed answer, and no text fields could be filled.', 'error');
        return;
      }
      const parts = [];
      if (optionSummary.selected > 0) parts.push('Selected ' + optionSummary.selected);
      if (textSummary.filled > 0)     parts.push('Filled ' + textSummary.filled);
      const skipped = (optionSummary.skipped || 0) + (textSummary.skipped || 0);
      if (skipped) parts.push('(' + skipped + ' skipped)');

      // Confidence + count-mismatch warning. Filled values stay filled; we just
      // warn the user to double-check.
      const warnings = [];
      const cvs = (parsed.computedValues || []);
      const hasLow = cvs.some(function (cv) { return cv.confidence === 'low'; });
      if (hasLow) warnings.push('low confidence — verify values');
      if (textInputs.length > 0 && cvs.length !== textInputs.length && cvs.length > 0) {
        warnings.push(cvs.length + ' value(s) vs ' + textInputs.length + ' input(s)');
      }

      // Aggregate text-input skip reasons into a short phrase like
      // "1 rejected characters, 2 value did not stick". (HUMAN_REASONS at module scope.)
      const textReasons = (textSummary.reasons || []);
      if (textReasons.length > 0) {
        const counts = {};
        textReasons.forEach(function (r) { counts[r] = (counts[r] || 0) + 1; });
        const parts2 = Object.keys(counts).map(function (r) {
          const human = HUMAN_REASONS[r] || r;
          return counts[r] === 1 ? human : (counts[r] + ' ' + human);
        });
        warnings.push(parts2.join(', '));
      }

      const tone = warnings.length > 0 ? 'warn' : 'success';
      const msg = parts.join(', ') + (warnings.length ? ' — ' + warnings.join('; ') : '');
      setAnswerStatus(msg, tone);
    });

    clear.addEventListener('click', function () {
      ta.value = '';
      renderAnswerSummary(null);
      setAnswerStatus('');
    });
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

  let _autopilotHandlers = {
    onRun: null,
    onStop: null,
    onResume: null,
    onTakeOver: null,
    onSettingsChange: null,
  };

  function setAutopilotStatus(text, meta) {
    if (!shadow) return;
    const s = shadow.querySelector('[data-role="autopilot-status"]');
    if (s) s.textContent = text || '';
    if (meta && meta.current) {
      const c = shadow.querySelector('[data-role="autopilot-current"]');
      if (c) c.textContent = meta.current;
    }
    if (meta && typeof meta.progressPct === 'number') {
      const bar = shadow.querySelector('[data-role="autopilot-bar"]');
      if (bar) bar.style.width = Math.max(0, Math.min(100, meta.progressPct)) + '%';
    }
  }

  function appendAutopilotLog(entry) {
    if (!shadow) return;
    const box = shadow.querySelector('[data-role="autopilot-log"]');
    if (!box) return;
    const line = (shadow.ownerDocument || document).createElement('div');
    line.className = 'ccp-autopilot-log-line';
    line.textContent = entry || '';
    box.appendChild(line);
    while (box.children.length > 20) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function setAutopilotPaused(isPaused, bannerText, opts) {
    if (!shadow) return;
    const resumeBtn   = shadow.querySelector('[data-action="autopilot-resume"]');
    const takeoverBtn = shadow.querySelector('[data-action="autopilot-takeover"]');
    const banner      = shadow.querySelector('[data-role="autopilot-banner"]');
    if (resumeBtn)   resumeBtn.hidden = !isPaused;
    if (takeoverBtn) takeoverBtn.hidden = !(isPaused && opts && opts.offerTakeover);
    if (banner)      banner.textContent = bannerText || '';
  }

  function setAutopilotButtonsRunning(isRunning) {
    if (!shadow) return;
    const run    = shadow.querySelector('[data-action="autopilot-run"]');
    const runAll = shadow.querySelector('[data-action="autopilot-run-all"]');
    const stop   = shadow.querySelector('[data-action="autopilot-stop"]');
    if (run)    run.disabled    = isRunning;
    if (runAll) runAll.disabled = isRunning;
    if (stop)   stop.disabled   = !isRunning;
  }

  // PHASE 17 — startup busy state. While a startup is pending, Run/Run-All
  // must be disabled so a rapid second click cannot start a competing
  // activation. When the startup ends, we re-enable Run/Run-All ONLY if we
  // are not already in a confirmed running state (proxied by Stop being
  // enabled). The controller-level startup gate is the true safety boundary;
  // this is purely a visible cue.
  function setAutopilotButtonsStarting(isStarting) {
    if (!shadow) return;
    const run    = shadow.querySelector('[data-action="autopilot-run"]');
    const runAll = shadow.querySelector('[data-action="autopilot-run-all"]');
    if (isStarting) {
      if (run)    run.disabled    = true;
      if (runAll) runAll.disabled = true;
      return;
    }
    const stop = shadow.querySelector('[data-action="autopilot-stop"]');
    const running = !!(stop && !stop.disabled);
    if (run)    run.disabled    = running;
    if (runAll) runAll.disabled = running;
  }

  function getAnswerText() {
    if (!shadow) return '';
    const ta = shadow.querySelector('[data-role="answer-text"]');
    return ta ? (ta.value || '') : '';
  }

  function _formatDiagDetails(d) {
    if (!d || typeof d !== 'object') return '';
    return Object.keys(d).map(function (k) {
      const v = d[k];
      if (v && typeof v === 'object') return k + '=' + JSON.stringify(v);
      if (typeof v === 'string') {
        // Quote strings that contain whitespace, ", or non-identifier chars.
        return /[\s"]|[^\w.\-:\/]/.test(v) ? (k + '=' + JSON.stringify(v)) : (k + '=' + v);
      }
      return k + '=' + String(v);
    }).join(' ');
  }

  function _renderDiagEvent(ev) {
    if (!shadow || !ev) return;
    const box = shadow.querySelector('[data-role="diag-events"]');
    if (!box) return;
    const doc = (shadow.ownerDocument || document);
    const line = doc.createElement('div');
    line.className = 'ccp-diag-event';
    line.textContent = (ev.at || '') + ' ' + (ev.type || '') + ' ' + _formatDiagDetails(ev.details);
    box.appendChild(line);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function _clearDiagEvents() {
    if (!shadow) return;
    const box = shadow.querySelector('[data-role="diag-events"]');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
  }

  function setDebugRecorder(rec) {
    if (_debugUnsubscribe) { try { _debugUnsubscribe(); } catch (_) {} _debugUnsubscribe = null; }
    _debugRecorder = rec || null;
    if (!_debugRecorder) return;
    if (!mounted) mount();
    _clearDiagEvents();
    if (typeof _debugRecorder.getEvents === 'function') {
      _debugRecorder.getEvents().forEach(_renderDiagEvent);
    }
    if (typeof _debugRecorder.subscribe === 'function') {
      _debugUnsubscribe = _debugRecorder.subscribe(function (ev) {
        if (ev === null) _clearDiagEvents();
        else _renderDiagEvent(ev);
      });
    }
  }

  function setAutopilotRunContext(ctx) {
    _lastRunContext = ctx || null;
    // Track the most recent "active" snapshot (running/paused with a non-empty
    // queue) so a report taken after Stop can still cite course scope/queue.
    if (ctx && (ctx.status === 'running' || ctx.status === 'paused') && (ctx.queueLength || (ctx.queue && ctx.queue.length))) {
      _lastActiveRunContext = ctx;
    }
    if (!shadow) return;
    ctx = ctx || {};
    const map = {
      'diag-status': ctx.status || 'idle',
      'diag-mode':   ctx.behaviorMode || 'fast',
      'diag-scope':  ctx.runScope || 'module',
      'diag-cursor': String(ctx.cursor == null ? 0 : ctx.cursor),
      'diag-queue-size': String(ctx.queueLength == null ? 0 : ctx.queueLength),
      'diag-current': ctx.currentTitle ? (ctx.currentTitle + (ctx.currentKind ? ' (' + ctx.currentKind + ')' : '')) : '',
    };
    Object.keys(map).forEach(function (role) {
      const el = shadow.querySelector('[data-role="' + role + '"]');
      if (el) el.textContent = map[role];
    });
  }

  function setAutopilotHandlers(handlers) {
    _autopilotHandlers = Object.assign({}, _autopilotHandlers, handlers || {});
  }

  // One-way sync of effective stored settings INTO the UI. Triggered by the
  // content script after the autopilot state has been loaded (and migrated, if
  // applicable). Does NOT call back into onSettingsChange — otherwise we would
  // echo the loaded value right back into storage, undoing migrations.
  function setAutopilotSettings(settings) {
    if (!mounted) mount();
    if (!shadow || !settings) return;
    const pi    = shadow.querySelector('[data-role="autopilot-pause-on-input"]');
    const as    = shadow.querySelector('[data-role="autopilot-auto-submit-quizzes"]');
    const bFast = shadow.querySelector('[data-role="autopilot-behavior-fast"]');
    const bHuman= shadow.querySelector('[data-role="autopilot-behavior-human"]');
    if (pi && typeof settings.pauseOnUserInput === 'boolean') pi.checked = settings.pauseOnUserInput;
    if (as && typeof settings.autoSubmitQuizzes === 'boolean') as.checked = settings.autoSubmitQuizzes;
    if (typeof settings.behaviorMode === 'string') {
      if (bFast)  bFast.checked  = settings.behaviorMode === 'fast';
      if (bHuman) bHuman.checked = settings.behaviorMode === 'human';
    }
  }

  function _setDiagStatus(text, tone) {
    if (!shadow) return;
    const s = shadow.querySelector('[data-role="diag-status-line"]');
    if (!s) return;
    s.textContent = text || '';
    if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
  }

  function populateBuildTag() {
    if (!shadow) return;
    var version = '';
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        var m = chrome.runtime.getManifest();
        if (m && typeof m.version === 'string') version = m.version;
      }
    } catch (_) { /* ignore — jsdom or restricted context */ }
    var text = 'Build: ' + (version || '—');
    var els = shadow.querySelectorAll('[data-role="ccp-build"]');
    for (var i = 0; i < els.length; i++) els[i].textContent = text;
  }

  function wireDiagnostics() {
    if (!shadow) return;
    const copyBtn = shadow.querySelector('[data-action="diag-copy"]');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        const rec = _debugRecorder;
        // Resolve formatDebugReport from CommonJS in Node tests OR from window.ClipboardCleaner in the browser.
        let dbg = null;
        if (typeof window !== 'undefined' && window.ClipboardCleaner && window.ClipboardCleaner.autopilotDebug) {
          dbg = window.ClipboardCleaner.autopilotDebug;
        } else if (typeof require === 'function') {
          try { dbg = require('../lib/autopilot-debug.js'); } catch (_) { dbg = null; }
        }
        if (!rec || !dbg || typeof dbg.formatDebugReport !== 'function') {
          _setDiagStatus('Diagnostics recorder not attached.', 'error');
          return;
        }
        // Compose the snapshot context: take the most recent active run's
        // queue/scope/courseId/moduleId/cursor as the base so a report taken
        // after Stop still surfaces what was running. Overlay the current
        // (possibly idle) context's status / lastPauseReason on top.
        let snapCtx;
        if (_lastActiveRunContext && (!_lastRunContext || !(_lastRunContext.queueLength || (_lastRunContext.queue && _lastRunContext.queue.length)))) {
          const cur = _lastRunContext || {};
          snapCtx = Object.assign({}, _lastActiveRunContext, {
            status: cur.status || _lastActiveRunContext.status,
            lastPauseReason: cur.lastPauseReason || _lastActiveRunContext.lastPauseReason,
          });
        } else {
          snapCtx = _lastRunContext || {};
        }
        let snap;
        try {
          snap = (typeof rec.snapshot === 'function')
            ? rec.snapshot(snapCtx)
            : { capturedAt: new Date().toISOString(), context: snapCtx, events: rec.getEvents() };
        } catch (_) {
          _setDiagStatus('Could not build snapshot.', 'error');
          return;
        }
        let text;
        try { text = dbg.formatDebugReport(snap); } catch (_) {
          _setDiagStatus('Could not format report.', 'error');
          return;
        }
        // Prefer the clipboard from the shadow's own document window so that
        // test environments (jsdom) can inject a mock via dom.window.navigator.clipboard.
        const _win = (shadow && shadow.ownerDocument && shadow.ownerDocument.defaultView)
          || (typeof window !== 'undefined' ? window : null);
        const _clip = _win && _win.navigator && _win.navigator.clipboard;
        const clip = (_clip && typeof _clip.writeText === 'function')
          ? _clip.writeText(text)
          : Promise.reject(new Error('clipboard unavailable'));
        clip.then(function () {
          _setDiagStatus('Debug report copied to clipboard.', 'success');
        }).catch(function (err) {
          _setDiagStatus('Copy failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
        });
      });
    }
    const clearBtn = shadow.querySelector('[data-action="diag-clear"]');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (_debugRecorder && typeof _debugRecorder.clear === 'function') {
          try { _debugRecorder.clear(); } catch (_) {}
        }
        // Both cached contexts are intentionally forgotten so a Clear-then-Copy
        // cycle cannot surface a stale prior run. If the autopilot is still
        // running, the content-script's 2s poll repopulates both shortly.
        _lastActiveRunContext = null;
        _lastRunContext = null;
        _clearDiagEvents();
        _setDiagStatus('Cleared.', 'success');
      });
    }
  }

  function wireAutopilot() {
    const run      = shadow.querySelector('[data-action="autopilot-run"]');
    const runAll   = shadow.querySelector('[data-action="autopilot-run-all"]');
    const stop     = shadow.querySelector('[data-action="autopilot-stop"]');
    const resume   = shadow.querySelector('[data-action="autopilot-resume"]');
    const takeover = shadow.querySelector('[data-action="autopilot-takeover"]');
    const pi       = shadow.querySelector('[data-role="autopilot-pause-on-input"]');
    const as       = shadow.querySelector('[data-role="autopilot-auto-submit-quizzes"]');
    const bFast    = shadow.querySelector('[data-role="autopilot-behavior-fast"]');
    const bHuman   = shadow.querySelector('[data-role="autopilot-behavior-human"]');
    if (run) {
      run.addEventListener('click', function () {
        if (_autopilotHandlers.onRun) _autopilotHandlers.onRun();
      });
    }
    if (runAll) {
      runAll.addEventListener('click', function () {
        if (_autopilotHandlers.onRunAllModules) _autopilotHandlers.onRunAllModules();
      });
    }
    if (stop) {
      stop.addEventListener('click', function () {
        if (_autopilotHandlers.onStop) _autopilotHandlers.onStop();
      });
    }
    if (resume) {
      resume.addEventListener('click', function () {
        if (_autopilotHandlers.onResume) _autopilotHandlers.onResume();
      });
    }
    if (takeover) {
      takeover.addEventListener('click', function () {
        if (_autopilotHandlers.onTakeOver) _autopilotHandlers.onTakeOver();
      });
    }
    function emitSettings() {
      const behaviorMode = (bFast && bFast.checked) ? 'fast' : 'human';
      if (_autopilotHandlers.onSettingsChange) {
        _autopilotHandlers.onSettingsChange({
          pauseOnUserInput: !!(pi && pi.checked),
          autoSubmitQuizzes: !!(as && as.checked),
          behaviorMode: behaviorMode,
        });
      }
    }
    if (pi) pi.addEventListener('change', emitSettings);
    if (as) as.addEventListener('change', emitSettings);
    if (bFast)  bFast.addEventListener('change', emitSettings);
    if (bHuman) bHuman.addEventListener('change', emitSettings);
  }

  // === Let AI answer for you — handler registry and state ===

  let _aiAnswerHandlers = {
    onOpenOptions: null, onOpenPortal: null, onScan: null, onGenerate: null,
    onCancel: null, onApply: null, onClearSuggestions: null,
  };
  let _aiState = {
    keyPresent: false,
    eligible: null, blockedReason: null, supportedCount: 0,
    snapshot: null, suggestions: null, inFlight: false,
    accessMode: 'personal-key',
  };

  function setAiAnswerHandlers(h) { _aiAnswerHandlers = Object.assign({}, _aiAnswerHandlers, h || {}); }

  var VALID_AI_ACCESS_MODES = { 'personal-key': true, 'managed-credits': true };

  function setAiAccessMode(mode) {
    if (!shadow) return;
    var normalized = VALID_AI_ACCESS_MODES[mode] ? mode : 'personal-key';
    _aiState.accessMode = normalized;
    var byok = shadow.querySelector('[data-card="ai-card-key"]');
    var managed = shadow.querySelector('[data-card="ai-card-managed"]');
    if (byok) byok.hidden = (normalized !== 'personal-key');
    if (managed) managed.hidden = (normalized !== 'managed-credits');
    _renderAiButtonStates();
  }

  function setAiManagedStatus(state) {
    if (!shadow) return;
    var managed = shadow.querySelector('[data-card="ai-card-managed"]');
    var pill = shadow.querySelector('[data-role="ai-managed-state"]');
    if (state && state.message && pill) pill.textContent = String(state.message);
    if (managed) {
      if (state && state.available === false) managed.classList.add('ccp-ai-card--unavailable');
      else managed.classList.remove('ccp-ai-card--unavailable');
    }
    _renderAiButtonStates();
  }

  function setAiOpenOptionsFailure(text) {
    if (!shadow) return;
    var el = shadow.querySelector('[data-role="ai-open-options-status"]');
    if (!el) return;
    var s = (typeof text === 'string') ? text : '';
    el.textContent = s;
    if (s.length === 0) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function setAiKeyStatus(statusOrBool) {
    var keyPresent, remembered;
    if (typeof statusOrBool === 'object' && statusOrBool !== null) {
      keyPresent = !!statusOrBool.keyPresent;
      remembered = !!statusOrBool.remembered;
    } else {
      keyPresent = !!statusOrBool;
      remembered = false;
    }
    _aiState.keyPresent = keyPresent;
    const el = shadow.querySelector('[data-role="ai-key-state"]');
    if (el) {
      if (!keyPresent) el.textContent = 'No AI API Key configured.';
      else if (remembered) el.textContent = 'AI API Key remembered on this browser.';
      else el.textContent = 'AI API Key configured for this session.';
    }
    _renderAiStatusText();
    _renderAiButtonStates();
  }

  function setAiPageEligibility(state) {
    _aiState.eligible = !!(state && state.eligible);
    _aiState.blockedReason = state && state.blockedReason || null;
    _aiState.supportedCount = (state && state.supportedCount) || 0;
    _aiState.actionableCount = (state && state.actionableCount) || 0;
    _renderAiStatusText();
    _renderAiButtonStates();
  }

  function _renderAiStatusText() {
    if (!shadow) return;
    const status = shadow.querySelector('[data-role="ai-status"]');
    if (!status) return;
    if (!_aiState.snapshot) {
      status.textContent = 'Click Scan questions to detect supported unanswered questions.';
      return;
    }
    if (!_aiState.keyPresent) {
      status.textContent = 'Enter your AI API Key (click Manage AI API Key below) to enable Generate suggestions.';
      return;
    }
    if (_aiState.actionableCount === 0) {
      if (_aiState.supportedCount > 0) {
        status.textContent = 'All ' + _aiState.supportedCount + ' supported question(s) on this page are already answered.';
      } else {
        status.textContent = 'No supported questions detected on this page.';
      }
      return;
    }
    status.textContent = 'Ready: ' + _aiState.actionableCount + ' unanswered question(s) detected. Click Generate suggestions.';
  }

  function setAiScanResult(snapshot) {
    _aiState.snapshot = snapshot || null;
    _renderAiStatusText();
    const el = shadow.querySelector('[data-role="ai-scan-preview"]');
    if (el) {
      while (el.firstChild) el.removeChild(el.firstChild);
      if (snapshot) {
        const doc = el.ownerDocument || document;
        const summary = doc.createElement('div');
        summary.textContent = 'Detected ' + snapshot.questions.length + ' questions (' + (snapshot.supportedCount || 0) + ' supported).';
        el.appendChild(summary);
        const ul = doc.createElement('ul');
        for (let i = 0; i < snapshot.questions.length; i++) {
          const q = snapshot.questions[i];
          const li = doc.createElement('li');
          const prompt = (q.prompt || '').toString().slice(0, 80);
          li.textContent = 'Q' + (q.questionNumber || (i+1)) + ' — ' + (q.type || '?') + ' — ' + prompt + (q.supported ? '' : ' (unsupported)');
          ul.appendChild(li);
        }
        el.appendChild(ul);
      }
    }
    _renderAiButtonStates();
  }

  function setAiSuggestions(list) {
    _aiState.suggestions = list || null;
    const el = shadow.querySelector('[data-role="ai-suggestion-preview"]');
    if (el) {
      while (el.firstChild) el.removeChild(el.firstChild);
      if (list) {
        const doc = el.ownerDocument || document;
        const summary = doc.createElement('div');
        summary.textContent = 'Got ' + list.length + ' suggestions.';
        el.appendChild(summary);
        const ul = doc.createElement('ul');
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          let ansText = '';
          if (s.choiceText) ansText = String(s.choiceText);
          else if (s.choiceTexts) ansText = s.choiceTexts.map(function (t) { return String(t); }).join(', ');
          else if (s.value) ansText = String(s.value);
          const li = doc.createElement('li');
          li.textContent = 'Q' + (s.questionNumber == null ? '?' : s.questionNumber) + ' — '
            + (s.mappingStatus || '?') + ' — ' + ansText
            + (s.explanation ? ' — ' + String(s.explanation).slice(0, 120) : '');
          ul.appendChild(li);
        }
        el.appendChild(ul);
      }
    }
    _renderAiButtonStates();
  }

  function setAiInFlight(flag) {
    _aiState.inFlight = !!flag;
    _renderAiButtonStates();
  }

  function setAiApplyResult(res) {
    const el = shadow.querySelector('[data-role="ai-apply-result"]');
    if (!el) return;
    if (!res) { el.textContent = ''; return; }
    if (res.message) {
      el.textContent = String(res.message);
      return;
    }
    el.textContent = 'Applied ' + (res.filled || 0) + ' answers; skipped ' + (res.failed || 0) + '.';
  }

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

  function wireAiAnswer() {
    const configure = shadow.querySelector('[data-action="ai-key-configure"]');
    const scan      = shadow.querySelector('[data-action="ai-scan"]');
    const gen       = shadow.querySelector('[data-action="ai-generate"]');
    const cancel    = shadow.querySelector('[data-action="ai-cancel"]');
    const apply     = shadow.querySelector('[data-action="ai-apply"]');
    const clearS    = shadow.querySelector('[data-action="ai-clear-suggestions"]');
    if (!configure || !scan || !gen || !cancel || !apply || !clearS) return;

    configure.addEventListener('click', function () { if (_aiAnswerHandlers.onOpenOptions) _aiAnswerHandlers.onOpenOptions(); });
    const portalBtn = shadow.querySelector('[data-action="ai-open-portal"]');
    if (portalBtn) {
      portalBtn.addEventListener('click', function () {
        if (_aiAnswerHandlers.onOpenPortal) _aiAnswerHandlers.onOpenPortal();
      });
    }
    scan     .addEventListener('click', function () { if (_aiAnswerHandlers.onScan)        _aiAnswerHandlers.onScan(); });
    gen      .addEventListener('click', function () { if (_aiAnswerHandlers.onGenerate)    _aiAnswerHandlers.onGenerate(); });
    cancel   .addEventListener('click', function () { if (_aiAnswerHandlers.onCancel)      _aiAnswerHandlers.onCancel(); });
    apply    .addEventListener('click', function () { if (_aiAnswerHandlers.onApply)       _aiAnswerHandlers.onApply(); });
    clearS   .addEventListener('click', function () { if (_aiAnswerHandlers.onClearSuggestions) _aiAnswerHandlers.onClearSuggestions(); setAiSuggestions(null); setAiApplyResult(null); });

    _renderAiButtonStates();
  }

  const api = {
    mount: mount, open: open, close: close, toggle: toggle,
    setActiveTab: setActiveTab, showCopied: showCopied,
    setAutopilotStatus: setAutopilotStatus,
    appendAutopilotLog: appendAutopilotLog,
    setAutopilotPaused: setAutopilotPaused,
    setAutopilotButtonsRunning: setAutopilotButtonsRunning,
    setAutopilotButtonsStarting: setAutopilotButtonsStarting,
    setAutopilotHandlers: setAutopilotHandlers,
    setAutopilotSettings: setAutopilotSettings,
    getAnswerText: getAnswerText,
    setDebugRecorder: setDebugRecorder,
    setAutopilotRunContext: setAutopilotRunContext,
    setAiAnswerHandlers: setAiAnswerHandlers,
    setAiAccessMode: setAiAccessMode,
    setAiManagedStatus: setAiManagedStatus,
    setAiKeyStatus: setAiKeyStatus,
    setAiOpenOptionsFailure: setAiOpenOptionsFailure,
    setAiPageEligibility: setAiPageEligibility,
    setAiScanResult: setAiScanResult,
    setAiSuggestions: setAiSuggestions,
    setAiInFlight: setAiInFlight,
    setAiApplyResult: setAiApplyResult,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.sidebar = api;
  }
})(typeof self !== 'undefined' ? self : this);
