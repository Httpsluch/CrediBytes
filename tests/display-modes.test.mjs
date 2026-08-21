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
  await page.addScriptTag({ content: await read("verdict-view.js") });
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

// displayResult is the new key. displayMode used to be one three-way value
// (badge|floating|sidepanel) conflating what is drawn on the page with where
// the extension's own UI opens; setLegacyMode() below proves the old value
// still resolves for users who have not been migrated yet.
const setMode = (mode) => page.evaluate((m) => new Promise(res => {
  const s = { ...window.__store.settings, displayResult: m };
  delete s.displayMode;
  window.chrome.storage.local.set({ settings: s }, () => setTimeout(res, 350));
}), mode);

const setLegacyMode = (mode) => page.evaluate((m) => new Promise(res => {
  const s = { ...window.__store.settings, displayMode: m };
  delete s.displayResult;
  window.chrome.storage.local.set({ settings: s }, () => setTimeout(res, 350));
}), mode);

const setSidePanel = (on) => page.evaluate((v) => new Promise(res => {
  const s = { ...window.__store.settings, sidePanel: v };
  window.chrome.storage.local.set({ settings: s }, () => setTimeout(res, 350));
}), on);

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

// ── The settings split, and the widget's new behaviour ──────────────────────
//
// displayMode was one three-way value that forced a false choice: "sidepanel"
// meant "badges PLUS the panel", so it was never a peer of "badge"/"floating".
// It is now displayMode (panel on/off) + displayResult (badge|floating), and
// the two are independent — every combination is reachable.
{
  // A stored legacy value must still resolve, or an un-migrated user gets a
  // blank page instead of the surface they chose.
  await setLegacyMode("floating");
  let t = await snap();
  check("legacy displayMode=floating still resolves", t.floating === true, JSON.stringify(t));
  await setLegacyMode("sidepanel");
  t = await snap();
  check("legacy displayMode=sidepanel still means badges on the page",
        t.badges === 1 && t.floating === false, JSON.stringify(t));

  // The panel setting must not touch what is drawn on the page. That
  // independence is the whole point of the split.
  await setMode("floating");
  await setSidePanel(true);
  t = await snap();
  check("side panel ON does not disturb the floating widget",
        t.floating === true && t.badges === 0, JSON.stringify(t));
  await setSidePanel(false);

  // Uncapped list. It used to show 6 while the header counted every scan, so
  // the number and the list openly disagreed.
  const many = await page.evaluate(() => new Promise(res => {
    const scans = Array.from({ length: 45 }, (_, i) => ({
      ts: Date.now() - i * 1000, legitimacy: "unverified", status: "no_reference_match",
      tier: "unverified", label: "Unverified", advertiserName: "Advertiser " + i,
      company: "", sec: "", officialUrl: "", isStoreUrl: false,
    }));
    window.chrome.storage.local.set({ scans }, () => setTimeout(() => res(
      document.querySelectorAll("#cb-float-content .cb-float-row").length), 400));
  }));
  check("widget draws a first batch well past the old cap of 6",
        many > 6, "rows=" + many);

  const detail = await page.evaluate(() => new Promise(res => {
    const rows = document.querySelectorAll("#cb-float-content .cb-float-row");
    rows[0].click();
    setTimeout(() => {
      const w = document.getElementById("cb-float-detail");
      const first = w?.querySelector("#cb-float-detail-title")?.textContent || "";
      rows[1].click();
      setTimeout(() => {
        const w2 = document.getElementById("cb-float-detail");
        res({
          opened: !!w,
          first,
          second: w2?.querySelector("#cb-float-detail-title")?.textContent || "",
          windows: document.querySelectorAll("#cb-float-detail").length,
          sections: w2?.querySelectorAll(".cb-section").length || 0,
        });
      }, 200);
    }, 200);
  }));

  check("clicking a card opens the detail window", detail.opened === true, JSON.stringify(detail));
  check("the detail window renders the card's sections",
        detail.sections >= 3, "sections=" + detail.sections);
  // The behaviour that keeps the page usable: one window, refilled.
  check("clicking another card REPLACES it rather than stacking",
        detail.windows === 1, "windows=" + detail.windows);
  check("and the replacement shows the second card",
        detail.second && detail.second !== detail.first,
        `${detail.first} -> ${detail.second}`);

  // The detail belongs to the list; it must not be left stranded on the page.
  const afterClose = await page.evaluate(() => new Promise(res => {
    document.getElementById("cb-float-close").click();
    setTimeout(() => res(document.querySelectorAll("#cb-float-detail").length), 200);
  }));
  check("closing the list closes the detail window", afterClose === 0, "left=" + afterClose);
}

console.log("");
let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "   -> " + r.detail}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);

await browser.close();
process.exit(failed ? 1 : 0);
