// The compose files people are told to run: what each service can reach, and what is kept from it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');

/** The lines of one service, under its name at the top of `services:`. */
function service(text, name) {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `there is a service called ${name}`);
  const end = lines.findIndex((line, i) => i > start && /^ {0,2}\S/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}
const published = (lines) => /^ {4}ports:/m.test(lines);

test('everything at once: PiRick is locked down as it is on its own', () => {
  const full = read('docker-compose.full.yml');
  const alone = read('docker-compose.yml');
  for (const line of ['image: ghcr.io/pirick-dev/pirick:latest', 'read_only: true', '- ALL', '- no-new-privileges:true', 'env_file: .env']) {
    assert.ok(service(alone, 'pirick').includes(line), `on its own: ${line}`);
    assert.ok(service(full, 'pirick').includes(line), `with everything: ${line}`);
  }
  // Nothing is built: the machine it runs on need not have the source.
  assert.doesNotMatch(full, /^\s*build:/m);
  // It reaches the others by their names on the stack's own network.
  const pirick = service(full, 'pirick');
  for (const address of ['OLLAMA_URL: http://ollama:11434', 'JACKETT_URL: http://jackett:9117', 'QBIT_URL: http://vpn:8080']) assert.ok(pirick.includes(address), address);
});

test('everything at once: qBittorrent has no way out but the VPN, and what has no login is not published', () => {
  const full = read('docker-compose.full.yml');
  const qbit = service(full, 'qbittorrent');
  assert.match(qbit, /network_mode: "service:vpn"/);
  assert.equal(published(qbit), false, 'its page is published by the VPN, in whose network it lives');
  // It does not start until the VPN is up.
  assert.match(qbit, /vpn:\n\s+condition: service_healthy/);
  assert.match(service(full, 'vpn'), /- NET_ADMIN/);
  assert.match(service(full, 'vpn'), /"8080:8080"/);

  // Ollama has no login of its own, and FlareSolverr opens any site it is asked to.
  assert.equal(published(service(full, 'ollama')), false);
  assert.equal(published(service(full, 'flaresolverr')), false);
});

test('everything at once: the VPN login is read by the VPN alone, and kept out of git and the image', () => {
  const full = read('docker-compose.full.yml');
  assert.deepEqual([...full.matchAll(/env_file: (\S+)/g)].map((match) => match[1]), ['.env', 'vpn.env']);
  assert.match(service(full, 'vpn'), /env_file: vpn\.env/);
  for (const file of ['.gitignore', '.dockerignore']) assert.ok(read(file).split('\n').includes('vpn.env'), file);
  assert.match(read('vpn.env.example'), /^VPN_SERVICE_PROVIDER=$/m);

  // Every setting the compose file takes from .env is in the example, with what it is for.
  const example = read('.env.example');
  const used = [...new Set([...full.matchAll(/\$\{(\w+)/g)].map((match) => match[1]))];
  assert.deepEqual(used.sort(), ['MEDIA_DIR', 'OLLAMA_MODEL', 'PGID', 'PUID', 'TZ']);
  for (const name of used) assert.match(example, new RegExp(`^${name}=`, 'm'), name);
});
