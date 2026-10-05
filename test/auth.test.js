import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  createAuth,
  createRateLimiter,
  hashPassword,
  validatePassword,
  validateUsername,
  verifyPassword,
} from '../src/auth.js';
import { build } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

function fakeRequest(cookie) {
  return { headers: cookie ? { cookie } : {}, secure: false };
}

/**
 * A running PiRick with one account, "dana". `signIn(password, address)` resolves
 * to the status of a sign-in that claims to come from `address`.
 */
async function withApp(env, run) {
  const config = loadConfig(env);
  config.dbFile = ':memory:';
  const { app, auth } = build(config);
  await auth.createUser('dana', 'password-one', 'user');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const signIn = async (password, address, username = 'dana') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PiRick': '1', 'X-Forwarded-For': address },
      body: JSON.stringify({ username, password }),
    });
    return res.status;
  };
  try {
    await run(signIn);
  } finally {
    server.close();
    server.closeAllConnections();
  }
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

test('one address cannot lock a person out for everyone else', async () => {
  await withApp({ TRUST_PROXY: '1' }, async (signIn) => {
    const statuses = [];
    for (let i = 0; i < 25; i++) statuses.push(await signIn('wrong-password', '203.0.113.5'));
    assert.deepEqual(statuses.slice(0, 5), Array(5).fill(401));
    assert.deepEqual(statuses.slice(5), Array(20).fill(429), 'that address is blocked for this username');
    // Its blocked guesses did not count against the username, so the real person still gets in.
    assert.equal(await signIn('password-one', '192.0.2.77'), 200);
  });
});

test('a claimed address is only believed when the trusted proxy passes it on', async () => {
  // An over-long password is refused without being hashed, which keeps this quick.
  const wrong = 'x'.repeat(200);
  // The proxy is somewhere else, so what this visitor claims is ignored and
  // every guess counts against the one address it really comes from.
  await withApp({ TRUST_PROXY: '10.9.8.7' }, async (signIn) => {
    for (let i = 0; i < 30; i++) assert.equal(await signIn(wrong, `203.0.113.${i}`, `user${i}`), 401);
    assert.equal(await signIn(wrong, '203.0.113.99', 'someone-else'), 429);
  });
  // Here the visitor is the proxy, so the address it passes on is the one used.
  await withApp({ TRUST_PROXY: '127.0.0.1' }, async (signIn) => {
    for (let i = 0; i < 31; i++) assert.equal(await signIn(wrong, `203.0.113.${i}`, `user${i}`), 401);
  });
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
