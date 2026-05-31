const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors the bridge content.js builds: wrap the ccp.ai.request 'generateAnswers'
// messenger as aiGenerate(snapshot) -> Promise<{ok, raw}>.
function makeAiGenerate(messenger) {
  return function (snapshot) {
    return new Promise(function (resolve) {
      messenger.send('generateAnswers', { snapshot: snapshot }, function (res) {
        resolve(res && res.ok ? { ok: true, raw: res.raw } : { ok: false, reason: (res && res.reason) || 'no-response' });
      });
    });
  };
}

test('aiGenerate bridge: forwards snapshot via generateAnswers and normalizes to {ok, raw}', async () => {
  const seen = [];
  const messenger = { send: function (command, params, cb) { seen.push({ command: command, params: params }); cb({ ok: true, raw: '{"answers":[]}' }); } };
  const aiGenerate = makeAiGenerate(messenger);
  const out = await aiGenerate({ token: 't', questions: [] });
  assert.equal(seen[0].command, 'generateAnswers');
  assert.deepEqual(seen[0].params.snapshot, { token: 't', questions: [] });
  assert.deepEqual(out, { ok: true, raw: '{"answers":[]}' });
});

test('aiGenerate bridge: a failed response normalizes to ok:false', async () => {
  const messenger = { send: function (command, params, cb) { cb({ ok: false, reason: 'no-key' }); } };
  const out = await makeAiGenerate(messenger)({ token: 't', questions: [] });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-key');
});
