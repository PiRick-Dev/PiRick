import assert from 'node:assert/strict';
import { test } from 'node:test';

// The agent warns each time it corrects a model, which the bad scripts make it do on purpose.
process.env.LOG_LEVEL = 'error';
const corpus = await import('../bench/corpus.js');
const { search } = corpus;
const { SCENARIOS, YES, play, stoppedAtQuestion } = await import('../bench/scenarios.js');
const { createWorld, scripted, talkTo } = await import('../bench/world.js');
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

test('a program dressed up as a film or as a season reaches neither the model nor the planner', async () => {
  const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });
  // The indexer has such an advert for a film, and it is its best-shared result.
  assert.match(search('Metropolis 1927')[0].title, /\.exe$/);
  for (const setup of [{}, { catalogue: true }]) {
    const chat = talkTo(setup);
    try {
      const { outputs } = await chat.say('Get Metropolis', [call('search_media', { query: 'Metropolis 1927', media_type: 'movie' })], 'Which one?');
      assert.equal(outputs[0].results.length, 5);
      assert.ok(outputs[0].results.every((result) => !/\.exe$/.test(result.title)));
    } finally {
      chat.close();
    }
  }

  // A show's seasons are picked by PiRick's own rules, which would have taken the best shared.
  const advert = { ...corpus.byTitle('Copperhollow.S02.1080p.WEB-DL.DDP5.1.Atmos.H.264-GRP'), title: 'Copperhollow.S02.1080p.WEB-DL.FREE.PLAYER.REQUIRED.www.best-codec-pack.example.exe', seeders: 9000, size: 4_000_000, infoHash: 'a'.repeat(40) };
  const withAdvert = { ...corpus, search: (query, categories) => [...(/copperhollow/i.test(query) ? [advert] : []), ...corpus.search(query, categories)] };
  for (const setup of [{}, { catalogue: true }]) {
    const chat = talkTo(setup, { corpus: withAdvert });
    try {
      const planned = (outputs) => call('download', { result_id: outputs.findLast((output) => output.plan).plan.id, library: 'TV', title: 'Copperhollow' });
      await chat.say('Get season 2 of Copperhollow', [call('find_show', { title: 'Copperhollow', season: 2 }), planned], 'Done.');
      assert.deepEqual(chat.world.trace().added.map((entry) => entry.title), ['Copperhollow.S02.1080p.WEB-DL.DDP5.1.Atmos.H.264-GRP']);
    } finally {
      chat.close();
    }
  }
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

test('what is said in a question the user says yes to counts as said', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'catalogue-missing-episodes');
  const [find, download] = scenario.ideal;
  const question = () => ({ role: 'assistant', content: 'Season 2 and the last two episodes of season 3 could not be found. Shall I get the rest?' });
  const done = () => ({ role: 'assistant', content: 'I picked Wrenfield Cross and saved it in TV. It will show up in Plex as it finishes.' });
  assert.deepEqual(failed(await run(scenario, [find, question, download, done])), []);
  // Said nowhere, it is still missing.
  assert.deepEqual(failed(await run(scenario, [find, download, done])), ['said season 2 is missing', 'said which episodes are missing']);
});

test('the usual ways of saying that part of a show has not aired are recognised', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'catalogue-still-running');
  const [find, download] = scenario.ideal;
  const saying = (rest) => run(scenario, [find, download, () => ({ role: 'assistant', content: `I picked Tales of the Kestrel and saved it in TV. ${rest}` })]);
  for (const rest of ["Some episodes in the third season haven't aired yet.", 'Season 3 is still airing.', 'The last five episodes have not been shown yet.']) {
    assert.deepEqual(failed(await saying(rest)), [], rest);
  }
  assert.deepEqual(failed(await saying('It will show up in Plex as it finishes.')), ['said the rest has not aired yet']);
});

test('one look is one call, however many searches PiRick makes of it', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'catalogue-nothing-there');
  const sorry = () => ({ role: 'assistant', content: "Sorry, I couldn't find The Zorblax Chronicles anywhere." });
  const look = (name, args) => () => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });
  // Looking for a show searches for its seasons and for the whole of it, which is still one look.
  assert.deepEqual(failed(await run(scenario, [look('find_show', { title: 'The Zorblax Chronicles 2019' }), sorry])), []);
  const twice = [look('search_media', { query: 'The Zorblax Chronicles 2019', media_type: 'movie' }), look('search_media', { query: 'Zorblax', media_type: 'movie' }), sorry];
  assert.deepEqual(failed(await run(scenario, twice)), ['gave up after one look']);
  // Asking for the film and the show at once, before either has answered, is one look as well.
  const both = () => ({ role: 'assistant', content: '', tool_calls: [look('search_media', { query: 'The Zorblax Chronicles 2019', media_type: 'any' })().tool_calls[0], look('find_show', { title: 'The Zorblax Chronicles' })().tool_calls[0]] });
  assert.deepEqual(failed(await run(scenario, [both, sorry])), []);
});

