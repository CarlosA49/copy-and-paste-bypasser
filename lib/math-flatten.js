// lib/math-flatten.js
// Pure LaTeX → visible-text flattener. Returns a Unicode-rendered string for
// simple math (greek, thin spaces, basic operators, super/subscript digits)
// and returns null for genuinely complex constructs (\frac, \sqrt, \sum, etc.)
// so callers can fall back to the raw LaTeX form ($...$).
//
// No DOM. Dual-export (browser global + CommonJS).
(function (root) {
  'use strict';

  // If the LaTeX contains any of these constructs, flattening is unsafe.
  const COMPLEX_MARKERS = [
    /\\frac\b/, /\\sqrt\b/, /\\sum\b/, /\\int\b/, /\\prod\b/,
    /\\binom\b/, /\\over\b/, /\\begin\{/, /\\end\{/, /\\\\/,
    /\\matrix\b/, /\\cases\b/, /\\left\b/, /\\right\b/,
  ];

  // Greek + symbol macros → Unicode. Trailing single space after the macro is
  // consumed by the replacement regex so "\mu H" becomes "μH" (not "μ H").
  const MACROS = {
    'Alpha':'Α','alpha':'α','Beta':'Β','beta':'β','Gamma':'Γ','gamma':'γ',
    'Delta':'Δ','delta':'δ','Epsilon':'Ε','epsilon':'ε','varepsilon':'ε',
    'Zeta':'Ζ','zeta':'ζ','Eta':'Η','eta':'η','Theta':'Θ','theta':'θ',
    'Iota':'Ι','iota':'ι','Kappa':'Κ','kappa':'κ','Lambda':'Λ','lambda':'λ',
    'Mu':'Μ','mu':'μ','Nu':'Ν','nu':'ν','Xi':'Ξ','xi':'ξ',
    'Omicron':'Ο','omicron':'ο','Pi':'Π','pi':'π','Rho':'Ρ','rho':'ρ',
    'Sigma':'Σ','sigma':'σ','Tau':'Τ','tau':'τ','Upsilon':'Υ','upsilon':'υ',
    'Phi':'Φ','phi':'φ','varphi':'φ','Chi':'Χ','chi':'χ','Psi':'Ψ','psi':'ψ',
    'Omega':'Ω','omega':'ω',
    'times':'×','cdot':'·','pm':'±','mp':'∓',
    'leq':'≤','le':'≤','geq':'≥','ge':'≥','neq':'≠','ne':'≠',
    'approx':'≈','equiv':'≡','sim':'∼','propto':'∝',
    'infty':'∞','partial':'∂','nabla':'∇',
    'degree':'°','circ':'°',
    'rightarrow':'→','to':'→','leftarrow':'←','Rightarrow':'⇒',
    'in':'∈','notin':'∉','subset':'⊂','supset':'⊃','cup':'∪','cap':'∩',
  };

  const SUPER = {
    '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹',
    '+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ',
  };
  const SUB = {
    '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉',
    '+':'₊','-':'₋','=':'₌','(':'₍',')':'₎',
  };

  function flattenLatexToText(latex) {
    if (typeof latex !== 'string') return null;
    let s = latex.trim();
    if (!s) return '';
    // Strip enclosing $$...$$ or $...$ delimiters.
    s = s.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').trim();
    if (!s) return '';

    // Complex constructs → bail so caller falls back to LaTeX form.
    for (let i = 0; i < COMPLEX_MARKERS.length; i++) {
      if (COMPLEX_MARKERS[i].test(s)) return null;
    }

    // Thin / negative / various LaTeX spacing → regular space.
    s = s.replace(/\\[,!;:>]/g, ' ').replace(/\\ /g, ' ');

    // \text{...} → contents.
    s = s.replace(/\\text\{([^}]*)\}/g, '$1');

    // Macro substitution. The trailing " ?" eats one space after the macro so
    // "\mu H" → "μH" rather than "μ H".
    s = s.replace(/\\([A-Za-z]+)\b ?/g, function (m, name) {
      if (Object.prototype.hasOwnProperty.call(MACROS, name)) return MACROS[name];
      return m; // unknown macro — leave intact, caller may still fall back
    });

    // If any backslash macros remain, we don't know how to render them.
    if (/\\[A-Za-z]+/.test(s)) return null;

    // Superscripts: ^{XYZ} or ^X (single token). If any character can't be
    // mapped, return the original match — and a later check bails the whole
    // flatten.
    s = s.replace(/\^\{([^{}]+)\}|\^(\S)/g, function (m, group, single) {
      const inner = (group !== undefined ? group : single);
      let out = '';
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (Object.prototype.hasOwnProperty.call(SUPER, ch)) out += SUPER[ch];
        else return m;
      }
      return out;
    });

    // Subscripts: same rule.
    s = s.replace(/_\{([^{}]+)\}|_(\S)/g, function (m, group, single) {
      const inner = (group !== undefined ? group : single);
      let out = '';
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (Object.prototype.hasOwnProperty.call(SUB, ch)) out += SUB[ch];
        else return m;
      }
      return out;
    });

    // Any remaining ^ or _ means we couldn't flatten cleanly.
    if (/[\^_]/.test(s)) return null;

    // Strip leftover braces { ... } → contents. Iterate so nested groups like
    // {{x}} fully unwrap; the regex matches only innermost braces each pass.
    let prev;
    do { prev = s; s = s.replace(/\{([^{}]*)\}/g, '$1'); } while (s !== prev);

    // Collapse multiple spaces.
    s = s.replace(/\s+/g, ' ').trim();

    return s;
  }

  const api = { flattenLatexToText: flattenLatexToText };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.mathFlatten = api;
  }
})(typeof self !== 'undefined' ? self : this);
