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
const { WORLD } = await import('../bench/works.js');
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
      const response = await standIn.fetch(`http://plex${req.url}`, { headers: req.headers, method: req.method });
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

// ---- What Plex took a download for ---------------------------------------------

// What Plex's own search knows: two shows of one name, and two films of another.
const KNOWN = [
  { imdb: 'tt0001963', kind: 'show', title: 'Kestrelmere', year: 1963 },
  { imdb: 'tt0002005', kind: 'show', title: 'Kestrelmere (US)', year: 2005 },
  { imdb: 'tt0001984', kind: 'movie', title: 'Brindle', year: 1984 },
  { imdb: 'tt0002021', kind: 'movie', title: 'Brindle', year: 2021 },
];
// What the catalogue said each download was, when the chat started it.
const OLD_SHOW = { kind: 'show', title: 'Kestrelmere', year: 1963, imdb: 'tt0001963' };
const OLD_FILM = { kind: 'film', title: 'Brindle', year: 1984, imdb: 'tt0001984' };
const NEW_SHOW_IN_PLEX = { title: 'Kestrelmere (US)', year: 2005, imdb: 'tt0002005' };

/** A Plex with nothing in it yet. Things arrive as a scan would bring them, with `add`. */
const emptyPlex = (knows = KNOWN) =>
  plexStandIn(
    [
      { key: '1', title: 'Films', type: 'movie', folders: ['/data/Movies'], items: [] },
      { key: '2', title: 'TV Shows', type: 'show', folders: ['/data/TV'], items: [] },
    ],
    { knows },
  );
/** A season of the show two share a name with, saved in a folder under the bare name. */
const seasonOf = (season, folder = 'Kestrelmere') => {
  const name = `Kestrelmere.S0${season}.1080p.WEB.H264-GRP`;
  return torrent(name, { save_path: `/media/TV/${folder}`, content_path: `/media/TV/${folder}/${name}` });
};
/** Where Plex sees the episodes of such a download. */
const episodesOf = (download, count = 2) => {
  const [, season] = /S(\d\d)/.exec(download.name);
  return Array.from({ length: count }, (unused, i) => `${download.content_path.replace('/media/', '/data/')}/Kestrelmere.S${season}E0${i + 1}.mkv`);
};
const filmCopy = (name = 'Brindle.1080p.BluRay.x264-GRP') => torrent(name, { save_path: '/media/Movies', content_path: `/media/Movies/${name}` });
/** Upkeep with these downloads started by the chat, each fetched as what is given with it, and all of them finished. */
async function fetched(downloads, plexServer = emptyPlex()) {
  const world = watching(downloads.map(([download]) => download), { plexServer });
  for (const [download, meant, username = 'alice'] of downloads) world.upkeep.track({ hash: download.hash, name: download.name, username, meant });
  await world.look();
  world.finish();
  await world.look();
  world.asked = () => plexServer.requests.filter((request) => request.search.includes('file=')).length;
  return world;
}

