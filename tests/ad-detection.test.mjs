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
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("verdict-view.js") });
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

// A generic link-preview headline must not bury the advertiser's brand.
//
// Live Cashalo ad: Facebook renders "Convenient application" as the preview
// headline, getAppName() picks it up, and the query became
// "Convenient application Cashalo" -> {convenient, application, cashalo}.
// Against Cashalo's registry entry {cashalo, paloo} that scores 1/min(3,2) =
// 0.50, under the 0.60 threshold, so the Possible Match section disappeared —
// while the advertiser name ALONE scores 1.00. The two fields are independent
// evidence and are now scored apart.
{
  const page = await browser.newPage();
  await page.goto("about:blank");
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("verdict-view.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("revoked_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  const out = await page.evaluate(() => {
    const M = window.CrediBytesMatcher;
    const s = (app, co) => {
      const r = M.matchUrl("https://app.cashaloapp.com/", app, co);
      return { sugg: r.suggestion ? r.suggestion.company : null, leg: r.legitimacy };
    };
    return {
      diluted: s("Convenient application", "Cashalo"),
      bare: s("", "Cashalo"),
      junk: s("Convenient application", "Totally Unrelated Brand"),
    };
  });
  check("cashalo: a generic preview headline no longer buries the brand",
        /paloo/i.test(out.diluted.sugg || ""), JSON.stringify(out.diluted));
  check("cashalo: the advertiser name alone still resolves",
        /paloo/i.test(out.bare.sugg || ""), JSON.stringify(out.bare));
  // Raising suggestion recall must not raise the VERDICT. A suggestion is
  // rendered under "Possible match"; Pass 3 still refuses to verify on a name.
  check("cashalo: the verdict stays unverified regardless",
        out.diluted.leg === "unverified" && out.bare.leg === "unverified",
        `${out.diluted.leg}/${out.bare.leg}`);
  check("an unrelated advertiser still gets no suggestion",
        out.junk.sugg === null, JSON.stringify(out.junk));
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
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("verdict-view.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(500);
  const name = await page.evaluate(() =>
    window.__sent.find(m => m.type === "SAVE_SCAN")?.payload.advertiserName);
  check('noise: "Like" rejected as a name', name === "", `got=${JSON.stringify(name)}`);
  await page.close();
}

// A link to a declared channel makes an ad a lending ad whatever its wording.
//
// Live InvestEd carousel: every lending word it had ("Educ4All Lending Inc.",
// "#StudentLoansPH") sat behind "See more", which Facebook does not render
// until clicked, so the keyword checks found nothing and the ad was dropped
// before its link — app.invested.ph, under the declared invested.ph — was read.
{
  const dest = "https://app.invested.ph/landing/application?utm_source=facebook";
  const card = `<div><div>Repayment Period</div><a aria-label="Apply now" role="link"
    href="https://l.facebook.com/l.php?u=${encodeURIComponent(dest)}&h=x"><span>Apply now</span></a></div>`;
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body><article>
    <div><a role="link" href="https://www.facebook.com/InvestEdPH"><strong><span>InvestEd Philippines</span></strong></a>
      <a aria-label="Sponsored" href="/ads/about/?x" role="link"><span>Sponsored</span></a></div>
    <div data-ad-preview="message">Tara, usapang REPAYMENT tayo! So, here are all of the things you need
      to know about InvestEd's repayment period, late fees, and on-time payments... <div role="button">See more</div></div>
    ${card}${card}
  </article>
  <article>
    <div><a role="link" href="https://www.facebook.com/GrabPH"><strong><span>Grab</span></strong></a>
      <a aria-label="Sponsored" href="/ads/about/?y" role="link"><span>Sponsored</span></a></div>
    <div>Craving something? Get your favourites delivered, free delivery on your first order.</div>
    <a href="https://l.facebook.com/l.php?u=${encodeURIComponent("https://www.grab.com/ph/food/")}&h=y">Order now</a>
  </article></body>`);
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("verdict-view.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(3400);
  const saved = await page.evaluate(() =>
    window.__sent.filter(m => m.type === "SAVE_SCAN").map(m => m.payload));
  const inv = saved.find(p => p.advertiserName === "InvestEd Philippines");
  check("declared destination: an ad with no lending words is still scanned", !!inv,
        saved.map(p => p.advertiserName).join(", ") || "(none)");
  check("declared destination: and verifies on that link",
        inv?.label === "SEC Verified" && inv?.destHost === "app.invested.ph",
        `${inv?.label} / ${inv?.destHost}`);
  // Grab declares only its lending page, grab.com/ph/grabfinance-quick-cash/.
  check("declared destination: a GrabFood ad on grab.com is not treated as lending",
        !saved.some(p => p.advertiserName === "Grab"), saved.map(p => p.advertiserName).join(", "));

  const scoped = await page.evaluate(() => {
    const M = window.CrediBytesMatcher;
    return {
      lendingPath: M.isDeclaredDestination("https://www.grab.com/ph/grabfinance-quick-cash/apply"),
      store: M.isDeclaredDestination("https://play.google.com/store/apps/details?id=com.juanhand.fast.cash.peso.loan.app"),
      unknownStore: M.isDeclaredDestination("https://play.google.com/store/apps/details?id=com.example.notinthesecregistry"),
    };
  });
  check("declared destination: Grab's declared lending path does count", scoped.lendingPath, "");
  check("declared destination: a declared Play package counts", scoped.store, "");
  check("declared destination: an undeclared package does not", !scoped.unknownStore, "");
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
