/**
 * Ad root boundary on the Meta Ad Library.
 *
 * Measured in the live Ad Library: [role="article"] and [data-pagelet] appear
 * ZERO times. climbToAdRoot() therefore fell through to isPlausibleAdRoot(),
 * which returns the first ancestor with a link and 40+ characters — the card's
 * header row. That subtree contains only the advertiser's Facebook page link,
 * so four ACOM ads displaying WWW.ACOM.COM.PH (a domain the SEC has on record)
 * were judged on a facebook.com URL and all read "Name Match Only".
 *
 * The card is now found by anchoring on the Library ID, which each card states
 * exactly once. These tests reproduce the measured nesting: the marker's
 * ancestors run preview (no ID) -> card (one ID) -> grid (one ID per card).
 *
 * The page must really be at /ads/library, because the fix is gated on the
 * pathname so the news feed is untouched — hence route+goto rather than a bare
 * setContent.
 */
import { chromium, read, createReporter, CHROME_SHIM } from "./_setup.mjs";

const r = createReporter("Ad Library ad root");
const browser = await chromium.launch({ headless: true });

async function scanAt(url, html) {
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto(url);
  await page.setContent(html);                 // keeps the URL, replaces the DOM
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("stage1_model.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("stage1.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(3400);             // exceeds BACKEND_WAIT_MS = 2500
  const out = await page.evaluate(() => ({
    payloads: window.__sent.filter(m => m.type === "SAVE_SCAN").map(m => m.payload),
    details: [...document.querySelectorAll(".cb-detail")].map(e => e.textContent),
  }));
  await page.close();
  return out;
}

const LIBRARY_URL = "https://www.facebook.com/ads/library/?active_status=active&country=PH";

// Mirrors the measured card: no [role="article"], no [data-pagelet], the
// destination wrapped in an anchor below the body, and the Library ID above it.
const card = (id, { advertiser, page: fbPage, body, dest, caption }) => `
  <div class="card">
    <div>Library ID: ${id}</div>
    <div>Started running on May 20, 2026</div>
    <div>Platforms</div>
    <div><div role="button">See ad details</div></div>
    <div class="preview">
      <a href="${fbPage}"><strong><span>${advertiser}</span></strong></a>
      <span>Sponsored</span>
      <div>${body}</div>
      ${dest ? `<a href="${dest}">
        <div>${caption}</div>
        <div>Your Trusted CASH LOAN Partner. ACOM Bahala Sa'yo!</div>
        <div>A leading personal loan company in Japan, now growing in the Philippines.</div>
      </a>` : `<div>${caption}</div>`}
    </div>
  </div>`;

const ACOM = {
  advertiser: "ACOM Consumer Finance Corporation",
  page: "https://www.facebook.com/ACOMph/",
  body: "Your Trusted Cash Loan Partner — ACOM Bahala Sa'yo! Need extra funds? " +
        "We're here to help — quickly, safely, and responsibly. Apply online anytime, 24/7!",
  dest: "https://l.facebook.com/l.php?u=" + encodeURIComponent("https://www.acom.com.ph/") + "&h=AbC",
  caption: "WWW.ACOM.COM.PH",
};

// 1. The reported case — the destination anchor is now in scope.
{
  const { payloads, details } = await scanAt(LIBRARY_URL,
    `<div id="grid">${card("1963449790957486", ACOM)}</div>`);
  const p = payloads[0];
  r.check("ACOM card resolves", p?.label === "SEC Verified", `label=${p?.label}`);
  r.check("matched the right registrant", /acom/i.test(p?.company || ""), `company=${p?.company}`);
  r.check("resolved via the real link, not the caption",
          !details.some(d => /displayed link/i.test(d)), details.join(" | ").slice(0, 140));
}

// 2. Four cards in one grid. Each must be judged on its OWN card — the grid
//    holds 49 captions in the live DOM, so a root that overshoots would let one
//    card's destination verify another's.
{
  const undeclared = {
    advertiser: "Fint hubnet developers",
    page: "https://www.facebook.com/pesohere/",
    body: "Cash loan online with fast approval! Borrow money instantly, no collateral loan needed.",
    dest: "https://play.google.com/store/apps/details?id=com.pesohere.fastcash",
    caption: "PLAY.GOOGLE.COM",
  };
  const { payloads } = await scanAt(LIBRARY_URL, `<div id="grid">
    ${card("1836997776958472", ACOM)}
    ${card("1963449790957486", undeclared)}
    ${card("2771963636500637", ACOM)}
    ${card("1570209497392960", undeclared)}
  </div>`);

  r.check("all four cards scanned separately", payloads.length === 4, `n=${payloads.length}`);
  const verified = payloads.filter(p => p.label === "SEC Verified").length;
  const flagged  = payloads.filter(p => p.label === "Unregistered App").length;
  r.check("the two ACOM cards verify", verified === 2, `verified=${verified}`);
  r.check("the two undeclared cards are still flagged", flagged === 2, `flagged=${flagged}`);
}

// 3. A card with no outbound anchor at all still falls back to the caption.
{
  const { payloads, details } = await scanAt(LIBRARY_URL,
    `<div id="grid">${card("1570209497392960", { ...ACOM, dest: "" })}</div>`);
  r.check("caption fallback still works when no link exists",
          payloads[0]?.label === "SEC Verified", `label=${payloads[0]?.label}`);
  r.check("and discloses that it read the displayed link",
          details.some(d => /displayed link/i.test(d)), details.join(" | ").slice(0, 140));
}

// 4. A lookalike caption must not inherit the registrant's verification.
{
  const { payloads } = await scanAt(LIBRARY_URL,
    `<div id="grid">${card("1570209497392960",
      { ...ACOM, dest: "", caption: "ACOM-LOANS-PH.XYZ" })}</div>`);
  r.check("lookalike caption is not verified",
          payloads[0]?.label !== "SEC Verified", `label=${payloads[0]?.label}`);
}

// 5. REGRESSION — the news feed must be untouched. Same markup shape, but not
//    on /ads/library and with a real post container, so the original path runs.
{
  const { payloads } = await scanAt("https://www.facebook.com/", `
    <div role="article">
      <a href="${ACOM.page}"><strong><span>${ACOM.advertiser}</span></strong></a>
      <span>Sponsored</span>
      <div>${ACOM.body}</div>
      <a href="${ACOM.dest}">Learn more</a>
    </div>`);
  r.check("news feed still resolves through the post container",
          payloads[0]?.label === "SEC Verified", `label=${payloads[0]?.label}`);
}

// 6. A feed ad that only links to Facebook must STILL be Name Match Only — the
//    spoofing protection must not be undone by looking harder for a root.
{
  const { payloads } = await scanAt("https://www.facebook.com/", `
    <div role="article">
      <a href="${ACOM.page}"><strong><span>${ACOM.advertiser}</span></strong></a>
      <span>Sponsored</span>
      <div>${ACOM.body}</div>
      <a href="https://m.me/acomph">Message us</a>
    </div>`);
  r.check("messenger-only feed ad stays Name Match Only",
          payloads[0]?.label === "Name Match Only", `label=${payloads[0]?.label}`);
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
