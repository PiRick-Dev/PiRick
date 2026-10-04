// Runs the whole app against stand-in Ollama, Jackett and qBittorrent servers.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { build } from '../src/build.js';
import { loadConfig } from '../src/config.js';

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Big.Buck.Bunny';
const TORRENT_BYTES = Buffer.from('d4:infod4:name4:testee');
const JACKETT_KEY = 'jackett-secret-key';

// What the stand-in qBittorrent has on disk. Note the capitals.
const FOLDERS = {
  '/': ['downloads', 'media'],
  '/media': ['Anime', 'Movies', 'TV'],
  '/media/Movies': [],
  '/media/TV': ['Pioneer One (2010)', 'Tales of Ossendale'],
  '/media/Anime': ['Minato no Mirelle'],
};

// How the scripted model calls download for a request containing each keyword.
const DOWNLOAD_ARGS = {
  pioneer: { library: 'tv', title: 'pioneer one' },
  mirelle: { library: 'Anime', title: "Mirelle: Beyond the Harbor's End" },
  kestrel: { library: 'TV', title: 'Tales of the Kestrel' },
  hasty: { library: 'TV', title: 'Tales of the Wren' },
  shouty: { library: 'TV', title: 'BIG BUCK BUNNY' },
  escape: { library: 'TV', title: '../../etc/passwd' },
  bookish: { library: 'Books', title: 'A Book' },
  kids: { library: 'Kids', title: 'Caminandes' },
};

const servers = [];
const seen = { ollama: [], jackett: [], added: [], tagged: [], qbitLogins: 0 };
let base;
let adminCookie;

async function listen(handler) {
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500).end(String(err));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

