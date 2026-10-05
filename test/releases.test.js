import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlan, describeContents, describePart, matchShow, parseRelease, parseWanted, planShow } from '../src/releases.js';

const GB = 1024 ** 3;
/** A search result as Jackett would give it, with its name already read. */
const release = (title, seeders = 10, sizeGb = 2) => ({ title, seeders, size: sizeGb * GB, parsed: parseRelease(title) });
const titles = (plan) => plan.parts.map((part) => `${describePart(part)}: ${part.releases.map((r) => r.title).join(' + ')}`);

test('release names are read for what they contain', () => {
  const cases = [
    // Scene and web naming.
    ['Pioneer.One.S01E05.1080p.BluRay.x264-GRP', 'S01E05', 'Pioneer One'],
    ['Pioneer.One.S02.1080p.BluRay.x264-GRP', 'season 2', 'Pioneer One'],
    ['Pioneer.One.S01-S05.COMPLETE.1080p.BluRay.x265', 'seasons 1-5', 'Pioneer One'],
    ['Pioneer One - The Complete Series (2008-2013) 1080p', 'complete series', 'Pioneer One'],
    ['Pioneer.One.Season.3.720p.WEB-DL', 'season 3', 'Pioneer One'],
    ['Pioneer.One.Seasons.1-5.720p', 'seasons 1-5', 'Pioneer One'],
    ['Pioneer.One.S01.S02.S03.720p', 'seasons 1-3', 'Pioneer One'],
    ['Pioneer.One.1x05.HDTV', 'S01E05', 'Pioneer One'],
    ['Pioneer.One.S01E01-E07.720p', 'season 1', 'Pioneer One'],
    ['Pioneer.One.S01E01-E02.720p', 'S01E01', 'Pioneer One'],
    ['Pioneer.One.S05E15E16.1080p', 'S05E15', 'Pioneer One'],
    ['Pioneer.One.COMPLETE.720p.WEB', 'complete series', 'Pioneer One'],
    ['Show.S01.COMPLETE.1080p', 'season 1', 'Show'],
    ['Show S01 to S03 DVDRip', 'seasons 1-3', 'Show'],
    ['Show (2020) Season 1-3 Complete', 'seasons 1-3', 'Show'],
    ['Show.The.Complete.Collection.DVDRip', 'complete series', 'Show'],
    ['Show.Saison.2.FRENCH.720p', 'season 2', 'Show'],
    ['Show Series 3 720p HDTV', 'season 3', 'Show'],
    ['Show.Name.S10E100.720p', 'S10E100', 'Show Name'],
    ['Show.E05.720p', 'episode 5', 'Show'],
    ['Kestrelmere.US.S03.1080p', 'season 3', 'Kestrelmere US'],
    ['Wrenfield.Cross.2005.S01.720p', 'season 1', 'Wrenfield Cross'],
    ['1808.S01E03.1080p.WEB', 'S01E03', '1808'],
    ['Mr.Kestrel.S03.720p', 'season 3', 'Mr Kestrel'],
    // Anime and fansub naming.
    ['[Subs] Minato no Mirelle - 05 (1080p) [ABCD1234].mkv', 'episode 5', 'Minato no Mirelle'],
    ['[Subs] Minato no Mirelle (01-28) (1080p) [Batch]', 'complete series', 'Minato no Mirelle'],
    ['[Grp] Minato no Mirelle (Mirelle of the Harbor) S01-S04 [BD 1080p][Batch]', 'seasons 1-4', 'Minato no Mirelle'],
    ['[Raws] Mirelle of the Harbor 2nd Season - 03 [720p]', 'S02E03', 'Mirelle of the Harbor'],
    ['[Group] Long Voyage - 1071 [1080p]', 'episode 1071', 'Long Voyage'],
    ['[Group] Title S2 - 05 [1080p]', 'S02E05', 'Title'],
    ['[Group] Title - 05v2 [1080p]', 'episode 5', 'Title'],
    ['Title 01-12 [Batch] [1080p]', 'complete series', 'Title'],
    ['[Group] Title [01-12] [BD]', 'complete series', 'Title'],
    ['Title - Episode 7 [720p]', 'episode 7', 'Title'],
    // Not shows.
    ['Tears.of.Steel.2012.1080p.WEB-DL', undefined, 'Tears of Steel'],
    ['Movie.Name.2019.COMPLETE.BLURAY-GRP', undefined, 'Movie Name'],
    ['Artist - Album Name [FLAC]', undefined, 'Artist - Album Name'],
  ];
  for (const [name, contains, show] of cases) {
    const parsed = parseRelease(name);
    assert.equal(describeContents(parsed), contains, name);
    assert.equal(parsed.show, show, name);
  }
});

