import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { findLatestExport, assertPinnedHost, rowsToIncidents, compileTaxonomy, classifyIncident, sanitiseLlm, analyse, coverageStatement, normDate } from './lib.mjs';
import { parseWorkbook } from './collect.mjs';
import { buildPrompt } from './llm.mjs';

const tax = JSON.parse(readFileSync(new URL('./taxonomy.json', import.meta.url)));
const { cases } = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url)));
const { sources } = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url)));
const ctax = compileTaxonomy(tax);
const HOST = 'pub-72b2b2fc36ec423189843747af98f80e.r2.dev';

// Builds a workbook laid out like the real AIID export: banner row 1, group band row 2, headers row 3.
async function fakeExport(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Incidents');
  ws.addRow(['AI Incident Database: Incidents']);
  ws.addRow(['INCIDENT IDENTITY', '', '', '', '', 'RISK CLASSIFICATION - MIT']);
  ws.addRow(['Incident ID', 'date', 'year', 'title', 'description', 'deployer', 'developer', 'harmed', 'Editor Notes', 'Risk Domain', 'Risk Subdomain', 'Public Sector Deployment', 'Country Code']);
  for (const r of rows) ws.addRow(r);
  wb.addWorksheet('Reports').addRow(['x']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('taxonomy: ids unique, every mode has coverage status and every mapped mode cites something', () => {
  const ids = tax.failure_modes.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 21);
  for (const m of tax.failure_modes) {
    assert.ok(['mapped', 'partial', 'unmapped'].includes(m.coverage), m.id);
    if (m.coverage === 'mapped') assert.ok(m.sections.length + m.artefacts.length > 0, m.id);
    if (m.coverage === 'unmapped') assert.equal(m.artefacts.length, 0, m.id);
    for (const a of m.artefacts) assert.match(a, /^AIG-(GOV|INV|ASS|DEC|OPS|AIMS|AGT)-\d{2}$/, `${m.id}: ${a}`);
    for (const c of m.text_cues) new RegExp(c); // compiles
  }
});

test('taxonomy: the three July gaps now closed are recorded as such, two remain partial, one new unmapped', () => {
  const by = Object.fromEntries(tax.failure_modes.map((m) => [m.id, m]));
  for (const id of ['vendor-model-substitution', 'downstream-reuse', 'redress-failure']) { assert.equal(by[id].coverage, 'mapped'); assert.ok(by[id].was_gap_in); }
  for (const id of ['deskilling', 'cumulative-population-harm']) assert.equal(by[id].coverage, 'partial');
  assert.equal(by['workforce-algorithmic-management'].coverage, 'unmapped');
});

test('cases: every case has sources, valid ids and an honest determination level', () => {
  const modeIds = new Set(tax.failure_modes.map((m) => m.id));
  const remIds = new Set(tax.remediation_types.map((r) => r.id));
  for (const c of cases) {
    assert.ok(c.sources.length >= 1 && c.sources.every((s) => /^https:\/\//.test(s.url)), c.id);
    for (const m of c.failure_modes) assert.ok(modeIds.has(m), `${c.id}: ${m}`);
    for (const r of c.remediation) assert.ok(remIds.has(r.type), `${c.id}: ${r.type}`);
    assert.ok(['alleged', 'acknowledged', 'determined'].includes(c.determination.level));
    if (c.determination.level === 'determined') assert.ok(c.determination.by, c.id);
  }
});

test('discovery: picks newest export on the pinned host and ignores others', () => {
  const html = `<a href="https://${HOST}/AIID_Excel_Export-20260928.xlsx">x</a>
    <a href="https://${HOST}/AIID_Excel_Export-20261005.xlsx">y</a>
    <a href="https://evil.example.com/AIID_Excel_Export-20991231.xlsx">z</a>`;
  const hit = findLatestExport(html, HOST);
  assert.equal(hit.file, 'AIID_Excel_Export-20261005.xlsx');
  assert.equal(hit.export_date, '2026-10-05');
  assert.equal(findLatestExport('<p>nothing</p>', HOST), null);
});

test('host pinning refuses other hosts', () => {
  assert.doesNotThrow(() => assertPinnedHost(`https://${HOST}/AIID_Excel_Export-20261005.xlsx`, HOST));
  assert.throws(() => assertPinnedHost('https://evil.example.com/AIID_Excel_Export-20261005.xlsx', HOST), /Refusing/);
});

test('parser: reads an AIID-shaped workbook, finds header on row 3, skips non-numeric rows', async () => {
  const buf = await fakeExport([
    [1, new Date('2015-05-19'), 2015, 'YouTube Kids shows inappropriate content', 'Desc one', 'youtube', 'google', 'children', '', 'Discrimination and Toxicity', '1.2 Exposure to toxic content', 'No', 'US'],
    ['TOTAL'],
    [2, '2020-08-06', 2020, 'Visa algorithm', 'Desc two', 'home-office', '', '', '', '', '', '', 'GB'],
  ]);
  const incs = await parseWorkbook(buf);
  assert.equal(incs.length, 2);
  assert.equal(incs[0].id, 1);
  assert.equal(incs[0].date, '2015-05-19');
  assert.equal(incs[1].url, 'https://incidentdatabase.ai/cite/2/');
});

test('parser: fails loudly when the layout changes', () => {
  assert.throws(() => rowsToIncidents([['ID', 'when', 'name']]), /no header row/);
  assert.throws(() => rowsToIncidents([['Incident ID', 'date', 'title']]), /required columns missing: description/);
});

test('normDate handles ISO, datetime and bare years', () => {
  assert.equal(normDate('2020-08-11T00:00:00Z'), '2020-08-11');
  assert.equal(normDate('2019'), '2019-01-01');
  assert.equal(normDate(''), null);
});

test('classifier: MIT tag and text cues both count, with their basis recorded', () => {
  const c = classifyIncident({ title: 'Council algorithm wrongly flagged benefit claimants', description: 'The system was found to be racially discriminatory and claimants could not appeal.', mit_subdomain: '1.1 Unfair discrimination and misrepresentation', deployer: 'city-of-rotterdam' }, ctax);
  const ids = c.modes.map((m) => m.id);
  assert.ok(ids.includes('biased-outcome'));
  assert.deepEqual(c.modes.find((m) => m.id === 'biased-outcome').basis, ['mit', 'text']);
  assert.ok(ids.includes('solely-automated-decision'));
  assert.ok(ids.includes('vulnerable-group-harm'));
  assert.ok(ids.includes('redress-failure'));
  assert.equal(c.public_sector, true);
  assert.equal(c.public_sector_basis, 'deployer name');
  assert.equal(c.determination, 'alleged');
});

test('classifier: word boundaries stop false hits, editors\' public-sector field wins over name', () => {
  const c = classifyIncident({ title: 'Agentive software for childcare', description: 'Nothing happened.', deployer: 'county-fair-ltd', public_sector_field: 'No' }, ctax);
  assert.ok(!c.modes.some((m) => m.id === 'agentic-overreach'));
  assert.equal(c.public_sector, false);
});

test('remediation cues are detected but only as indicated', () => {
  const c = classifyIncident({ title: 'Tool scrapped', description: 'The department apologised and the scheme was scrapped after a court ruled it unlawful.' }, ctax);
  assert.deepEqual(c.remediation_indicated.sort(), ['apology', 'court-ruling', 'withdrawn']);
  assert.equal(c.determination, 'alleged');
});

test('LLM output: invented ids discarded, determination can be lowered never raised', () => {
  const s = sanitiseLlm({ failure_modes: ['biased-outcome', 'made-up-mode', 7], remediation: ['apology', 'jail'], determination: 'determined' }, 'alleged', tax);
  assert.deepEqual(s.modes, ['biased-outcome']);
  assert.deepEqual(s.remediation, ['apology']);
  assert.equal(s.determination, 'alleged');
  assert.deepEqual(s.discarded.sort(), ['7', 'jail', 'made-up-mode']);
  assert.equal(sanitiseLlm({ determination: 'alleged' }, 'acknowledged', tax).determination, 'alleged');
  assert.equal(sanitiseLlm(null, 'alleged', tax).modes.length, 0);
});

test('LLM prompt carries only the incident text and the fixed id lists', () => {
  const p = buildPrompt({ title: 'T', description: 'D', editor_notes: '' }, tax);
  assert.match(p, /ONLY the text supplied/);
  for (const m of tax.failure_modes) assert.ok(p.includes(m.id));
});

test('analysis: gap list holds observed partial/unmapped modes; unexercised controls listed; no-remediation counted', () => {
  const mk = (id, text, ps) => ({ id, date: '2025-01-01', classification: classifyIncident({ title: text, description: '', deployer: ps ? 'city council' : 'acme' }, ctax) });
  const incs = [
    mk(1, 'Employee monitoring software scored workers on productivity', true),
    mk(2, 'Chatbot hallucinated fake citations', false),
    mk(3, 'Nothing classifiable here', false),
  ];
  const r = analyse(incs, cases, tax);
  assert.equal(r.totals.incidents, 3);
  assert.equal(r.totals.unclassified, 1);
  assert.ok(r.gap_list.some((g) => g.id === 'workforce-algorithmic-management'));
  assert.ok(r.gap_list.every((g) => g.coverage !== 'mapped'));
  assert.equal(r.remediation.none_indicated, 3);
  assert.ok(r.unexercised_controls.includes('agentic-overreach'));
  assert.deepEqual(r.closed_since_july.sort(), ['downstream-reuse', 'redress-failure', 'vendor-model-substitution']);
  assert.equal(r.determinations.determined, cases.filter((c) => c.determination.level === 'determined').length);
  assert.equal(r.modes[0].public >= r.modes.at(-1).public, true);
});

test('coverage statement names what is and is not read', () => {
  const c = coverageStatement(sources);
  assert.ok(c.collected.length === 2);
  assert.match(c.statement, /Find Case Law/);
  assert.match(c.statement, /does not read .*OECD/);
  assert.match(c.statement, /allegations/);
});

test('false-positive guard: creative-work and market-competition incidents do not count as gaps', () => {
  const art = classifyIncident({ title: 'GAN artwork won first place at state fair', description: 'An AI-generated image won an art prize.', mit_subdomain: '6.3 Economic and cultural devaluation of human effort' }, ctax);
  const mkt = classifyIncident({ title: 'Retailer tweaked search algorithm to boost own products', description: 'Self-preferencing in search results.', mit_subdomain: '6.1 Power centralization and unfair distribution of benefits' }, ctax);
  const rent = classifyIncident({ title: 'Rent pricing algorithm inflated rents', description: 'Landlords used shared software.', mit_subdomain: '6.2 Increased inequality and decline in employment quality' }, ctax);
  const ids = [...art.modes, ...mkt.modes, ...rent.modes].map((m) => m.id);
  for (const gap of ['deskilling', 'cumulative-population-harm', 'workforce-algorithmic-management']) assert.ok(!ids.includes(gap), gap);
  const flex = classifyIncident({ title: 'Delivery drivers allegedly fired via automated employee evaluations', description: '' }, ctax);
  assert.ok(flex.modes.some((m) => m.id === 'workforce-algorithmic-management'));
});

// ---------- Find Case Law connector ----------
import { licenceAllows, parseFeed, bodyText, aiPassages, classifyJudgment } from './judgments.mjs';

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xml:lang="en-us" xmlns="http://www.w3.org/2005/Atom" xmlns:tna="https://caselaw.nationalarchives.gov.uk">
  <title>Latest documents</title>
  <link href="https://caselaw.nationalarchives.gov.uk/atom.xml?page=2" rel="next"/>
  <entry>
    <title>Ayinde, R (on the application of) v London Borough of Haringey</title>
    <link href="https://caselaw.nationalarchives.gov.uk/ewhc/admin/2025/1383" rel="alternate"/>
    <published>2025-06-06T00:00:00+00:00</published><updated>2025-06-06T09:54:24+00:00</updated>
    <author><name>High Court (Administrative Court)</name></author>
    <tna:contenthash>abc123</tna:contenthash>
    <link href="https://caselaw.nationalarchives.gov.uk/ewhc/admin/2025/1383/data.xml" rel="alternate" type="application/akn+xml"/>
    <tna:uri>d-1111</tna:uri>
    <tna:identifier slug="ewhc/admin/2025/1383" type="ukncn">[2025] EWHC 1383 (Admin)</tna:identifier>
    <tna:identifier slug="tna.x1" type="fclid">x1</tna:identifier>
  </entry>
</feed>`;

test('judgments: connector is off unless a licence is granted AND referenced', () => {
  assert.equal(licenceAllows({ licence: { granted: false, reference: null } }), false);
  assert.equal(licenceAllows({ licence: { granted: true, reference: '' } }), false);
  assert.equal(licenceAllows({ licence: { granted: true, reference: 'CAL-123' } }), true);
  const src = sources.find((s) => s.id === 'find-case-law');
  assert.equal(licenceAllows(src), false, 'must ship switched off');
  assert.equal(src.collected, false);
});

test('judgments: parses the documented Atom shape', () => {
  const { entries, next } = parseFeed(FEED);
  assert.equal(next, 'https://caselaw.nationalarchives.gov.uk/atom.xml?page=2');
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.citation, '[2025] EWHC 1383 (Admin)');
  assert.equal(e.fclid, 'x1');
  assert.equal(e.published, '2025-06-06');
  assert.equal(e.xml_url, 'https://caselaw.nationalarchives.gov.uk/ewhc/admin/2025/1383/data.xml');
  assert.equal(e.url, 'https://caselaw.nationalarchives.gov.uk/ewhc/admin/2025/1383');
});

test('judgments: AI gate drops judgments that do not discuss AI; classification uses only AI passages', () => {
  const e = parseFeed(FEED).entries[0];
  assert.equal(classifyJudgment(e, bodyText('<akomaNtoso><p>A planning dispute about a fence.</p></akomaNtoso>'), ctax), null);
  const text = bodyText('<akomaNtoso><header>x</header><p>The grounds cited five fictitious cases, apparently produced with a generative AI tool, and fake citations were put before the court.</p></akomaNtoso>');
  const c = classifyJudgment(e, text, ctax);
  assert.ok(c.modes.some((m) => m.id === 'hallucination-misinformation'));
  assert.equal(c.determination, 'determined');
  assert.equal(c.public_sector, true);
  assert.ok(c.ai_terms.includes('generative AI'));
  assert.ok(aiPassages(text).length >= 1);
});

test('judgments: nothing stored carries judgment text', () => {
  const e = parseFeed(FEED).entries[0];
  const c = classifyJudgment(e, 'A generative AI tool produced fictitious cases.', ctax);
  const record = { ...e, classification: c };
  assert.ok(!JSON.stringify(record).includes('produced fictitious cases'));
});

test('analysis counts court judgments per mode and in totals', () => {
  const j = [{ uri: 'd-1', classification: { modes: [{ id: 'workforce-algorithmic-management', basis: ['text'] }], public_sector: true } }];
  const r = analyse([], [], tax, { judgments: j });
  assert.equal(r.totals.judgments, 1);
  assert.equal(r.totals.judgments_public, 1);
  assert.equal(r.modes.find((m) => m.id === 'workforce-algorithmic-management').court, 1);
  assert.ok(r.gap_list.some((g) => g.id === 'workforce-algorithmic-management'));
});
