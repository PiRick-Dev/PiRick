// What a search for a film does when PiRick has a catalogue to go by: the real
// tools and agent, a scripted model, and stand-ins for every service.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.LOG_LEVEL = 'error';

const { sayDate } = await import('../src/catalogue.js');
const { splitQuery } = await import('../src/search.js');
const { filmLine, neighbours, whenDue } = await import('../src/lookups.js');
const { talkTo } = await import('../bench/world.js');

const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });
const film = (query, more = {}) => call('search_media', { query, media_type: 'movie', ...more });
const firstId = (outputs) => outputs.findLast((output) => output.results?.length).results[0].id;

/** A PiRick with the catalogue on, to talk to with a scripted model: see talkTo. */
const pirick = (setup = { catalogue: true }) => talkTo(setup);

test('what a search for a film is made of', () => {
  assert.deepEqual(splitQuery('Charade 1965'), { title: 'Charade', year: 1965, copy: [], episodes: false });
  assert.deepEqual(splitQuery('Charade (1963) 2160p'), { title: 'Charade', year: 1963, copy: ['2160p'], episodes: false });
  // Words after the year are not part of the title, and a year that comes first is.
  assert.deepEqual(splitQuery('7 Chances 1925 Buster Keaton'), { title: '7 Chances', year: 1925, copy: [], episodes: false });
  assert.deepEqual(splitQuery('1808'), { title: '1808', year: null, copy: [], episodes: false });
  assert.deepEqual(splitQuery('1808 1925 1080p BluRay'), { title: '1808', year: 1925, copy: ['1080p', 'BluRay'], episodes: false });
  assert.deepEqual(splitQuery('Night of the Living Dead 4k remux'), { title: 'Night of the Living Dead', year: null, copy: ['4k', 'remux'], episodes: false });
  assert.equal(splitQuery('Copperhollow S02E05').episodes, true);
  assert.deepEqual(splitQuery(''), { title: '', year: null, copy: [], episodes: false });
});

test('what the catalogue knows, put into words', () => {
  const jekyll = { title: 'Dr. Jekyll and Mr. Hyde', year: 1920, directors: ['John S. Robertson'], cast: ['John Barrymore', 'Martha Mansfield', 'Nita Naldi', 'Charles Lane'], about: '1920 silent horror film' };
  assert.equal(filmLine(jekyll), 'Dr. Jekyll and Mr. Hyde (1920), directed by John S. Robertson, with John Barrymore, Martha Mansfield and Nita Naldi');
  // What it is said to be is added only on request, and only when it says something the line does not.
  assert.equal(filmLine(jekyll, { about: true }), filmLine(jekyll));
  assert.equal(filmLine({ title: 'Nosferatu', year: 1922, about: '1922 film directed by F. W. Murnau' }, { about: true }), 'Nosferatu (1922)');
  assert.equal(filmLine({ title: 'Nosferatu', year: 1922, about: 'film about the vampire Count Orlok' }, { about: true }), 'Nosferatu (1922): film about the vampire Count Orlok');
  assert.equal(filmLine({ title: 'Untitled' }), 'Untitled');

  assert.equal(whenDue({ date: '2026-12-18', year: 2026 }), 'on 18 December 2026');
  assert.equal(whenDue({ date: null, year: 2027 }), 'in 2027');
  assert.equal(whenDue({ date: null, year: null }), '');
  assert.equal(neighbours({ follows: { title: 'One', year: 2013 }, followedBy: { title: 'Three', year: 2016 } }), 'It follows One (2013) and is followed by Three (2016).');
  assert.equal(neighbours({ follows: null, followedBy: { title: 'Two', year: null } }), 'It is followed by Two.');
  assert.equal(neighbours({ follows: null, followedBy: null }), '');
});

