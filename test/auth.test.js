import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAuth,
  createRateLimiter,
  hashPassword,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

function fakeRequest(cookie) {
  return { headers: cookie ? { cookie } : {}, secure: false };
}

function fakeResponse() {
  return {
    cookies: [],
    append(name, value) {
      this.cookies.push(value);
    },
  };
}

test('password hashes verify only with the right password', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^scrypt\$32768\$8\$3\$/);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('wrong horse', hash), false);
  assert.notEqual(hash, await hashPassword('correct horse'), 'each hash gets its own salt');
});

test('malformed or truncated hashes never verify', async () => {
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', 'plain$text'), false);
  assert.equal(await verifyPassword('anything', 'scrypt$32768$8$3$c2FsdA==$'), false);
});

test('username and password rules', () => {
  assert.equal(validateUsername('alice'), null);
  assert.equal(validateUsername('a.b-c_1'), null);
  assert.ok(validateUsername('a'));
  assert.ok(validateUsername('has space'));
  assert.ok(validateUsername('comma,name'));
  assert.equal(validatePassword('12345678'), null);
  assert.ok(validatePassword('short'));
  assert.ok(validatePassword('x'.repeat(129)));
});

test('rate limiter blocks after the limit and stops at the first exceeded key', () => {
  const limiter = createRateLimiter({ windowMs: 60_000 });
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit([['ip', 3], [`user${i}`, 5]]), 0);
  const wait = limiter.hit([['ip', 3], ['never-counted', 5]]);
  assert.ok(wait > 0 && wait <= 60);
  // The second key was not touched while the first was blocking.
  assert.equal(limiter.hit([['never-counted', 1]]), 0);
  limiter.reset('ip');
  assert.equal(limiter.hit([['ip', 3]]), 0);
});

test('sessions: sign in, look up, sign out, and password change revokes others', async () => {
  const db = openDb(':memory:');
  const auth = createAuth(db, loadConfig({}));
  const user = await auth.createUser('Alice', 'password-one', 'user');
  assert.equal(await auth.createUser('alice', 'password-two', 'user'), null, 'usernames are case-insensitive');

  assert.equal(await auth.checkCredentials('alice', 'password-one').then((u) => u?.id), user.id);
  assert.equal(await auth.checkCredentials('alice', 'nope'), null);
  assert.equal(await auth.checkCredentials('nobody', 'password-one'), null);

  const first = fakeResponse();
  auth.signIn(fakeRequest(), first, user.id);
  assert.match(first.cookies[0], /^pirick_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  const firstCookie = first.cookies[0].split(';')[0];

  const second = fakeResponse();
  auth.signIn(fakeRequest(), second, user.id);
  const secondCookie = second.cookies[0].split(';')[0];

  const current = auth.userFromRequest(fakeRequest(firstCookie));
  assert.equal(current.username, 'Alice');
  assert.equal(auth.userFromRequest(fakeRequest('pirick_session=forged')), null);

  // The raw token is never stored.
  const stored = db.prepare('SELECT token_hash FROM sessions').all().map((row) => row.token_hash);
  assert.ok(stored.every((hash) => !firstCookie.includes(hash)));

  await auth.setPassword(user.id, 'password-three', current.session);
  assert.ok(auth.userFromRequest(fakeRequest(firstCookie)), 'the session that changed the password survives');
  assert.equal(auth.userFromRequest(fakeRequest(secondCookie)), null, 'other sessions are revoked');

  auth.signOut(fakeRequest(firstCookie), fakeResponse());
  assert.equal(auth.userFromRequest(fakeRequest(firstCookie)), null);
});

test('expired sessions are rejected', async () => {
  const db = openDb(':memory:');
  const auth = createAuth(db, loadConfig({ SESSION_IDLE_DAYS: '1', SESSION_MAX_DAYS: '2' }));
  const user = await auth.createUser('bob', 'password-one', 'user');
  const res = fakeResponse();
  auth.signIn(fakeRequest(), res, user.id);
  const cookie = res.cookies[0].split(';')[0];
  assert.ok(auth.userFromRequest(fakeRequest(cookie)));

  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  db.prepare('UPDATE sessions SET last_seen_at = ?').run(twoDaysAgo);
  assert.equal(auth.userFromRequest(fakeRequest(cookie)), null);
});

test('Secure cookie flag follows the request scheme in auto mode', async () => {
  const db = openDb(':memory:');
  const auth = createAuth(db, loadConfig({}));
  const user = await auth.createUser('carol', 'password-one', 'user');
  const res = fakeResponse();
  auth.signIn({ headers: {}, secure: true }, res, user.id);
  assert.match(res.cookies[0], /; Secure$/);
});
