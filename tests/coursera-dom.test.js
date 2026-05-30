// tests/coursera-dom.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  parseLearnUrl,
  classifyKind,
  parseItemAccessibleName,
  itemStatus,
  isExcludedNode,
  assessmentRoot,
  withinAssessment,
  findOutlineNav,
  findModuleRegions,
  findItemLinks,
  findNextItemButton,
  isExternalLaunchPage,
} = require('../lib/coursera-dom.js');

function dom(html, url) {
  return new JSDOM(
    '<!doctype html><html><body>' + html + '</body></html>',
    { url: url || 'https://www.coursera.org/learn/matlab/home/week/1' }
  ).window.document;
}

test('parseLearnUrl decomposes the /learn/{slug}/{kind}/{id}/{itemSlug} grammar', () => {
  assert.deepEqual(
    parseLearnUrl('https://www.coursera.org/learn/matlab/lecture/abc123/intro'),
    { courseSlug: 'matlab', kind: 'lecture', id: 'abc123', itemSlug: 'intro' }
  );
  assert.deepEqual(
    parseLearnUrl('https://www.coursera.org/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments'),
    { courseSlug: 'matlab', kind: 'ungradedWidget', id: '8h1hv', itemSlug: 'completing-matlab-programming-assignments' }
  );
  assert.deepEqual(
    parseLearnUrl('https://www.coursera.org/learn/matlab/gradedLti/0OaH5/assignment-echo-generator'),
    { courseSlug: 'matlab', kind: 'gradedLti', id: '0OaH5', itemSlug: 'assignment-echo-generator' }
  );
});

test('parseLearnUrl tolerates a missing itemSlug and query/hash', () => {
  assert.deepEqual(
    parseLearnUrl('/learn/x/quiz/q1'),
    { courseSlug: 'x', kind: 'quiz', id: 'q1', itemSlug: null }
  );
  assert.deepEqual(
    parseLearnUrl('/learn/x/exam/e9?foo=1#frag'),
    { courseSlug: 'x', kind: 'exam', id: 'e9', itemSlug: null }
  );
});

test('parseLearnUrl returns null for non-learn URLs', () => {
  assert.equal(parseLearnUrl('https://www.coursera.org/about'), null);
  assert.equal(parseLearnUrl(''), null);
  assert.equal(parseLearnUrl(null), null);
});

test('classifyKind maps known URL segments and keeps unknown as other', () => {
  assert.equal(classifyKind('/learn/x/lecture/abc/x'), 'video');
  assert.equal(classifyKind('/learn/x/supplement/abc/x'), 'reading');
  assert.equal(classifyKind('/learn/x/discussionPrompt/abc/x'), 'discussion');
  assert.equal(classifyKind('/learn/x/ungradedWidget/abc/x'), 'plugin');
  assert.equal(classifyKind('/learn/x/quiz/abc'), 'quiz');
  assert.equal(classifyKind('/learn/x/exam/abc'), 'exam');
  assert.equal(classifyKind('/learn/x/peer/abc'), 'peer');
  assert.equal(classifyKind('/learn/x/assignment/abc'), 'assignment');
  assert.equal(classifyKind('/learn/x/programming/abc'), 'programming');
  assert.equal(classifyKind('/learn/x/gradedLti/abc'), 'gradedLti');
  assert.equal(classifyKind('/learn/x/home/week/1'), 'home');
  assert.equal(classifyKind('/learn/x/brandNewSegment/abc'), 'other');
});

test('classifyKind accepts a bare segment token', () => {
  assert.equal(classifyKind('lecture'), 'video');
  assert.equal(classifyKind('ungradedWidget'), 'plugin');
  assert.equal(classifyKind('mysteryKind'), 'other');
});

test('classifyKind cross-checks accessibleName when the URL is ambiguous', () => {
  // No usable URL segment, but an accessibleName naming an Ungraded Plugin.
  assert.equal(classifyKind('', 'Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min'), 'plugin');
  assert.equal(classifyKind('', 'Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min'), 'gradedLti');
  assert.equal(classifyKind('', 'Video, Scripts, Not submitted, 4 min'), 'video');
  assert.equal(classifyKind('', 'Reading, Syllabus, Completed, 10 min'), 'reading');
});

