// OPTIONAL machine classification for public-sector incidents. Runs only if ANTHROPIC_API_KEY is set.
// Constraints: the model sees only the incident's own text, may choose only taxonomy ids,
// invented ids are discarded, and it may lower the determination level but never raise it.
// Suggestions are stored separately (classification.llm) and labelled as machine-suggested in the viewer.
import { readFile, writeFile } from 'node:fs/promises';
import { sanitiseLlm } from './lib.mjs';

const here = (f) => new URL(f, import.meta.url);
const MAX = Number(process.env.OBS_LLM_MAX || 40);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

export function buildPrompt(inc, tax) {
  const modes = tax.failure_modes.map((m) => `- ${m.id}: ${m.description}`).join('\n');
  const rems = tax.remediation_types.map((r) => `- ${r.id}: ${r.label}`).join('\n');
  return `Classify one AI incident using ONLY the text supplied. Do not use outside knowledge.

FAILURE MODES (choose zero or more ids):
${modes}

REMEDIATION TYPES (choose only those the text says actually happened):
${rems}

DETERMINATION: the record is currently "alleged". You may answer "alleged" only. Never claim a court, regulator or ombudsman finding the text does not state.

INCIDENT TEXT:
Title: ${inc.title}
Description: ${inc.description}
${inc.editor_notes ? 'Editor notes: ' + inc.editor_notes : ''}

Reply with JSON only: {"failure_modes": [...], "remediation": [...], "determination": "alleged"}`;
}

async function callModel(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body.content?.map((c) => c.text || '').join('') || '';
  const json = text.match(/\{[\s\S]*\}/);
  return json ? JSON.parse(json[0]) : {};
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.log('llm: ANTHROPIC_API_KEY not set, skipping (deterministic classification only).'); return; }
  const tax = JSON.parse(await readFile(here('taxonomy.json'), 'utf8'));
  const data = JSON.parse(await readFile(here('incidents.json'), 'utf8'));
  const todo = data.incidents.filter((i) => i.classification.public_sector && !i.classification.llm).slice(0, MAX);
  let done = 0;
  for (const inc of todo) {
    try {
      const raw = await callModel(buildPrompt(inc, tax));
      const s = sanitiseLlm(raw, inc.classification.determination, tax);
      inc.classification.llm = { ...s, model: MODEL, at: new Date().toISOString().slice(0, 10) };
      inc.classification.llm_modes = s.modes;
      inc.classification.llm_remediation = s.remediation;
      inc.classification.determination = s.determination;
      done++;
    } catch (e) {
      console.warn(`llm: incident ${inc.id} skipped: ${e.message}`);
    }
  }
  await writeFile(here('incidents.json'), JSON.stringify(data, null, 2) + '\n');
  console.log(`llm: classified ${done} of ${todo.length} queued public-sector incidents with ${MODEL}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
