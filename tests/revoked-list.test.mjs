/**
 * The SEC revoked / suspended list.
 *
 * Panel 1 ("the SEC blacklist ... should be relayed to the users through the
 * extension") and Panel 3 ("app cross check to SEC blacklist") both asked for
 * this. The list itself is 1,413 entries of which 3 carry a SEC registration
 * number, so nearly all of it is reachable only by company NAME.
 *
 * That makes this the one feature where the project's usual failure mode
 * inverts. Everywhere else a wrong answer means "we could not confirm this",
 * which is safe. Here a wrong answer means telling users a licensed lender lost
 * its authority. So the tests below spend most of their effort asserting what
 * the feature must NOT do:
 *
 *   - a name match must never change a verdict
 *   - a name match must never be worded as a finding about the advertiser
 *   - a legitimate ad must stay legitimate when only a name collides
 *
 * and only then that the real path works.
 */
import { chromium, read, createReporter, CHROME_SHIM, SRC, srcUrl } from "./_setup.mjs";

const r = createReporter("revoked list");
const browser = await chromium.launch({ headless: true });

// A registrant flagged revoked, injected on top of the shipped reference so the
// suite does not depend on which companies are currently confirmed. An earlier
// suite pinned com.pesohere.fastcash as an "undeclared" fixture and broke the
// day PesoHere verified — that assertion was measuring registry contents.
const FIXTURE = `
  SEC_REFERENCE.push({
    id: 99001, company: "Testco Revoked Lending Corporation", sec: "CS_TEST_001",
    appName: "Testco Cash", playPkg: "com.testco.revoked", appleId: "",
    website: "testco-revoked.example", playUrl:
      "https://play.google.com/store/apps/details?id=com.testco.revoked",
    appleUrl: "", websiteUrl: "https://testco-revoked.example/",
    revoked: { c: "RL", d: "2025-05-19", n: "TESTCO REVOKED LENDING CORP." },
  });
  SEC_REFERENCE.push({
    id: 99002, company: "Testco Active Lending Corporation", sec: "CS_TEST_002",
    appName: "Testco Active", playPkg: "com.testco.active", appleId: "",
    website: "testco-active.example", playUrl:
      "https://play.google.com/store/apps/details?id=com.testco.active",
    appleUrl: "", websiteUrl: "https://testco-active.example/",
  });
  REVOKED_REFERENCE.push({
    k: "zzz advisory only lending", n: "ZZZ ADVISORY ONLY LENDING CORP.",
    c: "RP", d: "2020-02-12",
  });
`;

async function matcherPage() {
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("revoked_reference.js") });
  await page.addScriptTag({ content: FIXTURE });
  await page.addScriptTag({ content: await read("matcher.js") });
  return page;
}

// ── The list actually shipped ────────────────────────────────────────────────
{
  const page = await matcherPage();
  const out = await page.evaluate(() => ({
    count: window.CrediBytesMatcher.revokedCount,
    sample: window.CrediBytesMatcher.lookupRevoked("163 Lending Corp."),
    suffixInsensitive: !!window.CrediBytesMatcher.lookupRevoked("163 LENDING CORPORATION"),
    // Short and generic keys are dropped at build time; nothing may match them.
    short: window.CrediBytesMatcher.lookupRevoked("ABC"),
    empty: window.CrediBytesMatcher.lookupRevoked(""),
  }));

  r.check("the revoked list is loaded and large", out.count > 1300, String(out.count));
  r.check("a known entry resolves", !!out.sample, JSON.stringify(out.sample));
  r.check("corporate suffix does not change the key", out.suffixInsensitive, "");
  r.check("a short name never matches", out.short === null, JSON.stringify(out.short));
  r.check("an empty name never matches", out.empty === null, "");
  await page.close();
}

