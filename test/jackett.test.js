// The Jackett client against stand-in servers: what it will and will not take from an indexer.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { after, test } from 'node:test';
import { createJackett } from '../src/jackett.js';

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Big.Buck.Bunny';
const TORRENT_BYTES = Buffer.from('d4:infod4:name4:testee');
const MEGABYTE = 1024 * 1024;

const servers = [];

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const client = (url = 'http://jackett.invalid') => createJackett({ url, apiKey: 'key', indexer: 'all', timeoutMs: 5000 });

after(() => {
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
});

test('a download link is followed within its own site or to a magnet, and nowhere else', async () => {
  // Some other service on the network, which a download link has no business reaching.
  const reached = [];
  const elsewhere = await listen((req, res) => {
    reached.push(req.url);
    res.end('not a torrent');
  });
  const site = await listen((req, res) => {
    if (req.url === '/dl/file') return res.writeHead(302, { Location: '/files/bunny.torrent' }).end();
    if (req.url === '/files/bunny.torrent') return res.end(TORRENT_BYTES);
    if (req.url === '/dl/magnet') return res.writeHead(302, { Location: MAGNET }).end();
    res.writeHead(302, { Location: `${elsewhere}/admin/restart` }).end();
  });
  const jackett = client();

  assert.deepEqual((await jackett.resolve({ link: `${site}/dl/file` })).file, TORRENT_BYTES);
  assert.deepEqual(await jackett.resolve({ link: `${site}/dl/magnet` }), { magnet: MAGNET });
  await assert.rejects(jackett.resolve({ link: `${site}/dl/away` }), /Could not follow the download link/);
  assert.deepEqual(reached, [], 'the other service was never asked');
});

test('a torrent file that is too large is abandoned part-way', async () => {
  // Far more than the 10 MB a torrent file may be, and no length given up front.
  const offered = 40 * MEGABYTE;
  let sent = 0;
  const site = await listen((req, res) => {
    const chunk = Buffer.alloc(MEGABYTE, 0x64);
    const pump = () => {
      while (sent < offered && !res.destroyed) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });

  await assert.rejects(client().resolve({ link: `${site}/dl/huge` }), /unexpectedly large/);
  assert.ok(sent < offered, `stopped after ${sent / MEGABYTE} MB of ${offered / MEGABYTE}`);
});

test('a magnet that runs over more than one line is not passed on', async () => {
  const hash = (digit) => digit.repeat(40);
  const url = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        Results: [
          // A second address hidden after a line break, and no other way to fetch it: dropped.
          { Title: 'Two.Lines.2020.1080p', Seeders: 9, MagnetUri: `magnet:?xt=urn:btih:${hash('a')}\nhttp://10.0.0.1/other.torrent` },
          // The same trick, but with a link as well: the link is used and the magnet is not.
          { Title: 'Has.A.Link.2020.1080p', Seeders: 8, MagnetUri: `magnet:?xt=urn:btih:${hash('b')}\r\nhttp://10.0.0.1/other.torrent`, Link: 'http://jackett.invalid/dl/x' },
          // Spaces in the name are untidy but harmless.
          { Title: 'Plain.2020.1080p', Seeders: 7, MagnetUri: `magnet:?xt=urn:btih:${hash('c')}&dn=Plain 2020 1080p` },
        ],
      }),
    );
  });

  const results = await client(url).search('anything');
  assert.deepEqual(
    results.map((result) => [result.title, result.magnet, result.link]),
    [
      ['Has.A.Link.2020.1080p', null, 'http://jackett.invalid/dl/x'],
      ['Plain.2020.1080p', `magnet:?xt=urn:btih:${hash('c')}&dn=Plain 2020 1080p`, null],
    ],
  );
});
