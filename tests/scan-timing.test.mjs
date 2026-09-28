/**
 * How long an ad waits for its badge.
 *
 * On one account ads took ~30 s to be badged with the backend awake. The scan
 * waited for the page to be quiet for 300 ms and restarted that wait on every
 * change, so on a page that never settles it never ran: measured, a page
 * changing every 200 ms produced no badge within 12 s. The badge also waited
 * on Stage 1, which it does not display — up to 2.5 s when the backend slept.
 */
import { chromium, read, createReporter, CHROME_SHIM } from "./_setup.mjs";

const r = createReporter("Scan timing");
const browser = await chromium.launch({ headless: true });

const AD = `<article><div><a role="link" href="https://www.facebook.com/KvikuPH"><strong><span>Kviku Philippines</span></strong></a>
  <a aria-label="Sponsored" href="/ads/about/?x" role="link"><span>Sponsored</span></a></div>
  <div>Cash loan up to PHP 25,000, no collateral. Apply now!</div>
  <a href="https://l.facebook.com/l.php?u=${encodeURIComponent("https://kvikuloan.ph/apply")}">Apply now</a></article>`;

// cold: PREDICT never answers, as with a sleeping Render instance.
// noiseMs: the page changes this often, as a feed with video does.
async function timeToBadge({ cold = false, noiseMs = 0 }) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body><div role="feed" id="feed"></div><div id="noise"></div></body>`);
  const shim = cold
    ? CHROME_SHIM.replace("cb && cb({ ok: true, prediction: null });",
                          "if (msg.type !== 'PREDICT') cb && cb({ ok: true, prediction: null });")
    : CHROME_SHIM;
  await page.addScriptTag({ content: shim });
  for (const f of ["i18n.js", "verdict-view.js", "sec_reference.js", "revoked_reference.js",
                   "stage1_model.js", "matcher.js", "stage1.js", "content.js"]) {
    await page.addScriptTag({ content: await read(f) });
  }
  await page.waitForTimeout(500);
  const ms = await page.evaluate(({ AD, noiseMs }) => new Promise((done) => {
    if (noiseMs) setInterval(() =>
      document.getElementById("noise").appendChild(document.createElement("i")), noiseMs);
    const t0 = performance.now();
    document.getElementById("feed").insertAdjacentHTML("beforeend", AD);
    const iv = setInterval(() => {
      const waited = performance.now() - t0;
      if (document.querySelector(".credibytes-badge") || waited > 8000) {
        clearInterval(iv);
        done(document.querySelector(".credibytes-badge") ? Math.round(waited) : null);
      }
    }, 10);
  }), { AD, noiseMs });
  // Past BACKEND_WAIT_MS, so the scan has been stored with whatever Stage 1 gave.
  await page.waitForTimeout(3000);
  const saved = await page.evaluate(() =>
    window.__sent.filter(m => m.type === "SAVE_SCAN").map(m => m.payload));
  await page.close();
  return { ms, saved };
}

{
  const m = await timeToBadge({ noiseMs: 200 });
  r.check("a page that never settles still gets its badge within about a second",
          m.ms !== null && m.ms < 1600, `badge after ${m.ms ?? "never (8 s cap)"} ms`);
}
{
  const m = await timeToBadge({ cold: true });
  r.check("a sleeping backend does not hold the badge back",
          m.ms !== null && m.ms < 1200, `badge after ${m.ms ?? "never"} ms`);
  r.check("the scan is still stored once, with the local model's Stage 1 score",
          m.saved.length === 1 && typeof m.saved[0].prob === "number",
          `saved=${m.saved.length} prob=${m.saved[0]?.prob}`);
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