test('a film is searched for under its proper title and year, whatever was typed', async () => {
  const chat = pirick();
  try {
    // The far better known of two namesakes is taken, and said to be.
    const plain = await chat.say('Can you get Charade?', [film('charade')], 'Which copy would you like?');
    assert.deepEqual(chat.world.trace().searches, ['Charade 1963']);
    assert.equal(plain.outputs[0].catalogue, 'This is Charade (1963). One lesser-known film has the same name.');
    assert.ok(plain.outputs[0].results.length >= 3 && plain.outputs[0].results.every((result) => result.title.startsWith('Charade.1963.')));
    assert.deepEqual(plain.record.statuses, ['Searched for “Charade 1963”: 4 results']);

    // A wrong year is put right in one search, where it used to take two.
    const wrong = await chat.say('The one from 1965.', [film('Charade 1965')], 'Which copy would you like?');
    assert.deepEqual(chat.world.trace().searches, ['Charade 1963', 'Charade 1963']);
    assert.equal(wrong.outputs[0].catalogue, 'No film called “Charade” is from 1965. The film of that name is Charade (1963), and that is what was searched for. One lesser-known film has the same name.');
    assert.deepEqual(wrong.record.statuses, ['Took “Charade” (1965) to be Charade (1963)', 'Searched for “Charade 1963”: 4 results']);

    // A misspelling likewise, and the quality asked for is kept.
    const misspelt = await chat.say('And the cabnet of dr caligary in 720p?', [film('the cabnet of dr caligary 720p')], 'Shall I get it?');
    assert.equal(chat.world.trace().searches.at(-1), 'The Cabinet of Dr. Caligari 1920 720p');
    assert.match(misspelt.outputs[0].catalogue, /^Nothing is called “the cabnet of dr caligary”\. The nearest is The Cabinet of Dr\. Caligari \(1920\), directed by Robert Wiene, and that is what was searched for\.$/);
    assert.deepEqual(misspelt.outputs[0].results.map((result) => result.title), ['The.Cabinet.of.Dr.Caligari.1920.720p.BluRay.x264-GRP']);
    assert.equal(misspelt.record.statuses[0], 'Took “the cabnet of dr caligary” to be The Cabinet of Dr. Caligari (1920)');

    // Another language's title, and what a film follows.
    // Another language's title. Copies go by that name too, so it is searched as well, and what both find is offered.
    const spanish = await chat.say('El acorazado Potemkin?', [film('El acorazado Potemkin')], 'Shall I get it?');
    assert.deepEqual(chat.world.trace().searches.slice(-2), ['Battleship Potemkin 1925', 'El acorazado Potemkin 1925']);
    assert.match(spanish.outputs[0].catalogue, /^This is Battleship Potemkin \(1925\), directed by Sergei Eisenstein\.$/);
    assert.deepEqual(
      spanish.outputs[0].results.map((result) => result.title),
      ['Battleship.Potemkin.1925.1080p.BluRay.x264-GRP', 'El.Acorazado.Potemkin.1925.1080p.BluRay.x264.Spanish-GRP', 'Battleship.Potemkin.1925.720p.BluRay.x264-GRP'],
    );
    assert.deepEqual(spanish.record.statuses, ['Searched for “Battleship Potemkin 1925” and 1 other spelling: 3 results']);
    const sequel = await chat.say('Caminandes Gran Dillama?', [film('Caminandes Gran Dillama')], 'Shall I get it?');
    assert.match(sequel.outputs[0].catalogue, /It follows Caminandes: Llama Drama \(2013\) and is followed by Caminandes: Llamigos \(2016\)\.$/);
    assert.ok(sequel.outputs[0].results.every((result) => result.title.startsWith('Caminandes.2.')));
  } finally {
    chat.close();
  }
});

