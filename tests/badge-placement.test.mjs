/**
 * Where the inline badge lands, and what it is allowed to cover.
 *
 * The feed fixture reproduces a probe of the live news feed (2026-09-28),
 * walking up from the Sponsored label:
 *
 *   #0  a[aria-label=Sponsored][href=/ads/about/…]
 *   #2  div flex/row   w=485   "Sponsored · (Shared with Public)"
 *   #5  div flex/column w=485  name + Sponsored
 *   #7  div flex/row   w=629   header row: avatar | name column | menu
 *   #8  div block      w=629   header wrapper
 *   #9  div block      w=629   the post's content (header, body, attachment)
 *   #12 article                the whole post
 *   #14 div BOX                the rounded card
 *   #18 div role=article aria-posinset
 *
 * Nothing matched the old root selector within 14 levels, so the root fell back
 * to part of the header, and the ad was judged on its header alone: an InvestEd
 * ad was dropped outright, a Salmon ad read Unverified off a facebook.com link.
 *
 * The badge belongs full width, inside the post, above its header (avatar and
 * name). With a header root it instead landed in the name column (#5 — the name
 * pushed onto the next line beside the avatar) or in the row (#7 — squeezed to
 * a sliver). An earlier fix picked its slot by width and landed in the name
 * column on wider cards; the slot is now found by structure, so it is checked
 * at two card widths.
 *
 * Destinations in the fixtures (invested.ph, moto.salmon.ph) are assumed for
 * the test — they are declared channels of Educ4All Lending and Sunprime
 * Finance, which is what makes the verdict observable.
 */
import { chromium, read, createReporter, CHROME_SHIM } from "./_setup.mjs";

const r = createReporter("Badge placement");
const browser = await chromium.launch({ headless: true });

const SCRIPTS = ["i18n.js", "verdict-view.js", "sec_reference.js",
                 "revoked_reference.js", "matcher.js", "content.js"];

async function load(page) {
  await page.addScriptTag({ content: CHROME_SHIM });
  for (const f of SCRIPTS) await page.addScriptTag({ content: await read(f) });
  await page.waitForTimeout(3400);             // exceeds BACKEND_WAIT_MS = 2500
}

// Visually hidden text on the menu button, standing in for whatever takes the
// live header row past 40 characters of innerText while the name column stays
// under it — the live root was the row (#7), not the column (#5).
const hidden = (t) =>
  `<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${t}</span>`;

const header = (name, slug) => `
  <div class="hdr-wrap">
    <div class="hdr" style="display:flex;flex-direction:row;align-items:center">
      <div class="avatar" style="width:40px"><a href="https://www.facebook.com/${slug}"><svg width="40" height="40"></svg></a></div>
      <div class="namecol-wrap" style="flex:1">
        <div class="namecol" style="display:flex;flex-direction:column">
          <div class="namerow"><span><a role="link" href="https://www.facebook.com/${slug}"><strong><span class="adv">${name}</span></strong></a></span></div>
          <div><span>
            <div style="display:flex;flex-direction:row">
              <span><a aria-label="Sponsored" href="/ads/about/?__cft__[0]=x" role="link"><span>Sponsored</span></a></span>
              <span> · </span><svg width="12" height="12"></svg>
            </div>
          </span></div>
        </div>
      </div>
      <div role="button" style="width:104px">${hidden("Actions for this post")}</div>
    </div>
  </div>`;

const content = (name, slug, body, dest) => `
  <div class="content">
    ${header(name, slug)}
    <div class="body">${body}</div>
    <div class="attachment"><a href="https://l.facebook.com/l.php?u=${encodeURIComponent(dest)}">Apply now</a></div>
    <div class="actions"><span>Like</span><span>Comment</span><span>Share</span></div>
  </div>`;

// `withArticle` false drops the <article> so only [aria-posinset] (18 levels
// up) remains — the shape to expect if another account's markup lacks it.
const story = (pos, ad, withArticle = true, width = 629) => {
  const inner = `<div><div>${content(...ad)}</div></div>`;
  return `
  <div class="story" role="article" aria-posinset="${pos}">
    <div style="display:flex;flex-direction:column"><div>
      <div style="display:flex;flex-direction:row"><div class="box" style="border-radius:8px;width:${width}px"><div>
        ${withArticle ? `<article class="post">${inner}</article>` : `<div class="post">${inner}</div>`}
      </div></div></div>
    </div></div>
  </div>`;
};

const INVESTED = ["InvestEd Philippines", "InvestEdPH",
  "Tara, usapang REPAYMENT tayo! Educ4All Lending Inc. (InvestEd PH) - SEC Reg. No. CS201629776. #StudentLoansPH",
  "https://invested.ph/apply"];
const SALMON = ["Salmon Philippines", "SalmonPH",
  "Choose your ride on Salmon Moto Marketplace, apply for Salmon Moto Loan.",
  "https://moto.salmon.ph/"];

const feedPage = (html, width = 629) => `<!doctype html><body style="margin:0">
  <div role="feed" style="width:${width}px">${html}</div></body>`;

