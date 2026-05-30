// lib/ai-providers.js
// Background-safe provider adapter registry. Zero deps; NO DOM (loads in the MV3
// service worker, so it references `self`, never `window`/`document`).
// Each adapter: { id, label, defaultModel, models, endpoint(opts),
//   buildRequest(sanitizedSnapshot, apiKey, opts) -> { url, method, headers, body },
//   parseResponse(jsonOrText) -> { ok, raw }, createClient(opts) -> { generateAnswers } }
(function (root) {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 30000;

  // Generalized system prompt — the SINGLE SOURCE OF TRUTH for the assessment
  // contract. MUST contain the literal word "json", the {"type":"text",...}
  // answer-shape example, and the token "math_input" so the deepseek adapter still
  // satisfies deepseek-client.test U15-P1/U15-P2. NOTE: lib/deepseek-client.js keeps a
  // VERBATIM copy of this string in its standalone fallback (used only when this
  // module cannot be loaded). The two must stay byte-identical; Task 7 Step 4 adds a
  // test (D-PROMPT) asserting equality. If you edit this prompt, edit the fallback too.
  // Type coverage here is intentionally scoped to single_choice / multiple_choice /
  // math_input / free_text; the remaining typed-schema kinds (dropdown, matching,
  // ordering, code, file_upload) are deferred to Phase C (WS-C question-type system).
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

  function userPromptFor(sanitizedSnapshot) {
    return 'Answer this json snapshot of an online assessment. Reply with strict json only matching the schema in the system instruction.\n\n'
      + JSON.stringify({ page: sanitizedSnapshot.page, questions: sanitizedSnapshot.questions });
  }

  // Shared transport: drives any adapter's buildRequest/parseResponse through
  // fetch with timeout + AbortController, normalizing to {ok, raw} / {ok:false, reason, detail, elapsedMs}.
  function makeClient(adapter, opts) {
    opts = opts || {};
    var fetchFn   = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    var callModel = opts.model || adapter.defaultModel;
    var baseUrl   = opts.baseUrl || null;

    function generateAnswers(sanitizedSnapshot, apiKey, callOpts) {
      callOpts = callOpts || {};
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        return Promise.resolve({ ok: false, reason: 'missing-key' });
      }
      if (!fetchFn) {
        return Promise.resolve({ ok: false, reason: 'network', detail: 'no-fetch' });
      }

      var req;
      try {
        req = adapter.buildRequest(sanitizedSnapshot, apiKey, { model: callModel, baseUrl: baseUrl });
      } catch (e) {
        return Promise.resolve({ ok: false, reason: 'invalid-response', detail: 'build-request: ' + String((e && e.message) || '').slice(0, 120) });
      }

      var ctrl = new AbortController();
      var externalSignal = callOpts.signal;
      if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
      }

      var timedOut = false;
      var startedAt = Date.now();
      var timer = setTimeout(function () {
        timedOut = true;
        try { ctrl.abort('timeout'); } catch (_) { ctrl.abort(); }
      }, timeoutMs);

      var init = {
        method: req.method || 'POST',
        headers: req.headers,
        body: req.body,
        signal: ctrl.signal,
      };

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
        Promise.resolve(fetchFn(req.url, init)),
        abortRace,
      ]).then(function (resp) {
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
          var parsed = adapter.parseResponse(outer);
          if (!parsed || parsed.ok !== true) {
            var outerExcerpt = JSON.stringify(outer).slice(0, 240);
            return { ok: false, reason: (parsed && parsed.reason) || 'invalid-response', detail: 'unparseable provider payload: ' + outerExcerpt, elapsedMs: Date.now() - startedAt };
          }
          return { ok: true, raw: parsed.raw, elapsedMs: Date.now() - startedAt };
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

  // Normalize raw model content into {ok:true, raw}. content is the provider's
  // text payload; JSON.parse it into raw.answers, else {ok:true, raw:{_raw:content}}.
  function normalizeContent(content) {
    if (typeof content !== 'string') return { ok: false, reason: 'invalid-response' };
    var inner;
    try { inner = JSON.parse(content); } catch (_) {
      return { ok: true, raw: { _raw: content } };
    }
    return { ok: true, raw: inner };
  }

  // ---- Adapter definitions (buildRequest/parseResponse filled in by later tasks) ----

  var openai = {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    endpoint: function () { return 'https://api.openai.com/v1/chat/completions'; },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  var anthropic = {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
    endpoint: function () { return 'https://api.anthropic.com/v1/messages'; },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  var gemini = {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-1.5-flash',
    models: ['gemini-1.5-flash', 'gemini-1.5-pro'],
    endpoint: function (opts) {
      var model = (opts && opts.model) || gemini.defaultModel;
      return 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  var deepseek = {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    endpoint: function () { return 'https://api.deepseek.com/chat/completions'; },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  var custom = {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    defaultModel: 'gpt-4o-mini',
    models: [],
    endpoint: function (opts) {
      var base = (opts && opts.baseUrl) || '';
      return joinUrl(base, '/chat/completions');
    },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  function joinUrl(base, path) {
    if (!base || typeof base !== 'string') return path;
    var b = base.replace(/\/+$/, '');
    if (b.indexOf('/chat/completions') !== -1 || b.indexOf('/completions') !== -1) return b;
    return b + path;
  }

  var REGISTRY = {
    openai: openai,
    anthropic: anthropic,
    gemini: gemini,
    deepseek: deepseek,
    custom: custom,
  };

  // Attach createClient to each adapter so callers can do get(id).createClient(opts).
  Object.keys(REGISTRY).forEach(function (id) {
    var a = REGISTRY[id];
    a.createClient = function (opts) { return makeClient(a, opts); };
  });

  var aiProviders = {
    get: function (id) { return REGISTRY[id] || null; },
    list: function () {
      return Object.keys(REGISTRY).map(function (id) {
        var a = REGISTRY[id];
        return { id: a.id, label: a.label, models: a.models.slice(), defaultModel: a.defaultModel };
      });
    },
  };

  var api = {
    aiProviders: aiProviders,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    classifyHttp: classifyHttp,
    userPromptFor: userPromptFor,
    normalizeContent: normalizeContent,
    joinUrl: joinUrl,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.aiProviders = aiProviders;
  }
})(typeof self !== 'undefined' ? self : this);
