import assert from 'node:assert/strict';
import { test } from 'node:test';
import { titleKey } from '../src/folders.js';
import { canonicalWords, createFinder, queryVariants, relevantResults, withoutTrailingWords } from '../src/search.js';

// What an indexer returns for "7 chances": episodes numbered 07, and not the 1925 film "Seven Chances".
const JUNK_FOR_7_CHANCES = [
  ['[Subs] Lantern Tide - 07 (1080p) [80535F59].mkv', 184],
  ['[Subs] The Night We Counted Every Star Above the Harbor, and Lost Count. - 07 (1080p) [E559A02A].mkv', 174],
  ['[Raws] Lantern Tide - 06 [1080p WEB-DL AVC AAC][MultiSub][534344C9]', 133],
  ['[Dubs] Emberwake - S02E07 v2 [English Dub] [WEB-DL 1080p H264 AAC] [5BC607B3]', 117],
  ['[Raws] Opposite Shores 2nd Season - 07 [1080p WEBRip HEVC AAC][MultiSub]', 101],
];
const JUNK_FOR_7_CHANCES_1925 = [
  ['A Quiet Harbor 1925 unrated 720p BRrip_ grp_x', 11],
  ['Harbor Friends Best Days - 143 Season 2 57 Island Adventure 21 - Up to the Lighthouse! Gulls', 1],
];
const THE_FILM = [
  ['Seven.Chances.1925.720p.WEB-DL.H264 GRP [Public]', 22],
  ['Seven.Chances.2013.REMASTERED.1925.BDRip.x264-GRP', 1],
];
const results = (list) => list.map(([title, seeders = 10]) => ({ title, seeders, size: 1e9, infoHash: null }));
const titles = (list) => list.map((result) => result.title);

/** A stand-in Jackett that answers from a table and remembers what it was asked. */
function fakeJackett(table) {
  const asked = [];
  return {
    asked,
    async search(query) {
      asked.push(query);
      const answer = Object.entries(table).find(([key]) => key.toLowerCase() === query.toLowerCase())?.[1] ?? [];
      if (answer instanceof Error) throw answer;
      return results(answer);
    },
  };
}

test('other spellings of a title are worked out', () => {
  const cases = {
    '7 chances': ['seven chances'],
    '7 chances 1925': ['seven chances 1925'],
    'Seven Chances 1925': ['7 Chances 1925'],
    'Kestrel 2': ['Kestrel two', 'Kestrel II'],
    'Kestrel II 1979': ['Kestrel 2 1979'],
    "Harlan's 11": ["Harlan's eleven", "Harlan's XI"],
    'Salt & Iron': ['Salt and Iron'],
    'Wren Part Two 2024 1080p': ['Wren Part 2 2024 1080p'],
    // Nothing to respell: years, resolutions and episode markers are left alone.
    'The General 1926': [],
    '2001 A Harbour Year': [],
    1917: [],
    300: [],
    'Show S01E05 720p': [],
    Le7el: [],
    '': [],
  };
  for (const [query, expected] of Object.entries(cases)) assert.deepEqual(queryVariants(query), expected, query);
});

test('words after the year are dropped when a search needs a second try', () => {
  assert.equal(withoutTrailingWords('7 chances 1925 Buster Keaton'), '7 chances 1925');
  assert.equal(withoutTrailingWords('seven chance 1925 Buster Keaton'), 'seven chance 1925');
  assert.equal(withoutTrailingWords('7 chances 1925'), null);
  assert.equal(withoutTrailingWords('7 chances 1925 1080p bluray'), null, 'quality words are not extras');
  assert.equal(withoutTrailingWords('Buster Keaton'), null);
  assert.equal(withoutTrailingWords('2001 A Harbour Year'), null, 'a year that starts the title is not a date');
});

test('titles are compared word by word with numbers in one form', () => {
  assert.deepEqual(canonicalWords('Seven.Chances.1925.720p.WEB-DL'), ['7', 'chances', '1925', '720p', 'web', 'dl']);
  assert.deepEqual(canonicalWords('Kestrel II'), ['kestrel', '2']);
  assert.deepEqual(canonicalWords('[Subs] Lantern Tide - 07 (1080p)'), ['subs', 'lantern', 'tide', '7', '1080p']);
  assert.deepEqual(canonicalWords("Harlan's Eleven & Twelve"), ['harlans', '11', 'and', '12']);
  // Folders and shows are matched the same way.
  assert.equal(titleKey('Seven Chances (1925)'), titleKey('7 Chances'));
  assert.equal(titleKey('Kestrel II'), titleKey('kestrel 2'));
});

