// lib/lecture-synthesizer.js
(function (root) {
  'use strict';

  const STOPWORDS = new Set([
    'this','that','with','from','have','were','will','would','their','about','there',
    'they','them','then','than','what','when','where','which','while','your','yours',
    'into','onto','such','some','also','only','very','much','many','more','most','over',
    'just','here','been','being','these','those','because','through','before','after',
    'between','among','each','every','other','another','same','different','example',
    'because','since','though','although','still','again','really','actually','basically',
    'going','make','makes','made','take','takes','took','give','gives','says','said',
    'know','knows','knew','think','thinks','thought','look','looks','looked','want',
    'wants','wanted','need','needs','needed','use','uses','used','using','like','liked',
  ]);

  function tokenize(text) {
    if (!text) return [];
    return String(text).toLowerCase().match(/[a-z]{4,}/g) || [];
  }

  function rankKeywords(cues, limit) {
    const counts = new Map();
    for (let i = 0; i < cues.length; i++) {
      const toks = tokenize(cues[i].text);
      for (let j = 0; j < toks.length; j++) {
        const t = toks[j];
        if (STOPWORDS.has(t)) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const arr = Array.from(counts.entries());
    arr.sort(function (a, b) {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    const max = (typeof limit === 'number' && limit > 0) ? limit : arr.length;
    return arr.slice(0, max).map(function (e) { return e[0]; });
  }

  function topKeywordsFor(cue, n) {
    const counts = new Map();
    const toks = tokenize(cue.text);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (STOPWORDS.has(t)) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    const arr = Array.from(counts.entries());
    arr.sort(function (a, b) { return b[1] - a[1]; });
    return arr.slice(0, n).map(function (e) { return e[0]; });
  }

  function shareKeyword(a, b) {
    for (let i = 0; i < a.length; i++) if (b.indexOf(a[i]) !== -1) return true;
    return false;
  }

  function clusterTopics(cues) {
    if (!cues || cues.length === 0) return [];
    const topics = [];
    let currentIdx = [0];
    let currentKw = topKeywordsFor(cues[0], 3);
    for (let i = 1; i < cues.length; i++) {
      const kw = topKeywordsFor(cues[i], 3);
      if (shareKeyword(kw, currentKw)) {
        currentIdx.push(i);
        for (let k = 0; k < kw.length; k++) {
          if (currentKw.indexOf(kw[k]) === -1) currentKw.push(kw[k]);
        }
      } else {
        topics.push({ keywords: currentKw.slice(0, 5), cueIndexes: currentIdx });
        currentIdx = [i];
        currentKw = kw;
      }
    }
    topics.push({ keywords: currentKw.slice(0, 5), cueIndexes: currentIdx });
    return topics;
  }

  const api = {
    tokenize: tokenize,
    rankKeywords: rankKeywords,
    clusterTopics: clusterTopics,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.lectureSynthesizer = api;
  }
})(typeof self !== 'undefined' ? self : this);
