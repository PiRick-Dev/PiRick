// How the Downloads panel is laid out: which downloads make one row, and which section a row is in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupDownloads } from '../src/downloads.js';

const GB = 1024 ** 3;
const LIBRARIES = [
  { id: 1, savePath: '/media/Movies', perTitle: false },
  { id: 2, savePath: '/media/TV', perTitle: true },
  { id: 3, savePath: '/media/Anime', perTitle: true },
  { id: 4, savePath: '/media/Loose TV', perTitle: false },
];

/** A download as the list of them has it. Downloading, halfway, 1 GB, unless told otherwise. */
const download = (name, extra = {}) => {
  const gb = extra.gb ?? 1;
  const { gb: unused, ...rest } = extra;
  return { name, status: 'downloading', progress: 50, size: `${gb} GB`, bytes: gb * GB, etaSeconds: null, addedAt: 1000, finishedAt: 0, savePath: '/media/Movies', ...rest };
};
const finished = (name, extra = {}) => download(name, { status: 'finished', progress: 100, finishedAt: 2000, ...extra });
const inFolder = (folder, library = '/media/TV') => ({ savePath: `${library}/${folder}` });
const rows = (items, libraries = LIBRARIES) => groupDownloads(items, libraries).groups;

test('everything of one show is one row, named for the folder it is kept in', () => {
  const [show, ...others] = rows([
    // Each release names the show its own way. The folder is what they have in common.
    download('Kestrelmere.US.S02E03.1080p.WEB.H264-GRP', inFolder('Kestrelmere (2005)')),
    finished('Kestrelmere.2005.S01.1080p.BluRay.x264-GRP', { ...inFolder('Kestrelmere (2005)'), gb: 8 }),
    download('Kestrelmere.S02E01.1080p.WEB.H264-GRP', inFolder('Kestrelmere (2005)')),
    finished('Kestrelmere.US.The.Complete.Series.S01-S09.1080p.BluRay.x265-GRP', inFolder('Kestrelmere (2005)')),
  ]);
  assert.deepEqual(others, []);
  assert.deepEqual([show.title, show.detail, show.count], ['Kestrelmere (2005)', '4 downloads', 4]);
  // Its parts are in the order they are watched, each under what it holds and the name its maker gave it.
  assert.deepEqual(show.items.map((item) => item.label), ['seasons 1-9', 'season 1', 'S02E01', 'S02E03']);
  assert.equal(show.items[2].name, 'Kestrelmere.S02E01.1080p.WEB.H264-GRP');

  // The namesake in the folder beside it is another row, and so is a folder of the same name in another library.
  const three = rows([
    download('Kestrelmere.S01E01.1080p.WEB.H264-GRP', inFolder('Kestrelmere (2005)')),
    download('Kestrelmere.S01E01.720p.DVDRip.x264-GRP', inFolder('Kestrelmere (1963)')),
    download('Kestrelmere.S01E02.1080p.WEB.H264-GRP', inFolder('Kestrelmere (2005)', '/media/Anime')),
  ]);
  assert.deepEqual(three.map((row) => [row.title, row.count]), [['Kestrelmere (2005)', 1], ['Kestrelmere (1963)', 1], ['Kestrelmere (2005)', 1]]);
  assert.equal(new Set(three.map((row) => row.key)).size, 3);
  // One download says which part of the show it is in place of how many there are.
  assert.equal(three[0].detail, 'S01E01');
});

test('a film is a row under its name and year, and what cannot be read stands as it is', () => {
  const listed = rows([
    download('Charade.1963.1080p.BluRay.x264-GRP'),
    download('Artist - Album [FLAC]', { savePath: '/media/Music' }),
    // Two copies of one film are one film.
    download('Sintel.2010.1080p.WEB.x264'),
    download('Sintel.2010.2160p.WEB.x265-GRP'),
    // Where shows have no folders of their own, the name in the release is what there is to go by.
    download('Wrenfield.Cross.S03E02.1080p.WEB.H264-GRP', { savePath: '/media/Loose TV' }),
    download('Wrenfield Cross S03E01 720p HDTV', { savePath: '/media/Loose TV' }),
    // Saved somewhere that is no library at all.
    download('Brindlemoor.S01.1080p.WEB-DL-GRP', { savePath: '/downloads' }),
  ]);
  assert.deepEqual(
    listed.map((row) => [row.title, row.detail]),
    [['Charade (1963)', ''], ['Artist - Album [FLAC]', ''], ['Sintel (2010)', '2 downloads'], ['Wrenfield Cross', '2 downloads'], ['Brindlemoor', 'season 1']],
  );
  assert.deepEqual(listed[3].items.map((item) => item.label), ['S03E01', 'S03E02']);
  // A film in a folder of its own, as an anime library keeps them, goes by the folder too.
  assert.deepEqual(rows([download('Minato.no.Mirelle.The.Movie.2019.1080p.BluRay-GRP', inFolder('Minato no Mirelle', '/media/Anime'))])[0].title, 'Minato no Mirelle');
  // With no libraries to go by, as before any is set up, names are all there is.
  assert.deepEqual(rows([download('Kestrelmere.S01E01.1080p', inFolder('Kestrelmere (2005)'))], []).map((row) => row.title), ['Kestrelmere']);
});