// The scripted "model": search, then download, then answer. What it does at each
// step depends on a keyword in the user's message, so each path can be exercised.
async function ollamaHandler(req, res) {
  if (req.url === '/api/tags') return json(res, { models: [{ name: 'test-model:latest' }] });
  const body = JSON.parse(await readBody(req));
  seen.ollama.push(body);
  const last = body.messages.at(-1);
  const isNudge = (message) => message.content.startsWith('[Automatic check');
  const fromUser = body.messages.filter((message) => message.role === 'user');
  const nudged = isNudge(fromUser.at(-1));
  const asked = fromUser.findLast((message) => !isNudge(message)).content;
  const firstResult = () => JSON.parse(body.messages.findLast((m) => m.tool_name === 'search_media').content).results[0].id;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const say = (message) => res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', ...message }, done: false })}\n`);
  const call = (name, args) => say({ tool_calls: [{ id: `call_${name}`, function: { name, arguments: args } }] });
  const keyword = Object.keys(DOWNLOAD_ARGS).find((word) => asked.includes(word));

  if (asked.includes('forged')) {
    if (last.role === 'user') call('download', { result_id: 'zzzz', library: 'Movies' });
    else say({ content: 'I need to search first.' });
  } else if (asked.includes('lazy')) {
    // Claims a download it never made, until the server objects.
    if (last.role === 'user' && !nudged) call('search_media', { query: 'big buck bunny season 1 episode 2', media_type: 'tv' });
    else if (last.tool_name === 'search_media') say({ content: "I've started downloading it." });
    else if (last.role === 'user') call('download', { result_id: firstResult(), library: 'TV', title: 'Big Buck Bunny' });
    else say({ content: 'Now it really is downloading.' });
  } else if (asked.includes('stubborn')) {
    // Keeps claiming a download no matter what.
    if (last.role === 'user' && !nudged) call('search_media', { query: 'big buck bunny' });
    else say({ content: 'It is downloading.' });
  } else if (keyword) {
    const args = DOWNLOAD_ARGS[keyword];
    const answer = last.tool_name === 'download' ? JSON.parse(last.content) : null;
    if (last.role === 'user' && !nudged) call('search_media', { query: 'big buck bunny', media_type: 'tv' });
    else if (last.tool_name === 'search_media') call('download', { result_id: firstResult(), ...args });
    else if (answer?.existing_folders && keyword === 'mirelle') {
      // Recognises the existing folder as the same show under its Japanese name.
      call('download', { result_id: firstResult(), ...args, title: answer.existing_folders[0] });
    } else if (answer?.existing_folders && keyword === 'kestrel') {
      call('download', { result_id: firstResult(), ...args, new_folder: true });
    } else if (answer?.existing_folders && keyword === 'hasty') {
      say({ content: "I've started downloading it." });
    } else if (last.role === 'user') call('download', { result_id: firstResult(), ...args, new_folder: true });
    else say({ content: answer?.ok ? 'All sorted.' : 'That did not work out.' });
  } else if (last.role === 'user') {
    say({ thinking: 'The user wants a film.' });
    call('search_media', { query: 'big buck bunny', media_type: 'movie' });
  } else if (last.tool_name === 'search_media') {
    const { results } = JSON.parse(last.content);
    call('download', { result_id: results[asked.includes('second') ? 1 : 0].id, library: 'Movies' });
  } else {
    say({ content: 'Found it. ' });
    say({ content: 'Downloading **Big Buck Bunny** now.' });
  }
  res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`);
}

async function jackettHandler(req, res) {
  const url = new URL(req.url, 'http://jackett');
  if (url.pathname === '/dl/bunny.torrent') {
    return res.writeHead(302, { Location: '/files/bunny.torrent' }).end();
  }
  if (url.pathname === '/files/bunny.torrent') {
    return res.writeHead(200, { 'Content-Type': 'application/x-bittorrent' }).end(TORRENT_BYTES);
  }
  if (url.searchParams.get('apikey') !== JACKETT_KEY) return res.writeHead(401).end();
  if (url.pathname.endsWith('/torznab/api')) {
    return res.writeHead(200, { 'Content-Type': 'application/xml' }).end('<indexers><indexer id="a"/><indexer id="b"/></indexers>');
  }
  seen.jackett.push(url);
  json(res, {
    Results: [
      { Title: 'Big.Buck.Bunny.2008.720p', Size: 5e8, Seeders: 5, Category: [2000], Link: `http://${req.headers.host}/dl/bunny.torrent`, Tracker: 'idx' },
      { Title: 'Big.Buck.Bunny.2008.1080p', Size: 2e9, Seeders: 50, Category: [2040], MagnetUri: MAGNET, Tracker: 'idx' },
      { Title: 'Big.Buck.Bunny.2008.1080p.dupe', Size: 2e9, Seeders: 9, Category: [2040], MagnetUri: MAGNET, Tracker: 'other' },
      { Title: 'No link at all', Size: 1, Seeders: 999 },
    ],
  });
}