test('years, quality and poor copies are noticed', () => {
  assert.equal(parseRelease('Tears.of.Steel.2012.1080p.WEB-DL').kind, 'movie');
  assert.equal(parseRelease('Tears.of.Steel.2012.1080p.WEB-DL').year, 2012);
  assert.equal(parseRelease('Artist - Album Name [FLAC]').kind, 'unknown');
  assert.equal(parseRelease('1808.S01E03.1080p.WEB').year, null, 'a year that is the title is not a date');
  assert.equal(parseRelease('Wrenfield.Cross.2005.S01.720p').year, 2005);
  assert.equal(parseRelease('Sintel.2010.2160p.UHD.BluRay.REMUX').resolution, 2160);
  assert.equal(parseRelease('Show 4K S01').resolution, 2160);
  assert.equal(parseRelease('Show.S01E05.720p').resolution, 720);
  assert.equal(parseRelease('Show.S01E05.HDTV').resolution, null);
  assert.equal(parseRelease('Some.Movie.2023.HDCAM.x264').poor, true);
  assert.equal(parseRelease('Some.Movie.2023.1080p.WEB').poor, false);
  // An alias in brackets counts as a name for the show.
  assert.deepEqual(parseRelease('[Grp] Minato no Mirelle (Mirelle of the Harbor) S01-S04').keys, ['minato no mirelle', 'mirelle of the harbor']);
  assert.equal(parseRelease('Pioneer.One.COMPLETE.720p.WEB').certain, false);
  assert.equal(parseRelease('Pioneer One The Complete Series').certain, true);
});

test('a requested title is split into name and year', () => {
  assert.deepEqual(parseWanted('Wrenfield Cross (2005)'), { name: 'Wrenfield Cross', key: 'wrenfield cross', year: 2005 });
  assert.deepEqual(parseWanted('  wrenfield   cross 2005 '), { name: 'wrenfield cross', key: 'wrenfield cross', year: 2005 });
  assert.deepEqual(parseWanted('Copperhollow'), { name: 'Copperhollow', key: 'copperhollow', year: null });
  assert.deepEqual(parseWanted('1808'), { name: '1808', key: '1808', year: null });
});

test('only releases of the wanted show are kept', () => {
  const found = [
    release('Kestrelmere.US.S01.1080p'),
    release('Kestrelmere.US.S02.1080p'),
    release('Kestrelmere.UK.S01.720p'),
    release('Kestrelmere.Road.1999.1080p'),
  ];
  // Nothing is called exactly "Kestrelmere": name the candidates instead of guessing.
  assert.deepEqual(matchShow(parseWanted('Kestrelmere'), found), { others: ['Kestrelmere US', 'Kestrelmere UK'] });
  assert.equal(matchShow(parseWanted('Kestrelmere US'), found).releases.length, 2);
  assert.deepEqual(matchShow(parseWanted('Nothing Like It'), found), { releases: [] });

  const aliased = [release('[Grp] Minato no Mirelle (Mirelle of the Harbor) S01-S04 [Batch]'), release('Mirelle.of.the.Harbor.S01.1080p')];
  assert.equal(matchShow(parseWanted('mirelle of the harbor'), aliased).releases.length, 2);
});

