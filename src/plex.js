// Talks to a Plex Media Server: what it already has, asking it to look at a
// folder again, and what it has taken a download for, which it can be told
// when it took it for something else. The token gives full control of the
// server, so it only ever travels in a request header: never in an address, a
// log line or an error.
import { UpstreamError, describeError } from './errors.js';
import { pathBelow, titleKey } from './folders.js';
import { cleanTitle } from './releases.js';
import { canonicalWord } from './words.js';

const LIBRARIES_FRESH_MS = 5 * 60 * 1000;
// Plex's numbers for the kinds of thing a library holds.
const KINDS = { movie: 1, show: 2 };
// And for what the files of each belong to: a film itself, an episode of a show.
const FILE_KINDS = { movie: 1, show: 4 };
const MAX_MATCHES = 500;
const MAX_WORDS_TRIED = 2;
// Too common to narrow anything down.
const COMMON_WORDS = new Set(['the', 'and', 'for', 'with', 'from']);

const names = (path) => String(path ?? '').split(/[/\\]+/).filter(Boolean);

/**
 * The Plex folder a PiRick library saves into. qBittorrent and Plex usually
 * see one folder under different paths ("/media/TV" and "/data/TV"), so it is
 * worked out from how the two paths end. `choice` is what an admin picked
 * instead: `{ key, path }`, or `{ none: true }` for a library Plex does not have.
 *
 * Returns `{ key, title, path, chosen }`, or null when nothing matches.
 */
export function matchLibrary(library, plexLibraries, choice) {
  if (choice?.none) return null;
  const folders = plexLibraries.flatMap(({ key, title, folders: paths }) => paths.map((path) => ({ key, title, path })));
  const picked = choice?.key ? folders.find((folder) => folder.key === choice.key && folder.path === choice.path) : null;
  if (picked) return { ...picked, chosen: true };

  const ending = (path) => names(path).map((name) => name.toLowerCase()).reverse();
  const mine = ending(library.savePath);
  let best = null;
  let most = 0;
  for (const folder of folders) {
    const theirs = ending(folder.path);
    let shared = 0;
    while (shared < mine.length && shared < theirs.length && mine[shared] === theirs[shared]) shared += 1;
    if (shared > most) {
      best = folder;
      most = shared;
    }
  }
  return best ? { ...best, chosen: false } : null;
}

/**
 * The path Plex uses for `folder`, a folder inside `library` as qBittorrent
 * names it, given the Plex folder the library matches. Null when it is not inside.
 */
export function plexPath(library, match, folder) {
  const below = pathBelow(library.savePath, folder);
  if (!below) return null;
  const separator = match.path.includes('\\') && !match.path.includes('/') ? '\\' : '/';
  return [match.path.replace(/[/\\]+$/, ''), ...below].join(separator);
}

/**
 * Words to ask Plex for. It finds titles that contain a word exactly as
 * written, so the words least likely to be written another way go first: not
 * numbers ("7" or "Seven"), and not ones that may hide an apostrophe.
 */