test('rows are in three sections: what needs a look, what is on the way, what has finished', () => {
  const { summary, groups } = groupDownloads(
    [
      finished('Sintel.2010.1080p.WEB.x264', { finishedAt: 5000 }),
      download('Charade.1963.1080p.BluRay.x264-GRP', { status: 'queued', progress: 0, addedAt: 3000 }),
      // One episode in trouble puts the show where it will be seen, and the rest of it is still counted.
      finished('Wrenfield.Cross.S03E01.1080p.WEB.H264-GRP', inFolder('Wrenfield Cross')),
      download('Wrenfield.Cross.S03E02.1080p.WEB.H264-GRP', { ...inFolder('Wrenfield Cross'), status: 'stuck', progress: 7 }),
      download('Wrenfield.Cross.S03E03.1080p.WEB.H264-GRP', inFolder('Wrenfield Cross')),
      download('Big.Buck.Bunny.2008.1080p.WEB.x264', { addedAt: 9000 }),
      download('Artist - Album [FLAC]', { status: 'error', savePath: '/media/Music', addedAt: 500 }),
      finished('Tears.of.Steel.2012.1080p.WEB-DL', { finishedAt: 7000 }),
      // qBittorrent kept no time for this one finishing: when it was added serves.
      finished('Elephants.Dream.2006.1080p.BluRay', { finishedAt: 0, addedAt: 6000 }),
    ],
    LIBRARIES,
  );
  assert.deepEqual(summary, { attention: 2, active: 2, finished: 3 });
  assert.deepEqual(
    groups.map((row) => [row.section, row.title, row.status]),
    [
      // What has gone wrong before what is only stuck, and what is moving before what is waiting.
      ['attention', 'Artist - Album [FLAC]', 'error'],
      ['attention', 'Wrenfield Cross', 'stuck'],
      ['active', 'Big Buck Bunny (2008)', 'downloading'],
      ['active', 'Charade (1963)', 'queued'],
      // And the last to finish first among what is done.
      ['finished', 'Tears of Steel (2012)', 'finished'],
      ['finished', 'Elephants Dream (2006)', 'finished'],
      ['finished', 'Sintel (2010)', 'finished'],
    ],
  );
  const show = groups[1];
  assert.deepEqual([show.count, show.finished, show.troubled], [3, 1, 1]);
  assert.deepEqual(show.items.map((item) => item.status), ['finished', 'stuck', 'downloading']);

  // Among rows that are doing the same, the newest comes first.
  assert.deepEqual(
    rows([download('Sintel.2010.1080p.WEB.x264', { addedAt: 1 }), download('Charade.1963.1080p.BluRay.x264-GRP', { addedAt: 3 }), download('Metropolis.1927.1080p.BluRay.x264-GRP', { addedAt: 2 })]).map((row) => row.title),
    ['Charade (1963)', 'Metropolis (1927)', 'Sintel (2010)'],
  );
  assert.deepEqual(groupDownloads([], LIBRARIES), { summary: { attention: 0, active: 0, finished: 0 }, groups: [] });
});

test('a row is as far along as its downloads are by size, and done only when all of them are', () => {
  const season = (extra) => download('Brindlemoor.S01.1080p.WEB-DL-GRP', { ...inFolder('Brindlemoor'), gb: 9, ...extra });
  const episode = (extra) => download('Brindlemoor.S02E01.1080p.WEB.H264-GRP', { ...inFolder('Brindlemoor'), ...extra });

  // Nine parts in ten are at 20%, the tenth at 100%.
  const [mixed] = rows([season({ progress: 20, etaSeconds: 900 }), episode({ status: 'finished', progress: 100, inPlex: true })]);
  assert.deepEqual([mixed.progress, mixed.size, mixed.section, mixed.etaSeconds], [28, '10.0 GB', 'active', 900]);
  assert.equal('inPlex' in mixed, false, 'not ready in Plex while some of it is still to come');
  assert.deepEqual(mixed.items.map((item) => item.inPlex), [undefined, true]);

  // All but a sliver there is not all of it there.
  assert.equal(rows([season({ progress: 99.9 }), episode({ progress: 99.99 })])[0].progress, 99.9);
  // When the last of it will arrive is known only if every part of it is on its way.
  assert.equal(rows([season({ etaSeconds: 900 }), episode({ etaSeconds: 60 })])[0].etaSeconds, 900);
  assert.equal(rows([season({ etaSeconds: 900 }), episode({ status: 'queued', progress: 0 })])[0].etaSeconds, null);

  const [done] = rows([season({ status: 'finished', progress: 100, inPlex: true }), episode({ status: 'finished', progress: 100, inPlex: true })]);
  assert.deepEqual([done.progress, done.section, done.status, done.inPlex, done.etaSeconds], [100, 'finished', 'finished', true, null]);
  // Finished, but Plex has not been asked about all of it.
  assert.equal('inPlex' in rows([season({ status: 'finished', progress: 100, inPlex: true }), episode({ status: 'finished', progress: 100 })])[0], false);

  // A size qBittorrent does not know yet counts each download alike.
  assert.equal(rows([season({ bytes: 0, progress: 20 }), episode({ bytes: 0, progress: 60 })])[0].progress, 40);
});

test('who asked is said only where it was given, and nothing of where things are kept goes out', () => {
  const [mine] = rows([download('Brindlemoor.S01E01.1080p.WEB.H264-GRP', inFolder('Brindlemoor'))]);
  assert.equal('requestedBy' in mine, false);
  assert.equal(JSON.stringify(mine).includes('/media'), false);
  assert.deepEqual(Object.keys(mine.items[0]), ['name', 'label', 'status', 'progress', 'size', 'etaSeconds']);

  const [everyones] = rows([
    download('Brindlemoor.S01E01.1080p.WEB.H264-GRP', { ...inFolder('Brindlemoor'), requestedBy: ['alice'] }),
    download('Brindlemoor.S01E02.1080p.WEB.H264-GRP', { ...inFolder('Brindlemoor'), requestedBy: ['bob', 'alice'] }),
  ]);
  assert.deepEqual(everyones.requestedBy, ['alice', 'bob']);
});
