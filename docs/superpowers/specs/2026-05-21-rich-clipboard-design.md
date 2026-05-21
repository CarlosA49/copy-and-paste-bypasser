# Rich Clipboard Output Design

**Status:** Approved 2026-05-21.

## Goal

Extend the Clipboard Cleaner browser extension to write **both** `text/plain` and `text/html` to the clipboard on copy. The HTML payload preserves question structure, answer choices, tables, and math semantics; the plain-text payload emits the same content in a form AI chat boxes parse well. The existing junk-paragraph filter continues to strip Coursera's AI-prompt-injection boilerplate from both payloads.

## Non-goals

- No new UI, options page, or per-site config — both clipboard formats are always written.
- No support for non-MathJax math libraries (KaTeX, custom SVG math). If they show up, they pass through as their existing DOM. Add support later if needed.
- No image rewriting — `<img src="...">` is kept verbatim (modulo attribute stripping).

## Architecture

Two cooperating modules:

```
content.js                       ← unchanged role: copy-event listener
  │
  ├─> lib/html-cleaner.js        ← NEW. Pure: html-string → { cleanHtml, cleanText }
  │     │
  │     └─> reuses JUNK_LINE_PATTERNS from lib/cleaner.js as single source of truth
  │
  └─> lib/cleaner.js             ← existing. Pure: text-string → text-string
        Used as a paranoid final pass over the plain-text output, and as the
        sole fallback when no selection HTML is available.
```

### Copy flow in `content.js`

```
on copy event:
  range = window.getSelection().getRangeAt(0)        (if no selection → fall through, browser default)
  fragment = range.cloneContents()
  rawHtml = serialize(fragment)                      (temp div .innerHTML)
  { cleanHtml, cleanText } = cleanSelectionHtml(rawHtml)
  event.clipboardData.setData('text/html', cleanHtml)
  event.clipboardData.setData('text/plain', cleanText)
  event.preventDefault()
```

Capture-phase listener, `document_start` injection, and the cleaner-module-not-loaded fallback all stay the same as today.

### `cleanSelectionHtml(rawHtml: string) → { cleanHtml, cleanText }`

Single entry point. Lives in `lib/html-cleaner.js`. Pure: takes an HTML string, returns two strings.

Runtime DOM provider:
- **Browser:** `new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html')` and operate on the `<body>` element.
- **Node tests:** `new JSDOM('<body>' + html + '</body>').window.document.body`. `jsdom` becomes a devDependency.

The function:
1. Parses the input HTML into a DOM document.
2. Walks the tree, applying the four cleaning passes below, producing a cleaned DOM.
3. Serializes the cleaned DOM to a string → `cleanHtml`.
4. Walks the cleaned DOM to produce plain text → `cleanText`.
5. Runs `cleanText` through the existing `cleanCopiedText` from `lib/cleaner.js` as a paranoid final pass.
6. Returns `{ cleanHtml, cleanText }`.

## Cleaning passes (HTML)

Applied in order against the parsed `<body>`.

### Pass 1 — MathJax normalisation

For each MathJax-rendered equation in the tree, locate the LaTeX source by checking these in priority order, stopping at the first hit:

1. Sibling/child `<script type="math/tex">` element — its `textContent` is the LaTeX (MathJax v2).
2. Descendant `<annotation encoding="application/x-tex">` inside a `<math><semantics>` — its `textContent` is the LaTeX (MathML w/ TeX annotation, MathJax v3).
3. `data-mml-node`, `data-original-source`, or `data-original-content` attribute on the MathJax container.
4. Existing `<math>` element's `alttext` attribute.
5. Fallback: textContent of the assistive MathML span with leading/trailing whitespace collapsed.

