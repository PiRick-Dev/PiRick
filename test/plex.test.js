// Everything PiRick does with Plex, against a stand-in Plex server.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { after, test } from 'node:test';

// Every log line is kept, so that it can be checked that none carries the token.
process.env.LOG_LEVEL = 'debug';
const logged = [];
console.log = (line) => logged.push(String(line));
console.error = (line) => logged.push(String(line));

const { build } = await import('../src/build.js');
const { loadConfig } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { pathBelow } = await import('../src/folders.js');
const { createPlex, matchLibrary, plexPath } = await import('../src/plex.js');
const { createSettings, parsePlexChoice } = await import('../src/settings.js');
const { createUpkeep } = await import('../src/upkeep.js');
const { PLEX_TOKEN, PLEX_URL, plexStandIn } = await import('../bench/plex.js');
const { createWorld, scripted } = await import('../bench/world.js');

const MINUTE = 60 * 1000;
const hashOf = (title) => createHash('sha1').update(title).digest('hex');

/** What a household's Plex might hold. Each call is a server of its own. */
const household = () =>
  plexStandIn([
    {
      key: '1',
      title: 'Films',
      type: 'movie',
      folders: ['/data/Movies'],
      items: [
        { title: 'Charade', year: 1963 },
        { title: 'Seven Chances', year: 1925 },
        { title: "Tol'able David", year: 1921 },
        { title: 'Dr. Jekyll and Mr. Hyde', year: 1920 },
        { title: 'Das Cabinet des Dr. Caligari', originalTitle: 'The Cabinet of Dr. Caligari', year: 1920 },
      ],
    },
    {
      key: '2',
      title: 'TV Shows',
      type: 'show',
      folders: ['/data/TV'],
      items: [
        { title: 'Brindlemoor', year: 2015, seasons: { 0: 2, 1: 10, 2: [1, 2, 3] } },
        { title: 'Kestrelmere', year: 1963, seasons: { 1: 4 } },
        { title: 'Kestrelmere', year: 2005, seasons: { 1: 8 } },
      ],
    },
    { key: '5', title: 'TV in 4K', type: 'show', folders: ['/data/TV 4K'], items: [{ title: 'Brindlemoor', year: 2015, seasons: { 2: [4], 3: 1 } }] },
  ]);
const clientFor = (server, config = {}) => createPlex({ url: PLEX_URL, token: PLEX_TOKEN, timeoutMs: 5000, ...config }, { fetch: server.fetch });

const servers = [];
after(() => {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
});

