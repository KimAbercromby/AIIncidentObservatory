// ONE-OFF probe: opens the DAIL site once in a headless browser and records which data
// requests the page makes, so we can judge whether a stable, polite way to read it exists.
// It does not page through or download the database. Output: dail-probe.json
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const START = 'https://etidail.com/';
const out = { probed_at: new Date().toISOString(), start: START, requests: [], links: [], robots: null, errors: [] };
const browser = await chromium.launch();
const page = await browser.newPage({ userAgent: 'AIIncidentObservatory-probe/1.0 (one-off; github.com/KimAbercromby/AIIncidentObservatory)' });
page.on('response', async (res) => {
  const req = res.request();
  if (!['xhr', 'fetch', 'document', 'script'].includes(req.resourceType())) return;
  const entry = { type: req.resourceType(), method: req.method(), url: res.url(), status: res.status(), content_type: res.headers()['content-type'] || '' };
  if (req.method() === 'POST') entry.post_body = (req.postData() || '').slice(0, 600);
  if (/json|csv|text\/plain/.test(entry.content_type)) {
    try { entry.sample = (await res.text()).slice(0, 1500); } catch (e) { entry.sample_error = e.message; }
  }
  out.requests.push(entry);
});
try {
  await page.goto(START, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);
  out.title = await page.title();
  out.visible_text = (await page.innerText('body')).slice(0, 3000);
  out.links = await page.$$eval('a[href]', (as) => as.map((a) => ({ text: a.innerText.trim().slice(0, 80), href: a.href })).slice(0, 120));
} catch (e) { out.errors.push(e.message); }
try { const r = await page.goto('https://etidail.com/robots.txt', { timeout: 20000 }); out.robots = { status: r.status(), body: (await r.text()).slice(0, 2000) }; } catch (e) { out.errors.push('robots: ' + e.message); }
await browser.close();
await writeFile('dail-probe.json', JSON.stringify(out, null, 2) + '\n');
console.log(`probe: ${out.requests.length} requests recorded, ${out.errors.length} errors`);
