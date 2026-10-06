// Looks after downloads once they have been started: notices the ones that have
// stopped making progress and replaces them with another copy, and notices the
// ones that finish, so Plex can be asked to pick them up and whoever asked can
// be told. Runs unattended, so everything here follows fixed rules; no language
// model is involved.
import { describeError } from './errors.js';
import { joinPath, pathBelow, titleKey } from './folders.js';
import { hashFromMagnet } from './jackett.js';
import { log } from './log.js';
import { matchLibrary, plexPath } from './plex.js';
import { BASE_TAG } from './qbittorrent.js';
import { best, describeContents, parseRelease, planShow } from './releases.js';
import { createFinder } from './search.js';
import { infoHashOf } from './torrentfile.js';

const HOUR_MS = 60 * 60 * 1000;
const CHECK_EVERY_MS = 10 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const LOOK_EVERY_MS = 60 * 1000;
const FIRST_LOOK_MS = 15 * 1000;
// A download the chat has just started may take a moment to show up in qBittorrent's list.
const FORGET_AFTER_MS = 2 * 60 * 1000;
const MAX_SCAN_TRIES = 5;
const MAX_PARTS_LISTED = 6;
const MAX_REMEMBERED_NOTES = 200;
const SEARCH_AGAIN_MS = 24 * HOUR_MS;
const MAX_REPLACEMENTS = 3;
const MAX_SEARCHES_PER_CHECK = 5;
// A replacement nobody asked for should not flood the queue.
const MAX_REPLACEMENT_TORRENTS = 50;
const LOG_KEEP = 500;
const TRIED_KEEP = 60;
const USER_TAG = `${BASE_TAG}-`;
const TV = [5000];
const MOVIES = [2000];
// States in which a healthy download would be making progress.
const ACTIVE = new Set(['downloading', 'forcedDL', 'stalledDL', 'metaDL', 'forcedMetaDL']);
// States that another copy would not fix (disk or file trouble).
const BROKEN = new Set(['error', 'missingFiles']);
// States in which the files are complete but not yet where they will stay.
const SETTLING = new Set(['moving', 'checkingUP', 'checkingResumeData']);
// What a tracked download is marked as once it has finished: 'scanning' while
// Plex still has to be told, then 'in-plex', or 'finished' when Plex has no part in it.
const FINISHED = new Set(['scanning', 'in-plex', 'finished']);
const LOOSE_FILE = /\.(?:mkv|mp4|m4v|avi|mov|wmv|mpg|mpeg|ts|m2ts|webm|flac|mp3|m4a|m4b|ogg|opus|wav|epub|pdf|mobi|azw3|cbz|cbr|iso)$/i;

