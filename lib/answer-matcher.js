// lib/answer-matcher.js
// DOM matcher: finds quiz option groups, matches parsed candidates, applies selection.
(function (root) {
  'use strict';

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
    const anonCounter = { n: 0 };
    const inputs = root.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    inputs.forEach(function (inp) {
      if (!isUsable(inp)) return;
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
          if (!ancestor.__ccpAnonId) ancestor.__ccpAnonId = '__anonGroup__:' + (++anonCounter.n);
          name = ancestor.__ccpAnonId;
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

  function tokenize(s) {
    const STOP = new Set(['the','a','an','of','to','in','and','or','for','is','are','on','with','by']);
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

  function matchCandidates(groups, parsed) {
    const out = [];
    if (!Array.isArray(groups) || !parsed) return out;
    groups.forEach(function (g) {
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
        final.sort(function (a, b) { return b.score - a.score; });
        final = [final[0]];
      }
      // Preserve discovery order within the group
      final.sort(function (a, b) { return a.option.index - b.option.index; });
      final.forEach(function (m) { out.push(m); });
    });
    return out;
  }

  const api = { findOptionGroups: findOptionGroups, matchCandidates: matchCandidates };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerMatcher = api;
  }
})(typeof self !== 'undefined' ? self : this);