/** Puts a stand-in on a real port, for the tests that go over the network. */
async function listen(standIn) {
  const server = http.createServer(async (req, res) => {
    try {
      const response = await standIn.fetch(`http://plex${req.url}`, { headers: req.headers });
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'text/plain' }).end(await response.text());
    } catch {
      // The stand-in is playing a server that is not there.
      req.socket.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test('a library is matched to the Plex folder its path ends like, unless an admin chose', () => {
  const plexLibraries = [
    { key: '1', title: 'Films', type: 'movie', folders: ['/data/Movies', '/data/More/Movies 2'] },
    { key: '2', title: 'TV Shows', type: 'show', folders: ['/data/TV'] },
    { key: '3', title: 'Kids TV', type: 'show', folders: ['/data/Kids/TV'] },
  ];
  const library = (savePath) => ({ id: 1, savePath });
  assert.deepEqual(matchLibrary(library('/media/TV'), plexLibraries), { key: '2', title: 'TV Shows', path: '/data/TV', chosen: false });
  // The more of the path that agrees, the better the match; capitals and separators do not matter.
  assert.equal(matchLibrary(library('/mnt/pool/kids/tv'), plexLibraries).key, '3');
  assert.equal(matchLibrary(library('D:\\Media\\Movies'), plexLibraries).path, '/data/Movies');
  assert.equal(matchLibrary(library('/media/Anime'), plexLibraries), null);

  assert.deepEqual(matchLibrary(library('/media/Anime'), plexLibraries, { key: '3', path: '/data/Kids/TV' }), { key: '3', title: 'Kids TV', path: '/data/Kids/TV', chosen: true });
  assert.equal(matchLibrary(library('/media/TV'), plexLibraries, { none: true }), null);
  // A chosen folder that Plex no longer has falls back to the worked-out match.
  assert.equal(matchLibrary(library('/media/TV'), plexLibraries, { key: '9', path: '/gone' }).chosen, false);

  assert.deepEqual(parsePlexChoice({ choice: 'auto' }), { choice: null });
  assert.deepEqual(parsePlexChoice({ choice: 'none' }), { choice: { none: true } });
  assert.deepEqual(parsePlexChoice({ choice: { key: '3', title: 'ignored', path: '/data/Kids/TV' } }), { choice: { key: '3', path: '/data/Kids/TV' } });
  for (const bad of [{}, { choice: 'everything' }, { choice: { key: '../1', path: '/x' } }, { choice: { key: '1' } }, { choice: { key: '1', path: 'a\nb' } }, null]) {
    assert.ok(parsePlexChoice(bad).error, JSON.stringify(bad));
  }
});

test('a folder is translated from the path qBittorrent uses to the one Plex uses', () => {
  assert.deepEqual(pathBelow('/media/TV', '/media/TV/Brindlemoor/Season 1'), ['Brindlemoor', 'Season 1']);
  assert.deepEqual(pathBelow('/media/TV', '/media/TV/'), []);
  assert.equal(pathBelow('/media/TV', '/media/TV 4K/Brindlemoor'), null, 'a folder whose name merely starts the same is not inside');
  assert.equal(pathBelow('/media/TV', '/media/tv/Brindlemoor'), null, 'capitals matter on Linux');
  assert.deepEqual(pathBelow('D:\\Media\\TV', 'd:\\media\\tv\\Brindlemoor'), ['Brindlemoor'], 'and do not on Windows');
  assert.equal(pathBelow('/media/TV', undefined), null);

  const match = { key: '2', path: '/data/TV' };
  assert.equal(plexPath({ savePath: '/media/TV' }, match, '/media/TV/Brindlemoor'), '/data/TV/Brindlemoor');
  assert.equal(plexPath({ savePath: '/media/TV' }, match, '/media/TV'), '/data/TV');
  assert.equal(plexPath({ savePath: '/media/TV' }, match, '/media/Movies/Charade'), null);
  // Each program keeps its own kind of path.
  assert.equal(plexPath({ savePath: 'D:\\Media\\TV' }, match, 'D:\\Media\\TV\\Brindlemoor'), '/data/TV/Brindlemoor');
  assert.equal(plexPath({ savePath: '/media/TV' }, { path: 'E:\\Plex\\TV\\' }, '/media/TV/Brindlemoor'), 'E:\\Plex\\TV\\Brindlemoor');
});

test('the client reads a Plex server over the network, with the token in a header and nowhere else', async () => {
  const server = household();
  const url = await listen(server);
  const plex = createPlex({ url, token: PLEX_TOKEN, timeoutMs: 5000 });
  assert.equal(plex.enabled, true);

  assert.equal(await plex.check(), 'Home 1.41.0.8994, 3 libraries');
  assert.deepEqual((await plex.libraries())[1], { key: '2', title: 'TV Shows', type: 'show', folders: ['/data/TV'] });

  await plex.scan('2', '/data/TV/Wrenfield Cross & Co');
  await plex.scan('1');
  assert.deepEqual(server.scans, [{ key: '2', path: '/data/TV/Wrenfield Cross & Co' }, { key: '1', path: null }]);

  assert.ok(server.requests.length >= 4);
  for (const request of server.requests) {
    assert.equal(request.token, PLEX_TOKEN);
    assert.equal((request.path + request.search).includes(PLEX_TOKEN), false, 'never in an address');
  }

  // A wrong token, a wrong address and a server that is not there are each said plainly.
  await assert.rejects(createPlex({ url, token: 'wrong', timeoutMs: 5000 }).check(), { name: 'UpstreamError', message: 'Plex rejected the token: check PLEX_TOKEN' });
  const elsewhere = await listen({ fetch: async () => new Response('<html>some other program</html>', { status: 200 }) });
  await assert.rejects(createPlex({ url: elsewhere, token: PLEX_TOKEN, timeoutMs: 5000 }).check(), /Plex did not answer as expected: check PLEX_URL/);
  const moved = await listen({ fetch: async () => new Response('', { status: 302, headers: { 'Content-Type': 'text/plain' } }) });
  await assert.rejects(createPlex({ url: moved, token: PLEX_TOKEN, timeoutMs: 5000 }).libraries(), /Plex returned HTTP 302|Cannot reach Plex/);
  server.setDown(true);
  await assert.rejects(clientFor(server).libraries(), (err) => {
    assert.match(err.message, /^Cannot reach Plex at http:\/\/plex\.invalid:32400 \(ECONNREFUSED\)$/);
    return true;
  });

  // Left out of the settings, PiRick has no Plex and says so only if asked.
  const off = createPlex({ url: '', token: '', timeoutMs: 5000 });
  assert.equal(off.enabled, false);
  await assert.rejects(off.check(), /PLEX_URL is not set/);
  assert.equal(createPlex({ url, token: '', timeoutMs: 5000 }).enabled, false);
});

test('the settings accept only a plain address for Plex, and never repeat what was entered', () => {
  assert.deepEqual(loadConfig({}).plex, { url: '', token: '', timeoutMs: 15_000 });
  assert.deepEqual(loadConfig({ PLEX_URL: ' http://plex.lan:32400/ ', PLEX_TOKEN: ' abc ' }).plex, { url: 'http://plex.lan:32400', token: 'abc', timeoutMs: 15_000 });
  for (const bad of ['plex.lan:32400', 'ftp://plex.lan', 'http://plex.lan:32400/?X-Plex-Token=secret-in-address', 'http://user:secret-in-address@plex.lan:32400']) {
    assert.throws(() => loadConfig({ PLEX_URL: bad }), (err) => /PLEX_URL must be only the address/.test(err.message) && !err.message.includes('secret-in-address'), bad);
  }
});

test('films are recognised by title and year, however the title is written', async () => {
  const server = household();
  const plex = clientFor(server);
  const titles = async (...args) => (await plex.films(...args)).map((film) => `${film.title} (${film.year})`);

  assert.deepEqual(await titles('Charade', 1963), ['Charade (1963)']);
  assert.deepEqual(await plex.films('Charade', 1963), [{ id: '100', title: 'Charade', year: 1963, library: 'Films' }]);
  // Sources disagree by a year about when a film came out, not by two.
  assert.deepEqual(await titles('charade', 1964), ['Charade (1963)']);
  assert.deepEqual(await titles('Charade', 1965), []);
  assert.deepEqual(await titles('Charade'), ['Charade (1963)']);
  // Numbers, apostrophes and full stops are written differently in release names.
  assert.deepEqual(await titles('7 Chances', 1925), ['Seven Chances (1925)']);
  assert.deepEqual(await titles('Tolable David', 1921), ["Tol'able David (1921)"]);
  assert.deepEqual(await titles('Dr Jekyll and Mr Hyde', 1920), ['Dr. Jekyll and Mr. Hyde (1920)']);
  // Filed under its German name, with the English one as the original title.
  assert.deepEqual(await titles('The Cabinet of Dr Caligari', 1920), ['Das Cabinet des Dr. Caligari (1920)']);
  // A title that only contains the words is another film.
  assert.deepEqual(await titles('Chances', 1925), []);
  assert.deepEqual(await titles('Night of the Living Dead', 1968), []);
  // Plex is asked for one plain word at a time, two at most, and the comparing is done here.
  assert.deepEqual(server.requests.slice(-2).map((request) => request.search), ['?type=1&title=living', '?type=1&title=night']);
});

test('a show is reported with the episodes Plex has of each season', async () => {
  const plex = clientFor(household());
  const show = await plex.show('Brindlemoor');
  assert.deepEqual([show.title, show.year], ['Brindlemoor', 2015]);
  // Specials are left out, and one show kept in two libraries is added together.
  assert.deepEqual([...show.seasons].map(([season, episodes]) => [season, [...episodes].sort((a, b) => a - b)]), [[1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], [2, [1, 2, 3, 4]], [3, [1]]]);

  assert.equal(await plex.show('Wrenfield Cross'), null);
  // Two shows share this name: nothing is claimed unless the year says which.
  assert.equal(await plex.show('Kestrelmere'), null);
  assert.equal((await plex.show('Kestrelmere', 2005)).seasons.get(1).size, 8);
  assert.equal((await plex.show('Kestrelmere', 1964)).seasons.get(1).size, 4);
  assert.equal(await plex.show('Kestrelmere', 1980), null);
});

/** A torrent as qBittorrent lists it. */
const torrent = (name, extra = {}) => ({
  hash: hashOf(name),
  name,
  progress: 0,
  completed: 0,
  state: 'downloading',
  tags: 'pirick, pirick-alice',
  save_path: '/media/TV/Wrenfield Cross',
  content_path: `/media/TV/Wrenfield Cross/${name}`,
  category: '',
  ...extra,
});

/** Upkeep over a stand-in qBittorrent and Plex, with a clock that the test moves. */
function watching(torrents, { plexServer = household(), connected = true } = {}) {
  const db = openDb(':memory:');
  const settings = createSettings(db);
  const libraries = {
    movies: settings.addLibrary({ name: 'Movies', description: '', savePath: '/media/Movies', perTitle: false, category: '' }),
    tv: settings.addLibrary({ name: 'TV', description: '', savePath: '/media/TV', perTitle: true, category: '' }),
    music: settings.addLibrary({ name: 'Music', description: '', savePath: '/media/Music', perTitle: false, category: '' }),
  };
  const clock = { time: Date.UTC(2026, 0, 1) };
  const state = { torrents };
  const qbit = { tagged: async () => state.torrents.map((entry) => ({ ...entry })) };
  const plex = connected ? clientFor(plexServer) : createPlex({ url: '', token: '' });
  const upkeep = createUpkeep({ db, qbit, jackett: {}, settings, config: loadConfig({}), plex, now: () => clock.time });
  const look = async (minutesLater = 1) => {
    clock.time += minutesLater * MINUTE;
    return upkeep.look();
  };
  const notes = (username = 'alice') => upkeep.unseen(username).map((event) => event.detail);
  const finish = (...names) => {
    for (const entry of state.torrents) if (!names.length || names.includes(entry.name)) Object.assign(entry, { progress: 1, state: 'uploading' });
  };
  return { upkeep, settings, libraries, state, plexServer, look, notes, finish };
}

test('when a download finishes, Plex is asked to look at its folder and whoever asked is told, once', async () => {
  const episode = torrent('Wrenfield.Cross.S03E01.1080p.WEB.H264-GRP');
  const { upkeep, plexServer, look, notes, finish } = watching([episode]);

  assert.deepEqual(await look(), { watching: 1 });
  assert.deepEqual(plexServer.scans, []);
  assert.deepEqual(notes(), []);
  assert.equal(upkeep.inPlex().size, 0);

  finish();
  assert.deepEqual(await look(), { watching: 0 });
  // The show's folder, as Plex sees it, in the library that folder belongs to.
  assert.deepEqual(plexServer.scans, [{ key: '2', path: '/data/TV/Wrenfield Cross' }]);
  assert.deepEqual(notes(), ['“Wrenfield Cross (S03E01)” has finished downloading and Plex has been asked to add it.']);
  assert.deepEqual([...upkeep.inPlex()], [episode.hash]);
  assert.deepEqual(upkeep.overview(), { watching: 0, stuck: 0 }, 'a finished download is no longer being watched');
  assert.equal(upkeep.recent()[0].action, 'finished');

  await look();
  await look(60);
  // The stuck-download check sees the same finished torrent and has nothing to add.
  assert.deepEqual(await upkeep.runOnce(), { watching: 0, stuck: 0, replaced: 0 });
  assert.equal(plexServer.scans.length, 1);
  assert.equal(notes().length, 1);
  assert.deepEqual(notes('bob'), [], 'nobody else is told');
});

test('a download that finishes before it was ever seen unfinished is noticed if the chat started it, and is old news otherwise', async () => {
  const quick = torrent('Charade.1963.1080p.BluRay.x264-GRP', { progress: 1, state: 'uploading', save_path: '/media/Movies', content_path: '/media/Movies/Charade.1963.1080p.BluRay.x264-GRP' });
  const old = torrent('Nosferatu.1922.1080p.BluRay.x264-GRP', { progress: 1, state: 'uploading', save_path: '/media/Movies', content_path: '/media/Movies/Nosferatu.1922.1080p.BluRay.x264-GRP.mkv' });
  const { upkeep, plexServer, look, notes } = watching([quick, old]);

  // What the download tool does the moment qBittorrent accepts a torrent.
  upkeep.track({ hash: quick.hash, name: quick.name, username: 'Alice' });
  upkeep.track({ hash: quick.hash, name: 'said twice', username: 'bob' });
  await look();
  // A film in a library without subfolders: its own folder is enough to look at.
  assert.deepEqual(plexServer.scans, [{ key: '1', path: '/data/Movies/Charade.1963.1080p.BluRay.x264-GRP' }]);
  assert.deepEqual(notes(), ['“Charade (1963)” has finished downloading and Plex has been asked to add it.']);
  assert.deepEqual([...upkeep.inPlex()], [quick.hash]);
});

test('several finishes in one folder make one request and one note', async () => {
  const episodes = [1, 2, 3].map((number) => torrent(`Wrenfield.Cross.S03E0${number}.1080p.WEB.H264-GRP`));
  const film = torrent('Sintel.2010.1080p.BluRay.x264-GRP', { save_path: '/media/Movies', content_path: '/media/Movies/Sintel.2010.1080p.BluRay.x264-GRP.mkv' });
  const { upkeep, state, plexServer, look, notes, finish } = watching([...episodes, film]);
  await look();

  finish();
  await look();
  // A film that is one loose file has no folder of its own, so its library's folder is looked at.
  assert.deepEqual(plexServer.scans, [{ key: '2', path: '/data/TV/Wrenfield Cross' }, { key: '1', path: '/data/Movies' }]);
  assert.deepEqual(notes(), [
    '3 downloads of “Wrenfield Cross” have finished (S03E01, S03E02, S03E03) and Plex has been asked to add them.',
    '“Sintel (2010)” has finished downloading and Plex has been asked to add it.',
  ]);

  // More of the same show, minutes later: Plex is asked again, and the note that has not been read yet grows.
  state.torrents.push(torrent('Wrenfield.Cross.S03E04.1080p.WEB.H264-GRP'), torrent('Wrenfield.Cross.S04.1080p.WEB-DL.DDP5.1.H.264-GRP'));
  await look(5);
  finish();
  await look(5);
  assert.equal(plexServer.scans.length, 3);
  assert.deepEqual(notes(), [
    '5 downloads of “Wrenfield Cross” have finished (S03E01, S03E02, S03E03, S03E04, season 4) and Plex has been asked to add them.',
    '“Sintel (2010)” has finished downloading and Plex has been asked to add it.',
  ]);

  // Once it has been read, later news is a new note.
  upkeep.markSeen(upkeep.unseen('alice').map((event) => event.id));
  state.torrents.push(torrent('Wrenfield.Cross.S03E05.1080p.WEB.H264-GRP'));
  await look();
  finish();
  await look();
  assert.deepEqual(notes(), ['“Wrenfield Cross (S03E05)” has finished downloading and Plex has been asked to add it.']);
});

test('without Plex, or where Plex has no part, a finish is still told but nothing is sent', async () => {
  const episode = torrent('Wrenfield.Cross.S03E01.1080p.WEB.H264-GRP');
  const off = watching([episode], { connected: false });
  await off.look();
  off.finish();
  await off.look();
  assert.deepEqual(off.notes(), ['“Wrenfield Cross (S03E01)” has finished downloading.']);
  assert.equal(off.upkeep.inPlex().size, 0);
  assert.deepEqual(off.plexServer.requests, []);

  // Connected, but this library is not one Plex has: nothing in Plex ends in "Music".
  const album = torrent('Artist - Album [FLAC]', { save_path: '/media/Music', content_path: '/media/Music/Artist - Album [FLAC]' });
  // And one an admin has said is not in Plex, whatever its folder is called.
  const film = torrent('Charade.1963.1080p.BluRay.x264-GRP', { save_path: '/media/Movies', content_path: '/media/Movies/Charade.1963.1080p.BluRay.x264-GRP' });
  // And one saved somewhere that is no library at all.
  const stray = torrent('Sintel.2010.1080p.BluRay.x264-GRP', { save_path: '/downloads', content_path: '/downloads/Sintel.2010.1080p.BluRay.x264-GRP' });
  const on = watching([album, film, stray]);
  on.settings.setPlexChoice(on.libraries.movies.id, { none: true });
  await on.look();
  on.finish();
  await on.look();
  assert.deepEqual(on.plexServer.scans, []);
  assert.deepEqual(on.notes(), ['“Artist - Album” has finished downloading.','“Charade (1963)” has finished downloading.', '“Sintel (2010)” has finished downloading.']);
  assert.equal(on.upkeep.inPlex().size, 0);

  // An admin's choice of folder is the one used.
  const chosen = watching([torrent('Wrenfield.Cross.S03E01.1080p.WEB.H264-GRP')]);
  chosen.settings.setPlexChoice(chosen.libraries.tv.id, { key: '5', path: '/data/TV 4K' });
  await chosen.look();
  chosen.finish();
  await chosen.look();
  assert.deepEqual(chosen.plexServer.scans, [{ key: '5', path: '/data/TV 4K/Wrenfield Cross' }]);
});

test('if Plex cannot be reached it is asked again on the next looks, and the note waits for the outcome', async () => {
  const episode = torrent('Wrenfield.Cross.S03E01.1080p.WEB.H264-GRP');
  const { upkeep, plexServer, look, notes, finish } = watching([episode]);
  await look();
  plexServer.setDown(true);
  finish();
  await look();
  await look();
  assert.deepEqual(notes(), [], 'not told yet: it is not known whether Plex will hear of it');
  assert.equal(upkeep.inPlex().size, 0);
  assert.deepEqual(upkeep.overview(), { watching: 0, stuck: 0 });

  plexServer.setDown(false);
  await look();
  assert.deepEqual(plexServer.scans, [{ key: '2', path: '/data/TV/Wrenfield Cross' }]);
  assert.deepEqual(notes(), ['“Wrenfield Cross (S03E01)” has finished downloading and Plex has been asked to add it.']);

  // Still unreachable after five goes: the person is told it finished, and no more.
  const lost = watching([torrent('Wrenfield.Cross.S03E02.1080p.WEB.H264-GRP')]);
  await lost.look();
  lost.plexServer.setDown(true);
  lost.finish();
  for (let i = 0; i < 4; i++) await lost.look();
  assert.deepEqual(lost.notes(), []);
  await lost.look();
  assert.deepEqual(lost.notes(), ['“Wrenfield Cross (S03E02)” has finished downloading.']);
  lost.plexServer.setDown(false);
  await lost.look();
  assert.deepEqual(lost.plexServer.scans, [], 'and it is left at that');
  assert.equal(lost.notes().length, 1);
});

test('a download still being moved into place is not announced, and one that starts again is watched again', async () => {
  const episode = torrent('Wrenfield.Cross.S03E01.1080p.WEB.H264-GRP');
  const { upkeep, state, plexServer, look, notes } = watching([episode]);
  await look();
  Object.assign(state.torrents[0], { progress: 1, state: 'moving' });
  await look();
  assert.deepEqual(plexServer.scans, []);
  state.torrents[0].state = 'uploading';
  await look();
  assert.equal(plexServer.scans.length, 1);

  // Its files are lost and qBittorrent fetches it again: it is unfinished, with a fresh clock, not stuck since long ago.
  Object.assign(state.torrents[0], { progress: 0.2, state: 'stalledDL' });
  await look(24 * 60);
  assert.deepEqual(upkeep.overview(), { watching: 1, stuck: 0 });
  assert.equal(upkeep.inPlex().size, 0);
  assert.deepEqual(await upkeep.runOnce(), { watching: 1, stuck: 0, replaced: 0 });
  Object.assign(state.torrents[0], { progress: 1, state: 'uploading' });
  await look();
  assert.equal(plexServer.scans.length, 2);
  assert.equal(notes().length, 1, 'both finishes of the one episode stay a single note until it is read');

  // Removed from qBittorrent: forgotten.
  state.torrents = [];
  await look(5);
  assert.equal(upkeep.inPlex().size, 0);
});

const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });
const say = (content) => ({ role: 'assistant', content });
const outputs = (messages) => messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));