test('parseItemAccessibleName parses the four-token grammar (no lock reason)', () => {
  assert.deepEqual(
    parseItemAccessibleName('Reading, Recommended Textbook, Completed, 10 min'),
    { kindToken: 'Reading', title: 'Recommended Textbook', status: 'completed', lockReason: null, durationText: '10 min' }
  );
  assert.deepEqual(
    parseItemAccessibleName('Video, Scripts, Not submitted, 4 min'),
    { kindToken: 'Video', title: 'Scripts', status: 'not-submitted', lockReason: null, durationText: '4 min' }
  );
  assert.deepEqual(
    parseItemAccessibleName('Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min'),
    { kindToken: 'Ungraded Plugin', title: 'Completing MATLAB Programming Assignments', status: 'not-submitted', lockReason: null, durationText: '15 min' }
  );
});

test('parseItemAccessibleName parses the five-token grammar with an optional lock reason', () => {
  assert.deepEqual(
    parseItemAccessibleName('Reading, Solution to valid_date, Locked, Complete previous item to unlock, 10 min'),
    { kindToken: 'Reading', title: 'Solution to valid_date', status: 'locked', lockReason: 'Complete previous item to unlock', durationText: '10 min' }
  );
});

test('parseItemAccessibleName keeps a title that itself contains a colon', () => {
  assert.deepEqual(
    parseItemAccessibleName('Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min'),
    { kindToken: 'Graded App Item', title: 'Assignment: MATLAB Calculation', status: 'not-submitted', lockReason: null, durationText: '15 min' }
  );
});

test('parseItemAccessibleName returns null for empty/garbage input', () => {
  assert.equal(parseItemAccessibleName(''), null);
  assert.equal(parseItemAccessibleName(null), null);
  assert.equal(parseItemAccessibleName('JustOneToken'), null);
});

test('itemStatus maps a status string to the canonical vocabulary', () => {
  assert.equal(itemStatus('Reading, Syllabus, Completed, 10 min'), 'completed');
  assert.equal(itemStatus('Video, Scripts, Not submitted, 4 min'), 'not-submitted');
  assert.equal(itemStatus('Reading, X, Locked, Complete previous item to unlock, 10 min'), 'locked');
  assert.equal(itemStatus('Something with no recognizable status'), 'unknown');
});

test('itemStatus reads an element accessible-name (aria-label) when given a node', () => {
  const d = dom('<a aria-label="Video, Introduction, Completed, 12 min" href="/learn/matlab/lecture/v1/intro">Intro</a>');
  const a = d.querySelector('a');
  assert.equal(itemStatus(a), 'completed');
});

test('isExcludedNode excludes the extension sidebar host (#ccp-host-root) and its subtree', () => {
  const d = dom(
    '<div id="ccp-host-root"><div class="ccp-host">' +
      '<input name="ccp-behavior" type="radio">' +
      '<textarea placeholder="Paste or type text...">x</textarea>' +
    '</div></div>' +
    '<main><input type="radio" name="q1"></main>'
  );
  assert.equal(isExcludedNode(d.getElementById('ccp-host-root')), true);
  assert.equal(isExcludedNode(d.querySelector('input[name="ccp-behavior"]')), true);
  assert.equal(isExcludedNode(d.querySelector('textarea')), true);
  assert.equal(isExcludedNode(d.querySelector('main input[name="q1"]')), false);
});

test('isExcludedNode excludes a .ccp-host subtree even without the #ccp-host-root id (inlined shadow content)', () => {
  const d = dom('<div class="ccp-host"><button>Autopilot</button></div><main><button>Submit</button></main>');
  assert.equal(isExcludedNode(d.querySelector('.ccp-host button')), true);
  assert.equal(isExcludedNode(d.querySelector('main button')), false);
});

