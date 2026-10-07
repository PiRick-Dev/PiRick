// What a request for a show does when PiRick has a catalogue to go by: the real
// tools and agent, a scripted model, and stand-ins for every service.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.LOG_LEVEL = 'error';

const { sayDate } = await import('../src/catalogue.js');
const { guideOf, heldAgainst, numbered, showLine } = await import('../src/lookups.js');
const { buildPlan, lastAired, matchShow, parseRelease, planShow } = await import('../src/releases.js');
const { talkTo } = await import('../bench/world.js');

const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });
const show = (args) => call('find_show', args);
const planId = (outputs) => outputs.findLast((output) => output.plan).plan.id;
const get = (library, title) => (outputs) => call('download', { result_id: planId(outputs), library, title });
const pirick = (setup = {}) => talkTo({ catalogue: true, ...setup });
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const titles = (chat) => chat.world.trace().added.map((entry) => entry.title);

// ---- Putting it into words -------------------------------------------------------

test('a show in one line, with what tells it from its namesakes', () => {
  const seasons = [{ number: 1 }, { number: 2 }];
  assert.equal(showLine({ title: 'Kestrelmere', year: 2005, countries: ['US'], seasons, status: 'ended' }), 'Kestrelmere (2005, United States, 2 seasons)');
  assert.equal(showLine({ title: 'Copperhollow', year: 2024, countries: ['US'], seasons: [seasons[0]], status: 'running' }), 'Copperhollow (2024, United States, 1 season, still running)');
  assert.equal(showLine({ title: 'Starfall Courier', year: 2021, countries: ['JP'], seasons, anime: true }), 'Starfall Courier (2021, Japan, 2 seasons, anime)');
  assert.equal(showLine({ title: 'Untitled', countries: [], seasons: [] }), 'Untitled');
  // What it is about is added on request, cut to a sentence.
  const about = `A sheriff comes home. ${'And then a great deal more happens to everyone in the town. '.repeat(5)}`;
  assert.equal(showLine({ title: 'Copperhollow', year: 2024, countries: [], seasons: [], about }, { about: true }), 'Copperhollow (2024): A sheriff comes home.');
  assert.equal(showLine({ title: 'Copperhollow', year: 2024, countries: [], seasons: [], about }), 'Copperhollow (2024)');
});

test('numbers are put briefly, and what Plex has is measured against the guide', () => {
  assert.equal(numbered([7, 8]), '7 and 8');
  assert.equal(numbered([5, 6, 7, 8, 9, 10]), '5 to 10');
  assert.equal(numbered([9, 1, 3, 5, 6, 7]), '1, 3, 5 to 7 and 9');
  assert.equal(numbered([4]), '4');

  const guide = new Map([[1, { aired: 10 }], [2, { aired: 10 }], [3, { aired: 4 }]]);
  const all = (count) => new Set(Array.from({ length: count }, (unused, i) => i + 1));
  assert.equal(heldAgainst(new Map([[1, all(10)]]), guide), 'all of season 1');
  assert.equal(heldAgainst(new Map([[1, all(10)], [2, all(10)], [3, all(3)]]), guide), 'all of seasons 1 and 2 and 3 of the 4 episodes of season 3');
  assert.equal(heldAgainst(new Map([[2, all(8)]]), guide), '8 of the 10 episodes of season 2');
  // A season the guide does not know is only counted.
  assert.equal(heldAgainst(new Map([[7, all(2)]]), guide), '2 episodes of season 7');
});

test('an episode guide is only gone by where release numbering can be trusted to follow it', () => {
  const seasons = [{ number: 1, episodes: 10, aired: 10 }, { number: 2, episodes: 10, aired: 4 }];
  const guide = guideOf({ seasons });
  assert.deepEqual([...guide.keys()], [1, 2]);
  assert.equal(lastAired(guide), 2);
  assert.equal(lastAired(guideOf({ seasons: [{ number: 1, episodes: 8, aired: 8 }, { number: 2, episodes: 8, aired: 0 }] })), 1);
  // Anime is numbered every which way, and some shows number their seasons by year.
  assert.equal(guideOf({ seasons, anime: true }), null);
  assert.equal(guideOf({ seasons: [{ number: 2019, episodes: 200, aired: 200 }] }), null);
  assert.equal(guideOf({ seasons: [] }), null);
  assert.equal(guideOf(null), null);
});