test('a film Plex has is not fetched again until the user, having been told, says so', async () => {
  const firstId = (messages) => outputs(messages).findLast((output) => output.results).results[0].id;
  const world = createWorld({ plex: { films: [{ title: 'Charade', year: 1963 }] } }, () =>
    scripted([
      () => call('search_media', { query: 'Charade 1963', media_type: 'movie' }),
      // Tries anyway, and tries again when refused.
      (messages) => call('download', { result_id: firstId(messages), library: 'Movies' }),
      (messages) => call('download', { result_id: firstId(messages), library: 'Movies' }),
      () => say("I've started downloading Charade."),
      () => say('You already have Charade (1963) in Plex. Do you want another copy anyway?'),
      // The user says yes: now it goes through, with the id from before or a new one.
      (messages) => call('download', { result_id: firstId(messages), library: 'Movies' }),
      () => say('I picked another copy of Charade (1963) and saved it in Movies.'),
    ]),
  );
  try {
    const first = await world.say('Can you get Charade from 1963?');
    assert.deepEqual(first.calls.map((entry) => JSON.parse(entry.output).already_in_plex), [undefined, 'Charade (1963)', 'Charade (1963)']);
    assert.equal(world.trace().added.length, 0);
    assert.equal(first.reply, 'You already have Charade (1963) in Plex. Do you want another copy anyway?', 'the false claim was withheld');
    assert.deepEqual(first.statuses, [
      'Searched for “Charade 1963”: 4 results',
      'Already in Plex: Charade (1963)',
      'Not downloaded: Plex already has Charade (1963)',
      'Not downloaded: Plex already has Charade (1963)',
    ]);

    const second = await world.say('Yes please, the one in Plex is broken.');
    assert.equal(JSON.parse(second.calls[0].output).ok, true);
    assert.deepEqual(world.trace().added.map((entry) => entry.title), ['Charade.1963.1080p.BluRay.x264-GRP']);
    // The model is told about Plex only when Plex is connected, and is never shown the token or where Plex is.
    const everything = JSON.stringify(world.trace());
    assert.equal(everything.includes(PLEX_TOKEN) || everything.includes('plex.invalid') || everything.includes('/data/'), false);
  } finally {
    world.close();
  }
});

