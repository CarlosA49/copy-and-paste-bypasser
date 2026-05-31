// lib/deepseek-client.js
// Background-safe DeepSeek HTTPS client. Now a thin delegator to the `deepseek`
// adapter in lib/ai-providers.js (request/response shape + {ok, raw} preserved).
// Exports createClient(opts) -> { generateAnswers(snapshot, apiKey, opts) } unchanged.
(function (root) {
  'use strict';

  var DEFAULT_ENDPOINT   = 'https://api.deepseek.com/chat/completions';
  var DEFAULT_MODEL      = 'deepseek-chat';
  var DEFAULT_TIMEOUT_MS = 30000;

  // Resolve the ai-providers module across realms: CommonJS (tests) and the
  // service-worker global (importScripts puts it on self.ClipboardCleaner).
  function resolveProviders() {
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./ai-providers.js'); } catch (_) { return null; }
    }
    if (root && root.ClipboardCleaner && root.ClipboardCleaner.aiProviders) {
      // Worker realm exposes only the registry object, not the helper export.
      return { aiProviders: root.ClipboardCleaner.aiProviders };
    }
    return null;
  }

  // Resolve EAGERLY at module load so the delegation link is established up front:
  // ai-providers appears in require.cache the moment deepseek-client is required,
  // proving delegation rather than a duplicated transport.
  var PROVIDERS_MODULE = resolveProviders();

  function createClient(opts) {
    opts = opts || {};
    var providers = PROVIDERS_MODULE || resolveProviders();
    var adapter = providers && providers.aiProviders && providers.aiProviders.get
      ? providers.aiProviders.get('deepseek')
      : null;
    if (adapter && typeof adapter.createClient === 'function') {
      return adapter.createClient({
        fetchFn: opts.fetchFn,
        model: opts.model || DEFAULT_MODEL,
        timeoutMs: opts.timeoutMs,
      });
    }
    // Fallback: self-contained client (kept so the file works if loaded alone).
    return fallbackClient(opts);
  }

  // --- Self-contained fallback (only used when ai-providers.js is NOT loadable) ---
  // This SYSTEM_PROMPT is a deliberate VERBATIM copy of the SYSTEM_PROMPT in
  // lib/ai-providers.js (Task 1). It must stay character-for-character identical so
  // there is no behavioral drift between the adapter path (production) and this
  // standalone fallback. If you change one, change both. Task 7 Step 4 adds a test
  // (D-PROMPT) asserting the two strings are byte-identical to enforce this.
  var SYSTEM_PROMPT = [
    'You are generating answer suggestions for an online assessment. Reply with strict json only matching the supplied schema. Use only the question_id and option_id values supplied. Do not output HTML, selectors, JavaScript, navigation actions, submit instructions, or markdown.',
    '',
    'For single_choice questions, return exactly one supplied option_id. For multiple_choice questions, return zero or more supplied option_ids only when justified. For math_input questions (text or numeric typed answers), return an answer object of shape {"type":"text","value":"<string>"}. Numeric answers MUST be returned as strings (e.g., "0.5", not 0.5). For free_text questions, return {"type":"text","value":"<string>"}. If a question cannot be answered confidently from the supplied context, omit it or mark confidence="low".',
    '',
    'Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" }, { "question_id": "q2", "answer": { "type": "text", "value": "the typed or numeric answer as a string" }, "explanation": "short", "confidence": "high" } ] }'
  ].join('\n');

  function classifyHttp(status) {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server-error';
    return 'invalid-response';
  }

  function fallbackClient(opts) {
    var fetchFn   = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var model     = opts.model || DEFAULT_MODEL;
    var endpoint  = opts.endpoint || DEFAULT_ENDPOINT;
    var timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    function generateAnswers(sanitizedSnapshot, apiKey, callOpts) {
      callOpts = callOpts || {};
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        return Promise.resolve({ ok: false, reason: 'missing-key' });
      }
      if (!fetchFn) return Promise.resolve({ ok: false, reason: 'network', detail: 'no-fetch' });

      var userPrompt = 'Answer this json snapshot of an online assessment. Reply with strict json only matching the schema in the system instruction.\n\n'
        + JSON.stringify({ page: sanitizedSnapshot.page, questions: sanitizedSnapshot.questions });
      var body = JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048,
      });

      var ctrl = new AbortController();
      var externalSignal = callOpts.signal;
      if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
      }
      var timedOut = false;
      var startedAt = Date.now();
      var timer = setTimeout(function () { timedOut = true; try { ctrl.abort('timeout'); } catch (_) { ctrl.abort(); } }, timeoutMs);

      var init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' },
        body: body,
        signal: ctrl.signal,
      };
      var abortRace = new Promise(function (_, reject) {
        if (ctrl.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        else ctrl.signal.addEventListener('abort', function () { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });

      return Promise.race([Promise.resolve(fetchFn(endpoint, init)), abortRace]).then(function (resp) {
        clearTimeout(timer);
        if (!resp.ok) {
          return resp.text().then(function (errBody) {
            var bodyExcerpt = (errBody == null ? '' : String(errBody)).slice(0, 240);
            return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status + ' ' + bodyExcerpt, elapsedMs: Date.now() - startedAt };
          }).catch(function () {
            return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status, elapsedMs: Date.now() - startedAt };
          });
        }
        return resp.text().then(function (txt) {
          var outer;
          try { outer = JSON.parse(txt); } catch (_) {
            var rawExcerpt = (txt == null ? '' : String(txt)).slice(0, 240);
            return { ok: false, reason: 'invalid-response', detail: 'non-json body: ' + rawExcerpt, elapsedMs: Date.now() - startedAt };
          }
          var content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content;
          if (typeof content !== 'string') {
            var outerExcerpt = JSON.stringify(outer).slice(0, 240);
            return { ok: false, reason: 'invalid-response', detail: 'missing choices[0].message.content: ' + outerExcerpt, elapsedMs: Date.now() - startedAt };
          }
          var inner;
          try { inner = JSON.parse(content); } catch (_) {
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
