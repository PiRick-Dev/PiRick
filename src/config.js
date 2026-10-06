import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

function text(env, name, fallback = '') {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function integer(env, name, fallback, min, max) {
  const raw = text(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function baseUrl(env, name, fallback) {
  const raw = text(env, name, fallback);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must start with http:// or https://`);
  }
  return raw.replace(/\/+$/, '');
}

function oneOf(env, name, fallback, allowed) {
  const value = text(env, name, fallback).toLowerCase();
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

// Empty leaves thinking to the model. Some models take on or off, others a level.
function think(env) {
  const raw = text(env, 'OLLAMA_THINK').toLowerCase();
  if (!raw) return undefined;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (['low', 'medium', 'high'].includes(raw)) return raw;
  throw new Error(`OLLAMA_THINK must be empty, true, false, low, medium or high (got "${raw}")`);
}

// Empty leaves PiRick without Plex, which is how it ran before it could talk to it.
function plexUrl(env) {
  const raw = text(env, 'PLEX_URL');
  if (!raw) return '';
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    // Reported below.
  }
  const plain = parsed && /^https?:$/.test(parsed.protocol) && !parsed.search && !parsed.hash && !parsed.username && !parsed.password;
  // The value is not repeated here: a token pasted into it must not reach the log.
  if (!plain) {
    throw new Error('PLEX_URL must be only the address of the Plex server, such as http://host.docker.internal:32400. The token goes in PLEX_TOKEN');
  }
  return raw.replace(/\/+$/, '');
}

// Express accepts a boolean, a hop count, or a list of trusted addresses.
function trustProxy(env) {
  const raw = text(env, 'TRUST_PROXY', 'false');
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(text(env, 'DATA_DIR', './data'));
  return {
    port: integer(env, 'PORT', 8080, 1, 65535),
    dbFile: path.join(dataDir, 'pirick.db'),
    trustProxy: trustProxy(env),
    cookieSecure: oneOf(env, 'COOKIE_SECURE', 'auto', ['auto', 'true', 'false']),
    session: {
      idleMs: integer(env, 'SESSION_IDLE_DAYS', 7, 1, 365) * DAY_MS,
      maxMs: integer(env, 'SESSION_MAX_DAYS', 30, 1, 365) * DAY_MS,
    },
    admin: {
      username: text(env, 'ADMIN_USERNAME', 'admin'),
      // Passwords are taken verbatim: leading or trailing spaces may be intentional.
      password: env.ADMIN_PASSWORD ?? '',
    },
    ollama: {
      url: baseUrl(env, 'OLLAMA_URL', 'http://host.docker.internal:11434'),
      model: text(env, 'OLLAMA_MODEL', 'gemma4:e4b'),
      apiKey: text(env, 'OLLAMA_API_KEY'),
      numCtx: integer(env, 'OLLAMA_NUM_CTX', 8192, 2048, 262144),
      think: think(env),
      keepAlive: text(env, 'OLLAMA_KEEP_ALIVE'),
      timeoutMs: integer(env, 'OLLAMA_TIMEOUT_SECONDS', 300, 10, 3600) * 1000,
    },
    jackett: {
      url: baseUrl(env, 'JACKETT_URL', 'http://host.docker.internal:9117'),
      apiKey: text(env, 'JACKETT_API_KEY'),
      indexer: text(env, 'JACKETT_INDEXER', 'all'),
      timeoutMs: integer(env, 'JACKETT_TIMEOUT_SECONDS', 60, 5, 600) * 1000,
      // Indexers behind a Cloudflare solver give thin results when asked several things at once.
      searchesAtOnce: integer(env, 'JACKETT_SEARCHES_AT_ONCE', 1, 1, 5),
      retryCachedEmpty: oneOf(env, 'JACKETT_RETRY_CACHED_EMPTY', 'true', ['true', 'false']) === 'true',
    },
    qbit: {
      url: baseUrl(env, 'QBIT_URL', 'http://host.docker.internal:8080'),
      username: text(env, 'QBIT_USERNAME'),
      password: env.QBIT_PASSWORD ?? '',
      timeoutMs: 30_000,
    },
    plex: {
      url: plexUrl(env),
      token: text(env, 'PLEX_TOKEN'),
      timeoutMs: 15_000,
    },
    searchLimit: integer(env, 'SEARCH_RESULT_LIMIT', 15, 3, 50),
    maxTorrentBytes: integer(env, 'MAX_TORRENT_SIZE_GB', 0, 0, 100000) * 1024 ** 3,
  };
}
