// Builds gaps.json (the gap analysis), coverage.json, and appends to run-log.json on EVERY run.
// The run-log entry is the heartbeat: it guarantees a weekly commit so GitHub never disables the schedule,
// and it is the negative-assurance record ("monitored, nothing new").
import { readFile, writeFile } from 'node:fs/promises';
import { analyse, coverageStatement } from './lib.mjs';

const here = (f) => new URL(f, import.meta.url);
const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(here(f), 'utf8')); } catch { return fallback; } };
const writeJson = (f, d) => writeFile(here(f), JSON.stringify(d, null, 2) + '\n');

async function main() {
  const tax = await readJson('taxonomy.json');
  const { cases } = await readJson('cases.json');
  const { sources } = await readJson('sources.json');
  const data = await readJson('incidents.json', { incidents: [] });
  const state = await readJson('state.json', {});
  const log = await readJson('run-log.json', { runs: [] });
  const collectOutcome = process.env.COLLECT_OUTCOME || 'success';

  const { judgments = [] } = await readJson('judgments.json', { judgments: [] });
  const result = analyse(data.incidents, cases, tax, { judgments });
  const coverage = coverageStatement(sources);
  const now = new Date().toISOString();

  await writeJson('gaps.json', {
    generated_at: now,
    taxonomy_version: tax.taxonomy_version,
    suite_baseline: tax.suite_baseline,
    export: data.export || null,
    coverage,
    ...result,
  });
  await writeJson('coverage.json', { generated_at: now, ...coverage, sources });

  const last = state.last_run || {};
  const entry = {
    at: now,
    collect: collectOutcome === 'success' ? last.status || 'not-run' : 'FAILED',
    export_file: data.export?.file || null,
    incidents: result.totals.incidents,
    new_incidents: collectOutcome === 'success' ? last.new_incidents ?? 0 : 0,
    gaps_observed: result.gap_list.map((g) => g.id),
    note: collectOutcome !== 'success'
      ? 'Collection failed; previous data kept. See the Actions run log.'
      : last.baseline ? 'First run: existing incidents baselined.' : (last.new_incidents ? `${last.new_incidents} new incidents.` : 'Monitored. No new incidents.'),
  };
  log.runs.push(entry);
  log.runs = log.runs.slice(-260); // five years of weekly runs
  await writeJson('run-log.json', log);
  console.log(`analyse: ${result.totals.incidents} incidents, ${result.gap_list.length} gaps observed, run logged (${entry.note})`);
}

main().catch((e) => { console.error(`ANALYSE FAILED: ${e.message}`); process.exit(1); });