test('a season Plex has some of is planned, but asked about before it is fetched', async () => {
  const planId = (messages) => outputs(messages).findLast((output) => output.plan).plan.id;
  const world = createWorld({ plex: { shows: [{ title: 'Copperhollow', year: 2019, seasons: { 1: 8, 2: 3 } }] }, folders: { '/media/TV': ['Copperhollow'] } }, () =>
    scripted([
      () => call('find_show', { title: 'Copperhollow', season: 2 }),
      () => say('You already have 3 episodes of season 2 of Copperhollow. Do you want the whole season anyway?'),
      (messages) => call('download', { result_id: planId(messages), library: 'TV', title: 'Copperhollow' }),
      () => say('I picked season 2 of Copperhollow and saved it in TV.'),
      // A season Plex has none of needs no question.
      () => call('find_show', { title: 'Copperhollow', season: 3 }),
      () => say('I could not find season 3 of Copperhollow. Would you like anything else?'),
    ]),
  );
  try {
    const first = await world.say('Can you get season 2 of Copperhollow?');
    const found = JSON.parse(first.calls[0].output);
    assert.equal(found.plex, 'Plex already has 3 episodes of season 2.');
    assert.match(found.next_step, /ask whether they still want this season/);
    assert.equal(found.plan.downloads, 1);
    assert.equal(first.nudges, 0);

    const second = await world.say('Yes, all of it.');
    assert.equal(JSON.parse(second.calls[0].output).ok, true);
    assert.deepEqual(world.trace().added.map((entry) => entry.title), ['Copperhollow.S02.1080p.WEB-DL.DDP5.1.Atmos.H.264-GRP']);

    const third = await world.say('And season 3?');
    assert.equal(JSON.parse(third.calls[0].output).plex, 'Plex has none of season 3.');
  } finally {
    world.close();
  }
});