test('only results about the title asked for are kept', () => {
  const everything = results([...JUNK_FOR_7_CHANCES, ...JUNK_FOR_7_CHANCES_1925, ...THE_FILM]);
  assert.deepEqual(titles(relevantResults('7 chances', everything)), titles(results(THE_FILM)));
  assert.deepEqual(titles(relevantResults('seven chances 1925', everything)), titles(results(THE_FILM)));
  assert.equal(relevantResults('7 chances 1925', results(JUNK_FOR_7_CHANCES_1925)), null, 'nothing clearly matches');

  const wrens = results([['Wren.1984.1080p.BluRay'], ['Wren.2021.2160p.WEB-DL'], ['Wren.Part.Two.2024.1080p'], ['Wrenfield.2017.1080p']]);
  assert.deepEqual(titles(relevantResults('Wren 2021', wrens)), ['Wren.2021.2160p.WEB-DL'], 'the year picks between films of one name');
  assert.deepEqual(titles(relevantResults('Wren', wrens)), ['Wren.1984.1080p.BluRay', 'Wren.2021.2160p.WEB-DL', 'Wren.Part.Two.2024.1080p']);
  assert.deepEqual(titles(relevantResults('Wren 1999', wrens)).length, 3, 'a year nothing has does not empty the list');

  const check = (query, title) => relevantResults(query, results([[title]])) !== null;
  assert.equal(check('The General 1926', 'General.1926.1080p.BluRay'), true, 'articles do not matter');
  assert.equal(check('General', 'The.General.1926.1080p'), true);
  assert.equal(check('Salt Marsh', 'Saltmarsh.2002.1080p'), true, 'split or joined differently');
  assert.equal(check('saltmarsh', 'Salt-Marsh.2002.1080p'), true);
  assert.equal(check('Kestrel 2', 'Kestrel.II.1979.1080p'), true);
  // The words in order is not enough: they have to sit together.
  assert.equal(check('Kestrel 2', '[Grp] The Kane Story 2| Kestrel Kane 2 [10bit 1080p][HEVC-x265]'), false);
  assert.equal(check('Night Living Dead', 'Night.of.the.Living.Dead.1968.1080p'), true, 'a long title may have small words in between');
  assert.equal(check('Show S01', 'Show.2019.S01.1080p.WEB'), true, 'a year between title and season does not count');
  const kestrels = results([['Kestrel.Run.1982.Final.Cut.1080p'], ['Kestrel.Run.2049.2017.1080p']]);
  assert.deepEqual(titles(relevantResults('Kestrel Run 2049', kestrels)), ['Kestrel.Run.2049.2017.1080p']);
  assert.equal(check('Wren 2021 1080p bluray', 'Wren.2021.720p.WEB'), true, 'quality words are about the copy, not the title');
  assert.equal(check('Show S01', 'Show.S01E05.1080p'), true);
  assert.equal(check('Ox 2017', 'Ox.2017.1080p'), true);
  assert.equal(check('Ox 2017', 'Boxer.2016.1080p'), false, 'short titles are not matched inside other words');
  assert.equal(check('Five', 'Fivefold.2020'), false);
  // A search with no title in it cannot be judged, so nothing is dropped.
  assert.equal(relevantResults('1080p 2021', wrens).length, 4);
});

