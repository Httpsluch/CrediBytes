/**
 * Facebook labels ads differently by account.
 *
 * Measured 2026-09-29 by probing the "Ad" label on an account where no ad was
 * ever detected, walking up from it:
 *
 *   span                     #shadow-root (closed): "Ad"
 *   span[aria-labelledby]    -> an element in the page whose text is "Ad"
 *   span
 *   a[href=/ads/about/…]     role=link, no text of its own
 *   span × 3, span block, div
 *   div flex/column          name column
 *   div flex/row             header row
 *   … div role=article
 *
 * No "Sponsored" anywhere, and the visible word in a closed shadow root — so
 * every marker the extension knew found nothing. The account that did work
 * marks the same link <a aria-label="Sponsored" href="/ads/about/…">.
 *
 * The fixtures attach a real closed shadow root, so nothing here can pass by
 * reading text a page script could not read.
 */
import { chromium, read, createReporter, CHROME_SHIM } from "./_setup.mjs";

const r = createReporter("Ad label variants");
const browser = await chromium.launch({ headless: true });

const SCRIPTS = ["i18n.js", "verdict-view.js", "sec_reference.js",
                 "revoked_reference.js", "matcher.js", "content.js"];

const BODY = "Bigger plans need bigger funds. Turn your property title into an opportunity " +
  "with Sangla Titulo. Get higher loan amounts, flexible payment terms. Apply now!";
const DEST = "https://l.facebook.com/l.php?u=" +
  encodeURIComponent("https://www.example-lender.ph/sangla-titulo") + "&h=x";

// `label` is the markup that stands where "Sponsored" used to be.
const post = (label, { name = "Asialink Finance Corporation", body = BODY } = {}) => `
  <div role="article">
    <div class="content">
      <div class="hdr-wrap"><div class="hdr" style="display:flex;flex-direction:row">
        <div class="avatar"><a href="https://www.facebook.com/AsialinkFinance"><svg width="40" height="40"></svg></a></div>
        <div style="flex:1"><div class="namecol" style="display:flex;flex-direction:column">
          <div><a role="link" href="https://www.facebook.com/AsialinkFinance"><strong><span class="adv">${name}</span></strong></a></div>
          <span style="display:block"><span><span>${label}</span> · <svg width="12" height="12"></svg></span></span>
        </div></div>
        <div role="button" style="width:60px"></div>
      </div></div>
      <div class="body">${body}</div>
      <a href="${DEST}">Apply now</a>
    </div>
  </div>`;

// The friend's account, as measured: the word lives in a closed shadow root.
const SHADOW_LABEL = (id) =>
  `<a href="/ads/about/?__cft__[0]=x" role="link" tabindex="0"><span>` +
  `<span aria-labelledby="${id}" style="display:inline-block"><span class="ad-host"></span></span>` +
  `</span></a>`;

// Hidden label targets, as the page keeps them.
const target = (id, text) =>
  `<span id="${id}" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${text}</span>`;