// ── Path A — VERDICT. Reached only through a declared URL. ───────────────────
{
  const page = await matcherPage();
  const out = await page.evaluate(() => {
    const M = window.CrediBytesMatcher;
    return {
      revoked: M.matchUrl("https://play.google.com/store/apps/details?id=com.testco.revoked", "", ""),
      active:  M.matchUrl("https://play.google.com/store/apps/details?id=com.testco.active", "", ""),
      site:    M.matchUrl("https://testco-revoked.example/apply", "", ""),
    };
  });

  r.check("a URL-verified revoked registrant changes the verdict",
          out.revoked.legitimacy === "revoked", out.revoked.legitimacy);
  r.check("and is marked as the verdict path",
          out.revoked.revoked?.verdict === true, JSON.stringify(out.revoked.revoked));
  r.check("the reason names the registrant and the withdrawal",
          /Testco Revoked Lending/.test(out.revoked.reason) &&
          /revoked list/i.test(out.revoked.reason), out.revoked.reason);
  r.check("the date reaches the result", out.revoked.revoked?.d === "2025-05-19",
          String(out.revoked.revoked?.d));
  r.check("the evidence trail records it as a failure",
          out.revoked.evidence.some(e => e.state === "fail" && /revoked list/i.test(e.text)),
          JSON.stringify(out.revoked.evidence));
  r.check("the matched ref is still returned so channels can be shown",
          out.revoked.ref?.sec === "CS_TEST_001", String(out.revoked.ref?.sec));

  r.check("website verification reaches the same verdict",
          out.site.legitimacy === "revoked", out.site.legitimacy);

  // The control. Same shape of ad, registrant not flagged.
  r.check("an unflagged registrant is untouched",
          out.active.legitimacy === "legitimate", out.active.legitimacy);
  r.check("and carries no revoked field", !out.active.revoked,
          JSON.stringify(out.active.revoked));
  await page.close();
}

// ── Path B — ADVISORY. A name, and nothing else. ─────────────────────────────
{
  const page = await matcherPage();
  const out = await page.evaluate(() => {
    const M = window.CrediBytesMatcher;
    return {
      // Name on the revoked list, destination proves nothing.
      social: M.matchUrl("https://m.me/somepage", "", "ZZZ Advisory Only Lending Corp."),
      // Name on the revoked list, but the ad VERIFIES against a different,
      // unflagged registrant. The verdict must survive intact.
      verified: M.matchUrl(
        "https://play.google.com/store/apps/details?id=com.testco.active",
        "", "ZZZ Advisory Only Lending Corp."),
      // Unregistered store app whose advertiser name is on the revoked list.
      store: M.matchUrl(
        "https://play.google.com/store/apps/details?id=com.nobody.nothing",
        "", "ZZZ Advisory Only Lending Corp."),
    };
  });

  r.check("an advisory is attached", !!out.social.revoked,
          JSON.stringify(out.social.revoked));
  r.check("and is explicitly NOT the verdict path",
          out.social.revoked?.verdict === false, JSON.stringify(out.social.revoked));
  r.check("the verdict is unchanged by the advisory",
          out.social.legitimacy === "unverified", out.social.legitimacy);
  r.check("the trail wording is hedged, not accusatory",
          out.social.evidence.some(e =>
            /an entity named/i.test(e.text) && /has not been shown to belong/i.test(e.text)),
          JSON.stringify(out.social.evidence));
  r.check("an advisory is recorded as info, never as a failure",
          out.social.evidence.filter(e => /revoked list/i.test(e.text))
                             .every(e => e.state === "info"),
          JSON.stringify(out.social.evidence));

  // The single most important assertion in this file.
  r.check("a name collision CANNOT demote a URL-verified ad",
          out.verified.legitimacy === "legitimate", out.verified.legitimacy);
  r.check("and the advisory still rides along for the reader",
          out.verified.revoked?.verdict === false, JSON.stringify(out.verified.revoked));

  r.check("an unregistered store app keeps its own verdict",
          out.store.legitimacy === "unverified", out.store.legitimacy);
  await page.close();
}