test('films that share a name are offered before anything is searched for', async () => {
  const chat = pirick();
  try {
    const which = await chat.say('Can you get Dr. Jekyll and Mr. Hyde?', [film('Dr Jekyll and Mr Hyde')], 'There are three. Which year?');
    assert.deepEqual(chat.world.trace().searches, [], 'the indexers were not asked');
    assert.deepEqual(which.outputs[0], {
      results: [],
      catalogue: 'More than one film is called “Dr Jekyll and Mr Hyde”.',
      which_one: [
        'Dr. Jekyll and Mr. Hyde (1920), directed by John S. Robertson, with John Barrymore and Martha Mansfield',
        'Dr. Jekyll and Mr. Hyde (1912), directed by Lucius Henderson, with James Cruze',
        'Dr. Jekyll and Mr. Hyde (1913), directed by Herbert Brenon, with King Baggot',
      ],
      note: 'Nothing was searched for yet. If what the user said settles which of these they mean (a year, a director, an actor), call search_media again with that title and its year. Otherwise ask the user which one, giving the years.',
    });
    assert.deepEqual(which.record.statuses, ['Looked up “Dr Jekyll and Mr Hyde”: 3 films share that name']);

    // With the year, it is one film and one search.
    const one = await chat.say('The 1920 one.', [film('Dr Jekyll and Mr Hyde 1920')], 'Shall I get it?');
    assert.deepEqual(chat.world.trace().searches, ['Dr. Jekyll and Mr. Hyde 1920']);
    // A year the only film of a name is not from.
    const vampire = await chat.say('What about Nosferatu, any year?', [film('Nosferatu 1900')], 'There is one from 1922. Shall I get it?');
    assert.match(vampire.outputs[0].catalogue, /^No film called “Nosferatu” is from 1900./);
    assert.ok(one.outputs[0].results.every((result) => result.title.startsWith('Dr.Jekyll.and.Mr.Hyde.1920.')));
    assert.match(one.outputs[0].catalogue, /^This is Dr\. Jekyll and Mr\. Hyde \(1920\), directed by John S\. Robertson, with John Barrymore and Martha Mansfield\.$/);

    // A year none of them is from: said, and still offered.
    const none = await chat.say('Or the 1950 one?', [film('Dr Jekyll and Mr Hyde 1950')], 'None is from 1950. Which year?');
    assert.equal(none.outputs[0].catalogue, 'No film called “Dr Jekyll and Mr Hyde” is from 1950. More than one film is called “Dr Jekyll and Mr Hyde”.');
    assert.equal(none.outputs[0].which_one.length, 3);
  } finally {
    chat.close();
  }
});

test('a film that is not out yet is not searched for, until the person says to anyway', async () => {
  const chat = pirick();
  try {
    const due = await chat.say('Get Starfall Courier The Last Parcel', [film('Starfall Courier The Last Parcel')], 'That one is not out yet.');
    assert.deepEqual(chat.world.trace().searches, []);
    const date = /It is due on (\d{1,2} \w+ \d{4})\.$/.exec(due.outputs[0].catalogue)?.[1];
    assert.equal(date, sayDate(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)));
    assert.match(due.outputs[0].catalogue, /^Starfall Courier: The Last Parcel \(\d{4}\) is not out yet\./);
    assert.deepEqual(due.outputs[0].results, []);
    assert.match(due.outputs[0].note, /^Nothing was searched for: anything offered under this name before it is out is a fake\./);
    // Saying so is a complete answer: the model is not sent back to "finish".
    assert.equal(due.record.nudges, 0);
    assert.equal(due.record.reply, 'That one is not out yet.');
    assert.match(due.record.statuses[0], /^Not searched for: Starfall Courier: The Last Parcel \(\d{4}\) is not out yet, it is due on /);

    // Told that, they say to look anyway.
    const insisted = await chat.say('Look for it anyway.', [film('Starfall Courier: The Last Parcel')], 'Nothing is out there yet.');
    assert.equal(chat.world.trace().searches.length, 1, 'now it is searched for');
    assert.match(insisted.outputs[0].catalogue, /^This is Starfall Courier: The Last Parcel/);
  } finally {
    chat.close();
  }
});

test('what the catalogue does not know is searched for once, and not finding it is a complete answer', async () => {
  const chat = pirick();
  try {
    const { record, outputs } = await chat.say('Can you find The Zorblax Chronicles from 2019?', [film('The Zorblax Chronicles 2019')], 'I could not find that anywhere. Could the name be different.');
    assert.deepEqual(outputs[0], {
      catalogue: 'The catalogue knows no film called “The Zorblax Chronicles”.',
      results: [],
      note: 'Nothing found, and the catalogue knows no film of this name. Tell the user you could not find it and ask them to check the name. Do not search again under other spellings.',
    });
    assert.equal(record.nudges, 0, 'the model is not pushed to try again');
    assert.equal(record.statuses.includes('Nothing was downloaded this time.'), false);

    // A film that exists, with no copy to be had, is said to be that.
    const noCopy = await chat.say('And Sherlock Jr.?', [film('Sherlock Jr')], 'It exists, but I found no copy of it.');
    assert.match(noCopy.outputs[0].catalogue, /^This is Sherlock Jr\. \(1924\), directed by Buster Keaton, with Buster Keaton\.$/);
    assert.equal(noCopy.outputs[0].note, 'The film exists, but no copy of it was found. Tell the user that. Do not search again under other spellings.');
    assert.equal(noCopy.record.nudges, 0);
  } finally {
    chat.close();
  }
});