// Behaves like qBittorrent 5: 204 on login, a port-named cookie, 403 when signed out.
async function qbitHandler(req, res) {
  const url = new URL(req.url, 'http://qbit');
  const body = await readBody(req);
  const form = () =>
    new Request('http://qbit', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData();

  if (url.pathname === '/api/v2/auth/login') {
    seen.qbitLogins += 1;
    const fields = await form();
    if (fields.get('username') !== 'qb-user' || fields.get('password') !== 'qb-pass') return res.writeHead(401).end('Unauthorized');
    return res.writeHead(204, { 'Set-Cookie': 'QBT_SID_8080=session1; HttpOnly; SameSite=Lax; path=/' }).end();
  }
  if (req.headers.cookie !== 'QBT_SID_8080=session1') return res.writeHead(403).end('Forbidden');

  if (url.pathname === '/api/v2/app/version') return res.end('v5.2.4');
  if (url.pathname === '/api/v2/app/defaultSavePath') return res.end('/downloads');
  if (url.pathname === '/api/v2/app/getDirectoryContent') {
    const dir = url.searchParams.get('dirPath');
    if (!Object.hasOwn(FOLDERS, dir)) return res.writeHead(404).end('Directory does not exist');
    return json(res, FOLDERS[dir].map((name) => `${dir === '/' ? '' : dir}/${name}`));
  }
  if (url.pathname === '/api/v2/torrents/add') {
    const fields = await form();
    const torrent = fields.get('torrents');
    seen.added.push({
      urls: fields.get('urls'),
      file: torrent ? Buffer.from(await torrent.arrayBuffer()) : null,
      category: fields.get('category'),
      savepath: fields.get('savepath'),
      autoTMM: fields.get('autoTMM'),
      tags: fields.get('tags'),
    });
    return res.end('Ok.');
  }
  if (url.pathname === '/api/v2/torrents/addTags') {
    seen.tagged.push(Object.fromEntries(await form()));
    return res.end();
  }
  if (url.pathname === '/api/v2/torrents/info') {
    if (url.searchParams.get('hashes')) {
      const known = url.searchParams.get('hashes') === 'f'.repeat(40);
      return json(res, known ? [{ name: 'Known', progress: 1, state: 'uploading', size: 1, tags: 'pirick' }] : []);
    }
    if (!url.searchParams.get('tag')) {
      // Everything added so far, whether or not its folder is on disk yet.
      return json(res, seen.added.map((torrent) => ({ save_path: torrent.savepath, tags: torrent.tags })));
    }
    const all = [
      { name: 'Big Buck Bunny', progress: 0.425, state: 'downloading', eta: 600, size: 2e9, added_on: 1700000000, tags: 'pirick, pirick-admin' },
      { name: 'Sintel', progress: 1, state: 'stalledUP', eta: 8640000, size: 1e9, added_on: 1600000000, tags: 'pirick, pirick-sam' },
    ];
    return json(res, all.filter((torrent) => torrent.tags.split(', ').includes(url.searchParams.get('tag'))));
  }
  res.writeHead(404).end('Endpoint does not exist');
}

function request(path, { method = 'GET', body, cookie = adminCookie, headers = {} } = {}) {
  return fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      'X-PiRick': '1',
      ...(body && { 'Content-Type': 'application/json' }),
      ...(cookie && { Cookie: cookie }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
}

const getJson = async (path, options) => (await request(path, options)).json();

async function login(username, password) {
  const res = await request('/api/login', { method: 'POST', body: { username, password }, cookie: null });
  return { res, cookie: res.headers.getSetCookie()[0]?.split(';')[0] };
}

async function chat(message, cookie = adminCookie) {
  const res = await request('/api/chat', { method: 'POST', body: { message }, cookie });
  assert.equal(res.status, 200);
  const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
  return {
    events,
    statuses: events.filter((event) => event.type === 'status'),
    shown: events.filter((event) => event.type === 'delta').map((event) => event.text).join(''),
    // What the model was told by the last tool it called.
    toolResult: () => JSON.parse(seen.ollama.at(-1).messages.findLast((message) => message.role === 'tool').content),
  };
}

before(async () => {
  const [ollamaUrl, jackettUrl, qbitUrl] = await Promise.all([
    listen(ollamaHandler),
    listen(jackettHandler),
    listen(qbitHandler),
  ]);
  const config = loadConfig({
    OLLAMA_URL: ollamaUrl,
    OLLAMA_MODEL: 'test-model',
    JACKETT_URL: jackettUrl,
    JACKETT_API_KEY: JACKETT_KEY,
    QBIT_URL: qbitUrl,
    QBIT_USERNAME: 'qb-user',
    QBIT_PASSWORD: 'qb-pass',
    // Retired settings must be ignored, not turned into folders or categories.
    QBIT_CATEGORY_TV: 'tv',
    QBIT_SAVEPATH_MOVIE: '/somewhere/else',
  });
  config.dbFile = ':memory:';
  const { app, auth } = build(config);
  await auth.createUser('admin', 'admin-password', 'admin');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
});

test('signed-out visitors are sent to the login page and refused by the API', async () => {
  const home = await request('/', { cookie: null });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login');

  for (const path of ['/api/me', '/api/chat', '/api/downloads', '/api/admin/users', '/api/admin/libraries', '/api/admin/personality']) {
    assert.equal((await request(path, { cookie: null })).status, 401, path);
  }
  assert.equal((await request('/api/chat', { method: 'POST', body: { message: 'hi' }, cookie: null })).status, 401);

  const page = await request('/login', { cookie: null });
  assert.equal(page.status, 200);
  // Without script, forms must post (never GET with the password in the URL) and just reload.
  assert.match(await page.text(), /<form id="login-form" method="post"/);
  const scriptless = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ username: 'a', password: 'b' }), redirect: 'manual' });
  assert.equal(scriptless.status, 303);
  assert.equal(scriptless.headers.get('location'), '/login');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-powered-by'), null);
});

