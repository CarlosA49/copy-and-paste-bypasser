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

  const CONNECTORS = [
    'Specifically,',
    'In other words,',
    'What this really means:',
    'Worth pausing on:',
    'Put another way,',
    'The catch:',
  ];

  const HEDGES = [
    'Still chewing on this.',
    'Need to revisit — not fully solid yet.',
    'Tagging this for the next review pass.',
  ];

  const SYNONYMS = {
    important: 'load-bearing',
    simple: 'unfussy',
    complex: 'tangled',
    useful: 'worth keeping',
    common: 'everyday',
    basic: 'starter',
    advanced: 'higher-order',
    final: 'last-mile',
  };

  function pick(arr, random) {
    return arr[Math.floor(random() * arr.length)];
  }

  function trimSentence(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function wordCount(s) {
    return (String(s).match(/\S+/g) || []).length;
  }

  function splitSentences(text) {
    return String(text).split(/(?<=[.!?])\s+/).map(trimSentence).filter(Boolean);
  }

  function shortSummaryFor(topic) {
    const k = (topic.keywords && topic.keywords[0]) || 'this';
    const cap = k.charAt(0).toUpperCase() + k.slice(1);
    return cap + ' — the load-bearing idea.';
  }

  function applyPerplexitySwap(sentence, random) {
    const words = sentence.split(/\b/);
    const swapKeys = Object.keys(SYNONYMS);
    for (let i = 0; i < words.length; i++) {
      const lower = words[i].toLowerCase();
      if (swapKeys.indexOf(lower) !== -1 && random() < 0.5) {
        const repl = SYNONYMS[lower];
        words[i] = (words[i][0] === words[i][0].toUpperCase())
          ? repl.charAt(0).toUpperCase() + repl.slice(1)
          : repl;
        break;
      }
    }
    return words.join('');
  }

  function paragraphFor(topic, cues, random) {
    const parts = [shortSummaryFor(topic)];
    const topicCues = topic.cueIndexes.map(function (i) { return cues[i]; });
    const sentences = [];
    for (let i = 0; i < topicCues.length; i++) {
      const s = splitSentences(topicCues[i].text);
      for (let j = 0; j < s.length; j++) sentences.push(s[j]);
    }
    const mediumOrLong = sentences.filter(function (s) {
      const w = wordCount(s);
      return w >= 6 && w <= 40;
    });
    const target = Math.min(3, Math.max(1, mediumOrLong.length));
    let perplexUsed = false;
    for (let i = 0; i < target; i++) {
      const base = mediumOrLong[i] || sentences[i] || '';
      if (!base) continue;
      const connector = (i === 0) ? '' : pick(CONNECTORS, random) + ' ';
      let body = base;
      if (!perplexUsed) {
        const swapped = applyPerplexitySwap(body, random);
        if (swapped !== body) { body = swapped; perplexUsed = true; }
      }
      parts.push(connector + body);
    }
    return parts.join(' ');
  }

  function generateDraft(opts) {
    opts = opts || {};
    const cues = opts.cues || [];
    if (cues.length === 0) return '';
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const topics = clusterTopics(cues);
    const out = [];
    if (opts.lectureTitle) out.push('# ' + opts.lectureTitle);
    if (opts.weekObjective) out.push("_Tied to this week's goal — " + opts.weekObjective + '._');
    for (let i = 0; i < topics.length; i++) {
      out.push(paragraphFor(topics[i], cues, random));
    }
    out.push(pick(HEDGES, random));
    return out.join('\n\n');
  }

  const api = {
    tokenize: tokenize,
    rankKeywords: rankKeywords,
    clusterTopics: clusterTopics,
    generateDraft: generateDraft,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.lectureSynthesizer = api;
  }
})(typeof self !== 'undefined' ? self : this);