test('a show asked for as a film is sent the right way', async () => {
  const chat = pirick();
  try {
    const show = await chat.say('Get Pioneer One', [film('Pioneer One')], 'Shall I get the whole show?');
    assert.deepEqual(show.outputs[0], { results: [], catalogue: 'The catalogue lists Pioneer One (2010) as a TV show, not a film.', note: 'Nothing was searched for. Call find_show for it instead.' });
    assert.deepEqual(chat.world.trace().searches, []);
    // Music, books and the rest are nothing to do with the catalogue.
    const book = await chat.say('Find the Frankenstein audiobook', [call('search_media', { query: 'Frankenstein', media_type: 'book' })], 'Shall I get it?');
    assert.equal(book.outputs[0].catalogue, undefined);
    assert.equal(chat.world.trace().searches.at(-1), 'Frankenstein');
    // Nor is a search that names an episode.
    const episode = await chat.say('Find Copperhollow S02E05', [film('Copperhollow S02E05')], 'Shall I get it?');
    assert.equal(episode.outputs[0].catalogue, undefined);
  } finally {
    chat.close();
  }
});

test('a show is not taken for the film that is named after it, nor a film for the show', async () => {
  const world = {
    films: [{ title: 'Copperhollow: The Film', year: 2025, known: 30 }, { title: 'Nosferatu', year: 1922, known: 60 }],
    shows: [{ id: 1, name: 'Copperhollow', year: 2024, weight: 65, country: 'US', seasons: { 1: 10, 2: 10 } }, { id: 2, name: 'Nosferatu: The Series', year: 2020, weight: 40, country: 'DE', seasons: { 1: 8 } }],
  };
  const chat = talkTo({ catalogue: world });
  try {
    // "Copperhollow" is the show. Only its film is called "Copperhollow: The Film".
    const show = await chat.say('Get Copperhollow', [film('Copperhollow')], 'Shall I get the show?');
    assert.deepEqual(show.outputs[0], { results: [], catalogue: 'The catalogue lists Copperhollow (2024) as a TV show, not a film.', note: 'Nothing was searched for. Call find_show for it instead.' });
    const itsFilm = await chat.say('No, the film', [film('Copperhollow The Film')], 'I could not find a copy.');
    assert.match(itsFilm.outputs[0].catalogue, /^This is Copperhollow: The Film \(2025\)\.$/);
    // And the other way about.
    const aFilm = await chat.say('Get the show Nosferatu', [call('find_show', { title: 'Nosferatu' })], 'That is a film. Shall I get it?');
    assert.deepEqual(aFilm.outputs[0], { found: false, catalogue: 'The catalogue lists Nosferatu (1922) as a film, not a TV show.', note: 'Nothing was looked for. Call search_media for it instead, with media_type set to movie.' });
    const itsShow = await chat.say('No, the series', [call('find_show', { title: 'Nosferatu: The Series' })], 'I could not find a copy.');
    assert.match(itsShow.outputs[0].catalogue, /^This is Nosferatu: The Series \(2020, Germany, 1 season\)\.$/);

    // An obscure film that happens to have the name outright does not stand in for a well-known show known by it.
    const known = talkTo({ catalogue: { films: [{ title: 'Wrenfield', year: 2019, known: 2 }], shows: [{ id: 3, name: 'Wrenfield: The Cross Years', year: 2023, weight: 90, country: 'GB', seasons: { 1: 8 } }] } });
    try {
      const meant = await known.say('Get Wrenfield', [call('find_show', { title: 'Wrenfield' })], 'I could not find a copy.');
      assert.match(meant.outputs[0].catalogue, /^Nothing is called “Wrenfield”\. The nearest is Wrenfield: The Cross Years \(2023, United Kingdom, 1 season\), and that is what was looked for\.$/);
    } finally {
      known.close();
    }
  } finally {
    chat.close();
  }
});

