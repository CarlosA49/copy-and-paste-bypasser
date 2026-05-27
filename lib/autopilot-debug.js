// lib/autopilot-debug.js
// Bounded in-memory event recorder + reusable snapshot helper for the
// Diagnostics tab. Never throws into the caller — a failure here must not
// stop the autopilot.
(function (root) {
  'use strict';

  const DEFAULT_MAX_EVENTS = 500;

  function safeNow(nowFn) {
    try {
      const n = nowFn();
      if (n instanceof Date) return n.toISOString();
      if (typeof n === 'number') return new Date(n).toISOString();
      if (typeof n === 'string') return n;
      return new Date().toISOString();
    } catch (_) {
      return new Date(0).toISOString();
    }
  }

  function safeDetails(details) {
    if (details == null) return {};
    try {
      return JSON.parse(JSON.stringify(details));
    } catch (_) {
      try { return { _unserializable: String(details) }; } catch (__) { return {}; }
    }
  }

  function createDebugRecorder(options) {
    options = options || {};
    const maxEvents = (typeof options.maxEvents === 'number' && options.maxEvents > 0)
      ? options.maxEvents : DEFAULT_MAX_EVENTS;
    const nowFn = (typeof options.nowFn === 'function') ? options.nowFn : function () { return new Date(); };
    const getContext = (typeof options.getContext === 'function') ? options.getContext : null;
    const events = [];
    const listeners = [];

    function record(type, details) {
      try {
        const ev = { at: safeNow(nowFn), type: String(type || ''), details: safeDetails(details) };
        events.push(ev);
        while (events.length > maxEvents) events.shift();
        for (let i = 0; i < listeners.length; i++) {
          try { listeners[i](ev); } catch (_) { /* listener errors must not bubble */ }
        }
      } catch (_) { /* recorder must never throw into caller */ }
    }

    function getEvents() { return events.slice(); }

    function clear() {
      events.length = 0;
      for (let i = 0; i < listeners.length; i++) {
        try { listeners[i](null); } catch (_) {}
      }
    }

    function subscribe(fn) {
      if (typeof fn === 'function') listeners.push(fn);
      return function () { unsubscribe(fn); };
    }

    function unsubscribe(fn) {
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i] === fn) listeners.splice(i, 1);
      }
    }

    function snapshot(extra) {
      let ctx = null;
      try { ctx = getContext ? getContext() : null; } catch (_) { ctx = null; }
      return {
        capturedAt: safeNow(nowFn),
        context: Object.assign({}, ctx || {}, extra || {}),
        events: events.slice(),
      };
    }

    return {
      record: record,
      getEvents: getEvents,
      clear: clear,
      subscribe: subscribe,
      unsubscribe: unsubscribe,
      snapshot: snapshot,
    };
  }

  // ── formatDebugReport ──────────────────────────────────────────────────────

  var FORBIDDEN_KEYS = ['answerText', 'pageBody', 'bodyText', 'pastedAnswer', 'quizOptions'];

  function sanitize(obj) {
    if (obj == null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sanitize);
    var out = {};
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (FORBIDDEN_KEYS.indexOf(k) === -1) {
        out[k] = sanitize(obj[k]);
      }
    }
    return out;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function headerLine(label, val) {
    return label.padEnd(20, ' ') + (val == null ? '' : String(val));
  }

  function formatDetails(d) {
    if (!d || typeof d !== 'object') return '';
    var clean = sanitize(d);
    var keys = Object.keys(clean);
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = clean[k];
      var formatted;
      if (typeof v === 'string') {
        // Quote strings that contain spaces or special characters, leave simple identifiers bare
        formatted = /[\s,="]/.test(v) ? JSON.stringify(v) : v;
      } else if (v !== null && typeof v === 'object') {
        formatted = JSON.stringify(v);
      } else {
        formatted = String(v);
      }
      parts.push(k + '=' + formatted);
    }
    return parts.join(' ');
  }

  function formatQueueLine(i, cursor, item) {
    var prefix = (i === cursor) ? '<- ' : '';
    var line;
    if (item.blocked) {
      line = '[' + pad2(i) + '] ' + prefix + 'blocked ' + (item.blockReason || '') +
        '  "' + (item.title || '') + '"' +
        ' id=' + (item.id || '') +
        ' completed=' + !!item.completed +
        ' skippedLogged=' + !!item.skippedLogged +
        ' url=' + (item.url || '');
    } else {
      line = '[' + pad2(i) + '] ' + prefix + 'safe' +
        '  ' + (item.kind || 'unknown') +
        '  "' + (item.title || '') + '"' +
        ' id=' + (item.id || '') +
        ' completed=' + !!item.completed +
        ' url=' + (item.url || '');
    }
    return line;
  }

  function buildVideoState(events) {
    // Filter to video-related event types
    var videoTypes = /^(handler\.start|handler\.outcome|video\.)/;
    var videoEvents = events.filter(function (e) { return videoTypes.test(e.type); });
    if (videoEvents.length === 0) return null;

    // Find latest itemId by walking backwards
    var latestItemId = null;
    for (var i = videoEvents.length - 1; i >= 0; i--) {
      var d = videoEvents[i].details || {};
      if (d.itemId) { latestItemId = d.itemId; break; }
    }
    if (!latestItemId) return null;

    // Keep only events for that itemId
    var relevant = videoEvents.filter(function (e) {
      return (e.details || {}).itemId === latestItemId;
    });

    // Fold into flat object
    var flat = {};
    for (var j = 0; j < relevant.length; j++) {
      var ev = relevant[j];
      var det = ev.details || {};
      switch (ev.type) {
        case 'handler.start':
          if (det.itemId != null) flat.itemId = det.itemId;
          if (det.title != null) flat.title = det.title;
          if (det.behaviorMode != null) flat.behaviorMode = det.behaviorMode;
          break;
        case 'video.element':
          if (det.found != null) flat['video.found'] = det.found;
          break;
        case 'video.element.wait.started':
          flat['element.waited'] = true;
          if (det.timeoutMs != null) flat['element.timeoutMs'] = det.timeoutMs;
          break;
        case 'video.element.wait.completed':
          flat['element.waited'] = true;
          if (det.found != null) flat['element.found'] = det.found;
          if (det.polls != null) flat['element.polls'] = det.polls;
          if (det.elapsedMs != null) flat['element.elapsedMs'] = det.elapsedMs;
          if (det.timeoutMs != null) flat['element.timeoutMs'] = det.timeoutMs;
          break;
        case 'video.element.wait.timeout':
          flat['element.waited'] = true;
          flat['element.found'] = false;
          if (det.polls != null) flat['element.polls'] = det.polls;
          if (det.elapsedMs != null) flat['element.elapsedMs'] = det.elapsedMs;
          break;
        case 'video.element.wait.aborted':
          flat['element.waited'] = true;
          flat['element.aborted'] = true;
          if (det.polls != null) flat['element.polls'] = det.polls;
          break;
        case 'video.duration.initial':
          flat['duration.initial'] = det.value !== undefined ? det.value : null;
          break;
        case 'video.duration.wait.completed':
          if (det.duration != null) flat.duration = det.duration;
          if (det.polls != null) flat.polls = det.polls;
          break;
        case 'video.seek.requested':
          if (det.directTarget != null) flat.target = det.directTarget;
          if (det.fallbackTarget != null) flat.fallbackTarget = det.fallbackTarget;
          break;
        case 'video.seek.direct.result':
          if (det.attempted != null) flat['direct.attempted'] = det.attempted;
          if (det.accepted != null) flat['direct.accepted'] = det.accepted;
          if (det.currentTime != null) flat['direct.currentTime'] = det.currentTime;
          break;
        case 'video.seek.forward.result':
          if (det.found != null) flat['forward.found'] = det.found;
          if (det.clicks != null) flat['forward.clicks'] = det.clicks;
          if (det.currentTime != null) flat['forward.currentTime'] = det.currentTime;
          if (det.reached != null) flat['forward.reached'] = det.reached;
          break;
        case 'handler.outcome':
          if (det.outcome != null) flat.outcome = det.outcome;
          if (det.mode != null) flat.mode = det.mode;
          break;
        default:
          break;
      }
    }
    return flat;
  }

  var NAV_TYPES = [
    'queue.cursor.changed',
    'queue.blocked.skipped',
    'queue.next.safe',
    'navigation.requested',
    'navigation.result',
    'route.changed',
    'item.run.deferred',
    'item.run.rerun.scheduled',
    'item.run.rerun.executed',
  ];

  function formatNavLine(ev) {
    var d = ev.details || {};
    switch (ev.type) {
      case 'queue.cursor.changed':
        return '  cursor ' + d.before + ' -> ' + d.after + (d.reason ? ' (' + d.reason + ')' : '');
      case 'queue.blocked.skipped':
        return '  blocked skipped: "' + (d.title || '') + '" reason=' + (d.blockReason || '') + ' logged=' + !!d.logged;
      case 'queue.next.safe':
        return '  next safe: "' + (d.title || '') + '" id=' + (d.itemId || '') + ' cursor=' + d.cursor;
      case 'navigation.requested':
        return '  navigation.requested from=' + (d.from || '') + ' target=' + (d.target || '') + ' itemId=' + (d.itemId || '');
      case 'navigation.result':
        return '  navigation.result target=' + (d.target || '') + ' urlChanged=' + !!d.urlChanged + ' rowAnchorFallbackClicked=' + !!d.rowAnchorFallbackClicked;
      case 'route.changed':
        return '  route.changed from=' + (d.from || '') + ' to=' + (d.to || '') + ' source=' + (d.source || '');
      case 'item.run.deferred':
        return '  item.run.deferred reason=' + (d.reason || '') + ' queuedRun=' + !!d.queuedRun;
      case 'item.run.rerun.scheduled':
        return '  rerun.scheduled';
      case 'item.run.rerun.executed':
        return '  rerun.executed';
      default:
        return '  ' + ev.type;
    }
  }

  function formatDebugReport(snap, extraContext) {
    try {
      snap = snap || {};
      var ctx = sanitize(Object.assign({}, snap.context || {}, extraContext || {}));
      var events = (snap.events || []).slice();
      var lines = [];

      // HEADER
      lines.push(headerLine('REPORT TIMESTAMP', snap.capturedAt || ''));
      if (ctx.url != null) lines.push(headerLine('URL', ctx.url));
      if (ctx.status != null) lines.push(headerLine('STATUS', ctx.status));
      if (ctx.behaviorMode != null) lines.push(headerLine('BEHAVIOR MODE', ctx.behaviorMode));
      if (ctx.runScope != null) lines.push(headerLine('RUN SCOPE', ctx.runScope));
      if (ctx.courseId != null) lines.push(headerLine('COURSE', ctx.courseId));
      if (ctx.moduleId != null) lines.push(headerLine('MODULE', ctx.moduleId));
      if (ctx.cursor != null) lines.push(headerLine('CURSOR', ctx.cursor));
      if (ctx.queueLength != null) lines.push(headerLine('QUEUE LENGTH', ctx.queueLength));
      if (ctx.ownerTabKey != null) lines.push(headerLine('OWNER TAB', ctx.ownerTabKey));
      if (ctx.lastPauseReason != null) lines.push(headerLine('LAST PAUSE', ctx.lastPauseReason));
      lines.push('');

      // QUEUE
      var queue = ctx.queue;
      if (!queue || !Array.isArray(queue) || queue.length === 0) {
        lines.push('QUEUE           (empty)');
      } else {
        lines.push('QUEUE');
        var cursor = ctx.cursor != null ? ctx.cursor : -1;
        for (var i = 0; i < queue.length; i++) {
          lines.push(formatQueueLine(i, cursor, queue[i]));
        }
      }
      lines.push('');

      // VIDEO STATE
      var videoFlat = buildVideoState(events);
      if (videoFlat === null) {
        lines.push('VIDEO STATE     (no video activity)');
      } else {
        lines.push('VIDEO STATE');
        lines.push('  ' + formatDetails(videoFlat));
      }
      lines.push('');

      // NAVIGATION
      var navEvents = events.filter(function (e) { return NAV_TYPES.indexOf(e.type) !== -1; });
      if (navEvents.length === 0) {
        lines.push('NAVIGATION      (no navigation activity)');
      } else {
        lines.push('NAVIGATION');
        for (var n = 0; n < navEvents.length; n++) {
          lines.push(formatNavLine(navEvents[n]));
        }
      }
      lines.push('');

      // EVENTS
      if (events.length === 0) {
        lines.push('EVENTS          (none)');
      } else {
        lines.push('EVENTS');
        for (var e = 0; e < events.length; e++) {
          var ev = events[e];
          var det = formatDetails(ev.details || {});
          lines.push('  ' + ev.at + ' ' + ev.type + (det ? ' ' + det : ''));
        }
      }

      return lines.join('\n');
    } catch (_) {
      return 'formatDebugReport: internal error';
    }
  }

  const api = { createDebugRecorder: createDebugRecorder, formatDebugReport: formatDebugReport };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotDebug = api;
  }
})(typeof self !== 'undefined' ? self : this);