If none yields anything, leave the original tree untouched (don't make it worse).

Display mode is determined by:
- `<script type="math/tex; mode=display">` → display, OR
- container class includes `MathJax_Display` / `mjx-display`, OR
- the original `<math>` carries `display="block"`.

Otherwise inline.

Replace the entire MathJax tree (the outermost `.MathJax*` / `<math>` ancestor) with one of:

```html
<!-- inline -->
<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><semantics>
  <!-- rendered MathML, when available from path 2 or path 5; otherwise omitted -->
  <annotation encoding="application/x-tex">LATEX</annotation>
</semantics></math>

<!-- display -->
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics>
  …
  <annotation encoding="application/x-tex">LATEX</annotation>
</semantics></math>
```

If we already have MathML available (paths 2 or 5), preserve it inside `<semantics>` and append the `<annotation>`. If we only have LaTeX (paths 1, 3, 4), emit an `<mtext>LATEX</mtext>` as the visible primary child alongside the `<annotation>` — a `<math>` element with only an `<annotation>` renders blank in many rich-text targets, so the `<mtext>` ensures the LaTeX shows up as readable text wherever MathML rendering falls back. Renderers that handle MathML will display the rendered nodes (or the `<mtext>` fallback); AI tools that read text will see the LaTeX in the annotation either way.

Concrete shapes:

```html
<!-- MathML available (paths 2 or 5) -->
<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><semantics>
  <mrow>…rendered MathML…</mrow>
  <annotation encoding="application/x-tex">LATEX</annotation>
</semantics></math>

<!-- LaTeX-only (paths 1, 3, 4) -->
<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><semantics>
  <mtext>LATEX</mtext>
  <annotation encoding="application/x-tex">LATEX</annotation>
</semantics></math>
```

Notes:
- Multiple parallel MathJax renderings of the same equation collapse to one `<math>` element.
- `<script type="math/tex">` standalone elements (no enclosing MathJax container) are also handled — replaced in place with a `<math>` element by the same logic.

### Pass 2 — Block-level junk drop

Block-level tags considered: `p`, `div`, `section`, `article`, `aside`, `header`, `footer`, `figure`, `figcaption`, `blockquote`, `li`, `tr`, `td`, `th`.

For each such element, walking depth-first:
- Compute the element's `textContent`, normalised to single spaces.
- If it matches any `JUNK_LINE_PATTERNS` regex from `lib/cleaner.js`, remove the entire element.
- An element is checked **after** its children have been processed, so we drop the smallest block that contains the junk rather than its huge ancestor.

This is the HTML analogue of the existing paragraph-level filter: the same `JUNK_LINE_PATTERNS` array drives both.

### Pass 3 — Attribute stripping

For every remaining element:
- Remove: `class`, `style`, `id`, every `data-*` attribute, `aria-*` attribute, `role`, `tabindex`, `contenteditable`, `xmlns:*` other than the one on `<math>`.
- Keep only this allow-list of attributes per element:
  - `<a>`: `href`, `title`
  - `<img>`: `src`, `alt`, `title`, `width`, `height`
  - `<td>` / `<th>`: `colspan`, `rowspan`, `scope`
  - `<ol>`: `start`, `type`, `reversed`
  - `<th>`: `abbr`
  - `<math>`: `xmlns`, `display`, `alttext`
  - `<annotation>`: `encoding`
- All other attributes on all other elements are dropped.

### Pass 4 — Tag filtering and unwrap

Allowed tags (semantic structure we want to preserve):

```
h1 h2 h3 h4 h5 h6
p br hr
ul ol li
table thead tbody tfoot tr td th caption
blockquote pre code kbd samp var
strong em b i u s del ins mark small sub sup
a img figure figcaption
math semantics annotation mrow mi mn mo ms mtext mfrac msup msub msubsup
  munder mover munderover msqrt mroot mtable mtr mtd mlabeledtr menclose
  mphantom mpadded mfenced mspace mglyph
```

For every element in the tree:
- If its tag is in the allow-list → keep as-is (attributes already filtered in Pass 3).
- If not → **unwrap**: replace the element with its children in place. The element itself disappears but its content stays.
- After unwrapping, runs of adjacent whitespace text nodes are coalesced.

Then a final sweep: any element from the kept block tags that has no remaining non-whitespace children is removed (drops empty wrappers left behind by the junk-drop pass).

### Output: `cleanHtml`

The serialised `<body>` contents after the four passes, with these final touches:
- Leading/trailing whitespace trimmed.
- Consecutive `<br>` collapsed to at most two (visual paragraph break).
- A `\n` inserted between sibling block elements during serialisation for human-readability of the raw HTML; the rendered result is unaffected.

## Plain-text derivation

Walk the cleaned DOM (post Pass 4). Emit text per node:

| Node type | Output |
|---|---|
| Text node | the text, with runs of whitespace collapsed to single space, but preserving the text exactly within `<pre>` / `<code>` contexts |
| `<br>` | `\n` |
| `<hr>` | `\n\n---\n\n` |
| Block element (start) | a `\n` if previous emitted char wasn't already a newline |
| Block element (end) | a `\n\n` for paragraph separation |
| `<li>` in `<ol>` | indent + index + `. ` prefix where index follows `<ol start>` / sibling count, then content, then `\n` |
| `<li>` in `<ul>` | indent + `- ` prefix, then content, then `\n` |
| `<th>` / `<td>` | content + tab between cells; cells separated by `\t`, rows by `\n` |
| `<a>` | `text (href)` if `href` is present and differs from text; otherwise just text |
| `<img>` | `alt` if present; else empty |
| `<math display="inline">` | `$LATEX$` (LaTeX read from `<annotation>`) |
| `<math display="block">` | `\n$$LATEX$$\n` |
| Other inline element | just descend into children |

After the walk:
- Multiple consecutive blank lines collapsed to one blank line.
- Trailing whitespace stripped.
- Result passed through `cleanCopiedText` from `lib/cleaner.js` for a final paranoid sweep. If anything junk got through (e.g., a span whose text matched a junk pattern but whose ancestor block didn't), the paragraph filter still catches it.

### Anti-duplication of visible labels

Coursera sometimes renders answer choices with the label baked into the visible text — e.g., `<li>(a) Force</li>` or non-list-wrapped `<div>1. Force</div>`. We must not produce `1. (a) Force`. Heuristic, applied per `<li>`:

If the `<li>` body's first non-whitespace text matches `/^(\(?[a-z0-9]\)|\(?[a-z0-9][.):])/i` (i.e., starts with `1.`, `1)`, `(1)`, `a.`, `a)`, `(a)`, etc., case-insensitive), **suppress the auto-prefix** and emit the body as-is. Otherwise apply the standard `1.` / `- ` prefix.

This also applies to display math: if the LaTeX itself begins with a tag like `(1)` or `\tag{1}`, no extra numbering is added.

## File layout summary

```
lib/cleaner.js                   # unchanged surface; JUNK_LINE_PATTERNS exported
lib/html-cleaner.js              # NEW. exports { cleanSelectionHtml }
content.js                       # modified: write text/html as well as text/plain
package.json                     # adds devDependency: jsdom
tests/cleaner.test.js            # unchanged
tests/html-cleaner.test.js       # NEW. uses jsdom; covers each pass
```

## Testing

`tests/html-cleaner.test.js`, all using `jsdom`. Each test calls `cleanSelectionHtml` with an HTML input and asserts on **both** `cleanHtml` (with whitespace-tolerant string match or DOM equivalence) and `cleanText`.

Required test cases:

1. **No-op input** — clean text with no junk and no math passes through structurally intact.
2. **Junk `<div>` drop** — a `<div>` whose textContent matches `\bcoursera\b` is removed from the HTML; surrounding content survives.
3. **Junk inside a `<section>`** — only the junk child block is removed, the section and its other children survive.
4. **MathJax v2 inline equation** — `<span class="MathJax">…</span><script type="math/tex">x = 5</script>` becomes one `<math>` containing `<mtext>x = 5</mtext>` and `<annotation>x = 5</annotation>` (LaTeX-only path → mtext visible fallback); plain text is `$x = 5$`.
5. **MathJax v2 display equation** — same as above but `mode=display`, output uses `display="block"` and plain text emits `$$…$$` on its own line.
6. **MathML w/ annotation** — pre-existing `<math><semantics><mrow>…</mrow><annotation encoding="application/x-tex">…</annotation></semantics></math>` is kept intact (real MathML preserved, no `<mtext>` injected); MathML rendering survives.
7. **Attribute stripping** — input element `<p class="x" style="color:red" data-foo="bar" id="z">Hi</p>` becomes `<p>Hi</p>`.
8. **Tag unwrap** — `<font color="red">word</font>` produces just `word`; non-allowed tags disappear, content stays.
9. **Allow-list attributes survive** — `<a href="/x" title="t" class="y">link</a>` becomes `<a href="/x" title="t">link</a>`.
10. **Ordered list numbering** — `<ol><li>a</li><li>b</li></ol>` plain text is `1. a\n2. b`.
11. **Unordered list bullets** — `<ul><li>a</li><li>b</li></ul>` plain text is `- a\n- b`.
12. **Anti-duplication** — `<ol><li>(a) Force</li><li>(b) Current</li></ol>` plain text is `(a) Force\n(b) Current` (no `1.` / `2.` added).
13. **Table preservation** — `<table><tr><th>K</th><th>V</th></tr><tr><td>x</td><td>1</td></tr></table>` plain text is `K\tV\nx\t1`.
14. **Realistic Coursera quiz question** — a full DOM snippet mirroring the user's pasted output: question number, question text, embedded inline equation, the AI-prompt-injection `<div>`, four answer choices in a list, `1 point`. Result: question, equation in LaTeX, four choices, `1 point` — boilerplate `<div>` gone.
15. **`<br>` newline** — `a<br>b` plain text is `a\nb`.
16. **Empty wrapper sweep** — `<div><div><span></span></div></div>` produces empty `cleanHtml` and empty `cleanText`.
17. **Anchor with same text and href** — `<a href="http://x">http://x</a>` plain text is just `http://x` (no `(http://x)` duplication).
18. **Paranoid final pass** — junk text that the element walker would not catch (e.g., a top-level text node containing `Do you understand?.`) is still removed by the post-walk plain-text filter.

`tests/cleaner.test.js` is untouched.

## Risks & mitigations

- **`jsdom` is heavy.** It's a dev-time dependency only — content scripts use the browser's native `DOMParser`. Runtime extension package is unchanged in size.
- **DOM parsing in MV3 isolated world.** `DOMParser` is available in isolated worlds; no permission needed.
- **MathML rendering in target editors.** Modern Chrome, Word, Google Docs, Notion handle MathML in pasted HTML. Older editors will fall back to the textContent of the `<annotation>`, which is the LaTeX source — still readable.
- **Unknown MathJax variants.** If Coursera ever uses a MathJax config not covered by the 5 detection paths, the equation passes through untouched (no degradation). The fallback path means we never make math worse.
- **Selection that spans a junk block and its surroundings.** If the user selects across the boundary of a junk block, only the junk block is removed; the surrounding selection is preserved. Behaviour matches existing paragraph filter.

## Open question

None — both attribute-stripping and list-formatting questions confirmed by the user. Anti-duplication heuristic added in response to user's note about visible answer labels.
