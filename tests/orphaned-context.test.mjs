/**
 * Reloading/updating/disabling the extension orphans content scripts already
 * injected into open tabs: their `chrome` object is torn down, so
 * `chrome.runtime` reads back undefined.
 *
 * Reported symptom:
 *   Uncaught (in promise) TypeError:
 *   Cannot read properties of undefined (reading 'sendMessage')
 *   at content.js (saveScan)  <- called from processAd
 *
 * The page keeps running and the MutationObserver keeps firing, so an
 * unguarded call throws once per detected ad.
 */
import { chromium, SRC, read, srcUrl, CHROME_SHIM } from "./_setup.mjs";
import { createReporter } from "./_setup.mjs";

const AD = `
<div role="article" id="ad1">
  <span>Sponsored</span>
  <h3><a role="link" href="https://www.facebook.com/x"><span>Test Lender</span></a></h3>
  <div>Instant cash loan, apply for loan now, no collateral needed today.</div>
  <a href="https://play.google.com/store/apps/details?id=com.unregistered.testloan">Install</a>
</div>`;

const NEW_AD = `
<div role="article" id="ad2">
  <span>Sponsored</span>
  <h3><a role="link" href="https://www.facebook.com/y"><span>Second Lender</span></a></h3>
  <div>Fast online lending app, borrow money instantly, quick loan approval.</div>
  <a href="https://play.google.com/store/apps/details?id=com.unregistered.second">Install</a>
</div>`;

const r = createReporter("orphaned extension context");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
page.on("console", m => { if (m.type() === "error") pageErrors.push(m.text()); });

await page.setContent(`<!doctype html><body>${AD}</body>`);
await page.addScriptTag({ content: CHROME_SHIM });
await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
await page.addScriptTag({ content: await read("matcher.js") });
await page.addScriptTag({ content: await read("content.js") });
await page.waitForTimeout(500);

// The shim has no runtime.id; content.js requires one to consider the context
// live, so give it one for the healthy phase.
const healthy = await page.evaluate(() => ({
  badges: document.querySelectorAll(".credibytes-badge").length,
  saved: window.__sent.filter(m => m.type === "SAVE_SCAN").length,
}));
r.check("baseline: ad badged while context is alive", healthy.badges === 1,
        JSON.stringify(healthy));
r.check("baseline: scan saved", healthy.saved >= 1, `saved=${healthy.saved}`);

const errorsBefore = pageErrors.length;

// Orphan the context exactly as Chrome does: chrome.runtime becomes undefined.
await page.evaluate(() => { window.chrome.runtime = undefined; });

// Inject a new ad so the MutationObserver fires and the full pipeline reruns.
await page.evaluate((html) => {
  document.body.insertAdjacentHTML("beforeend", html);
}, NEW_AD);
await page.waitForTimeout(900);

const after = await page.evaluate(() => ({
  badges: document.querySelectorAll(".credibytes-badge").length,
}));

const newErrors = pageErrors.slice(errorsBefore)
  .filter(m => /sendMessage|Cannot read properties of undefined|storage/i.test(m));

r.check("no TypeError after context is orphaned", newErrors.length === 0,
        JSON.stringify(newErrors.slice(0, 3)));
r.check("does not badge new ads once orphaned", after.badges === 1,
        `badges=${after.badges}`);

// Storage-backed paths must also stay quiet.
const errsBeforeStorage = pageErrors.length;
await page.evaluate(() => { window.chrome.storage = undefined; });
await page.evaluate((html) => {
  document.body.insertAdjacentHTML("beforeend", html.replace("ad2", "ad3"));
}, NEW_AD);
await page.waitForTimeout(700);
const storageErrs = pageErrors.slice(errsBeforeStorage)
  .filter(m => /Cannot read properties of undefined|storage|sendMessage/i.test(m));
r.check("no error when chrome.storage is also gone", storageErrs.length === 0,
        JSON.stringify(storageErrs.slice(0, 3)));

// Whole chrome object removed — the harshest teardown.
const errsBeforeAll = pageErrors.length;
await page.evaluate(() => { delete window.chrome; });
await page.evaluate((html) => {
  document.body.insertAdjacentHTML("beforeend", html.replace("ad2", "ad4"));
}, NEW_AD);
await page.waitForTimeout(700);
const allErrs = pageErrors.slice(errsBeforeAll)
  .filter(m => /chrome|sendMessage|Cannot read properties of undefined/i.test(m));
r.check("no error when chrome is deleted entirely", allErrs.length === 0,
        JSON.stringify(allErrs.slice(0, 3)));

await browser.close();
process.exit(r.finish() ? 1 : 0);