const pad = (number) => String(number).padStart(2, '0');
const tagsOf = (torrent) => String(torrent.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
const usernameOf = (torrent) => tagsOf(torrent).find((tag) => tag.startsWith(USER_TAG))?.slice(USER_TAG.length) ?? '';

/** A readable name for a torrent: "Pioneer One (S01E05)" rather than its release name. */
export function describeTorrent(name) {
  const parsed = parseRelease(name);
  if (!parsed.show) return name;
  const contents = describeContents(parsed) ?? (parsed.kind === 'movie' ? String(parsed.year) : null);
  return contents ? `${parsed.show} (${contents})` : parsed.show;
}

export function createUpkeep({ db, qbit, jackett, settings, config, plex, now = Date.now }) {
  const q = {
    get: db.prepare('SELECT * FROM tracked_downloads WHERE hash = ?'),
    all: db.prepare('SELECT hash, status, progress_at FROM tracked_downloads'),
    adopt: db.prepare('INSERT OR IGNORE INTO tracked_downloads (hash, name, username, completed, progress_at) VALUES (?, ?, ?, 0, ?)'),
    insert: db.prepare(`
      INSERT OR REPLACE INTO tracked_downloads (hash, name, username, completed, progress_at, status, attempts, tried, searched_at)
      VALUES (?, ?, ?, ?, ?, 'watching', ?, ?, 0)`),
    progress: db.prepare("UPDATE tracked_downloads SET name = ?, completed = ?, progress_at = ?, status = 'watching', searched_at = 0 WHERE hash = ?"),
    status: db.prepare('UPDATE tracked_downloads SET status = ? WHERE hash = ?'),
    searched: db.prepare('UPDATE tracked_downloads SET searched_at = ? WHERE hash = ?'),
    remove: db.prepare('DELETE FROM tracked_downloads WHERE hash = ?'),
    note: db.prepare('INSERT INTO upkeep_log (at, username, action, detail) VALUES (?, ?, ?, ?)'),
    trim: db.prepare('DELETE FROM upkeep_log WHERE id <= (SELECT id FROM upkeep_log ORDER BY id DESC LIMIT 1 OFFSET ?)'),
    recent: db.prepare('SELECT at, username, action, detail FROM upkeep_log ORDER BY id DESC LIMIT ?'),
    unseen: db.prepare('SELECT id, at, action, detail FROM upkeep_log WHERE username = ? AND seen = 0 ORDER BY id LIMIT 50'),
    seen: db.prepare('UPDATE upkeep_log SET seen = 1 WHERE id = ?'),
    unread: db.prepare('SELECT id FROM upkeep_log WHERE id = ? AND seen = 0'),
    reword: db.prepare('UPDATE upkeep_log SET at = ?, detail = ? WHERE id = ?'),
  };
  let running = false;
  let timers = [];
  let lookFailing = false;
  // How often Plex has been asked in vain about each finished download.
  const scanTries = new Map();
  // The latest "finished" note for each person and show, so that episodes
  // finishing minutes apart are told in a single note until it has been read.
  const announced = new Map();
  // Replacements are looked for under every spelling of the title, like any other search.
  const finder = createFinder(jackett, config.jackett);
  const search = async (query, categories) => (await finder.search(query, categories, { filter: false })).results;

  function note(username, action, detail) {
    const { lastInsertRowid } = q.note.run(now(), username, action, detail);
    q.trim.run(LOG_KEEP);
    log.info(`upkeep: ${action}`, { user: username, detail });
    return Number(lastInsertRowid);
  }

  function finishedText(items) {
    const told = items.every((item) => item.told);
    if (items.length === 1) return `“${items[0].label}” has finished downloading${told ? ' and Plex has been asked to add it' : ''}.`;
    const listed = items.slice(0, MAX_PARTS_LISTED).map((item) => item.contents);
    const more = items.length - listed.length;
    return `${items.length} downloads of “${items[0].show}” have finished (${listed.join(', ')}${more ? ` and ${more} more` : ''})${told ? ' and Plex has been asked to add them' : ''}.`;
  }

  /** Leaves a note that a download has finished. `told` says whether Plex was asked to pick it up. */
  function announce(username, name, told) {
    const parsed = parseRelease(name);
    const contents = parsed.show ? describeContents(parsed) : undefined;
    const item = { label: describeTorrent(name), show: parsed.show, contents, told };
    // Only parts of a show are gathered up; a film is its own piece of news.
    const key = contents ? `${username}|${titleKey(parsed.show)}` : null;
    const earlier = key ? announced.get(key) : null;
    if (earlier && q.unread.get(earlier.id)) {
      // The same thing finishing twice (it was fetched again) is still one item.
      if (!earlier.items.some((known) => known.label === item.label)) earlier.items.push(item);
      const detail = finishedText(earlier.items);
      q.reword.run(now(), detail, earlier.id);
      log.info('upkeep: finished', { user: username, detail });
      return;
    }
    const id = note(username, 'finished', finishedText([item]));
    if (!key) return;
    announced.delete(key);
    announced.set(key, { id, items: [item] });
    if (announced.size > MAX_REMEMBERED_NOTES) announced.delete(announced.keys().next().value);
  }

  /** Where Plex should look for a finished torrent: `{ key, path }`, or null when Plex has no part in it. */
  async function plexFolderOf(torrent) {
    // The most specific library, in case one is set up inside another.
    const library = settings
      .libraries()
      .filter((entry) => pathBelow(entry.savePath, torrent.save_path))
      .sort((a, b) => b.savePath.length - a.savePath.length)[0];
    if (!library) return null;
    const match = matchLibrary(library, await plex.libraries(), settings.plexChoice(library.id));
    if (!match) return null;

    const [show] = pathBelow(library.savePath, torrent.save_path);
    let folder = torrent.save_path;
    if (library.perTitle && show) {
      folder = joinPath(library.savePath, show);
    } else {
      // A torrent that is one loose file has no folder of its own to look in.
      const [own] = pathBelow(torrent.save_path, torrent.content_path) ?? [];
      if (own && !LOOSE_FILE.test(own)) folder = joinPath(torrent.save_path, own);
    }
    return { key: match.key, path: plexPath(library, match, folder) };
  }

  /**
   * Deals with the downloads that have finished since the last look: asks Plex
   * to pick them up, one request per folder, and leaves a note for whoever
   * asked for each. `torrents` is everything of PiRick's in qBittorrent.
   */
  async function finishUp(torrents) {
    const waiting = [];
    for (const torrent of torrents) {
      if (torrent.progress < 1 || SETTLING.has(torrent.state)) continue;
      const row = q.get.get(torrent.hash);
      // No row means it finished before PiRick ever saw it unfinished: old news.
      if (row && row.status !== 'in-plex' && row.status !== 'finished') waiting.push({ torrent, row });
    }

    const settle = ({ torrent, row }, told) => {
      q.status.run(told ? 'in-plex' : 'finished', torrent.hash);
      scanTries.delete(torrent.hash);
      announce(row.username, torrent.name, told);
    };
    const tryAgainLater = ({ torrent, row }, err) => {
      const tries = (scanTries.get(torrent.hash) ?? 0) + 1;
      if (tries === 1) log.warn('upkeep: could not ask Plex to scan, will try again', { title: torrent.name, error: describeError(err) });
      if (tries >= MAX_SCAN_TRIES) return settle({ torrent, row }, false);
      scanTries.set(torrent.hash, tries);
      if (row.status !== 'scanning') q.status.run('scanning', torrent.hash);
    };

    const folders = new Map();
    for (const entry of waiting) {
      if (!plex?.enabled) {
        settle(entry, false);
        continue;
      }
      try {
        const target = await plexFolderOf(entry.torrent);
        if (!target) {
          settle(entry, false);
          continue;
        }
        const id = `${target.key}|${target.path}`;
        if (!folders.has(id)) folders.set(id, { ...target, entries: [] });
        folders.get(id).entries.push(entry);
      } catch (err) {
        tryAgainLater(entry, err);
      }
    }
    for (const { key, path, entries } of folders.values()) {
      try {
        await plex.scan(key, path);
        log.info('upkeep: asked Plex to scan', { folder: path, downloads: entries.length });
        for (const entry of entries) settle(entry, true);
      } catch (err) {
        for (const entry of entries) tryAgainLater(entry, err);
      }
    }
  }

  /** Forgets torrents that have been removed from qBittorrent. */
  function forgetMissing(torrents, time) {
    const present = new Set(torrents.map((torrent) => torrent.hash));
    for (const row of q.all.all()) {
      if (!present.has(row.hash) && time - row.progress_at >= FORGET_AFTER_MS) q.remove.run(row.hash);
    }
  }

  /**
   * A quick look, made every minute whether or not stuck downloads are being
   * replaced: takes note of new downloads and deals with the ones that have
   * just finished.
   */
  async function look() {
    if (running) return { skipped: 'already running' };
    running = true;
    try {
      const time = now();
      const torrents = await qbit.tagged(BASE_TAG);
      await finishUp(torrents);
      for (const torrent of torrents) {
        if (torrent.progress >= 1) continue;
        const row = q.get.get(torrent.hash);
        if (!row) q.insert.run(torrent.hash, torrent.name, usernameOf(torrent), torrent.completed ?? 0, time, 0, '[]');
        // Being downloaded again after it had finished: its clock starts afresh.
        else if (FINISHED.has(row.status)) q.progress.run(torrent.name, torrent.completed ?? 0, time, torrent.hash);
      }
      forgetMissing(torrents, time);
      return { watching: torrents.filter((torrent) => torrent.progress < 1).length };
    } finally {
      running = false;
    }
  }

  /**
   * The copies to fetch instead of a stuck torrent: an array (empty when none
   * was found), or null when the name does not say what it is.
   */
  async function alternatives(torrent, tried) {
    const stuck = parseRelease(torrent.name);
    const quality = stuck.resolution ?? 1080;
    const skip = (release) =>
      release.seeders < 1 ||
      tried.has(release.infoHash) ||
      tried.has(release.title) ||
      Boolean(config.maxTorrentBytes && release.size > config.maxTorrentBytes);
    const read = (found) => found.map((release) => ({ ...release, parsed: parseRelease(release.title) }));
    const sameTitle = ({ parsed }) => parsed.keys.some((key) => stuck.keys.includes(key));
    const plan = async (season) => {
      const found = await planShow((query) => search(query, TV), {
        title: stuck.show,
        season,
        quality,
        maxBytes: config.maxTorrentBytes,
        skip,
        atOnce: config.jackett.searchesAtOnce,
      });
      return found.plan ? found.plan.parts.flatMap((part) => part.releases) : [];
    };

    switch (stuck.kind) {
      case 'episode': {
        const marker = stuck.season == null ? pad(stuck.episode) : `S${pad(stuck.season)}E${pad(stuck.episode)}`;
        const copies = read(await search(`${stuck.show} ${marker}`, TV)).filter(
          (release) =>
            release.parsed.kind === 'episode' &&
            release.parsed.season === stuck.season &&
            release.parsed.episode === stuck.episode &&
            sameTitle(release) &&
            !skip(release),
        );
        return copies.length ? [best(copies, quality)] : [];
      }
      case 'season':
        return plan(stuck.seasons[0]);
      case 'seasons': {
        // Only the seasons the stuck pack held, not the rest of the show.
        const parts = [];
        for (const season of stuck.seasons) parts.push(...(await plan(season)));
        return parts;
      }
      case 'series':
        return plan(null);
      case 'movie': {
        const copies = read(await search(`${stuck.show} ${stuck.year}`, MOVIES)).filter(
          (release) => release.parsed.kind === 'movie' && release.parsed.year === stuck.year && !release.parsed.poor && sameTitle(release) && !skip(release),
        );
        return copies.length ? [best(copies, quality)] : [];
      }
      default:
        return null;
    }
  }

  /** Tries to replace one stuck torrent. Resolves to true when it was replaced. */
  async function replace(torrent, row, time) {
    const label = describeTorrent(torrent.name);
    const tried = new Set([...JSON.parse(row.tried), torrent.hash, torrent.name]);
    // Said once per item; `searched_at` doubles as the "already said" marker.
    const giveNotice = (action, detail) => {
      if (!row.searched_at) note(row.username, action, detail);
      q.searched.run(time, torrent.hash);
      return false;
    };

    const releases = torrent.save_path ? await alternatives(torrent, tried) : null;
    if (releases === null) {
      return giveNotice('stuck', `“${torrent.name}” is stuck, and its name does not say clearly enough what it is to look for another copy.`);
    }
    if (releases.length > MAX_REPLACEMENT_TORRENTS) {
      return giveNotice('stuck', `“${label}” is stuck. Replacing it would take ${releases.length} separate downloads, so it was left for a person to decide.`);
    }

    // Same folder, category and tags, so the new copy lands where the old one was heading.
    const target = { category: torrent.category, savePath: torrent.save_path, tags: tagsOf(torrent) };
    const added = [];
    let errors = 0;
    for (const release of releases) {
      try {
        let hash = release.infoHash;
        if (hash && (await qbit.find(hash))) continue;
        const source = await jackett.resolve(release);
        hash ??= source.magnet ? hashFromMagnet(source.magnet) : infoHashOf(source.file);
        if (hash && (tried.has(hash) || (await qbit.find(hash)))) continue;
        await qbit.add({ ...source, ...target });
        added.push({ title: release.title, hash });
      } catch (err) {
        errors += 1;
        log.warn('upkeep: could not add a replacement', { title: release.title, error: describeError(err) });
      }
    }
    // Copies exist but could not be handed over (a service hiccup): try again next check.
    if (!added.length && errors) return false;
    if (!added.length) {
      return giveNotice('no-copy', `“${label}” is stuck and no other copy could be found. PiRick will keep looking.`);
    }

    // Only now that qBittorrent has the new copy does the stuck one go, with its partial files.
    await qbit.remove(torrent.hash, true);
    q.remove.run(torrent.hash);
    const chain = JSON.stringify([...tried].slice(-TRIED_KEEP));
    for (const { title, hash } of added) {
      if (hash) q.insert.run(hash, title, row.username, 0, time, row.attempts + 1, chain);
    }
    // A pack that could only be replaced by single episodes may now be incomplete: say so.
    const piecemeal = parseRelease(torrent.name).kind !== 'episode' && added.every(({ title }) => parseRelease(title).kind === 'episode');
    let replacement = added.length === 1 ? `another copy (“${added[0].title}”)` : `${added.length} downloads that cover the same thing`;
    if (piecemeal) replacement = `${added.length} single episode${added.length === 1 ? '' : 's'}, all that could be found`;
    note(row.username, 'replaced', `Replaced the stuck download of “${label}” with ${replacement}.`);
    return true;
  }

  /**
   * One round: record progress, find what is stuck, replace what can be replaced.
   * `manual` runs it even when automatic upkeep is switched off.
   */
  async function runOnce({ manual = false } = {}) {
    const { enabled, stuckHours } = settings.upkeep();
    if (!enabled && !manual) return { skipped: 'switched off' };
    if (running) return { skipped: 'already running' };
    running = true;
    try {
      const time = now();
      const torrents = await qbit.tagged(BASE_TAG);
      await finishUp(torrents);
      const stuck = [];
      let watching = 0;

      for (const torrent of torrents) {
        if (torrent.progress >= 1) continue;
        const row = q.get.get(torrent.hash);
        watching += 1;
        const completed = torrent.completed ?? 0;
        if (!row) {
          q.insert.run(torrent.hash, torrent.name, usernameOf(torrent), completed, time, 0, '[]');
          continue;
        }
        if (FINISHED.has(row.status)) {
          // Being downloaded again after it had finished: its clock starts afresh.
          q.progress.run(torrent.name, completed, time, torrent.hash);
          continue;
        }
        if (BROKEN.has(torrent.state)) {
          if (row.status !== 'problem') {
            q.status.run('problem', torrent.hash);
            note(row.username, 'problem', `“${describeTorrent(torrent.name)}” has a problem in qBittorrent (${torrent.state}) that another copy would not fix.`);
          }
          continue;
        }
        if (completed > row.completed || !ACTIVE.has(torrent.state)) {
          // It grew, or it is paused, queued or being checked, when no growth is
          // expected. Either way the clock starts again.
          q.progress.run(torrent.name, completed, time, torrent.hash);
          continue;
        }
        if (time - row.progress_at < stuckHours * HOUR_MS) continue;
        if (row.status !== 'stuck') q.status.run('stuck', torrent.hash);
        stuck.push({ torrent, row });
      }
      forgetMissing(torrents, time);

      let searches = 0;
      let replaced = 0;
      // Longest stuck first.
      for (const { torrent, row } of stuck.sort((a, b) => a.row.progress_at - b.row.progress_at)) {
        if (row.attempts >= MAX_REPLACEMENTS) {
          if (!row.searched_at) {
            note(row.username, 'gave-up', `“${describeTorrent(torrent.name)}” has been replaced ${MAX_REPLACEMENTS} times and is stuck again. It needs a person to look at it.`);
            q.searched.run(time, torrent.hash);
          }
          continue;
        }
        if (row.searched_at && time - row.searched_at < SEARCH_AGAIN_MS) continue;
        if (searches >= MAX_SEARCHES_PER_CHECK) break;
        searches += 1;
        try {
          if (await replace(torrent, row, time)) replaced += 1;
        } catch (err) {
          // Usually the search or download service being down: try again next round.
          log.warn('upkeep: replacement failed', { title: torrent.name, error: describeError(err) });
        }
      }
      return { watching, stuck: stuck.length, replaced };
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    look,

    /** Begins the periodic checks. The timers never keep the process alive. */
    start() {
      const tick = () =>
        runOnce().then(
          (summary) => log.debug('upkeep check', summary),
          (err) => log.warn('upkeep check failed', { error: describeError(err) }),
        );
      // qBittorrent being away would otherwise be reported every minute.
      const glance = () =>
        look().then(
          () => {
            lookFailing = false;
          },
          (err) => {
            if (!lookFailing) log.warn('upkeep could not look at the downloads', { error: describeError(err) });
            lookFailing = true;
          },
        );
      timers = [setTimeout(tick, FIRST_CHECK_MS), setInterval(tick, CHECK_EVERY_MS), setTimeout(glance, FIRST_LOOK_MS), setInterval(glance, LOOK_EVERY_MS)];
      for (const timer of timers) timer.unref();
    },

    stop() {
      for (const timer of timers) clearTimeout(timer);
    },

    /**
     * Called when the chat starts a download, so that one which finishes before
     * the next look is still noticed.
     */
    track({ hash, name, username }) {
      if (hash) q.adopt.run(hash, name, String(username).toLowerCase(), now());
    },

    /** Hashes of the downloads currently considered stuck. */
    stuckHashes: () => new Set(q.all.all().filter((row) => row.status === 'stuck').map((row) => row.hash)),

    /** Hashes of the finished downloads that Plex has been asked to pick up. */
    inPlex: () => new Set(q.all.all().filter((row) => row.status === 'in-plex').map((row) => row.hash)),

    /** How many unfinished downloads are being watched, and how many of them are stuck. */
    overview() {
      const rows = q.all.all().filter((row) => !FINISHED.has(row.status));
      return { watching: rows.length, stuck: rows.filter((row) => row.status === 'stuck').length };
    },

    recent: (limit = 50) => q.recent.all(limit).map((row) => ({ ...row })),

    /** Things done for this person that they have not been told about yet. */
    unseen: (username) => q.unseen.all(String(username).toLowerCase()).map((row) => ({ ...row })),

    markSeen(ids) {
      for (const id of ids) q.seen.run(id);
    },
  };
}
