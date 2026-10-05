import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { infoHashOf } from '../src/torrentfile.js';

const info = Buffer.concat([
  Buffer.from('d5:filesld6:lengthi5e4:pathl5:a.mkveed6:lengthi7e4:pathl3:sub5:b.mkveee4:name4:Show12:piece lengthi16384e6:pieces20:'),
  Buffer.alloc(20, 0xab),
  Buffer.from('e'),
]);
const torrent = (before, after = '') => new Uint8Array(Buffer.concat([Buffer.from(before), info, Buffer.from(after)]));

test('the info hash is the SHA-1 of the info dictionary, wherever it sits in the file', () => {
  const expected = createHash('sha1').update(info).digest('hex');
  assert.match(expected, /^[0-9a-f]{40}$/);
  assert.equal(infoHashOf(torrent('d8:announce14:http://t/a.php4:info', 'e')), expected);
  // Other keys before and after, including nested lists and a binary-safe string.
  assert.equal(infoHashOf(torrent('d8:announce3:a:b13:announce-listll1:xel1:yee7:comment2:hi4:info', '8:url-listl1:zee')), expected);
});

test('files that are not readable torrents give null instead of throwing', () => {
  for (const bad of ['', 'not a torrent', 'd4:info', 'd4:infod4:name99:shorte', 'd3:fooi1ee', 'l4:infoe', `d4:info${'l'.repeat(500)}`]) {
    assert.equal(infoHashOf(new Uint8Array(Buffer.from(bad))), null, JSON.stringify(bad.slice(0, 30)));
  }
});