test('the client finds what holds a download, what Plex took it for, and what Plex would take it for instead', async () => {
  const server = emptyPlex();
  const wrong = server.add('2', { ...NEW_SHOW_IN_PLEX, files: ['/data/TV/Kestrelmere/Kestrelmere.S01.1080p.WEB.H264-GRP/Kestrelmere.S01E01.mkv', '/data/TV/Kestrelmere/Kestrelmere.S01.1080p.WEB.H264-GRP/Kestrelmere.S01E02.mkv'] });
  server.add('2', { title: 'Kestrelmere', year: 1963, imdb: 'tt0001963', files: ['/data/TV/Kestrelmere (1963)/Season 01/Kestrelmere - S01E01.mkv'] });
  const unplaced = server.add('1', { title: 'Brindle', unmatched: true, files: ['/data/Movies/Brindle.1080p.BluRay.x264-GRP/Brindle.1080p.BluRay.x264-GRP.mkv'] });
  const url = await listen(server);
  const plex = createPlex({ url, token: PLEX_TOKEN, timeoutMs: 5000 });

  // Plex finds every path with the text in it. Only what lies in the folder counts, not what lies in one named like it.
  const [show, ...more] = await plex.holding('2', '/data/TV/Kestrelmere');
  assert.deepEqual(more, []);
  assert.deepEqual(show, { id: wrong, kind: 'show', title: 'Kestrelmere (US)', year: 2005, matched: true, imdb: 'tt0002005', folders: ['/data/TV/Kestrelmere'] });
  assert.deepEqual((await plex.holding('2', '/data/TV/Kestrelmere/Kestrelmere.S01.1080p.WEB.H264-GRP/Kestrelmere.S01E02.mkv')).map((item) => item.id), [wrong], 'a single file is found as well');
  assert.deepEqual(await plex.holding('2', '/data/TV/Wrenfield Cross'), []);
  assert.deepEqual(await plex.holding('9', '/data/TV/Kestrelmere'), [], 'a library Plex does not have holds nothing');
  assert.equal((await plex.filesOf(show)).length, 2);

  const [film] = await plex.holding('1', '/data/Movies/Brindle.1080p.BluRay.x264-GRP');
  assert.deepEqual(film, { id: unplaced, kind: 'movie', title: 'Brindle', year: null, matched: false, imdb: null, folders: [] });
  assert.deepEqual(await plex.filesOf(film), ['/data/Movies/Brindle.1080p.BluRay.x264-GRP/Brindle.1080p.BluRay.x264-GRP.mkv']);

  // Asked by number, Plex has one answer or none. A number for a show is no answer about a film.
  assert.deepEqual(await plex.candidate(show, 'tt0001963'), { guid: 'plex://show/tt0001963', name: 'Kestrelmere', year: 1963 });
  assert.equal(await plex.candidate(show, 'tt7777777'), null);
  assert.equal(await plex.candidate(film, 'tt0001963'), null);

  await plex.match(film, await plex.candidate(film, 'tt0001984'));
  assert.deepEqual(server.matches, [{ id: unplaced, imdb: 'tt0001984', name: 'Brindle', year: '1984' }]);
  assert.deepEqual((await plex.holding('1', '/data/Movies/Brindle.1080p.BluRay.x264-GRP'))[0], { id: unplaced, kind: 'movie', title: 'Brindle', year: 1984, matched: true, imdb: 'tt0001984', folders: [] });

  // Telling Plex is the one request that is not a read. The token rides in its header like any other.
  assert.deepEqual(server.requests.filter((request) => request.method).map((request) => [request.method, request.path]), [['PUT', `/library/metadata/${unplaced}/match`]]);
  for (const request of server.requests) {
    assert.equal(request.token, PLEX_TOKEN);
    assert.equal((request.path + request.search).includes(PLEX_TOKEN), false, 'never in an address');
  }
});

test('a show Plex took for its namesake is corrected once, and whoever asked is told', async () => {
  const season = seasonOf(1);
  const { upkeep, plexServer, look, notes } = await fetched([[season, OLD_SHOW]]);
  assert.deepEqual(notes(), ['“Kestrelmere (season 1)” has finished downloading and Plex has been asked to add it.']);

  // Plex has not got to it yet.
  await look();
  assert.deepEqual(plexServer.matches, []);

  // It takes the folder for the better-known show of the name.
  const id = plexServer.add('2', { ...NEW_SHOW_IN_PLEX, files: episodesOf(season) });
  await look();
  assert.deepEqual(plexServer.matches, [{ id, imdb: 'tt0001963', name: 'Kestrelmere', year: '1963' }]);
  assert.equal(notes().length, 1, 'nothing is said until Plex shows the change');

  await look();
  assert.equal(notes()[1], 'Plex had filed “Kestrelmere” (1963) as “Kestrelmere (US)” (2005). That has been corrected.');
  assert.deepEqual([upkeep.recent()[0].action, upkeep.recent()[0].username], ['filed', 'alice']);
  assert.deepEqual([plexServer.item(id).title, plexServer.item(id).year], ['Kestrelmere', 1963]);

  // Someone would rather have it as it was, and changes it back in Plex: after its one check, it is theirs.
  Object.assign(plexServer.item(id), NEW_SHOW_IN_PLEX);
  const before = plexServer.requests.length;
  await look();
  await look(60);
  assert.equal(plexServer.matches.length, 1);
  assert.equal(plexServer.requests.length, before, 'and Plex is not asked about it again');
  assert.equal(notes().length, 2);
  assert.equal(logged.some((line) => line.includes(PLEX_TOKEN)), false);
});

