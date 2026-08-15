/**
 * Shared test harness for the CrediBytes extension suites.
 *
 * Resolves Playwright and the extension source without hard-coded absolute
 * paths, so the tests keep working if the repo is cloned elsewhere.
 *
 * Playwright is not a dependency of this project — it is borrowed from
 * whichever sibling checkout already has it (the thesis pipeline uses it for
 * ad collection). Set PLAYWRIGHT_ROOT to override.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the extension's src/ directory. */
export const SRC = path.resolve(HERE, "..", "src");

/** Read a file from src/ as text. */
export const read = (f) => fs.readFile(path.join(SRC, f), "utf8");

/** file:// URL for a page under src/ (Playwright needs a URL, not a path). */
export const srcUrl = (f, query = "") =>
  "file:///" + path.join(SRC, f).replace(/\\/g, "/") + query;

function resolveChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_ROOT,
    path.resolve(HERE, "..", ".."),                       // repo root
    path.resolve(HERE, "..", "..", ".."),                 // parent of repo
    "D:/Coding_Projects/Python/Thesis Project",           // known sibling checkout
  ].filter(Boolean);

  for (const base of candidates) {
    try {
      const req = createRequire(path.join(base, "package.json"));
      return req("playwright").chromium;
    } catch { /* try next */ }
  }
  throw new Error(
    "Playwright not found. Install it (npm i -D playwright) or set " +
    "PLAYWRIGHT_ROOT to a checkout that has it."
  );
}

export const chromium = resolveChromium();

/**
 * Minimal chrome.* stand-in.
 *
 * Backed by a real in-memory store that fires storage.onChanged, because the
 * display-mode fix depends on that listener firing — a stub that only records
 * calls would pass while the feature was broken.
 */
export const CHROME_SHIM = `
window.__store = { settings: { scanningEnabled: true, displayMode: "badge" }, scans: [] };
window.__listeners = [];
window.__sent = [];
window.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const k = typeof keys === "string" ? [keys]
                : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
        const out = {};
        k.forEach(key => { if (key in window.__store) out[key] = window.__store[key]; });
        cb && cb(out);
      },
      set(obj, cb) {
        const changes = {};
        for (const key of Object.keys(obj)) {
          changes[key] = { oldValue: window.__store[key], newValue: obj[key] };
          window.__store[key] = obj[key];
        }
        cb && cb();
        window.__listeners.forEach(fn => fn(changes, "local"));
      },
    },
    onChanged: { addListener(fn) { window.__listeners.push(fn); } },
  },
  runtime: {
    // Real content scripts always have this. content.js treats a missing
    // runtime.id as "extension context invalidated", so the shim must provide
    // one or every suite would think it had been orphaned.
    id: "credibytes-test-extension-id",
    lastError: null,
    sendMessage(msg, cb) {
      window.__sent.push(msg);
      if (msg.type === "SAVE_SCAN") {
        window.__store.scans = [msg.payload, ...window.__store.scans];
      }
      cb && cb({ ok: true, prediction: null });
    },
  },
  tabs: { query: (q, cb) => cb([]) },
  sidePanel: { open() {}, setOptions() { return Promise.resolve(); } },
};`;

/** Load the content-script stack (reference -> matcher -> content) into a page. */
export async function loadContentScripts(page) {
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("verdict-view.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("content.js") });
}

/** Tiny assertion collector. */
export function createReporter(title) {
  const results = [];
  return {
    check(name, cond, detail = "") { results.push({ name, pass: !!cond, detail }); },
    finish() {
      console.log(`\n${title}`);
      let failed = 0;
      for (const r of results) {
        console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "   -> " + r.detail}`);
        if (!r.pass) failed++;
      }
      console.log(`  ${results.length - failed}/${results.length} passed`);
      return failed;
    },
  };
}
