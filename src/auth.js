import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Work factors from the OWASP password storage cheat sheet. They are stored with
// each hash, so raising them later does not invalidate existing passwords.
const SCRYPT = { N: 2 ** 15, r: 8, p: 3 };
const KEY_BYTES = 32;
const COOKIE_NAME = 'pirick_session';
const TOUCH_INTERVAL_MS = 60_000;
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}$/;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function validateUsername(username) {
  return typeof username === 'string' && USERNAME_PATTERN.test(username)
    ? null
    : 'Usernames are 2 to 32 characters: letters, numbers, dot, dash or underscore.';
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Passwords need at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) return `Passwords can be at most ${PASSWORD_MAX} characters.`;
  return null;
}

function derive(password, salt, { N, r, p }, length) {
  return scryptAsync(password.normalize('NFKC'), salt, length, { N, r, p, maxmem: 256 * N * r });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT, KEY_BYTES);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    // Guards against a truncated hash, where an empty key would match anything.
    if (expected.length < 16) return false;
    const params = { N: Number(N), r: Number(r), p: Number(p) };
    const actual = await derive(password, Buffer.from(salt, 'base64'), params, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const split = part.indexOf('=');
    if (split > 0 && part.slice(0, split).trim() === COOKIE_NAME) return part.slice(split + 1).trim();
  }
  return null;
}

/**
 * Fixed-window attempt counter. `hit` takes [key, max] pairs, most general first,
 * and returns the seconds to wait if any is over its limit (0 when allowed).
 */
export function createRateLimiter({ windowMs, maxKeys = 50_000 }) {
  const hits = new Map();

  function prune(now) {
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }

  return {
    hit(limits) {
      const now = Date.now();
      if (hits.size >= maxKeys) prune(now);
      for (const [key, max] of limits) {
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
          // Under a flood of distinct keys, refuse new ones rather than forget old ones.
          if (hits.size >= maxKeys) return 60;
          entry = { count: 0, resetAt: now + windowMs };
          hits.set(key, entry);
        }
        entry.count += 1;
        // Stop at the first exceeded limit so a blocked client cannot grow the map.
        if (entry.count > max) return Math.ceil((entry.resetAt - now) / 1000);
      }
      return 0;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

export function createAuth(db, config) {
  const q = {
    userByName: db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
    users: db.prepare('SELECT id, username, role, created_at FROM users ORDER BY username'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    insertUser: db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ),
    session: db.prepare(`
      SELECT s.token_hash, s.created_at, s.last_seen_at, u.id, u.username, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE created_at < ? OR last_seen_at < ?'),
  };

  let dummyHash;

  function cookie(req, value, maxAgeSeconds) {
    const secure = config.cookieSecure === 'true' || (config.cookieSecure === 'auto' && req.secure);
    return (
      `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
      (secure ? '; Secure' : '')
    );
  }

  return {
    userCount: () => q.countUsers.get().n,
    listUsers: () => q.users.all().map((row) => ({ ...row })),
    findUser: (username) => {
      const row = q.userByName.get(username);
      return row ? { id: row.id, username: row.username, role: row.role } : null;
    },
    findUserById: (id) => {
      const row = q.userById.get(id);
      return row ? { ...row } : null;
    },

    /** Returns the new user, or null when the username is taken. */
    async createUser(username, password, role) {
      if (q.userByName.get(username)) return null;
      const hash = await hashPassword(password);
      const { lastInsertRowid } = q.insertUser.run(username, hash, role, Date.now());
      return { id: Number(lastInsertRowid), username, role };
    },

    deleteUser: (id) => q.deleteUser.run(id).changes > 0,

    /** Changes the password and signs the user out everywhere except `keepSession`. */
    async setPassword(userId, password, keepSession = '') {
      q.setPassword.run(await hashPassword(password), userId);
      q.deleteOtherSessions.run(userId, keepSession);
    },

    async checkCredentials(username, password) {
      const row = q.userByName.get(username);
      // Unknown users still cost one hash, so response time does not reveal who exists.
      dummyHash ??= hashPassword(randomBytes(18).toString('base64'));
      const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash));
      return row && ok ? { id: row.id, username: row.username, role: row.role } : null;
    },

    userFromRequest(req) {
      const token = readSessionCookie(req);
      if (!token) return null;
      const row = q.session.get(hashToken(token));
      if (!row) return null;
      const now = Date.now();
      if (now - row.created_at > config.session.maxMs || now - row.last_seen_at > config.session.idleMs) {
        q.deleteSession.run(row.token_hash);
        return null;
      }
      if (now - row.last_seen_at > TOUCH_INTERVAL_MS) q.touchSession.run(now, row.token_hash);
      return { id: row.id, username: row.username, role: row.role, session: row.token_hash };
    },

    signIn(req, res, userId) {
      const previous = readSessionCookie(req);
      if (previous) q.deleteSession.run(hashToken(previous));
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      // Only a hash is stored, so a leaked database cannot be replayed as cookies.
      q.insertSession.run(hashToken(token), userId, now, now);
      res.append('Set-Cookie', cookie(req, token, Math.floor(config.session.maxMs / 1000)));
    },

    signOut(req, res) {
      const token = readSessionCookie(req);
      if (token) q.deleteSession.run(hashToken(token));
      res.append('Set-Cookie', cookie(req, '', 0));
    },

    purgeExpiredSessions() {
      const now = Date.now();
      q.deleteExpired.run(now - config.session.maxMs, now - config.session.idleMs);
    },
  };
}
