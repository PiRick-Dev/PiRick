import { UpstreamError, describeError } from './errors.js';
import { log } from './log.js';

const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32ToHex(value) {
  let bits = '';
  for (const char of value.toLowerCase()) bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Returns a 40-character lowercase hex info hash, or null. */
export function normaliseHash(value) {
  if (typeof value !== 'string') return null;
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(value)) return base32ToHex(value);
  return null;
}

export function hashFromMagnet(magnet) {
  const match = /[?&]xt=urn:btih:([a-z0-9]+)/i.exec(magnet ?? '');
  return match ? normaliseHash(match[1]) : null;
}

function cleanTitle(title) {
  // Titles come from the internet: drop control characters and cap the length.
  return String(title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalise(raw) {
  const magnet = [raw.MagnetUri, raw.Link].find((v) => typeof v === 'string' && v.startsWith('magnet:?')) ?? null;
  const link = typeof raw.Link === 'string' && /^https?:\/\//i.test(raw.Link) ? raw.Link : null;
  const title = cleanTitle(raw.Title);
  if (!title || (!magnet && !link)) return null;
  return {
    title,
    size: Number(raw.Size) || 0,
    seeders: Number(raw.Seeders) || 0,
    indexer: String(raw.Tracker ?? ''),
    categories: Array.isArray(raw.Category) ? raw.Category.map(Number) : [],
    published: typeof raw.PublishDate === 'string' ? raw.PublishDate : null,
    magnet,
    link,
    infoHash: normaliseHash(raw.InfoHash) ?? hashFromMagnet(magnet),
  };
}

export function createJackett(config) {
  // Indexers that reported an error in the most recent searches, and why.
  const failing = new Map();
  async function get(indexer, path, params, accept) {
    if (!config.apiKey) throw new UpstreamError('jackett', 'JACKETT_API_KEY is not set');
    const url = new URL(`${config.url}/api/v2.0/indexers/${encodeURIComponent(indexer)}/results${path}`);
    url.searchParams.set('apikey', config.apiKey);
    for (const [key, value] of params) url.searchParams.append(key, value);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(config.timeoutMs) });
    } catch (err) {
      // Never include `url` in an error: it carries the API key.
      throw new UpstreamError('jackett', `Cannot reach Jackett at ${config.url} (${describeError(err)})`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new UpstreamError('jackett', 'Jackett rejected the API key: check JACKETT_API_KEY');
    }
    if (!res.ok) throw new UpstreamError('jackett', `Jackett returned HTTP ${res.status}`);
    return res;
  }

  return {
    /** Searches Jackett; returns results sorted by seeders, best first. */
    async search(query, categories = []) {
      const params = [['Query', query], ...categories.map((id) => ['Category[]', String(id)])];
      const res = await get(config.indexer, '', params, 'application/json');
      // A wrong key or URL usually lands on Jackett's HTML login page.
      if (!res.headers.get('content-type')?.includes('json')) {
        throw new UpstreamError('jackett', 'Jackett did not return search results: check JACKETT_URL and JACKETT_API_KEY');
      }
      const data = await res.json();
      // Jackett answers with whatever worked, so a broken indexer is easy to miss.
      for (const entry of data.Indexers ?? []) {
        const name = String(entry.Name ?? entry.ID);
        if (!entry.Error) {
          failing.delete(name);
          continue;
        }
        const reason = String(entry.Error).split('\n')[0].replace(/^[\w.]*Exception:\s*/, '').slice(0, 140);
        if (!failing.has(name)) log.warn('a Jackett indexer is failing', { indexer: name, reason });
        failing.set(name, reason);
      }
      const seen = new Set();
      const results = [];
      const all = (data.Results ?? []).map(normalise).filter(Boolean).sort((a, b) => b.seeders - a.seeders);
      for (const result of all) {
        if (result.infoHash) {
          if (seen.has(result.infoHash)) continue;
          seen.add(result.infoHash);
        }
        results.push(result);
      }
      const seeded = results.filter((result) => result.seeders > 0);
      return seeded.length ? seeded : results;
    },

    /**
     * Turns a result into something qBittorrent can take without reaching Jackett
     * itself: `{ magnet }` or `{ file }` (the .torrent bytes).
     */
    async resolve(result) {
      if (result.magnet) return { magnet: result.magnet };
      let url = result.link;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (url.startsWith('magnet:?')) return { magnet: url };
        const target = new URL(url);
        if (target.protocol !== 'http:' && target.protocol !== 'https:') break;
        let res;
        try {
          res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        } catch (err) {
          throw new UpstreamError('jackett', `Could not fetch the torrent file (${describeError(err)})`);
        }
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) break;
          url = location.startsWith('magnet:') ? location : new URL(location, target).href;
          continue;
        }
        if (!res.ok) throw new UpstreamError('jackett', `The indexer returned HTTP ${res.status} for the torrent file`);
        if (Number(res.headers.get('content-length')) > MAX_TORRENT_FILE_BYTES) {
          throw new UpstreamError('jackett', 'The torrent file is unexpectedly large');
        }
        const file = new Uint8Array(await res.arrayBuffer());
        // Every .torrent is a bencoded dictionary, which starts with "d".
        if (file.length === 0 || file.length > MAX_TORRENT_FILE_BYTES || file[0] !== 0x64) {
          throw new UpstreamError('jackett', 'The indexer did not return a valid torrent file');
        }
        return { file };
      }
      throw new UpstreamError('jackett', 'Could not follow the download link for this result');
    },

    /** Confirms the API key works and reports how many indexers are set up. */
    async check() {
      const res = await get('all', '/torznab/api', [['t', 'indexers'], ['configured', 'true']], 'application/xml');
      const xml = await res.text();
      const error = /<error[^>]*description="([^"]*)"/.exec(xml);
      if (error) throw new UpstreamError('jackett', `Jackett says: ${error[1]}`);
      if (!xml.includes('<indexers')) {
        throw new UpstreamError('jackett', 'Unexpected reply: check JACKETT_URL and JACKETT_API_KEY');
      }
      const count = (xml.match(/<indexer\b/g) ?? []).length;
      if (count === 0) throw new UpstreamError('jackett', 'Connected, but no indexers are configured in Jackett');
      const broken = failing.size ? `; failing in recent searches: ${[...failing.keys()].join(', ')}` : '';
      return `${count} indexer${count === 1 ? '' : 's'} configured${broken}`;
    },
  };
}