test('two shows with one name are told apart by year', () => {
  const found = [
    release('Wrenfield.Cross.1963.S01.DVDRip'),
    release('Wrenfield.Cross.2005.S01.1080p'),
    release('Wrenfield.Cross.2006.S02.1080p'),
    release('Wrenfield.Cross.S03.1080p'),
  ];
  assert.deepEqual(matchShow(parseWanted('Wrenfield Cross'), found), { years: [1963, 2005] });
  const modern = matchShow(parseWanted('Wrenfield Cross 2005'), found).releases.map((r) => r.title);
  assert.deepEqual(modern, ['Wrenfield.Cross.2005.S01.1080p', 'Wrenfield.Cross.2006.S02.1080p']);

  // Seasons dated a year apart are one show whose release dates drift.
  const drift = [release('Show.2019.S01.1080p'), release('Show.2020.S01.REPACK.1080p'), release('Show.2021.S02.1080p')];
  assert.equal(matchShow(parseWanted('Show'), drift).releases.length, 3);
});

test('a good complete pack is taken on its own', () => {
  const plan = buildPlan([
    release('Show.S01.1080p', 80),
    release('Show.S02.1080p', 90),
    release('Show.S01E01.1080p', 300),
    release('Show.The.Complete.Series.1080p', 12, 40),
    release('Show.Complete.Series.720p', 40, 20),
  ]);
  // Healthy, in the wanted quality: beats a better-seeded 720p pack and any number of parts.
  assert.deepEqual(titles(plan), ['Complete series: Show.The.Complete.Series.1080p']);
  assert.equal(plan.torrents, 1);
  assert.deepEqual(plan.missing, []);
});

test('a complete pack with too few seeders loses to healthy season packs', () => {
  const found = [
    release('Show.Complete.Series.1080p', 2, 40),
    release('Show.S01.1080p', 30),
    release('Show.S02.1080p', 25),
    release('Show.S03.720p', 60),
    release('Show.S03.1080p', 4),
  ];
  assert.deepEqual(titles(buildPlan(found)), ['Season 1: Show.S01.1080p', 'Season 2: Show.S02.1080p', 'Season 3: Show.S03.1080p']);
  assert.deepEqual(titles(buildPlan(found, { quality: 720 })).at(-1), 'Season 3: Show.S03.720p');
});

test('seasons without a pack fall back to single episodes, best copy of each', () => {
  const plan = buildPlan([
    release('Show.S01.1080p', 30),
    release('Show.S02.1080p', 30),
    release('Show.S03E01.1080p', 12),
    release('Show.S03E01.720p', 90),
    release('Show.S03E02.1080p', 1),
    release('Show.S03E02.720p', 15),
    release('Show.S03E03.1080p', 0),
  ]);
  assert.deepEqual(titles(plan), [
    'Season 1: Show.S01.1080p',
    'Season 2: Show.S02.1080p',
    // E01: healthy 1080p wins over better-seeded 720p. E02: the 1080p is nearly dead. E03: no seeders at all.
    'Season 3: 2 single episodes: Show.S03E01.1080p + Show.S03E02.720p',
  ]);
  assert.equal(plan.torrents, 4);
});

test('a weak season pack only loses to episodes that are mostly healthy', () => {
  const weakPack = release('Show.S01.1080p', 1);
  const healthyEpisodes = [release('Show.S01E01.1080p', 20), release('Show.S01E02.1080p', 20)];
  const dyingEpisodes = [release('Show.S01E01.1080p', 1), release('Show.S01E02.1080p', 2)];
  assert.equal(buildPlan([weakPack, ...healthyEpisodes]).parts[0].type, 'episodes');
  assert.equal(buildPlan([weakPack, ...dyingEpisodes]).parts[0].type, 'season');
  assert.equal(buildPlan(dyingEpisodes).parts[0].type, 'episodes', 'poor episodes are still better than nothing');
});

test('packs of several seasons are used, and one that spans everything counts as complete', () => {
  const partial = buildPlan([
    release('Show.S01-S02.1080p', 20, 30),
    release('Show.S01.1080p', 50),
    release('Show.S03.1080p', 20),
    release('Show.S04E01.1080p', 20),
  ]);
  assert.deepEqual(titles(partial), ['Seasons 1-2: Show.S01-S02.1080p', 'Season 3: Show.S03.1080p', 'Season 4: 1 single episode: Show.S04E01.1080p']);

  const spanning = buildPlan([release('Show.S01-S03.1080p', 20, 30), release('Show.S01.1080p', 50), release('Show.S03E01.1080p', 9)]);
  assert.deepEqual(titles(spanning), ['Complete series: Show.S01-S03.1080p']);
});