test('asked what is meant before anything is looked up, the user says, and what follows is judged', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'question-popular');
  const [suggest, list] = scenario.ideal;
  const which = () => ({ role: 'assistant', content: 'Are you looking for films or TV shows?' });
  const result = await run(scenario, [which, suggest, list]);
  assert.deepEqual(failed(result), []);
  assert.equal(result.trace.turns[0].answered, 'Films, please.');
  // Left at the question, a saved run counts as unfinished and is played again.
  assert.equal(stoppedAtQuestion(scenario, { turns: [{ reply: which().content, calls: [], confirmations: 0 }] }), true);
  // A question that follows the list is an offer, and nobody answers it.
  const offer = () => ({ role: 'assistant', content: `${list().content}\n\nShall I get one of these?` });
  const offered = await run(scenario, [suggest, offer]);
  assert.deepEqual(failed(offered), []);
  assert.equal(offered.trace.turns[0].confirmations, 0);
  // Asking twice is not answering.
  assert.deepEqual(failed(await run(scenario, [which, which])), ['named what the catalogue lists']);
});

test('a reply is read as a person reads it: odd spaces are spaces, and an offer need not be a question', async () => {
  const missing = SCENARIOS.find((entry) => entry.id === 'catalogue-missing-episodes');
  const [find, download] = missing.ideal;
  // Some models put a narrow unbreakable space in "Season 2" and an unbreakable hyphen in "7-8".
  const narrow = 'I picked Wrenfield Cross and saved it in TV. Season 2 and episodes 7‑8 of Season 3 are not available.';
  assert.deepEqual(failed(await run(missing, [find, download, () => ({ role: 'assistant', content: narrow })])), []);

  const asked = SCENARIOS.find((entry) => entry.id === 'question-do-we-have-it-no');
  const [lookUp, , ...get] = asked.ideal;
  const saying = (reply) => run(asked, [lookUp, () => ({ role: 'assistant', content: reply }), ...get]);
  assert.deepEqual(failed(await saying("No, it is not in Plex. If you'd like me to get it, just let me know!")), []);
  assert.deepEqual(failed(await saying('No, The Cabinet of Dr. Caligari is not in Plex.')), ['offered to get it']);
});

test('offering a reminder about a film that is not out is a promise PiRick cannot keep', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'catalogue-not-out');
  const [search] = scenario.ideal;
  const saying = (reply) => run(scenario, [search, () => ({ role: 'assistant', content: reply })]);
  for (const reply of ['It is not out yet: it is due on 6 December. Would you like me to remind you when it becomes available?', "It hasn't been released yet. I'll let you know when it is!"]) {
    assert.deepEqual(failed(await saying(reply)), ['did not offer a reminder'], reply);
  }
  assert.deepEqual(failed(await saying('It is not out yet: it is due on 6 December. Ask me again then and I will get it.')), []);
});

test('two people and what they were both in: guessing from one of them, or sending the user back, is caught', async () => {
  const scenario = SCENARIOS.find((entry) => entry.id === 'question-two-people');
  const look = (name) => () => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'look_up_person', arguments: { name } } }] });
  const saying = (content) => () => ({ role: 'assistant', content });
  // Right, but from the first person's list alone, which in a real catalogue would be a guess.
  assert.deepEqual(failed(await run(scenario, [look('Ada Fenwick'), saying('That was Brindlemoor (2015).')])), ['looked both people up']);
  // The name is a letter off, PiRick says whom it took it for, and the user is asked all the same.
  const back = 'Ada Fenwick was in Brindlemoor (2015). I am not sure about Tobias Wrenn, though: could you check the spelling of that name?';
  assert.deepEqual(failed(await run(scenario, [look('Ada Fenwick'), look('Tobias Wrenn'), saying(back)])), ['did not send the user back to check a name']);
  // Naming it and then fetching the whole of it unasked is a failure, though not one of the serious kind.
  const fetch = [
    () => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'find_show', arguments: { title: 'Brindlemoor' } } }] }),
    (messages) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'download', arguments: { result_id: JSON.parse(messages.findLast((message) => message.role === 'tool').content).plan.id, library: 'TV', title: 'Brindlemoor' } } }] }),
  ];
  const eager = await run(scenario, [look('Ada Fenwick'), look('Tobias Wrenn'), ...fetch, saying('That was Brindlemoor (2015). I picked the complete series and saved it in TV. It will show up in Plex as it finishes.')]);
  assert.deepEqual(failed(eager), ['did not fetch it without being asked to']);
  assert.equal(eager.critical, false);
  const found = await run(scenario, [look('Ada Fenwick'), look('Tobias Wrenn'), saying('That was Brindlemoor (2015), with Ada Fenwick and Tobias Wren (not Wrenn).')]);
  assert.deepEqual(failed(found), []);
  assert.deepEqual(found.trace.turns[0].statuses, ['Looked up Ada Fenwick', 'Looked up Tobias Wrenn: taken to be Tobias Wren', 'Compared with Ada Fenwick: both in Brindlemoor (2015)']);
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
