// Whether an episode has aired, going by the catalogue: what every way of fetching an episode asks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVICES, catalogueStandIn } from '../bench/catalogue.js';
import { WORLD } from '../bench/works.js';
import { notAiredYet } from '../src/airing.js';
import { createCatalogue } from '../src/catalogue.js';

// In the benchmark's world, season 3 of "Tales of the Kestrel" has aired as far as episode 3 of 8,
// and episode 4 is due in a few days.
const services = () => catalogueStandIn(WORLD);
const catalogueOn = (server = services()) => createCatalogue({ enabled: true, ...SERVICES, timeoutMs: 5000 }, { fetch: server.fetch });

test('an episode still to come is named, with when it is due if that is known', async () => {
  const catalogue = catalogueOn();
  const next = await notAiredYet(catalogue, 'Tales.of.the.Kestrel.S03E04.1080p.WEB.H264-GRP');
  assert.deepEqual([next.show, next.label], ['Tales of the Kestrel', 'S03E04']);
  assert.match(next.due, /^ It is due on \d{1,2} \w+ \d{4}\.$/);
  assert.deepEqual(await notAiredYet(catalogue, 'Tales.of.the.Kestrel.S03E05.1080p.WEB.H264-GRP'), { show: 'Tales of the Kestrel', label: 'S03E05', due: '' });
  // What was searched for is read the same way as a release name.
  assert.equal((await notAiredYet(catalogue, 'Tales of the Kestrel S03E06')).label, 'S03E06');
  // A file of two episodes, the second of them still to come, is due when that one is.
  const double = await notAiredYet(catalogue, 'Tales.of.the.Kestrel.S03E03E04.1080p.WEB.H264-GRP');
  assert.equal(double.label, 'S03E03-E04');
  assert.equal(double.due, next.due);
  // The show's year in the name settles which show it is, as it is written.
  assert.equal((await notAiredYet(catalogue, 'Tales.of.the.Kestrel.2022.S03E07.1080p')).label, 'S03E07');
});

test('nothing is said where the guide does not say so for certain', async () => {
  const catalogue = catalogueOn();
  for (const name of [
    // Aired.
    'Tales.of.the.Kestrel.S03E03.1080p.WEB.H264-GRP',
    // A pack of a season part aired: what it holds of the rest is for the planner to judge.
    'Tales.of.the.Kestrel.S03.1080p.WEB.H264-GRP',
    // A season the guide does not have, and a number past the end of a season that has aired all it has: numbered otherwise.
    'Tales.of.the.Kestrel.S04E01.1080p.WEB.H264-GRP',
    'Brindlemoor.S05E07.1080p.WEB.H264-GRP',
    // Another show's year.
    'Tales.of.the.Kestrel.2019.S03E06.1080p',
    // Two shows have this name.
    'Kestrelmere.S01E09.1080p.WEB.H264-GRP',
    // An anime is numbered its own way, and the catalogue gives it no guide.
    'Minato.no.Mirelle.S01E30.1080p',
    // A film, and a show the catalogue does not know.
    'Charade.1963.1080p.BluRay.x264-GRP',
    'Wenderbrook.S01E01.1080p.WEB.H264-GRP',
  ]) {
    assert.equal(await notAiredYet(catalogue, name), null, name);
  }
  assert.equal(await notAiredYet({ enabled: false }, 'Tales.of.the.Kestrel.S03E05.1080p'), null, 'without a catalogue, nothing is known');

  // Out of reach, it says so rather than guess, and whoever asked decides what that means.
  const down = services();
  down.setDown('tvmaze');
  await assert.rejects(notAiredYet(catalogueOn(down), 'Tales.of.the.Kestrel.S03E05.1080p'), { name: 'UpstreamError' });
});
