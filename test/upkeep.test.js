import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashFromMagnet } from '../src/jackett.js';
import { createSettings } from '../src/settings.js';
import { createUpkeep, describeTorrent } from '../src/upkeep.js';

const HOUR = 60 * 60 * 1000;
const GB = 1024 ** 3;
const hashOf = (title) => createHash('sha1').update(title).digest('hex');

/** A torrent as qBittorrent lists it. Stalled at zero unless told otherwise. */
const torrent = (name, extra = {}) => ({
  hash: hashOf(name),
  name,
  progress: 0,
  completed: 0,
  state: 'stalledDL',
  size: 2 * GB,
  tags: 'pirick, pirick-alice',
  save_path: '/media/TV/Show',
  category: '',
  ...extra,
});

/** Stand-ins for qBittorrent and Jackett, a controllable clock, and the upkeep built on them. */
function setup({ torrents = [], catalog = {}, settings: initial } = {}) {
  const db = openDb(':memory:');
  const settings = createSettings(db);
  if (initial) settings.setUpkeep(initial);
  const clock = { time: Date.UTC(2026, 0, 1) };
  const calls = { added: [], removed: [], searched: [] };
  const state = { torrents, catalog, failAdds: false };

  const qbit = {
    tagged: async () => state.torrents.map((entry) => ({ ...entry })),
    find: async (hash) => (state.torrents.some((entry) => entry.hash === hash) ? { status: 'downloading', progress: 0 } : null),
    async add(item) {
      if (state.failAdds) throw new Error('qBittorrent is down');
      calls.added.push(item);
      state.torrents.push(torrent(item.name, { hash: hashFromMagnet(item.magnet), tags: item.tags.join(', '), save_path: item.savePath, category: item.category }));
    },
    async remove(hash, deleteFiles) {
      calls.removed.push({ hash, deleteFiles });
      state.torrents = state.torrents.filter((entry) => entry.hash !== hash);
    },
  };
  const jackett = {
    async search(query, categories) {
      calls.searched.push(query);
      const found = Object.entries(state.catalog).find(([key]) => key.toLowerCase() === query.toLowerCase())?.[1] ?? [];
      return found.map(([title, seeders = 10, sizeGb = 2]) => ({ title, seeders, size: sizeGb * GB, infoHash: hashOf(title), categories }));
    },
    resolve: async (release) => ({ magnet: `magnet:?xt=urn:btih:${release.infoHash}`, name: release.title }),
  };
  const upkeep = createUpkeep({ db, qbit, jackett, settings, config: loadConfig({}), now: () => clock.time });
  const run = async (hoursLater = 0) => {
    clock.time += hoursLater * HOUR;
    return upkeep.runOnce();
  };
  const actions = () => upkeep.recent().reverse().map((entry) => entry.action);
  return { db, upkeep, settings, state, calls, clock, run, actions };
}

test('torrents are described by what they are', () => {
  assert.equal(describeTorrent('Copperhollow.S02E05.1080p.WEB.h264-GRP'), 'Copperhollow (S02E05)');
  assert.equal(describeTorrent('Copperhollow.S02.1080p.WEB'), 'Copperhollow (season 2)');
  assert.equal(describeTorrent('Tears.of.Steel.2012.1080p.WEB-DL'), 'Tears of Steel (2012)');
  assert.equal(describeTorrent('Artist - Album [FLAC]'), 'Artist - Album');
});