test('a match a person has changed is not changed back when more of the show arrives', async () => {
  const first = seasonOf(1);
  const { upkeep, state, plexServer, look, notes, finish } = await fetched([[first, OLD_SHOW]]);
  const id = plexServer.add('2', { ...NEW_SHOW_IN_PLEX, files: episodesOf(first) });
  await look();
  await look();
  assert.equal(plexServer.matches.length, 1);
  // Whoever runs Plex knows better, or wants it so, and sets it back.
  Object.assign(plexServer.item(id), NEW_SHOW_IN_PLEX);

  // The next season is fetched as the same show and lands in the same folder, beside what has had its check.
  const second = seasonOf(2);
  state.torrents.push(second);
  upkeep.track({ hash: second.hash, name: second.name, username: 'alice', meant: OLD_SHOW });
  await look();
  finish();
  await look();
  plexServer.item(id).files.push(...episodesOf(second));
  await look();
  await look();
  assert.equal(plexServer.matches.length, 1, 'Plex is not told again');
  assert.deepEqual([plexServer.item(id).title, plexServer.item(id).year], ['Kestrelmere (US)', 2005]);
  assert.deepEqual(notes().filter((note) => note.startsWith('Plex')), ['Plex had filed “Kestrelmere” (1963) as “Kestrelmere (US)” (2005). That has been corrected.'], 'and nothing more is said of it');
});

test('a film Plex could not place is told which film it is, once Plex has had time to place it', async () => {
  const film = filmCopy();
  const { plexServer, look, notes } = await fetched([[film, OLD_FILM]]);
  const id = plexServer.add('1', { title: 'Brindle', unmatched: true, files: [`/data/Movies/${film.name}/${film.name}.mkv`] });

  // A new thing shows in Plex before Plex has matched it, so the first sight of it proves nothing.
  await look();
  assert.deepEqual(plexServer.matches, []);
  await look();
  assert.deepEqual(plexServer.matches, [{ id, imdb: 'tt0001984', name: 'Brindle', year: '1984' }]);
  await look();
  assert.equal(notes()[1], 'Plex did not recognise “Brindle” (1984). It has been told which film it is.');

  // One that Plex places itself in that time needs nothing.
  const slow = await fetched([[filmCopy(), OLD_FILM]]);
  const later = slow.plexServer.add('1', { title: 'Brindle', unmatched: true, files: [`/data/Movies/${film.name}/${film.name}.mkv`] });
  await slow.look();
  Object.assign(slow.plexServer.item(later), { title: 'Brindle', year: 1984, imdb: 'tt0001984', unmatched: false });
  await slow.look();
  await slow.look();
  assert.deepEqual(slow.plexServer.matches, []);
  assert.equal(slow.notes().length, 1);
});

test('what Plex took for the right thing is left as it is, and what the catalogue did not name is not looked for', async () => {
  const season = seasonOf(1);
  const unnamed = torrent('Wrenfield.Cross.S03E01.1080p.WEB.H264-GRP');
  const { plexServer, look, notes, asked } = await fetched([[season, OLD_SHOW], [unnamed, undefined]]);
  plexServer.add('2', { title: 'Kestrelmere', year: 1963, imdb: 'tt0001963', files: episodesOf(season) });
  // Taken for something else altogether, which nothing here can know.
  plexServer.add('2', { ...NEW_SHOW_IN_PLEX, files: ['/data/TV/Wrenfield Cross/Wrenfield.Cross.S03E01.1080p.WEB.H264-GRP'] });
  assert.equal(asked(), 1, 'the one the catalogue named was looked for at once, when Plex did not have it yet');

  await look();
  assert.equal(asked(), 2);
  await look();
  await look(60);
  assert.equal(asked(), 2, 'found right, it is not looked for again');
  assert.deepEqual(plexServer.matches, []);
  assert.equal(notes().length, 2, 'the two that finished, and no more');
});

