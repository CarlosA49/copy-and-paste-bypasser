// lib/autopilot-authority.js
// PHASE 11 — extension-scoped state authority.
//
// Owns the single-writer queue for active-run state mutations. In production
// this runs inside the MV3 service worker (background.js) and receives
// commands from content scripts via chrome.runtime.sendMessage. In tests,
// multiple in-process messengers (representing distinct realms) all dispatch
// to ONE authority instance, so their mutations serialize through one queue.
//
// Why this is the right boundary:
//   * chrome.storage.local is FIFO at the storage backend, but our state
//     ops are read-then-write pairs that span multiple async boundaries.
//     Without an enclosing serialization point, a stale read-then-write from
//     an old document/tab can land after a Stop or replacement from a newer
//     document/tab. A per-realm WeakMap queue cannot prevent this — each
//     realm has its own JS heap.
//   * The service worker is the only object in an MV3 extension that all
//     content-script realms can share. By routing every active-run mutation
//     command through it, we get a single logical writer regardless of how
//     many tabs/documents are alive.
//
// What the authority owns (commands routed through the queue):
//   save, update (run fields), updateIfCurrentRun, clear, acquireOwnership,
//   refreshHeartbeat.
//
// What is intentionally NOT queued:
//   * SETTINGS_KEY writes inside `update({settings:...})` — they cannot
//     restore active RUN_KEY fields (settings live in their own storage key
//     as of PHASE 10). They go through the queue purely for in-order
//     processing but can never resurrect a stopped run.
//   * recordCourseItem (Policy A: in-flight historical writes settle).
//   * getCourseLog (direct read).
//
// Change broadcast:
//   After every RUN_KEY/SETTINGS_KEY mutation the authority calls every
//   subscribed listener with { key, oldValue, newValue }. Content-script
//   controllers use this to detect cross-realm Stop/replacement and bump
//   their local _runGeneration so handler/click/recovery/navigation side
//   effects are short-circuited.

