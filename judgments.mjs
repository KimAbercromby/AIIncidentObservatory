// Find Case Law connector. SWITCHED OFF until a computational analysis licence is granted:
// it does nothing unless sources.json -> find-case-law -> licence.granted is true and a reference is set.
//
// What it does when on: reads the documented Atom feed for a fixed set of AI search terms, fetches each new or
// changed judgment's XML once, checks the body really mentions AI, and classifies it against the taxonomy.
// Under the nine principles it stores NO judgment text: only metadata, a link to the authoritative version,
// and the labels assigned. Judgments that the National Archives withdraws are removed on the monthly re-check.
import { readFile, writeFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { compileTaxonomy, classifyIncident } from './lib.mjs';

const here = (f) => new URL(f, import.meta.url);
const readJson = async (f, fallback) => { try { return JSON.parse(await readFile(here(f), 'utf8')); } catch { return fallback; } };
const UA = 'AIIncidentObservatory/2.1 (licensed computational analysis; github.com/KimAbercromby/AIIncidentObservatory)';
const PAUSE_MS = 1000;
const MAX_DOCS_PER_RUN = 300;
const MAX_PAGES_PER_QUERY = 12;

// Words that show the judgment itself discusses AI (bare "algorithm" is too common in judgments to count).
export const AI_GATE = [
  ['artificial intelligence', /artificial intelligence/i], ['generative AI', /\bgenerative AI\b/i], ['ChatGPT', /\bChatGPT\b/i],
  ['large language model', /\blarge language models?\b/i], ['machine learning', /\bmachine learning\b/i], ['facial recognition', /\bfacial recognition\b/i],
  ['automated decision', /\bautomated decision/i], ['algorithmic', /\balgorithmic\b/i], ['AI tool or output', /\bAI[- ](generated|tools?|systems?|models?|chatbots?)\b/i],
];

export function licenceAllows(src) {
  return Boolean(src?.licence?.granted && typeof src.licence.reference === 'string' && src.licence.reference.trim());
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: false, isArray: (name) => ['entry', 'link', 'tna:identifier'].includes(name) });

export function parseFeed(xml) {
  const feed = parser.parse(xml).feed || {};
  const links = feed.link || [];
  const next = links.find((l) => l['@rel'] === 'next')?.['@href'] || null;
  const entries = (feed.entry || []).map((e) => {
    const ls = e.link || [];
    const ids = e['tna:identifier'] || [];
    const idText = (t) => { const x = ids.find((i) => i['@type'] === t); return x ? (x['#text'] ?? '').toString() : null; };
    return {
      uri: (e['tna:uri'] ?? '').toString(),
      fclid: idText('fclid'),
      citation: idText('ukncn'),
      title: (e.title ?? '').toString().trim(),
      court: (e.author?.name ?? '').toString(),
      published: (e.published ?? '').toString().slice(0, 10) || null,
      updated: (e.updated ?? '').toString(),
      url: ls.find((l) => l['@rel'] === 'alternate' && !l['@type'])?.['@href'] || null,
      xml_url: ls.find((l) => l['@type'] === 'application/akn+xml')?.['@href'] || null,
      contenthash: (e['tna:contenthash'] ?? '').toString(),
    };
  }).filter((e) => e.uri && e.url);
  return { entries, next };
}

// Strip markup to plain text. Used only in memory for classification; never written to disk.
export function bodyText(xml) {
  return xml.replace(/<header[\s\S]*?<\/header>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Only the passages around AI mentions are used to classify, so an unrelated part of a long judgment cannot trigger a mode.
export function aiPassages(text, width = 600) {
  const out = [];
  for (const [, re] of AI_GATE) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(text)) !== null && out.length < 12) out.push(text.slice(Math.max(0, m.index - width), m.index + width));
  }
  return out;
}

export function classifyJudgment(entry, text, ctax) {
  const passages = aiPassages(text);
  if (!passages.length) return null; // fails the AI gate
  const c = classifyIncident({ title: entry.title, description: passages.join(' \n '), deployer: entry.title }, ctax);
  const terms = AI_GATE.filter(([, re]) => re.test(text)).map(([label]) => label);
  return {
    modes: c.modes.map((m) => ({ id: m.id, basis: ['text'] })),
    remediation_indicated: c.remediation_indicated,
    public_sector: c.public_sector,
    public_sector_basis: c.public_sector ? 'party name in case title' : 'no public-sector party in title',
    determination: 'determined',
    ai_terms: terms,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  await sleep(PAUSE_MS);
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (res.status === 429) throw new Error('HTTP 429 from Find Case Law: rate limit reached. Stopping this run.');
  return res;
}

async function main() {
  const { sources } = await readJson('sources.json');
  const src = sources.find((s) => s.id === 'find-case-law');
  if (!licenceAllows(src)) {
    console.log('judgments: skipped. No computational analysis licence recorded in sources.json, so Find Case Law is not read.');
    return;
  }
  const ctax = compileTaxonomy(await readJson('taxonomy.json'));
  const store = await readJson('judgments.json', { judgments: [], gated_out: [] });
  const byUri = new Map(store.judgments.map((j) => [j.uri, j]));
  const gatedOut = new Set(store.gated_out || []);
  let fetched = 0; let added = 0; let changed = 0; let removed = 0;

  // Monthly re-check (first week of the month): drop anything the National Archives no longer publishes.
  if (new Date().getUTCDate() <= 7) {
    for (const j of [...byUri.values()]) {
      const res = await get(j.xml_url || j.url);
      if (res.status === 404 || res.status === 410) { byUri.delete(j.uri); removed++; }
    }
  }

  outer: for (const q of src.queries) {
    let url = `${src.feed}?query=${encodeURIComponent(q)}&order=-updated&per_page=50`;
    for (let page = 0; url && page < MAX_PAGES_PER_QUERY; page++) {
      const { entries, next } = parseFeed(await (await get(url)).text());
      let anyNew = false;
      for (const e of entries) {
        const known = byUri.get(e.uri);
        if ((known && known.contenthash === e.contenthash) || gatedOut.has(`${e.uri}:${e.contenthash}`)) {
          if (known && !known.matched_queries.includes(q)) known.matched_queries.push(q);
          continue;
        }
        anyNew = true;
        if (fetched >= MAX_DOCS_PER_RUN) break outer;
        const res = await get(e.xml_url);
        fetched++;
        if (!res.ok) continue;
        const cls = classifyJudgment(e, bodyText(await res.text()), ctax);
        if (!cls) { gatedOut.add(`${e.uri}:${e.contenthash}`); continue; }
        const { xml_url, ...meta } = e;
        byUri.set(e.uri, { ...meta, xml_url, matched_queries: [q], first_seen: known?.first_seen || new Date().toISOString().slice(0, 10), classification: cls });
        known ? changed++ : added++;
      }
      if (!anyNew) break; // ordered by last update: once a page holds nothing new, the rest is already held
      url = next;
    }
  }

  const judgments = [...byUri.values()].sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  await writeFile(here('judgments.json'), JSON.stringify({
    source: 'Find Case Law, The National Archives. ' + src.attribution,
    licence_reference: src.licence.reference,
    note: 'No judgment text is held here. Follow each link for the authoritative, current version.',
    judgments,
    gated_out: [...gatedOut].slice(-5000),
  }, null, 2) + '\n');
  console.log(`judgments: ${judgments.length} held (${added} new, ${changed} updated, ${removed} withdrawn); ${fetched} documents read this run.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`JUDGMENTS FAILED: ${e.message}`); process.exit(1); });