test('episodes of one show that finish together are settled as one, and each person is told', async () => {
  const [first, second, third] = [1, 2, 3].map((season) => seasonOf(season));
  const { upkeep, plexServer, look, notes } = await fetched([[first, OLD_SHOW], [second, OLD_SHOW], [third, OLD_SHOW, 'bob']]);
  const id = plexServer.add('2', { ...NEW_SHOW_IN_PLEX, files: [first, second, third].flatMap((season) => episodesOf(season)) });
  await look();
  await look();
  assert.deepEqual(plexServer.matches, [{ id, imdb: 'tt0001963', name: 'Kestrelmere', year: '1963' }], 'Plex is told once');
  const corrected = 'Plex had filed “Kestrelmere” (1963) as “Kestrelmere (US)” (2005). That has been corrected.';
  assert.deepEqual(notes().filter((note) => note.startsWith('Plex')), [corrected]);
  assert.deepEqual(notes('bob').filter((note) => note.startsWith('Plex')), [corrected]);

  // A season fetched later lands in a show that is right by then.
  const fourth = seasonOf(4);
  upkeep.track({ hash: fourth.hash, name: fourth.name, username: 'alice', meant: OLD_SHOW });
  plexServer.item(id).files.push(...episodesOf(fourth));
  await look();
  assert.equal(plexServer.matches.length, 1);
});

test('what Plex put together with something it already had is left for a person, who is told once', async () => {
  // The show: Plex has the newer one, and adds the older one's folder to it.
  const plexServer = emptyPlex();
  const had = plexServer.add('2', { ...NEW_SHOW_IN_PLEX, title: 'Kestrelmere (2005)', files: ['/data/TV/Kestrelmere (2005)/Season 04/Kestrelmere - S04E01.mkv'] });
  const season = seasonOf(1);
  const { upkeep, state, look, notes, finish } = await fetched([[season, OLD_SHOW]], plexServer);
  plexServer.item(had).files.push(...episodesOf(season));
  await look();
  await look();
  assert.deepEqual(plexServer.matches, [], 'the show that was there is not to be changed');
  const together =
    'Plex has put “Kestrelmere” (1963) together with “Kestrelmere (2005)”, which it already had. Only what PiRick added itself is corrected, so this one is left for an admin: in Plex, use Split Apart on it, then Fix Match on the new one.';
  assert.deepEqual(notes().slice(1), [together]);
  assert.equal(upkeep.recent()[0].action, 'misfiled');

  // More of it arrives and goes the same way. It has been said.
  const next = seasonOf(2);
  state.torrents.push(next);
  upkeep.track({ hash: next.hash, name: next.name, username: 'alice', meant: OLD_SHOW });
  await look();
  finish();
  await look();
  plexServer.item(had).files.push(...episodesOf(next));
  await look();
  assert.deepEqual(notes().filter((note) => note.startsWith('Plex has put')), [together]);
  assert.deepEqual(plexServer.matches, []);

  // The film: Plex has the newer one, and takes the older for another copy of it.
  const films = emptyPlex();
  const newer = films.add('1', { title: 'Brindle', year: 2021, imdb: 'tt0002021', files: ['/data/Movies/Brindle (2021)/Brindle (2021).mkv'] });
  const film = filmCopy();
  const second = await fetched([[film, OLD_FILM]], films);
  films.item(newer).files.push(`/data/Movies/${film.name}/${film.name}.mkv`);
  await second.look();
  assert.deepEqual(films.matches, []);
  assert.match(second.notes()[1], /^Plex has put “Brindle” \(1984\) together with “Brindle” \(2021\), which it already had\./);
});

