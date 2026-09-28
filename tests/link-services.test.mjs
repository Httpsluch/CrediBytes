/**
 * Ads whose link goes through a link service (AppsFlyer OneLink, Adjust,
 * Firebase, bit.ly).
 *
 * No registrant declares those hosts, so judging one judges nothing. A JuanHand
 * ad on juanhand.onelink.me read Unverified while it lands on
 * privacy.juanhand.com, under the declared juanhand.com; the thesis collector
 * followed redirects, and on 48 of 2,164 collected ads the two disagreed.
 *
 * The backend's /resolve is simulated through the chrome shim, in three states:
 * it answers, it refuses, and it never answers (a sleeping Render instance).
 * What the extension SENDS is checked as closely as what it concludes: only
 * link-service links, only for lending ads, never with fbclid.
 */
import { chromium, read, createReporter, CHROME_SHIM } from "./_setup.mjs";

const r = createReporter("Link services");
const browser = await chromium.launch({ headless: true });

const SCRIPTS = ["i18n.js", "verdict-view.js", "sec_reference.js",
                 "revoked_reference.js", "matcher.js", "content.js"];

// RESOLVE_LINK answered from window.__resolve: a reply object, or "never".
const SHIM = CHROME_SHIM.replace(
  "cb && cb({ ok: true, prediction: null });",
  `if (msg.type === "RESOLVE_LINK") {
     const reply = (window.__resolve || {})[msg.url];
     if (reply === "never") return;
     cb && cb(reply || { ok: false, final: null, reason: "no_redirect" });
     return;
   }
   cb && cb({ ok: true, prediction: null });`);

const JUANHAND = "https://juanhand.onelink.me/xOEL/zn6i876x?MEDIASOURCE=Facebook_H5&AGENCY=paipaidai";
const JUANHAND_DEST = "https://privacy.juanhand.com/h5/index.html#/juanhand/web2appA?pid=Facebook_H5";

const wrap = (url) => "https://l.facebook.com/l.php?u=" + encodeURIComponent(url) + "&h=x";

const ad = ({ name, slug, body, dest }) => `
  <article>
    <div><a role="link" href="https://www.facebook.com/${slug}"><strong><span>${name}</span></strong></a>
      <a aria-label="Sponsored" href="/ads/about/?x" role="link"><span>Sponsored</span></a></div>
    <div>${body}</div>
    <a href="${wrap(dest)}">Learn more</a>
  </article>`;

const JUANHAND_AD = ad({ name: "JuanHand", slug: "JuanHandPH",
  body: "Relate na relate kami! Good thing, nandiyan si JuanHand para sa'yo!",
  dest: JUANHAND + "&fbclid=IwAR0abc" });

