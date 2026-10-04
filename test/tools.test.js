import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endedWithoutActing } from '../src/agent.js';
import { hashFromMagnet, normaliseHash } from '../src/jackett.js';
import { formatBytes, toDownload } from '../src/qbittorrent.js';
import { differentReleasesNote, normaliseQuery } from '../src/tools.js';

test('season and episode wording is rewritten the way indexers name things', () => {
  assert.equal(normaliseQuery('Copperhollow season 2'), 'Copperhollow S02');
  assert.equal(normaliseQuery('Copperhollow Season 2 Episode 5 1080p'), 'Copperhollow S02E05 1080p');
  assert.equal(normaliseQuery('  Sintel   Part Two  '), 'Sintel Part Two');
  assert.equal(normaliseQuery('Changing Seasons 1970'), 'Changing Seasons 1970');
  assert.equal(normaliseQuery(undefined), '');
});

test('results spanning several years get a hint to ask, unless the query was specific', () => {
  const titles = ['Dr.Jekyll.and.Mr.Hyde.1912.720p.WEB', 'Dr.Jekyll.and.Mr.Hyde.1913.720p.WEB', 'Dr.Jekyll.and.Mr.Hyde.1920.1080p.BluRay'];
  assert.match(differentReleasesNote('Dr Jekyll and Mr Hyde', titles), /1912, 1913, 1920/);
  assert.equal(differentReleasesNote('Dr Jekyll and Mr Hyde 1920', titles), undefined);
  assert.equal(differentReleasesNote('Show S02', ['Show.S02.2019.1080p', 'Show.S02.2020.720p']), undefined);
  // Resolutions such as 2160p are not years.
  assert.equal(differentReleasesNote('Bunny', ['Bunny.2008.1080p', 'Bunny.2008.2160p']), undefined);
});

test('replies that claim a download which never happened are caught', () => {
  const idle = {};
  for (const claim of [
    "I've started downloading Sintel (2010) in 1080p.",
    'I started the download for you.',
    'Great news, your movie is now downloading.',
    'The download has started and will show up in Plex.',
  ]) {
    assert.equal(endedWithoutActing(idle, claim), true, claim);
  }
  for (const fine of [
    "You're welcome! Enjoy it once it's downloaded.",
    'I can only help you find and download movies and shows.',
    'Which one would you like? I can start downloading it right away.',
  ]) {
    assert.equal(endedWithoutActing(idle, fine), false, fine);
  }
  // A real download or a progress check makes any wording acceptable.
  assert.equal(endedWithoutActing({ succeeded: true }, "I've started downloading it."), false);
  // A failed attempt may be reported, but not announced as a success.
  assert.equal(endedWithoutActing({ searched: true, failed: true }, "Sorry, that could not be started."), false);
  assert.equal(endedWithoutActing({ searched: true, failed: true }, "I've started downloading it."), true);
  assert.equal(endedWithoutActing({ listed: true }, 'Sintel is downloading, 40% done.'), false);
  // After a search, stopping without a download or a question is nudged once, in any language.
  assert.equal(endedWithoutActing({ searched: true }, 'Lo he puesto a descargar.'), true);
  assert.equal(endedWithoutActing({ searched: true }, 'Lo he puesto a descargar.', 1), false);
  assert.equal(endedWithoutActing({ searched: true }, "I couldn't find it anywhere, sorry.", 1), false);
  // A list of options is a question even without a question mark.
  assert.equal(endedWithoutActing({ searched: true }, 'Are you looking for:\n\n1. Dr. Jekyll and Mr. Hyde (1920)\n2. Dr. Jekyll and Mr. Hyde (1913)'), false);
});

test('info hashes are read from hex and base32 magnets', () => {
  const hex = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(hashFromMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=x`), hex);
  assert.equal(hashFromMagnet('magnet:?dn=x&xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH'), hex);
  assert.equal(hashFromMagnet('magnet:?dn=no-hash'), null);
  assert.equal(normaliseHash('not-a-hash'), null);
});

test('torrents are summarised in plain terms', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(0), 'unknown size');
  assert.equal(toDownload({ name: 'a', progress: 0.9996, state: 'downloading', eta: 5 }).progress, 99.9);
  assert.equal(toDownload({ name: 'a', progress: 1, state: 'pausedUP' }).status, 'finished');
  assert.equal(toDownload({ name: 'a', progress: 0.2, state: 'stalledDL', eta: 8640000 }).etaSeconds, null);
  assert.deepEqual(toDownload({ name: 'a', progress: 0, state: 'metaDL', tags: 'x, pirick, pirick-sam' }).requestedBy, ['sam']);
});