test('what was in Plex before PiRick came to it is not changed, and nobody is troubled with it', async () => {
  // The folder held episodes from elsewhere, and Plex has had the show as the other one all along.
  const plexServer = emptyPlex();
  const had = plexServer.add('2', { ...NEW_SHOW_IN_PLEX, files: ['/data/TV/Kestrelmere/Season 01/Kestrelmere - S01E01.mkv'] });
  const season = seasonOf(2);
  const { look, notes, asked } = await fetched([[season, OLD_SHOW]], plexServer);
  plexServer.item(had).files.push(...episodesOf(season));
  await look();
  await look();
  assert.deepEqual(plexServer.matches, []);
  assert.equal(notes().length, 1);
  const before = asked();
  await look(60);
  assert.equal(asked(), before, 'and that is the end of it');

  // Matched by one of Plex's older agents, which do not say what IMDb calls a thing: right or wrong cannot be told.
  const older = emptyPlex();
  const film = filmCopy();
  const second = await fetched([[filmCopy(), OLD_FILM]], older);
  older.add('1', { title: 'Brindle', year: 2021, files: [`/data/Movies/${film.name}/${film.name}.mkv`] });
  await second.look();
  await second.look();
  assert.deepEqual(older.matches, []);
  assert.equal(second.notes().length, 1);

  // Plex's search knows nothing by the number: there is nothing to tell it.
  const unknowing = emptyPlex(KNOWN.filter((known) => known.imdb !== 'tt0001984'));
  const third = await fetched([[film, OLD_FILM]], unknowing);
  unknowing.add('1', { title: 'Brindle', year: 2021, imdb: 'tt0002021', files: [`/data/Movies/${film.name}/${film.name}.mkv`] });
  await third.look();
  await third.look();
  assert.deepEqual(unknowing.matches, []);
  assert.equal(third.notes().length, 1);
});

test('a correction Plex does not take is said, not sent again', async () => {
  const season = seasonOf(1);
  const { upkeep, plexServer, look, notes } = await fetched([[season, OLD_SHOW]]);
  plexServer.setDeaf(true);
  plexServer.add('2', { ...NEW_SHOW_IN_PLEX, files: episodesOf(season) });
  await look();
  assert.equal(plexServer.matches.length, 1);
  await look();
  await look();
  assert.equal(notes().length, 1, 'Plex is given a few looks to show it');
  await look();
  assert.equal(notes()[1], 'Plex has filed “Kestrelmere” (1963) as “Kestrelmere (US)” (2005) and did not take the correction. An admin can put it right in Plex with Fix Match.');
  assert.equal(upkeep.recent()[0].action, 'misfiled');
  await look();
  await look(60);
  assert.equal(plexServer.matches.length, 1);
  assert.equal(notes().length, 2);
});