// Everything the assertions need about one story's badge.
const inspect = (storySel) => {
  const s = document.querySelector(storySel);
  const badge = s.querySelector(".credibytes-badge");
  return {
    root: s.querySelector("[credibytes-processed]")?.className || null,
    badgeParent: badge?.parentElement?.className || null,
    badgeNext: badge?.nextElementSibling?.className || null,
    insideCard: !!badge?.closest(".box"),
    inNameColumn: !!badge?.closest(".namecol-wrap"),
    badgeW: badge ? badge.getBoundingClientRect().width : 0,
    hdrW: s.querySelector(".hdr").getBoundingClientRect().width,
    nameH: s.querySelector(".adv").getBoundingClientRect().height,
  };
};

// 1. The feed as measured — and on a wider card, where the width-based first
//    attempt put the badge in the name column instead.
for (const width of [629, 1000]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(feedPage(story(1, INVESTED, true, width) + story(2, SALMON, true, width), width));
  const nameBefore = await page.evaluate(() =>
    document.querySelector(".adv").getBoundingClientRect().height);
  await load(page);
  const saved = await page.evaluate(() =>
    window.__sent.filter(m => m.type === "SAVE_SCAN").map(m => m.payload));
  const inv = await page.evaluate(inspect, ".story[aria-posinset='1']");
  const sal = await page.evaluate(inspect, ".story[aria-posinset='2']");

  if (width === 629) {
    const byName = (n) => saved.find(p => p.advertiserName === n);
    r.check("InvestEd is scanned now that the body is in scope",
            !!byName("InvestEd Philippines"), saved.map(p => p.advertiserName).join(", "));
    r.check("InvestEd verifies through its declared website",
            byName("InvestEd Philippines")?.label === "SEC Verified",
            JSON.stringify(byName("InvestEd Philippines")?.label));
    r.check("Salmon is judged on its call to action, not a facebook.com link",
            byName("Salmon Philippines")?.destHost === "moto.salmon.ph",
            `dest=${byName("Salmon Philippines")?.destHost}`);
    r.check("Salmon verifies", byName("Salmon Philippines")?.label === "SEC Verified",
            byName("Salmon Philippines")?.label);
  }

  for (const [label, m] of [["InvestEd", inv], ["Salmon", sal]]) {
    const at = `${label} @${width}px`;
    r.check(`${at}: the root is the post, not the header row`, m.root === "post", `root=${m.root}`);
    r.check(`${at}: badge sits directly above the header row (avatar | name)`,
            m.badgeParent === "hdr-wrap" && m.badgeNext === "hdr",
            `parent=${m.badgeParent} next=${m.badgeNext}`);
    r.check(`${at}: badge is not in the name column`, !m.inNameColumn, "");
    r.check(`${at}: badge is inside the card`, m.insideCard, "");
    r.check(`${at}: badge spans the header's full width`,
            m.badgeW >= m.hdrW - 1, `badge=${Math.round(m.badgeW)} header=${Math.round(m.hdrW)}`);
  }
  r.check(`@${width}px: the advertiser name does not wrap`,
          Math.abs(inv.nameH - nameBefore) < 1, `${nameBefore} -> ${inv.nameH}`);
  await page.close();
}

// 2. No <article>: the story is found through aria-posinset, 18 levels up.
{
  const page = await browser.newPage();
  await page.setContent(feedPage(story(1, INVESTED, false)));
  await load(page);
  const m = await page.evaluate(() => ({
    root: document.querySelector("[credibytes-processed]")?.className || null,
    label: window.__sent.find(x => x.type === "SAVE_SCAN")?.payload.label || null,
    parent: document.querySelector(".credibytes-badge")?.parentElement?.className || null,
  }));
  r.check("without <article>, the feed story itself is the root", m.root === "story", `root=${m.root}`);
  r.check("and the ad is still judged on its whole content", m.label === "SEC Verified", m.label);
  r.check("and the badge still sits above the header row", m.parent === "hdr-wrap", `parent=${m.parent}`);
  await page.close();
}

