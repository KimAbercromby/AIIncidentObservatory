// Pure functions shared by collect, classify and analyse. No network, no file system.

export const REQUIRED_HEADERS = ['Incident ID', 'date', 'title', 'description'];
export const DETERMINATION_ORDER = ['alleged', 'acknowledged', 'determined'];

// ---------- discovery ----------

// Find the newest AIID_Excel_Export-YYYYMMDD.xlsx link on the listing page,
// accepting only the pinned download host.
export function findLatestExport(html, pinnedHost) {
  const re = /https:\/\/([a-z0-9.-]+)\/AIID_Excel_Export-(\d{8})\.xlsx/g;
  const found = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const [url, host, ymd] = m;
    if (host !== pinnedHost) continue;
    found.set(ymd, url);
  }
  if (found.size === 0) return null;
  const latest = [...found.keys()].sort().at(-1);
  return { url: found.get(latest), export_date: `${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6, 8)}`, file: `AIID_Excel_Export-${latest}.xlsx` };
}

// Refuse any URL whose host is not the pinned one (protects against a changed or hostile link).
export function assertPinnedHost(url, pinnedHost) {
  const host = new URL(url).host;
  if (host !== pinnedHost) throw new Error(`Refusing download from ${host}; only ${pinnedHost} is allowed. If AIID has moved its exports, verify the new host and update sources.json.`);
}

// ---------- parsing ----------

export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return cellText(v.result);
    if ('hyperlink' in v && 'text' in v) return String(v.text);
  }
  return String(v).trim();
}

export function normDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const y = String(s).match(/^(\d{4})$/);
  return y ? `${y[1]}-01-01` : null;
}

// rows: array of arrays of cell values (already converted to text). Finds the header row by name.
export function rowsToIncidents(rows) {
  const headerIdx = rows.slice(0, 15).findIndex((r) => r.some((c) => c === 'Incident ID'));
  if (headerIdx === -1) throw new Error('Incidents sheet: no header row containing "Incident ID" in the first 15 rows. The export layout has changed.');
  const headers = rows[headerIdx];
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`Incidents sheet: required columns missing: ${missing.join(', ')}. The export layout has changed.`);
  const col = (name) => headers.indexOf(name);
  const get = (r, name) => (col(name) === -1 ? '' : (r[col(name)] ?? '').toString().trim());
  const out = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const id = get(r, 'Incident ID');
    if (!/^\d+$/.test(id)) continue;
    out.push({
      id: Number(id),
      date: normDate(get(r, 'date')),
      title: get(r, 'title'),
      description: get(r, 'description'),
      deployer: get(r, 'deployer'),
      developer: get(r, 'developer'),
      harmed: get(r, 'harmed'),
      editor_notes: get(r, 'Editor Notes'),
      mit_domain: get(r, 'Risk Domain'),
      mit_subdomain: get(r, 'Risk Subdomain'),
      public_sector_field: get(r, 'Public Sector Deployment'),
      sector: get(r, 'Sector of Deployment'),
      country: get(r, 'Country Code'),
      report_count: Number(get(r, 'report_count')) || null,
      url: `https://incidentdatabase.ai/cite/${id}/`,
    });
  }
  return out;
}

// ---------- classification ----------

function cue(src) {
  return new RegExp(`(^|[^a-z0-9])(${src})($|[^a-z0-9])`, 'i');
}

export function compileTaxonomy(tax) {
  return {
    ...tax,
    _modes: tax.failure_modes.map((m) => ({ ...m, _text: m.text_cues.map(cue), _mit: m.mit_cues.map((c) => c.toLowerCase()) })),
    _rem: tax.remediation_types.map((r) => ({ ...r, _text: r.text_cues.map(cue) })),
    _public: tax.public_sector_cues.map(cue),
  };
}

export function isPublicSector(inc, ctax) {
  const f = (inc.public_sector_field || '').toLowerCase();
  if (['yes', 'true'].includes(f)) return { value: true, basis: 'AIID editors (CSET: Public Sector Deployment)' };
  if (['no', 'false'].includes(f)) return { value: false, basis: 'AIID editors (CSET: Public Sector Deployment)' };
  const deployer = (inc.deployer || '').replace(/[-_]+/g, ' ');
  if (ctax._public.some((re) => re.test(deployer))) return { value: true, basis: 'deployer name' };
  return { value: false, basis: 'no public-sector signal' };
}

// Deterministic classification. MIT subdomain tags come from AIID editors; text cues are ours.
export function classifyIncident(inc, ctax) {
  const text = [inc.title, inc.description, inc.editor_notes].filter(Boolean).join(' \n ');
  const mit = (inc.mit_subdomain || '').toLowerCase();
  const modes = [];
  for (const m of ctax._modes) {
    const basis = [];
    if (mit && m._mit.some((c) => mit.includes(c))) basis.push('mit');
    if (m._text.some((re) => re.test(text))) basis.push('text');
    if (basis.length) modes.push({ id: m.id, basis });
  }
  const remediation = ctax._rem.filter((r) => r._text.some((re) => re.test(text))).map((r) => r.id);
  const ps = isPublicSector(inc, ctax);
  return {
    modes,
    remediation_indicated: remediation,
    public_sector: ps.value,
    public_sector_basis: ps.basis,
    determination: 'alleged',
  };
}

// ---------- constrained LLM output ----------