test('the check waits for Plex, gives up quietly, and can be switched off', async () => {
  // Plex is out of reach when the check comes round: it is tried again, and nothing is lost.
  const season = seasonOf(1);
  const away = await fetched([[season, OLD_SHOW]]);
  const id = away.plexServer.add('2', { ...NEW_SHOW_IN_PLEX, files: episodesOf(season) });
  away.plexServer.setDown(true);
  await away.look();
  await away.look();
  away.plexServer.setDown(false);
  await away.look();
  assert.deepEqual(away.plexServer.matches.map((match) => match.id), [id]);

  // Plex never shows it: after half an hour of looks it is let be, with nothing said.
  const never = await fetched([[seasonOf(1), OLD_SHOW]]);
  for (let i = 0; i < 28; i++) await never.look();
  assert.equal(never.asked(), 29);
  await never.look();
  await never.look();
  await never.look(60);
  assert.equal(never.asked(), 30);
  assert.equal(never.notes().length, 1);

  // Switched off under Admin > Upkeep, Plex is not asked what it took anything for.
  const off = watching([seasonOf(1)], { plexServer: emptyPlex() });
  off.settings.setUpkeep({ enabled: true, stuckHours: 6, fixMatches: false });
  off.upkeep.track({ hash: season.hash, name: season.name, username: 'alice', meant: OLD_SHOW });
  await off.look();
  off.finish();
  await off.look();
  off.plexServer.add('2', { ...NEW_SHOW_IN_PLEX, files: episodesOf(season) });
  await off.look();
  await off.look();
  assert.equal(off.plexServer.scans.length, 1, 'Plex is still asked to pick the download up');
  assert.deepEqual(off.plexServer.matches, []);
  assert.equal(off.plexServer.requests.some((request) => request.search.includes('file=')), false);
  // Switched on again, what is waiting is seen to.
  off.settings.setUpkeep({ enabled: true, stuckHours: 6, fixMatches: true });
  await off.look();
  assert.equal(off.plexServer.matches.length, 1);
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

test('from the request to Plex: what the catalogue named is what Plex is held to', async () => {
  const planId = (messages) => outputs(messages).findLast((output) => output.plan).plan.id;
  const firstId = (messages) => outputs(messages).findLast((output) => output.results).results[0].id;
  // The numbers the stand-in catalogue gives its shows and films.
  const british = `tt${9000000 + WORLD.shows.findIndex((show) => show.id === 106)}`;
  const american = `tt${9000000 + WORLD.shows.findIndex((show) => show.id === 105)}`;
  const charade = `tt${8000000 + WORLD.films.findIndex((film) => film.title === 'Charade' && film.date)}`;
  const knows = [
    { imdb: british, kind: 'show', title: 'Kestrelmere', year: 2001 },
    { imdb: american, kind: 'show', title: 'Kestrelmere (US)', year: 2005 },
    { imdb: charade, kind: 'movie', title: 'Charade', year: 1963 },
  ];
  const world = createWorld({ catalogue: true, plex: { knows } }, () =>
    scripted([
      () => call('find_show', { title: 'Kestrelmere 2001' }),
      (messages) => call('download', { result_id: planId(messages), library: 'TV', title: 'Kestrelmere' }),
      () => say('I found all of the British Kestrelmere and saved it in TV.'),
      () => call('search_media', { query: 'Charade 1963', media_type: 'movie' }),
      (messages) => call('download', { result_id: firstId(messages), library: 'Movies' }),
      () => say('I picked a copy of Charade (1963) and saved it in Movies.'),
      () => say('Welcome back! Both have finished, and Plex has them as what they are now.'),
    ]),
  );
  try {
    await world.say('Can you get the British Kestrelmere? All of it.');
    await world.say('And Charade from 1963, please.');
    const [show, film] = world.trace().added;
    assert.deepEqual([show.title, film.title], ['Kestrelmere.UK.The.Complete.Series.S01-S02.1080p.BluRay.x264-GRP', 'Charade.1963.1080p.BluRay.x264-GRP']);

    world.finish();
    await world.upkeep.look();
    // Plex takes the show for its better-known namesake, and the film for nothing at all.
    const inPlex = (download) => `${download.savePath.replace('/media/', '/data/')}/${download.title}`;
    const showId = world.plexServer.add('2', { title: 'Kestrelmere (US)', year: 2005, imdb: american, files: [`${inPlex(show)}/Kestrelmere.UK.S01E01.mkv`] });
    const filmId = world.plexServer.add('1', { title: 'Charade', unmatched: true, files: [`${inPlex(film)}/Charade.mkv`] });
    for (let looks = 0; looks < 3; looks++) await world.upkeep.look();
    assert.deepEqual(world.plexServer.matches, [
      { id: showId, imdb: british, name: 'Kestrelmere', year: '2001' },
      { id: filmId, imdb: charade, name: 'Charade', year: '1963' },
    ]);

    // Whoever asked hears of it when they are next there.
    const back = await world.comeBack();
    assert.deepEqual(back.statuses.filter((status) => status.startsWith('Plex')), [
      'Plex had filed “Kestrelmere” (2001) as “Kestrelmere (US)” (2005). That has been corrected.',
      'Plex did not recognise “Charade” (1963). It has been told which film it is.',
    ]);
    // The model had no part in any of it, and was told nothing of numbers or of where Plex is.
    const everything = JSON.stringify(world.trace());
    assert.equal([british, charade, PLEX_TOKEN, 'plex.invalid', '/data/'].some((text) => everything.includes(text)), false);
  } finally {
    world.close();
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