test('login rejects bad credentials and cross-site requests, and accepts good ones', async () => {
  assert.equal((await login('admin', 'wrong-password')).res.status, 401);
  assert.equal((await login('nobody', 'admin-password')).res.status, 401);

  const noHeader = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
  });
  assert.equal(noHeader.status, 403, 'the custom header is required');

  const crossSite = await request('/api/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin-password' },
    cookie: null,
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);

  const { res, cookie } = await login('admin', 'admin-password');
  assert.equal(res.status, 200);
  assert.match(res.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);
  adminCookie = cookie;

  const me = await getJson('/api/me');
  assert.equal(me.username, 'admin');
  assert.equal(me.role, 'admin');
  assert.equal((await request('/')).status, 200);
});

test('repeated wrong passwords are locked out', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('ghost', 'wrong-password')).res.status, 401);
  const blocked = (await login('ghost', 'wrong-password')).res;
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('nothing is downloaded until an admin has set up a library', async () => {
  assert.equal((await getJson('/api/me')).setupNeeded, true);

  const { events, toolResult } = await chat('Can you get Big Buck Bunny?');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(seen.added.length, 0, 'no default folder or category is ever invented');
  assert.match(toolResult().error, /no libraries set up/);

  const firstCall = seen.ollama[0];
  assert.match(firstCall.messages[0].content, /None are set up yet/);
  const download = firstCall.tools.find((tool) => tool.function.name === 'download');
  assert.deepEqual(Object.keys(download.function.parameters.properties), ['result_id']);

  await request('/api/chat', { method: 'DELETE' });
});

