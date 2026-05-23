// lib/autopilot-state.js
// chrome.storage.local CRUD + acquireOwnership procedure for the module autopilot.
(function (root) {
  'use strict';

  const RUN_KEY = 'ccp_autopilot_run';
  const COURSE_LOG_KEY = 'ccp_autopilot_course_log';
  const HEARTBEAT_TTL_MS = 30 * 1000;

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
      settings: { pauseOnUserInput: true, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' },
      heartbeatAt: 0,
      ownerTabKey: null,
    };
  }

  function createState(storage) {
    function load(cb) {
      storage.get([RUN_KEY], function (got) {
        const raw = (got && got[RUN_KEY]) || null;
        if (!raw) { cb(defaults()); return; }
        // Shallow-merge into defaults so newly-added fields don't break older state.
        const d = defaults();
        const merged = Object.assign({}, d, raw);
        merged.settings = Object.assign({}, d.settings, raw.settings || {});
        cb(merged);
      });
    }

    function save(state, cb) {
      const items = {};
      items[RUN_KEY] = state;
      storage.set(items, function () { cb && cb(); });
    }

    function update(patch, cb) {
      load(function (cur) {
        const next = Object.assign({}, cur, patch || {});
        if (patch && patch.settings) {
          next.settings = Object.assign({}, cur.settings, patch.settings);
        }
        save(next, cb);
      });
    }

    function clear(cb) {
      save(defaults(), cb);
    }

    function getCourseLog(cb) {
      storage.get([COURSE_LOG_KEY], function (got) {
        cb((got && got[COURSE_LOG_KEY]) || {});
      });
    }

    function recordCourseItem(courseId, itemId, kind, outcome, cb) {
      getCourseLog(function (log) {
        const next = Object.assign({}, log);
        next[courseId] = Object.assign({}, next[courseId] || {});
        next[courseId][itemId] = { kind: kind, outcome: outcome, at: Date.now() };
        const items = {};
        items[COURSE_LOG_KEY] = next;
        storage.set(items, function () { cb && cb(); });
      });
    }

    function acquireOwnership(myTabKey, now, cb) {
      load(function (cur) {
        const isOwnerAlready = cur.ownerTabKey === myTabKey && (now - cur.heartbeatAt) <= HEARTBEAT_TTL_MS;
        if (isOwnerAlready) { cb('owner'); return; }
        const foreignFresh = cur.ownerTabKey && cur.ownerTabKey !== myTabKey
          && (now - cur.heartbeatAt) <= HEARTBEAT_TTL_MS;
        if (foreignFresh) { cb('foreign-active'); return; }
        // Stale or unowned — claim it.
        const next = Object.assign({}, cur, { ownerTabKey: myTabKey, heartbeatAt: now });
        save(next, function () {
          // Re-read after the claim. Note: this only catches an interleaved write that
          // had already landed before our get fires; two well-separated claims can both
          // see their own key on re-read. The real safety net is the heartbeat TTL
          // (HEARTBEAT_TTL_MS) — a stale owner gets reclaimed on the next bootIfRunning().
          load(function (after) {
            cb(after.ownerTabKey === myTabKey ? 'owner' : 'foreign-active');
          });
        });
      });
    }

    function refreshHeartbeat(myTabKey, now, cb) {
      load(function (cur) {
        if (cur.ownerTabKey !== myTabKey) { cb(false); return; }
        const next = Object.assign({}, cur, { heartbeatAt: now });
        save(next, function () { cb(true); });
      });
    }

    return {
      load: load,
      save: save,
      update: update,
      clear: clear,
      getCourseLog: getCourseLog,
      recordCourseItem: recordCourseItem,
      acquireOwnership: acquireOwnership,
      refreshHeartbeat: refreshHeartbeat,
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
    chromeStorageOrNull: chromeStorageOrNull,
    HEARTBEAT_TTL_MS: HEARTBEAT_TTL_MS,
    RUN_KEY: RUN_KEY,
    COURSE_LOG_KEY: COURSE_LOG_KEY,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotState = api;
  }
})(typeof self !== 'undefined' ? self : this);