// Small models often leave the kind of thing out. Most such searches are for a film.
test('a search that does not say what kind of thing is wanted still goes by a film of exactly that name', async () => {
  const any = (query) => call('search_media', { query });
  const ELSE = ' If the user is after something else of this name (an album, a book, a game), call search_media again with media_type set to that.';
  const chat = pirick();
  try {
    const one = await chat.say('Find Charade from 1965', [any('Charade 1965')], 'Which copy?');
    assert.deepEqual(chat.world.trace().searches, ['Charade 1963']);
    assert.match(one.outputs[0].catalogue, /^No film called “Charade” is from 1965\. The film of that name is Charade \(1963\)/);

    const several = await chat.say('Find Dr Jekyll and Mr Hyde', [call('search_media', { query: 'Dr Jekyll and Mr Hyde', media_type: 'any' })], 'Which year?');
    assert.equal(chat.world.trace().searches.length, 1, 'nothing more was searched for');
    assert.equal(several.outputs[0].which_one.length, 3);
    assert.match(several.outputs[0].which_one[0], /with John Barrymore/);
    assert.ok(several.outputs[0].note.endsWith(`giving the years.${ELSE}`));

    const due = await chat.say('Find Starfall Courier The Last Parcel', [any('Starfall Courier The Last Parcel')], 'It is not out yet.');
    assert.equal(chat.world.trace().searches.length, 1);
    assert.match(due.outputs[0].catalogue, /is not out yet\. It is due on /);
    assert.ok(due.outputs[0].note.endsWith(`looked for anyway.${ELSE}`));
    assert.equal(due.record.nudges, 0);

    // A film whose name is only close is not acted on: it could as well be an album.
    const close = await chat.say('Find the cabnet of dr caligary', [any('the cabnet of dr caligary')], 'Which copy?');
    assert.equal(chat.world.trace().searches.at(-1), 'the cabnet of dr caligary', 'the search is not rewritten');
    assert.equal(close.outputs[0].catalogue, 'The catalogue has a film with a name like this: The Cabinet of Dr. Caligari (1920).');

    // A show is pointed out, and the search still made as asked.
    const show = await chat.say('Find Pioneer One', [any('Pioneer One')], 'Shall I get it?');
    assert.equal(chat.world.trace().searches.at(-1), 'Pioneer One');
    assert.equal(show.outputs[0].catalogue, 'The catalogue lists Pioneer One (2010) as a TV show, not a film. If that is what the user wants, call find_show for it.');
    assert.ok(show.outputs[0].results.length > 0);

    // Neither a film nor a show: said, searched for once, and not finding it is a complete answer.
    const nothing = await chat.say('Find The Zorblax Chronicles', [any('The Zorblax Chronicles')], 'I could not find that anywhere.');
    assert.deepEqual(nothing.outputs[0], {
      catalogue: 'The catalogue knows no film or show called “The Zorblax Chronicles”.',
      results: [],
      note: 'Nothing found, and the catalogue knows no film or show of this name. Tell the user you could not find it and ask them to check the name. Do not search again under other spellings.',
    });
    assert.equal(nothing.record.nudges, 0);
  } finally {
    chat.close();
  }
});

test('with a catalogue, the model has to say what kind of thing it is searching for', async () => {
  const withIt = pirick();
  const without = pirick({});
  try {
    const required = async (chat) => (await chat.say('Hello', [], 'Hello! What would you like?')).tools.find((tool) => tool.function.name === 'search_media').function.parameters.required;
    assert.deepEqual(await required(withIt), ['query', 'media_type']);
    assert.deepEqual(await required(without), ['query']);
  } finally {
    withIt.close();
    without.close();
  }
});

