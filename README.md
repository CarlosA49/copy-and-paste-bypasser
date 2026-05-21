# Clipboard Cleaner

A Manifest V3 browser extension for Chrome and Edge that intercepts the `copy` event on educational sites (Coursera by default) and removes injected copyright / "do not share" boilerplate before the text reaches your clipboard.

## What it does

When you copy text, the extension:
1. Reads your current selection.
2. Drops any line containing `coursera`, `copyright`, `assessment`, `don't share`, `(c) YEAR`, or `© YEAR`.
3. Trims trailing whitespace.
4. Writes the cleaned text to the clipboard.

Your selection stays visually highlighted so you can still see what you copied.

## Load in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the folder that contains `manifest.json` (the project root).
5. Visit a Coursera reading or assessment, select text, and copy. Paste into a plain text editor to verify the boilerplate is gone.

## Load in Edge

1. Open `edge://extensions`.
2. Toggle **Developer mode** on (bottom-left).
3. Click **Load unpacked**.
4. Select the folder that contains `manifest.json`.
5. Test as above.

## Targeting other sites

By default the extension only runs on `*.coursera.org`. To widen it, edit the `matches` array in `manifest.json`. To run on every site, replace the array with:

```json
"matches": ["<all_urls>"]
```

Reload the extension from the extensions page after any manifest change.

## Tuning the filter

The list of patterns that mark a line as junk lives in `lib/cleaner.js` as `JUNK_LINE_PATTERNS`. Add or remove regexes there. Each pattern is tested against a single line; if any matches, the whole line is dropped.

## Sidebar UI

Clipboard Cleaner adds a floating panel on the right side of any Coursera page. When closed, a small pill button sits in the lower-right corner — click it to reopen.

### Copied Text tab

Every time you copy text from the page, the cleaned plain-text result appears in this tab. Click **Copy** to re-copy the cleaned text from the panel itself. Empty / success / error states are shown inline.

### Auto Typer tab

Auto Typer types text into the editable field you focused most recently. To use:

1. Click into the input, textarea, or contenteditable field you want typed into.
2. Open the panel and switch to **Auto Typer**.
3. Paste or type the source text into the textarea.
4. Choose a profile (Balanced Natural / Careful Writer / Fast Drafter), a speed (Slow / Normal / Fast), and whether to simulate humanlike typos with corrections.
5. Click **Start**. Confirm in the modal — Auto Typer will not run until you confirm.
6. While typing you can **Pause / Resume** or **Stop** at any time. If the focused field changes mid-run, Auto Typer halts automatically.

The Auto Typer only writes to the editable element you focused before clicking Start; it cannot run hidden or without an explicit user action.

### Answering for you

Paste the answer text you want to apply (for example: "The correct answers are A and C" or a quoted option phrase like "Gradient descent"). Click **Apply to page** and the extension will:

1. Parse letter answers (A, B, C…), numeric option references (`option 2`, `#3`), and quoted option text.
2. Scan the current page for radio / checkbox groups (including ARIA `role="radio"` / `role="checkbox"`).
3. Tick the matching option(s). Radio groups receive a single selection; checkbox groups receive all matches.

Nothing is sent off-device — parsing and matching happen entirely in the content script.

### Resizing

Drag the left edge of the panel to resize between 280 and 640 pixels wide.

## Running the tests

Requires Node.js 20 or newer (for the built-in test runner).

```bash
npm test
```