test('a download is stuck only after hours without growth while it should be growing', async () => {
  const dead = torrent('Show.S01E01.1080p');
  const { upkeep, state, run } = setup({ torrents: [dead] });

  assert.deepEqual(await run(), { watching: 1, stuck: 0, replaced: 0 }, 'first seen: the clock starts now');
  assert.equal((await run(5)).stuck, 0, '5 hours is under the 6 hour limit');

  // Growth restarts the clock.
  state.torrents[0].completed = 1000;
  assert.equal((await run(2)).stuck, 0);
  assert.equal((await run(5)).stuck, 0, '5 hours since it last grew');

  // Paused, queued or being checked: no growth is expected, so the time does not count.
  for (const waiting of ['pausedDL', 'stoppedDL', 'queuedDL', 'checkingDL']) {
    state.torrents[0].state = waiting;
    assert.equal((await run(20)).stuck, 0, waiting);
  }
  state.torrents[0].state = 'stalledDL';
  assert.equal((await run(5)).stuck, 0, 'the clock restarted when it left the queue');
  assert.equal((await run(2)).stuck, 1);
  assert.deepEqual([...upkeep.stuckHashes()], [dead.hash]);
  assert.deepEqual(upkeep.overview(), { watching: 1, stuck: 1 });

  // It comes back to life: no longer stuck.
  state.torrents[0].completed = 5000;
  assert.equal((await run()).stuck, 0);
  assert.equal(upkeep.stuckHashes().size, 0);

  // Finished or removed downloads are forgotten.
  state.torrents[0].progress = 1;
  assert.deepEqual(await run(), { watching: 0, stuck: 0, replaced: 0 });
  assert.deepEqual(upkeep.overview(), { watching: 0, stuck: 0 });
});

test('a stuck episode is replaced by another copy in the same place, and only then removed', async () => {
  const dead = torrent('Show.S01E03.1080p.WEB-GRP', { save_path: '/media/TV/Show (2019)', category: 'shows' });
  const { upkeep, state, calls, run } = setup({
    torrents: [dead],
    catalog: {
      'Show S01E03': [
        ['Show.S01E03.1080p.WEB-GRP', 0], // the dead one itself
        ['Show.S01E03.720p.HDTV', 90],
        ['Show.S01E03.1080p.BluRay', 8],
        ['Show.S01E04.1080p.BluRay', 99], // a different episode
        ['Other.Show.S01E03.1080p', 99], // a different show
        ['Show.S01.1080p.BluRay', 99], // a pack is not a like-for-like replacement
      ],
    },
  });
  await run();

  // If qBittorrent will not take the new copy, the stuck one must stay.
  state.failAdds = true;
  assert.deepEqual(await run(7), { watching: 1, stuck: 1, replaced: 0 });
  assert.deepEqual(calls.removed, []);
  assert.equal(state.torrents.length, 1);

  // A copy existed but could not be handed over, so it is simply tried again next time.
  state.failAdds = false;
  assert.equal((await run()).replaced, 1);

  // Healthy and in the stuck one's own quality beats a better-seeded 720p.
  assert.equal(calls.added.length, 1);
  assert.deepEqual(
    { name: calls.added[0].name, savePath: calls.added[0].savePath, category: calls.added[0].category, tags: calls.added[0].tags },
    { name: 'Show.S01E03.1080p.BluRay', savePath: '/media/TV/Show (2019)', category: 'shows', tags: ['pirick', 'pirick-alice'] },
  );
  assert.deepEqual(calls.removed, [{ hash: dead.hash, deleteFiles: true }]);
  assert.deepEqual(state.torrents.map((entry) => entry.hash), [hashFromMagnet(calls.added[0].magnet)]);

  const log = upkeep.recent();
  assert.equal(log[0].action, 'replaced');
  assert.equal(log[0].username, 'alice');
  assert.equal(log[0].detail, 'Replaced the stuck download of “Show (S01E03)” with another copy (“Show.S01E03.1080p.BluRay”).');
});

test('a copy that was already tried is never picked again, and replacing stops after three goes', async () => {
  const { upkeep, state, calls, run, actions } = setup({
    torrents: [torrent('Show.S01E01.1080p.A')],
    catalog: {
      'Show S01E01': [['Show.S01E01.1080p.A', 50], ['Show.S01E01.1080p.B', 40], ['Show.S01E01.1080p.C', 30], ['Show.S01E01.1080p.D', 20], ['Show.S01E01.1080p.E', 10]],
    },
  });
  await run();
  // Every replacement dies in turn.
  for (const expected of ['B', 'C', 'D']) {
    assert.equal((await run(7)).replaced, 1);
    assert.equal(state.torrents.length, 1);
    assert.equal(state.torrents[0].name, `Show.S01E01.1080p.${expected}`);
  }
  // D is the third replacement. When it sticks too, PiRick stops and says so once.
  assert.deepEqual(await run(7), { watching: 1, stuck: 1, replaced: 0 });
  await run(7);
  await run(48);
  assert.equal(calls.added.length, 3);
  assert.deepEqual(actions(), ['replaced', 'replaced', 'replaced', 'gave-up']);
  assert.match(upkeep.recent()[0].detail, /replaced 3 times and is stuck again/);
});

