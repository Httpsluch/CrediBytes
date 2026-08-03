/**
 * The verdict has to show its working.
 *
 * Two additions are covered here:
 *
 *   A. matcher.js records an ordered trail of what it actually checked, so the
 *      badge can say WHY rather than only WHAT. Before this, a lookalike domain
 *      and a genuine registrant produced verdicts that looked equally arbitrary.
 *
 *   B. stage1.js attributes the profile score to individual signals. A MegaPeso
 *      ad that Stage 2 had verified by exact Apple ID displayed "23%", which read
 *      as self-contradiction; the cause was a registrant with no website on
 *      record, worth ~55 points on its own.
 *
 * The trail is descriptive only. These tests assert it never changes a verdict.
 */
import { chromium, read, createReporter, CHROME_SHIM, SRC, srcUrl } from "./_setup.mjs";

const r = createReporter("analysis detail");
const browser = await chromium.launch({ headless: true });

// ── A. Evidence trail ────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });

  const out = await page.evaluate(() => {
    const M = window.CrediBytesMatcher;
    const run = (u, a, c) => M.matchUrl(u, a, c);
    return {
      verified:  run("https://www.acom.com.ph/", "", ""),
      lookalike: run("https://acom-loans-ph.xyz/apply", "", "Acom Consumer Finance Corporation"),
      store:     run("https://play.google.com/store/apps/details?id=com.nope.nope", "X", "Y"),
      none:      run("", "", ""),
    };
  });

  r.check("verified result carries a trail",
          out.verified.evidence.length > 0, JSON.stringify(out.verified.evidence));
  r.check("a passing check is marked pass",
          out.verified.evidence.some(e => e.state === "pass"), "");
  r.check("verdict itself is unchanged",
          out.verified.legitimacy === "legitimate", out.verified.legitimacy);

  // The important one: the trail must explain the refusal, not just assert it.
  r.check("lookalike trail records the domain failure",
          out.lookalike.evidence.some(e => e.state === "fail" && /declared websites/i.test(e.text)),
          JSON.stringify(out.lookalike.evidence));
  r.check("lookalike is still NOT verified",
          out.lookalike.legitimacy === "name_match_only", out.lookalike.legitimacy);

  r.check("store miss explains why name matching was skipped",
          out.store.evidence.some(e => /skipped/i.test(e.text)),
          JSON.stringify(out.store.evidence));
  r.check("no-url case still reports broken link",
          out.none.legitimacy === "broken_or_missing_link", out.none.legitimacy);

  await page.close();
}

// ── B. Score attribution ─────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.addScriptTag({ content: await read("stage1_model.js") });
  await page.addScriptTag({ content: await read("stage1.js") });

  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage1;
    return {
      noSite:   S.predict("MegaPeso", "", 0),
      withSite: S.predict("MegaPeso", "", 1),
      typical:  S.explain("A".repeat(31), "B".repeat(9), 1),
    };
  });

  r.check("contributions are returned with the prediction",
          Array.isArray(out.noSite.contributions) && out.noSite.contributions.length > 0,
          JSON.stringify(out.noSite.contributions));

  const website = out.noSite.contributions.find(c => c.feature === "has_official_website");
  r.check("the missing website is identified as the driver", !!website, "");
  r.check("and it is a large negative", website && website.points < -20,
          website ? String(website.points) : "absent");

  r.check("supplying the website raises the score",
          out.withSite.pct > out.noSite.pct, `${out.noSite.pct} -> ${out.withSite.pct}`);

  r.check("contributions are ordered by magnitude",
          out.noSite.contributions.every((c, i, a) =>
            i === 0 || Math.abs(a[i - 1].points) >= Math.abs(c.points)), "");

  r.check("labels are human-readable, not feature keys",
          out.noSite.contributions.every(c => !/_/.test(c.label)),
          JSON.stringify(out.noSite.contributions.map(c => c.label)));

  // A registrant sitting exactly on the baseline has nothing to explain.
  r.check("a typical profile reports no drivers", out.typical.length === 0,
          JSON.stringify(out.typical));

  await page.close();
}

// ── Popup: cards expand to show the analysis ─────────────────────────────────
{
  const scans = [{
    ts: Date.now() - 4000, tier: "namematch", legitimacy: "name_match_only",
    status: "name_match_only", label: "Name Match Only",
    reason: "Company name matches SEC-registered X.",
    advertiserName: "Pesohere", company: "Super-Space PH Lending Inc",
    sec: "CS2021030008899", officialUrl: "https://example.ph/", isStoreUrl: false,
    prob: 0.78, riskLabel: "High",
    evidence: [
      { state: "info", text: "Destination: m.me" },
      { state: "fail", text: "m.me is not among any registrant's declared websites." },
    ],
    contributions: [{ feature: "has_official_website", label: "known official website", value: 1, points: 38 }],
  }];

  const page = await browser.newPage({ viewport: { width: 360, height: 600 } });
  await page.route("**/popup.js", route => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(srcUrl("popup.html"));
  await page.addScriptTag({ content:
    `window.chrome={storage:{local:{get:(k,cb)=>cb({scans:${JSON.stringify(scans)},totals:null,settings:{}}),set:(o,cb)=>cb&&cb()},onChanged:{addListener(){}}},` +
    `runtime:{sendMessage:(m,cb)=>cb&&cb({ok:true}),getManifest:()=>({version:"1.2.0"})},tabs:{query:(q,cb)=>cb([])},` +
    `sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(250);

  const before = await page.evaluate(() => ({
    cards: document.querySelectorAll(".scan-item").length,
    detail: !!document.querySelector(".scan-detail"),
    gauge: !!document.querySelector(".gauge"),
    expanded: document.querySelector(".scan-item")?.getAttribute("aria-expanded"),
  }));
  r.check("card rendered", before.cards === 1, JSON.stringify(before));
  r.check("gauge shown when a profile score exists", before.gauge === true, "");
  r.check("analysis is collapsed initially", before.detail === false, "");
  r.check("collapsed state announced", before.expanded === "false", String(before.expanded));

  await page.click(".scan-item");
  const after = await page.evaluate(() => {
    const d = document.querySelector(".scan-detail");
    return {
      detail: !!d,
      text: d ? d.textContent : "",
      evItems: document.querySelectorAll(".ev-item").length,
      contribRows: document.querySelectorAll(".contrib-row").length,
      expanded: document.querySelector(".scan-item")?.getAttribute("aria-expanded"),
    };
  });
  r.check("clicking a card opens the analysis", after.detail === true, "");
  r.check("expanded state announced", after.expanded === "true", String(after.expanded));
  r.check("evidence trail rendered", after.evItems === 2, `items=${after.evItems}`);
  r.check("score contributions rendered", after.contribRows === 1, `rows=${after.contribRows}`);
  r.check("registrant details shown", /CS2021030008899/.test(after.text), after.text.slice(0, 90));
  r.check("score is labelled supplementary",
          /supplementary/i.test(after.text), after.text.slice(0, 120));

  await page.click(".scan-item");
  const closed = await page.evaluate(() => !!document.querySelector(".scan-detail"));
  r.check("clicking again collapses it", closed === false, "");

  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