// ---- The planner with a guide ----------------------------------------------------

const release = (title, seeders = 50) => ({ title, seeders, size: 1e9, infoHash: title, parsed: parseRelease(title) });
const guide = (seasons) => new Map(Object.entries(seasons).map(([number, [episodes, aired = episodes]]) => [Number(number), { number: Number(number), episodes, aired }]));

test('with a guide, a plan covers every season that has aired and says which episodes nobody has', () => {
  const found = [release('Show.S01.1080p.WEB-GRP'), ...[1, 2, 3, 4, 5, 6].map((number) => release(`Show.S03E0${number}.1080p.WEB-GRP`)), release('Show.S04.1080p.WEB-GRP')];
  // Without one, only the seasons some release names are known of, and a short season looks whole.
  const blind = buildPlan(found);
  assert.deepEqual(blind.missing, [2]);
  assert.equal(blind.gaps, undefined);
  // Five seasons have aired, and season 3 has eight episodes.
  const plan = buildPlan(found, { guide: guide({ 1: [8], 2: [8], 3: [8], 4: [8], 5: [8], 6: [8, 0] }) });
  assert.deepEqual(plan.parts.map((part) => [part.type, part.seasons[0], part.releases.length]), [['season', 1, 1], ['episodes', 3, 6], ['season', 4, 1]]);
  assert.deepEqual(plan.missing, [2, 5]);
  assert.deepEqual(plan.gaps, [{ season: 3, episodes: [7, 8] }]);
  // One episode asked for is not a season with holes in it.
  assert.equal(buildPlan(found, { season: 3, episode: 2, guide: guide({ 3: [8] }) }).gaps, undefined);
});

test('a season still being shown is fetched episode by episode, and a pack is not taken for the whole of it', () => {
  const found = [release('Show.S01.1080p.WEB-GRP', 300), release('Show.S02.1080p.WEB-GRP', 500), ...[1, 2, 3].map((number) => release(`Show.S02E0${number}.1080p.WEB-GRP`, 40))];
  // Without a guide the well-shared pack wins.
  assert.deepEqual(buildPlan(found, { season: 2 }).parts.map((part) => part.type), ['season']);
  const airing = guide({ 1: [8], 2: [8, 3] });
  const plan = buildPlan(found, { season: 2, guide: airing });
  assert.deepEqual(plan.parts.map((part) => [part.type, part.releases.length]), [['episodes', 3]]);
  assert.equal(plan.gaps, undefined);
  // With no single episodes to be had, the pack is better than nothing.
  assert.deepEqual(buildPlan(found.slice(0, 2), { season: 2, guide: airing }).parts.map((part) => part.type), ['season']);
  // A range of seasons is the whole show only if it reaches the last one that has aired.
  const range = [release('Show.S01-S05.1080p.BluRay-GRP', 200), release('Show.S06.1080p.WEB-GRP', 100)];
  assert.deepEqual(buildPlan(range, { guide: guide({ 1: [8], 2: [8], 3: [8], 4: [8], 5: [8], 6: [8] }) }).parts.map((part) => part.type), ['seasons', 'season']);
  assert.deepEqual(buildPlan([range[0]], { guide: guide({ 1: [8], 2: [8], 3: [8], 4: [8], 5: [8] }) }).parts.map((part) => part.type), ['series']);
});

test('releases count as the show under any of the names it is known to go by', async () => {
  const releases = [release('The.Vampires.1915.S01.1080p.BluRay-GRP'), release('Kestrelmere.US.S01.1080p.BluRay-GRP'), release('Kestrelmere.UK.S01.720p.BluRay-GRP')];
  assert.deepEqual(matchShow({ key: 'les vampires', year: null }, releases), { releases: [] });
  assert.deepEqual(matchShow({ key: 'les vampires', keys: ['les vampires', 'the vampires'], year: null }, releases).releases.map((entry) => entry.title), ['The.Vampires.1915.S01.1080p.BluRay-GRP']);
  // A show told from its namesake by country takes the releases that carry its country.
  assert.deepEqual(matchShow({ key: 'kestrelmere', keys: ['kestrelmere', 'kestrelmere us'], year: 2005 }, releases).releases.map((entry) => entry.title), ['Kestrelmere.US.S01.1080p.BluRay-GRP']);

  // The planner is told the names, the year and the guide, and looks at every season that has aired.
  const asked = [];
  const search = async (query) => {
    asked.push(query);
    return releases.filter((entry) => entry.title.toLowerCase().includes('kestrelmere'));
  };
  const planned = await planShow(search, { title: 'Kestrelmere', names: ['Kestrelmere US'], year: 2005, guide: guide({ 1: [6], 2: [22] }) });
  assert.deepEqual(planned.plan.parts.map((part) => part.releases[0].title), ['Kestrelmere.US.S01.1080p.BluRay-GRP']);
  assert.deepEqual(planned.plan.missing, [2]);
  assert.ok(asked.includes('Kestrelmere S02'), `searched for: ${asked.join(', ')}`);
});