test('missing seasons are reported, unless a weak complete pack can fill the gap', () => {
  const gap = [release('Show.S01.1080p', 30), release('Show.S03.1080p', 30)];
  assert.deepEqual(buildPlan(gap).missing, [2]);
  assert.equal(buildPlan(gap).torrents, 2);
  assert.deepEqual(titles(buildPlan([...gap, release('Show.Complete.Series.720p', 1, 40)])), ['Complete series: Show.Complete.Series.720p']);
});

test('the size limit can rule out a huge pack', () => {
  const found = [release('Show.Complete.Series.1080p', 100, 120), release('Show.S01.1080p', 20, 30), release('Show.S02.1080p', 20, 30)];
  assert.equal(buildPlan(found).torrents, 1);
  assert.deepEqual(titles(buildPlan(found, { maxBytes: 50 * GB })), ['Season 1: Show.S01.1080p', 'Season 2: Show.S02.1080p']);
});

test('one season can be planned on its own', () => {
  const found = [
    release('Show.S01.1080p', 30),
    release('Show.S02E01.1080p', 30),
    release('Show.S02E02.1080p', 30),
    release('Show.Complete.Series.1080p', 100, 60),
  ];
  assert.deepEqual(titles(buildPlan(found, { season: 1 })), ['Season 1: Show.S01.1080p']);
  assert.deepEqual(titles(buildPlan(found, { season: 2 })), ['Season 2: 2 single episodes: Show.S02E01.1080p + Show.S02E02.1080p']);
  assert.deepEqual(buildPlan(found, { season: 3 }), { parts: [], missing: [3], torrents: 0 });
});

test('one episode can be asked for: the best copy of it and nothing else', async () => {
  const found = [
    release('Show.S01E02.720p.HDTV', 90),
    release('Show.S01E02.1080p.WEB', 12),
    release('Show.S01E03.1080p.WEB', 99),
    release('Show.S01.1080p.BluRay', 99),
    release('[Group] Show - 02 [1080p]', 5),
  ];
  assert.deepEqual(titles(buildPlan(found, { season: 1, episode: 2 })), ['Season 1: 1 single episode: Show.S01E02.1080p.WEB']);
  assert.deepEqual(buildPlan(found, { season: 1, episode: 9 }), { parts: [], missing: [], torrents: 0 });
  // No season given: fansub numbering, where the season is left off.
  assert.equal(buildPlan([release('[Group] Show - 02 [1080p]', 5), release('[Group] Show - 03 [1080p]', 5)], { episode: 3 }).parts[0].releases[0].title, '[Group] Show - 03 [1080p]');

  const numbered = fakeSearch({ 'Show S01E02': [['Show.S01E02.1080p.WEB', 12], ['Show.S01E03.1080p.WEB', 99]] });
  assert.equal((await planShow(numbered.search, { title: 'Show', season: 1, episode: 2 })).plan.torrents, 1);
  assert.deepEqual(numbered.asked, ['Show S01E02'], 'one search, no season-by-season follow-up');
  const bare = fakeSearch({ 'Long Voyage 1071': [['[Group] Long Voyage - 1071 [1080p]', 30]] });
  assert.equal((await planShow(bare.search, { title: 'Long Voyage', episode: 1071 })).plan.torrents, 1);
  assert.deepEqual(bare.asked, ['Long Voyage 1071']);
});

test('fansub numbering: bare episodes are the first season, and a batch is everything unless later seasons exist', () => {
  const batch = release('[Group] Title (01-12) [Batch]', 40);
  assert.deepEqual(titles(buildPlan([batch, release('[Group] Title - 01 [1080p]', 90)])), ['Complete series: [Group] Title (01-12) [Batch]']);
  assert.deepEqual(titles(buildPlan([release('[Group] Title - 01 [1080p]', 9), release('[Group] Title - 02 [1080p]', 9)])), [
    'Season 1: 2 single episodes: [Group] Title - 01 [1080p] + [Group] Title - 02 [1080p]',
  ]);
  // With a second season around, the unlabelled batch is only season one.
  assert.deepEqual(titles(buildPlan([batch, release('[Group] Title S2 (01-12) [Batch]', 40)])), [
    'Season 1: [Group] Title (01-12) [Batch]',
    'Season 2: [Group] Title S2 (01-12) [Batch]',
  ]);
});