test('when no other copy exists the item is left alone, said once, and looked for again a day later', async () => {
  const dead = torrent('Show.S01E01.1080p.A');
  const { state, calls, run, actions } = setup({ torrents: [dead], catalog: { 'Show S01E01': [['Show.S01E01.1080p.A', 5]] } });
  await run();
  assert.equal((await run(7)).replaced, 0);
  assert.equal((await run(1)).replaced, 0);
  assert.equal((await run(1)).replaced, 0);
  assert.equal(calls.searched.length, 1, 'not searched again within a day');
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(actions(), ['no-copy']);

  // A copy turns up later.
  state.catalog['Show S01E01'].push(['Show.S01E01.1080p.NEW', 12]);
  assert.equal((await run(24)).replaced, 1);
  assert.deepEqual(actions(), ['no-copy', 'replaced']);
  assert.equal(state.torrents[0].name, 'Show.S01E01.1080p.NEW');
});

test('a stuck season pack is replaced by another pack, or by its episodes', async () => {
  const withPack = setup({
    torrents: [torrent('Show.S02.1080p.DEAD')],
    catalog: { 'Show S02': [['Show.S02.1080p.DEAD', 1], ['Show.S02.1080p.ALIVE', 30, 20], ['Show.S02E01.1080p', 99]] },
  });
  await withPack.run();
  await withPack.run(7);
  assert.deepEqual(withPack.calls.added.map((item) => item.name), ['Show.S02.1080p.ALIVE']);

  const episodesOnly = setup({
    torrents: [torrent('Show.S02.1080p.DEAD')],
    catalog: { 'Show S02': [['Show.S02E01.1080p', 20], ['Show.S02E02.1080p', 20]], 'Show season 2': [['Show.S02E03.1080p', 20]] },
  });
  await episodesOnly.run();
  assert.equal((await episodesOnly.run(7)).replaced, 1);
  assert.deepEqual(episodesOnly.calls.added.map((item) => item.name), ['Show.S02E01.1080p', 'Show.S02E02.1080p', 'Show.S02E03.1080p']);
  assert.equal(episodesOnly.calls.removed.length, 1);
  assert.match(episodesOnly.upkeep.recent()[0].detail, /with 3 single episodes, all that could be found/);
});

test('a stuck film is replaced only by the same title and year, never by a cinema recording', async () => {
  const dead = torrent('Brindle.2021.1080p.WEB-DL.DEAD', { save_path: '/media/Movies' });
  const { calls, run } = setup({
    torrents: [dead],
    catalog: { 'Brindle 2021': [['Brindle.1984.1080p.BluRay', 99], ['Brindle.2021.HDCAM.x264', 500], ['Brindle.Part.Two.2024.1080p', 99], ['Brindle.2021.2160p.UHD', 40], ['Brindle.2021.1080p.BluRay', 30]] },
  });
  await run();
  await run(7);
  assert.deepEqual(calls.added.map((item) => [item.name, item.savePath]), [['Brindle.2021.1080p.BluRay', '/media/Movies']]);
});

test('things PiRick cannot identify, and broken torrents, are flagged but left alone', async () => {
  const album = torrent('Artist - Album [FLAC]', { save_path: '/media/Music' });
  const broken = torrent('Show.S01E01.1080p', { state: 'missingFiles' });
  const { upkeep, calls, run, actions } = setup({ torrents: [album, broken], catalog: { 'Show S01E01': [['Show.S01E01.720p', 50]] } });
  await run();
  await run(7);
  await run(30);
  assert.deepEqual(calls.added, []);
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(actions().sort(), ['problem', 'stuck']);
  assert.deepEqual([...upkeep.stuckHashes()], [album.hash], 'a broken torrent is a different problem, not "stuck"');
});

