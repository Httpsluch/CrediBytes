/**
 * Stage 3 — the undeclared-app detector, on request.
 *
 * Answers Panel 2's "focus on AI detection": Stage 2 decides legitimacy
 * deterministically because a model on that label is provably circular, so the
 * ML that earns its place is here — given a store-linked ad, does this listing
 * look like the ones SEC registrants actually declare?
 *
 * Two things carry most of the risk, and most of these assertions are about
 * them:
 *
 *   1. FEATURE ORDER. The exported trees address features by index. A reordered
 *      list scores every input against the wrong columns and raises nothing.
 *
 *   2. MISSING VALUES. 116 of 130 training rows have at least one NaN — Apple
 *      publishes no install count at all — so the model learned real directions
 *      for them. A field the fetch cannot read must become NaN, never 0: the
 *      historic failure here was regexes that matched nothing and reported
 *      zeros as though they were measurements.
 *
 * Network is never touched. Extraction is exercised against a saved fixture of
 * the structured block Play embeds in its own page.
 */
import { chromium, read, createReporter } from "./_setup.mjs";

const r = createReporter("stage3");
const browser = await chromium.launch({ headless: true });

const page = await browser.newPage();
await page.route("**/*", route =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
await page.goto("https://www.facebook.com/");
// NOTE: no `self` shim here, deliberately.
//
// An earlier version of this suite did `window.self = window` before loading,
// which made a page look enough like a worker to pass — and hid a defect that
// broke the extension outright: the exported model assigned to `window`, the
// service worker has no `window`, importScripts threw, and registration failed
// with status code 15. The whole background script was dead, so scans stopped
// being stored too.
//
// Both files now target globalThis, which is `window` in a page and `self` in a
// worker. Loading them here with no shim proves the page half; the worker half
// is asserted separately below.
await page.addScriptTag({ content: await read("stage3_model.js") });
await page.addScriptTag({ content: await read("stage3.js") });

// ── The exported model ───────────────────────────────────────────────────────
{
  const out = await page.evaluate(() => ({
    features: window.CrediBytesStage3Model.features,
    trees: window.CrediBytesStage3Model.trees.length,
    // Stage 1 must NOT have been overwritten by the shared exporter.
    stage1Present: typeof window.CrediBytesStage1Model,
  }));

  const EXPECTED = ["is_play_store", "install_count_num", "rating_num",
    "review_count_num", "days_since_last_update", "has_privacy_policy",
    "privacy_policy_is_free_host", "developer_name_length", "app_title_length",
    "dev_matches_advertiser", "title_has_loan_keyword", "title_has_cash_keyword",
    "title_has_peso_keyword", "content_rating_is_everyone", "listing_live"];

  r.check("the model ships with all 15 features",
          out.features.length === 15, String(out.features.length));
  // Pinned in order, not as a set. Index IS the addressing scheme.
  r.check("feature ORDER matches the trained model exactly",
          out.features.join(",") === EXPECTED.join(","), out.features.join(","));
  r.check("all 120 trees exported", out.trees === 120, String(out.trees));
  r.check("exporting Stage 3 did not clobber Stage 1",
          out.stage1Present === "undefined", out.stage1Present);
}

// ── Structured extraction, from a fixture ────────────────────────────────────
{
  // The shape Play embeds. Only the paths Stage 3 reads are populated; the rest
  // is padding, which is the point — extraction indexes by position.
  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage3;
    const d = [];
    d[1] = []; d[1][2] = [];
    const f = d[1][2];
    f[0] = ["Peso Cash Loan - Lending App"];
    f[13] = ["1,000,000+", null, 1234567];
    f[51] = [[null, 4.6711235], null, [null, 262940], [null, 58287]];
    f[68] = ["MAKATI LOAN, INC"];
    f[99] = [[null, null, null, null, null, "https://makati-loan.com/privacy"]];
    f[9]  = ["Rated for 3+"];
    f[145] = [[null, [1785324705]]];
    const html =
      `<script>AF_initDataCallback({key: 'ds:5', hash: '1', data:${JSON.stringify(d)}, sideChannel: {}});</script>` +
      `<script>AF_initDataCallback({key: 'ds:3', hash: '2', data:[1,2], sideChannel: {}});</script>`;
    const ds = S.parsePlayDatasets(html);
    return { keys: Object.keys(ds).sort(), title: ds["ds:5"]?.[1]?.[2]?.[0]?.[0] };
  });

  r.check("every embedded dataset is recovered",
          out.keys.join(",") === "ds:3,ds:5", out.keys.join(","));
  r.check("a known path resolves through the structure",
          out.title === "Peso Cash Loan - Lending App", String(out.title));
}