test('single episodes Plex lacks are still fetched from a season it has part of, and nothing is searched for needlessly', async () => {
  const planId = (messages) => outputs(messages).findLast((output) => output.plan).plan.id;
  // Plex has all of season 1 and the first four episodes of season 2.
  const world = createWorld({ plex: { shows: [{ title: 'Copperhollow', year: 2019, seasons: { 1: 8, 2: 4 } }] }, folders: { '/media/TV': ['Copperhollow'] } }, () =>
    scripted([
      () => call('find_show', { title: 'Copperhollow' }),
      (messages) => call('download', { result_id: planId(messages), library: 'TV', title: 'Copperhollow' }),
      () => say('You had season 1 and four episodes of season 2. I picked the other six episodes and saved them in TV.'),
    ]),
  );
  try {
    const turn = await world.say('Can you get the rest of Copperhollow?');
    const found = JSON.parse(turn.calls[0].output);
    assert.equal(found.plex, 'Plex already has season 1 (8 episodes) and season 2 (4 episodes). That is left out of this plan.');
    assert.deepEqual(found.plan.gets.map((part) => part.what), ['Season 2: 6 single episodes']);
    assert.equal(found.plan.seasons_not_found, undefined);
    assert.deepEqual(world.trace().added.map((entry) => /S02E(\d\d)/.exec(entry.title)[1]), ['05', '06', '07', '08', '09', '10']);
    // Season 1 is taken to be complete, and a pack of everything would be no use: neither is looked for.
    assert.deepEqual(world.trace().searches, ['Copperhollow', 'Copperhollow S02']);
  } finally {
    world.close();
  }
});

