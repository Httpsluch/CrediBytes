/**
 * Stat tiles must count every scan, not just the visible feed.
 *
 * Reported: scrolling the Meta Ad Library took Verified from 22 down to 20
 * while Unverified rose. The tiles were derived from the stored `scans` array,
 * which is capped at 50 — so once full, each new scan evicted an older one and
 * a tile could fall. The giveaway was that the three tiles always summed to
 * exactly 50 (30 + 17 + 3 in the report).
 */
import { chromium, SRC, createReporter } from "./_setup.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const r = createReporter("scan totals");
const browser = await chromium.launch({ headless: true });

const bg = await fs.readFile(path.join(SRC, "background.js"), "utf8");
const queueSrc = bg.slice(bg.indexOf("const MAX_SCANS"),
                          bg.indexOf("// ── Keeping the fallback backend warm"));

const page = await browser.newPage();
await page.setContent("<!doctype html><body></body>");
await page.addScriptTag({ content: `
  window.__data = { scans: [], totals: undefined };
  const delay = () => new Promise(res => setTimeout(res, Math.random() * 4));
  window.chrome = { storage: { local: {
    async get(keys) {
      await delay();
      const k = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of k) if (window.__data[key] !== undefined) out[key] = window.__data[key];
      return out;
    },
    async set(o) { await delay(); Object.assign(window.__data, o); },
  } } };
  ${queueSrc}
  window.__save = (tier, n) => Promise.all(
    Array.from({ length: n }, (_, i) =>
      enqueueScan({ ts: Date.now() + i, tier, legitimacy: "x", status: "y" })));
` });

// Save well past the 50-item cap: 40 verified, then 30 unverified.
// Under the old code the feed would hold 50 (10 verified + 30 unverified... in
// eviction order), and Verified would have visibly dropped.
await page.evaluate(() => window.__save("legitimate", 40));
const mid = await page.evaluate(() => ({ ...window.__data.totals, feed: window.__data.scans.length }));
await page.evaluate(() => window.__save("unverified", 30));
const end = await page.evaluate(() => ({ ...window.__data.totals, feed: window.__data.scans.length }));

r.check("feed holds all 70 (under the 500 cap)", end.feed === 70, `feed=${end.feed}`);
r.check("verified total does not fall as rows age out",
        end.legitimate === 40 && end.legitimate >= mid.legitimate,
        `mid=${mid.legitimate} end=${end.legitimate}`);
r.check("unverified total counts all 30", end.unverified === 30, `unverified=${end.unverified}`);
r.check("totals count every save",
        end.legitimate + end.unverified === 70,
        `sum=${end.legitimate + end.unverified}`);

// Danger and namematch tiers are tracked independently.
await page.evaluate(() => window.__save("danger", 5));
await page.evaluate(() => window.__save("namematch", 3));
const t = await page.evaluate(() => ({ ...window.__data.totals }));
r.check("danger counted separately", t.danger === 5, `danger=${t.danger}`);
r.check("namematch counted separately", t.namematch === 3, `namematch=${t.namematch}`);

// Legacy records without `tier` must still be classified.
await page.evaluate(() => enqueueScan(
  { ts: Date.now(), legitimacy: "unverified", status: "no_reference_match", isStoreUrl: true }));
const legacy = await page.evaluate(() => ({ ...window.__data.totals }));
r.check("record without tier falls back to derived tier",
        legacy.danger === 6, `danger=${legacy.danger}`);

// Concurrency: totals are a read-modify-write too, so they need the same queue.
await page.evaluate(() => { window.__data.scans = []; window.__data.totals = undefined; });
await page.evaluate(() => window.__save("legitimate", 35));
const conc = await page.evaluate(() => ({ ...window.__data.totals }));
r.check("35 concurrent saves all counted", conc.legitimate === 35, `legitimate=${conc.legitimate}`);

await browser.close();
process.exit(r.finish() ? 1 : 0);
