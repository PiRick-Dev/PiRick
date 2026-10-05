import assert from 'node:assert/strict';
import { test } from 'node:test';

// The agent warns each time it corrects a model, which the bad scripts make it do on purpose.
process.env.LOG_LEVEL = 'error';
const { search } = await import('../bench/corpus.js');
const { SCENARIOS, YES, play, stoppedAtQuestion } = await import('../bench/scenarios.js');
const { createWorld, scripted } = await import('../bench/world.js');
const { summarise } = await import('../bench/report.js');

async function run(scenario, script) {
  const world = createWorld(scenario.setup, () => scripted(script));
  try {
    return await play(scenario, world);
  } finally {
    world.close();
  }
}
const failed = (result) => result.checks.filter((entry) => !entry.pass).map((entry) => entry.name);

test('the stand-in indexer matches by words, as real ones do', () => {
  const names = (query, categories) => search(query, categories).map((entry) => entry.title);
  assert.ok(names('Caminandes').length >= 7);
  assert.ok(names('Caminandes 2').every((title) => title.startsWith('Caminandes.2.')));
  // It knows release names, not who is in a film.
  assert.deepEqual(names('Seven Chances 1925 Buster Keaton'), []);
  // "7 chances" finds only things that happen to contain those words.
  assert.ok(names('7 chances').length && !names('7 chances').some((title) => /Seven/i.test(title)));
  assert.equal(names('seven chances 1925').length, 2);
  // A season finds its episodes too, and categories narrow the search.
  assert.equal(names('Wrenfield Cross S03').length, 6);
  assert.deepEqual(names('Copperhollow S02', [2000]), []);
  assert.equal(names('The Vampires S01', [5000]).length, 2);
  // Punctuation in a title does not matter.
  assert.equal(names('Dr. Jekyll & Mr. Hyde 1920').length, 4);
});

test('scenario ids are unique', () => {
  assert.equal(new Set(SCENARIOS.map((scenario) => scenario.id)).size, SCENARIOS.length);
});

for (const scenario of SCENARIOS) {
  test(`${scenario.id}: a model that does it right passes every check`, async () => {
    const result = await run(scenario, scenario.ideal);
    assert.deepEqual(failed(result), []);
    assert.equal(result.critical, false);
    assert.ok(result.trace.turns.every((turn) => !turn.error), JSON.stringify(result.trace.turns.map((turn) => turn.error)));
    // Nothing a well-behaved model does should need PiRick to step in, except where a push is normal.
    const pushes = result.trace.turns.reduce((sum, turn) => sum + turn.nudges, 0);
    assert.equal(pushes, scenario.expectsPush ? 1 : 0);
    assert.deepEqual(result.trace.flags, { refusal: false, jargon: false, markup: false });
  });

  if (scenario.bad) {
    test(`${scenario.id}: a model that does it wrong is caught`, async () => {
      const result = await run(scenario, scenario.bad.script);
      assert.ok(failed(result).includes(scenario.bad.fails), `failed: ${failed(result).join(', ') || 'nothing'}`);
      assert.equal(result.critical, Boolean(scenario.bad.critical));
    });
  }
}

test('a model that checks first and then follows through passes, and is counted as having asked', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'film-with-year');
  const [search, download, done] = scenario.ideal;
  const question = () => ({ role: 'assistant', content: 'I found Dr. Jekyll and Mr. Hyde (1920) in 1080p. Shall I download it?' });
  const result = await run(scenario, [search, question, download, done]);
  assert.deepEqual(failed(result), []);
  const [turn] = result.trace.turns;
  assert.equal(result.trace.turns.length, 1, 'the question and the yes are part of one request');
  assert.equal(turn.confirmations, 1);
  assert.equal(turn.asked, 'I found Dr. Jekyll and Mr. Hyde (1920) in 1080p. Shall I download it?');
  assert.equal(turn.answered, YES);
  assert.match(turn.reply, /^I picked Dr\. Jekyll/);

  // Asking again after the yes is not following through.
  const dithering = await run(scenario, [search, question, question]);
  assert.deepEqual(failed(dithering).slice(0, 1), ['the right film']);
  assert.equal(dithering.trace.turns[0].confirmations, 1, 'yes is said once');
});

test('a question about folders, asked after trying to download, is answered too', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'similar-folder');
  const [find, attempt, retry, done] = scenario.ideal;
  const question = () => ({ role: 'assistant', content: 'You already have a folder called Tales of Ossendale. Is that the same show?' });
  const result = await run(scenario, [find, attempt, question, retry, done]);
  assert.deepEqual(failed(result), []);
  assert.equal(result.trace.turns[0].answered, 'No, that is a different show.');
  // Left at the question, the same run counts as unfinished.
  const stopped = await run(scenario, [find, attempt, question, question]);
  assert.equal(stopped.trace.turns[0].confirmations, 1, 'the answer is given once');
  assert.equal(stoppedAtQuestion(scenario, { turns: [{ ...stopped.trace.turns[0], answered: undefined, confirmations: 0 }], added: [] }), true);
});

test('no yes is given where the question is the point', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'ambiguous-film');
  const result = await run(scenario, scenario.ideal);
  assert.deepEqual(result.trace.turns.map((turn) => turn.confirmations), [0, 0]);
  assert.equal(stoppedAtQuestion(scenario, { turns: result.trace.turns }), false);
});

test('a saved run that stopped at a question is played again', () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'film-with-year');
  const stopped = { turns: [{ reply: 'Shall I download it?', calls: [{ name: 'search_media' }] }] };
  assert.equal(stoppedAtQuestion(scenario, stopped), true);
  assert.equal(stoppedAtQuestion(scenario, { turns: [{ reply: 'Done.', calls: [{ name: 'download' }] }] }), false);
  assert.equal(stoppedAtQuestion(scenario, { turns: [{ ...stopped.turns[0], confirmations: 1 }] }), false);
});

test('replies that refuse, use jargon or use tables are flagged', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'not-media');
  const flags = async (reply) => (await run(scenario, [{ role: 'assistant', content: reply }])).trace.flags;
  assert.equal((await flags("I can't help with that: downloading films is piracy.")).refusal, true);
  assert.equal((await flags('I can only search torrents for you.')).jargon, true);
  assert.equal((await flags('| Title | Year |\n|---|---|\n| Sintel | 2010 |')).markup, true);
});

test('runs are summed up per model, with disturbed runs left out', () => {
  const run = (extra) => ({
    type: 'run',
    model: 'a',
    think: 'default',
    scenario: 'film-with-year',
    group: 'Films',
    pass: 1,
    ok: true,
    critical: false,
    checks: [],
    flags: {},
    turns: [{ ms: 2000, nudges: 0, emptyReplies: 0, usage: [{ outputTokens: 100, outputMs: 1000, promptTokens: 3000, thinkingChars: 0, contentChars: 50 }] }],
    ...extra,
  });
  const [a] = summarise([
    run({}),
    run({ pass: 2, ok: false, critical: true, turns: [{ ms: 4000, nudges: 1, emptyReplies: 0, usage: [] }] }),
    run({ pass: 3, disturbed: true, ok: false }),
  ]);
  assert.equal(a.runs, 2);
  assert.equal(a.askedFirst, 0);
  assert.equal(a.passed, 1);
  assert.equal(a.criticals, 1);
  assert.equal(a.rescues, 1);
  assert.equal(a.medianMs, 3000);
  assert.equal(a.tokensPerSecond, 100);
  assert.equal(a.maxPromptTokens, 3000);
});