test('isExcludedNode excludes the Boost support chat composer and panel', () => {
  const d = dom(
    '<div id="boostai-chat-panel-composer">' +
      '<textarea placeholder="Ask your question here"></textarea>' +
      '<button>Send</button>' +
    '</div>' +
    '<div class="Boost-ChatPanel-foo"><button>X</button></div>' +
    '<button data-testid="coach-chat-launcher-button">Chat</button>' +
    '<main><button>Submit</button></main>'
  );
  assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer textarea')), true);
  assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer button')), true);
  assert.equal(isExcludedNode(d.querySelector('.Boost-ChatPanel-foo button')), true);
  assert.equal(isExcludedNode(d.querySelector('[data-testid="coach-chat-launcher-button"]')), true);
  assert.equal(isExcludedNode(d.querySelector('main button')), false);
});

test('isExcludedNode is safe on null and non-element input', () => {
  assert.equal(isExcludedNode(null), false);
  assert.equal(isExcludedNode(undefined), false);
});

test('assessmentRoot returns main when present and excludes nav/aside/extension/chat', () => {
  const d = dom(
    '<nav><a href="/learn/x/quiz/q1">Quiz</a></nav>' +
    '<div id="ccp-host-root"><input name="ccp-behavior" type="radio"></div>' +
    '<main id="real"><fieldset><input type="radio" name="q1"></fieldset></main>'
  );
  const r = assessmentRoot(d);
  assert.ok(r);
  assert.equal(r.id, 'real');
});

test('withinAssessment is true for a node inside the assessment root and false for excluded/nav nodes', () => {
  const d = dom(
    '<nav><button id="nav-btn">Nav</button></nav>' +
    '<div class="ccp-host"><button id="ext-btn">Ext</button></div>' +
    '<main><button id="ok-btn">Submit</button></main>'
  );
  assert.equal(withinAssessment(d.getElementById('ok-btn')), true);
  assert.equal(withinAssessment(d.getElementById('ext-btn')), false);
  assert.equal(withinAssessment(d.getElementById('nav-btn')), false);
});

// A small fixture that mirrors the captured outline shape: a role=navigation
// landmark containing role=region modules, each with a level-3 role=heading
// toggle button (clickable + expandable) and ul>li>div>a item links.
function outlineFixture() {
  return dom(
    '<nav role="navigation" aria-label="Course Material">' +
      '<div role="region" aria-label="Module 1 Course Pages">' +
        '<div role="heading" aria-level="3"><button aria-expanded="true">Module 1 Course Pages</button></div>' +
        '<ul><li><div>' +
          '<a role="link" href="/learn/matlab/lecture/cp1/course-preview" aria-label="Video, Course Preview, Completed, 2 min">Course Preview</a>' +
        '</div></li>' +
        '<li><div>' +
          '<a role="link" href="/learn/matlab/supplement/syl/syllabus" aria-label="Reading, Syllabus, Completed, 10 min">Syllabus</a>' +
        '</div></li></ul>' +
      '</div>' +
      '<div role="region" aria-label="Module 2 The MATLAB Environment">' +
        '<div role="heading" aria-level="3"><button aria-expanded="false">Module 2 The MATLAB Environment</button></div>' +
        '<ul><li><div>' +
          '<a role="link" href="/learn/matlab/lecture/intro/introduction" aria-label="Video, Introduction, Completed, 12 min">Introduction</a>' +
        '</div></li></ul>' +
      '</div>' +
    '</nav>'
  );
}

test('findOutlineNav returns the role=navigation outline landmark', () => {
  const d = outlineFixture();
  const navEl = findOutlineNav(d);
  assert.ok(navEl);
  assert.equal(navEl.getAttribute('role'), 'navigation');
});

test('findModuleRegions returns one entry per role=region module with title/headingToggle/expanded', () => {
  const d = outlineFixture();
  const regions = findModuleRegions(d);
  assert.equal(regions.length, 2);
  assert.equal(regions[0].title, 'Module 1 Course Pages');
  assert.equal(regions[0].expanded, true);
  assert.ok(regions[0].headingToggle);
  assert.equal(regions[0].headingToggle.tagName.toUpperCase(), 'BUTTON');
  assert.equal(regions[1].title, 'Module 2 The MATLAB Environment');
  assert.equal(regions[1].expanded, false);
});

