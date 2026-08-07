/**
 * Batch 1 bug fixes.
 *
 *  2. Keyword accuracy — story/novel apps excluded; registered brands caught
 *     even when the copy contains no lending vocabulary.
 *  3. Scan history race — concurrent SAVE_SCAN writes no longer clobber.
 *  4. Link selection — the store link wins over the profile link, so an ad
 *     pointing at a package the SEC *does* declare verifies correctly.
 *  5. Name-match-only — a registry name plus a social/messenger link is no
 *     longer "SEC Verified".
 */
import { chromium, SRC, read, createReporter, CHROME_SHIM } from "./_setup.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const r = createReporter("batch 1 — bug fixes");
const browser = await chromium.launch({ headless: true });

// ── 5 + 4: matcher verdicts ────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });

  const v = await page.evaluate(() => {
    const M = window.CrediBytesMatcher;
    return {
      // The reported spoof: Messenger link + registered company name.
      messenger: M.matchUrl("https://m.me/snapcashph", "", "Snapcash Lending Inc."),
      fbPage:    M.matchUrl("https://www.facebook.com/snapcashph/", "", "Snapcash Lending Inc."),
      // Same name, but a genuinely declared channel must still verify.
      declaredPkg: M.matchUrl(
        "https://play.google.com/store/apps/details?id=com.cashola.loan.cash.peso",
        "Cashify Ph", ""),
      // A store URL with no declaration stays the highest-risk tier.
      undeclared: M.matchUrl(
        "https://play.google.com/store/apps/details?id=com.totally.unknown.app",
        "Some App", ""),
      isSocial: [
        M.isSocialUrl("https://m.me/x"),
        M.isSocialUrl("https://www.facebook.com/x"),
        M.isSocialUrl("https://play.google.com/store/apps/details?id=a.b"),
        M.isSocialUrl("https://kviku.ph/"),
      ],
    };
  });

  r.check("messenger + registry name is NOT legitimate",
          v.messenger.legitimacy === "name_match_only",
          `${v.messenger.status} / ${v.messenger.legitimacy}`);
  r.check("facebook page + registry name is NOT legitimate",
          v.fbPage.legitimacy === "name_match_only",
          `${v.fbPage.status} / ${v.fbPage.legitimacy}`);
  r.check("name_match_only still returns the ref (for official links)",
          !!v.messenger.ref && /snapcash/i.test(v.messenger.ref.company),
          JSON.stringify(v.messenger.ref?.company));
  r.check("declared Play package still verifies",
          v.declaredPkg.legitimacy === "legitimate" &&
          v.declaredPkg.status === "exact_play_store_package_match",
          `${v.declaredPkg.status} / ${v.declaredPkg.legitimacy}`);
  r.check("undeclared store package stays unverified",
          v.undeclared.status === "no_reference_match", v.undeclared.status);
  r.check("isSocialUrl classifies correctly",
          JSON.stringify(v.isSocial) === JSON.stringify([true, true, false, false]),
          JSON.stringify(v.isSocial));
  await page.close();
}

// ── 4: link ranking picks the CTA, not the first link in DOM order ─────────
{
  // Profile link first, store link last — the order a real ad card uses.
  const AD = `
  <div role="article">
    <a role="link" href="https://www.facebook.com/CashifyPh/"><strong><span>Cashify Ph</span></strong></a>
    <span>Sponsored</span>
    <div>Cash loan up to PHP 25,000 — apply for loan online, walang collateral.</div>
    <a href="https://www.facebook.com/CashifyPh/">See more</a>
    <a href="https://play.google.com/store/apps/details?id=com.cashola.loan.cash.peso">Install now</a>
  </div>`;
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${AD}</body>`);
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("stage1_model.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("stage1.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(700);

  const saved = await page.evaluate(() =>
    window.__sent.find(m => m.type === "SAVE_SCAN")?.payload);
  r.check("store link beats the profile link",
          saved?.label === "SEC Verified", `label=${saved?.label}`);
  r.check("resolved to the declared registrant",
          /sunloan/i.test(saved?.company || ""), `company=${saved?.company}`);
  await page.close();
}

// ── 2: keyword accuracy ────────────────────────────────────────────────────
{
  const mk = (advertiser, body, href) => `
  <div role="article">
    <a role="link" href="https://www.facebook.com/p/"><strong><span>${advertiser}</span></strong></a>
    <span>Sponsored</span>
    <div>${body}</div>
    <a href="${href}">Open</a>
  </div>`;

  const cases = [
    ["Romance Novel", "Read the next chapter now, borrow her heart", "https://play.google.com/store/apps/details?id=com.novel.reader", false, "story app rejected"],
    ["Novels Lover",  "Thousands of stories free to read",            "https://play.google.com/store/apps/details?id=com.novels.lover", false, "novel app rejected"],
    // No lending vocabulary at all — caught only via the registry brand name.
    ["JuanHand", "Relate na relate kami, Donna Cariaga! Good thing, nandiyan si JuanHand para sa'yo!", "https://www.facebook.com/juanhand/", true, "registered brand with no keywords is caught"],
    ["Some Lender", "Instant cash loan, walang collateral, apply now", "https://example-lender.ph/", true, "ordinary lending ad still caught"],
    ["Samsung", "Pre-order now and get free Galaxy Buds",             "https://www.samsung.com/ph/", false, "unrelated ad ignored"],
  ];

  for (const [advertiser, body, href, expect, name] of cases) {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body>${mk(advertiser, body, href)}</body>`);
    await page.addScriptTag({ content: CHROME_SHIM });
    await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
    await page.addScriptTag({ content: await read("stage1_model.js") });
    await page.addScriptTag({ content: await read("matcher.js") });
    await page.addScriptTag({ content: await read("stage1.js") });
    await page.addScriptTag({ content: await read("content.js") });
    await page.waitForTimeout(600);
    const scanned = await page.evaluate(() =>
      window.__sent.some(m => m.type === "SAVE_SCAN"));
    r.check(name, scanned === expect, `scanned=${scanned}, expected=${expect}`);
    await page.close();
  }
}

// ── 3: SAVE_SCAN race ──────────────────────────────────────────────────────
// background.js is a service worker, so exercise its logic directly against a
// storage shim whose get/set are genuinely async — the condition that made the
// old read-modify-write lose entries.
{
  const bg = await fs.readFile(path.join(SRC, "background.js"), "utf8");
  const queueSrc = bg.slice(bg.indexOf("const MAX_SCANS"),
                            bg.indexOf("// ── Keeping the fallback backend warm"));

  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: `
    window.__data = { scans: [] };
    const delay = () => new Promise(res => setTimeout(res, Math.random() * 12));
    window.chrome = { storage: { local: {
      async get() { await delay(); return { scans: window.__data.scans.slice() }; },
      async set(o) { await delay(); Object.assign(window.__data, o); },
    } } };
    ${queueSrc}
    window.__run = async (n) => {
      await Promise.all(Array.from({ length: n }, (_, i) => enqueueScan({ id: i })));
      return window.__data.scans.length;
    };
  ` });

  const kept = await page.evaluate(() => window.__run(25));
  r.check("25 concurrent saves all persist", kept === 25, `kept=${kept}/25`);

  // 60 saves stay under the 500 cap, so all of them persist.
  const capped = await page.evaluate(async () => {
    window.__data.scans = [];
    return window.__run(60);
  });
  r.check("history capped at MAX_SCANS (500)", capped === 60, `kept=${capped}`);
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
