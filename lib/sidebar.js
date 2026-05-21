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