test('findItemLinks returns the ul>li>div>a item anchors of a region', () => {
  const d = outlineFixture();
  const regions = findModuleRegions(d);
  const links = findItemLinks(regions[0].region);
  assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute('href'), '/learn/matlab/lecture/cp1/course-preview');
  assert.equal(links[1].getAttribute('href'), '/learn/matlab/supplement/syl/syllabus');
});

test('findItemLinks over the whole document collects all /learn/ anchors and skips excluded ones', () => {
  const d = dom(
    '<div id="ccp-host-root"><a href="/learn/matlab/lecture/x/sidebar-link">x</a></div>' +
    '<main><a href="/learn/matlab/lecture/v1/intro">Intro</a><a href="/learn/matlab/quiz/q1">Quiz</a></main>'
  );
  const links = findItemLinks(d);
  const hrefs = links.map(function (a) { return a.getAttribute('href'); });
  assert.deepEqual(hrefs, ['/learn/matlab/lecture/v1/intro', '/learn/matlab/quiz/q1']);
});

test('findNextItemButton finds a role=button "Go to next item" (locale-tolerant substring)', () => {
  const d = dom(
    '<main>' +
      '<button>Mark as completed</button>' +
      '<div role="button">Go to next item</div>' +
    '</main>'
  );
  const btn = findNextItemButton(d);
  assert.ok(btn);
  assert.equal(btn.getAttribute('role'), 'button');
});

test('findNextItemButton matches an aria-label and ignores excluded chat buttons', () => {
  const d = dom(
    '<div id="boostai-chat-panel-composer"><button aria-label="Next item">Send</button></div>' +
    '<main><button aria-label="Go to next item">→</button></main>'
  );
  const btn = findNextItemButton(d);
  assert.ok(btn);
  assert.equal(btn.getAttribute('aria-label'), 'Go to next item');
});

test('findNextItemButton returns null when there is no next-item control', () => {
  const d = dom('<main><button>Mark as completed</button></main>');
  assert.equal(findNextItemButton(d), null);
});

test('isExternalLaunchPage is true for a gradedLti URL', () => {
  const d = dom('<main><p>Some content</p></main>');
  assert.equal(
    isExternalLaunchPage(d, 'https://www.coursera.org/learn/matlab/gradedLti/0OaH5/assignment-echo-generator'),
    true
  );
});

test('isExternalLaunchPage is true when a role=form "Launch App" is present (regardless of URL)', () => {
  const d = dom(
    '<main>' +
      '<input type="checkbox" id="agreement-checkbox-base">' +
      '<form role="form" aria-label="Launch App" action="https://learningtool.mathworks.com/lti/oidc" method="post">' +
        '<button>Launch app. Opens in new window</button>' +
      '</form>' +
    '</main>'
  );
  assert.equal(isExternalLaunchPage(d, 'https://www.coursera.org/learn/matlab/lecture/v1/intro'), true);
});

test('isExternalLaunchPage is false for an in-page answerable assessment with no launch form', () => {
  const d = dom('<main><fieldset><input type="radio" name="q1"><input type="radio" name="q1"></fieldset></main>');
  assert.equal(isExternalLaunchPage(d, 'https://www.coursera.org/learn/matlab/quiz/q1/check'), false);
});

test('GROUND TRUTH (extraction): the gradedLti launch page is recognized despite heuristicPageType="dashboard"', () => {
  // Derived from dom-extraction-ex_mpqxgj5l_aneblp.json:
  // source.url=/learn/matlab/gradedLti/0OaH5/assignment-echo-generator,
  // form F1 role=form accessibleName="Launch App" action=mathworks/lti/oidc,
  // heuristicPageType={type:"dashboard",confidence:"low"} (must NOT be relied on).
  const url = 'https://www.coursera.org/learn/matlab/gradedLti/0OaH5/assignment-echo-generator';
  const d = dom(
    '<main>' +
      '<h1>Assignment: Echo Generator</h1>' +
      '<input type="checkbox" id="agreement-checkbox-base">' +
      '<form role="form" aria-label="Launch App" action="https://learningtool.mathworks.com/lti/oidc" method="post">' +
        '<button>Launch app. Opens in new window</button>' +
      '</form>' +
    '</main>',
    url
  );
  assert.equal(isExternalLaunchPage(d, url), true);
  // And the URL classifies as gradedLti, not 'other'.
  assert.equal(classifyKind(url), 'gradedLti');
});

