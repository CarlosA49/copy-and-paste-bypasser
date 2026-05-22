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
      const ccRoot = (typeof window !== 'undefined') ? window.ClipboardCleaner : null;
      const applier = ccRoot && ccRoot.answerApplier;
      if (!parser || !matcher) { setAnswerStatus('Answer engine unavailable.', 'error'); return; }
      const raw = ta.value || '';
      if (!raw.trim()) { setAnswerStatus('Paste an answer first.', 'error'); return; }

      // Render the legacy parsed summary chips so the user sees the parsed
      // candidates regardless of which pipeline runs.
      let parsed;
      try { parsed = parser.parseAnswerText(raw); } catch (_) { parsed = null; }
      if (parsed) renderAnswerSummary(parsed);

      // Try the numbered pipeline first.
      if (applier && typeof applier.applyAnswers === 'function') {
        let out;
        try {
          out = applier.applyAnswers(raw, document.body, { verbose: true });
        } catch (_) {
          out = null;
        }
        if (out && out.parsedAnswers > 0) {
          const s = out.summary;
          const parts = ['Filled ' + s.filled + '/' + s.total];
          if (s.failed) parts.push(s.failed + ' failed');
          if (s.missingAnswers) parts.push(s.missingAnswers + ' missing answer' + (s.missingAnswers === 1 ? '' : 's'));
          if (s.missingQuestions) parts.push(s.missingQuestions + ' extra answer' + (s.missingQuestions === 1 ? '' : 's'));
          const tone = (s.failed === 0 && s.missingAnswers === 0) ? 'success' : 'warn';
          setAnswerStatus(parts.join(', '), tone);
          return;
        }
        // parsedAnswers === 0 — fall through to legacy path.
      }

      if (applier && typeof applier.applyAnswers === 'function') {
        try { console.log('[answer-applier] fallback=legacy'); } catch (_) { /* ignore */ }
      }

      // Legacy fallback: letters / quoted snippets / positional text values.
      if (!parsed) { setAnswerStatus('Could not parse the pasted text.', 'error'); return; }
      const hasAnyCandidate = parsed.letters.length + parsed.numbers.length + parsed.quotedSnippets.length + (parsed.computedValues ? parsed.computedValues.length : 0);
      if (!hasAnyCandidate) { setAnswerStatus('No answer candidates found in the pasted text.', 'error'); return; }
      const groups = matcher.findOptionGroups(document.body);
      const matches = (groups.length > 0) ? matcher.matchCandidates(groups, parsed) : [];
      const optionSummary = (matches.length > 0) ? matcher.applyMatches(matches) : { selected: 0, skipped: 0 };
      const textInputs = matcher.findTextInputs ? matcher.findTextInputs(document.body) : [];
      const textMatches = matcher.matchTextInputs ? matcher.matchTextInputs(textInputs, parsed) : [];
      const textSummary = (textMatches.length > 0 && matcher.applyTextMatches) ? matcher.applyTextMatches(textMatches) : { filled: 0, skipped: 0 };
      const did = optionSummary.selected + textSummary.filled;
      if (did === 0) { setAnswerStatus('No options matched the parsed answer, and no text fields could be filled.', 'error'); return; }
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

  const api = { mount: mount, open: open, close: close, toggle: toggle, setActiveTab: setActiveTab, showCopied: showCopied };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.sidebar = api;
  }
})(typeof self !== 'undefined' ? self : this);
