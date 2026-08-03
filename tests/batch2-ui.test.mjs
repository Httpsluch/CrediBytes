/**
 * Batch 2 features.
 *
 *  1. Stat tiles filter the feed. Single-select: clicking a tile shows only
 *     that result, clicking another switches, clicking the active one clears.
 *     Totals keep counting everything regardless of the filter.
 *  2. Three-way theme (light / dark / system) that persists and is applied
 *     before first paint.
 */
import { chromium, SRC, srcUrl, createReporter } from "./_setup.mjs";

const r = createReporter("batch 2 — filters and theme");
const browser = await chromium.launch({ headless: true });

const SCANS = [
  { ts: Date.now(),      tier: "legitimate", legitimacy: "legitimate",      status: "exact_play_store_package_match", label: "SEC Verified",      reason: "x", advertiserName: "Verified Co" },
  { ts: Date.now() - 1e3, tier: "danger",     legitimacy: "unverified",      status: "no_reference_match", isStoreUrl: true, label: "Unregistered App", reason: "x", advertiserName: "Undeclared App" },
  { ts: Date.now() - 2e3, tier: "unverified", legitimacy: "unverified",      status: "no_reference_match", isStoreUrl: false, label: "Unverified",     reason: "x", advertiserName: "Unknown Co" },
  { ts: Date.now() - 3e3, tier: "namematch",  legitimacy: "name_match_only", status: "name_match_only", label: "Name Match Only", reason: "x", advertiserName: "Spoof Co" },
  { ts: Date.now() - 4e3, tier: "legitimate", legitimacy: "legitimate",      status: "same_domain_match", label: "SEC Verified",   reason: "x", advertiserName: "Verified Two" },
];
const TOTALS = { legitimate: 40, likely: 0, namematch: 1, unverified: 9, danger: 3 };

function shim(settings = {}) {
  return `window.chrome={storage:{local:{
      get:(k,cb)=>cb({scans:${JSON.stringify(SCANS)},totals:${JSON.stringify(TOTALS)},settings:${JSON.stringify(settings)}}),
      set:(o,cb)=>{window.__set=Object.assign(window.__set||{},o);cb&&cb();}},
    onChanged:{addListener(){}}},
    runtime:{id:"t",sendMessage:(m,cb)=>cb&&cb({ok:true})},
    tabs:{query:(q,cb)=>cb([])},
    sidePanel:{open(){},setOptions(){return Promise.resolve();}}};`;
}