// ---- Asking for shows ------------------------------------------------------------

test('a show is looked for under its proper name, with its guide to go by', async () => {
  const chat = pirick();
  try {
    const whole = await chat.say('Get all of Brindlemoor', [show({ title: 'brindlemoor' }), get('TV', 'brindlemoor')], 'Done. Anything else?');
    assert.equal(whole.outputs[0].catalogue, 'This is Brindlemoor (2015, United Kingdom, 5 seasons).');
    assert.equal(whole.outputs[0].plan.show, 'Brindlemoor');
    assert.deepEqual(whole.outputs[0].plan.gets.map((part) => part.what), ['Complete series']);
    assert.deepEqual(titles(chat), ['Brindlemoor.The.Complete.Series.S01-S05.1080p.BluRay.x265-GRP']);
    // The folder is named by the catalogue, whatever the model typed.
    assert.equal(chat.world.trace().added[0].savePath, '/media/TV/Brindlemoor');

    // Misspelt, which is said.
    const misspelt = await chat.say('And Brindelmoor season 2?', [show({ title: 'Brindelmoor', season: 2 })], 'Shall I get it?');
    assert.equal(misspelt.outputs[0].catalogue, 'Nothing is called “Brindelmoor”. The nearest is Brindlemoor (2015, United Kingdom, 5 seasons), and that is what was looked for.');
    assert.equal(misspelt.record.statuses[0], 'Took “Brindelmoor” to be Brindlemoor (2015)');
    assert.match(misspelt.record.statuses[1], /^Found season 2 of “Brindlemoor”: /);
  } finally {
    chat.close();
  }
});

test('what could not be found is told apart from what does not exist or has not aired', async () => {
  const chat = pirick();
  try {
    // Season 2 is nowhere, and of season 3 only six of the eight episodes are.
    const holes = await chat.say('Get all of Wrenfield Cross', [show({ title: 'Wrenfield Cross' })], 'Shall I get what there is?');
    assert.deepEqual(holes.outputs[0].plan.gets.map((part) => part.what), ['Season 1', 'Season 3: 6 single episodes', 'Season 4']);
    assert.deepEqual(holes.outputs[0].plan.seasons_not_found, [2]);
    assert.deepEqual(holes.outputs[0].plan.episodes_not_found, ['season 3: episodes 7 and 8']);
    assert.equal(holes.outputs[0].plan.not_aired_yet, undefined);
    assert.ok(holes.outputs[0].next_step.endsWith('Tell the user what could not be found or has not aired yet.'));

    // A show still running: what has aired is fetched, and the rest is said to be still to come.
    const running = await chat.say('Get all of Tales of the Kestrel', [show({ title: 'Tales of the Kestrel' })], 'Shall I get it?');
    assert.equal(running.outputs[0].catalogue, `This is Tales of the Kestrel (2022, United States, 3 seasons, still running). The next episode, season 3 episode 4, is due on ${sayDate(day(4))}.`);
    assert.deepEqual(running.outputs[0].plan.gets.map((part) => part.what), ['Season 1', 'Season 2', 'Season 3: 3 single episodes']);
    assert.deepEqual(running.outputs[0].plan.not_aired_yet, ['season 3: 5 of its 8 episodes have not aired yet']);
    assert.equal(running.outputs[0].plan.episodes_not_found, undefined);
    assert.equal(running.outputs[0].plan.seasons_not_found, undefined);
  } finally {
    chat.close();
  }
});