/** A stand-in for Jackett: answers each query from a table and remembers what was asked. */
function fakeSearch(table) {
  const asked = [];
  const search = async (query) => {
    asked.push(query);
    const answer = Object.entries(table).find(([key]) => key.toLowerCase() === query.toLowerCase())?.[1] ?? [];
    if (answer instanceof Error) throw answer;
    return answer.map(([title, seeders = 10, sizeGb = 2]) => ({ title, seeders, size: sizeGb * GB, infoHash: null }));
  };
  return { search, asked };
}

test('planning a whole show stops at a good complete pack', async () => {
  const { search, asked } = fakeSearch({
    Show: [['Show.S01E01.1080p', 50], ['Show.S02.1080p', 20]],
    'Show complete': [['Show.The.Complete.Series.1080p', 25, 40]],
  });
  const { plan, show } = await planShow(search, { title: 'Show' });
  assert.deepEqual(titles(plan), ['Complete series: Show.The.Complete.Series.1080p']);
  assert.equal(show, 'Show');
  assert.deepEqual(asked, ['Show', 'Show complete'], 'no season-by-season searches were needed');
});

test('without a complete pack, each season still lacking a pack is searched', async () => {
  const { search, asked } = fakeSearch({
    Show: [['Show.S01E01.1080p', 50], ['Show.S02.1080p', 20], ['Show.S03E04.1080p', 30], ['Other.Show.S01.1080p', 99]],
    'Show S01': [['Show.S01.1080p', 15, 20], ['Show.S01E01.1080p', 50]],
    'Show S03': [['Show.S03E04.1080p', 30], ['Show.S03E05.1080p', 30]],
  });
  const { plan } = await planShow(search, { title: 'show' });
  assert.deepEqual(titles(plan), [
    'Season 1: Show.S01.1080p',
    'Season 2: Show.S02.1080p',
    'Season 3: 2 single episodes: Show.S03E04.1080p + Show.S03E05.1080p',
  ]);
  // Season 2 already had a healthy pack, so only 1 and 3 were looked up.
  assert.deepEqual(asked, ['show', 'show complete', 'show S01', 'show S03']);
});

test('planning one season, skipping copies, and passing ambiguity through', async () => {
  const table = {
    'Show S02': [['Show.S02.1080p', 20], ['Show.S02.720p', 40]],
    'Show season 2': [['Show.Season.2.1080p.WEB', 8]],
    'Kestrelmere': [['Kestrelmere.US.S01.1080p'], ['Kestrelmere.UK.S01.720p']],
  };
  const season = fakeSearch(table);
  assert.deepEqual(titles((await planShow(season.search, { title: 'Show', season: 2 })).plan), ['Season 2: Show.S02.1080p']);
  assert.deepEqual(season.asked, ['Show S02'], 'a good pack was found, so the second wording was not needed');

  // With those packs ruled out, the "season 2" wording is searched as well.
  const skipping = fakeSearch(table);
  const plan = await planShow(skipping.search, { title: 'Show', season: 2, skip: (r) => r.title.startsWith('Show.S02.') });
  assert.deepEqual(titles(plan.plan), ['Season 2: Show.Season.2.1080p.WEB']);
  assert.deepEqual(skipping.asked, ['Show S02', 'Show season 2']);

  assert.deepEqual(await planShow(fakeSearch(table).search, { title: 'Kestrelmere' }), { others: ['Kestrelmere US', 'Kestrelmere UK'] });
  assert.equal((await planShow(fakeSearch({}).search, { title: 'Nothing' })).plan.torrents, 0);
});

test('a failed search is tolerated unless every search failed', async () => {
  const partly = fakeSearch({ Show: [['Show.S01.1080p', 20]], 'Show complete': new Error('indexer timed out'), 'Show S01': new Error('indexer timed out') });
  assert.equal((await planShow(partly.search, { title: 'Show' })).plan.torrents, 1, 'what the first search found still stands');
  const down = fakeSearch({ Show: new Error('down'), 'Show complete': new Error('down') });
  await assert.rejects(planShow(down.search, { title: 'Show' }), /down/);
});
