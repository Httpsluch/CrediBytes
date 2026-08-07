/**
 * Verifies the display-mode fix in a real Chromium DOM.
 * Shims the chrome.* APIs content.js depends on, then drives the actual
 * settings flow the popup would trigger.
 */
import { chromium, SRC, read, srcUrl, CHROME_SHIM } from "./_setup.mjs";
const AD_HTML = `
<div role="article" id="ad1">
  <span>Sponsored</span>
  <div>Get an instant cash loan today! Apply for loan online, no collateral.</div>
  <a href="https://play.google.com/store/apps/details?id=com.totally.unregistered.loanapp">Install</a>
</div>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><body>${AD_HTML}</body></html>`);

await page.addScriptTag({ content: CHROME_SHIM });
await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
await page.addScriptTag({ content: await read("matcher.js") });
await page.addScriptTag({ content: await read("content.js") });
await page.waitForTimeout(600);

const snap = () => page.evaluate(() => ({
  badges: document.querySelectorAll(".credibytes-badge").length,
  floating: !!document.getElementById("cb-floating"),
  badgeLabel: document.querySelector(".credibytes-badge .cb-label")?.textContent || null,
  toggleTag: document.querySelector(".credibytes-badge .cb-toggle")?.tagName || null,
  ariaExpanded: document.querySelector(".credibytes-badge .cb-toggle")?.getAttribute("aria-expanded") ?? null,
  scans: window.__store.scans.length,
  saved: window.__store.scans[0] || null,
  processed: document.querySelectorAll("[credibytes-processed]").length,
}));

const setMode = (mode) => page.evaluate((m) => new Promise(res => {
  const s = { ...window.__store.settings, displayMode: m };
  window.chrome.storage.local.set({ settings: s }, () => setTimeout(res, 350));
}), mode);

const setScanning = (on) => page.evaluate((v) => new Promise(res => {
  const s = { ...window.__store.settings, scanningEnabled: v };
  window.chrome.storage.local.set({ settings: s }, () => setTimeout(res, 350));
}), on);

const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: !!cond, detail }); };

let s = await snap();
check("badge mode: badge injected", s.badges === 1, JSON.stringify(s));
check("badge mode: bar reads AD UNREGISTERED!", /UNREGISTERED/.test(s.badgeLabel || ""), s.badgeLabel);
check("badge mode: stored label stays canonical", s.saved?.label === "Unregistered App", s.saved?.label);
check("badge mode: no floating widget", s.floating === false, "");
check("badge mode: scan saved", s.scans === 1, "scans=" + s.scans);
check("a11y: toggle is a real BUTTON", s.toggleTag === "BUTTON", s.toggleTag);
check("a11y: aria-expanded present", s.ariaExpanded === "false", String(s.ariaExpanded));

// THE BUG: switching to floating previously did nothing until page reload.
await setMode("floating");
s = await snap();
check("switch -> floating: badge removed", s.badges === 0, "badges=" + s.badges);
check("switch -> floating: widget created", s.floating === true, "floating=" + s.floating);

// And back again.
await setMode("badge");
s = await snap();
check("switch -> badge: widget removed", s.floating === false, "floating=" + s.floating);
check("switch -> badge: badge re-injected", s.badges === 1, "badges=" + s.badges);

// THE OTHER BUG: this toggle previously did nothing at all.
await setScanning(false);
s = await snap();
check("scanning off: badge removed", s.badges === 0, "badges=" + s.badges);
check("scanning off: processed marks cleared", s.processed === 0, "processed=" + s.processed);

await setScanning(true);
s = await snap();
check("scanning on: badge restored", s.badges === 1, "badges=" + s.badges);

// Detail panel toggle
const expanded = await page.evaluate(() => {
  const b = document.querySelector(".credibytes-badge .cb-toggle");
  b.click();
  return {
    hidden: document.querySelector(".credibytes-badge .cb-detail").hidden,
    aria: b.getAttribute("aria-expanded"),
    text: b.textContent,
    rows: document.querySelectorAll(".credibytes-badge .cb-row").length,
  };
});
check("detail expands on click", expanded.hidden === false, JSON.stringify(expanded));
check("detail sets aria-expanded=true", expanded.aria === "true", expanded.aria);
check("detail renders rows", expanded.rows > 0, "rows=" + expanded.rows);

console.log("");
let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "   -> " + r.detail}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);

await browser.close();
process.exit(failed ? 1 : 0);
