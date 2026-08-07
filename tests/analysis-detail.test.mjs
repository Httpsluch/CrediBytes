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
      // Four words, so platform_name_is_single_word is 0 — the case that used
      // to render as "app name is a single word".
      multiWord: S.explain("MegaPeso", "Mega Peso Cash Loan", 1),
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

  // A label must describe the value the ad ACTUALLY has, not name the feature.
  //
  // Reported from two live badges. An advertiser with no website on record
  // rendered "-25  known official website", and a multi-word app name rendered
  // "+32  app name is a single word". Both read as statements of fact about the
  // ad and both were the reverse of the truth: for a binary feature the number
  // is usually what its ABSENCE is worth. Two of four rows on each card were
  // wrong this way.
  const siteRow = out.noSite.contributions.find(c => c.feature === "has_official_website");
  r.check("an absent website is not labelled as a known one",
          siteRow && /no official website/i.test(siteRow.label),
          siteRow ? siteRow.label : "absent");

  // "MegaPeso" is one word; "Mega Peso Cash Loan" is four. The second must not
  // claim to be a single word just because that is the feature's name.
  const multi = out.multiWord.find(c => c.feature === "platform_name_is_single_word");
  r.check("a multi-word app name is not labelled a single word",
          multi && /several words/i.test(multi.label),
          multi ? multi.label : "absent");
  r.check("and the sign is unchanged by the relabel",
          multi && typeof multi.points === "number" && multi.points !== 0,
          multi ? String(multi.points) : "absent");

  // Length rows carry the number, so a reader can see WHY it moved the score.
  const len = out.noSite.contributions.find(c => c.feature === "company_name_length");
  r.check("length labels state the measured value",
          !len || /\(\d+ chars\)/.test(len.label), len ? len.label : "absent");

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

// ── A backend-served score must carry a breakdown too ────────────────────────
// The backend's /predict returns only the score. A remotely-served ad therefore
// rendered the explanatory note above an EMPTY list — reported from a live
// EZLoan scan. content.js now attributes locally whichever source answered.
{
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.setContent(`
    <div role="article">
      <a role="link" href="https://www.facebook.com/x/"><strong><span>EZLoan</span></strong></a>
      <span>Sponsored</span>
      <div>Cash loan online with fast approval, no collateral loan needed.</div>
      <a href="https://play.google.com/store/apps/details?id=com.sploan.tech.ezloan">Install</a>
    </div>`);

  // Shim answers PREDICT the way the real backend does: no contributions field.
  await page.addScriptTag({ content: `
    window.__sent = []; window.__listeners = [];
    window.__store = { settings: { scanningEnabled: true, displayMode: "badge" }, scans: [] };
    window.chrome = {
      storage: { local: {
        get(k, cb) { const ks = typeof k === "string" ? [k] : (Array.isArray(k) ? k : Object.keys(k || {}));
                     const o = {}; ks.forEach(x => { if (x in window.__store) o[x] = window.__store[x]; }); cb && cb(o); },
        set(o, cb) { Object.assign(window.__store, o); cb && cb(); } },
        onChanged: { addListener(fn) { window.__listeners.push(fn); } } },
      runtime: { id: "t", lastError: null, sendMessage(m, cb) {
        window.__sent.push(m);
        if (m.type === "PREDICT") {
          cb && cb({ ok: true, prediction: { is_app: false, probability: 0.23, pct: 23,
            risk_label: "Low", risk_desc: "Profile score: 23%.", company: "EZLoan", source: "remote" } });
          return;
        }
        cb && cb({ ok: true });
      } },
      tabs: { query: (q, cb) => cb([]) },
      sidePanel: { open() {}, setOptions() { return Promise.resolve(); } },
    };` });
  for (const f of ["sec_reference.js", "stage1_model.js", "matcher.js", "stage1.js", "content.js"]) {
    await page.addScriptTag({ content: await read(f) });
  }
  await page.waitForTimeout(3400);

  const saved = await page.evaluate(() =>
    window.__sent.find(m => m.type === "SAVE_SCAN")?.payload || null);

  r.check("remote score is used", saved?.prob === 0.23, String(saved?.prob));
  r.check("verdict still from Stage 2", saved?.label === "SEC Verified", saved?.label);
  r.check("backend-served scan still gets a breakdown",
          Array.isArray(saved?.contributions) && saved.contributions.length > 0,
          JSON.stringify(saved?.contributions));
  // Deliberately NOT asserting a specific feature here. An earlier version
  // pinned has_official_website, which stopped holding the moment Second Pay
  // Financing's website was verified into the registry — the assertion was
  // measuring registry contents rather than whether attribution happened at all.
  r.check("breakdown entries are well formed",
          saved?.contributions?.every(c => c.label && typeof c.points === "number"),
          JSON.stringify(saved?.contributions));
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