test('Plex is asked for the film the catalogue named, under its original title too', async () => {
  const chat = pirick({ catalogue: true, plex: { films: [{ title: 'Das Cabinet des Dr. Caligari', year: 1920 }] } });
  try {
    const { outputs, record } = await chat.say('Get the Cabinet of Dr Caligari', [film('Cabinet of Dr Caligari'), (seen) => call('download', { result_id: firstId(seen), library: 'Movies' })], 'You already have it. Another copy?');
    assert.equal(outputs[0].plex, 'Plex already has Das Cabinet des Dr. Caligari (1920). Which copy or quality it has is not known.');
    assert.ok(outputs[0].results.every((result) => result.user_has_this_film === true));
    assert.equal(outputs[1].already_in_plex, 'Das Cabinet des Dr. Caligari (1920)');
    assert.equal(chat.world.trace().added.length, 0);
    assert.deepEqual(record.statuses.slice(-2), ['Already in Plex: Das Cabinet des Dr. Caligari (1920)', 'Not downloaded: Plex already has Das Cabinet des Dr. Caligari (1920)']);
  } finally {
    chat.close();
  }
});

test('without the catalogue, or when it cannot be reached, searching is as it always was', async () => {
  const without = pirick({});
  const lost = pirick();
  try {
    lost.world.catalogueServices.setDown('all');
    const before = await without.say('Get Charade from 1965', [film('Charade 1965')], 'Which copy?');
    const after = await lost.say('Get Charade from 1965', [film('Charade 1965')], 'Which copy?');
    const plain = (output) => ({ ...output, results: output.results.map(({ id, ...rest }) => rest) });
    assert.deepEqual(plain(after.outputs[0]), plain(before.outputs[0]));
    assert.equal(before.outputs[0].catalogue, undefined);
    assert.deepEqual(without.world.trace().searches, lost.world.trace().searches);
    assert.deepEqual(after.record.statuses, before.record.statuses);

    // The model is told about the catalogue only when there is one.
    assert.equal(before.prompt.includes('catalogue'), false);
    assert.match(after.prompt, /PiRick has a catalogue of the films and shows that exist\./);
    assert.equal(without.world.catalogueServices, null);
  } finally {
    without.close();
    lost.close();
  }
});

test('a description never sits beside a download id', async () => {
  const chat = pirick();
  try {
    // Nosferatu's description says more than its year and director, so it is one that would be passed on.
    const { outputs } = await chat.say('Get Nosferatu', [film('Nosferatu')], 'Shall I get it?');
    assert.ok(outputs[0].results.length > 0 && outputs[0].results.every((result) => result.id));
    assert.equal(JSON.stringify(outputs[0]).includes('Count Orlok'), false);
    assert.equal(outputs[0].catalogue, 'This is Nosferatu (1922), directed by F. W. Murnau, with Max Schreck.');
  } finally {
    chat.close();
  }
});

test('a new film with the name of an old one is offered beside it, however well known the films named after them', async () => {
  const later = ['Undertow', 'Landfall', 'Deep Water', 'The Long Dark', 'Riptide', 'Last Light', 'Breakwater', 'Low Tide'];
  const films = [
    { title: 'Harrow Deep', year: 2002, known: 57, directors: ['Ines Carrow'] },
    { title: 'Harrow Deep', year: 2025, known: 27, directors: ['Tobin Marsh'] },
    ...later.map((name, i) => ({ title: `Harrow Deep: ${name}`, year: 2004 + i, known: 40 + i })),
  ];
  const chat = talkTo({ catalogue: { films } });
  try {
    const which = await chat.say('Get Harrow Deep', [film('Harrow Deep')], 'The one from 2002, or the new one?');
    assert.deepEqual(which.outputs[0].which_one, ['Harrow Deep (2002), directed by Ines Carrow', 'Harrow Deep (2025), directed by Tobin Marsh']);
    assert.deepEqual(chat.world.trace().searches, [], 'nothing is searched for until it is known which');
  } finally {
    chat.close();
  }
});