test('admins define libraries, and a folder with the wrong capitals is caught', async () => {
  const add = (body) => request('/api/admin/libraries', { method: 'POST', body });

  const movies = await add({ name: 'Movies', description: 'Films', savePath: '/media/Movies/' });
  assert.equal(movies.status, 201);
  assert.deepEqual((await movies.json()).library, {
    id: 1,
    name: 'Movies',
    description: 'Films',
    savePath: '/media/Movies',
    perTitle: false,
    category: '',
    folder: { status: 'ok' },
  });

  // The mistake that started all this: "tv" where the real folder is "TV".
  const tv = (await (await add({ name: 'TV', description: 'Live-action series', savePath: '/media/tv', perTitle: true })).json()).library;
  assert.deepEqual(tv.folder, { status: 'wrong-case', suggestion: '/media/TV' });
  const fixed = await request(`/api/admin/libraries/${tv.id}`, {
    method: 'PUT',
    body: { name: 'TV', description: 'Live-action series', savePath: tv.folder.suggestion, perTitle: true },
  });
  assert.deepEqual((await fixed.json()).library.folder, { status: 'ok' });

  assert.equal((await add({ name: 'Anime', description: 'Japanese animated series and films', savePath: '/media/Anime', perTitle: true })).status, 201);
  const kids = (await (await add({ name: 'Kids', savePath: '/media/Kids' })).json()).library;
  assert.deepEqual(kids.folder, { status: 'missing' });

  assert.equal((await add({ name: 'anime', savePath: '/media/Anime' })).status, 409, 'names are unique whatever the capitals');
  assert.equal((await add({ name: 'Books', savePath: 'media/books' })).status, 400, 'the folder must be a full path');
  assert.equal((await add({ name: '', savePath: '/media/Books' })).status, 400);
  assert.equal((await request('/api/admin/libraries/999', { method: 'PUT', body: { name: 'X', savePath: '/x' } })).status, 404);

  const { libraries } = await getJson('/api/admin/libraries');
  assert.deepEqual(libraries.map((library) => [library.name, library.savePath, library.folder.status]), [
    ['Anime', '/media/Anime', 'ok'],
    ['Kids', '/media/Kids', 'missing'],
    ['Movies', '/media/Movies', 'ok'],
    ['TV', '/media/TV', 'ok'],
  ]);
  assert.equal((await getJson('/api/me')).setupNeeded, false);

  // Suggestions for the folder box come from what qBittorrent really has.
  const suggest = async (typed) => (await getJson(`/api/admin/folders?path=${encodeURIComponent(typed)}`)).folders;
  assert.deepEqual(await suggest('/media/t'), ['/media/Anime', '/media/Movies', '/media/TV']);
  assert.deepEqual(await suggest('/media/TV/'), ['/media/TV/Pioneer One (2010)', '/media/TV/Tales of Ossendale']);
  assert.deepEqual(await suggest(''), ['/downloads', '/media'], 'starts beside the default save folder');
  assert.deepEqual(await suggest('/nowhere/x'), []);
  assert.deepEqual(await suggest('relative'), []);
});

test('a chat message searches, downloads the best result into the right library and replies', async () => {
  const { events, statuses, shown } = await chat('Can you get Big Buck Bunny?');
  assert.equal(events.at(-1).type, 'done');

  assert.deepEqual(statuses.map((event) => event.kind), ['search', 'download']);
  // The unusable result and the duplicate hash are dropped, leaving two.
  assert.match(statuses[0].text, /2 results/);
  assert.equal(statuses[1].text, 'Started downloading: Big.Buck.Bunny.2008.1080p (1.9 GB) → Movies');
  assert.equal(shown, 'Found it. Downloading **Big Buck Bunny** now.');

  const search = seen.jackett.at(-1);
  assert.equal(search.searchParams.get('Query'), 'big buck bunny');
  assert.deepEqual(search.searchParams.getAll('Category[]'), ['2000']);
  // The model is told what the indexer filed each result under.
  const searchResult = JSON.parse(seen.ollama.at(-2).messages.at(-1).content);
  assert.deepEqual(searchResult.results.map((result) => result.kind), ['movie', 'movie']);

  assert.deepEqual(seen.added.at(-1), {
    urls: MAGNET,
    file: null,
    category: null, // none unless the admin set one on the library
    savepath: '/media/Movies',
    autoTMM: 'false',
    tags: 'pirick,pirick-admin',
  });
  assert.equal(seen.qbitLogins, 1, 'the qBittorrent session is reused');
});