test('the latest season is worked out by PiRick, and a season or episode that is not there is said not to be', async () => {
  const chat = pirick();
  try {
    const latest = await chat.say('Get the latest season of Copperhollow', [show({ title: 'Copperhollow', latest: true })], 'Shall I get it?');
    assert.deepEqual(latest.outputs[0].plan.gets.map((part) => part.what), ['Season 2']);
    assert.match(latest.record.statuses[0], /^Found season 2 of “Copperhollow”: /);
    assert.equal(latest.tools.find((tool) => tool.function.name === 'find_show').function.parameters.properties.latest.type, 'boolean');
    const before = chat.world.trace().searches.length;

    const none = await chat.say('And season 4?', [show({ title: 'Copperhollow', season: 4 })], 'There are only two seasons.');
    assert.deepEqual(none.outputs[0], {
      found: false,
      catalogue: 'This is Copperhollow (2024, United States, 2 seasons). Copperhollow has 2 seasons. There is no season 4.',
      note: 'Nothing was looked for. Tell the user how many seasons there are, and ask which they would like.',
    });
    assert.deepEqual(none.record.statuses, ['Not looked for: Copperhollow has 2 seasons. There is no season 4.']);
    // Saying so is a complete answer.
    assert.equal(none.record.nudges, 0);

    const episode = await chat.say('Season 2 episode 12 then?', [show({ title: 'Copperhollow', season: 2, episode: 12 })], 'That season has ten episodes.');
    assert.match(episode.outputs[0].catalogue, /Season 2 of Copperhollow has 10 episodes\. There is no episode 12\.$/);

    // Of a show still running, what has not aired yet is said to be that, with its date when known.
    const soon = await chat.say('Tales of the Kestrel season 3 episode 4?', [show({ title: 'Tales of the Kestrel', season: 3, episode: 4 })], 'It has not aired yet.');
    assert.ok(soon.outputs[0].catalogue.endsWith(`Only 3 episodes of season 3 of Tales of the Kestrel have aired so far. It is due on ${sayDate(day(4))}.`), soon.outputs[0].catalogue);
    const later = await chat.say('And episode 7?', [show({ title: 'Tales of the Kestrel', season: 3, episode: 7 })], 'Not yet.');
    assert.ok(later.outputs[0].catalogue.endsWith('Only 3 episodes of season 3 of Tales of the Kestrel have aired so far.'));
    const beyond = await chat.say('Season 4?', [show({ title: 'Tales of the Kestrel', season: 4 })], 'There are three so far.');
    assert.ok(beyond.outputs[0].catalogue.endsWith('Tales of the Kestrel has 3 seasons so far. There is no season 4.'));
    assert.equal(chat.world.trace().searches.length, before, 'none of that was searched for');
  } finally {
    chat.close();
  }
});

test('two shows with one name are offered before anything is looked for, and told apart by year or country', async () => {
  const chat = pirick();
  try {
    const which = await chat.say('Get Kestrelmere', [show({ title: 'Kestrelmere' })], 'The American or the British one?');
    assert.deepEqual(which.outputs[0], {
      found: false,
      catalogue: 'More than one show is called “Kestrelmere”.',
      which_one: ['Kestrelmere (2005, United States, 9 seasons)', 'Kestrelmere (2001, United Kingdom, 2 seasons)'],
      note: 'Nothing was looked for yet. If what the user said settles which of these they mean (a year, a country), call find_show again with that year added to the title. Otherwise ask the user which one, giving the years and countries.',
    });
    assert.deepEqual(chat.world.trace().searches, []);

    await chat.say('The American one.', [show({ title: 'Kestrelmere 2005' }), get('TV', 'Kestrelmere US')], 'Done.');
    await chat.say('And the British one.', [show({ title: 'Kestrelmere UK' }), get('TV', 'Kestrelmere UK')], 'Done.');
    assert.deepEqual(titles(chat), ['Kestrelmere.US.The.Complete.Series.S01-S09.1080p.BluRay.x265-GRP', 'Kestrelmere.UK.The.Complete.Series.S01-S02.1080p.BluRay.x264-GRP']);
  } finally {
    chat.close();
  }
});

