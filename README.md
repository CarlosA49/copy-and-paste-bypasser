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

## Running the tests

Requires Node.js 20 or newer (for the built-in test runner).

```bash
npm test
```
