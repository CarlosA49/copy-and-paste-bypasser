// lib/answer-applier.js
// Top-level orchestrator. Maps parsed numbered answers onto detected question
// containers and fills/clicks them. Uses answer-matcher's applyTextMatches for
// the variant-chain text-fill, but iterates over QUESTIONS (not inputs).
(function (root) {
  'use strict';

  function req(name, browserName) {
    if (typeof module !== 'undefined' && module.exports) return require(name);
    return root.ClipboardCleaner && root.ClipboardCleaner[browserName];
  }
  const numberedParser   = req('./numbered-parser.js',   'numberedParser');
  const questionDetector = req('./question-detector.js', 'questionDetector');
  const mathNormalize    = req('./math-normalize.js',    'mathNormalize');
  const answerMatcher    = req('./answer-matcher.js',    'answerMatcher');

  function dispatch(el, type) {
    try {
      const ev = new el.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    } catch (_) { /* ignore */ }
  }

  function normalizeChoiceText(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    A.forEach(function (t) { if (B.has(t)) inter++; });
    const uni = A.size + B.size - inter;
    return uni === 0 ? 0 : inter / uni;
  }

  function tokens(s) {
    return normalizeChoiceText(s).split(' ').filter(function (t) { return t.length > 1; });
  }

  function pickChoice(choices, raw) {
    const r = String(raw || '').trim();
    if (!r) return null;
    if (/^[A-Ha-h]$/.test(r)) {
      const idx = r.toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < choices.length) return choices[idx];
    }
    const n = normalizeChoiceText(r);
    const direct = choices.find(function (c) { return normalizeChoiceText(c.text) === n; });
    if (direct) return direct;
    // Substring fallback — only safe when the option label is long enough that an
    // accidental hit in long answer prose is unlikely. Single-letter labels like
    // "A"/"B" otherwise match any answer containing that letter, causing the
    // "always picks first option" bug.
    const sub = choices.find(function (c) {
      const ct = normalizeChoiceText(c.text);
      if (ct.length <= 2) return false;
      return ct.indexOf(n) !== -1 || n.indexOf(ct) !== -1;
    });
    if (sub) return sub;
    let best = null, bestScore = 0;
    choices.forEach(function (c) {
      const sc = jaccard(tokens(r), tokens(c.text));
      if (sc > bestScore) { bestScore = sc; best = c; }
    });
    return (best && bestScore >= 0.34) ? best : null;
  }

  function pickMultipleChoices(choices, raw) {
    const r = String(raw || '').replace(/[\[\]]/g, '').replace(/\band\b/gi, ',');
    const parts = r.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    const out = [];
    parts.forEach(function (p) {
      const m = pickChoice(choices, p);
      if (m && out.indexOf(m) === -1) out.push(m);
    });
    return out;
  }

  function clickChoice(opt) {
    const el = opt && opt.el;
    if (!el) return false;
    if ((el.tagName || '').toUpperCase() === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
      el.checked = true;
      dispatch(el, 'click');
      dispatch(el, 'input');
      dispatch(el, 'change');
      return el.checked === true;
    }
    dispatch(el, 'click');
    const aria = el.getAttribute && el.getAttribute('aria-checked');
    return aria === 'true' || aria === null;
  }

  function fillTextOnce(target, value) {
    const r = answerMatcher.applyTextMatches([{ el: target, value: value, reason: 'numbered' }]);
    const first = r && r.results && r.results[0];
    return first && first.filled
      ? { ok: true, valueUsed: first.valueUsed }
      : { ok: false, reason: first ? first.reason : 'unknown' };
  }

  function logHeader(label) { console.log('[answer-applier] ' + label); }

  function applyAnswers(rawAnswerText, rootEl, options) {
    const opts = options || {};
    const verbose = opts.verbose !== false; // default true
    const maxRetries = opts.maxRetries || 3;
    const questions = questionDetector.detectQuestions(rootEl);
    let parsed = numberedParser.parseNumberedAnswers(rawAnswerText);
    let mode = 'numbered';
    // Require >= 2 detected questions: a single bare line is too ambiguous to route
    // through the ordered-lines pipeline without a count anchor.
    if (parsed.length === 0 && questions.length >= 2) {
      const ordered = numberedParser.parseOrderedLines(rawAnswerText, questions.length);
      if (ordered.length > 0) {
        parsed = ordered;
        mode = 'ordered-lines';
      }
    }
    if (verbose) console.log('[answer-applier] mode=' + mode);

    if (verbose) {
      logHeader('Detected ' + questions.length + ' questions:');
      questions.forEach(function (q) {
        const t = q.type === 'single_choice' || q.type === 'multiple_choice'
          ? q.type + ' choices=[' + q.choices.map(function (c) { return c.text; }).join(', ') + ']'
          : q.type + ' target=' + (q.targets[0] ? q.targets[0].tagName.toLowerCase() : 'none');
        console.log('  Q' + q.questionNumber + ' type=' + t);
      });
    }

    if (parsed.length === 0) {
      return {
        detectedQuestions: questions.length,
        parsedAnswers: 0,
        mode: mode,
        results: [],
        summary: { total: questions.length, filled: 0, failed: 0, missingAnswers: questions.length, missingQuestions: 0 }
      };
    }

    const ansByNum = new Map();
    parsed.forEach(function (p) { ansByNum.set(p.questionNumber, p); });

    if (verbose) {
      logHeader('Parsed answers:');
      parsed.forEach(function (p) { console.log('  Q' + p.questionNumber + ' raw="' + p.rawAnswer + '"'); });
    }

    const results = [];
    questions.forEach(function (q) {
      const p = ansByNum.get(q.questionNumber);
      if (!p) {
        results.push({ questionNumber: q.questionNumber, type: q.type, status: 'no-answer' });
        if (verbose) console.log('  Q' + q.questionNumber + ' NO ANSWER');
        return;
      }

      if (q.type === 'math_input' || q.type === 'numerical' || q.type === 'input') {
        const normalized = mathNormalize.normalizeMathAnswer(p.rawAnswer);
        if (!normalized) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'empty-after-normalize', rawAnswer: p.rawAnswer });
          return;
        }
        let lastReason = 'unknown';
        let ok = false; let valueUsed = null;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          // Re-query targets if attempt > 0 (Coursera may re-render).
          const target = (attempt === 0)
            ? q.targets[0]
            : (questionDetector.detectQuestions(rootEl).find(function (qq) { return qq.questionNumber === q.questionNumber; }) || q).targets[0];
          if (!target) { lastReason = 'field not found'; continue; }
          if (target.scrollIntoView) { try { target.scrollIntoView({ block: 'center' }); } catch (_) {} }
          const r = fillTextOnce(target, normalized);
          if (r.ok) { ok = true; valueUsed = r.valueUsed; break; }
          lastReason = r.reason || 'value-did-not-stick';
        }
        if (ok) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', rawAnswer: p.rawAnswer, normalizedAnswer: normalized, valueUsed: valueUsed });
          if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' success "' + valueUsed + '"');
        } else {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: lastReason, rawAnswer: p.rawAnswer, normalizedAnswer: normalized });
          if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' FAIL ' + lastReason);
        }
        return;
      }

      // Multi-segment answers (e.g. "(A) X, (B) Y") aimed at letter-labeled
      // choice questions cannot be sensibly mapped to a single pick — refuse
      // loudly instead of guessing via substring fallback. Long-text choice
      // options (≥3 chars) still go through pickChoice unchanged.
      if (p.segments && (q.type === 'single_choice' || q.type === 'multiple_choice')) {
        const shortChoiceLabels = (q.choices || []).every(function (c) {
          return normalizeChoiceText(c.text).length <= 2;
        });
        if (shortChoiceLabels) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'multi-segment-not-single-choice', rawAnswer: p.rawAnswer });
          if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' FAIL multi-segment-not-single-choice');
          return;
        }
      }

      if (q.type === 'single_choice') {
        const choice = pickChoice(q.choices, p.rawAnswer);
        if (!choice) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'choice not matched', rawAnswer: p.rawAnswer });
          return;
        }
        const ok = clickChoice(choice);
        if (ok) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'selected', rawAnswer: p.rawAnswer, valueUsed: choice.text });
          if (verbose) console.log('  Q' + q.questionNumber + ' single_choice selected "' + choice.text + '"');
        } else {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'click did not select', rawAnswer: p.rawAnswer });
        }
        return;
      }

      if (q.type === 'multiple_choice') {
        const picks = pickMultipleChoices(q.choices, p.rawAnswer);
        if (picks.length === 0) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'no choices matched', rawAnswer: p.rawAnswer });
          return;
        }
        let allOk = true;
        picks.forEach(function (c) { if (!clickChoice(c)) allOk = false; });
        if (allOk) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', rawAnswer: p.rawAnswer, valueUsed: picks.map(function (c) { return c.text; }).join(', ') });
        } else {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'some clicks failed', rawAnswer: p.rawAnswer });
        }
        return;
      }

      results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'unknown question type', rawAnswer: p.rawAnswer });
    });

    const filled = results.filter(function (r) { return r.status === 'filled' || r.status === 'selected'; }).length;
    const failed = results.filter(function (r) { return r.status === 'failed'; }).length;
    const missingAnswers = results.filter(function (r) { return r.status === 'no-answer'; }).length;
    const detectedNums = new Set(questions.map(function (q) { return q.questionNumber; }));
    const missingQuestions = parsed.filter(function (p) { return !detectedNums.has(p.questionNumber); }).length;

    if (verbose) {
      console.log('[answer-applier] Final: Success ' + filled + '/' + questions.length + ' filled.');
      if (failed > 0) {
        console.log('[answer-applier] Failed:');
        results.filter(function (r) { return r.status === 'failed'; }).forEach(function (r) {
          console.log('  Q' + r.questionNumber + ' reason="' + r.reason + '"');
        });
      }
    }

    return {
      detectedQuestions: questions.length,
      parsedAnswers: parsed.length,
      mode: mode,
      results: results,
      summary: { total: questions.length, filled: filled, failed: failed, missingAnswers: missingAnswers, missingQuestions: missingQuestions }
    };
  }

  function _findQuestionByNumber(questions, n) {
    for (let i = 0; i < questions.length; i++) if (questions[i].questionNumber === n) return questions[i];
    return null;
  }

  function applyStructuredAnswers(structuredList, rootEl, options) {
    const opts = options || {};
    const verbose = opts.verbose !== false;
    const maxRetries = opts.maxRetries || 3;
    const questions = questionDetector.detectQuestions(rootEl);
    const list = Array.isArray(structuredList) ? structuredList : [];
    const results = [];
    let filled = 0, failed = 0;

    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      const q = _findQuestionByNumber(questions, item.questionNumber);
      if (!q) {
        results.push({ questionNumber: item.questionNumber, status: 'no-question' });
        continue;
      }
      if (q.type !== item.type) {
        results.push({ questionNumber: q.questionNumber, type: q.type, status: 'type-mismatch', requested: item.type });
        failed++;
        continue;
      }

      if (item.type === 'single_choice') {
        const choice = pickChoice(q.choices, item.choiceText);
        if (!choice) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'choice not matched' }); failed++; continue; }
        const ok = clickChoice(choice);
        if (ok) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'selected', valueUsed: choice.text }); filled++; }
        else { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'click did not select' }); failed++; }
        continue;
      }

      if (item.type === 'multiple_choice') {
        const labels = Array.isArray(item.choiceTexts) ? item.choiceTexts : [];
        const picks = [];
        for (let k = 0; k < labels.length; k++) {
          const c = pickChoice(q.choices, labels[k]);
          if (c && picks.indexOf(c) === -1) picks.push(c);
        }
        if (picks.length === 0) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'no choices matched' }); failed++; continue; }
        let allOk = true;
        for (let k = 0; k < picks.length; k++) if (!clickChoice(picks[k])) allOk = false;
        if (allOk) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', valueUsed: picks.map(function (c) { return c.text; }).join(', ') }); filled++; }
        else { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'some clicks failed' }); failed++; }
        continue;
      }

      if (item.type === 'math_input' || item.type === 'numerical' || item.type === 'input') {
        const normalized = mathNormalize.normalizeMathAnswer(item.value);
        if (!normalized) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'empty-after-normalize' }); failed++; continue; }
        let ok = false, valueUsed = null, lastReason = 'unknown';
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          const target = (attempt === 0)
            ? q.targets[0]
            : (questionDetector.detectQuestions(rootEl).find(function (qq) { return qq.questionNumber === q.questionNumber; }) || q).targets[0];
          if (!target) { lastReason = 'field not found'; continue; }
          if (target.scrollIntoView) { try { target.scrollIntoView({ block: 'center' }); } catch (_) {} }
          const r = fillTextOnce(target, normalized);
          if (r.ok) { ok = true; valueUsed = r.valueUsed; break; }
          lastReason = r.reason || 'value-did-not-stick';
        }
        if (ok) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', normalizedAnswer: normalized, valueUsed: valueUsed }); filled++; }
        else { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: lastReason, normalizedAnswer: normalized }); failed++; }
        continue;
      }

      results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'unsupported-type', requested: item.type });
      failed++;
    }

    if (verbose) console.log('[answer-applier] structured-apply filled=' + filled + ' failed=' + failed);

    return {
      detectedQuestions: questions.length,
      parsedAnswers: list.length,
      mode: 'structured',
      results: results,
      summary: { total: questions.length, filled: filled, failed: failed, missingAnswers: 0, missingQuestions: 0 },
    };
  }

  const api = { applyAnswers: applyAnswers, applyStructuredAnswers: applyStructuredAnswers };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerApplier = api;
  }
})(typeof self !== 'undefined' ? self : this);
