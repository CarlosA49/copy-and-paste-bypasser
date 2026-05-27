// lib/deepseek-client.js
// Background-safe DeepSeek HTTPS client. Zero deps; no DOM.
// Usage: createClient({ fetchFn, model, endpoint, timeoutMs }) -> { generateAnswers(snapshot, apiKey, opts) }
(function (root) {
  'use strict';

  var DEFAULT_ENDPOINT   = 'https://api.deepseek.com/chat/completions';
  // deepseek-v4-flash is the current recommended model (2026-05-26).
  // deepseek-chat was its legacy alias and is deprecated 2026/07/24 per api-docs.deepseek.com.
  var DEFAULT_MODEL      = 'deepseek-v4-flash';
  var DEFAULT_TIMEOUT_MS = 30000;

  // System prompt MUST contain the word "json" and an example schema (DeepSeek JSON-mode requirement).
  var SYSTEM_PROMPT = [
    'You are generating answer suggestions for an ungraded practice form. Reply with strict json only matching the supplied schema. Use only the question_id and option_id values supplied. Do not output HTML, selectors, JavaScript, navigation actions, submit instructions, or markdown.',
    '',
    'For single_choice questions, return exactly one supplied option_id. For multiple_choice questions, return zero or more supplied option_ids only when justified. For text questions, return a concise fill value. If a question cannot be answered confidently from the supplied context, omit it or mark confidence="low".',
    '',
    'Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" } ] }'
  ].join('\n');

  function classifyHttp(status) {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server-error';
    return 'invalid-response';
  }

  function createClient(opts) {
    opts = opts || {};
    var fetchFn    = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var model      = opts.model      || DEFAULT_MODEL;
    var endpoint   = opts.endpoint   || DEFAULT_ENDPOINT;
    var timeoutMs  = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0)
                       ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    function generateAnswers(sanitizedSnapshot, apiKey, callOpts) {
      callOpts = callOpts || {};

      // Guard: missing/empty key — short-circuit BEFORE touching fetch.
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        return Promise.resolve({ ok: false, reason: 'missing-key' });
      }

      if (!fetchFn) {
        return Promise.resolve({ ok: false, reason: 'network', detail: 'no-fetch' });
      }

      var userPrompt = 'Answer this json snapshot of an ungraded practice form. Reply with strict json only matching the schema in the system instruction.\n\n'
        + JSON.stringify({ page: sanitizedSnapshot.page, questions: sanitizedSnapshot.questions });

      // API key goes ONLY into the Authorization header — never into the body or return value.
      var body = JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048,
      });

      var ctrl = new AbortController();
      var externalSignal = callOpts.signal;
      if (externalSignal) {
        if (externalSignal.aborted) {
          ctrl.abort();
        } else {
          externalSignal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
        }
      }

      var timedOut  = false;
      var startedAt = Date.now();

      var timer = setTimeout(function () {
        timedOut = true;
        try { ctrl.abort('timeout'); } catch (_) { ctrl.abort(); }
      }, timeoutMs);

      var init = {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Accept':        'application/json',
        },
        body:   body,
        signal: ctrl.signal,
      };

      // Race the fetch against the abort signal so that a fetch implementation that
      // ignores ctrl.signal (e.g. a stub that never resolves) is still cut off by
      // the internal timeout or an external abort.
      var abortRace = new Promise(function (_, reject) {
        if (ctrl.signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        } else {
          ctrl.signal.addEventListener('abort', function () {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        }
      });

      return Promise.race([
        Promise.resolve(fetchFn(endpoint, init)),
        abortRace,
      ]).then(function (resp) {
        clearTimeout(timer);
        if (!resp.ok) {
          return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status, elapsedMs: Date.now() - startedAt };
        }
        return resp.text().then(function (txt) {
          var outer;
          try { outer = JSON.parse(txt); } catch (_) {
            return { ok: false, reason: 'invalid-response', elapsedMs: Date.now() - startedAt };
          }
          var content = outer && outer.choices && outer.choices[0] &&
                        outer.choices[0].message && outer.choices[0].message.content;
          if (typeof content !== 'string') {
            return { ok: false, reason: 'invalid-response', elapsedMs: Date.now() - startedAt };
          }
          var inner;
          try { inner = JSON.parse(content); } catch (_) {
            // Content is non-JSON text; return it as raw so the validator can report invalid-json.
            return { ok: true, raw: { _raw: content }, elapsedMs: Date.now() - startedAt };
          }
          return { ok: true, raw: inner, elapsedMs: Date.now() - startedAt };
        });
      }).catch(function (err) {
        clearTimeout(timer);
        if (timedOut) return { ok: false, reason: 'timeout', elapsedMs: Date.now() - startedAt };
        if (err && err.name === 'AbortError') return { ok: false, reason: 'aborted', elapsedMs: Date.now() - startedAt };
        return { ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '', elapsedMs: Date.now() - startedAt };
      });
    }

    return { generateAnswers: generateAnswers };
  }

  var api = { createClient: createClient };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.deepseekClient = api;
  }
})(typeof self !== 'undefined' ? self : this);
