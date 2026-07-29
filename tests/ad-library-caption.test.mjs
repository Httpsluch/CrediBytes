/**
 * Meta Ad Library previews expose no outbound link.
 *
 * Reported: ACOM ads in the Ad Library stayed "Name Match Only" even though the
 * card shows WWW.ACOM.COM.PH — a domain the SEC has on record. The preview's
 * call to action is an internal "See details" control, so there is no href and
 * no data-lynx-uri to resolve; the destination exists only as a caption Meta
 * renders from the real target.
 *
 * The caption is therefore used, but only when no outbound link exists, and only
 * when an element's ENTIRE text is a bare domain. Scanning ad copy for
 * domain-shaped strings would be trivially spoofable.
 */
import { chromium, read, createReporter, CHROME_SHIM } from "./_setup.mjs";

const r = createReporter("Ad Library caption destination");
const browser = await chromium.launch({ headless: true });

async function scan(html) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${html}</body>`);
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("stage1_model.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("stage1.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(3400);
  const out = await page.evaluate(() => ({
    payload: window.__sent.find(m => m.type === "SAVE_SCAN")?.payload || null,
    detail: document.querySelector(".cb-detail")?.textContent || "",
  }));
  await page.close();
  return out;
}

// Mirrors a real Ad Library card: page link only, "See details" button, and the
// destination rendered as a caption.
const card = (caption, body = "Your Trusted CASH LOAN Partner. Apply online anytime, 24/7! Competitive interest rates.") => `
<div role="article">
  <div>Library ID: 1963449790957486</div>
  <div>Started running on May 20, 2026</div>
  <div><span>Sponsored</span></div>
  <a role="link" href="https://www.facebook.com/ACOMph/"><strong><span>ACOM Consumer Finance Corporation</span></strong></a>
  <div>${body}</div>
  ${caption}
  <div><div>See details</div></div>
</div>`;

// 1. The reported case.
{
  const { payload, detail } = await scan(card(`<div>WWW.ACOM.COM.PH</div>`));
  r.check("caption domain resolves the ad", payload?.label === "SEC Verified",
          `label=${payload?.label}`);
  r.check("matched the right registrant", /acom/i.test(payload?.company || ""),
          `company=${payload?.company}`);
  r.check("badge discloses the destination came from the caption",
          /displayed link/i.test(detail), detail.slice(0, 120));
}

// 2. A real outbound link must still win over a caption.
{
  const { payload } = await scan(card(
    `<div>WWW.ACOM.COM.PH</div>
     <a href="https://play.google.com/store/apps/details?id=com.totally.undeclared">Install</a>`));
  r.check("resolved link outranks the caption",
          payload?.label === "Unregistered App", `label=${payload?.label}`);
}

// 3. Domain-shaped text inside ad COPY must not count — that is spoofable.
{
  const { payload } = await scan(card("", "Cash loan online! Visit acom.com.ph now for your loan."));
  r.check("domain mentioned in body copy is ignored",
          payload?.label === "Name Match Only", `label=${payload?.label}`);
}

// 4. A caption that is not a declared channel stays unverified.
{
  const { payload } = await scan(card(`<div>ACOM-LOANS-PH.XYZ</div>`));
  r.check("lookalike caption is not verified",
          payload?.label !== "SEC Verified", `label=${payload?.label}`);
}

// 5. No caption at all — unchanged behaviour.
{
  const { payload } = await scan(card(""));
  r.check("no caption leaves the verdict on the page link",
          payload?.label === "Name Match Only", `label=${payload?.label}`);
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
