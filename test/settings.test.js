import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { STARTER_PERSONALITIES, createSettings, parseLibrary, parsePersonality } from '../src/settings.js';

const valid = { name: 'TV', description: 'Live-action series', savePath: '/media/TV', perTitle: true, category: '' };

test('library input is validated and the folder keeps its exact spelling', () => {
  assert.deepEqual(parseLibrary({ ...valid, savePath: '  /media/TV/  ' }).library, valid);
  assert.equal(parseLibrary({ ...valid, savePath: 'D:\\Media\\TV Shows\\' }).library.savePath, 'D:\\Media\\TV Shows');
  assert.equal(parseLibrary({ ...valid, name: '  Kids   TV ' }).library.name, 'Kids TV');
  assert.equal(parseLibrary({ name: 'Movies', savePath: '/m' }).library.perTitle, false);
  // "true" as a string, or anything else, does not switch subfolders on.
  assert.equal(parseLibrary({ ...valid, perTitle: 'true' }).library.perTitle, false);

  for (const bad of [
    { ...valid, name: '' },
    { ...valid, name: 'x'.repeat(41) },
    { ...valid, name: 'TV"; drop' },
    { ...valid, name: 'a\nb\u0000' },
    { ...valid, savePath: '' },
    { ...valid, savePath: 'media/TV' },
    { ...valid, savePath: 'TV' },
    { ...valid, savePath: '/media/T\nV' },
    { ...valid, savePath: `/${'x'.repeat(600)}` },
    { ...valid, description: 'x'.repeat(201) },
    { ...valid, category: 'a,b' },
    { ...valid, savePath: 42 },
    null,
  ]) {
    assert.ok(parseLibrary(bad).error, JSON.stringify(bad));
  }
});

test('libraries are stored, renamed and removed; names are unique whatever the capitals', () => {
  const settings = createSettings(openDb(':memory:'));
  assert.deepEqual(settings.libraries(), []);

  const tv = settings.addLibrary(valid);
  assert.deepEqual(tv, { id: tv.id, ...valid });
  const anime = settings.addLibrary({ ...valid, name: 'Anime', savePath: '/media/Anime' });
  assert.equal(settings.addLibrary({ ...valid, name: 'tv', savePath: '/media/tv' }), null);
  assert.deepEqual(settings.libraries().map((library) => library.name), ['Anime', 'TV']);

  assert.equal(settings.findLibrary(' anime ').id, anime.id);
  assert.equal(settings.findLibrary('Books'), null);
  assert.equal(settings.library(999), null);

  assert.equal(settings.updateLibrary(anime.id, { ...valid, name: 'TV' }), null, 'cannot take another library’s name');
  const renamed = settings.updateLibrary(tv.id, { ...valid, name: 'tv shows', perTitle: false, category: 'shows' });
  assert.deepEqual(renamed, { id: tv.id, name: 'tv shows', description: valid.description, savePath: '/media/TV', perTitle: false, category: 'shows' });
  // Changing only the capitals of a library's own name is allowed.
  assert.equal(settings.updateLibrary(tv.id, { ...valid, name: 'TV Shows' }).name, 'TV Shows');

  assert.equal(settings.removeLibrary(anime.id), true);
  assert.equal(settings.removeLibrary(anime.id), false);
  assert.deepEqual(settings.libraries().map((library) => library.name), ['TV Shows']);
});

/** A database with some people in it, who can then have choices of their own. */
function withPeople(...usernames) {
  const db = openDb(':memory:');
  const add = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, 'none', 'user', 0)");
  const ids = usernames.map((username) => Number(add.run(username).lastInsertRowid));
  return { db, ids };
}

test('the list of personalities starts with the starters and is an admin’s to change', () => {
  const { db, ids: [alice] } = withPeople('alice');
  const settings = createSettings(db);
  const names = () => settings.personalities().map((entry) => entry.name);
  assert.deepEqual(names(), ['Grumpy video-store clerk', 'Over-excited film buff', 'Pirate captain', 'Posh butler']);
  assert.deepEqual(settings.personalities().map((entry) => entry.text).sort(), STARTER_PERSONALITIES.map((entry) => entry.text).sort());
  // Nobody hears a personality until one is made the usual one, or they choose.
  assert.equal(settings.usualPersonality(), null);
  assert.equal(settings.personalityFor(alice), '');

  const seaDog = settings.addPersonality({ name: 'Sea dog', text: 'Talk like an old sailor.' });
  assert.deepEqual(seaDog, { id: 5, name: 'Sea dog', text: 'Talk like an old sailor.' });
  assert.equal(settings.addPersonality({ name: 'sea DOG', text: 'Again.' }), null, 'names are unique whatever the capitals');
  assert.equal(settings.updatePersonality(seaDog.id, { name: 'Pirate captain', text: 'x' }), null, 'cannot take another entry’s name');
  assert.equal(settings.updatePersonality(seaDog.id, { name: 'Sea Dog', text: 'Talk like a very old sailor.' }).name, 'Sea Dog');

  settings.setUsualPersonality(seaDog.id);
  assert.equal(settings.usualPersonality().name, 'Sea Dog');
  assert.equal(settings.personalityFor(alice), 'Talk like a very old sailor.');

  // Removing the usual one leaves none. Its number is never given to a later entry.
  assert.equal(settings.removePersonality(seaDog.id), true);
  assert.equal(settings.removePersonality(seaDog.id), false);
  assert.equal(settings.usualPersonality(), null);
  assert.equal(settings.addPersonality({ name: 'Newcomer', text: 'Be brief.' }).id, 6);
  assert.equal(settings.personalityFor(alice), '');

  // A starter that has been removed does not come back the next time PiRick starts.
  settings.removePersonality(settings.personalities().find((entry) => entry.name === 'Posh butler').id);
  assert.deepEqual(createSettings(db).personalities().map((entry) => entry.name), ['Grumpy video-store clerk', 'Newcomer', 'Over-excited film buff', 'Pirate captain']);
});

