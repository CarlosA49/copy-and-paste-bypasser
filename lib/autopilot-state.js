// lib/autopilot-state.js
// State client. Talks to the extension-scoped autopilot-authority over an
// injectable messenger. The authority is the only writer for active-run
// (RUN_KEY) state in production; this client just shapes commands and
// unwraps responses.
//
// Backward compatibility:
//   createState(storage) is still accepted — it transparently constructs a
//   local authority + in-process messenger so existing single-realm tests
//   and the service-worker bootstrap keep working with the same API.
//   createState(messenger) is the cross-realm form used by content scripts
//   in production and by PHASE 11 tests that simulate distinct realms.

(function (root) {
  'use strict';

  const RUN_KEY = 'ccp_autopilot_run';
  const SETTINGS_KEY = 'ccp_autopilot_settings';
  const COURSE_LOG_KEY = 'ccp_autopilot_course_log';
  const HEARTBEAT_TTL_MS = 30 * 1000;
  const SETTINGS_VERSION = 1;

  function defaults() {
    return {
      status: 'idle',
      courseId: null,
      moduleId: null,
      queue: [],
      cursor: 0,
      dwellEndsAt: null,
      startedAt: 0,
      itemStartedAt: 0,
      history: [],
      replyHistory: [],
      settings: { pauseOnUserInput: false, autoSubmitQuizzes: false, aiAnswerAssessments: false, behaviorMode: 'fast', runScope: 'module', settingsVersion: SETTINGS_VERSION },
      heartbeatAt: 0,
      ownerTabKey: null,
      skippedLogged: {},
      lastPauseReason: null,
      runId: null,
    };
  }

  function migrateSettings(rawSettings) {
    const raw = rawSettings || {};
    const ver = (typeof raw.settingsVersion === 'number') ? raw.settingsVersion : 0;
    if (ver >= SETTINGS_VERSION) {
      return { settings: raw, migrated: false };
    }
    const next = Object.assign({}, raw);
    if (ver < 1 && next.pauseOnUserInput === true) {
      next.pauseOnUserInput = false;
    }
    next.settingsVersion = SETTINGS_VERSION;
    return { settings: next, migrated: true };
  }

  // Build a messenger from raw storage by constructing a local authority +
  // in-process messenger. Used for backward-compatible createState(storage)
  // calls and for the service-worker bootstrap.
  //
  // PRESERVED PHASE-10 INVARIANT (single-realm, in-process):
  //   Two createState(storage) calls with the SAME storage object inside
  //   the SAME JS realm share the SAME authority. This keeps existing
  //   single-realm tests deterministic: a "same storage, different
  //   wrapper" scenario (e.g. controller + settings UI in one realm) does
  //   NOT race because both wrappers reach the same authority instance.
  //   For true cross-realm isolation (different documents/tabs), callers
  //   must use createState(messenger) with a shared authority object —
  //   that is the production wiring (background.js owns the authority,
  //   content scripts connect via chrome.runtime).
  const _authoritiesByStorage = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function _authorityForStorage(storage) {
    let authorityMod = null;
    if (typeof module !== 'undefined' && module.exports) {
      authorityMod = require('./autopilot-authority.js');
    } else {
      authorityMod = root.ClipboardCleaner && root.ClipboardCleaner.autopilotAuthority;
    }
    if (_authoritiesByStorage) {
      let auth = _authoritiesByStorage.get(storage);
      if (!auth) { auth = authorityMod.createAuthority(storage); _authoritiesByStorage.set(storage, auth); }
      return auth;
    }
    return authorityMod.createAuthority(storage);
  }
  function _localMessengerFromStorage(storage) {
    let messengerMod = null;
    if (typeof module !== 'undefined' && module.exports) {
      messengerMod = require('./autopilot-messenger.js');
    } else {
      messengerMod = root.ClipboardCleaner && root.ClipboardCleaner.autopilotMessenger;
    }
    const auth = _authorityForStorage(storage);
    return messengerMod.createInProcessMessenger(auth);
  }

  function _isMessenger(arg) {
    return !!(arg && typeof arg.send === 'function' && typeof arg.onChange === 'function');
  }
  function _isStorage(arg) {
    return !!(arg && typeof arg.get === 'function' && typeof arg.set === 'function');
  }

  function createState(arg) {
    let messenger;
    if (_isMessenger(arg)) {
      messenger = arg;
    } else if (_isStorage(arg)) {
      messenger = _localMessengerFromStorage(arg);
    } else {
      throw new Error('createState requires a messenger or a storage adapter');
    }

    // PHASE 12: each method propagates the authority's structured response
    // to its callback. `load` is special — historical callers do
    //   state.load(function (cur) { ... cur.status ... });
    // so on success the cb receives the merged state. On authority failure
    // the cb receives `null` (NOT a synthetic idle-defaults object that the
    // controller might mistake for trustworthy state).
    function load(cb) {
      messenger.send('load', {}, function (res) {
        if (cb) cb(res && res.ok ? res.state : null);
      });
    }
    function save(state, cb) {
      messenger.send('save', { state: state }, function (res) {
        if (cb) cb(res || { ok: false, reason: 'no-response' });
      });
    }
    function update(patch, cb) {
      messenger.send('update', { patch: patch || {} }, function (res) {
        if (cb) cb(res || { ok: false, reason: 'no-response' });
      });
    }
    function updateIfCurrentRun(expectedRunId, patch, cb) {
      messenger.send('updateIfCurrentRun', { expectedRunId: expectedRunId, patch: patch || {} }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function clear(cb) {
      messenger.send('clear', {}, function (res) {
        if (cb) cb(res || { ok: false, reason: 'no-response' });
      });
    }
    function getCourseLog(cb) {
      messenger.send('getCourseLog', {}, function (res) {
        cb(res && res.ok ? (res.log || {}) : null);
      });
    }
    function recordCourseItem(courseId, itemId, kind, outcome, cb) {
      messenger.send('recordCourseItem', { courseId: courseId, itemId: itemId, kind: kind, outcome: outcome }, function (res) {
        if (cb) cb(res || { ok: false, reason: 'no-response' });
      });
    }
    function acquireOwnership(myTabKey, now, cb) {
      messenger.send('acquireOwnership', { tabKey: myTabKey, now: now }, function (res) {
        if (!res || res.ok === false) { cb('authority-unavailable'); return; }
        cb(res.result || 'foreign-active');
      });
    }
    // PHASE 14 — fenced ownership claim. Controllers that hold a runId must
    // use this instead of acquireOwnership so a late stale claim against a
    // replaced run is rejected at the authority.
    function claimRunOwnership(expectedRunId, myTabKey, now, cb) {
      messenger.send('claimRunOwnership', { expectedRunId: expectedRunId, tabKey: myTabKey, now: now }, function (res) {
        if (!res || res.ok === false) { cb('authority-unavailable'); return; }
        cb(res.result || 'foreign-active');
      });
    }
    function refreshHeartbeat(myTabKey, now, cb, expectedRunId) {
      const params = { tabKey: myTabKey, now: now };
      if (expectedRunId != null) params.expectedRunId = expectedRunId;
      messenger.send('refreshHeartbeat', params, function (res) {
        if (!res || res.ok === false) { cb(false); return; }
        cb(!!res.refreshed);
      });
    }
    // PHASE 12 fenced lifecycle helpers. cb receives { ok, written?, reason? }.
    function activateRun(stateBody, cb) {
      messenger.send('activateRun', { state: stateBody }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function pauseRun(expectedRunId, lastPauseReason, cb) {
      messenger.send('pauseRun', { expectedRunId: expectedRunId, lastPauseReason: lastPauseReason }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function resumeRun(expectedRunId, tabKey, now, cb) {
      messenger.send('resumeRun', { expectedRunId: expectedRunId, tabKey: tabKey, now: now }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function upgradeLegacyRunId(expectedStatus, newRunId, cb) {
      messenger.send('upgradeLegacyRunId', { expectedStatus: expectedStatus, newRunId: newRunId }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function takeOverRun(expectedRunId, tabKey, now, cb) {
      messenger.send('takeOverRun', { expectedRunId: expectedRunId, tabKey: tabKey, now: now }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    // PHASE 13 — fenced stop. Authority refuses unless cur.runId === expectedRunId.
    function stopRun(expectedRunId, cb) {
      messenger.send('stopRun', { expectedRunId: expectedRunId }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function takeOverLegacyRun(expectedStatus, expectedOwnerTabKey, tabKey, now, cb) {
      messenger.send('takeOverLegacyRun', {
        expectedStatus: expectedStatus, expectedOwnerTabKey: expectedOwnerTabKey,
        tabKey: tabKey, now: now,
      }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function stopLegacyRun(expectedStatus, expectedOwnerTabKey, cb) {
      messenger.send('stopLegacyRun', {
        expectedStatus: expectedStatus, expectedOwnerTabKey: expectedOwnerTabKey,
      }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function pauseLegacyRun(expectedStatus, expectedOwnerTabKey, lastPauseReason, cb) {
      messenger.send('pauseLegacyRun', {
        expectedStatus: expectedStatus, expectedOwnerTabKey: expectedOwnerTabKey,
        lastPauseReason: lastPauseReason,
      }, function (res) {
        if (cb) cb(res || { ok: false, written: false, reason: 'no-response' });
      });
    }
    function onChange(listener) {
      return messenger.onChange(listener);
    }

    return {
      load: load,
      save: save,
      update: update,
      updateIfCurrentRun: updateIfCurrentRun,
      clear: clear,
      getCourseLog: getCourseLog,
      recordCourseItem: recordCourseItem,
      acquireOwnership: acquireOwnership,
      claimRunOwnership: claimRunOwnership,
      refreshHeartbeat: refreshHeartbeat,
      // PHASE 12 fenced lifecycle.
      activateRun: activateRun,
      pauseRun: pauseRun,
      resumeRun: resumeRun,
      upgradeLegacyRunId: upgradeLegacyRunId,
      takeOverRun: takeOverRun,
      // PHASE 13 fenced commands.
      stopRun: stopRun,
      stopLegacyRun: stopLegacyRun,
      pauseLegacyRun: pauseLegacyRun,
      takeOverLegacyRun: takeOverLegacyRun,
      onChange: onChange,
      _messenger: messenger,
    };
  }

  function chromeStorageOrNull() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return {
        get: function (keys, cb) { chrome.storage.local.get(keys, cb); },
        set: function (items, cb) { chrome.storage.local.set(items, cb); },
      };
    }
    return null;
  }

  const api = {
    createState: createState,
    defaults: defaults,
    migrateSettings: migrateSettings,
    chromeStorageOrNull: chromeStorageOrNull,
    HEARTBEAT_TTL_MS: HEARTBEAT_TTL_MS,
    RUN_KEY: RUN_KEY,
    SETTINGS_KEY: SETTINGS_KEY,
    COURSE_LOG_KEY: COURSE_LOG_KEY,
    SETTINGS_VERSION: SETTINGS_VERSION,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotState = api;
  }
})(typeof self !== 'undefined' ? self : this);
