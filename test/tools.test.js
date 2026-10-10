import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endedWithoutActing } from '../src/agent.js';
import { hashFromMagnet, normaliseHash } from '../src/jackett.js';
import { formatBytes, toDownload } from '../src/qbittorrent.js';
import { differentReleasesNote, filmMeant, normaliseQuery } from '../src/tools.js';

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
  // A remaster carries its own year as well as the film's: still one film.
  assert.equal(differentReleasesNote('7 chances', ['Seven.Chances.1925.720p.WEB-DL', 'Seven.Chances.2013.REMASTERED.1925.BDRip']), undefined);
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

  // A download that waits on the user's word may be left with them, as an offer or as a plain account.
  const waiting = { searched: true, askFirst: true };
  for (const fine of [
    'It is a 1963 mystery set in Paris. Say the word and I will fetch it.',
    'You have seasons 1 and 5. I found seasons 2, 3 and 4: just let me know and I will get them.',
    'I found seasons 2, 3 and 4, 43 GB in all.',
    'Once you say yes, I will start it.',
  ]) {
    assert.equal(endedWithoutActing(waiting, fine), false, fine);
  }
  // Saying it is about to be done is not leaving it with them: nothing will come of it. Sent back once.
  for (const promise of [
    "I've found the remaining seasons. Since you already have seasons 1 and 5, I'm going to start downloading seasons 2, 3, and 4. They'll show up once they're finished.",
    "I found it. I'll go ahead and download the 1080p copy.",
    'I will start the download now.',
  ]) {
    assert.equal(endedWithoutActing(waiting, promise), true, promise);
    assert.equal(endedWithoutActing(waiting, promise, 1), false, promise);
  }
});

test('a copy is remembered as the film the catalogue named, unless its own name says otherwise', () => {
  const known = { title: 'Brindle', year: 1984, imdb: 'tt0001984' };
  const meant = { kind: 'film', title: 'Brindle', year: 1984, imdb: 'tt0001984' };
  assert.deepEqual(filmMeant(known, 'Brindle.1984.1080p.BluRay.x264-GRP'), meant);
  // A name with no year in it is the very thing Plex has to guess at.
  assert.deepEqual(filmMeant(known, 'Brindle.1080p.BluRay.x264-GRP'), meant);
  assert.deepEqual(filmMeant(known, 'Brindle.1985.1080p.BluRay.x264-GRP'), meant, 'sources differ by a year');
  // The remake, or an episode of a show of the name: not the film that was named.
  assert.equal(filmMeant(known, 'Brindle.2021.1080p.WEB-DL.x264-GRP'), null);
  assert.equal(filmMeant(known, 'Brindle.S01E02.1080p.WEB.H264-GRP'), null);
  assert.equal(filmMeant(known, 'Brindle.S01.1080p.WEB.H264-GRP'), null);
  // Nothing named a film, or the catalogue has no number for it: there is nothing to hold Plex to.
  assert.equal(filmMeant(undefined, 'Brindle.1984.1080p.BluRay.x264-GRP'), null);
  assert.equal(filmMeant({ title: 'Brindle', year: 1984, imdb: null }, 'Brindle.1984.1080p.BluRay.x264-GRP'), null);
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