test('with nothing left to fetch, or Plex out of reach, find_show says so and carries on', async () => {
  const everything = createWorld({ plex: { shows: [{ title: 'Pioneer One', year: 2010, seasons: { 1: 6 } }] } }, () =>
    scripted([() => call('find_show', { title: 'Pioneer One' }), () => say('You already have all of Pioneer One.')]),
  );
  try {
    const turn = await everything.say('Can you get Pioneer One?');
    const found = JSON.parse(turn.calls[0].output);
    assert.deepEqual([found.found, found.plan, found.plex], [true, undefined, 'Plex already has season 1 (6 episodes).']);
    assert.equal(turn.nudges, 0, 'saying they have it all is a complete answer');
    assert.equal(turn.reply, 'You already have all of Pioneer One.');
  } finally {
    everything.close();
  }

  // Plex is down: PiRick works as it does without it, rather than failing the request.
  const unreachable = createWorld({ plex: { films: [{ title: 'Charade', year: 1963 }] } }, () =>
    scripted([
      () => call('search_media', { query: 'Charade 1963', media_type: 'movie' }),
      (messages) => call('download', { result_id: outputs(messages)[0].results[0].id, library: 'Movies' }),
      () => say('I picked Charade (1963) and saved it in Movies.'),
    ]),
  );
  try {
    unreachable.plexServer.setDown(true);
    const turn = await unreachable.say('Can you get Charade from 1963?');
    assert.equal(JSON.parse(turn.calls[0].output).plex, undefined, 'nothing is claimed about Plex either way');
    assert.equal(unreachable.trace().added.length, 1);
  } finally {
    unreachable.close();
  }
});

