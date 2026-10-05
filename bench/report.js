// Turns saved benchmark runs into a ranked comparison and readable transcripts.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const GB = 1024 ** 3;
const SIDE_BY_SIDE = ['film-with-year', 'nothing-there', 'personality', 'welcome-back'];
const FINALISTS = 4;

/** One model in one thinking mode is one thing being compared. */
export const configOf = (record) => `${record.model}${record.think === 'default' ? '' : `, thinking ${record.think}`}`;

const sum = (values) => values.reduce((total, value) => total + value, 0);
function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * fraction;
  const low = Math.floor(at);
  return Math.round(sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low));
}

/** A push is normal where a search rightly ends in "not found", so one is not held against the model there. */
const rescuesIn = (run) => Math.max(0, sum(run.turns.map((turn) => turn.nudges)) - (run.expectsPush ? 1 : 0)) + sum(run.turns.map((turn) => turn.emptyReplies));

/**
 * One summary per model and thinking mode, best first: fewest critical
 * failures before any, then most passes, then fewest rescues, then fastest.
 */
export function summarise(records) {
  const info = new Map(records.filter((record) => record.type === 'model').map((record) => [configOf(record), record]));
  // A scenario that was played again replaces its earlier run.
  const latest = new Map();
  for (const run of records) {
    // A run disturbed by someone else using Ollama says nothing about the model.
    if (run.type === 'run' && !run.disturbed) latest.set(`${configOf(run)}|${run.scenario}|${run.pass}`, run);
  }
  const byConfig = new Map();
  for (const run of latest.values()) {
    const key = configOf(run);
    byConfig.set(key, [...(byConfig.get(key) ?? []), run]);
  }

  const summaries = [...byConfig].map(([config, runs]) => {
    const turns = runs.flatMap((run) => run.turns);
    const usage = turns.flatMap((turn) => turn.usage);
    const tally = (keyOf) => {
      const counts = new Map();
      for (const run of runs) {
        const entry = counts.get(keyOf(run)) ?? { runs: 0, passed: 0, criticals: 0 };
        entry.runs += 1;
        entry.passed += run.ok ? 1 : 0;
        entry.criticals += run.critical ? 1 : 0;
        counts.set(keyOf(run), entry);
      }
      return counts;
    };
    const outputMs = sum(usage.map((entry) => entry.outputMs));
    const written = sum(usage.map((entry) => entry.thinkingChars + entry.contentChars));
    return {
      config,
      model: runs[0].model,
      think: runs[0].think,
      info: info.get(config) ?? null,
      runs: runs.length,
      passed: runs.filter((run) => run.ok).length,
      criticals: runs.filter((run) => run.critical).length,
      errors: turns.filter((turn) => turn.error).length,
      rescues: sum(runs.map(rescuesIn)),
      gaveUp: turns.filter((turn) => turn.stuck || turn.blank).length,
      askedFirst: sum(turns.map((turn) => turn.confirmations ?? 0)),
      requests: turns.length,
      // The stand-in indexer answers at once; a real one takes many seconds per search.
      searches: sum(runs.map((run) => run.searches?.length ?? 0)),
      medianMs: percentile(turns.map((turn) => turn.ms), 0.5),
      slowMs: percentile(turns.map((turn) => turn.ms), 0.9),
      tokensPerSecond: outputMs ? Math.round((sum(usage.map((entry) => entry.outputTokens)) / outputMs) * 1000) : 0,
      thinkingShare: written ? sum(usage.map((entry) => entry.thinkingChars)) / written : 0,
      maxPromptTokens: Math.max(0, ...usage.map((entry) => entry.promptTokens)),
      refusals: runs.filter((run) => run.flags?.refusal).length,
      jargon: runs.filter((run) => run.flags?.jargon).length,
      markup: runs.filter((run) => run.flags?.markup).length,
      groups: tally((run) => run.group),
      scenarios: tally((run) => run.scenario),
      list: runs,
    };
  });

  // Having any critical failure counts for more than how many: models are not all run equally often.
  const rank = (entry) => [entry.criticals ? 1 : 0, -entry.passed / entry.runs, entry.criticals / entry.runs, entry.rescues / entry.requests, entry.medianMs];
  return summaries.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    const at = x.findIndex((value, i) => value !== y[i]);
    return at < 0 ? 0 : x[at] - y[at];
  });
}

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '-');
const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
const quote = (text) => String(text || '(nothing)').trim().split('\n').map((line) => `> ${line}`).join('\n');

/**
 * What a loaded model takes. Where the machine's graphics memory could be read,
 * this is the difference loading made; otherwise it is Ollama's own figure.
 */