test('a replacement is remembered as what the stuck download was fetched as', async () => {
  const dead = torrent('Show.S01E03.1080p.WEB-GRP');
  const { db, upkeep, state, run } = setup({ torrents: [dead], catalog: { 'Show S01E03': [['Show.S01E03.1080p.BluRay', 8]] } });
  const meant = { kind: 'show', title: 'Show', year: 2019, imdb: 'tt0002019' };
  // A look comes upon the download before the chat has said what it is.
  await run();
  upkeep.track({ hash: dead.hash, name: dead.name, username: 'alice', meant });
  // Said again without it, as when someone else asks for the same thing, nothing is lost.
  upkeep.track({ hash: dead.hash, name: dead.name, username: 'bob' });
  const kept = () => db.prepare('SELECT hash, meant FROM tracked_downloads').all().map((row) => [row.hash, JSON.parse(row.meant || 'null')]);
  assert.deepEqual(kept(), [[dead.hash, meant]]);

  assert.equal((await run(7)).replaced, 1);
  assert.deepEqual(kept(), [[state.torrents[0].hash, meant]]);
});

test('a database from before PiRick remembered such things gains what it needs, and keeps what it had', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'pirick-'));
  const file = path.join(folder, 'pirick.db');
  try {
    // The table as it was made before.
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE tracked_downloads (
      hash TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', completed INTEGER NOT NULL DEFAULT 0, progress_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'watching', attempts INTEGER NOT NULL DEFAULT 0, tried TEXT NOT NULL DEFAULT '[]', searched_at INTEGER NOT NULL DEFAULT 0)`);
    old.prepare("INSERT INTO tracked_downloads (hash, name, username, progress_at, status) VALUES (?, 'Show.S01E01.1080p', 'alice', 1, 'in-plex')").run('a'.repeat(40));
    old.close();

    for (let opened = 0; opened < 2; opened++) {
      const db = openDb(file);
      const [row] = db.prepare('SELECT * FROM tracked_downloads').all();
      assert.deepEqual({ ...row }, { hash: 'a'.repeat(40), name: 'Show.S01E01.1080p', username: 'alice', completed: 0, progress_at: 1, status: 'in-plex', attempts: 0, tried: '[]', searched_at: 0, meant: '', filed: '', filed_as: '' });
      db.close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('one check replaces at most five items, and upkeep can be switched off', async () => {
  const torrents = Array.from({ length: 7 }, (unused, i) => torrent(`Show.S01E0${i + 1}.1080p.A`));
  const catalog = Object.fromEntries(torrents.map((entry, i) => [`Show S01E0${i + 1}`, [[`Show.S01E0${i + 1}.1080p.B`, 20]]]));
  const busy = setup({ torrents, catalog });
  await busy.run();
  assert.deepEqual(await busy.run(7), { watching: 7, stuck: 7, replaced: 5 });
  assert.equal((await busy.run()).replaced, 2, 'the rest follow on the next check');

  const off = setup({ torrents: [torrent('Show.S01E01.1080p.A')], catalog, settings: { enabled: false, stuckHours: 6 } });
  assert.deepEqual(await off.run(), { skipped: 'switched off' });
  // An admin pressing "Check now" still works.
  assert.deepEqual(await off.upkeep.runOnce({ manual: true }), { watching: 1, stuck: 0, replaced: 0 });
});

test('the hours setting is respected, and each person only hears about their own downloads', async () => {
  const mine = torrent('Show.S01E01.1080p.A');
  const theirs = torrent('Show.S01E02.1080p.A', { tags: 'pirick, pirick-bob' });
  const { upkeep, run } = setup({
    torrents: [mine, theirs],
    catalog: { 'Show S01E01': [['Show.S01E01.1080p.B', 20]], 'Show S01E02': [['Show.S01E02.1080p.B', 20]] },
    settings: { enabled: true, stuckHours: 2 },
  });
  await run();
  assert.equal((await run(1)).stuck, 0);
  assert.equal((await run(1)).replaced, 2);

  const forAlice = upkeep.unseen('Alice');
  assert.equal(forAlice.length, 1);
  assert.match(forAlice[0].detail, /Show \(S01E01\)/);
  upkeep.markSeen(forAlice.map((event) => event.id));
  assert.deepEqual(upkeep.unseen('alice'), []);
  assert.equal(upkeep.unseen('bob').length, 1, 'marking one person’s as seen leaves the other’s');
});