test('the admin screen shows the Plex connection and each library’s match, and nothing ever shows the token', async () => {
  const server = household();
  const url = await listen(server);
  // The other services are not there at all; only the Plex side is under test.
  const config = loadConfig({ PLEX_URL: url, PLEX_TOKEN, OLLAMA_URL: url, JACKETT_URL: url, QBIT_URL: url });
  config.dbFile = ':memory:';
  const { app, auth } = build(config);
  await auth.createUser('admin', 'admin-password', 'admin');
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  servers.push(listener);
  const base = `http://127.0.0.1:${listener.address().port}`;

  const replies = [];
  let cookie = '';
  async function request(path, method = 'GET', body) {
    const res = await fetch(base + path, { method, headers: { 'X-PiRick': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
    const text = await res.text();
    replies.push(text);
    cookie ||= res.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    return { status: res.status, body: JSON.parse(text) };
  }
  await request('/api/login', 'POST', { username: 'admin', password: 'admin-password' });

  assert.deepEqual((await request('/api/admin/status')).body.plex, { ok: true, detail: 'Home 1.41.0.8994, 3 libraries' });

  const tv = (await request('/api/admin/libraries', 'POST', { name: 'TV', savePath: '/media/TV', perTitle: true })).body.library;
  assert.deepEqual(tv.plex, { key: '2', title: 'TV Shows', path: '/data/TV', chosen: 'auto' });
  const anime = (await request('/api/admin/libraries', 'POST', { name: 'Anime', savePath: '/media/Anime', perTitle: true })).body.library;
  assert.deepEqual(anime.plex, { none: true, chosen: 'auto' });

  const listed = (await request('/api/admin/libraries')).body;
  assert.deepEqual(listed.plex.folders, [
    { key: '1', title: 'Films', path: '/data/Movies' },
    { key: '2', title: 'TV Shows', path: '/data/TV' },
    { key: '5', title: 'TV in 4K', path: '/data/TV 4K' },
  ]);

  // An admin corrects a match, takes a library out of Plex, and puts it back to automatic.
  const choose = (id, choice) => request(`/api/admin/libraries/${id}/plex`, 'PUT', { choice });
  assert.deepEqual((await choose(anime.id, listed.plex.folders[2])).body.library.plex, { key: '5', title: 'TV in 4K', path: '/data/TV 4K', chosen: 'folder' });
  assert.deepEqual((await choose(tv.id, 'none')).body.library.plex, { none: true, chosen: 'none' });
  assert.deepEqual((await choose(tv.id, 'auto')).body.library.plex.chosen, 'auto');
  assert.equal((await choose(tv.id, { key: 'x y', path: '/data/TV' })).status, 400);
  assert.equal((await choose(999, 'auto')).status, 404);

  // A library that is removed takes its choice with it, so the next one with that number starts afresh.
  assert.equal((await request(`/api/admin/libraries/${anime.id}`, 'DELETE')).status, 200);
  const again = (await request('/api/admin/libraries', 'POST', { name: 'Anime', savePath: '/media/Anime', perTitle: true })).body.library;
  assert.deepEqual([again.id, again.plex], [anime.id, { none: true, chosen: 'auto' }]);

  // If Plex stops answering, the screen says so and the libraries are still listed.
  server.setDown(true);
  const without = (await request('/api/admin/libraries')).body;
  assert.equal(without.libraries.length, 2);
  assert.match(without.plex.error, /^Cannot reach Plex at /);
  assert.equal((await request('/api/admin/status')).body.plex.ok, false);
  server.setDown(false);

  assert.ok(logged.some((line) => line.includes('library matched to Plex')), 'the log is being captured');
  for (const text of [...replies, ...logged]) assert.equal(text.includes(PLEX_TOKEN), false, text.slice(0, 200));
  for (const requested of server.requests) assert.equal((requested.path + requested.search).includes(PLEX_TOKEN), false);
});