async function open(settings) {
  const page = await browser.newPage({ viewport: { width: 360, height: 620 } });
  // popup.html loads popup.js itself; stub it so the real script runs once,
  // AFTER the chrome shim exists.
  await page.route("**/popup.js", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(srcUrl("popup.html"));
  await page.addScriptTag({ content: shim(settings) });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(250);
  return page;
}

const visible = (page) => page.$$eval(".scan-item",
  els => els.map(e => e.className.replace("scan-item ", "")));

// ── Filters ────────────────────────────────────────────────────────────────
{
  const page = await open();

  r.check("all 5 scans shown initially", (await visible(page)).length === 5, "");
  r.check("tiles show cumulative totals, not the feed",
          await page.textContent("#count-legit") === "40",
          await page.textContent("#count-legit"));

  await page.click('.stat[data-filter="verified"]');
  let v = await visible(page);
  r.check("verified filter shows only verified",
          v.length === 2 && v.every(c => c === "legitimate"), JSON.stringify(v));
  r.check("active tile marked aria-pressed",
          await page.getAttribute('.stat[data-filter="verified"]', "aria-pressed") === "true", "");
  r.check("totals unchanged while filtered",
          await page.textContent("#count-legit") === "40", "");

  // Clicking a different tile switches rather than adding.
  await page.click('.stat[data-filter="unregistered"]');
  v = await visible(page);
  r.check("switching filter replaces the previous one",
          v.length === 1 && v[0] === "danger", JSON.stringify(v));
  r.check("previous tile is released",
          await page.getAttribute('.stat[data-filter="verified"]', "aria-pressed") === "false", "");

  // Unverified groups likely + namematch, matching how the tile counts.
  await page.click('.stat[data-filter="unverified"]');
  v = await visible(page);
  r.check("unverified groups namematch with unverified",
          v.length === 2 && v.includes("unverified") && v.includes("namematch"),
          JSON.stringify(v));

  // Clicking the active tile clears.
  await page.click('.stat[data-filter="unverified"]');
  r.check("clicking the active tile clears the filter",
          (await visible(page)).length === 5, "");
  r.check("no tile left pressed",
          (await page.$$eval('.stat[aria-pressed="true"]', e => e.length)) === 0, "");
  await page.close();
}

// A filter matching nothing must not look like scanning stopped.
{
  const page = await browser.newPage({ viewport: { width: 360, height: 620 } });
  // popup.html loads popup.js itself; stub it so the real script runs once,
  // AFTER the chrome shim exists.
  await page.route("**/popup.js", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(srcUrl("popup.html"));
  await page.addScriptTag({ content: `window.chrome={storage:{local:{
      get:(k,cb)=>cb({scans:[${JSON.stringify(SCANS[0])}],totals:${JSON.stringify(TOTALS)},settings:{}}),
      set:(o,cb)=>cb&&cb()},onChanged:{addListener(){}}},
      runtime:{id:"t",sendMessage:(m,cb)=>cb&&cb({ok:true})},
      tabs:{query:(q,cb)=>cb([])},sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(200);
  await page.click('.stat[data-filter="unregistered"]');
  r.check("empty filter shows its own message, not the no-scans state",
          (await page.$$eval(".filter-empty", e => e.length)) === 1 &&
          (await page.$eval("#empty-state", e => getComputedStyle(e).display)) === "none",
          "");
  await page.close();
}

// ── Theme ──────────────────────────────────────────────────────────────────
{
  const page = await open();
  await page.click('.tab[data-tab="settings"]');   // Settings panel is hidden until selected
  const attr = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const bg   = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  r.check("defaults to system (no override attribute)", (await attr()) === null, String(await attr()));
  r.check("system tile marked checked",
          await page.getAttribute('.seg-btn[data-theme="system"]', "aria-checked") === "true", "");

  await page.click('.seg-btn[data-theme="dark"]');
  const darkBg = await bg();
  r.check("dark sets the override", (await attr()) === "dark", String(await attr()));
  // Pinning an exact hex made this fail on every restyle while testing nothing
  // about theming. What matters is that forcing dark actually changes the paint
  // and lands on a dark colour.
  const darkLum = darkBg.match(/\d+/g)?.slice(0, 3).reduce((a, b) => a + Number(b), 0) ?? 999;
  r.check("dark actually repaints", darkLum < 200, darkBg);

  await page.click('.seg-btn[data-theme="light"]');
  const lightBg = await bg();
  r.check("light sets the override", (await attr()) === "light", String(await attr()));
  r.check("light differs from dark", lightBg !== darkBg, `${lightBg} vs ${darkBg}`);

  await page.click('.seg-btn[data-theme="system"]');
  r.check("system removes the override", (await attr()) === null, String(await attr()));

  r.check("choice persisted to chrome.storage",
          (await page.evaluate(() => window.__set?.settings?.theme)) === "system", "");
  r.check("choice mirrored to localStorage for pre-paint use",
          (await page.evaluate(() => localStorage.getItem("cb-theme"))) === "system", "");
  await page.close();
}

// Stored theme is restored on open, and applied before paint by panel-init.js.
{
  const page = await browser.newPage({ viewport: { width: 360, height: 620 } });
  // popup.html loads popup.js itself; stub it so the real script runs once,
  // AFTER the chrome shim exists.
  await page.route("**/popup.js", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.addInitScript(() => { try { localStorage.setItem("cb-theme", "dark"); } catch (e) {} });
  await page.goto(srcUrl("popup.html"));
  const preScript = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  r.check("panel-init applies the mirrored theme before popup.js runs",
          preScript === "dark", String(preScript));

  await page.addScriptTag({ content: shim({ theme: "dark" }) });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(200);
  await page.click('.tab[data-tab="settings"]');
  r.check("stored theme reflected in the control",
          await page.getAttribute('.seg-btn[data-theme="dark"]', "aria-checked") === "true", "");
  await page.close();
}

// Light must win over an OS dark preference.
{
  const page = await browser.newPage({ viewport: { width: 360, height: 620 }, colorScheme: "dark" });
  // popup.html loads popup.js itself; stub it so the real script runs once,
  // AFTER the chrome shim exists.
  await page.route("**/popup.js", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(srcUrl("popup.html"));
  await page.addScriptTag({ content: shim({ theme: "light" }) });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(200);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  r.check("explicit light overrides an OS dark preference",
          (bg.match(/\d+/g)?.slice(0, 3).reduce((a, b) => a + Number(b), 0) ?? 0) > 600, bg);
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