function searchWords(title) {
  const plain = String(title)
    .split(/[^\p{L}\p{N}'’]+/u)
    .filter((word) => /^[a-z]{3,}$/i.test(word) && canonicalWord(word) === word.toLowerCase() && !COMMON_WORDS.has(word.toLowerCase()));
  const possessive = (word) => /s$/i.test(word);
  plain.sort((a, b) => possessive(a) - possessive(b) || b.length - a.length);
  const words = [...new Set(plain.map((word) => word.toLowerCase()))].slice(0, MAX_WORDS_TRIED);
  return words.length ? words : [String(title).trim()];
}

// What Plex's own ids for films and shows look like. Anything else is from one of its older agents.
const PLEX_ID = /^plex:\/\//;
// What it gives something it could not match to anything.
const UNMATCHED = /^(?:local|com\.plexapp\.agents\.none):\/\//;
const imdbIn = (text) => /\btt\d{5,}\b/.exec(String(text ?? ''))?.[0] ?? null;

/** The files of one film or episode, as Plex lists it. */
const filesIn = (item) => (item.Media ?? []).flatMap((media) => (media.Part ?? []).map((part) => String(part.file ?? ''))).filter(Boolean);

/**
 * What Plex has taken a film or show for: `{ id, kind, title, year, matched,
 * imdb, folders }`. `matched` is false when it took it for nothing at all, and
 * `imdb` is the number IMDb gives what it took it for, or null when Plex does
 * not say. `folders` are the folders it keeps a show in, more than one when it
 * has put two folders together as one show.
 */
function filedAs(item) {
  const guid = String(item.guid ?? '');
  const own = (item.Guid ?? []).map((entry) => String(entry.id ?? '')).find((id) => id.startsWith('imdb://'));
  return {
    id: String(item.ratingKey),
    kind: String(item.type ?? ''),
    // Read by people, and retold by the model, so tidied like any other name that came from elsewhere.
    title: cleanTitle(item.title),
    year: Number(item.year) || null,
    matched: Boolean(guid) && !UNMATCHED.test(guid),
    // The older IMDb agent put the number in the id itself.
    imdb: imdbIn(own) ?? (/^com\.plexapp\.agents\.imdb:/.test(guid) ? imdbIn(guid) : null),
    folders: (item.Location ?? []).map((location) => String(location.path ?? '')).filter(Boolean),
  };
}

/** `fetch` can be replaced, which the benchmark does to stand in for a Plex server. */
export function createPlex(config, { fetch: send = fetch } = {}) {
  let known = null;

  async function ask(path, params, headers = {}, method = 'GET') {
    if (!config.url) throw new UpstreamError('plex', 'PLEX_URL is not set');
    if (!config.token) throw new UpstreamError('plex', 'PLEX_TOKEN is not set');
    const query = params ? `?${new URLSearchParams(params)}` : '';
    let res;
    try {
      res = await send(config.url + path + query, {
        method,
        headers: { Accept: 'application/json', 'X-Plex-Token': config.token, 'X-Plex-Product': 'PiRick', 'X-Plex-Client-Identifier': 'pirick', ...headers },
        // Following a redirect would hand the token to wherever it points.
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError('plex', `Cannot reach Plex at ${config.url} (${describeError(err)})`);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new UpstreamError('plex', 'Plex rejected the token: check PLEX_TOKEN');
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError('plex', `Plex returned HTTP ${res.status} for ${path}`);
    }
    return res;
  }

  async function read(path, params, headers) {
    const res = await ask(path, params, headers);
    try {
      return (await res.json()).MediaContainer ?? {};
    } catch {
      throw new UpstreamError('plex', 'Plex did not answer as expected: check PLEX_URL');
    }
  }

  /** Plex's libraries: `{ key, title, type, folders }`. They rarely change, so the answer is kept for a while. */
  async function libraries({ fresh = false } = {}) {
    if (!fresh && known && Date.now() - known.at < LIBRARIES_FRESH_MS) return known.list;
    const container = await read('/library/sections');
    const list = (container.Directory ?? []).map((entry) => ({
      key: String(entry.key),
      title: String(entry.title ?? ''),
      type: String(entry.type ?? ''),
      folders: (entry.Location ?? []).map((location) => String(location.path ?? '')).filter(Boolean),
    }));
    known = { at: Date.now(), list };
    return list;
  }

  /** Everything of one kind that Plex has under this title, in whichever library. */
  async function titled(kind, title) {
    const wanted = titleKey(title);
    if (!wanted) return [];
    const found = new Map();
    for (const library of (await libraries()).filter((entry) => entry.type === kind)) {
      for (const word of searchWords(title)) {
        const container = await read(
          `/library/sections/${encodeURIComponent(library.key)}/all`,
          { type: KINDS[kind], title: word },
          { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': String(MAX_MATCHES) },
        );
        // The comparing is done here, where "7 Chances" and "Seven Chances" are one title.
        const same = (container.Metadata ?? []).filter((item) => [item.title, item.originalTitle].some((name) => name && titleKey(name) === wanted));
        for (const item of same) {
          // The title is read by the model, so it is tidied like any other name that came from elsewhere.
          found.set(String(item.ratingKey), { id: String(item.ratingKey), title: cleanTitle(item.title), year: Number(item.year) || null, library: library.title });
        }
        if (same.length) break;
      }
    }
    return [...found.values()];
  }

  return {
    /** False when PLEX_URL or PLEX_TOKEN is not set, and PiRick carries on without Plex. */
    enabled: Boolean(config.url && config.token),

    libraries,

    /**
     * The films or shows that hold a file at or below `path`, a folder or a
     * file as Plex names it, in one library: a list of `{ id, kind, title, year,
     * matched, imdb, folders }` (see filedAs). Empty until Plex has picked the
     * files up.
     */
    async holding(key, path) {
      const library = (await libraries()).find((entry) => entry.key === String(key));
      if (!library || !FILE_KINDS[library.type] || !path) return [];
      const container = await read(
        `/library/sections/${encodeURIComponent(library.key)}/all`,
        { type: FILE_KINDS[library.type], file: path, includeGuids: 1 },
        { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': String(MAX_MATCHES) },
      );
      // Plex finds every file whose path has the text in it, so ".../Show" finds ".../Show 2" as well.
      const inside = (container.Metadata ?? []).filter((item) => filesIn(item).some((file) => pathBelow(path, file)));
      if (library.type === 'movie') return inside.map(filedAs);
      // An episode says which show it is of, and the show says what it was taken for.
      const found = [];
      for (const id of new Set(inside.map((episode) => String(episode.grandparentRatingKey ?? '')).filter(Boolean))) {
        const [show] = (await read(`/library/metadata/${encodeURIComponent(id)}`, { includeGuids: 1 })).Metadata ?? [];
        if (show) found.push(filedAs(show));
      }
      return found;
    },

    /** Every file of a film or show (as `holding` gives it), wherever Plex keeps it. */
    async filesOf(item) {
      const id = encodeURIComponent(item.id);
      const container = await read(item.kind === 'show' ? `/library/metadata/${id}/allLeaves` : `/library/metadata/${id}`);
      return (container.Metadata ?? []).flatMap(filesIn);
    },

    /**
     * What Plex's own search has under an IMDb number, as the thing one of its
     * items could be: `{ guid, name, year }`. Asked by number it answers with
     * the one film or show that has it, where a name gets twenty. Null when it
     * knows nothing by the number or cannot say which, as a library still on
     * one of Plex's older agents cannot.
     */
    async candidate(item, imdb) {
      const container = await read(`/library/metadata/${encodeURIComponent(item.id)}/matches`, { manual: 1, title: imdb });
      const offered = (container.SearchResult ?? []).filter((result) => result.type === item.kind && PLEX_ID.test(String(result.guid ?? '')));
      if (offered.length !== 1) return null;
      return { guid: String(offered[0].guid), name: String(offered[0].name ?? ''), year: Number(offered[0].year) || null };
    },

    /** Tells Plex that one of its items is what `candidate` found. Its files stay as they are. */
    async match(item, { guid, name, year }) {
      const res = await ask(`/library/metadata/${encodeURIComponent(item.id)}/match`, { guid, name, ...(year && { year }) }, {}, 'PUT');
      await res.body?.cancel();
    },

    /** Asks Plex to look at one folder of a library again, or at all of the library when no folder is given. */
    async scan(key, path) {
      const res = await ask(`/library/sections/${encodeURIComponent(key)}/refresh`, path ? { path } : undefined);
      await res.body?.cancel();
    },

    /** The films Plex has under this title. With a year, only those within a year of it, as dates differ between sources. */
    async films(title, year = null) {
      const all = await titled('movie', title);
      return year == null ? all : all.filter((film) => film.year == null || Math.abs(film.year - year) <= 1);
    },

    /**
     * The show Plex has under this title and which episodes of it:
     * `{ title, year, seasons, folders }`, where `seasons` maps a season number
     * to the set of its episode numbers and `folders` names the folders it is
     * kept in, each inside one of Plex's library folders. Null when Plex has no
     * such show, or has two different ones and nothing says which is meant.
     */
    async show(title, year = null) {
      let shows = await titled('show', title);
      if (year != null) shows = shows.filter((show) => show.year == null || Math.abs(show.year - year) <= 1);
      // One show kept in two libraries is still one show; two from different years are not.
      const years = shows.map((show) => show.year).filter((value) => value != null);
      if (!shows.length || Math.max(...years, 0) - Math.min(...years, Infinity) > 1) return null;

      const roots = (await libraries()).filter((library) => library.type === 'show').flatMap((library) => library.folders);
      const seasons = new Map();
      const folders = new Set();
      for (const show of shows) {
        const container = await read(`/library/metadata/${encodeURIComponent(show.id)}/allLeaves`);
        for (const item of container.Metadata ?? []) {
          // A show's folder is the first below the library's, whatever lies between it and the file.
          const below = roots.map((root) => pathBelow(root, item.Media?.[0]?.Part?.[0]?.file ?? '')).find((parts) => parts?.length > 1);
          if (below) folders.add(cleanTitle(below[0]));
          const season = Number(item.parentIndex);
          const episode = Number(item.index);
          // Season 0 is where Plex keeps specials.
          if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode)) continue;
          if (!seasons.has(season)) seasons.set(season, new Set());
          seasons.get(season).add(episode);
        }
      }
      return { title: shows[0].title, year: shows[0].year, seasons, folders: [...folders] };
    },

    /** Confirms the address and token work, and says which server answered. */
    async check() {
      const server = await read('/');
      if (!server.machineIdentifier) throw new UpstreamError('plex', 'Unexpected reply: check PLEX_URL');
      const count = (await libraries({ fresh: true })).length;
      const version = String(server.version ?? '').split('-')[0];
      return `${server.friendlyName || 'Plex Media Server'}${version ? ` ${version}` : ''}, ${count} librar${count === 1 ? 'y' : 'ies'}`;
    },
  };
}