test('the model is offered the libraries by name, and never sees paths, links or keys', async () => {
  const lastCall = seen.ollama.at(-1);
  assert.equal(lastCall.messages[0].role, 'system');
  assert.match(lastCall.messages[0].content, /- Anime: Japanese animated series and films \(each show has its own folder/);
  assert.match(lastCall.messages[0].content, /- Movies: Films\n/);

  assert.deepEqual(lastCall.tools.map((tool) => tool.function.name), ['search_media', 'download', 'list_downloads']);
  const { properties, required } = lastCall.tools[1].function.parameters;
  assert.deepEqual(properties.library.enum, ['Anime', 'Kids', 'Movies', 'TV']);
  assert.deepEqual(required, ['result_id', 'library', 'title']);

  const sent = JSON.stringify(seen.ollama);
  for (const secret of ['magnet:', 'btih', '/dl/', '/media/', '/somewhere/else', JACKETT_KEY, 'qb-pass']) {
    assert.equal(sent.includes(secret), false, secret);
  }
});

test('a result with only a link is fetched and uploaded as a .torrent file', async () => {
  const { events } = await chat('The second one please');
  assert.equal(events.at(-1).type, 'done');
  const added = seen.added.at(-1);
  assert.equal(added.urls, null);
  assert.deepEqual(added.file, TORRENT_BYTES);
  assert.equal(added.savepath, '/media/Movies');
});

test('an id that did not come from a search is refused', async () => {
  const before = seen.added.length;
  const { events, toolResult } = await chat('forged id');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(seen.added.length, before, 'nothing was added');
  assert.equal(toolResult().ok, false);
});

test('a reply that claims a download without making one is withheld and corrected', async () => {
  const before = seen.added.length;
  const { shown, statuses } = await chat('lazy model please');
  assert.equal(shown, 'Now it really is downloading.', 'the false claim never reaches the browser');
  assert.equal(seen.added.length, before + 1);
  assert.equal(seen.jackett.at(-1).searchParams.get('Query'), 'big buck bunny S01E02', '"season 1 episode 2" is rewritten');
  // A show with no folder yet gets one, and the status line says so.
  assert.equal(seen.added.at(-1).savepath, '/media/TV/Big Buck Bunny');
  assert.match(statuses.at(-1).text, /→ TV \/ Big Buck Bunny \(new folder\)$/);

  const stored = JSON.stringify((await getJson('/api/chat')).messages);
  assert.equal(stored.includes("I've started downloading it."), false);
  assert.equal(stored.includes('Automatic check'), false);
});

test('if the model keeps claiming, its reply is replaced with an honest one', async () => {
  const before = seen.added.length;
  const { events, shown } = await chat('stubborn model please');
  assert.equal(seen.added.length, before);
  assert.match(shown, /didn't actually start anything/);
  assert.equal(shown.includes('It is downloading.'), false);
  assert.equal(events.at(-1).type, 'done');

  const stored = JSON.stringify((await getJson('/api/chat')).messages);
  assert.equal(stored.includes('It is downloading.'), false, 'the false claim is not stored either');
});

test('each show goes into one folder, reusing the one that already exists', async () => {
  // Lower-case library and title from the model; the real folder has capitals and a year.
  const pioneer = await chat('get pioneer');
  assert.equal(seen.added.at(-1).savepath, '/media/TV/Pioneer One (2010)');
  assert.equal(pioneer.statuses.at(-1).text, 'Started downloading: Big.Buck.Bunny.2008.1080p (1.9 GB) → TV / Pioneer One (2010)');
  assert.equal(pioneer.toolResult().saved_in, 'TV / Pioneer One (2010)');

  // A look-alike folder: the model is asked, and recognises the same show under another name.
  let before = seen.added.length;
  const mirelle = await chat('get mirelle');
  assert.equal(seen.added.length, before + 1, 'downloaded once, after the question');
  assert.equal(seen.added.at(-1).savepath, '/media/Anime/Minato no Mirelle');
  const question = JSON.parse(seen.ollama.at(-2).messages.at(-1).content);
  assert.equal(question.ok, false);
  assert.deepEqual(question.existing_folders, ['Minato no Mirelle']);
  assert.equal(mirelle.shown, 'All sorted.');

  // A look-alike folder that is a different show: the model says so and a new folder is made.
  before = seen.added.length;
  const kestrel = await chat('get kestrel');
  assert.equal(seen.added.length, before + 1);
  assert.equal(seen.added.at(-1).savepath, '/media/TV/Tales of the Kestrel');
  assert.match(kestrel.statuses.at(-1).text, /→ TV \/ Tales of the Kestrel \(new folder\)$/);
});

test('a title cannot place files outside its library', async () => {
  await chat('try to escape');
  const { savepath } = seen.added.at(-1);
  assert.equal(savepath, '/media/TV/etc passwd');
  assert.equal(savepath.includes('..'), false);
});

test('claiming a download after only being asked about folders is still caught', async () => {
  const before = seen.added.length;
  const { shown } = await chat('hasty model please');
  assert.equal(shown, 'All sorted.', 'the premature claim was withheld');
  assert.equal(seen.added.length, before + 1);
  assert.equal(seen.added.at(-1).savepath, '/media/TV/Tales of the Wren');
});

test('a folder that is not on disk yet is still reused, capitals and all', async () => {
  // "Big Buck Bunny" was given a folder earlier, but no data has arrived, so
  // qBittorrent has not created it. A differently capitalised title must not
  // start a second folder.
  assert.equal(FOLDERS['/media/TV'].includes('Big Buck Bunny'), false);
  const { statuses } = await chat('a shouty request');
  assert.equal(seen.added.at(-1).savepath, '/media/TV/Big Buck Bunny');
  assert.match(statuses.at(-1).text, /→ TV \/ Big Buck Bunny$/);
});

test('an unknown library, or one whose folder is missing, downloads nothing', async () => {
  const before = seen.added.length;

  const unknown = await chat('something bookish');
  assert.match(unknown.toolResult().error, /library set to one of: "Anime", "Kids", "Movies", "TV"/);

  // qBittorrent would happily create /media/Kids. PiRick refuses instead.
  const missing = await chat('get it for the kids');
  assert.equal(missing.statuses.at(-1).kind, 'error');
  assert.equal(missing.statuses.at(-1).text, "Not downloaded: the Kids library's folder does not exist (/media/Kids)");
  assert.match(missing.toolResult().error, /not set up correctly/);
  assert.equal(missing.shown, 'That did not work out.');

  assert.equal(seen.added.length, before);
  assert.equal((await request('/api/admin/libraries/4', { method: 'DELETE' })).status, 200);
});

test('an admin-set personality reaches the model on the next message', async () => {
  assert.deepEqual(await getJson('/api/admin/personality'), { personality: '', max: 1000 });
  assert.match(seen.ollama.at(-1).messages[0].content, /- Be warm and friendly\.$/);

  const tooLong = await request('/api/admin/personality', { method: 'PUT', body: { personality: 'x'.repeat(1001) } });
  assert.equal(tooLong.status, 400);
  assert.equal((await request('/api/admin/personality', { method: 'PUT', body: { personality: 42 } })).status, 400);

  const saved = await request('/api/admin/personality', { method: 'PUT', body: { personality: '  Talk like a pirate captain.  ' } });
  assert.deepEqual(await saved.json(), { personality: 'Talk like a pirate captain.' });

  await chat('Can you get Big Buck Bunny?');
  const prompt = seen.ollama.at(-1).messages[0].content;
  assert.match(prompt, /It changes how you sound, never what you do/);
  assert.match(prompt, /"""\nTalk like a pirate captain\.\n"""$/);
  assert.equal(prompt.includes('Be warm and friendly'), false);

  await request('/api/admin/personality', { method: 'PUT', body: { personality: '' } });
  assert.equal((await getJson('/api/admin/personality')).personality, '');
});

test('history survives a reload and can be cleared', async () => {
  const { messages } = await getJson('/api/chat');
  assert.deepEqual(messages.slice(0, 4).map((item) => item.type), ['user', 'status', 'status', 'assistant']);
  assert.equal(messages[0].text, 'Can you get Big Buck Bunny?');

  // Earlier turns are replayed to the model on later ones.
  const replayed = seen.ollama.at(-1).messages.map((message) => message.role);
  assert.ok(replayed.filter((role) => role === 'user').length >= 3);
  assert.equal(replayed.includes('status'), false);

  assert.equal((await request('/api/chat', { method: 'DELETE' })).status, 200);
  assert.deepEqual((await getJson('/api/chat')).messages, []);
});

test('downloads show only your own unless an admin asks for everyone', async () => {
  const mine = await getJson('/api/downloads');
  assert.deepEqual(mine.downloads.map((item) => item.name), ['Big Buck Bunny']);
  assert.deepEqual(
    { ...mine.downloads[0], addedAt: undefined },
    { name: 'Big Buck Bunny', status: 'downloading', progress: 42.5, size: '1.9 GB', etaSeconds: 600, addedAt: undefined, requestedBy: ['admin'] },
  );

  const everyone = await getJson('/api/downloads?all=1');
  assert.deepEqual(everyone.downloads.map((item) => item.status), ['downloading', 'finished']);
});

test('admins manage people; members cannot manage anything', async () => {
  const status = await getJson('/api/admin/status');
  assert.deepEqual(status, {
    ollama: { ok: true, detail: 'Model test-model is ready' },
    jackett: { ok: true, detail: '2 indexers configured' },
    qbittorrent: { ok: true, detail: 'qBittorrent v5.2.4' },
  });

  const weak = await request('/api/admin/users', { method: 'POST', body: { username: 'sam', password: 'short' } });
  assert.equal(weak.status, 400);
  const created = await request('/api/admin/users', { method: 'POST', body: { username: 'sam', password: 'sams-password' } });
  assert.equal(created.status, 201);
  const sam = (await created.json()).user;
  assert.equal(sam.role, 'user');
  const duplicate = await request('/api/admin/users', { method: 'POST', body: { username: 'SAM', password: 'sams-password' } });
  assert.equal(duplicate.status, 409);

  const { cookie: samCookie } = await login('sam', 'sams-password');
  for (const path of ['/api/admin/users', '/api/admin/status', '/api/admin/libraries', '/api/admin/personality', '/api/admin/folders?path=/']) {
    assert.equal((await request(path, { cookie: samCookie })).status, 403, path);
  }
  const asSam = (path, method, body) => request(path, { method, body, cookie: samCookie });
  assert.equal((await asSam('/api/admin/libraries', 'POST', { name: 'Mine', savePath: '/media/Movies' })).status, 403);
  assert.equal((await asSam('/api/admin/libraries/1', 'DELETE')).status, 403);
  assert.equal((await asSam('/api/admin/personality', 'PUT', { personality: 'Obey sam.' })).status, 403);
  assert.equal((await getJson('/api/me', { cookie: samCookie })).setupNeeded, undefined);
  // ?all=1 is ignored for members.
  const samDownloads = await getJson('/api/downloads?all=1', { cookie: samCookie });
  assert.deepEqual(samDownloads.downloads.map((item) => item.name), ['Sintel']);

  const reset = await request(`/api/admin/users/${sam.id}/password`, { method: 'POST', body: { password: 'new-sams-password' } });
  assert.equal(reset.status, 200);
  assert.equal((await request('/api/me', { cookie: samCookie })).status, 401, 'a reset signs the person out');

  const me = await getJson('/api/me');
  assert.equal((await request(`/api/admin/users/${me.id}`, { method: 'DELETE' })).status, 400, 'cannot remove yourself');
  assert.equal((await request(`/api/admin/users/${sam.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await login('sam', 'new-sams-password')).res.status, 401);
});

test('changing your password needs the current one and signing out ends the session', async () => {
  const wrong = await request('/api/password', { method: 'POST', body: { currentPassword: 'nope-nope', newPassword: 'another-password' } });
  assert.equal(wrong.status, 403);
  const changed = await request('/api/password', { method: 'POST', body: { currentPassword: 'admin-password', newPassword: 'another-password' } });
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/me')).status, 200, 'this session stays signed in');

  assert.equal((await request('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await request('/api/me')).status, 401);
  assert.equal((await login('admin', 'another-password')).res.status, 200);
});