test('a show kept under another of its names goes into the folder it has, with no question asked', async () => {
  const chat = pirick();
  try {
    const { outputs, record } = await chat.say('Get season 1 of The Vampires', [show({ title: 'The Vampires', season: 1 }), get('TV', 'The Vampires')], 'Done.');
    assert.equal(outputs[0].catalogue, 'This is Les Vampires (1915, France, 1 season).');
    assert.equal(outputs[0].plan.show, 'Les Vampires');
    assert.equal(outputs[1].ok, true, 'the first download call went through');
    assert.equal(chat.world.trace().added[0].savePath, '/media/TV/Les Vampires');
    assert.equal(chat.world.trace().added[0].title, 'The.Vampires.1915.S01.1080p.BluRay.x265-GRP');
    // It is released under its English name, which is tried when its own finds nothing.
    assert.ok(chat.world.trace().searches.some((query) => query.startsWith('The Vampires')));
    assert.match(record.statuses.at(-1), /→ TV \/ Les Vampires$/);

    // A folder that only looks similar is another show: the catalogue would have known the name.
    const other = await chat.say('And season 1 of Tales of the Kestrel', [show({ title: 'Tales of the Kestrel', season: 1 }), get('TV', 'Tales of the Kestrel')], 'Done.');
    assert.equal(other.outputs[1].ok, true);
    assert.equal(chat.world.trace().added[1].savePath, '/media/TV/Tales of the Kestrel');
  } finally {
    chat.close();
  }
});

test('a show named with a description after it is still the show', async () => {
  for (const title of ['The Vampires, the French serial 1915', 'The Vampires, the French serial', 'The Vampires - the 1915 serial']) {
    const chat = pirick();
    try {
      const { outputs } = await chat.say('Get season 1 of The Vampires, the French serial from 1915', [show({ title, season: 1 }), get('TV', 'The Vampires')], 'Done.');
      assert.equal(outputs[0].catalogue, 'This is Les Vampires (1915, France, 1 season).', title);
      assert.equal(chat.world.trace().added[0].savePath, '/media/TV/Les Vampires', title);
    } finally {
      chat.close();
    }
  }
});

test('an anime is marked as one, and its guide is not held against what is found', async () => {
  const chat = pirick();
  try {
    const { outputs } = await chat.say('Get all of Starfall Courier', [show({ title: 'Starfall Courier' }), get('Anime', 'Starfall Courier')], 'Done.');
    assert.equal(outputs[0].catalogue, 'This is Starfall Courier (2021, Japan, 2 seasons, anime).');
    assert.equal(outputs[0].plan.kind, 'anime');
    assert.equal(outputs[0].plan.episodes_not_found, undefined);
    assert.ok(chat.world.trace().added.every((entry) => entry.savePath === '/media/Anime/Starfall Courier'));
    // Found under its Japanese name too, and filed in the folder it already has under that name.
    const mirelle = await chat.say('Get Mirelle of the Harbor', [show({ title: 'Mirelle of the Harbor' })], 'I could not find a copy.');
    assert.match(mirelle.outputs[0].catalogue, /^This is Minato no Mirelle \(2019, Japan, 1 season, anime\)\.$/);
  } finally {
    chat.close();
  }
});

test('a film asked for as a show is sent the right way, and a show nobody has heard of is looked for once', async () => {
  const chat = pirick();
  try {
    const film = await chat.say('Get the show Nosferatu', [show({ title: 'Nosferatu' })], 'That is a film. Shall I get it?');
    assert.deepEqual(film.outputs[0], { found: false, catalogue: 'The catalogue lists Nosferatu (1922) as a film, not a TV show.', note: 'Nothing was looked for. Call search_media for it instead, with media_type set to movie.' });
    assert.deepEqual(chat.world.trace().searches, []);

    const unknown = await chat.say('Get The Zorblax Chronicles', [show({ title: 'The Zorblax Chronicles' })], 'I could not find that anywhere.');
    assert.equal(unknown.outputs[0].catalogue, 'The catalogue knows no show called “The Zorblax Chronicles”.');
    assert.equal(unknown.outputs[0].note, 'Nothing found, and the catalogue knows no show of this name. Tell the user you could not find it and ask them to check the name. Do not look again under other spellings.');
    assert.equal(unknown.record.nudges, 0);

    // A show that exists, with no copy to be had.
    const noCopy = await chat.say('Get Minato no Mirelle', [show({ title: 'Minato no Mirelle' })], 'It exists, but I found no copy.');
    assert.equal(noCopy.outputs[0].note, 'The show exists, but no copy of this was found. Tell the user that. Do not look again under other spellings.');
    assert.equal(noCopy.record.nudges, 0);
  } finally {
    chat.close();
  }
});