// Accept only taxonomy ids; the model may lower a determination, never raise it.
export function sanitiseLlm(raw, currentDetermination, tax) {
  const modeIds = new Set(tax.failure_modes.map((m) => m.id));
  const remIds = new Set(tax.remediation_types.map((r) => r.id));
  const discarded = [];
  const keep = (arr, ids) => (Array.isArray(arr) ? arr : []).filter((x) => {
    const ok = typeof x === 'string' && ids.has(x);
    if (!ok) discarded.push(String(x));
    return ok;
  });
  const modes = [...new Set(keep(raw?.failure_modes, modeIds))];
  const remediation = [...new Set(keep(raw?.remediation, remIds))];
  let determination = currentDetermination;
  const proposed = raw?.determination;
  if (DETERMINATION_ORDER.includes(proposed) && DETERMINATION_ORDER.indexOf(proposed) < DETERMINATION_ORDER.indexOf(currentDetermination)) determination = proposed;
  return { modes, remediation, determination, discarded };
}

// ---------- analysis ----------

export function analyse(incidents, cases, tax, opts = {}) {
  const sinceYear = opts.sinceYear ?? null;
  const judgments = opts.judgments || [];
  const pool = sinceYear ? incidents.filter((i) => i.date && Number(i.date.slice(0, 4)) >= sinceYear) : incidents;
  const modeCounts = new Map(tax.failure_modes.map((m) => [m.id, { global: 0, public: 0, cases: 0, court: 0, by_basis: { mit: 0, text: 0, llm: 0 } }]));
  let unclassified = 0;
  let unclassifiedPublic = 0;
  for (const inc of pool) {
    const c = inc.classification;
    const ids = new Set(c.modes.map((m) => m.id));
    for (const l of c.llm_modes || []) ids.add(l);
    if (ids.size === 0) { unclassified++; if (c.public_sector) unclassifiedPublic++; }
    for (const id of ids) {
      const e = modeCounts.get(id);
      e.global++;
      if (c.public_sector) e.public++;
      const m = c.modes.find((x) => x.id === id);
      if (m) for (const b of m.basis) e.by_basis[b]++;
      else e.by_basis.llm++;
    }
  }
  for (const cs of cases) for (const id of cs.failure_modes) if (modeCounts.has(id)) modeCounts.get(id).cases++;
  for (const j of judgments) for (const m of j.classification.modes) if (modeCounts.has(m.id)) modeCounts.get(m.id).court++;

  const modes = tax.failure_modes.map((m) => ({
    id: m.id,
    label: m.label,
    coverage: m.coverage,
    coverage_note: m.coverage_note,
    sections: m.sections,
    artefacts: m.artefacts,
    was_gap_in: m.was_gap_in || null,
    new_in: m.new_in || null,
    ...modeCounts.get(m.id),
  })).sort((a, b) => b.public - a.public || b.global - a.global);

  const observed = (m) => m.global + m.cases + m.court > 0;
  const gap_list = modes.filter((m) => m.coverage !== 'mapped' && observed(m));
  const unobserved_gaps = modes.filter((m) => m.coverage !== 'mapped' && !observed(m)).map((m) => m.id);
  const unexercised_controls = modes.filter((m) => m.coverage === 'mapped' && !observed(m)).map((m) => m.id);
  const closed_since_july = modes.filter((m) => m.was_gap_in).map((m) => m.id);

  const remCounts = Object.fromEntries(tax.remediation_types.map((r) => [r.id, { indicated: 0, documented: 0 }]));
  let noRem = 0;
  let noRemPublic = 0;
  let publicTotal = 0;
  for (const inc of pool) {
    const c = inc.classification;
    const r = new Set([...(c.remediation_indicated || []), ...(c.llm_remediation || [])]);
    if (c.public_sector) publicTotal++;
    if (r.size === 0) { noRem++; if (c.public_sector) noRemPublic++; }
    for (const id of r) remCounts[id].indicated++;
  }
  for (const cs of cases) for (const r of cs.remediation) if (remCounts[r.type]) remCounts[r.type].documented++;

  const determinations = { alleged: 0, acknowledged: 0, determined: 0 };
  for (const inc of pool) determinations[inc.classification.determination]++;
  for (const cs of cases) determinations[cs.determination.level]++;

  return {
    totals: {
      incidents: pool.length,
      public_sector: publicTotal,
      cases: cases.length,
      judgments: judgments.length,
      judgments_public: judgments.filter((j) => j.classification.public_sector).length,
      unclassified,
      unclassified_public: unclassifiedPublic,
    },
    modes,
    gap_list,
    unobserved_gaps,
    unexercised_controls,
    closed_since_july,
    remediation: {
      none_indicated: noRem,
      none_indicated_public: noRemPublic,
      none_indicated_share: pool.length ? Math.round((noRem / pool.length) * 1000) / 10 : null,
      none_indicated_public_share: publicTotal ? Math.round((noRemPublic / publicTotal) * 1000) / 10 : null,
      by_type: tax.remediation_types.map((r) => ({ id: r.id, label: r.label, ...remCounts[r.id] })),
    },
    determinations,
  };
}

export function coverageStatement(sources) {
  const inn = sources.filter((s) => s.collected).map((s) => s.name);
  const out = sources.filter((s) => !s.collected).map((s) => `${s.name} (${s.status})`);
  return {
    collected: inn,
    not_collected: out,
    statement: `This observatory reads ${inn.join(' and ')}. It does not read ${out.join('; ')}. Counts describe what these sources recorded, not how often failures happen in the world. Media-sourced incidents are allegations unless an authority made a finding.`,
  };
}
