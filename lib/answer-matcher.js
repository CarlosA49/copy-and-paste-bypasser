// lib/answer-matcher.js
// DOM matcher: finds quiz option groups, matches parsed candidates, applies selection.
(function (root) {
  'use strict';

  const answerParser = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./answer-parser.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.answerParser) || null;
  })();

  function cleanFillValue(s) {
    if (answerParser && typeof answerParser.cleanFillValue === 'function') {
      return answerParser.cleanFillValue(s);
    }
    return (typeof s === 'string') ? s.trim() : '';
  }

  function textOf(el) {
    if (!el) return '';
    // Prefer associated label content. Fall back to the element's own text.
    const id = el.id;
    let labelText = '';
    if (id) {
      const lbl = el.ownerDocument.querySelector('label[for="' + cssEscape(id) + '"]');
      if (lbl) labelText = lbl.textContent || '';
    }
    if (!labelText) {
      const wrappingLabel = el.closest && el.closest('label');
      if (wrappingLabel) labelText = wrappingLabel.textContent || '';
    }
    if (!labelText) labelText = el.textContent || '';
    return labelText.replace(/\s+/g, ' ').trim();
  }

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  function isUsable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  function findNativeGroups(root) {
    const groups = new Map();
    const anonIds = new WeakMap();
    const anonCounter = { n: 0 };
    const inputs = root.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    inputs.forEach(function (inp) {
      if (!isUsable(inp)) return;
      if (!isVisible(inp)) return;
      const kind = inp.type === 'radio' ? 'radio' : 'checkbox';
      let key;
      let name;
      if (inp.name) {
        name = inp.name;
        key = kind + '::name::' + name;
      } else {
        // Anonymous: bucket by nearest grouping ancestor so unrelated fieldsets stay separate.
        const ancestor = inp.closest && inp.closest('fieldset,[role="radiogroup"],[role="group"]');
        if (ancestor) {
          let id = anonIds.get(ancestor);
          if (!id) { id = '__anonGroup__:' + (++anonCounter.n); anonIds.set(ancestor, id); }
          name = id;
          key = kind + '::ancestor::' + name;
        } else {
          // No grouping ancestor — each input is its own group.
          name = '__anonInput__:' + (++anonCounter.n);
          key = kind + '::input::' + name;
        }
      }
      if (!groups.has(key)) groups.set(key, { kind: kind, name: name, options: [] });
      groups.get(key).options.push({ el: inp, text: textOf(inp), index: groups.get(key).options.length });
    });
    return Array.from(groups.values()).filter(function (g) { return g.options.length > 0; });
  }

  function findAriaGroups(root) {
    const out = [];
    const radioGroups = root.querySelectorAll('[role="radiogroup"]');
    radioGroups.forEach(function (rg) {
      const items = rg.querySelectorAll('[role="radio"]');
      if (items.length === 0) return;
      const options = [];
      items.forEach(function (it, i) {
        if (!isUsable(it)) return;
        if (!isVisible(it)) return;
        options.push({ el: it, text: textOf(it), index: i });
      });
      if (options.length > 0) {
        const name = rg.id || ('__aria__:' + (out.length + 1));
        out.push({ kind: 'radio', name: name, options: options });
      }
    });
    const groupContainers = root.querySelectorAll('[role="group"]');
    const seenChecks = new Set();
    groupContainers.forEach(function (gc) {
      const items = gc.querySelectorAll('[role="checkbox"]');
      if (items.length === 0) return;
      const options = [];
      items.forEach(function (it, i) {
        if (seenChecks.has(it)) return;  // claimed by an outer container already
        if (!isUsable(it)) return;
        if (!isVisible(it)) return;
        seenChecks.add(it);
        options.push({ el: it, text: textOf(it), index: options.length });
      });
      if (options.length > 0) {
        const name = gc.id || ('__aria__:' + (out.length + 1));
        out.push({ kind: 'checkbox', name: name, options: options });
      }
    });
    const looseChecks = root.querySelectorAll('[role="checkbox"]');
    const orphan = [];
    looseChecks.forEach(function (it, i) {
      if (seenChecks.has(it)) return;
      if (!isUsable(it)) return;
      if (!isVisible(it)) return;
      orphan.push({ el: it, text: textOf(it), index: orphan.length });
    });
    if (orphan.length > 0) out.push({ kind: 'checkbox', name: '__aria_loose__:' + (out.length + 1), options: orphan });
    return out;
  }

  function findOptionGroups(root) {
    if (!root) return [];
    return findNativeGroups(root).concat(findAriaGroups(root));
  }

  function normalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const STOP = new Set(['the','a','an','of','to','in','and','or','for','is','are','on','with','by']);

  function tokenize(s) {
    return normalize(s).split(' ').filter(function (t) { return t.length > 1 && !STOP.has(t); });
  }

  function jaccard(aTokens, bTokens) {
    if (aTokens.length === 0 || bTokens.length === 0) return 0;
    const a = new Set(aTokens), b = new Set(bTokens);
    let inter = 0;
    a.forEach(function (t) { if (b.has(t)) inter += 1; });
    const uni = a.size + b.size - inter;
    return uni === 0 ? 0 : inter / uni;
  }

  // Determines whether an element (and all ancestors up to <html>) are visible
  // in the rendered tree. Hidden/aria-hidden/display:none/visibility:hidden at
  // any level filters the element out.
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden === true) return false;
    if (el.type === 'hidden') return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      if (cur.style && (cur.style.display === 'none' || cur.style.visibility === 'hidden')) return false;
      // Computed style honours stylesheets too (real browser). In JSDOM this
      // mostly reflects inline styles, so the inline checks above already cover
      // the common test cases.
      const view = cur.ownerDocument && cur.ownerDocument.defaultView;
      if (view && view.getComputedStyle) {
        try {
          const cs = view.getComputedStyle(cur);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
        } catch (_) { /* JSDOM may throw on detached nodes */ }
      }
      cur = cur.parentElement;
    }
    return true;
  }

  // Text-entry targets: <input> of a text-like type, <textarea>, contenteditable.
  // Disabled/readonly/hidden are skipped. Order preserved.
  function findTextInputs(root) {
    if (!root) return [];
    const out = [];
    const TEXT_INPUT_TYPES = ['text', 'number', 'email', 'tel', 'url', 'password'];
    const els = root.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]');
    els.forEach(function (el) {
      if (!isUsable(el)) return;
      if (el.readOnly) return;
      if (!isVisible(el)) return;
      const tag = (el.tagName || '').toUpperCase();
      let kind;
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (TEXT_INPUT_TYPES.indexOf(t) === -1) return;
        kind = 'input';
      } else if (tag === 'TEXTAREA') {
        kind = 'textarea';
      } else {
        kind = 'contenteditable';
      }
      out.push({ el: el, kind: kind });
    });
    return out;
  }

  function matchCandidates(groups, parsed) {
    const out = [];
    if (!Array.isArray(groups) || !parsed) return out;
    groups.forEach(function (g) {
      if (!g || !Array.isArray(g.options)) return;
      const groupMatches = [];
      // letters: A=0, B=1, ...
      (parsed.letters || []).forEach(function (ch) {
        const idx = ch.charCodeAt(0) - 65;
        if (idx >= 0 && idx < g.options.length) {
          groupMatches.push({ group: g, option: g.options[idx], reason: 'letter', score: 1.0 });
        }
      });
      // numbers: 1-based
      (parsed.numbers || []).forEach(function (n) {
        const idx = n - 1;
        if (idx >= 0 && idx < g.options.length) {
          groupMatches.push({ group: g, option: g.options[idx], reason: 'number', score: 0.95 });
        }
      });
      // quoted snippets: direct substring, then token overlap
      (parsed.quotedSnippets || []).forEach(function (sn) {
        const snipNorm = normalize(sn);
        if (!snipNorm) return;
        const direct = g.options.find(function (o) { return normalize(o.text).indexOf(snipNorm) !== -1; });
        if (direct) {
          groupMatches.push({ group: g, option: direct, reason: 'snippet', score: 0.9 });
          return;
        }
        const snipTokens = tokenize(sn);
        let best = null; let bestScore = 0;
        g.options.forEach(function (o) {
          const sc = jaccard(snipTokens, tokenize(o.text));
          if (sc > bestScore) { bestScore = sc; best = o; }
        });
        if (best && bestScore >= 0.34) {
          groupMatches.push({ group: g, option: best, reason: 'overlap', score: bestScore });
        }
      });
      // De-dup by option element, keep highest-score reason
      const byEl = new Map();
      groupMatches.forEach(function (m) {
        const prev = byEl.get(m.option.el);
        if (!prev || m.score > prev.score) byEl.set(m.option.el, m);
      });
      let final = Array.from(byEl.values());
      // Radio groups: keep only the single highest-score match
      if (g.kind === 'radio' && final.length > 1) {
        final.sort(function (a, b) {
          return (b.score - a.score) || (a.option.index - b.option.index);
        });
        final = [final[0]];
      }
      // Preserve discovery order within the group
      final.sort(function (a, b) { return a.option.index - b.option.index; });
      final.forEach(function (m) { out.push(m); });
    });
    return out;
  }

  function matchTextInputs(textInputs, parsed) {
    const out = [];
    if (!Array.isArray(textInputs) || !parsed) return out;
    const values = Array.isArray(parsed.computedValues) ? parsed.computedValues : [];
    if (values.length === 0) return out;
    const limit = Math.min(textInputs.length, values.length);
    for (let i = 0; i < limit; i++) {
      const ti = textInputs[i];
      const cv = values[i];
      if (!ti || !ti.el || !cv) continue;
      out.push({ el: ti.el, value: cv.raw, reason: 'computedValue' });
    }
    return out;
  }

  function dispatch(el, type) {
    try {
      const ev = new el.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    } catch (_) { /* ignore */ }
  }

  function applyMatches(matches) {
    let selected = 0, skipped = 0;
    if (!Array.isArray(matches)) return { selected: 0, skipped: 0 };
    matches.forEach(function (m) {
      const el = m && m.option && m.option.el;
      if (!el || !el.ownerDocument || !el.ownerDocument.contains(el)) { skipped += 1; return; }
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || '').toLowerCase();
        if (t === 'radio' || t === 'checkbox') {
          if (!el.checked) {
            el.checked = true;
            dispatch(el, 'click');
            dispatch(el, 'input');
            dispatch(el, 'change');
          } else {
            dispatch(el, 'click');
          }
          selected += 1;
          return;
        }
      }
      // ARIA path: just click; the host page's handler updates aria-checked.
      dispatch(el, 'click');
      selected += 1;
    });
    return { selected: selected, skipped: skipped };
  }

  function setNativeValue(el, value) {
    // React (and some other frameworks) override the prototype `value`
    // descriptor on inputs/textareas. Setting via the native descriptor and
    // dispatching `input` is the standard "make framework see this" pattern.
    // Own-property overrides (e.g. tests, some frameworks) take precedence.
    //
    // Descriptor *lookup* is wrapped in try/catch so that exotic getter/setter
    // enumeration failures don't crash us. But the setter *invocation* itself
    // is intentionally NOT caught here — callers (trySetAndVerify) own that
    // responsibility, so they can try the next variant on throw.
    let ownDesc;
    try { ownDesc = Object.getOwnPropertyDescriptor(el, 'value'); } catch (_) { /* ignore */ }
    if (ownDesc && typeof ownDesc.set === 'function') {
      ownDesc.set.call(el, value);
      return;
    }
    let protoDesc;
    try {
      const proto = Object.getPrototypeOf(el);
      protoDesc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    } catch (_) { /* ignore */ }
    if (protoDesc && typeof protoDesc.set === 'function') {
      protoDesc.set.call(el, value);
      return;
    }
    el.value = value;
  }

  // True when the element is <input type="number">. Number inputs cannot
  // accept unit suffixes (e.g. "1.0e-6 H") — the variant chain skips those
  // forms preemptively so the first attempted setter call is parseable.
  function isNumberInput(el) {
    if (!el || (el.tagName || '').toUpperCase() !== 'INPUT') return false;
    return (el.getAttribute('type') || '').toLowerCase() === 'number';
  }

  // True when a string is shaped like a number that <input type="number">
  // would accept: optional sign, digits, optional fractional part, optional
  // exponent. Decimal point at start ".5" is also accepted (HTML spec).
  function isNumberShaped(s) {
    return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s);
  }

  // Build an ordered list of value variants to try for a text-input fill.
  // The first variant is the cleaned raw (e.g. "1.0e-6 H"). Then numeric-only
  // ("1.0e-6"). Then plain decimal expansion ("0.000001") for fields that
  // reject scientific notation. Empty / NaN-derived variants are skipped.
  function buildVariants(match, targetEl) {
    const variants = [];
    const seen = new Set();
    function push(v) {
      const t = cleanFillValue(v);
      if (t && !seen.has(t)) { seen.add(t); variants.push(t); }
    }
    const cleaned = cleanFillValue(match && match.value);
    push(cleaned);

    // Numeric-only: the first numeric token in the cleaned string. Matches
    // standard forms (42, -3.14, 1.0e-6) and dot-leading forms (.5, -.5).
    const numMatch = cleaned.match(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/);
    if (numMatch) push(numMatch[0]);

    // Plain-decimal expansion (only useful when the value is in e-notation
    // and the magnitude is in a sensible range).
    if (numMatch) {
      const num = parseFloat(numMatch[0]);
      if (Number.isFinite(num) && num !== 0) {
        const abs = Math.abs(num);
        if (abs >= 1e-9 && abs < 1e15) {
          // toFixed(10) keeps numbers like 0.0352 representable without
          // float-imprecision artefacts (toFixed(20) would emit a trailing "212").
          const dec = num.toFixed(10).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
          push(dec);
        }
      } else if (num === 0) {
        push('0');
      }
    }

    // For <input type="number">, drop variants that aren't number-shaped.
    // This prevents wasted setter attempts (and DOMException throws) on the
    // unit-containing form.
    if (isNumberInput(targetEl)) {
      return variants.filter(isNumberShaped);
    }
    return variants;
  }

  // Set a value, dispatch events, and read it back. Returns {ok, reason}.
  // The value-setter call is wrapped in try/catch because some inputs
  // (notably <input type="number">) throw a DOMException when the assigned
  // string cannot be parsed as a number. We treat that as a rejected variant
  // and let the caller try the next one.
  function trySetAndVerify(el, value) {
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      try {
        setNativeValue(el, value);
      } catch (_) {
        return { ok: false, reason: 'rejected-throw' };
      }
      dispatch(el, 'input');
      dispatch(el, 'change');
      const actual = (el.value == null) ? '' : String(el.value);
      if (actual === value) return { ok: true };
      if (actual && actual.trim() === value.trim()) return { ok: true };
      if (!actual) return { ok: false, reason: 'rejected-empty' };
      return { ok: false, reason: 'value-did-not-stick' };
    }
    // contenteditable
    try {
      el.textContent = value;
    } catch (_) {
      return { ok: false, reason: 'rejected-throw' };
    }
    dispatch(el, 'input');
    const actualCE = (el.textContent == null) ? '' : String(el.textContent);
    if (actualCE === value) return { ok: true };
    if (!actualCE) return { ok: false, reason: 'rejected-empty' };
    return { ok: false, reason: 'value-did-not-stick' };
  }

  function applyTextMatches(matches) {
    const results = [];
    if (!Array.isArray(matches)) return { filled: 0, skipped: 0, reasons: [], results: [] };

    matches.forEach(function (m) {
      const el = m && m.el;
      if (!el || !el.ownerDocument || !el.ownerDocument.contains(el)) {
        results.push({ el: el, filled: false, reason: 'detached' });
        return;
      }
      const variants = buildVariants(m, el);
      if (variants.length === 0) {
        results.push({ el: el, filled: false, reason: 'no-variants' });
        return;
      }
      let success = false;
      let lastReason = 'value-did-not-stick';
      // variantIndex indexes into the variants list as returned by
      // buildVariants — which may be filtered for <input type="number">.
      // E.g. for a number field, variantIndex 0 is the first NUMBER-SHAPED
      // variant, not necessarily the cleaned-raw form.
      for (let i = 0; i < variants.length; i++) {
        const r = trySetAndVerify(el, variants[i]);
        if (r.ok) {
          results.push({ el: el, filled: true, valueUsed: variants[i], variantIndex: i });
          success = true;
          break;
        }
        lastReason = r.reason;
      }
      if (!success) {
        results.push({ el: el, filled: false, reason: lastReason });
      }
    });

    const filled = results.filter(function (r) { return r.filled; }).length;
    const skipped = results.length - filled;
    const reasons = results.filter(function (r) { return !r.filled; }).map(function (r) { return r.reason; });
    return { filled: filled, skipped: skipped, reasons: reasons, results: results };
  }

  const api = {
    findOptionGroups: findOptionGroups,
    matchCandidates: matchCandidates,
    applyMatches: applyMatches,
    findTextInputs: findTextInputs,
    matchTextInputs: matchTextInputs,
    applyTextMatches: applyTextMatches,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerMatcher = api;
  }
})(typeof self !== 'undefined' ? self : this);
