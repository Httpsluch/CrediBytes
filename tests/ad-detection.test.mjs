/** Feed-vs-search advertiser-name extraction + Kviku suggestion. */
import { chromium, SRC, read, srcUrl, CHROME_SHIM } from "./_setup.mjs";
// NEWS FEED: no role="article" anywhere. "Sponsored" sits in its own small
// classed wrapper — the shape that used to defeat the old closest() call.
const FEED = `
<div class="x1lliihq feedunit">
  <div class="x9f619">
    <div class="xu06os2"><h4 class="x1heor9g"><span class="xt0psk2"><a role="link" href="https://www.facebook.com/KvikuPH/"><strong><span>Kviku Philippines</span></strong></a></span></h4></div>
    <div class="x1yztbdb"><span class="x4k7w5x">Sponsored</span></div>
  </div>
  <div class="x1iorvi4">Walang budget? Up to PHP 25,000 agad. Kviku loan in 5 minutes. No collateral. Tap Apply Now.</div>
  <a href="https://kvikuloan.ph/apply">Apply now</a>
  <div><span>Like</span><span>Comment</span><span>Share</span></div>
</div>`;

// SEARCH RESULTS: has role="article" — this path already worked.
const SEARCH = `
<div role="article" class="x1n2onr6">
  <h3><a role="link" href="https://www.facebook.com/dhen.calma"><span>Dhen Punongbayan Calma</span></a></h3>
  <span>Sponsored</span>
  <div>Fast cash loan online, apply for loan, no collateral needed.</div>
  <a href="https://example-lender.ph/apply">Apply</a>
</div>`;

const browser = await chromium.launch({ headless: true });
const results = [];
const check = (n, c, d) => results.push({ n, pass: !!c, d });

for (const [label, html, expectName] of [
  ["news feed (no role=article)", FEED, "Kviku Philippines"],
  ["search results (role=article)", SEARCH, "Dhen Punongbayan Calma"],
]) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body style="background:#fff">${html}</body>`);
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(500);

  const r = await page.evaluate(() => {
    const saved = window.__sent.filter(m => m.type === "SAVE_SCAN").map(m => m.payload);
    return {
      badges: document.querySelectorAll(".credibytes-badge").length,
      name: saved[0]?.advertiserName ?? null,
      label: saved[0]?.label ?? null,
      suggestion: saved[0]?.suggestion?.company ?? null,
      savedCount: saved.length,
    };
  });

  check(`${label}: exactly one badge`, r.badges === 1, `badges=${r.badges}`);
  check(`${label}: advertiser name captured`, r.name === expectName, `got=${JSON.stringify(r.name)}`);
  check(`${label}: saved once (no double-badge)`, r.savedCount === 1, `saved=${r.savedCount}`);
  if (label.startsWith("news feed")) {
    check("kviku: flagged (kvikuloan.ph is undeclared)", r.label === "Unverified", r.label);
    check("kviku: fuzzy suggestion now resolves", r.suggestion && /kviku/i.test(r.suggestion),
          `suggestion=${JSON.stringify(r.suggestion)}`);
  }
  await page.close();
}

// Noise rejection: a bare <strong>Like</strong> must not become the name.
{
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>
    <div class="wrap"><span>Sponsored</span>
      <div>Get an instant cash loan today, apply for loan now, no collateral.</div>
      <a href="https://play.google.com/store/apps/details?id=com.nope.loan">Install</a>
      <strong>Like</strong></div></body>`);
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(500);
  const name = await page.evaluate(() =>
    window.__sent.find(m => m.type === "SAVE_SCAN")?.payload.advertiserName);
  check('noise: "Like" rejected as a name', name === "", `got=${JSON.stringify(name)}`);
  await page.close();
}

// Popup height regression
{
  const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
  await page.route("**/popup.js", r => r.fulfill({ status:200, contentType:"text/javascript", body:"" }));
  await page.goto(srcUrl("popup.html"));
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const f = document.querySelector(".feed");
    return { bodyH: document.body.getBoundingClientRect().height,
             feedH: f.getBoundingClientRect().height };
  });
  check("popup: body has real height", m.bodyH >= 500, `bodyH=${Math.round(m.bodyH)}`);
  check("popup: feed is not collapsed", m.feedH > 150, `feedH=${Math.round(m.feedH)}`);
  await page.close();
}

console.log("");
let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.n}${r.pass ? "" : "   -> " + r.d}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
