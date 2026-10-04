import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { createSettings, parseLibrary } from '../src/settings.js';

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

test('personality is empty until set and can be replaced', () => {
  const settings = createSettings(openDb(':memory:'));
  assert.equal(settings.personality(), '');
  settings.setPersonality('Talk like a pirate.');
  settings.setPersonality('Talk like a butler.');
  assert.equal(settings.personality(), 'Talk like a butler.');
});