(function (root) {
  'use strict';

  function _getStateMod() {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./autopilot-state.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.autopilotState) || null;
  }

  function createAuthority(storage, options) {
    const _opts = options || {};
    // PHASE 15 — when true, the authority refuses the deprecated unfenced
    // commands that can mutate active RUN_KEY without identity checks
    // (save / update with run fields / clear / acquireOwnership). The
    // background service worker creates the authority with publicSurface
    // true so a stale chrome.runtime.sendMessage cannot bypass the PHASE
    // 12–14 fences just by naming an old command. Local/test in-process
    // callers (default publicSurface false) retain the full legacy
    // command set so older PHASE 11/12 tests that use raw clear/save
    // /update/acquireOwnership as setup keep working.
    const _publicSurface = !!_opts.publicSurface;
    const stateMod = _getStateMod();
    const RUN_KEY = stateMod.RUN_KEY;
    const SETTINGS_KEY = stateMod.SETTINGS_KEY;
    const COURSE_LOG_KEY = stateMod.COURSE_LOG_KEY;
    const SETTINGS_VERSION = stateMod.SETTINGS_VERSION;
    const HEARTBEAT_TTL_MS = stateMod.HEARTBEAT_TTL_MS;
    const migrateSettings = stateMod.migrateSettings;
    const defaults = stateMod.defaults;

    function _runDefaults() { const d = defaults(); delete d.settings; return d; }
    function _settingsDefaults() { return defaults().settings; }

    // --- Queue: every queued op is `(done) => …` and must call done()
    // exactly once. Rejections are swallowed so subsequent writes are not
    // blocked by an unrelated failure.
    let _queue = Promise.resolve();
    function _enqueue(op) {
      const next = _queue.then(function () {
        return new Promise(function (resolve) {
          try { op(resolve); } catch (e) { resolve(); }
        });
      });
      _queue = next.catch(function () {});
      return next;
    }

    // --- Subscribers
    const _listeners = [];
    function subscribe(listener) {
      _listeners.push(listener);
      return function unsubscribe() {
        const i = _listeners.indexOf(listener);
        if (i >= 0) _listeners.splice(i, 1);
      };
    }
    function _broadcast(key, oldValue, newValue) {
      const ev = { key: key, oldValue: oldValue, newValue: newValue };
      for (let i = 0; i < _listeners.length; i++) {
        try { _listeners[i](ev); } catch (_) { /* listener failures must never block writes */ }
      }
    }

    // --- Raw storage helpers (run INSIDE queued ops to avoid re-entry deadlocks)
    function _readRun(cb) {
      storage.get([RUN_KEY], function (got) {
        const raw = (got && got[RUN_KEY]) || null;
        if (!raw) { cb(_runDefaults(), null); return; }
        const merged = Object.assign({}, _runDefaults(), raw);
        delete merged.settings;
        cb(merged, raw);
      });
    }
    function _readSettings(cb) {
      storage.get([SETTINGS_KEY], function (got) {
        cb((got && got[SETTINGS_KEY]) || null);
      });
    }
    function _writeRun(next, prev, cb) {
      const sanitized = Object.assign({}, next);
      delete sanitized.settings;
      const items = {}; items[RUN_KEY] = sanitized;
      storage.set(items, function () { _broadcast(RUN_KEY, prev, sanitized); cb && cb(); });
    }
    function _writeSettings(next, prev, cb) {
      const items = {}; items[SETTINGS_KEY] = next;
      storage.set(items, function () { _broadcast(SETTINGS_KEY, prev, next); cb && cb(); });
    }

    // --- Commands
    function _cmd_load(params, respond) {
      _readRun(function (runMerged, runRaw) {
        _readSettings(function (settingsRaw) {
          let settings; let migrated = false;
          if (settingsRaw && typeof settingsRaw.settingsVersion === 'number' && settingsRaw.settingsVersion >= SETTINGS_VERSION) {
            settings = Object.assign({}, _settingsDefaults(), settingsRaw);
          } else {
            const legacyCandidate = settingsRaw || (runRaw && runRaw.settings) || null;
            if (legacyCandidate) {
              const mig = migrateSettings(legacyCandidate);
              settings = Object.assign({}, _settingsDefaults(), mig.settings);
              migrated = mig.migrated || !settingsRaw;
            } else {
              settings = _settingsDefaults();
            }
          }
          const merged = Object.assign({}, runMerged, { settings: settings });
          if (migrated) {
            // Persist settings ONLY, inside THIS load slot. We are already
            // inside the single-writer queue, so a direct write is safe and
            // observable to the caller's `await load()` without an extra
            // tick.
            _writeSettings(settings, settingsRaw, function () {
              respond({ ok: true, state: merged });
            });
            return;
          }
          respond({ ok: true, state: merged });
        });
      });
    }

    function _cmd_save(params, respond) {
      const state = params && params.state;
      _readRun(function (curRun) {
        _writeRun(state || _runDefaults(), curRun, function () {
          if (state && state.settings) {
            _readSettings(function (curSettings) {
              _writeSettings(state.settings, curSettings, function () { respond({ ok: true }); });
            });
          } else {
            respond({ ok: true });
          }
        });
      });
    }

    function _cmd_update(params, respond) {
      const patch = (params && params.patch) || {};
      const settingsPatch = patch.settings ? Object.assign({}, patch.settings) : null;
      const runPatch = Object.assign({}, patch);
      delete runPatch.settings;
      const hasRunFields = Object.keys(runPatch).length > 0;
      function doSettings(next) {
        if (!settingsPatch) { next(); return; }
        _readSettings(function (cur) {
          const merged = Object.assign({}, _settingsDefaults(), cur || {}, settingsPatch);
          merged.settingsVersion = SETTINGS_VERSION;
          _writeSettings(merged, cur, next);
        });
      }
      function doRun(next) {
        if (!hasRunFields) { next(); return; }
        _readRun(function (cur) {
          const nextRun = Object.assign({}, cur, runPatch);
          delete nextRun.settings;
          _writeRun(nextRun, cur, next);
        });
      }
      doRun(function () { doSettings(function () { respond({ ok: true }); }); });
    }

    function _cmd_updateIfCurrentRun(params, respond) {
      const expectedRunId = params && params.expectedRunId;
      const patch = (params && params.patch) || {};
      if (expectedRunId == null) {
        respond({ ok: true, written: false, reason: 'null-run-id', expectedRunId: expectedRunId });
        return;
      }
      const runPatch = Object.assign({}, patch);
      delete runPatch.settings;
      _readRun(function (cur) {
        if (cur.runId !== expectedRunId) {
          respond({ ok: true, written: false, reason: 'stale-run', currentRunId: cur.runId, expectedRunId: expectedRunId });
          return;
        }
        const next = Object.assign({}, cur, runPatch);
        delete next.settings;
        _writeRun(next, cur, function () { respond({ ok: true, written: true }); });
      });
    }

    function _cmd_clear(params, respond) {
      _readRun(function (cur) {
        _writeRun(_runDefaults(), cur, function () { respond({ ok: true }); });
      });
    }

    function _cmd_acquireOwnership(params, respond) {
      const myTabKey = params && params.tabKey;
      const now = params && params.now;
      _readRun(function (cur) {
        const isOwnerAlready = cur.ownerTabKey === myTabKey && (now - cur.heartbeatAt) <= HEARTBEAT_TTL_MS;
        if (isOwnerAlready) { respond({ ok: true, result: 'owner' }); return; }
        const foreignFresh = cur.ownerTabKey && cur.ownerTabKey !== myTabKey
          && (now - cur.heartbeatAt) <= HEARTBEAT_TTL_MS;
        if (foreignFresh) { respond({ ok: true, result: 'foreign-active' }); return; }
        const next = Object.assign({}, cur, { ownerTabKey: myTabKey, heartbeatAt: now });
        _writeRun(next, cur, function () {
          _readRun(function (after) {
            respond({ ok: true, result: after.ownerTabKey === myTabKey ? 'owner' : 'foreign-active' });
          });
        });
      });
    }

    // PHASE 14 — fenced ownership claim for active runs. Replaces the
    // generic acquireOwnership for any controller path that owns a runId
    // (bootIfRunning, resume, takeOver bootstrap). A late old claim that
    // arrives AFTER a newer run has been installed is rejected at the
    // authority instead of silently overwriting ownerTabKey/heartbeatAt.
    //
    // Contract:
    //   expectedRunId == null              → refuse (null-run-id); no mutation
    //                                        result: 'foreign-active'
    //   cur.runId !== expectedRunId        → refuse (stale-run); no mutation
    //                                        result: 'foreign-active'
    //   cur.ownerTabKey === myTabKey       → return owner; preserves fresh
    //     AND heartbeat fresh                heartbeat (no-op write)
    //   cur.ownerTabKey foreign + fresh    → result: 'foreign-active'; no mutation
    //   cur.ownerTabKey foreign + stale,   → transfer ownership; write
    //     OR null, OR same tab + stale       { ownerTabKey: myTabKey, heartbeatAt: now }
    //                                        result: 'owner'
    function _cmd_claimRunOwnership(params, respond) {
      const expectedRunId = params && params.expectedRunId;
      const myTabKey = params && params.tabKey;
      const now = params && params.now;
      if (expectedRunId == null) {
        respond({ ok: true, written: false, reason: 'null-run-id', result: 'foreign-active' });
        return;
      }
      _readRun(function (cur) {
        if (cur.runId !== expectedRunId) {
          respond({ ok: true, written: false, reason: 'stale-run', currentRunId: cur.runId, result: 'foreign-active' });
          return;
        }
        const isOwnerAlready = cur.ownerTabKey === myTabKey && (now - cur.heartbeatAt) <= HEARTBEAT_TTL_MS;
        if (isOwnerAlready) { respond({ ok: true, written: false, result: 'owner' }); return; }
        const foreignFresh = cur.ownerTabKey && cur.ownerTabKey !== myTabKey
          && (now - cur.heartbeatAt) <= HEARTBEAT_TTL_MS;
        if (foreignFresh) { respond({ ok: true, written: false, result: 'foreign-active' }); return; }
        const next = Object.assign({}, cur, { ownerTabKey: myTabKey, heartbeatAt: now });
        _writeRun(next, cur, function () { respond({ ok: true, written: true, result: 'owner' }); });
      });
    }

    function _cmd_refreshHeartbeat(params, respond) {
      const myTabKey = params && params.tabKey;
      const now = params && params.now;
      const expectedRunId = params && params.expectedRunId;
      _readRun(function (cur) {
        // PHASE 13: heartbeat refreshes against ACTIVE state (cur.runId is
        // set) MUST carry expectedRunId. An old already-scheduled tick that
        // forgot to bind the runId at timer creation would otherwise
        // refresh whatever new run replaced the old one in the same tab.
        if (cur.runId != null && expectedRunId == null) {
          respond({ ok: true, refreshed: false, reason: 'missing-run-id', currentRunId: cur.runId });
          return;
        }
        if (expectedRunId != null && cur.runId !== expectedRunId) {
          respond({ ok: true, refreshed: false, reason: 'stale-run', currentRunId: cur.runId });
          return;
        }
        if (cur.ownerTabKey !== myTabKey) { respond({ ok: true, refreshed: false, reason: 'foreign-owner' }); return; }
        const next = Object.assign({}, cur, { heartbeatAt: now });
        _writeRun(next, cur, function () { respond({ ok: true, refreshed: true }); });
      });
    }

    // PHASE 12 — fenced lifecycle commands. Each refuses to mutate if the
    // current persisted state does not match the expected identity/status.
    // These commands are explicit ("activate", "pause", "resume", "upgrade",
    // "takeOver") so a stale message from an older content-script lifecycle
    // can be rejected at the authority rather than silently overwriting
    // newer state.
    function _cmd_activateRun(params, respond) {
      const newState = params && params.state;
      if (!newState || !newState.runId) {
        respond({ ok: true, written: false, reason: 'invalid-state' });
        return;
      }
      _readRun(function (cur) {
        // Allow activation only when there is no currently active run.
        // (cur.runId == null AND cur.status === 'idle')
        if (cur.runId != null || cur.status !== 'idle') {
          respond({ ok: true, written: false, reason: 'already-active', currentRunId: cur.runId, currentStatus: cur.status });
          return;
        }
        const sanitized = Object.assign({}, newState);
        delete sanitized.settings;
        _writeRun(sanitized, cur, function () {
          if (newState.settings) {
            _readSettings(function (curSettings) {
              const mergedSettings = Object.assign({}, _settingsDefaults(), curSettings || {}, newState.settings);
              mergedSettings.settingsVersion = SETTINGS_VERSION;
              _writeSettings(mergedSettings, curSettings, function () { respond({ ok: true, written: true }); });
            });
          } else {
            respond({ ok: true, written: true });
          }
        });
      });
    }

    function _cmd_pauseRun(params, respond) {
      const expectedRunId = params && params.expectedRunId;
      const lastPauseReason = params && params.lastPauseReason;
      if (expectedRunId == null) {
        respond({ ok: true, written: false, reason: 'null-run-id' });
        return;
      }
      _readRun(function (cur) {
        if (cur.runId !== expectedRunId) {
          respond({ ok: true, written: false, reason: 'stale-run', currentRunId: cur.runId, expectedRunId: expectedRunId });
          return;
        }
        const next = Object.assign({}, cur, { status: 'paused', ownerTabKey: null, lastPauseReason: lastPauseReason || null });
        _writeRun(next, cur, function () { respond({ ok: true, written: true }); });
      });
    }

    function _cmd_resumeRun(params, respond) {
      const expectedRunId = params && params.expectedRunId;
      const tabKey = params && params.tabKey;
      const now = params && params.now;
      if (expectedRunId == null) {
        respond({ ok: true, written: false, reason: 'null-run-id' });
        return;
      }
      _readRun(function (cur) {
        if (cur.runId !== expectedRunId) {
          respond({ ok: true, written: false, reason: 'stale-run', currentRunId: cur.runId });
          return;
        }
        if (cur.status !== 'paused') {
          respond({ ok: true, written: false, reason: 'stale-status', currentStatus: cur.status });
          return;
        }
        const next = Object.assign({}, cur, { status: 'running', ownerTabKey: tabKey, heartbeatAt: now, lastPauseReason: null });
        _writeRun(next, cur, function () { respond({ ok: true, written: true }); });
      });
    }

    function _cmd_upgradeLegacyRunId(params, respond) {
      const expectedStatus = params && params.expectedStatus;
      const newRunId = params && params.newRunId;
      if (!newRunId) {
        respond({ ok: true, written: false, reason: 'invalid-run-id' });
        return;
      }
      _readRun(function (cur) {
        if (cur.runId != null) {
          respond({ ok: true, written: false, reason: 'already-has-run-id', currentRunId: cur.runId });
          return;
        }
        if (expectedStatus != null && cur.status !== expectedStatus) {
          respond({ ok: true, written: false, reason: 'stale-status', currentStatus: cur.status });
          return;
        }
        const next = Object.assign({}, cur, { runId: newRunId });
        _writeRun(next, cur, function () { respond({ ok: true, written: true }); });
      });
    }

    function _cmd_takeOverRun(params, respond) {
      const expectedRunId = params && params.expectedRunId;
      const tabKey = params && params.tabKey;
      const now = params && params.now;
      if (expectedRunId == null) {
        respond({ ok: true, written: false, reason: 'null-run-id' });
        return;
      }
      _readRun(function (cur) {
        if (cur.runId !== expectedRunId) {
          respond({ ok: true, written: false, reason: 'stale-run', currentRunId: cur.runId });
          return;
        }
        const next = Object.assign({}, cur, { ownerTabKey: tabKey, heartbeatAt: now });
        _writeRun(next, cur, function () { respond({ ok: true, written: true }); });
      });
    }

    // PHASE 13 — fenced stopRun. Replaces unconditional clear for Stop. A
    // stale Stop arriving after a newer run has been activated must NOT
    // destroy that newer run.
    function _cmd_stopRun(params, respond) {
      const expectedRunId = params && params.expectedRunId;
      if (expectedRunId == null) {
        respond({ ok: true, written: false, reason: 'null-run-id' });
        return;
      }
      _readRun(function (cur) {
        if (cur.runId !== expectedRunId) {
          respond({ ok: true, written: false, reason: 'stale-run', currentRunId: cur.runId });
          return;
        }
        _writeRun(_runDefaults(), cur, function () { respond({ ok: true, written: true }); });
      });
    }

    // PHASE 13 — fenced legacy stop / legacy pause. The legacy variants exist
    // only for state predating PHASE 9 (cur.runId is null). They require the
    // caller to pass expected status and owner; if a modern run-new has
    // installed itself in the meantime the authority refuses.
    function _cmd_stopLegacyRun(params, respond) {
      const expectedStatus = params && params.expectedStatus;
      const expectedOwnerTabKey = params && params.expectedOwnerTabKey;
      _readRun(function (cur) {
        if (cur.runId != null) {
          respond({ ok: true, written: false, reason: 'modern-run-active', currentRunId: cur.runId });
          return;
        }
        if (expectedStatus != null && cur.status !== expectedStatus) {
          respond({ ok: true, written: false, reason: 'stale-status', currentStatus: cur.status });
          return;
        }
        if (cur.ownerTabKey !== expectedOwnerTabKey) {
          respond({ ok: true, written: false, reason: 'stale-owner', currentOwnerTabKey: cur.ownerTabKey });
          return;
        }
        _writeRun(_runDefaults(), cur, function () { respond({ ok: true, written: true }); });
      });
    }
    function _cmd_pauseLegacyRun(params, respond) {
      const expectedStatus = params && params.expectedStatus;
      const expectedOwnerTabKey = params && params.expectedOwnerTabKey;
      const lastPauseReason = params && params.lastPauseReason;
      _readRun(function (cur) {
        if (cur.runId != null) {
          respond({ ok: true, written: false, reason: 'modern-run-active', currentRunId: cur.runId });
          return;
        }
        if (expectedStatus != null && cur.status !== expectedStatus) {
          respond({ ok: true, written: false, reason: 'stale-status', currentStatus: cur.status });
          return;
        }
        if (cur.ownerTabKey !== expectedOwnerTabKey) {
          respond({ ok: true, written: false, reason: 'stale-owner', currentOwnerTabKey: cur.ownerTabKey });
          return;
        }
        const next = Object.assign({}, cur, { status: 'paused', ownerTabKey: null, lastPauseReason: lastPauseReason || null });
        _writeRun(next, cur, function () { respond({ ok: true, written: true }); });
      });
    }

    // PHASE 13 — fenced legacy takeover. For state predating PHASE 9
    // (cur.runId is null). Caller passes expectedStatus and
    // expectedOwnerTabKey snapshotted from the same read; the authority
    // refuses if any of those have changed (e.g., a modern run-new now
    // owns the state with its own runId).
    function _cmd_takeOverLegacyRun(params, respond) {
      const expectedStatus = params && params.expectedStatus;
      const expectedOwnerTabKey = params && params.expectedOwnerTabKey;
      const tabKey = params && params.tabKey;
      const now = params && params.now;
      _readRun(function (cur) {
        if (cur.runId != null) {
          respond({ ok: true, written: false, reason: 'modern-run-active', currentRunId: cur.runId });
          return;
        }
        if (expectedStatus != null && cur.status !== expectedStatus) {
          respond({ ok: true, written: false, reason: 'stale-status', currentStatus: cur.status });
          return;
        }
        if (cur.ownerTabKey !== expectedOwnerTabKey) {
          respond({ ok: true, written: false, reason: 'stale-owner', currentOwnerTabKey: cur.ownerTabKey });
          return;
        }
        const next = Object.assign({}, cur, { ownerTabKey: tabKey, heartbeatAt: now });
        _writeRun(next, cur, function () { respond({ ok: true, written: true }); });
      });
    }

    // --- Non-queued commands (COURSE_LOG_KEY policy A + direct reads)
    function _cmd_recordCourseItem(params, respond) {
      const courseId = params && params.courseId;
      const itemId = params && params.itemId;
      const kind = params && params.kind;
      const outcome = params && params.outcome;
      storage.get([COURSE_LOG_KEY], function (got) {
        const log = (got && got[COURSE_LOG_KEY]) || {};
        const next = Object.assign({}, log);
        next[courseId] = Object.assign({}, next[courseId] || {});
        next[courseId][itemId] = { kind: kind, outcome: outcome, at: Date.now() };
        const items = {}; items[COURSE_LOG_KEY] = next;
        storage.set(items, function () { respond({ ok: true }); });
      });
    }
    function _cmd_getCourseLog(params, respond) {
      storage.get([COURSE_LOG_KEY], function (got) {
        respond({ ok: true, log: (got && got[COURSE_LOG_KEY]) || {} });
      });
    }

    const _commands = {
      load: _cmd_load,
      save: _cmd_save,
      update: _cmd_update,
      updateIfCurrentRun: _cmd_updateIfCurrentRun,
      clear: _cmd_clear,
      acquireOwnership: _cmd_acquireOwnership,
      claimRunOwnership: _cmd_claimRunOwnership,
      refreshHeartbeat: _cmd_refreshHeartbeat,
      recordCourseItem: _cmd_recordCourseItem,
      getCourseLog: _cmd_getCourseLog,
      // PHASE 12 fenced lifecycle commands.
      activateRun: _cmd_activateRun,
      pauseRun: _cmd_pauseRun,
      resumeRun: _cmd_resumeRun,
      upgradeLegacyRunId: _cmd_upgradeLegacyRunId,
      takeOverRun: _cmd_takeOverRun,
      // PHASE 13 fenced commands.
      stopRun: _cmd_stopRun,
      stopLegacyRun: _cmd_stopLegacyRun,
      pauseLegacyRun: _cmd_pauseLegacyRun,
      takeOverLegacyRun: _cmd_takeOverLegacyRun,
    };

    // Commands routed through the queue. Active-run mutations are obviously
    // queued. `load` is ALSO queued so that a load called after an active
    // mutation observes the post-mutation state — without this, a reader
    // running between Stop's enqueued clear and that clear actually
    // executing could see stale "running" state, miss the cross-realm
    // cancellation broadcast, and proceed to invoke a handler.
    const _queuedCommands = {
      load: true,
      save: true, update: true, updateIfCurrentRun: true, clear: true,
      acquireOwnership: true, claimRunOwnership: true, refreshHeartbeat: true,
      // PHASE 12 fenced lifecycle commands are queued so their read-and-
      // check happens atomically with respect to other writes.
      activateRun: true, pauseRun: true, resumeRun: true,
      upgradeLegacyRunId: true, takeOverRun: true,
      // PHASE 13 fenced commands.
      stopRun: true, stopLegacyRun: true, pauseLegacyRun: true, takeOverLegacyRun: true,
    };

    // PHASE 15 — commands that mutate (or could mutate) active RUN_KEY
    // without carrying identity fences. These are forbidden on the public
    // (runtime/service-worker) authority surface. Production callers must
    // use the corresponding fenced lifecycle commands instead:
    //   acquireOwnership → claimRunOwnership / takeOverLegacyRun
    //   clear            → stopRun / stopLegacyRun
    //   save             → activateRun
    //   update (run fields) → updateIfCurrentRun / pauseRun / resumeRun /
    //                         takeOverRun / takeOverLegacyRun / etc.
    // Settings-only `update` (patch contains only `settings`) is still
    // accepted on the public surface so the settings UI keeps working.
    const _publicForbidden = { save: true, clear: true, acquireOwnership: true };
    function _isRunFieldUpdate(params) {
      const patch = (params && params.patch) || {};
      const keys = Object.keys(patch);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== 'settings') return true;
      }
      return false;
    }

    function dispatch(command, params, cb) {
      const handler = _commands[command];
      if (!handler) { cb({ ok: false, reason: 'unknown-command', command: command }); return; }
      if (_publicSurface) {
        if (_publicForbidden[command]) {
          cb({ ok: false, reason: 'fenced-command-required', command: command });
          return;
        }
        if (command === 'update' && _isRunFieldUpdate(params)) {
          cb({ ok: false, reason: 'fenced-command-required', command: command });
          return;
        }
      }
      function respond(res) { try { cb(res); } catch (_) { /* protect authority loop */ } }
      if (_queuedCommands[command]) {
        _enqueue(function (done) {
          handler(params || {}, function (res) { respond(res); done(); });
        });
      } else {
        handler(params || {}, respond);
      }
    }

    return {
      dispatch: dispatch,
      subscribe: subscribe,
    };
  }

  const api = { createAuthority: createAuthority };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotAuthority = api;
  }
})(typeof self !== 'undefined' ? self : this);