// ── Feature construction ─────────────────────────────────────────────────────
{
  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage3;
    const play = {
      isPlay: 1, title: "Peso Cash Loan - Lending App", developer: "MAKATI LOAN, INC",
      installs: 1234567, rating: 4.67, reviews: 262940,
      updatedMs: Date.now() - 30 * 86400000,
      policy: "https://makati-loan.com/privacy", contentRating: "Rated for 3+",
    };
    const apple = {
      isPlay: 0, title: "Home Credit Philippines", developer: "HC Consumer Finance Philippines, Inc.",
      installs: undefined, rating: 4.79, reviews: 140262,
      updatedMs: Date.now() - 12 * 86400000, policy: "", contentRating: "4+",
    };
    const freeHost = { ...play, policy: "https://pesoloan.blogspot.com/privacy" };
    const bare = { isPlay: 1, title: "", developer: "", contentRating: "" };
    return {
      play: S.buildFeatures3(play, "Makati Loan Inc"),
      apple: S.buildFeatures3(apple, "HC Consumer Finance"),
      free: S.buildFeatures3(freeHost, "Makati Loan Inc"),
      bare: S.buildFeatures3(bare, ""),
      devMismatch: S.buildFeatures3(play, "Totally Unrelated Ventures"),
    };
  });

  r.check("days since update is derived from the timestamp",
          out.play.days_since_last_update === 30,
          String(out.play.days_since_last_update));
  r.check("title keywords are read from the title",
          out.play.title_has_loan_keyword === 1 &&
          out.play.title_has_cash_keyword === 1 &&
          out.play.title_has_peso_keyword === 1, JSON.stringify(out.play));
  r.check("a policy on the app's own domain is not flagged",
          out.play.privacy_policy_is_free_host === 0 && out.play.has_privacy_policy === 1, "");
  r.check("a policy on a free host IS flagged",
          out.free.privacy_policy_is_free_host === 1, String(out.free.privacy_policy_is_free_host));
  r.check("developer matching uses containment, not equality",
          out.play.dev_matches_advertiser === 1, String(out.play.dev_matches_advertiser));
  r.check("an unrelated advertiser does not match",
          out.devMismatch.dev_matches_advertiser === 0,
          String(out.devMismatch.dev_matches_advertiser));

  // The one that matters most.
  r.check("Apple's absent install count becomes undefined, NOT 0",
          out.apple.install_count_num === undefined,
          String(out.apple.install_count_num));
  r.check("an unreadable update date becomes undefined, NOT 0",
          out.bare.days_since_last_update === undefined,
          String(out.bare.days_since_last_update));
  r.check("an unknown developer name leaves the match unknown, not false",
          out.bare.dev_matches_advertiser === undefined,
          String(out.bare.dev_matches_advertiser));
  // A genuinely absent policy IS a real 0 — the field was readable and empty.
  r.check("an absent privacy policy is a real zero, not missing",
          out.bare.has_privacy_policy === 0, String(out.bare.has_privacy_policy));
}

// ── Scoring, including the NaN paths ─────────────────────────────────────────
{
  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage3;
    const declared = {
      isPlay: 1, title: "JuanHand-online cash loan App", developer: "Wefund Lending corp",
      installs: 17392132, rating: 4.67, reviews: 262940,
      updatedMs: Date.now() - 17 * 86400000,
      policy: "https://privacy.juanhand.com/x", contentRating: "Rated for 3+",
    };
    const thin = {
      isPlay: 1, title: "Loan Calculator Pro", developer: "Indie Dev",
      installs: 120, rating: 3.1, reviews: 4,
      updatedMs: Date.now() - 700 * 86400000,
      policy: "https://calcpro.blogspot.com/p/privacy.html", contentRating: "Rated for 3+",
    };
    const allMissing = { isPlay: 1, title: "", developer: "", contentRating: "" };
    const s = (L, adv) => S.score3(S.buildFeatures3(L, adv));
    return {
      declared: s(declared, "Wefund Lending Corp"),
      thin: s(thin, "Smart Finance Tools"),
      missing: s(allMissing, ""),
    };
  });

  const pct = (x) => Math.round(x * 100);
  r.check("an established declared-looking listing scores high",
          out.declared > 0.7, `${pct(out.declared)}%`);
  r.check("a thin listing on a free policy host scores low",
          out.thin < 0.5, `${pct(out.thin)}%`);
  r.check("and the two are clearly separated",
          out.declared - out.thin > 0.3,
          `${pct(out.declared)}% vs ${pct(out.thin)}%`);
  // Every feature NaN must still produce a number — the model learned where to
  // send missing values, so this is a defined path, not an error case.
  r.check("an all-missing listing still scores rather than throwing",
          typeof out.missing === "number" && out.missing >= 0 && out.missing <= 1,
          String(out.missing));
}

// ── It must load where it actually runs: a worker, with no `window` ─────────
//
// This is the assertion that was missing. background.js importScripts these two
// files into an MV3 service worker, where `window` does not exist at all. A
// bare `window.X = ...` throws there, aborts registration, and takes every
// message handler and the scan store down with it — reported as "Service worker
// registration failed. Status code: 15", which names nothing useful.
{
  const worker = await browser.newPage();
  await worker.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await worker.goto("https://www.facebook.com/");

  const out = await worker.evaluate(async ([modelSrc, libSrc]) => {
    // Evaluate both files in a scope where `window` is genuinely unreachable,
    // standing in for the worker global scope.
    const run = new Function("self", "globalThis", "window",
      `"use strict";
${modelSrc}
${libSrc}
return globalThis;`);
    const fakeGlobal = {};
    try {
      run(fakeGlobal, fakeGlobal, undefined);
    } catch (e) {
      return { ok: false, err: String(e) };
    }
    return {
      ok: true,
      hasModel: !!fakeGlobal.CrediBytesStage3Model,
      hasLib: typeof fakeGlobal.CrediBytesStage3 === "object",
    };
  }, [await read("stage3_model.js"), await read("stage3.js")]);

  r.check("both files load with no `window` in scope", out.ok === true,
          out.err || "");
  r.check("the model attaches to the worker global", out.hasModel === true, "");
  r.check("so does the feature builder", out.hasLib === true, "");
  await worker.close();
}

await page.close();
await browser.close();
process.exit(r.finish() ? 1 : 0);
