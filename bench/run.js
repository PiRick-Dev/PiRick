// Puts Ollama models through every benchmark scenario and writes a comparison.
//
//   npm run bench -- --models gemma4:e4b,gemma4:12b            two passes of everything
//   npm run bench -- --models gemma4:12b --passes 5            carry on up to five passes
//   npm run bench -- --models gemma4:12b --think off           the same model without thinking
//   npm run bench -- --models gemma4:12b --measure             only load it and note the memory it takes
//   npm run bench -- --models scripted                         dry run with the ideal scripts
//   npm run bench -- --report                                  rebuild the report only
//
// Runs are saved as they finish, so a stopped benchmark picks up where it was.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// PiRick logs every search and download; here that would bury the progress lines.
process.env.LOG_LEVEL ??= 'error';
const { createOllama } = await import('../src/ollama.js');
const { writeReport, configOf, memory } = await import('./report.js');
const { SCENARIOS, judge, play, stoppedAtQuestion } = await import('./scenarios.js');
const { createWorld, scripted } = await import('./world.js');

const THINK = { default: undefined, off: false, on: true, low: 'low', medium: 'medium', high: 'high' };
const SCRIPTED = 'scripted';
const MAX_ATTEMPTS = 3;
const GB = 1024 ** 3;
// How long memory is given to be released after a model is unloaded.
const SETTLE_MS = 3000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { values: args } = parseArgs({
  options: {
    models: { type: 'string', default: '' },
    passes: { type: 'string', default: '2' },
    think: { type: 'string', default: 'default' },
    scenarios: { type: 'string', default: '' },
    name: { type: 'string', default: 'main' },
    report: { type: 'boolean', default: false },
    measure: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});
if (!Object.hasOwn(THINK, args.think)) throw new Error(`--think must be one of: ${Object.keys(THINK).join(', ')}`);
const passes = Number(args.passes);
if (!Number.isInteger(passes) || passes < 1) throw new Error('--passes must be a whole number');
const models = args.models.split(',').map((name) => name.trim()).filter(Boolean);
const wanted = args.scenarios.split(',').map((id) => id.trim()).filter(Boolean);
const unknown = wanted.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
if (unknown.length) throw new Error(`No such scenario: ${unknown.join(', ')}`);
const scenarios = wanted.length ? SCENARIOS.filter((scenario) => wanted.includes(scenario.id)) : SCENARIOS;
if (!models.length && !args.report) throw new Error('Say which models to test: --models name,name (or --report to rebuild the report)');

// The same settings PiRick runs with. Only Ollama's address is taken from the
// environment: the benchmark is never told where Jackett or qBittorrent are.
const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const numCtx = Number(process.env.OLLAMA_NUM_CTX) || 8192;
const settingsFor = (model, pass) => ({ url, model, apiKey: process.env.OLLAMA_API_KEY ?? '', numCtx, keepAlive: '30m', timeoutMs: 240_000, think: THINK[args.think], seed: 1000 + pass });

const dir = path.resolve('bench', 'results', args.name);
const file = path.join(dir, 'runs.jsonl');
mkdirSync(dir, { recursive: true });
const records = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
function save(record) {
  records.push(record);
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

async function api(route, body) {
  let res;
  try {
    res = await fetch(url + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch (err) {
    throw new Error(`Cannot reach Ollama at ${url} (${err.cause?.code ?? err.message})`);
  }
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status} for ${route}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
/**
 * Graphics memory in use on the whole machine, in bytes, or null where it
 * cannot be read. Ollama's own figure for a loaded model is far too low on some
 * graphics backends, so the report prefers the difference loading makes.
 */
function gpuMemoryUsed() {
  if (process.platform !== 'win32') return null;
  try {
    const sum = "((Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples | Measure-Object CookedValue -Sum).Sum";
    const bytes = Number(execFileSync('powershell', ['-NoProfile', '-Command', sum], { encoding: 'utf8', timeout: 30_000 }).trim());
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}
const loaded = async () => (await api('/api/ps')).models ?? [];
const unload = (model) => api('/api/generate', { model, keep_alive: 0 });
const isModel = (entry, model) => entry.name === model || entry.name === `${model}:latest`;

/** Checks a model can be tested, loads it alone, and notes how much room it takes. */
async function prepare(model) {
  const base = { type: 'model', model, think: args.think, at: new Date().toISOString() };
  let shown;
  try {
    shown = await api('/api/show', { model });
  } catch (err) {
    if (!/HTTP 404/.test(err.message)) throw err;
    return { ...base, skipped: `not installed: run "ollama pull ${model}"` };
  }
  const capabilities = shown.capabilities ?? [];
  Object.assign(base, { capabilities, parameters: shown.details?.parameter_size, quantization: shown.details?.quantization_level });
  if (!capabilities.includes('tools')) return { ...base, skipped: 'cannot call tools' };
  if (args.think !== 'default' && !capabilities.includes('thinking')) return { ...base, skipped: 'does not think, so there is nothing to switch' };

  // Everything is unloaded first, the model itself included, so its loading time
  // is measured from cold and the memory it takes is the difference it makes.
  for (const other of await loaded()) await unload(other.name);
  await sleep(SETTLE_MS);
  const before = gpuMemoryUsed();
  let loadMs = 0;
  try {
    await createOllama(settingsFor(model, 0), { onUsage: (usage) => (loadMs = usage.loadMs) }).chat({ messages: [{ role: 'user', content: 'Reply with the one word: ready' }] });
  } catch (err) {
    return { ...base, skipped: `could not be loaded: ${err.message}` };
  }
  const gpu = gpuMemoryUsed();
  const running = (await loaded()).find((entry) => isModel(entry, model));
  const gpuBytes = gpu == null || before == null ? null : Math.max(0, gpu - before);

  // A machine with two graphics adapters can put the model on the weak one,
  // where it runs many times slower and every timing is meaningless. Hardly any
  // dedicated graphics memory taken by loading a large model is the sign of it.
  const fileBytes = (await api('/api/tags')).models?.find((entry) => isModel(entry, model))?.size ?? 0;
  if (!args.force && gpuBytes != null && fileBytes > GB && gpuBytes < fileBytes * 0.2) {
    await unload(model);
    const taken = `${(gpuBytes / GB).toFixed(1)} GB of dedicated graphics memory for a ${(fileBytes / GB).toFixed(1)} GB model`;
    return { ...base, skipped: `it does not seem to be on the dedicated graphics card (loading it took ${taken}). Run with --force to test it anyway` };
  }
  return { ...base, loadMs, sizeBytes: running?.size ?? 0, vramBytes: running?.size_vram ?? 0, gpuBytes };
}

/** One scenario, once. Repeated if someone else's request loaded another model meanwhile. */
async function runOnce(model, scenario, pass) {
  const live = model !== SCRIPTED;
  for (let attempt = 1; ; attempt++) {
    if (live) for (const other of await loaded()) if (!isModel(other, model)) await unload(other.name);
    const world = createWorld(scenario.setup, (onUsage) => (live ? createOllama(settingsFor(model, pass), { onUsage }) : scripted(scenario.ideal)));
    let result;
    try {
      result = await play(scenario, world);
    } finally {
      world.close();
    }
    const { trace, checks, ok, critical } = result;
    // Without Ollama there is nothing to measure, and recording failures would only mislead.
    const down = trace.turns.find((turn) => /Cannot reach Ollama|is not available: run/.test(turn.error ?? ''));
    if (down) throw new Error(down.error);
    const disturbed = live && (await loaded()).some((entry) => !isModel(entry, model));
    const record = {
      type: 'run',
      model,
      think: args.think,
      scenario: scenario.id,
      group: scenario.group,
      pass,
      at: new Date().toISOString(),
      ok,
      critical,
      disturbed,
      expectsPush: Boolean(scenario.expectsPush),
      checks,
      flags: trace.flags,
      turns: trace.turns,
      added: trace.added,
      searches: trace.searches,
    };
    save(record);
    if (!disturbed || attempt >= MAX_ATTEMPTS) return record;
    console.log('    another model was loaded during that run; repeating it');
  }
}

const key = (record) => `${configOf(record)}|${record.scenario}|${record.pass}`;
// A run saved before the user began answering PiRick's questions is kept unless it stopped at one.
const stale = (record) => stoppedAtQuestion(SCENARIOS.find((scenario) => scenario.id === record.scenario) ?? { turns: [] }, record);
const done = new Set(records.filter((record) => record.type === 'run' && !record.disturbed && !stale(record)).map(key));

for (const model of models) {
  const todo = [];
  for (let pass = 1; pass <= passes; pass++) {
    for (const scenario of scenarios) if (!done.has(key({ model, think: args.think, scenario: scenario.id, pass }))) todo.push({ scenario, pass });
  }
  const label = configOf({ model, think: args.think });
  if (args.measure) todo.length = 0;
  if (!todo.length && !args.measure) {
    console.log(`${label}: nothing left to run`);
    continue;
  }
  if (model !== SCRIPTED) {
    const info = await prepare(model);
    save(info);
    if (info.skipped) {
      console.log(`${label}: skipped, ${info.skipped}`);
      continue;
    }
    console.log(`${label}: ${info.parameters ?? '?'} ${info.quantization ?? ''}, ${memory(info)}, loaded in ${(info.loadMs / 1000).toFixed(1)} s, ${todo.length} runs to go`);
  }
  const started = Date.now();
  for (const [i, { scenario, pass }] of todo.entries()) {
    const record = await runOnce(model, scenario, pass);
    const took = record.turns.reduce((total, turn) => total + turn.ms, 0);
    const failed = record.checks.filter((check) => !check.pass).map((check) => check.name);
    const verdict = record.ok ? 'pass' : `${record.critical ? 'CRITICAL' : 'fail'}: ${failed.join('; ')}`;
    console.log(`  [${i + 1}/${todo.length}] ${scenario.id} #${pass}  ${(took / 1000).toFixed(1)}s  ${verdict}`);
  }
  if (model !== SCRIPTED) await unload(model);
  console.log(`${label}: finished in ${Math.round((Date.now() - started) / 60_000)} min`);
}

// Saved runs are judged afresh, so a check that is corrected later also applies to the runs made before.
for (const record of records) {
  const scenario = SCENARIOS.find((entry) => entry.id === record.scenario);
  if (record.type !== 'run' || !scenario) continue;
  const trace = { turns: record.turns, added: record.added, searches: record.searches, calls: record.turns.flatMap((turn) => turn.calls), reply: record.turns.at(-1)?.reply ?? '' };
  Object.assign(record, judge(scenario, trace), { group: scenario.group, expectsPush: Boolean(scenario.expectsPush) });
}
const summaries = writeReport(dir, records, SCENARIOS, numCtx);
console.log(`\n${'Model'.padEnd(46)} ${'Passed'.padEnd(13)} Critical  Rescues  Typical wait`);
for (const entry of summaries) {
  const passed = `${entry.passed}/${entry.runs} (${Math.round((entry.passed / entry.runs) * 100)}%)`;
  console.log(`${entry.config.padEnd(46)} ${passed.padEnd(13)} ${String(entry.criticals).padEnd(9)} ${String(entry.rescues).padEnd(8)} ${(entry.medianMs / 1000).toFixed(1)} s`);
}
console.log(`\nReport: ${path.join(dir, 'report.md')}`);
