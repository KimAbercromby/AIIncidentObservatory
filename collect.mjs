// Weekly collection: find the newest AIID Excel export, download it from the pinned host,
// parse the Incidents sheet, and classify every incident against the current taxonomy.
// Usage: node collect.mjs [--force]   (env OBS_EXPORT_URL overrides discovery; OBS_EXPORT_FILE reads a local file)
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { findLatestExport, assertPinnedHost, cellText, rowsToIncidents, compileTaxonomy, classifyIncident } from './lib.mjs';

const MIN_INCIDENTS = 100;
const here = (f) => new URL(f, import.meta.url);
const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(here(f), 'utf8')); } catch { return fallback; } };
const writeJson = (f, d) => writeFile(here(f), JSON.stringify(d, null, 2) + '\n');
const UA = 'AIIncidentObservatory/2.0 (weekly, one download; github.com/KimAbercromby/AIIncidentObservatory)';

export async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Incidents');
  if (!ws) throw new Error('Workbook has no "Incidents" sheet. The export layout has changed.');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values; // 1-based, sparse
    const out = [];
    for (let i = 1; i < vals.length; i++) out.push(cellText(vals[i]));
    rows.push(out);
  });
  return rowsToIncidents(rows);
}

async function discover(src) {
  if (process.env.OBS_EXPORT_URL) return { url: process.env.OBS_EXPORT_URL, file: process.env.OBS_EXPORT_URL.split('/').pop(), export_date: (process.env.OBS_EXPORT_URL.match(/(\d{4})(\d{2})(\d{2})\.xlsx$/) || []).slice(1).join('-') || null };
  const pages = [src.listing_url, new URL('/page-data/research/snapshots/page-data.json', src.listing_url).href];
  for (const p of pages) {
    const res = await fetch(p, { headers: { 'user-agent': UA } });
    if (!res.ok) continue;
    const hit = findLatestExport(await res.text(), src.download_host);
    if (hit) return hit;
  }
  throw new Error(`No AIID_Excel_Export link on ${src.listing_url} from host ${src.download_host}. Check the snapshots page by hand.`);
}

async function main() {
  const force = process.argv.includes('--force');
  const { sources } = await readJson('sources.json');
  const src = sources.find((s) => s.id === 'aiid-excel-export');
  const ctax = compileTaxonomy(await readJson('taxonomy.json'));
  const state = await readJson('state.json', {});
  const prev = await readJson('incidents.json', { incidents: [] });
  const prevById = new Map(prev.incidents.map((i) => [i.id, i]));

  let incidents;
  let status;
  let exportInfo = state.last_export || null;

  if (process.env.OBS_EXPORT_FILE) {
    incidents = await parseWorkbook(await readFile(process.env.OBS_EXPORT_FILE));
    exportInfo = { file: process.env.OBS_EXPORT_FILE.split('/').pop(), export_date: null, url: null };
    status = 'collected-local-file';
  } else {
    const hit = await discover(src);
    assertPinnedHost(hit.url, src.download_host);
    if (!force && state.last_export?.file === hit.file && prev.incidents.length) {
      incidents = prev.incidents.map(({ classification, ...rest }) => rest);
      status = 'no-new-export';
    } else {
      const res = await fetch(hit.url, { headers: { 'user-agent': UA } });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${hit.url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      incidents = await parseWorkbook(buf);
      exportInfo = { ...hit, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
      status = 'collected';
    }
  }

  // Collapse detection: a run that parses far fewer incidents than before is treated as a failure, not news.
  if (incidents.length < MIN_INCIDENTS) throw new Error(`Parsed only ${incidents.length} incidents (minimum ${MIN_INCIDENTS}). Not overwriting the previous data.`);
  if (prev.incidents.length && incidents.length < prev.incidents.length * 0.5) throw new Error(`Parsed ${incidents.length} incidents, under half the previous ${prev.incidents.length}. Not overwriting the previous data.`);

  const newIds = [];
  const out = incidents.map((inc) => {
    const old = prevById.get(inc.id);
    if (!old) newIds.push(inc.id);
    const textHash = createHash('sha256').update(`${inc.title}\n${inc.description}\n${inc.editor_notes}`).digest('hex').slice(0, 16);
    const classification = classifyIncident(inc, ctax);
    // Keep machine suggestions only while the text they were made on is unchanged.
    const llm = old?.classification?.llm && old.text_hash === textHash ? old.classification.llm : null;
    if (llm) {
      classification.llm = llm;
      classification.llm_modes = llm.modes;
      classification.llm_remediation = llm.remediation;
      classification.determination = llm.determination;
    }
    return { ...inc, text_hash: textHash, first_seen: old?.first_seen || new Date().toISOString().slice(0, 10), classification };
  });

  await writeJson('incidents.json', {
    source: 'AI Incident Database weekly Excel export (CC BY-SA 4.0). Titles and descriptions are AIID editors\' text; classification is this tool\'s.',
    export: exportInfo,
    taxonomy_version: ctax.taxonomy_version,
    incidents: out,
  });
  await writeJson('state.json', {
    last_export: exportInfo,
    last_run: { at: new Date().toISOString(), status, incidents: out.length, new_incidents: prev.incidents.length ? newIds.length : 0, baseline: prev.incidents.length === 0 },
  });
  console.log(`${status}: ${out.length} incidents (${prev.incidents.length ? newIds.length + ' new' : 'first run, baselined'}) from ${exportInfo?.file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`COLLECT FAILED: ${e.message}`); process.exit(1); });
}