test('a title asked for with a digit is found under its spelled-out name', async () => {
  const table = {
    '7 chances': JUNK_FOR_7_CHANCES,
    'seven chances': THE_FILM,
    '7 chances 1925': JUNK_FOR_7_CHANCES_1925,
    'seven chances 1925': THE_FILM,
    'seven chance 1925': THE_FILM,
  };
  const found = async (query) => {
    const jackett = fakeJackett(table);
    return { ...(await createFinder(jackett, { retryCachedEmpty: false }).search(query, [2000])), asked: jackett.asked };
  };

  const bare = await found('7 chances');
  assert.deepEqual(titles(bare.results), titles(results(THE_FILM)), 'the film, best-seeded first, and none of the episodes numbered 07');
  assert.deepEqual([bare.foundAs, bare.exact, bare.asked], ['seven chances', true, ['7 chances', 'seven chances']]);

  const withYear = await found('7 chances 1925');
  assert.deepEqual(titles(withYear.results), titles(results(THE_FILM)));

  // With the actor's name every spelling finds nothing, so the words after the year are dropped.
  const withActor = await found('7 chances 1925 Buster Keaton');
  assert.deepEqual(titles(withActor.results), titles(results(THE_FILM)));
  assert.equal(withActor.foundAs, 'seven chances 1925');
  assert.equal(withActor.also.length, 3);
  assert.deepEqual(withActor.asked, ['7 chances 1925 Buster Keaton', 'seven chances 1925 Buster Keaton', '7 chances 1925', 'seven chances 1925']);

  const misremembered = await found('seven chance 1925 Buster Keaton');
  assert.deepEqual(titles(misremembered.results), titles(results(THE_FILM)));

  // A title that is found as typed costs one search, not one per spelling.
  const direct = await found('Seven Chances 1925');
  assert.deepEqual([direct.asked, direct.also, direct.foundAs], [['Seven Chances 1925'], [], null]);
});

test('when nothing clearly matches, everything is returned but flagged', async () => {
  const jackett = fakeJackett({ zorblax: JUNK_FOR_7_CHANCES });
  const outcome = await createFinder(jackett, { retryCachedEmpty: false }).search('zorblax', []);
  assert.equal(outcome.exact, false);
  assert.equal(outcome.results.length, JUNK_FOR_7_CHANCES.length);
  assert.deepEqual(await createFinder(fakeJackett({})).search('zorblax', []), { results: [], also: [], foundAs: null, exact: false });
});

test('callers that judge relevance themselves get whatever the first fruitful spelling returns', async () => {
  const table = { 'show 2 S01': [], 'show two S01': [['Show.Two.S01.720p', 9], ['Unrelated', 50], ['Show.Two.S01.DEAD', 0]], 'show II S01': [['Never.Reached', 5]] };
  const jackett = fakeJackett(table);
  const tried = [];
  const { results: all } = await createFinder(jackett, { retryCachedEmpty: false }).search('show 2 S01', [5000], { filter: false, onTry: (spelling) => tried.push(spelling) });
  assert.deepEqual(titles(all), ['Unrelated', 'Show.Two.S01.720p'], 'unfiltered, best-seeded first, dead copies dropped');
  assert.deepEqual(jackett.asked, ['show 2 S01', 'show two S01']);
  assert.deepEqual(tried, jackett.asked, 'each search is announced, for the progress display');
});

test('an instant empty answer is Jackett’s cache talking, so it is asked again in other capitals', async () => {
  // Like Jackett's cache, this stand-in tells capitals apart.
  const asked = [];
  const jackett = {
    async search(query) {
      asked.push(query);
      return query === 'Seven Chances 1925' ? results(THE_FILM) : [];
    },
  };
  assert.equal((await createFinder(jackett).search('seven chances 1925', [])).results.length, 2);
  assert.deepEqual(asked, ['seven chances 1925', 'Seven Chances 1925']);

  // An empty answer that took its time came from the indexers, and is believed.
  asked.length = 0;
  const slow = { search: async (query) => (asked.push(query), await new Promise((resolve) => setTimeout(resolve, 30)), []) };
  await createFinder(slow, { cachedAnswerMs: 10 }).search('zorblax', []);
  assert.deepEqual(asked, ['zorblax']);
});

test('a failed spelling is tolerated; a search that fails outright is an error', async () => {
  const oneDown = fakeJackett({ '7 chances': new Error('indexer timed out'), 'seven chances': THE_FILM });
  assert.equal((await createFinder(oneDown, { retryCachedEmpty: false }).search('7 chances', [])).results.length, 2);
  const allDown = fakeJackett({ '7 chances': new Error('Jackett is down'), 'seven chances': new Error('Jackett is down') });
  await assert.rejects(createFinder(allDown).search('7 chances', []), /Jackett is down/);
});