// 3. No container at all, so the last resort roots the ad on part of its own
//    header: the row (as measured live for short names), or the name column
//    once the name alone clears 40 characters. The badge must still land above
//    the header row, full width — never in the row or the column.
for (const [what, ad, expectRoot] of [
  ["the header row", SALMON, "hdr"],
  ["the name column (long advertiser name)",
   ["Asialink Finance Corporation Philippines", "AsialinkFinance", SALMON[2], SALMON[3]], "namecol"],
]) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body style="margin:0"><div style="width:629px">
    ${content(...ad)}</div></body>`);
  const before = await page.evaluate(() =>
    document.querySelector(".adv").getBoundingClientRect().height);
  await load(page);
  const m = await page.evaluate(() => {
    const badge = document.querySelector(".credibytes-badge");
    return {
      root: document.querySelector("[credibytes-processed]")?.className || null,
      parent: badge?.parentElement?.className || null,
      next: badge?.nextElementSibling?.className || null,
      nameH: document.querySelector(".adv").getBoundingClientRect().height,
      badges: document.querySelectorAll(".credibytes-badge").length,
      saves: window.__sent.filter(x => x.type === "SAVE_SCAN").length,
    };
  });
  r.check(`fixture really does root on ${what}`, m.root === expectRoot, `root=${m.root}`);
  // The badge's own text lifts the header over the 40-character bar on the
  // rescan its insertion triggers; without the processed-marker check that
  // rooted the same ad again.
  r.check(`rooted on ${what}: one badge and one saved scan, not two`,
          m.badges === 1 && m.saves === 1, `badges=${m.badges} saves=${m.saves}`);
  r.check(`rooted on ${what}: the badge sits above the header row, not inside it`,
          m.parent === "hdr-wrap" && m.next === "hdr", `parent=${m.parent} next=${m.next}`);
  r.check(`rooted on ${what}: the advertiser name keeps its line`,
          Math.abs(m.nameH - before) < 1, `${before} -> ${m.nameH}`);
  await page.close();
}

// 4. The analysis floats over the ad, as it always did. The CLOSED bar claims
//    no stacking level — that is the state a user scrolls past — and the badge
//    is lifted only while its panel is open.
{
  const page = await browser.newPage();
  await page.setContent(feedPage(story(1, SALMON)));
  await load(page);
  const bodyTop = () => page.evaluate(() => document.querySelector(".body").getBoundingClientRect().top);
  const style = () => page.evaluate(() => {
    const b = document.querySelector(".credibytes-badge");
    return { pos: getComputedStyle(b).position, z: getComputedStyle(b).zIndex,
             detailPos: getComputedStyle(b.querySelector(".cb-detail")).position };
  });
  const closedTop = await bodyTop();
  const closed = await style();
  await page.click(".credibytes-badge .cb-toggle");
  const openedTop = await bodyTop();
  const opened = await style();
  r.check("closed badge is not positioned", closed.pos === "static", closed.pos);
  r.check("closed badge claims no z-index", closed.z === "auto", closed.z);
  r.check("open badge is lifted above the ad", opened.pos === "relative" && opened.z === "10",
          JSON.stringify(opened));
  r.check("the analysis panel floats", opened.detailPos === "absolute", opened.detailPos);
  r.check("opening it does not push the ad down", Math.abs(openedTop - closedTop) < 1,
          `${closedTop} -> ${openedTop}`);
  await page.click(".credibytes-badge .cb-toggle");
  const reclosed = await style();
  r.check("closing it drops the lift again", reclosed.pos === "static" && reclosed.z === "auto",
          JSON.stringify(reclosed));
  await page.close();
}

// 5. The Ad Library: inside the card, just above the ad preview, and BELOW a
//    sticky filter bar when scrolled under it — the reported overlap.
{
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/ads/library/?active_status=active&country=PH");
  // z-index auto is the hardest case: any positioned bar, even one that sets no
  // z-index, must still paint over the badge.
  await page.setContent(`<!doctype html><body style="margin:0">
    <div id="filters" style="position:sticky;top:0;height:60px;background:#fff">
      <div role="button">Filters</div><div role="button">Sort by</div>
    </div>
    <div id="grid" style="width:360px">
      <div class="card">
        <div>Library ID: 1963449790957486</div>
        <div>Started running on May 20, 2026</div>
        <div><div role="button">See ad details</div></div>
        <div class="preview">
          <a href="https://www.facebook.com/ACOMph/"><strong><span>ACOM Consumer Finance Corporation</span></strong></a>
          <span>Sponsored</span>
          <div>Your Trusted Cash Loan Partner. Apply online anytime, 24/7!</div>
          <a href="https://l.facebook.com/l.php?u=${encodeURIComponent("https://www.acom.com.ph/")}">WWW.ACOM.COM.PH</a>
        </div>
      </div>
    </div>
    <div style="height:3000px"></div></body>`);
  await load(page);

  const place = await page.evaluate(() => {
    const b = document.querySelector(".credibytes-badge");
    return { parent: b?.parentElement?.className, next: b?.nextElementSibling?.className,
             inset: b?.classList.contains("cb-inset") };
  });
  r.check("Ad Library: badge sits inside the card, just above the ad preview",
          place.parent === "card" && place.next === "preview", JSON.stringify(place));
  r.check("Ad Library: badge is inset from the card edge", place.inset, JSON.stringify(place));

  const hit = await page.evaluate(() => {
    const b = document.querySelector(".credibytes-badge").getBoundingClientRect();
    window.scrollBy(0, b.top - 20);            // badge now sits under the 60px bar
    const nb = document.querySelector(".credibytes-badge").getBoundingClientRect();
    const el = document.elementFromPoint(nb.left + 20, 30);
    return { underBar: nb.top < 60 && nb.bottom > 30,
             onTop: el?.closest("#filters") ? "filters" : el?.className };
  });
  r.check("Ad Library: the filter bar stays on top of the badge scrolled under it",
          hit.underBar && hit.onTop === "filters", JSON.stringify(hit));
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
