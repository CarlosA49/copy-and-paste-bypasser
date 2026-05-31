'use strict';
// lib/ui-revision.js
// U13 — source-controlled UI revision label. The manifest version (1.0.0) is
// unchanged across multiple code revisions, so it cannot distinguish loaded
// builds in the unpacked extension. This module exports a single string that
// every plan iteration bumps (U13, U14, ...) so a user reloading the unpacked
// extension can visually confirm which revision Chrome actually picked up.
//
// Display surfaces: Diagnostics tab footer (sidebar) and options-page footer.

(function (root) {
  'use strict';

  var CCP_UI_REVISION = 'U13';

  function populateUiRevisionTag(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
    var nodes = rootEl.querySelectorAll('[data-role="ccp-ui-revision"]');
    var text = 'UI Revision: ' + CCP_UI_REVISION;
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = text;
  }

  var api = { CCP_UI_REVISION: CCP_UI_REVISION, populateUiRevisionTag: populateUiRevisionTag };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.uiRevision = api; }
})(typeof self !== 'undefined' ? self : this);
