// A stand-in for a Plex Media Server, answering the few requests PiRick makes
// the way a real one does. Used by the benchmark and by the tests, through the
// real Plex client, so what is measured includes how PiRick reads Plex.
//
// `libraries` is a list of
//   { key, title, type: 'movie' | 'show', folders: [path], items: [...] }
// where a film is { title, year } and a show is { title, year, seasons }, with
// `seasons` mapping a season number to how many episodes of it are there (or
// to the list of episode numbers).

export const PLEX_TOKEN = 'stand-in-plex-token';
export const PLEX_URL = 'http://plex.invalid:32400';

const KINDS = { 1: 'movie', 2: 'show' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

export function plexStandIn(libraries, { token = PLEX_TOKEN, name = 'Home' } = {}) {
  // Every film and show gets a number, as it has in Plex.
  const items = new Map();
  for (const library of libraries) {
    for (const item of library.items ?? []) items.set(String(items.size + 100), { ...item, library });
  }
  const state = { requests: [], scans: [], down: false };

  /** Answers one request as `fetch` would. */
  async function answer(address, { headers = {} } = {}) {
    const url = new URL(address);
    const header = (wanted) => Object.entries(headers).find(([key]) => key.toLowerCase() === wanted.toLowerCase())?.[1];
    state.requests.push({ path: url.pathname, search: url.search, token: header('X-Plex-Token') });
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
      // Plex finds titles that contain the text as written, whatever the capitals.
      const wanted = (url.searchParams.get('title') ?? '').toLowerCase();
      const kind = KINDS[url.searchParams.get('type')] ?? library.type;
      const Metadata = [...items]
        .filter(([, item]) => item.library === library && library.type === kind && item.title.toLowerCase().includes(wanted))
        .map(([ratingKey, item]) => ({ ratingKey, type: kind, title: item.title, year: item.year, ...(item.originalTitle && { originalTitle: item.originalTitle }) }));
      return json({ MediaContainer: { size: Metadata.length, Metadata } });
    }

    const leaves = /^\/library\/metadata\/([^/]+)\/allLeaves$/.exec(url.pathname);
    const show = leaves && items.get(decodeURIComponent(leaves[1]));
    if (show?.seasons) {
      const Metadata = Object.entries(show.seasons).flatMap(([season, episodes]) =>
        (Array.isArray(episodes) ? episodes : Array.from({ length: episodes }, (unused, i) => i + 1)).map((index) => ({ type: 'episode', parentIndex: Number(season), index, title: `Episode ${index}` })),
      );
      return json({ MediaContainer: { size: Metadata.length, Metadata } });
    }
    return new Response('', { status: 404 });
  }

  return {
    fetch: answer,
    token,
    /** Every request made, as `{ path, search, token }`. */
    requests: state.requests,
    /** The folders Plex was asked to look at again, as `{ key, path }`. */
    scans: state.scans,
    /** Makes the server unreachable, or reachable again. */
    setDown(down) {
      state.down = down;
    },
  };
}