async function run(html, resolveTable = {}, waitMs = 3400) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${html}</body>`);
  await page.addScriptTag({ content: SHIM });
  await page.addScriptTag({ content: `window.__resolve = ${JSON.stringify(resolveTable)};` });
  for (const f of SCRIPTS) await page.addScriptTag({ content: await read(f) });
  await page.waitForTimeout(waitMs);
  const out = await page.evaluate(() => ({
    saved: window.__sent.filter(m => m.type === "SAVE_SCAN").map(m => m.payload),
    asked: window.__sent.filter(m => m.type === "RESOLVE_LINK").map(m => m.url),
    detail: document.querySelector(".credibytes-badge .cb-detail")?.textContent || "",
  }));
  await page.close();
  return out;
}

// 1. Followed: the verdict is on where the link leads.
{
  const m = await run(JUANHAND_AD, { [JUANHAND]: { ok: true, final: JUANHAND_DEST } });
  const p = m.saved[0];
  r.check("resolved: the link service is followed to its destination",
          p?.destHost === "privacy.juanhand.com", `destHost=${p?.destHost}`);
  r.check("resolved: which verifies under the declared juanhand.com",
          p?.label === "SEC Verified" && /wefund/i.test(p?.company || ""), `${p?.label} / ${p?.company}`);
  r.check("resolved: the service is recorded as what it went through",
          p?.viaHost === "juanhand.onelink.me" && p?.redirect === "resolved", `${p?.viaHost} / ${p?.redirect}`);
  r.check("resolved: the evidence trail says so first",
          p?.evidence?.[0]?.key === "ev.redirected", JSON.stringify(p?.evidence?.[0]));
  r.check("resolved: the badge explains it",
          /goes through juanhand\.onelink\.me.*leads to privacy\.juanhand\.com/i.test(m.detail), m.detail.slice(0, 160));
  r.check("resolved: the destination row names both",
          /privacy\.juanhand\.com \(through juanhand\.onelink\.me\)/.test(m.detail), m.detail.slice(0, 160));
  r.check("fbclid never leaves the browser", m.asked.length === 1 && m.asked[0] === JUANHAND,
          JSON.stringify(m.asked));
}

// 2. The backend could not follow it: judged as shown, and said so.
{
  const m = await run(JUANHAND_AD, { [JUANHAND]: { ok: false, final: null, reason: "no_redirect" } });
  const p = m.saved[0];
  r.check("unresolved: not verified on a host nobody declares", p?.label !== "SEC Verified", p?.label);
  r.check("unresolved: judged on the link as shown",
          p?.destHost === "juanhand.onelink.me" && p?.redirect === "unresolved" && p?.viaHost === "",
          `${p?.destHost} / ${p?.redirect} / via=${JSON.stringify(p?.viaHost)}`);
  r.check("unresolved: the badge says the destination could not be confirmed",
          /could not be\s+confirmed/i.test(m.detail), m.detail.slice(0, 200));
  r.check("unresolved: the destination row does not present the service as the destination",
          /juanhand\.onelink\.me \(a link service/.test(m.detail), m.detail.slice(0, 200));
}

// 3. The backend never answers (asleep): the ad is not held up indefinitely.
{
  const m = await run(JUANHAND_AD, { [JUANHAND]: "never" }, 8000);
  const p = m.saved[0];
  r.check("asleep: the ad is still judged, on the link as shown",
          !!p && p.redirect === "unresolved", JSON.stringify(p && { redirect: p.redirect, label: p.label }));
}

// 4. A link that names its destination is read in the browser, with no request.
{
  const hc = "https://hcphapp.page.link/?link=" + encodeURIComponent("https://app.gma.homecredit.ph/home") +
             "&apn=ph.homecredit.capp&isi=1577894172";
  const m = await run(ad({ name: "Home Credit Philippines", slug: "HomeCreditPH",
    body: "Cash loan hanggang PHP 150,000. Apply now!", dest: hc }));
  const p = m.saved[0];
  r.check("named destination: page.link's link= is read and verifies",
          p?.destHost === "app.gma.homecredit.ph" && p?.label === "SEC Verified", `${p?.destHost} / ${p?.label}`);
  r.check("named destination: recorded as read through the service",
          p?.viaHost === "hcphapp.page.link" && p?.redirect === "read", `${p?.viaHost} / ${p?.redirect}`);
  r.check("named destination: nothing is sent to the server", m.asked.length === 0, JSON.stringify(m.asked));
}

// 5. What is never sent.
{
  const direct = await run(ad({ name: "Kviku Philippines", slug: "KvikuPH",
    body: "Cash loan up to PHP 25,000, no collateral.", dest: "https://kvikuloan.ph/apply" }));
  r.check("an ordinary link is never sent", direct.asked.length === 0 && direct.saved.length === 1,
          `asked=${direct.asked.length} saved=${direct.saved.length}`);

  const game = await run(ad({ name: "Dragon Quest Mobile Game", slug: "DQM",
    body: "Play now and collect rare heroes!", dest: "https://dqm.onelink.me/abc?pid=facebook" }));
  r.check("a non-lending ad's link-service link is never sent",
          game.asked.length === 0 && game.saved.length === 0,
          `asked=${game.asked.length} saved=${game.saved.length}`);
}

// 6. The lists themselves.
{
  const page = await browser.newPage();
  await page.goto("about:blank");
  for (const f of ["i18n.js", "sec_reference.js", "revoked_reference.js", "matcher.js"]) {
    await page.addScriptTag({ content: await read(f) });
  }
  const t = await page.evaluate(() => {
    const M = window.CrediBytesMatcher;
    return {
      onelink: M.isLinkService("https://juanhand.onelink.me/x"),
      lookalike: M.isLinkService("https://onelink.me.evil.example/x"),
      declared: M.isLinkService("https://www.juanhand.com/"),
      afWebDp: M.linkServiceTarget("https://x.onelink.me/a?af_web_dp=" + encodeURIComponent("https://lender.ph/")),
      script: M.linkServiceTarget("https://x.onelink.me/a?af_r=javascript%3Aalert(1)"),
      none: M.linkServiceTarget("https://juanhand.onelink.me/xOEL/zn6i876x?MEDIASOURCE=Facebook_H5"),
    };
  }).catch(e => ({ error: String(e) }));
  await page.close();
  r.check("a link-service subdomain is recognised", t.onelink === true, JSON.stringify(t));
  r.check("a lookalike host is not", t.lookalike === false, JSON.stringify(t));
  r.check("a registrant's own site is not a link service", t.declared === false, JSON.stringify(t));
  r.check("AppsFlyer's desktop destination parameter is read", t.afWebDp === "https://lender.ph/", JSON.stringify(t));
  r.check("a non-web target in a parameter is ignored", t.script === "", JSON.stringify(t));
  r.check("a link that does not name its destination yields nothing", t.none === "", JSON.stringify(t));
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