// ── Badge rendering ──────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.setContent(`
    <div role="article">
      <a role="link" href="https://www.facebook.com/x/"><strong><span>Testco Cash</span></strong></a>
      <span>Sponsored</span>
      <div>Cash loan online, fast approval, no collateral.</div>
      <a href="https://play.google.com/store/apps/details?id=com.testco.revoked">Install</a>
    </div>`);
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("revoked_reference.js") });
  await page.addScriptTag({ content: FIXTURE });
  for (const f of ["stage1_model.js", "matcher.js", "stage1.js", "content.js"]) {
    await page.addScriptTag({ content: await read(f) });
  }
  await page.waitForTimeout(3400);

  const out = await page.evaluate(() => {
    const badge = document.querySelector(".credibytes-badge");
    document.querySelector(".cb-toggle")?.click();
    return {
      cls: badge?.className || "",
      bar: document.querySelector(".cb-label")?.textContent || "",
      detail: document.querySelector(".cb-detail")?.textContent || "",
      saved: window.__sent.find(m => m.type === "SAVE_SCAN")?.payload || null,
    };
  });

  r.check("badge uses the revoked class", /cb-revoked/.test(out.cls), out.cls);
  r.check("badge is not also styled as danger", !/cb-danger/.test(out.cls), out.cls);
  r.check("bar text names the state", /AUTHORITY REVOKED/.test(out.bar), out.bar);
  r.check("detail explains the link is genuine",
          /link in this ad is genuine/i.test(out.detail), out.detail.slice(0, 160));
  r.check("detail states what was withdrawn",
          /lending company was revoked/i.test(out.detail), out.detail.slice(0, 200));

  r.check("scan is saved in the revoked tier", out.saved?.tier === "revoked",
          String(out.saved?.tier));
  r.check("scan label is human readable", out.saved?.label === "Authority Revoked",
          String(out.saved?.label));
  r.check("the verdict flag survives into storage",
          out.saved?.revoked?.verdict === true, JSON.stringify(out.saved?.revoked));
  await page.close();
}

// ── Popup: totals, filter and the two detail wordings ────────────────────────
{
  const scans = [
    { ts: Date.now() - 1000, tier: "revoked", legitimacy: "revoked",
      status: "registrant_revoked", label: "Authority Revoked",
      reason: "Registrant appears on the SEC revoked list.",
      advertiserName: "Testco Cash", company: "Testco Revoked Lending Corporation",
      sec: "CS_TEST_001", isStoreUrl: true, evidence: [], contributions: [],
      revoked: { c: "RL", d: "2025-05-19", n: "TESTCO REVOKED LENDING CORP.", verdict: true } },
    { ts: Date.now() - 2000, tier: "unverified", legitimacy: "unverified",
      status: "no_reference_match", label: "Unverified", reason: "No match.",
      advertiserName: "ZZZ Advisory Only Lending Corp.", isStoreUrl: false,
      evidence: [], contributions: [],
      revoked: { c: "RP", d: "2020-02-12", n: "ZZZ ADVISORY ONLY LENDING CORP.", verdict: false } },
    { ts: Date.now() - 3000, tier: "danger", legitimacy: "unverified",
      status: "no_reference_match", label: "Unregistered App", isStoreUrl: true,
      reason: "No match.", advertiserName: "Other", evidence: [], contributions: [] },
  ];

  const page = await browser.newPage({ viewport: { width: 360, height: 700 } });
  await page.route("**/popup.js", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(srcUrl("popup.html"));
  await page.addScriptTag({ content:
    `window.chrome={storage:{local:{get:(k,cb)=>cb({scans:${JSON.stringify(scans)},totals:null,settings:{}}),` +
    `set:(o,cb)=>cb&&cb()},onChanged:{addListener(){}}},` +
    `runtime:{sendMessage:(m,cb)=>cb&&cb({ok:true}),getManifest:()=>({version:"1.2.0"})},` +
    `tabs:{query:(q,cb)=>cb([])},sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(250);

  const tiles = await page.evaluate(() => ({
    legit: document.getElementById("count-legit").textContent,
    unver: document.getElementById("count-unverified").textContent,
    danger: document.getElementById("count-danger").textContent,
    cards: document.querySelectorAll(".scan-item").length,
  }));
  // The regression this guards: counts[tierOf(s)]++ against a literal that had
  // no `revoked` key produced NaN and blanked the tile.
  r.check("the flagged tile counts revoked alongside unregistered",
          tiles.danger === "2", tiles.danger);
  r.check("no tile reads NaN",
          ![tiles.legit, tiles.unver, tiles.danger].some(v => /NaN/.test(v)),
          JSON.stringify(tiles));
  r.check("all three scans render", tiles.cards === 3, String(tiles.cards));

  await page.click(".stat[data-filter='unregistered']");
  await page.waitForTimeout(120);
  const filtered = await page.evaluate(() =>
    [...document.querySelectorAll(".scan-item")].length);
  r.check("the flagged filter returns exactly the tile's count", filtered === 2,
          String(filtered));

  await page.click(".stat[data-filter='unregistered']");   // clear
  await page.waitForTimeout(120);

  const texts = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".scan-item")];
    items[0].click(); items[1].click();
    return [...document.querySelectorAll(".scan-detail")].map(d => d.textContent);
  });
  const verdictText  = texts.find(t => /link in this ad is genuine/i.test(t));
  const advisoryText = texts.find(t => /name match only/i.test(t));

  r.check("the verdict card states the link is genuine", !!verdictText,
          JSON.stringify(texts).slice(0, 200));
  r.check("the advisory card is headed as a name match",
          !!advisoryText && /Name appears on the SEC revoked list/i.test(advisoryText),
          (advisoryText || "").slice(0, 160));
  r.check("the advisory card tells the reader not to conclude",
          !!advisoryText && /reason to verify, not as a conclusion/i.test(advisoryText),
          (advisoryText || "").slice(0, 200));
  // The two must not be interchangeable.
  r.check("the advisory never claims the link is genuine",
          !!advisoryText && !/link in this ad is genuine/i.test(advisoryText), "");
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
