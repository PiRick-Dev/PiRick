// A stand-in for a Plex Media Server, answering the few requests PiRick makes
// the way a real one does. Used by the benchmark and by the tests, through the
// real Plex client, so what is measured includes how PiRick reads Plex.
//
// `libraries` is a list of
//   { key, title, type: 'movie' | 'show', folders: [path], items: [...] }
// where a film is { title, year } and a show is { title, year, seasons }, with
// `seasons` mapping a season number to how many episodes of it are there (or
// to the list of episode numbers).
//
// For what Plex has taken a thing for, an item can also say
//   imdb       the number IMDb gives what Plex matched it to
//   unmatched  true when Plex matched it to nothing
//   files      where its files are, as Plex names them. An episode's season
//              and number are read from its name ("S01E02")
// and `knows` lists what Plex's own search can be asked for by such a number:
//   { imdb, kind: 'movie' | 'show', title, year }

export const PLEX_TOKEN = 'stand-in-plex-token';
export const PLEX_URL = 'http://plex.invalid:32400';

const KINDS = { 1: 'movie', 2: 'show' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const pad = (number) => String(number).padStart(2, '0');
const idOf = (known) => `plex://${known.kind}/${known.imdb}`;

export function plexStandIn(libraries, { token = PLEX_TOKEN, name = 'Home', knows = [] } = {}) {
  // Every film and show gets a number, as it has in Plex.
  const items = new Map();
  let next = 100;
  const add = (library, item) => {
    const id = String(next++);
    items.set(id, { ...item, library });
    return id;
  };
  for (const library of libraries) {
    for (const item of library.items ?? []) add(library, item);
  }
  const state = { requests: [], scans: [], matches: [], down: false, deaf: false };

  /** The episodes of a show: `{ season, index, file }`. */
  function leavesOf(show) {
    const counted = Object.entries(show.seasons ?? {}).flatMap(([season, episodes]) =>
      (Array.isArray(episodes) ? episodes : Array.from({ length: episodes }, (unused, i) => i + 1)).map((index) => ({
        season: Number(season),
        index,
        // Where the file is, as Plex sees it: in the show's folder, which is named after it unless `folder` says otherwise.
        file: `${show.library.folders[0]}/${show.folder ?? show.title}/Season ${pad(season)}/S${pad(season)}E${pad(index)}.mkv`,
      })),
    );
    const listed = (show.files ?? []).map((file, i) => {
      const [, season, index] = /S(\d{1,2})E(\d{1,3})/i.exec(file.split('/').pop()) ?? [];
      return { season: Number(season ?? 1), index: Number(index ?? i + 1), file };
    });
    return [...counted, ...listed];
  }
  const filesOf = (item) => (item.library.type === 'show' ? leavesOf(item).map((leaf) => leaf.file) : (item.files ?? []));
  /** The folders a show is kept in: the first below its library's, for each of its files. */
  const foldersOf = (show) => [
    ...new Set(
      leavesOf(show).map(({ file }) => {
        const root = show.library.folders.find((folder) => file.startsWith(`${folder}/`)) ?? show.library.folders[0];
        return `${root}/${file.slice(root.length + 1).split('/')[0]}`;
      }),
    ),
  ];
  const media = (files) => files.map((file) => ({ Part: [{ file }] }));

  /** A film or show as Plex lists it. What it was matched to comes with `includeGuids`. */
  function listed(ratingKey, item, { guids = false, full = false } = {}) {
    const { type } = item.library;
    return {
      ratingKey,
      type,
      title: item.title,
      ...(!item.unmatched && { year: item.year }),
      ...(item.originalTitle && { originalTitle: item.originalTitle }),
      guid: item.unmatched ? `local://${ratingKey}` : item.imdb ? `plex://${type}/${item.imdb}` : `plex://${type}/${ratingKey}`,
      ...(guids && !item.unmatched && item.imdb && { Guid: [{ id: `imdb://${item.imdb}` }, { id: `tmdb://${ratingKey}` }] }),
      ...(type === 'movie' && item.files && { Media: media(item.files) }),
      ...(full && type === 'show' && { Location: foldersOf(item).map((path) => ({ path })) }),
    };
  }

  /** Answers one request as `fetch` would. */
  async function answer(address, { headers = {}, method = 'GET' } = {}) {
    const url = new URL(address);
    const header = (wanted) => Object.entries(headers).find(([key]) => key.toLowerCase() === wanted.toLowerCase())?.[1];
    state.requests.push({ path: url.pathname, search: url.search, token: header('X-Plex-Token'), ...(method !== 'GET' && { method }) });
    if (state.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (header('X-Plex-Token') !== token) return new Response('<html><head><title>Unauthorized</title></head></html>', { status: 401 });

    if (url.pathname === '/') return json({ MediaContainer: { friendlyName: name, machineIdentifier: 'abc123', version: '1.41.0.8994-f2c27da23' } });
    if (url.pathname === '/library/sections') {
      const Directory = libraries.map(({ key, title, type, folders }) => ({ key, title, type, Location: folders.map((path, i) => ({ id: i + 1, path })) }));
      return json({ MediaContainer: { size: Directory.length, Directory } });
    }

    const section = /^\/library\/sections\/([^/]+)\/(all|refresh)$/.exec(url.pathname);
    const library = section && libraries.find((entry) => entry.key === decodeURIComponent(section[1]));
    if (section && !library) return new Response('', { status: 404 });
    if (section?.[2] === 'refresh') {
      state.scans.push({ key: library.key, path: url.searchParams.get('path') });
      return new Response('', { status: 200 });
    }
    if (section) {
      const guids = url.searchParams.get('includeGuids') === '1';
      const own = [...items].filter(([, item]) => item.library === library);
      // Plex finds files whose path has the text anywhere in it, whatever the capitals.
      const file = url.searchParams.get('file')?.toLowerCase();
      if (file != null && url.searchParams.get('type') === '4') {
        const Metadata = own.flatMap(([ratingKey, show]) =>
          (library.type === 'show' ? leavesOf(show) : [])
            .filter((leaf) => leaf.file.toLowerCase().includes(file))
            .map((leaf) => ({ type: 'episode', grandparentRatingKey: ratingKey, grandparentTitle: show.title, parentIndex: leaf.season, index: leaf.index, Media: media([leaf.file]) })),
        );
        return json({ MediaContainer: { size: Metadata.length, Metadata } });
      }
      // And titles that contain the text as written, whatever the capitals.
      const wanted = (url.searchParams.get('title') ?? '').toLowerCase();
      const kind = KINDS[url.searchParams.get('type')] ?? library.type;
      const Metadata = own
        .filter(([, item]) => library.type === kind && item.title.toLowerCase().includes(wanted))
        .filter(([, item]) => file == null || filesOf(item).some((path) => path.toLowerCase().includes(file)))
        .map(([ratingKey, item]) => listed(ratingKey, item, { guids }));
      return json({ MediaContainer: { size: Metadata.length, Metadata } });
    }

    const [, key, part] = /^\/library\/metadata\/([^/]+)(?:\/(allLeaves|matches|match))?$/.exec(url.pathname) ?? [];
    const item = key && items.get(decodeURIComponent(key));
    if (!item) return new Response('', { status: 404 });
    if (!part) return json({ MediaContainer: { size: 1, Metadata: [listed(decodeURIComponent(key), item, { guids: true, full: true })] } });
    if (part === 'allLeaves' && item.library.type === 'show') {
      const Metadata = leavesOf(item).map((leaf) => ({ type: 'episode', parentIndex: leaf.season, index: leaf.index, title: `Episode ${leaf.index}`, Media: media([leaf.file]) }));
      return json({ MediaContainer: { size: Metadata.length, Metadata } });
    }
    if (part === 'matches') {
      // Asked by an IMDb number, Plex's search answers with the one thing that has it. By name it answers with whatever is like it.
      const asked = url.searchParams.get('title') ?? '';
      const number = /^(?:imdb-)?(tt\d+)$/.exec(asked)?.[1];
      const SearchResult = knows
        .filter((known) => known.kind === item.library.type && (number ? known.imdb === number : known.title.toLowerCase().includes(asked.toLowerCase())))
        .map((known) => ({ type: known.kind, guid: idOf(known), name: known.title, year: known.year }));
      return json({ MediaContainer: { size: SearchResult.length, SearchResult } });
    }
    if (part === 'match' && method === 'PUT') {
      const to = knows.find((known) => idOf(known) === url.searchParams.get('guid'));
      if (!to) return new Response('', { status: 400 });
      state.matches.push({ id: decodeURIComponent(key), imdb: to.imdb, name: url.searchParams.get('name'), year: url.searchParams.get('year') });
      // A real server takes a second or two over it, and its files stay where they are.
      if (!state.deaf) Object.assign(item, { title: to.title, year: to.year, imdb: to.imdb, unmatched: false });
      return new Response('', { status: 200 });
    }
    return new Response('', { status: 404 });
  }

  return {
    fetch: answer,
    token,
    /** Every request made, as `{ path, search, token }`, with `method` when it was not a read. */
    requests: state.requests,
    /** The folders Plex was asked to look at again, as `{ key, path }`. */
    scans: state.scans,
    /** What Plex was told its items are, as `{ id, imdb, name, year }`. */
    matches: state.matches,
    /** Makes the server unreachable, or reachable again. */
    setDown(down) {
      state.down = down;
    },
    /** Makes the server accept being told what an item is without acting on it, or act on it again. */
    setDeaf(deaf) {
      state.deaf = deaf;
    },
    /** Puts one more film or show in the library with this key, as a scan does. Gives its number. */
    add(key, item) {
      return add(libraries.find((library) => library.key === key), item);
    },
    /** A film or show by its number, as it stands. */
    item: (id) => items.get(String(id)),
  };
}
