import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseNames,
  checkFolder,
  cleanFolderName,
  findFolder,
  isAbsolutePath,
  joinPath,
  splitPath,
  tidyPath,
  titleFromRelease,
  titleKey,
} from '../src/folders.js';

test('folder names cannot escape the library or upset Windows', () => {
  assert.equal(cleanFolderName('Tears of Steel'), 'Tears of Steel');
  assert.equal(cleanFolderName('../../etc'), 'etc');
  assert.equal(cleanFolderName('..\\..\\Windows'), 'Windows');
  assert.equal(cleanFolderName('..'), '');
  assert.equal(cleanFolderName('.'), '');
  assert.equal(cleanFolderName('   '), '');
  assert.equal(cleanFolderName(undefined), '');
  assert.equal(cleanFolderName('Re:Tide - Starting Over?'), 'Re Tide - Starting Over');
  assert.equal(cleanFolderName('Trailing dots... '), 'Trailing dots');
  assert.equal(cleanFolderName('.wave//SIGN'), 'wave SIGN');
  assert.equal(cleanFolderName('line\nbreak\ttab'), 'line break tab');
  assert.equal(cleanFolderName('x'.repeat(300)).length, 120);
  for (const hostile of ['../x', 'a/b', 'a\\b', 'C:\\x', '/abs', '....//....//x']) {
    assert.doesNotMatch(cleanFolderName(hostile), /[/\\:]|^\.\.?$/, hostile);
  }
});

test('titles are compared without capitals, punctuation, accents, year or id tags', () => {
  assert.equal(titleKey('Tears of Steel (2012) {tvdb-208671}'), 'tears of steel');
  assert.equal(titleKey('TEARS OF STEEL'), 'tears of steel');
  assert.equal(titleKey('Señal'), 'senal');
  assert.equal(titleKey("Mirelle: Beyond the Harbor's End"), 'mirelle beyond the harbors end');
  assert.equal(titleKey('Salt & Iron'), 'salt and iron');
  // A country tag is part of the name, not a year.
  assert.notEqual(titleKey('Kestrelmere (US)'), titleKey('Kestrelmere'));
});

test('a title is derived from a release name when the model gives none', () => {
  assert.equal(titleFromRelease('Tears.of.Steel.S01.1080p.BluRay.x264-GROUP'), 'Tears of Steel');
  assert.equal(titleFromRelease('[Subs] Minato no Mirelle - 01 (1080p) [ABCD1234].mkv'), 'Minato no Mirelle');
  assert.equal(titleFromRelease('Copperhollow.S02E05.720p.WEB.h264'), 'Copperhollow');
  assert.equal(titleFromRelease('Big.Buck.Bunny.2008.2160p.WEB-DL'), 'Big Buck Bunny');
  assert.equal(titleFromRelease('1808.S01.1080p.WEB'), '1808');
  assert.equal(titleFromRelease('The_Wren_Season 2 Complete'), 'The Wren');
});

test('an existing folder is reused whatever the capitals or year', () => {
  const existing = ['Pioneer One (2010)', 'Tales of Ossendale', 'Minato no Mirelle', 'Wrenfield Cross (1963)', 'Wrenfield Cross (2005)'];
  assert.deepEqual(findFolder('pioneer one', existing), { match: 'Pioneer One (2010)' });
  assert.deepEqual(findFolder('TALES OF: OSSENDALE', existing), { match: 'Tales of Ossendale' });
  // Naming an existing folder exactly always wins, even when another shares its key.
  assert.deepEqual(findFolder('wrenfield cross (2005)', existing), { match: 'Wrenfield Cross (2005)' });
});

test('look-alike folders are offered instead of guessing', () => {
  const existing = ['Pioneer One (2010)', 'Tales of Ossendale', 'Minato no Mirelle', 'Wrenfield Cross (1963)', 'Wrenfield Cross (2005)', 'The Ember Prince Chronicles'];
  assert.deepEqual(findFolder("Mirelle: Beyond the Harbor's End", existing), { similar: ['Minato no Mirelle'] });
  assert.deepEqual(findFolder('Tales of the Kestrel', existing), { similar: ['Tales of Ossendale'] });
  assert.deepEqual(findFolder('Wrenfield Cross', existing), { similar: ['Wrenfield Cross (1963)', 'Wrenfield Cross (2005)'] });
  // One shared word out of three is not enough.
  assert.deepEqual(findFolder('Ember Fall Saga', existing), {});
  assert.deepEqual(findFolder('The Wren', existing), {});
  assert.deepEqual(findFolder('Anything', []), {});
});

test('paths keep their own separator style', () => {
  assert.equal(joinPath('/media/TV', 'Sintel'), '/media/TV/Sintel');
  assert.equal(joinPath('/media/TV/', 'Sintel'), '/media/TV/Sintel');
  assert.equal(joinPath('D:\\Media\\TV', 'Sintel'), 'D:\\Media\\TV\\Sintel');
  assert.equal(joinPath('D:\\', 'TV'), 'D:\\TV');
  assert.equal(joinPath('/', 'TV'), '/TV');

  assert.equal(tidyPath('  /media/TV//  '), '/media/TV');
  assert.equal(tidyPath('/'), '/');
  assert.equal(tidyPath('D:\\'), 'D:\\');
  assert.equal(tidyPath('D:\\Media\\'), 'D:\\Media');

  assert.deepEqual(splitPath('/media/TV'), { parent: '/media', name: 'TV' });
  assert.deepEqual(splitPath('/TV'), { parent: '/', name: 'TV' });
  assert.deepEqual(splitPath('D:\\Media\\TV'), { parent: 'D:\\Media', name: 'TV' });
  assert.deepEqual(splitPath('D:\\TV'), { parent: 'D:\\', name: 'TV' });
  assert.deepEqual(baseNames(['/media/TV/Pioneer One (2010)', 'D:/Media/Anime']), ['Pioneer One (2010)', 'Anime']);

  for (const path of ['/media/TV', 'D:\\Media', 'd:/media', '\\\\nas\\share']) assert.equal(isAbsolutePath(path), true, path);
  for (const path of ['media/TV', 'TV', '', './TV']) assert.equal(isAbsolutePath(path), false, path);
});

test('a library folder is checked against what really exists', () => {
  const siblings = ['Anime', 'Movies', 'TV'];
  assert.deepEqual(checkFolder('/media/TV', siblings), { status: 'ok' });
  assert.deepEqual(checkFolder('/media/tv', siblings), { status: 'wrong-case', suggestion: '/media/TV' });
  assert.deepEqual(checkFolder('/media/Shows', siblings), { status: 'missing' });
  assert.deepEqual(checkFolder('/media/TV', null), { status: 'unknown' });
  assert.deepEqual(checkFolder('D:\\Media\\tv', siblings), { status: 'wrong-case', suggestion: 'D:\\Media\\TV' });
});
