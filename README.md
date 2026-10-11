# AI Incident Observatory

> **What this is.** A weekly pattern library of AI incidents reported around the world, showing what was done afterwards and where the AI Governance Suite has no control that would have caught the failure first. It is **not** a measure of how often AI fails. It counts what its sources recorded. Every media-sourced incident is an **allegation** unless a court, regulator or ombudsman made a finding.

This tool is separate from the [regulatory horizon scanner](https://github.com/KimAbercromby/AIRegScanner) by design. The scanner's value rests on reading authoritative publishers only, and mixing journalism into it would undermine that. This tool reads journalism-derived data and handles it with different rules.

## The rules this tool follows

- **Allegation by default.** There are three determination levels: *alleged*, *acknowledged* (the deployer admitted the failure or withdrew the system) and *determined* (a court, regulator or ombudsman made a finding). Nothing is raised above what a source states.
- **Classification shows its basis.** Each matched failure mode records *why* it matched: `mit` (the AIID editors' MIT risk tag), `text` (a phrase in the incident's own description) or `llm` (an optional machine suggestion, shown as a dashed chip).
- **No remediation recorded counts as a finding.** Incident databases index harms. Almost nothing indexes what was done afterwards, so the biggest category is expected to be "none recorded". That is a gap in the discipline.
- **Coverage is stated on the page.** The masthead says which sources are read and which are not.
- **Every run is logged**, including runs that find nothing new. The weekly commit is also what stops GitHub from switching the schedule off after 60 days without activity.

## Files

| File | What it does |
| --- | --- |
| `taxonomy.json` | **The intellectual core.** 21 failure modes and 11 remediation types. Each failure mode is mapped to the Playbook sections and AIG-xx artefacts that would have caught it, with a coverage status of `mapped`, `partial` or `unmapped`. |
| `cases.json` | Curated public-sector cases with a determination level and sources. Edited by hand. |
| `sources.json` | Source register: what is read, what is not, and why. |
| `collect.mjs` | Finds the newest AIID weekly Excel export, downloads it from the one allowed host, parses it and classifies each incident. |
| `llm.mjs` | Optional. Runs only if an `ANTHROPIC_API_KEY` secret exists. It suggests modes for public-sector incidents, may use only taxonomy ids, and may lower a determination but never raise one. |
| `analyse.mjs` | Builds `gaps.json` (the gap analysis) and `coverage.json`, and appends to `run-log.json`. |
| `lib.mjs` | Shared logic (pure functions, fully tested). |
| `index.html` | The viewer, served by GitHub Pages. |
| `observatory.test.mjs` | 16 tests. They run before every collection. |
| `.github/workflows/observatory.yml` | Runs weekly (Tuesdays 06:17 UTC) and on demand. |

## Taxonomy 2.0: what changed since July 2026

The July taxonomy left five failure modes deliberately unmapped so the gap analysis would have teeth. Re-checked against the 52-artefact suite (v3.9.9, 11 October 2026):

| Failure mode | July | Now | Why |
| --- | --- | --- | --- |
| Supplier changed the model underneath | unmapped | **mapped** | Escalation trigger (minimum High) for material model change; the Supplier DDQ asks how changes are notified (Q7.1); the Model Card keeps a change history. *Residual risk:* detection relies on the supplier telling the council. |
| Reused for a purpose nobody assessed | unmapped | **mapped** | UC-ID per materially distinct use; approval covers only the scope decided; SoA A.9.4 requires scope-creep detection. |
| No route to challenge or redress | unmapped | **mapped** | AIG-OPS-04 Contestability and Redress Control. |
| Deskilling and lost fallback | unmapped | **partial** | §4.3.13 names degraded manual fallback as a risk, but nothing measures whether staff can still do the work unaided. |
| Cumulative harm to the same people | unmapped | **partial** | §4.5.8 portfolio view tracks council-side concentration risk, not the combined burden on the same residents. |
| AI used to monitor or manage staff | (not in July) | **unmapped** | New. No artefact addresses AI used on council staff as employees. |

Controls are design-stage. A mapping says a control exists on paper, not that it works.

## Sources

| Source | Status | Notes |
| --- | --- | --- |
| AI Incident Database, weekly Excel export | form-verified, **collected** | The July design used AIID's GraphQL API, which **now requires a logged-in account**. The project points bulk users to this export instead. The workbook layout was taken from AIID's own export pipeline. The parser finds the header row by name and fails loudly if the layout changes. |
| Curated cases (`cases.json`) | verified, **collected** | Every fact is sourced. |
| OECD AI Incidents Monitor | **excluded** | No API or bulk download, and its terms do not grant reuse of the underlying news material. Read it by hand. |
| AIAAIC Repository | unverified | No documented download or licence found. Ask AIAAIC before connecting it. |
| Database of AI Litigation (GWU) | unverified | Most valuable missing source, because litigation records carry remediation. Needs its own fetcher. |
| ICO enforcement | covered elsewhere | Results load in the browser and the ICO has withdrawn its RSS feeds. Regulator output belongs in the regulatory scanner. |

## Safeguards

- **Pinned download host.** Only `pub-72b2b2fc36ec423189843747af98f80e.r2.dev` is accepted. If AIID moves its exports, the run fails and asks you to verify the new host.
- **Collapse detection.** A run that parses fewer than 100 incidents, or less than half the previous count, fails without overwriting the data.
- **First run baselines.** The first collection records everything as existing, so "new incidents" only means new since the observatory started.
- **No sample data ships.** Until the first collection runs, the page shows the curated cases and the suite mapping only.

## Adding a curated case

Add an entry to `cases.json` following the existing ones. Every fact needs a `sources` link. Set `determination.level` to the highest level actually reached. Commit the change; the next run includes it, or run the workflow by hand.

## Licence

Incident data comes from the [AI Incident Database](https://incidentdatabase.ai/) (Responsible AI Collaborative), licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Report text is not collected because it is not covered by that licence. The derived data in this repository (`incidents.json`, `gaps.json`) is shared under CC BY-SA 4.0.

## Re-applying the taxonomy without downloading

After editing `taxonomy.json`, run `node collect.mjs --reclassify && node analyse.mjs` to re-classify the incidents already held. The weekly run also re-applies the current taxonomy every time.

**Taxonomy 2.1 (11 Oct 2026).** The first real collection showed that the MIT risk tags nearest to three gaps meant something else: "devaluation of human effort" covers creative and copyright cases, "power centralisation" covers market competition, and "employment quality" covers labour markets generally. Those tags no longer count for deskilling, cumulative harm or staff monitoring; only specific wording does. Every incident behind those three gaps was checked by hand.
