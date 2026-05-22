// lib/math-normalize.js
// Pure text normaliser. Turns AI math-answer strings into Coursera-acceptable
// syntax: `\times` → `*`, implicit `*`, strip outer parens, strip trailing
// units, LaTeX brace cleanup. No DOM. Dual-export.
(function (root) {
  'use strict';

  // Tokens that look like units but are actually math identifiers — never strip.
  const MATH_IDENTS = new Set([
    'pi', 'e', 'E', 'epsilon_o', 'E_o', 'sqrt', 'sin', 'cos', 'tan',
    'ln', 'log', 'exp', 'abs'
  ]);

  // Rule 1: LaTeX \times and Unicode × → *.
  function replaceLatexTimes(s) {
    return s.replace(/\\times/g, '*').replace(/×/g, '*');
  }

  // Rule 2: ^{N} → ^N.
  function replaceLatexBraces(s) {
    return s.replace(/\^\{([^}]+)\}/g, '^$1');
  }

  // Rule 3: Strip \ prefixes from known LaTeX commands (\sqrt → sqrt, etc.).
  // Also handle \cdot → *.
  function stripLatexBackslashes(s) {
    s = s.replace(/\\cdot\b/g, '*');
    s = s.replace(/\\([A-Za-z]+)/g, '$1');
    return s;
  }

  // Rule 3b: Convert numeric scientific notation to E form.
  //   3.7699×10^-8 → 3.7699E-8       (after replaceLatexTimes, × is already *)
  //   1.23 x 10^8 → 1.23E8
  //   8.0000*10^3 → 8.0000E3
  //
  // Only fires when the mantissa is purely numeric (digits + optional decimal)
  // AND not preceded by an identifier character. So k*10^2 stays as "k*10^2"
  // and 2*epsilon_o stays symbolic. The prefix capture group ensures the
  // mantissa is a standalone number, not the tail of a longer identifier.
  function scientificToE(s) {
    return s.replace(
      /(^|[^A-Za-z0-9_.])(\d+(?:\.\d+)?)\s*[*x]\s*10\s*\^\s*([+-]?\d+)/g,
      function (_m, prefix, mantissa, exp) {
        return prefix + mantissa + 'E' + exp;
      }
    );
  }

  // Rule 5: Strip outer wrapping parentheses iff they balance over the entire
  // string. Repeated until stable.
  // Example: (2*x) → 2*x
  // Example: (a+b)/c → kept (the outer ( closes at the ) before /c, not the end)
  function stripOuterParens(s) {
    let t = s.trim();
    while (t.length >= 2 && t.charAt(0) === '(' && t.charAt(t.length - 1) === ')') {
      // Walk the string. If depth first reaches 0 before the last char, the
      // opening paren is NOT paired with the closing one — stop.
      let depth = 0;
      let outerPaired = true;
      for (let i = 0; i < t.length; i++) {
        const c = t.charAt(i);
        if (c === '(') {
          depth++;
        } else if (c === ')') {
          depth--;
          if (depth === 0 && i < t.length - 1) {
            // Outer ( closed before end of string — parens are NOT wrapping.
            outerPaired = false;
            break;
          }
        }
      }
      if (!outerPaired || depth !== 0) break;
      t = t.slice(1, -1).trim();
    }
    return t;
  }

  // Rule 4: Strip a trailing unit suffix.
  // Pattern: <expression> <space> <unit-token>
  // Unit token: starts with [A-Za-zμΩ°], up to 7 chars of [A-Za-zμΩ°/],
  // optional ²³ superscript.
  // Does NOT strip if the token is a known math identifier.
  // Does NOT strip if the LHS ends with an operator (would mean the unit is
  // part of the expression, e.g. "a + b m" is odd but we play safe).
  function stripTrailingUnit(s) {
    const m = s.match(/^(.*\S)\s+([A-Za-zμΩ°][A-Za-zμΩ°/]{0,6}[²³]?)\s*$/);
    if (!m) return s;
    const lhs = m[1];
    const unit = m[2];
    if (MATH_IDENTS.has(unit)) return s;
    // If lhs ends in operator/open-paren, the "unit" is likely part of the expr.
    if (/[+\-*/^=(]\s*$/.test(lhs)) return s;
    return lhs;
  }

  // Known identifiers sorted longest-first so that "epsilon_o" is matched
  // before a shorter prefix would be consumed.
  const KNOWN_IDENTS_SORTED = Array.from(MATH_IDENTS).sort(function (a, b) {
    return b.length - a.length;
  });

  // Rule 6: Insert implicit * between adjacent tokens where needed.
  // Tokenise into: numbers [0-9.]+, identifiers [A-Za-z_][A-Za-z0-9_]*,
  // single-char operators/parens. Insert * between:
  //   number  → identifier
  //   identifier → identifier
  //   identifier → number
  //   number  → (
  //   identifier → (
  //   )  → number / identifier / (
  //
  // Identifiers are extracted with a "known-first" strategy: at each position
  // we first try to match the longest known identifier (from MATH_IDENTS), then
  // fall back to a greedy [A-Za-z_][A-Za-z0-9_]* scan. This ensures that a
  // string like "epsilon_oE_o" is split into ["epsilon_o", "E_o"] rather than
  // being consumed as one token.
  function insertImplicitMultiplication(s) {
    // Build token list.
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s.charAt(i);
      // Skip whitespace (already collapsed, but defensive).
      if (/\s/.test(c)) { i++; continue; }
      // Number literal (including decimals and trailing E-notation).
      // After scientificToE, mantissas like "3.7699E-8" must be ONE token,
      // not [num "3.7699", id "E", op "-", num "8"]. Otherwise the implicit-*
      // pass would insert a spurious star between mantissa and "E".
      if (/[0-9.]/.test(c)) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s.charAt(j))) j++;
        // Extend through E[+-]?digits if present.
        if (j < s.length && (s.charAt(j) === 'E' || s.charAt(j) === 'e')) {
          let k = j + 1;
          if (k < s.length && (s.charAt(k) === '+' || s.charAt(k) === '-')) k++;
          let m = k;
          while (m < s.length && /[0-9]/.test(s.charAt(m))) m++;
          // Only extend if at least one digit followed the optional sign.
          if (m > k) j = m;
        }
        tokens.push({ kind: 'num', text: s.slice(i, j) });
        i = j;
        continue;
      }
      // Identifier: starts with letter or underscore.
      if (/[A-Za-z_]/.test(c)) {
        // First: try known identifiers (longest match wins).
        let matched = null;
        for (let ki = 0; ki < KNOWN_IDENTS_SORTED.length; ki++) {
          const ident = KNOWN_IDENTS_SORTED[ki];
          if (s.startsWith(ident, i)) {
            // Ensure this is a complete token: next char must not be [A-Za-z0-9_]
            const nextPos = i + ident.length;
            if (nextPos >= s.length || !/[A-Za-z0-9_]/.test(s.charAt(nextPos))) {
              matched = ident;
              break;
            }
          }
        }
        if (matched) {
          tokens.push({ kind: 'id', text: matched });
          i += matched.length;
          continue;
        }
        // Fallback: greedy identifier scan (stops before a known-ident boundary).
        let j = i + 1;
        while (j < s.length && /[A-Za-z0-9_]/.test(s.charAt(j))) {
          // Before consuming the next character, check if remaining substring
          // starts a known identifier. If so, break here so it gets its own token.
          let startsKnown = false;
          for (let ki = 0; ki < KNOWN_IDENTS_SORTED.length; ki++) {
            const ident = KNOWN_IDENTS_SORTED[ki];
            if (s.startsWith(ident, j)) {
              const nextPos = j + ident.length;
              if (nextPos >= s.length || !/[A-Za-z0-9_]/.test(s.charAt(nextPos))) {
                startsKnown = true;
                break;
              }
            }
          }
          if (startsKnown) break;
          j++;
        }
        tokens.push({ kind: 'id', text: s.slice(i, j) });
        i = j;
        continue;
      }
      // Single-char operator or paren.
      if (c === '(') {
        tokens.push({ kind: 'lparen', text: c });
      } else if (c === ')') {
        tokens.push({ kind: 'rparen', text: c });
      } else {
        tokens.push({ kind: 'op', text: c });
      }
      i++;
    }

    // Rebuild, inserting * where needed.
    const out = [];
    for (let k = 0; k < tokens.length; k++) {
      const tok = tokens[k];
      const prev = out.length > 0 ? out[out.length - 1] : null;
      if (prev) {
        const needsStar =
          (prev.kind === 'num'    && tok.kind === 'id')     ||
          (prev.kind === 'id'     && tok.kind === 'id')     ||
          (prev.kind === 'id'     && tok.kind === 'num')    ||
          (prev.kind === 'num'    && tok.kind === 'lparen') ||
          (prev.kind === 'id'     && tok.kind === 'lparen') ||
          (prev.kind === 'rparen' && tok.kind === 'num')    ||
          (prev.kind === 'rparen' && tok.kind === 'id')     ||
          (prev.kind === 'rparen' && tok.kind === 'lparen');
        if (needsStar) out.push({ kind: 'op', text: '*' });
      }
      out.push(tok);
    }

    return out.map(function (t) { return t.text; }).join('');
  }

  // Public API: apply all rules in order until stable.
  function normalizeMathAnswer(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();
    if (!s) return '';

    // Rules 1–3: LaTeX substitutions.
    s = replaceLatexTimes(s);
    s = replaceLatexBraces(s);
    s = stripLatexBackslashes(s);

    // Rule 3b: numeric N*10^M → NEM (Coursera prefers E notation in numeric fields).
    s = scientificToE(s);

    // Rule 5 (first pass): strip outer parens before unit check so that
    // e.g. "(3.7647*10^5) N/C" — the ) is NOT the last char, so parens
    // are NOT stripped here. That is intentional: unit is still present.
    s = stripOuterParens(s);

    // Rule 4: strip trailing unit.
    s = stripTrailingUnit(s);

    // Rule 5 (second pass): now strip outer parens if unit was removed.
    s = stripOuterParens(s);

    // Rule 6: insert implicit multiplication.
    s = insertImplicitMultiplication(s);

    // Rule 7: collapse whitespace (tokens were joined without spaces, but
    // any residual spaces from the original input are cleaned up).
    s = s.replace(/\s+/g, '');

    return s;
  }

  const api = { normalizeMathAnswer: normalizeMathAnswer };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.mathNormalize = api;
  }
})(typeof self !== 'undefined' ? self : this);
