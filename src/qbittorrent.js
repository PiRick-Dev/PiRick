import { UpstreamError, describeError } from './errors.js';
import { baseNames } from './folders.js';

export const BASE_TAG = 'pirick';
const ETA_UNKNOWN = 8_640_000;
const SEEDING_STATES = new Set(['uploading', 'stalledUP', 'forcedUP', 'queuedUP', 'pausedUP', 'stoppedUP', 'checkingUP']);

/** The qBittorrent tag that marks a torrent as requested by this user. */
export function userTag(username) {
  return `${BASE_TAG}-${username.toLowerCase()}`;
}

export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function statusOf(torrent) {
  if (torrent.progress >= 1 || SEEDING_STATES.has(torrent.state)) return 'finished';
  switch (torrent.state) {
    case 'downloading':
    case 'forcedDL':
      return 'downloading';
    case 'stalledDL':
      return 'waiting';
    case 'metaDL':
    case 'forcedMetaDL':
    case 'allocating':
      return 'starting';
    case 'queuedDL':
      return 'queued';
    case 'pausedDL':
    case 'stoppedDL':
      return 'paused';
    case 'checkingDL':
    case 'checkingResumeData':
    case 'moving':
      return 'checking';
    case 'error':
    case 'missingFiles':
      return 'error';
    default:
      return 'unknown';
  }
}

/** Reduces a qBittorrent torrent to what PiRick shows people. */
export function toDownload(torrent) {
  const status = statusOf(torrent);
  const active = status === 'downloading' && torrent.eta > 0 && torrent.eta < ETA_UNKNOWN;
  return {
    name: torrent.name,
    status,
    // Capped so an unfinished download never reads as 100%.
    progress: status === 'finished' ? 100 : Math.min(99.9, Math.round((torrent.progress ?? 0) * 1000) / 10),
    size: formatBytes(torrent.size),
    etaSeconds: active ? torrent.eta : null,
    addedAt: (torrent.added_on ?? 0) * 1000,
    requestedBy: String(torrent.tags ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.startsWith(`${BASE_TAG}-`))
      .map((tag) => tag.slice(BASE_TAG.length + 1)),
  };
}

export function createQbittorrent(config) {
  let cookie = null;

  async function raw(path, init = {}) {
    const headers = cookie ? { Cookie: cookie } : {};
    try {
      return await fetch(config.url + path, { ...init, headers, signal: AbortSignal.timeout(config.timeoutMs) });
    } catch (err) {
      throw new UpstreamError('qbittorrent', `Cannot reach qBittorrent at ${config.url} (${describeError(err)})`);
    }
  }

  async function login() {
    cookie = null;
    const res = await raw('/api/v2/auth/login', {
      method: 'POST',
      body: new URLSearchParams({ username: config.username, password: config.password }),
    });
    const body = (await res.text()).trim();
    if (res.status === 403) {
      throw new UpstreamError('qbittorrent', 'qBittorrent has temporarily banned PiRick after too many failed logins');
    }
    if (!res.ok || body === 'Fails.') {
      // A signed-out request normally gets 403. If even that gets 401, qBittorrent
      // is rejecting the Host header, which it does when its port is remapped.
      const probe = await raw('/api/v2/app/webapiVersion');
      await probe.body?.cancel();
      if (probe.status === 401) {
        throw new UpstreamError(
          'qbittorrent',
          'qBittorrent is refusing PiRick before it looks at the password. Its port is probably remapped: use the same port number inside and outside its container, or turn off "Enable Host header validation" in its Web UI options',
        );
      }
      throw new UpstreamError('qbittorrent', 'qBittorrent rejected the login: check QBIT_USERNAME and QBIT_PASSWORD');
    }
    // The cookie name differs between qBittorrent versions, so keep whatever is set.
    cookie = res.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ') || null;
  }

  /** Sends a request, signing in first if the session is missing or has expired. */
  async function send(path, init) {
    let res = await raw(path, init);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      await login();
      res = await raw(path, init);
    }
    return res;
  }

  async function request(path, init) {
    const res = await send(path, init);
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpstreamError('qbittorrent', `qBittorrent returned HTTP ${res.status} for ${path.split('?')[0]}`);
    }
    return res;
  }

  async function info(params) {
    const res = await request(`/api/v2/torrents/info?${new URLSearchParams(params)}`);
    return res.json();
  }

  return {
    /** Adds a torrent from a magnet link or the bytes of a .torrent file. */
    async add({ magnet, file, category, savePath, tags }) {
      const form = new FormData();
      if (magnet) form.set('urls', magnet);
      else form.set('torrents', new Blob([file], { type: 'application/x-bittorrent' }), 'pirick.torrent');
      if (category) form.set('category', category);
      if (savePath) {
        form.set('savepath', savePath);
        form.set('autoTMM', 'false');
      }
      if (tags?.length) form.set('tags', tags.join(','));

      const res = await request('/api/v2/torrents/add', { method: 'POST', body: form });
      const body = (await res.text()).trim();
      let rejected = body === 'Fails.';
      if (body.startsWith('{')) {
        // Newer versions answer with counts instead of "Ok." / "Fails.".
        try {
          const counts = JSON.parse(body);
          rejected = counts.failure_count > 0 && !counts.success_count && !counts.pending_count;
        } catch {
          rejected = false;
        }
      }
      if (rejected) {
        throw new UpstreamError('qbittorrent', 'qBittorrent refused the torrent (it may already be in the list)');
      }
    },

    /** Torrents carrying `tag`, newest first. */
    async list(tag) {
      const torrents = await info({ tag, sort: 'added_on', reverse: 'true' });
      return torrents.map(toDownload);
    },

    /** The torrent with this info hash, or null. */
    async find(infoHash) {
      const [torrent] = await info({ hashes: infoHash });
      return torrent ? toDownload(torrent) : null;
    },

    async addTags(infoHash, tags) {
      await request('/api/v2/torrents/addTags', {
        method: 'POST',
        body: new URLSearchParams({ hashes: infoHash, tags: tags.join(',') }),
      });
    },

    /**
     * The folders inside `path`, as qBittorrent sees them: `{ exists, names }`.
     * Returns null when qBittorrent cannot say (the call needs version 5).
     */
    async listFolders(path) {
      const res = await send(`/api/v2/app/getDirectoryContent?${new URLSearchParams({ dirPath: path, mode: 'dirs' })}`);
      if (res.ok) return { exists: true, names: baseNames(await res.json()) };
      const reason = await res.text();
      // An older version answers 404 too, but about the endpoint, not the directory.
      if (res.status === 404 && /directory/i.test(reason)) return { exists: false, names: [] };
      return null;
    },

    /** Every folder a torrent is currently set to save into. */
    async savePaths() {
      const torrents = await info({});
      return [...new Set(torrents.map((torrent) => torrent.save_path).filter(Boolean))];
    },

    async defaultSavePath() {
      const res = await request('/api/v2/app/defaultSavePath');
      return (await res.text()).trim();
    },

    async check() {
      const res = await request('/api/v2/app/version');
      return `qBittorrent ${(await res.text()).trim()}`;
    },
  };
}
