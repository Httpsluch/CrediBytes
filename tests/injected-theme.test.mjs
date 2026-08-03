/**
 * The theme choice has to reach the injected UI.
 *
 * Reported: with Light selected in Settings, the inline badge's detail panel and
 * the floating widget stayed dark. Both styled themselves with
 * `@media (prefers-color-scheme: dark)`, which follows the OPERATING SYSTEM and
 * knows nothing about the extension's own setting — so on a dark OS the choice
 * was ignored.
 *
 * The popup solves this with data-theme on <html>, but <html> inside a content
 * script belongs to Facebook. The resolved theme is therefore stamped onto each
 * injected root as .cb-light / .cb-dark, with neither class meaning "follow the
 * OS". These tests pin that contract, since the bug was invisible to every
 * existing suite: the styles were present and correct, just keyed off the wrong
 * signal.
 */
import { chromium, read, createReporter } from "./_setup.mjs";

const r = createReporter("injected theme");
const browser = await chromium.launch({ headless: true });

const AD = `
<div role="article">
  <a role="link" href="https://www.facebook.com/x/"><strong><span>Snapcash Lending Inc.</span></strong></a>
  <span>Sponsored</span>
  <div>Cash loan online, fast approval, no collateral loan needed.</div>
  <a href="https://m.me/snapcash">Message us</a>
</div>`;

async function scanWithTheme(theme, osScheme = "light") {
  const page = await browser.newPage({ colorScheme: osScheme });
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.setContent(AD);

  // Shim carrying a theme in settings, plus a live onChanged channel so the
  // "switch after the fact" case can be exercised.
  await page.addScriptTag({ content: `
    window.__listeners = []; window.__sent = [];
    window.__store = { settings: { scanningEnabled: true, displayMode: "badge", theme: ${JSON.stringify(theme)} }, scans: [] };
    window.chrome = {
      storage: {
        local: {
          get(keys, cb) {
            const k = typeof keys === "string" ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
            const out = {}; k.forEach(x => { if (x in window.__store) out[x] = window.__store[x]; }); cb && cb(out);
          },
          set(obj, cb) {
            const ch = {};
            for (const key of Object.keys(obj)) { ch[key] = { oldValue: window.__store[key], newValue: obj[key] }; window.__store[key] = obj[key]; }
            cb && cb(); window.__listeners.forEach(fn => fn(ch, "local"));
          },
        },
        onChanged: { addListener(fn) { window.__listeners.push(fn); } },
      },
      runtime: { id: "test", lastError: null,
        sendMessage(m, cb) { window.__sent.push(m); cb && cb({ ok: true, prediction: null }); } },
      tabs: { query: (q, cb) => cb([]) },
      sidePanel: { open() {}, setOptions() { return Promise.resolve(); } },
    };` });

  for (const f of ["sec_reference.js", "stage1_model.js", "matcher.js", "stage1.js", "content.js"]) {
    await page.addScriptTag({ content: await read(f) });
  }
  await page.waitForTimeout(3400);        // exceeds BACKEND_WAIT_MS
  return page;
}

const badgeClasses = (page) => page.evaluate(() => {
  const b = document.querySelector(".credibytes-badge");
  return b ? [...b.classList] : null;
});

// 1. Forced light must mark itself light, even though the OS is not consulted.
{
  const page = await scanWithTheme("light");
  const cls = await badgeClasses(page);
  r.check("light: badge marked .cb-light", cls?.includes("cb-light"), JSON.stringify(cls));
  r.check("light: not also marked dark", !cls?.includes("cb-dark"), JSON.stringify(cls));

  // The detail panel must actually paint light, not merely carry the class.
  await page.click(".credibytes-badge .cb-toggle");
  const bg = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".cb-detail")).backgroundColor);
  const lum = bg.match(/\d+/g)?.slice(0, 3).reduce((a, b) => a + Number(b), 0) ?? 0;
  r.check("light: detail panel paints light", lum > 600, bg);
  await page.close();
}

// 2. Forced dark.
{
  const page = await scanWithTheme("dark");
  const cls = await badgeClasses(page);
  r.check("dark: badge marked .cb-dark", cls?.includes("cb-dark"), JSON.stringify(cls));

  await page.click(".credibytes-badge .cb-toggle");
  const bg = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".cb-detail")).backgroundColor);
  const lum = bg.match(/\d+/g)?.slice(0, 3).reduce((a, b) => a + Number(b), 0) ?? 999;
  r.check("dark: detail panel paints dark", lum < 220, bg);
  await page.close();
}

// 3. THE REPORTED CASE: a dark operating system with Light chosen in Settings.
//    This is what a plain media query gets wrong, and what nothing caught before.
{
  const page = await scanWithTheme("light", "dark");
  await page.click(".credibytes-badge .cb-toggle");
  const bg = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".cb-detail")).backgroundColor);
  const lum = bg.match(/\d+/g)?.slice(0, 3).reduce((a, b) => a + Number(b), 0) ?? 0;
  r.check("dark OS + Light setting: panel still paints light", lum > 600, bg);
  await page.close();
}

// 3b. And the converse: a light OS with Dark chosen.
{
  const page = await scanWithTheme("dark", "light");
  await page.click(".credibytes-badge .cb-toggle");
  const bg = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".cb-detail")).backgroundColor);
  const lum = bg.match(/\d+/g)?.slice(0, 3).reduce((a, b) => a + Number(b), 0) ?? 999;
  r.check("light OS + Dark setting: panel still paints dark", lum < 220, bg);
  await page.close();
}

// 4. "system" must leave prefers-color-scheme in charge — neither class.
{
  const page = await scanWithTheme("system");
  const cls = await badgeClasses(page);
  r.check("system: neither class applied",
          !cls?.includes("cb-light") && !cls?.includes("cb-dark"), JSON.stringify(cls));
  await page.close();
}

// 5. Changing the setting must re-stamp badges ALREADY on the page — otherwise
//    the switch would only apply to ads scanned afterwards.
{
  const page = await scanWithTheme("light");
  r.check("before switch: light", (await badgeClasses(page))?.includes("cb-light"), "");

  await page.evaluate(() => new Promise(res => {
    const s = { ...window.__store.settings, theme: "dark" };
    window.chrome.storage.local.set({ settings: s }, () => setTimeout(res, 250));
  }));

  const cls = await badgeClasses(page);
  r.check("existing badge re-stamped to dark", cls?.includes("cb-dark"), JSON.stringify(cls));
  r.check("and the light class removed", !cls?.includes("cb-light"), JSON.stringify(cls));
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