export function memory(info) {
  if (!info?.sizeBytes) return '-';
  // Ollama's totals can be wrong, but it does know when part of a model did not fit on the card.
  const onGpu = info.vramBytes / info.sizeBytes;
  const split = onGpu >= 0.995 ? '' : `, only ${percent(info.vramBytes, info.sizeBytes)} of the model on the GPU`;
  if (info.gpuBytes != null) return `${(info.gpuBytes / GB).toFixed(1)} GB of graphics memory${split}`;
  return `${(info.sizeBytes / GB).toFixed(1)} GB by Ollama's count${split}`;
}

/** The comparison as Markdown. `scenarios` gives the order and names of the rows. */
export function render(records, scenarios, numCtx) {
  const summaries = summarise(records);
  if (!summaries.length) return '# PiRick model benchmark\n\nNo runs yet.\n';
  const groups = [...new Set(scenarios.map((scenario) => scenario.group))];
  const out = ['# PiRick model benchmark', ''];
  out.push(`${sum(summaries.map((entry) => entry.runs))} runs of ${scenarios.length} scenarios, written ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '');

  out.push('## Ranking', '', 'Best first: models with no critical failures before those with any, then most scenarios passed, then fewest rescues, then speed.', '');
  out.push(
    table(
      ['#', 'Model', 'Passed', 'Critical failures', 'Asked first, per 100 requests', 'Rescues per 100 requests', 'Typical wait', 'Slow wait', 'Searches per request', 'Tokens/s', 'Thinking', 'Memory', 'Longest prompt'],
      summaries.map((entry, i) => [
        i + 1,
        `\`${entry.config}\``,
        `${percent(entry.passed, entry.runs)} (${entry.passed}/${entry.runs})`,
        entry.criticals,
        ((entry.askedFirst / entry.requests) * 100).toFixed(0),
        ((entry.rescues / entry.requests) * 100).toFixed(0),
        seconds(entry.medianMs),
        seconds(entry.slowMs),
        (entry.searches / entry.requests).toFixed(1),
        entry.tokensPerSecond || '-',
        percent(entry.thinkingShare, 1),
        memory(entry.info),
        entry.maxPromptTokens ? `${entry.maxPromptTokens}${numCtx && entry.maxPromptTokens > numCtx * 0.85 ? ' (near the limit)' : ''}` : '-',
      ]),
    ),
    '',
    '- **Critical failures**: downloaded the wrong or a spam item, downloaded when it should have asked, or told the user something was downloading when it was not.',
    '- **Asked first**: times the model checked with the user before downloading when it could have gone ahead. The user said yes and the model was judged on what it did next, so this is not a failure, but each one is an extra message to answer.',
    '- **Rescues**: times PiRick had to withhold a false claim, push the model to finish, or ask again after an empty reply. The user never sees these, but each one costs a wait.',
    '- **Typical wait** is the median time from a message to its finished reply, not counting the user\'s own time when asked something; **slow wait** is the time nine in ten requests beat. Both are the model alone: searches here are instant.',
    '- **Searches per request** is how many times the indexers were asked. Each one adds its own wait on a real setup, often 10 to 20 seconds.',
    '- **Thinking** is the share of what the model wrote that was reasoning the user never sees.',
    '',
  );

  out.push('## By kind of request', '');
  out.push(table(['Model', ...groups], summaries.map((entry) => [`\`${entry.config}\``, ...groups.map((group) => percent(entry.groups.get(group)?.passed ?? 0, entry.groups.get(group)?.runs ?? 0))])), '');

  out.push('## By scenario', '', 'Passes out of runs. An exclamation mark means at least one critical failure.', '');
  out.push(
    table(
      ['Scenario', ...summaries.map((entry) => `\`${entry.config}\``)],
      scenarios.map((scenario) => [
        `${scenario.title} (\`${scenario.id}\`)`,
        ...summaries.map((entry) => {
          const cell = entry.scenarios.get(scenario.id);
          return cell ? `${cell.passed}/${cell.runs}${cell.criticals ? ' !' : ''}` : '-';
        }),
      ]),
    ),
    '',
  );

  out.push('## Other things counted', '');
  out.push(
    table(
      ['Model', 'Refused or lectured', 'Used jargon', 'Used tables, headings or links', 'Gave up ("ask me again")', 'Errors and timeouts'],
      summaries.map((entry) => [`\`${entry.config}\``, entry.refusals, entry.jargon, entry.markup, entry.gaveUp, entry.errors]),
    ),
    '',
  );

  out.push('## What went wrong', '');
  for (const entry of summaries) {
    const failures = new Map();
    for (const run of entry.list) {
      for (const check of run.checks.filter((item) => !item.pass)) {
        const key = `\`${run.scenario}\`: ${check.name}${check.critical ? ' (critical)' : ''}`;
        failures.set(key, (failures.get(key) ?? 0) + 1);
      }
    }
    out.push(`### \`${entry.config}\``, '');
    out.push(failures.size ? [...failures].map(([what, count]) => `- ${what}, ${count} of ${entry.scenarios.get(what.slice(1, what.indexOf('`', 1))).runs}`).join('\n') : 'Nothing.', '');
  }

  const leaders = summaries.slice(0, FINALISTS);
  const noisy = scenarios.filter((scenario) => leaders.some((entry) => {
    const cell = entry.scenarios.get(scenario.id);
    return cell && cell.passed > 0 && cell.passed < cell.runs;
  }));
  if (noisy.length) {
    out.push('## Scenarios that went both ways', '', `One of the top ${leaders.length} passed these in some runs and failed them in others. A difference of a run or two between models here is luck.`, '');
    out.push(noisy.map((scenario) => `- \`${scenario.id}\`: ${leaders.map((entry) => `${entry.scenarios.get(scenario.id)?.passed ?? '-'}/${entry.scenarios.get(scenario.id)?.runs ?? '-'}`).join(', ')}`).join('\n'), '');
  }

  out.push('## The same replies side by side', '', `The first run of each, for the top ${Math.min(FINALISTS, summaries.length)}.`, '');
  for (const id of SIDE_BY_SIDE) {
    const scenario = scenarios.find((entry) => entry.id === id);
    if (!scenario) continue;
    out.push(`### ${scenario.title}`, '');
    for (const entry of summaries.slice(0, FINALISTS)) {
      const run = entry.list.find((candidate) => candidate.scenario === id);
      if (run) out.push(`\`${entry.config}\`${run.ok ? '' : ' (failed)'}:`, '', quote(run.turns.at(-1).reply), '');
    }
  }
  return `${out.join('\n')}\n`;
}

/** Every run of one model, as something a person can read through. */
function transcript(entry) {
  const out = [`# ${entry.config}`, ''];
  for (const run of entry.list) {
    out.push(`## ${run.scenario}, pass ${run.pass}: ${run.ok ? 'passed' : run.critical ? 'FAILED (critical)' : 'failed'}`, '');
    for (const turn of run.turns) {
      out.push(`**User:** ${turn.text}`, '');
      for (const call of turn.calls) out.push(`- \`${call.name}(${JSON.stringify(call.args)})\`${call.error ? ` → ${call.error}` : ''}`);
      for (const status of turn.statuses) out.push(`- _${status}_`);
      // Replies the user never saw: PiRick withheld them and sent the model back.
      const spoken = (turn.said ?? []).filter((entry) => !entry.calls.length && entry.content.trim());
      // The last thing it said is the reply itself, unless PiRick replaced that too.
      const withheld = turn.stuck ? spoken : spoken.slice(0, -1);
      for (const entry of withheld) out.push(`- withheld: “${entry.content.trim().replace(/\s+/g, ' ').slice(0, 300)}”`);
      const notes = [`${seconds(turn.ms)}`, `${turn.modelCalls} model calls`, turn.nudges && `${turn.nudges} pushes`, turn.emptyReplies && `${turn.emptyReplies} empty replies`, turn.error && `error: ${turn.error}`].filter(Boolean);
      if (turn.confirmations) out.push('', '**PiRick:**', '', quote(turn.asked), '', `**User:** ${turn.answered}`);
      out.push('', '**PiRick:**', '', quote(turn.reply), '', `(${notes.join(', ')})`, '');
    }
    out.push(run.checks.map((check) => `- ${check.pass ? 'pass' : check.critical ? 'FAIL (critical)' : 'FAIL'}: ${check.name}`).join('\n'), '');
  }
  return `${out.join('\n')}\n`;
}

/** Writes report.md, results.json and one transcript per model into `dir`. */
export function writeReport(dir, records, scenarios, numCtx) {
  const summaries = summarise(records);
  mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  writeFileSync(path.join(dir, 'report.md'), render(records, scenarios, numCtx));
  writeFileSync(
    path.join(dir, 'results.json'),
    JSON.stringify(summaries.map(({ list, groups, scenarios: cells, ...rest }) => ({ ...rest, groups: Object.fromEntries(groups), scenarios: Object.fromEntries(cells) })), null, 2),
  );
  for (const entry of summaries) {
    writeFileSync(path.join(dir, 'transcripts', `${entry.config.replace(/[^a-z0-9.]+/gi, '-')}.md`), transcript(entry));
  }
  return summaries;
}