test('with a guide, what Plex has of a season is known to be all of it or not', async () => {
  const plex = { shows: [{ title: 'Copperhollow', year: 2024, seasons: { 1: 10, 2: [1, 2, 3, 4, 5, 6, 7, 8] } }] };
  const chat = pirick({ plex, folders: { '/media/TV': ['Copperhollow'] } });
  try {
    // All of season 1 is there: said, and nothing planned.
    const all = await chat.say('Get season 1 of Copperhollow', [show({ title: 'Copperhollow', season: 1 })], 'You have all of season 1 already.');
    assert.deepEqual(all.outputs[0], {
      found: true,
      catalogue: 'This is Copperhollow (2024, United States, 2 seasons).',
      plex: 'Plex already has all 10 episodes of season 1 of Copperhollow.',
      note: 'Nothing needs downloading: the user already has the whole season in Plex. Tell them so. Only if they then say they want another copy, call find_show again.',
    });
    assert.equal(all.record.nudges, 0);

    // Part of season 2 is there: the rest is fetched, without asking.
    const rest = await chat.say('And season 2', [show({ title: 'Copperhollow', season: 2 }), get('TV', 'Copperhollow')], 'I got the two you were missing.');
    assert.equal(rest.outputs[0].plex, 'Plex already has 8 of the 10 episodes of season 2. This plan gets only the 2 it lacks: episodes 9 and 10.');
    assert.deepEqual(rest.outputs[0].plan.gets.map((part) => part.what), ['Season 2: 2 single episodes']);
    assert.equal(rest.outputs[1].ok, true, 'no question first');
    assert.deepEqual(titles(chat), ['Copperhollow.S02E09.1080p.WEB.H264-GRP', 'Copperhollow.S02E10.1080p.WEB.H264-GRP']);
    assert.ok(rest.record.statuses.includes('Already in Plex, so left out: 8 of the 10 episodes of season 2'));

    // The whole show: what Plex has is described exactly.
    const whole = await chat.say('Actually, all of it', [show({ title: 'Copperhollow' })], 'Shall I?');
    assert.equal(whole.outputs[0].plex, 'Plex already has all of season 1 and 8 of the 10 episodes of season 2. That is left out of this plan.');
    assert.deepEqual(whole.outputs[0].plan.gets.map((part) => part.what), ['Season 2: 2 single episodes']);

    // Told they have season 1, they say to get it anyway.
    const again = await chat.say('Get season 1 anyway', [show({ title: 'Copperhollow', season: 1 })], 'Shall I?');
    assert.equal(again.outputs[0].plex, 'Plex already has all of season 1, and the user has been told.');
    assert.ok(again.outputs[0].plan);
  } finally {
    chat.close();
  }
});

test('without the catalogue, or when it cannot be reached, a request for a show is as it always was', async () => {
  const without = talkTo({});
  const lost = pirick();
  try {
    lost.world.catalogueServices.setDown('all');
    const plain = (output) => JSON.parse(JSON.stringify(output).replace(/"id":"[a-z0-9]{4}"/g, '"id":"x"'));
    for (const args of [{ title: 'Wrenfield Cross' }, { title: 'Kestrelmere' }, { title: 'The Vampires', season: 1 }, { title: 'Copperhollow', latest: true }]) {
      const before = await without.say('Get it', [show(args)], 'Shall I?');
      const after = await lost.say('Get it', [show(args)], 'Shall I?');
      assert.deepEqual(plain(after.outputs[0]), plain(before.outputs[0]), JSON.stringify(args));
      assert.deepEqual(after.record.statuses, before.record.statuses);
      assert.equal(before.outputs[0].catalogue, undefined);
    }
    assert.deepEqual(without.world.trace().searches, lost.world.trace().searches);
    // The option to ask for the latest season is only offered with a catalogue.
    const tools = (await without.say('Hello', [], 'Hello!')).tools;
    assert.equal(tools.find((tool) => tool.function.name === 'find_show').function.parameters.properties.latest, undefined);
  } finally {
    without.close();
    lost.close();
  }
});