test('what an admin enters for a personality is checked', () => {
  assert.deepEqual(parsePersonality({ name: '  Sea   dog ', text: '  Talk like a sailor.\nBe brief.  ' }).personality, { name: 'Sea dog', text: 'Talk like a sailor.\nBe brief.' });
  for (const bad of [{ name: '', text: 'x' }, { name: 'x'.repeat(41), text: 'x' }, { name: 'Sea "dog"', text: 'x' }, { name: 'Fine', text: '   ' }, { name: 'Fine', text: 'x'.repeat(1001) }, { name: 'Fine', text: 42 }, null]) {
    assert.ok(parsePersonality(bad).error, JSON.stringify(bad));
  }
});

test('the one personality an earlier version kept becomes an entry, and the usual one', () => {
  const earlier = (text) => {
    const { db, ids: [alice] } = withPeople('alice');
    db.prepare("INSERT INTO settings (key, value) VALUES ('personality', ?)").run(text);
    return { db, alice, settings: createSettings(db) };
  };

  // Written by the admin: it is kept under a name of its own, so nobody hears a change.
  const custom = earlier('  Talk like a ship’s cat.  ');
  assert.deepEqual(custom.settings.usualPersonality(), { id: 5, name: 'House voice', text: 'Talk like a ship’s cat.' });
  assert.equal(custom.settings.personalities().length, 5);
  assert.equal(custom.settings.personalityFor(custom.alice), 'Talk like a ship’s cat.');
  // Starting again changes nothing, even after the admin has chosen otherwise.
  custom.settings.setUsualPersonality(null);
  const again = createSettings(custom.db);
  assert.equal(again.personalities().length, 5);
  assert.equal(again.usualPersonality(), null);

  // One of the starters, unchanged: that starter is the usual one, with no second copy.
  const starter = earlier(STARTER_PERSONALITIES[1].text);
  assert.equal(starter.settings.usualPersonality().name, 'Posh butler');
  assert.equal(starter.settings.personalities().length, 4);

  // None was set: the starters, and nobody hears one.
  assert.equal(earlier('   ').settings.usualPersonality(), null);
});

test('each person has a theme and a personality of their own', () => {
  const { db, ids: [alice, bob] } = withPeople('alice', 'bob');
  const settings = createSettings(db);
  const [clerk] = settings.personalities();
  assert.deepEqual(settings.preferences(alice), { theme: 'sea', mode: 'auto', personality: '' });

  // Only what is on offer is accepted, and only what was sent is changed.
  assert.deepEqual(settings.checkPreferences({ theme: 'plain' }), { changes: { theme: 'plain' } });
  assert.deepEqual(settings.checkPreferences({ mode: 'dark', personality: String(clerk.id), extra: 1 }), { changes: { mode: 'dark', personality: String(clerk.id) } });
  assert.deepEqual(settings.checkPreferences({}), { changes: {} });
  for (const bad of [{ theme: 'neon' }, { theme: 7 }, { mode: 'dusk' }, { personality: '999' }, { personality: clerk.id }, { personality: 'none; drop' }, { personality: null }]) {
    assert.ok(settings.checkPreferences(bad).error, JSON.stringify(bad));
  }

  settings.setPreferences(alice, { theme: 'plain' });
  settings.setPreferences(alice, { mode: 'dark', personality: String(clerk.id) });
  assert.deepEqual(settings.preferences(alice), { theme: 'plain', mode: 'dark', personality: String(clerk.id) });
  assert.deepEqual(settings.preferences(bob), { theme: 'sea', mode: 'auto', personality: '' }, 'one person’s choices are theirs alone');
  assert.equal(settings.personalityFor(alice), clerk.text);

  // With a usual personality set, each person hears their own choice, the usual one, or none.
  const [, buff] = settings.personalities();
  settings.setUsualPersonality(buff.id);
  settings.setPreferences(bob, { personality: 'none' });
  assert.equal(settings.personalityFor(alice), clerk.text);
  assert.equal(settings.personalityFor(bob), '');
  settings.setPreferences(bob, { personality: '' });
  assert.equal(settings.personalityFor(bob), buff.text);

  // An entry that is removed puts whoever chose it back on the usual one.
  settings.removePersonality(clerk.id);
  assert.equal(settings.preferences(alice).personality, '');
  assert.equal(settings.personalityFor(alice), buff.text);

  // A theme that a later version no longer has reads as the usual one.
  db.prepare("UPDATE preferences SET theme = 'retired', mode = 'dusk' WHERE user_id = ?").run(alice);
  assert.deepEqual(settings.preferences(alice), { theme: 'sea', mode: 'auto', personality: '' });

  // Choices go when the account goes.
  db.prepare('DELETE FROM users WHERE id = ?').run(alice);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM preferences').get().n, 1);
});