test('GROUND TRUTH (extraction): the ungradedWidget item parses, classifies as plugin, and keeps its id', () => {
  // Derived from accessibleName "Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min"
  // and href /learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments.
  const href = '/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments';
  const name = 'Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min';
  assert.deepEqual(parseLearnUrl(href), {
    courseSlug: 'matlab', kind: 'ungradedWidget', id: '8h1hv', itemSlug: 'completing-matlab-programming-assignments',
  });
  assert.equal(classifyKind(href, name), 'plugin');
  assert.equal(itemStatus(name), 'not-submitted');
  const parsed = parseItemAccessibleName(name);
  assert.equal(parsed.title, 'Completing MATLAB Programming Assignments');
  assert.equal(parsed.durationText, '15 min');
});

test('GROUND TRUTH (extraction): contamination nodes are excluded while real outline links are kept', () => {
  // The page DOM carries the extension sidebar (#ccp-host-root, name=ccp-behavior,
  // "Paste or type text..." textarea) and the Boost chat ("Ask your question here",
  // "Send", #boostai-chat-panel-composer). These must be hard-excluded.
  const d = dom(
    '<div id="ccp-host-root"><div class="ccp-host">' +
      '<input name="ccp-behavior" type="radio">' +
      '<textarea placeholder="Paste or type text..."></textarea>' +
    '</div></div>' +
    '<div id="boostai-chat-panel-composer"><textarea placeholder="Ask your question here"></textarea><button>Send</button></div>' +
    '<nav role="navigation" aria-label="Course Material">' +
      '<div role="region" aria-label="Module 1 Course Pages">' +
        '<ul><li><div><a role="link" href="/learn/matlab/lecture/cp1/course-preview" aria-label="Video, Course Preview, Completed, 2 min">Course Preview</a></div></li></ul>' +
      '</div>' +
    '</nav>'
  );
  assert.equal(isExcludedNode(d.querySelector('input[name="ccp-behavior"]')), true);
  assert.equal(isExcludedNode(d.querySelector('#ccp-host-root textarea')), true);
  assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer textarea')), true);
  assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer button')), true);
  const links = findItemLinks(d);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '/learn/matlab/lecture/cp1/course-preview');
});

test('parseItemAccessibleName matches the status as a WHOLE token, not a status word inside the title', () => {
  // Regression (code-quality review): a title token that merely CONTAINS a status
  // word ("Completed solutions", "Locked Room Mystery") must not be taken as the
  // status — the status occupies its own comma-token in the grammar.
  assert.deepEqual(
    parseItemAccessibleName('Reading, Completed solutions, Not submitted, 5 min'),
    { kindToken: 'Reading', title: 'Completed solutions', status: 'not-submitted', lockReason: null, durationText: '5 min' }
  );
  assert.deepEqual(
    parseItemAccessibleName('Video, Locked Room Mystery, Completed, 8 min'),
    { kindToken: 'Video', title: 'Locked Room Mystery', status: 'completed', lockReason: null, durationText: '8 min' }
  );
});

const fs = require('node:fs');
const path = require('node:path');

test('manifest loads coursera-dom.js before its content-script consumers', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const js = manifest.content_scripts[0].js;
  const idx = function (name) { return js.indexOf(name); };
  assert.ok(idx('lib/coursera-dom.js') !== -1, 'coursera-dom.js must be in the content-script js list');
  const consumers = [
    'lib/answer-matcher.js',
    'lib/module-scraper.js',
    'lib/page-fallback.js',
    'lib/completion-confirmer.js',
    'lib/module-autopilot.js',
    'lib/question-detector.js',
    'lib/ai-question-context.js',
  ];
  consumers.forEach(function (c) {
    assert.ok(idx(c) !== -1, c + ' must be present');
    assert.ok(idx('lib/coursera-dom.js') < idx(c), 'coursera-dom.js must load before ' + c);
  });
});