test('a film whose name ends in what reads as a year is that film, and the films whose names begin with one are passed on with it', async () => {
  const soon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const films = [
    { title: 'Harrow Deep', year: 1982, known: 84, directors: ['Ines Carrow'] },
    { title: 'Harrow Deep 2049', year: 2017, known: 70, directors: ['Tobin Marsh'] },
    { title: 'Kestrel Rising', year: 2012, known: 80, directors: ['Ines Carrow'] },
    { title: 'Kestrel Rising: Nightfall', year: 2018, known: 50 },
    { title: 'Kestrel Rising: Last Light', date: soon, known: 30 },
  ];
  const chat = talkTo({ catalogue: { films } });
  try {
    // No film called Harrow Deep is from 2049, and one is called exactly "Harrow Deep 2049".
    const dated = await chat.say('Get Harrow Deep 2049', [film('Harrow Deep 2049')], 'I could not find a copy.');
    assert.equal(dated.outputs[0].catalogue, 'This is Harrow Deep 2049 (2017), directed by Tobin Marsh.');
    assert.equal(chat.world.trace().searches[0], 'Harrow Deep 2049 2017');
    // A year is still a year where no film has it in its name.
    const wrong = await chat.say('Get Harrow Deep from 1985', [film('Harrow Deep 1985')], 'I could not find a copy.');
    assert.match(wrong.outputs[0].catalogue, /^No film called “Harrow Deep” is from 1985\. The film of that name is Harrow Deep \(1982\)/);

    // "The new one" and "the third one" are among the films whose names begin the same way, which come with it, newest first.
    const after = [`Kestrel Rising: Last Light (${soon.slice(0, 4)}), not out yet`, 'Kestrel Rising: Nightfall (2018)'];
    const asked = await chat.say('Is the new Kestrel Rising out?', [call('look_up', { title: 'Kestrel Rising', kind: 'film' })], 'Not yet.');
    assert.deepEqual(asked.outputs[0].names_that_begin_the_same, after);
    const fetched = await chat.say('Get Kestrel Rising then', [film('Kestrel Rising')], 'I could not find a copy.');
    assert.equal(fetched.outputs[0].catalogue, `This is Kestrel Rising (2012), directed by Ines Carrow. Other films whose names begin the same way: ${after.join('; ')}.`);
    // Asked for by its full name, a film has none named after it.
    const one = await chat.say('What is Kestrel Rising: Nightfall?', [call('look_up', { title: 'Kestrel Rising: Nightfall', kind: 'film' })], 'A film from 2018.');
    assert.equal(one.outputs[0].names_that_begin_the_same, undefined);
  } finally {
    chat.close();
  }
});

test('a little-known film does not stand in for a well-known show of the same name', async () => {
  const chat = talkTo({
    catalogue: {
      films: [{ title: 'Saltmarsh', year: 2016, known: 5, directors: ['Ines Carrow'] }],
      shows: [{ id: 1, name: 'Saltmarsh', year: 2023, weight: 100, country: 'US', seasons: { 1: 9, 2: 7 } }],
    },
  });
  const SHOW = 'The catalogue lists Saltmarsh (2023) as a TV show, far better known than the film of the same name, Saltmarsh (2016).';
  try {
    // Asked for with no kind given: the show is pointed out, and the search made as asked, not for the film.
    const any = await chat.say('Find Saltmarsh', [call('search_media', { query: 'Saltmarsh', media_type: 'any' })], 'Do you mean the show?');
    assert.equal(any.outputs[0].catalogue, `${SHOW} If the show is what the user wants, call find_show for it.`);
    assert.deepEqual(chat.world.trace().searches, ['Saltmarsh']);

    // Asked for as a film: nothing is searched for until it is known that the film is meant.
    const sure = await chat.say('The film Saltmarsh', [film('Saltmarsh')], 'Do you mean the show, or the film from 2016?');
    assert.deepEqual(sure.outputs[0], {
      results: [],
      catalogue: SHOW,
      note: 'Nothing was searched for. If the user means the show, call find_show for it instead. If they do mean the film, call search_media again with its year: Saltmarsh 2016.',
    });
    assert.deepEqual(chat.world.trace().searches, ['Saltmarsh']);

    const meant = await chat.say('The film from 2016', [film('Saltmarsh 2016')], 'I could not find a copy of it.');
    assert.equal(meant.outputs[0].catalogue, 'This is Saltmarsh (2016), directed by Ines Carrow.');
    assert.equal(chat.world.trace().searches.at(-1), 'Saltmarsh 2016');
  } finally {
    chat.close();
  }
});
