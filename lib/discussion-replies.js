// lib/discussion-replies.js
// 20 short, topic-agnostic discussion replies + a cooldown-aware picker.
(function (root) {
  'use strict';

  const REPLIES = [
    "This actually clicked for me on the second read. The piece about how the framing shifts depending on context is the part I'm still chewing on.",
    "Useful prompt. I'd push back gently on the implied either/or — most of the real cases I've seen sit in the messy middle.",
    "Quick reaction: the bit on tradeoffs felt right. The part about long-term costs is where I want more evidence.",
    "The example is carrying more of the argument than I noticed at first. That was the part that made the main point click for me.",
    "Honestly the angle here surprised me. I went in expecting one conclusion and ended up somewhere else by the end.",
    "Solid. Worth pausing on the assumption baked into step two — that's where I think the disagreements in the class will land.",
    "Two things stuck. First, the definition is sharper than I remembered. Second, the boundary cases matter more than the central ones.",
    "I like this. It takes a clearer position than I expected, and that makes the tradeoffs easier to see.",
    "I'm not fully sold on the example. It feels cleaner than the situation the conclusion is trying to explain.",
    "Reads true. The part I had to slow down on was the move from observation to recommendation — that step is doing a lot of work.",
    "Nice writeup. I keep coming back to the question of who bears the cost when this is applied at scale — feels underexplored.",
    "Half-agree. The descriptive part is sharp; the prescriptive part loses me when it stops engaging with the obvious alternative.",
    "First take: the framework is useful as a sorting tool, less so as a decision tool. Different jobs.",
    "What I'm taking away: the second-order effects are doing more work in the argument than the first-order ones. That's the part to interrogate.",
    "Worth restating in your own words — when I tried, I noticed the steps don't quite connect the way I assumed on first read.",
    "The edge cases are the strongest part for me. Without them, the main point would feel more conventional.",
    "Reasonable. I'd want to see this stress-tested against the case in week two — the one where the usual heuristic breaks.",
    "Tagging this as one to revisit. The argument is tighter than my initial reaction gave it credit for.",
    "Side note: the terminology overlap with the previous module made this harder to read on the first pass than it needed to be.",
    "Pretty much aligns with what I've been mulling over. The one place I'd press is the move from anecdote to general claim — feels quick.",
  ];

  function pickReply(history, rng) {
    const hist = Array.isArray(history) ? history : [];
    const usable = REPLIES.filter(function (r) { return hist.indexOf(r) === -1; });
    const pool = usable.length > 0 ? usable : REPLIES;
    const idx = Math.floor(rng() * pool.length);
    return pool[idx];
  }

  const api = { REPLIES: REPLIES, pickReply: pickReply };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.discussionReplies = api;
  }
})(typeof self !== 'undefined' ? self : this);
