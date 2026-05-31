// lib/peer-review-replies.js
// ~20 generic, domain-neutral, human-sounding peer-review comments + a
// cooldown-aware, min-length-padding picker. No topic / AI / Coursera mention.
(function (root) {
  'use strict';

  const COMMENTS = [
    "Solid work overall. You laid out the steps clearly enough that I could follow your reasoning without backtracking, which is harder to do than it looks.",
    "I appreciated how direct this was. A couple of the middle points could use a sentence more of support, but the through-line held up.",
    "Strong submission. The part that worked best for me was how you connected the opening claim to the conclusion instead of leaving it implied.",
    "Clear and well organized. I'd only nudge you to spell out the assumption behind your second point, since it carries a lot of the argument.",
    "Nicely done. You picked a defensible position and stuck with it, and the examples mostly earned their place rather than padding the length.",
    "Good effort here. The structure is easy to navigate. Where I got slowed down was the jump from the evidence to the recommendation.",
    "This reads like you actually thought it through rather than rushing it. The tradeoffs you named felt genuine, not boilerplate.",
    "Competent and readable. One thing I'd flag: the strongest idea is buried in the middle, and it deserves to be up front.",
    "I liked the restraint. You resisted the urge to overclaim, and that made the parts you did assert land harder.",
    "Decent foundation. The opening is sharp; the closing trails off a little, so a firmer final sentence would tie it together.",
    "Honestly better than I expected from the prompt. You found an angle that wasn't obvious and committed to it without hedging everything.",
    "Works well. I'd push you on the example in the third section — it almost makes the opposite case if you read it closely.",
    "Thorough. You covered the bases and didn't leave obvious gaps, though a tighter edit would let the best points breathe more.",
    "Good instincts throughout. The reasoning is sound; what's missing is one concrete instance to anchor the more abstract middle stretch.",
    "I found this persuasive. The move from the general principle to the specific case was smooth, which is exactly where most attempts stumble.",
    "Reasonable and clear-eyed. You acknowledged the weaker side of your own position, and that honesty made the whole thing more convincing.",
    "Well argued. If I were revising it, I'd cut the qualifier in the second paragraph — it softens a claim that didn't need softening.",
    "Pretty effective. The pacing is uneven in spots, but the core idea is genuinely interesting and you gave it room to develop.",
    "Capable work. The framing is the standout part. The supporting detail is fine, just a touch generic where a sharper instance would help.",
    "This holds together. You didn't try to do too much, and the focus paid off — every section earned its keep instead of wandering.",
    "Genuinely thoughtful. I came away with a clearer sense of where you stand, and the few rough edges are easy fixes, not structural problems.",
    "Good submission. The logic chains cleanly from start to finish, and the one place I'd revisit is the transition into your final point.",
  ];

  function pickComment(history, minLength, random) {
    const hist = Array.isArray(history) ? history : [];
    const min = (typeof minLength === 'number' && minLength > 0) ? minLength : 0;
    const rng = (typeof random === 'function') ? random : Math.random;

    function pickOne(exclude) {
      const usable = COMMENTS.filter(function (c) { return exclude.indexOf(c) === -1; });
      const pool = usable.length > 0 ? usable : COMMENTS;
      const idx = Math.floor(rng() * pool.length);
      return pool[idx];
    }

    // First pick avoids recent history.
    let result = pickOne(hist);
    if (result.length >= min) return result;

    // Pad by appending further pool sentences (avoiding immediate repeats),
    // bounded so an absurd minLength can never loop forever.
    const used = hist.slice();
    used.push(result);
    let guard = 0;
    while (result.length < min && guard < 100000) {
      const next = pickOne(used);
      result = result + ' ' + next;
      used.push(next);
      guard += 1;
    }
    return result;
  }

  const api = { COMMENTS: COMMENTS, pickComment: pickComment };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.peerReviewReplies = api;
  }
})(typeof self !== 'undefined' ? self : this);
