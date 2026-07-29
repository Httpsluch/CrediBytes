/**
 * Capturing an ad's true destination.
 *
 * Reported: an ACOM ad redirecting to acom.com.ph — a domain the SEC has on
 * record for Acom Consumer Finance Corporation — was flagged "Name Match Only",
 * whose reason line says the ad links to a social page. The matcher handles
 * acom.com.ph correctly on its own, so the destination was never reaching it.
 *
 * Two causes: Facebook keeps the real target in data-lynx-uri while href holds
 * an internal redirect, and unwrapFBRedirect only recognised l.facebook.com.
 */
import { chromium, read, createReporter, CHROME_SHIM } from "./_setup.mjs";

const r = createReporter("ad link capture");
const browser = await chromium.launch({ headless: true });

async function verdictFor(html) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${html}</body>`);
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("stage1_model.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("stage1.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(3400);          // exceeds BACKEND_WAIT_MS
  const out = await page.evaluate(() =>
    window.__sent.find(m => m.type === "SAVE_SCAN")?.payload || null);
  await page.close();
  return out;
}

const ad = (cta) => `
<div role="article">
  <a role="link" href="https://www.facebook.com/ACOMph/"><strong><span>ACOM Consumer Finance Corporation</span></strong></a>
  <span>Sponsored</span>
  <div>Personal loan with low interest. Apply for loan online today.</div>
  ${cta}
</div>`;

// 1. Real destination only in data-lynx-uri — the reported case.
{
  const p = await verdictFor(ad(
    `<a href="https://www.facebook.com/ACOMph/" data-lynx-uri="https://www.acom.com.ph/">Learn more</a>`));
  r.check("data-lynx-uri destination is used", p?.label === "SEC Verified",
          `label=${p?.label}`);
  r.check("resolves to the registrant", /acom/i.test(p?.company || ""),
          `company=${p?.company}`);
}

// 2. Wrapped in each redirect host Facebook uses.
for (const host of ["l.facebook.com", "lm.facebook.com", "l.messenger.com"]) {
  const wrapped = `https://${host}/l.php?u=${encodeURIComponent("https://www.acom.com.ph/")}&h=AbC`;
  const p = await verdictFor(ad(`<a href="${wrapped}">Learn more</a>`));
  r.check(`${host} wrapper is unwrapped`, p?.label === "SEC Verified", `label=${p?.label}`);
}

// 3. Nested wrapper.
{
  const inner = `https://l.facebook.com/l.php?u=${encodeURIComponent("https://www.acom.com.ph/")}`;
  const outer = `https://lm.facebook.com/l.php?u=${encodeURIComponent(inner)}`;
  const p = await verdictFor(ad(`<a href="${outer}">Learn more</a>`));
  r.check("nested wrapper is unwrapped", p?.label === "SEC Verified", `label=${p?.label}`);
}

// 4. Genuinely social-only ads must STILL be Name Match Only — the spoofing
//    protection must not be undone by looking harder for a destination.
{
  const p = await verdictFor(ad(`<a href="https://m.me/acomph">Message us</a>`));
  r.check("messenger-only ad stays Name Match Only",
          p?.label === "Name Match Only", `label=${p?.label}`);
}
{
  const p = await verdictFor(ad(`<a href="https://www.facebook.com/ACOMph/">See page</a>`));
  r.check("facebook-only ad stays Name Match Only",
          p?.label === "Name Match Only", `label=${p?.label}`);
}

// 5. A spoofed lynx target must not inherit the registrant's verification.
{
  const p = await verdictFor(ad(
    `<a href="https://www.facebook.com/x/" data-lynx-uri="https://acom-loans-ph.xyz/apply">Apply</a>`));
  r.check("lookalike domain is not verified", p?.label !== "SEC Verified",
          `label=${p?.label}`);
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