async function run(html) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body><div role="feed" style="width:500px">${html}</div></body>`);
  await page.evaluate(() => {
    for (const host of document.querySelectorAll(".ad-host")) {
      host.attachShadow({ mode: "closed" }).textContent = "Ad";
    }
  });
  await page.addScriptTag({ content: CHROME_SHIM });
  for (const f of SCRIPTS) await page.addScriptTag({ content: await read(f) });
  await page.waitForTimeout(3400);             // exceeds BACKEND_WAIT_MS = 2500
  const out = await page.evaluate(() => ({
    saved: window.__sent.filter(m => m.type === "SAVE_SCAN").map(m => m.payload.advertiserName),
    badges: document.querySelectorAll(".credibytes-badge").length,
    badgeNext: document.querySelector(".credibytes-badge")?.nextElementSibling?.className || null,
    pageText: document.body.innerText,
  }));
  await page.close();
  return out;
}

// 1. The measured markup: /ads/about link + aria-labelledby + closed shadow root.
{
  const m = await run(post(SHADOW_LABEL("_r_7r_")) + target("_r_7r_", "Ad"));
  r.check("fixture: the word 'Sponsored' appears nowhere", !/sponsored/i.test(m.pageText), "");
  r.check("closed-shadow 'Ad' label: the ad is detected", m.saved.length === 1, JSON.stringify(m.saved));
  r.check("closed-shadow 'Ad' label: the advertiser name is found",
          m.saved[0] === "Asialink Finance Corporation", JSON.stringify(m.saved[0]));
  r.check("closed-shadow 'Ad' label: the badge sits above the header row",
          m.badgeNext === "hdr", `next=${m.badgeNext}`);
}

// 2. Each signal on its own, so losing one does not lose the account.
{
  const labelledbyOnly = `<span role="link"><span aria-labelledby="_r_1_" style="display:inline-block">` +
    `<span class="ad-host"></span></span></span>`;
  const m1 = await run(post(labelledbyOnly) + target("_r_1_", "Ad"));
  r.check("aria-labelledby -> 'Ad' alone is enough", m1.saved.length === 1, JSON.stringify(m1.saved));

  const linkOnly = `<a href="/ads/about/?__cft__[0]=y" role="link"><svg width="14" height="10"></svg></a>`;
  const m2 = await run(post(linkOnly));
  r.check("the /ads/about link alone is enough, whatever the label says",
          m2.saved.length === 1, JSON.stringify(m2.saved));

  const filipino = `<a aria-label="May Sponsor" role="link" href="#"><span>May Sponsor</span></a>`;
  const m3 = await run(post(filipino));
  r.check("the Filipino label 'May Sponsor' is recognised", m3.saved.length === 1, JSON.stringify(m3.saved));
}

// 3. What must NOT count as an ad marker.
{
  // An organic post with lending words, a bare "Ad" in its text, and an
  // aria-labelledby pointing at something longer than a label.
  const organic = `
    <div role="article">
      <div><a role="link" href="https://www.facebook.com/juan"><strong><span>Juan Dela Cruz</span></strong></a></div>
      <div>Got a cash loan approved today! <span>Ad</span> astra. Online lending is fast.</div>
      <div aria-labelledby="_r_9_">Photo</div>
      <a href="https://example.com/story">Read</a>
    </div>${target("_r_9_", "Ad hoc album from the weekend")}`;
  const m1 = await run(organic);
  r.check("bare text 'Ad' and a long labelledby target are not ad markers",
          m1.saved.length === 0 && m1.badges === 0, JSON.stringify(m1.saved));

  // The "Why am I seeing this ad?" item: a long label, inside a menu.
  const menu = `
    <div role="article">
      <div><a role="link" href="https://www.facebook.com/juan"><strong><span>Juan Dela Cruz</span></strong></a></div>
      <div>Got a cash loan approved today! Online lending is fast.</div>
      <a href="https://example.com/story">Read</a>
    </div>
    <div role="menu"><div role="article">
      <a href="/ads/about/?__cft__[0]=z" role="menuitem">About this ad</a>
      <div>Cash loan lending ad preferences and settings</div>
      <a href="https://example.com/x">x</a>
    </div></div>
    <div><a href="/ads/about/?__cft__[0]=w">Why am I seeing this ad? Learn more about cash loan ads</a>
      <div>Cash loan lending explanation text for this advertisement</div></div>`;
  const m2 = await run(menu);
  r.check("an /ads/about link inside a menu, or with a long label, is not a marker",
          m2.saved.length === 0 && m2.badges === 0, JSON.stringify(m2.saved));
}

// 4. REGRESSION — the account that always worked keeps working, and its two
//    signals (aria-label and the /ads/about link are the same element) still
//    produce one scan, not two.
{
  const m = await run(post(`<a aria-label="Sponsored" href="/ads/about/?__cft__[0]=v" role="link"><span>Sponsored</span></a>`));
  r.check("aria-label 'Sponsored' on the /ads/about link: one ad, one scan",
          m.saved.length === 1 && m.badges === 1, `saved=${m.saved.length} badges=${m.badges}`);
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
