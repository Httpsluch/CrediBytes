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
    // policy: "" means we LOOKED and found none. Omitting the key entirely now
    // means we never looked, which is a different feature value.
    const bare = { isPlay: 1, title: "", developer: "", contentRating: "", policy: "" };
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
  // A policy we looked for and did not find IS a real 0 — readable and empty.
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

// ── The response the popup actually receives ────────────────────────────────
//
// readListing() returns the listing FLAT; the message handler wraps it once as
// { ok, listing }. An earlier version wrapped it at both levels, so the popup
// got res.listing.listing and every field read undefined. The card still
// rendered — with a single "Privacy policy: none listed" row, because that
// label is a constant string while everything else was missing. Nothing threw,
// and no test noticed, because nothing asserted on the shape.
{
  const out = await page.evaluate(async ([bgSrc, modelSrc, libSrc]) => {
    // Run background.js in a worker-shaped scope and capture what the
    // CHECK_LISTING handler passes to sendResponse.
    let handler = null;
    const g = {
      Map, Set, JSON, Date, Math, Promise, console, URL, RegExp,
      encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, isNaN,
      fetch: async () => ({ ok: true, json: async () => ({ results: [{
        trackName: "Peso Cash Loan", sellerName: "MAKATI LOAN, INC",
        averageUserRating: 4.6, userRatingCount: 9000,
        currentVersionReleaseDate: new Date(Date.now() - 20 * 86400000).toISOString(),
        contentAdvisoryRating: "4+" }] }) }),
      chrome: {
        runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} },
                   onMessage: { addListener(fn) { handler = fn; } }, lastError: null },
        storage: { local: { get: async () => ({}), set: async () => {} },
                   onChanged: { addListener() {} } },
        action: { setPopup: async () => {} },
        sidePanel: { setPanelBehavior: async () => {} },
        tabs: { onUpdated: { addListener() {} }, onActivated: { addListener() {} } },
      },
    };
    g.self = g; g.globalThis = g;

    // importScripts must genuinely evaluate the two files INTO this scope, not
    // borrow the page's copies. stage3.js closes over whatever `fetch` it was
    // loaded with, so handing it the page's objects would leave it calling the
    // page's fetch and never touching the stub below — which is exactly how an
    // earlier version of this test failed with a JSON parse error against the
    // route stub instead of exercising the handler.
    const SOURCES = { "stage3_model.js": modelSrc, "stage3.js": libSrc };
    g.importScripts = (...names) => {
      for (const n of names) {
        new Function("self", "globalThis", "fetch", "console", SOURCES[n])
          .call(g, g, g, g.fetch, console);
      }
    };

    new Function("self", "globalThis", "chrome", "importScripts", "fetch", "console",
                 bgSrc).call(g, g, g, g.chrome, g.importScripts, g.fetch, console);

    if (!handler) return { err: "no message handler registered" };
    const res = await new Promise(resolve => {
      handler({ type: "CHECK_LISTING", url: "https://apps.apple.com/ph/app/x/id123",
                advertiserName: "Makati Loan Inc" }, {}, resolve);
    });
    return { res };
  }, [await read("background.js"), await read("stage3_model.js"), await read("stage3.js")]);

  const L = out.res && out.res.listing;
  r.check("the handler responds ok", out.res && out.res.ok === true,
          JSON.stringify(out.err || out.res).slice(0, 90));
  // The assertion that was missing.
  r.check("listing is FLAT, not double-wrapped",
          !!L && L.listing === undefined, JSON.stringify(L).slice(0, 90));
  r.check("developer reaches the popup", !!L && L.developer === "MAKATI LOAN, INC",
          String(L && L.developer));
  // Installs, rating count and star rating are three separate fields; the unit
  // word lives in the i18n template, not in the value. Combining them hid Play's
  // rating count behind its install count, so the row read "3,199,675 installs"
  // under a heading saying "Ratings".
  r.check("the rating count reaches the popup", !!L && /^9,?000$/.test(L.ratings || ""),
          String(L && L.ratings));
  // This fixture is an Apple listing, and Apple publishes no install count.
  r.check("Apple reports no installs rather than zero", !!L && L.installs === "",
          JSON.stringify(L && L.installs));
  r.check("the star rating is rounded to one decimal",
          !!L && /^\d\.\d$/.test(L.stars || ""), String(L && L.stars));
  r.check("last-updated reaches the popup", !!L && /^\d{4}-\d{2}-\d{2}$/.test(L.updated || ""),
          String(L && L.updated));
  r.check("a score reaches the popup", !!L && typeof L.pct === "number",
          String(L && L.pct));
}

// ── Unknown is not "none" ───────────────────────────────────────────────────
//
// Reported live: every Cashify card read "Privacy policy: none listed", on both
// stores, for apps that plainly have one.
//
// Apple's cause was structural. The iTunes lookup API exposes no privacy field
// at all, so we never looked — but "" became has_privacy_policy = 0, telling the
// model that every Apple app lacks a policy and telling the user something
// false. Training carried real values for all 38 Apple rows because the
// enrichment scraped the store PAGE, so this was a train/serve skew too.
{
  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage3;
    const base = { isPlay: 0, title: "Cashify PH", developer: "SUNLOAN LENDING INVESTORS CORP.",
                   rating: 4.5, reviews: 13369, updatedMs: Date.now() - 3 * 86400000,
                   contentRating: "4+" };
    return {
      unknown: S.buildFeatures3({ ...base, policy: undefined }, "Cashify"),
      absent:  S.buildFeatures3({ ...base, policy: "" }, "Cashify"),
      present: S.buildFeatures3({ ...base, policy: "https://sunloanlending.com/p" }, "Cashify"),
    };
  });

  r.check("a policy we never looked for is undefined, not 0",
          out.unknown.has_privacy_policy === undefined,
          String(out.unknown.has_privacy_policy));
  r.check("and its free-host flag is undefined too",
          out.unknown.privacy_policy_is_free_host === undefined,
          String(out.unknown.privacy_policy_is_free_host));
  // The distinction only means something if a REAL absence still reads as 0.
  r.check("a policy we looked for and did not find IS 0",
          out.absent.has_privacy_policy === 0, String(out.absent.has_privacy_policy));
  r.check("a policy we found is 1",
          out.present.has_privacy_policy === 1, String(out.present.has_privacy_policy));
}

// ── The dataset index is not pinned ─────────────────────────────────────────
//
// Play's ds: numbering is internal ordering and varies by response. Pinning
// ds:5 produced a listing where every field was empty while the card still
// rendered — one row, and a percentage computed from nothing.
{
  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage3;
    const rec = []; rec[1] = []; rec[1][2] = [];
    rec[1][2][0] = ["Cashify PH-Fast and Safe Cash"];
    rec[1][2][68] = ["Sunloan Lending Investors Corporation"];
    // Deliberately NOT ds:5.
    const ds = { "ds:2": [1, 2, 3], "ds:7": rec, "ds:9": null };
    const found = S.findAppDataset(ds);
    let threw = false;
    try { S.assertReadable({ title: "", developer: "" }); } catch (_e) { threw = true; }
    return {
      title: found && found[1][2][0][0],
      none: S.findAppDataset({ "ds:1": [1], "ds:2": null }),
      threw,
    };
  });

  r.check("the app record is found wherever it is keyed",
          out.title === "Cashify PH-Fast and Safe Cash", String(out.title));
  r.check("and nothing is invented when it is absent", out.none === null, String(out.none));
  r.check("an unreadable listing throws instead of scoring blanks",
          out.threw === true, String(out.threw));
}

// ── A string at the title path is not an app record ─────────────────────────
//
// Live bug: most Play responses carry the single letter "i" at exactly the
// title path in ds:11. "First dataset with a non-empty string title" picked it,
// and because "i" is non-empty the readability guard passed too — so the card
// rendered one row and a confident percentage from a coincidence.
//
// Measured on the same page: ds:5 resolved 6 of 6 core fields, ds:11 resolved 1.
{
  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage3;
    const mk = (title, dev, installs) => {
      const rec = []; rec[1] = []; rec[1][2] = [];
      rec[1][2][0] = [title];
      if (dev) rec[1][2][68] = [dev];
      if (installs !== undefined) rec[1][2][13] = [null, null, installs];
      return rec;
    };
    // The decoy is enumerated FIRST, as it is on the live page.
    const ds = {
      "ds:11": mk("i"),
      "ds:5": mk("Mega Peso-Fast Cash Easy Loan", "CEIMMARJ Financing Inc", 1636867),
    };
    const found = S.findAppDataset(ds);
    return {
      title: found && found[1][2][0][0],
      decoyAlone: S.findAppDataset({ "ds:11": mk("i") }),
    };
  });

  r.check("the richest dataset wins, not the first one with a string",
          out.title === "Mega Peso-Fast Cash Easy Loan", String(out.title));
  r.check("an uncorroborated title is refused outright",
          out.decoyAlone === null, String(out.decoyAlone));
}

// ── Data safety: the developer's declaration, quoted not judged (P3-6a) ─────
//
// Fixture markup mirrors the live page: <h2> sections, <h3> categories, and the
// subtypes in the div that follows. Class names are deliberately WRONG here —
// the parser must not depend on Google's obfuscated build output.
{
  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage3;
    const juanhand = `
      <h1 class="Xyz">Data safety</h1>
      <h2 class="q">No data shared with third parties</h2><div>The developer says…</div>
      <h2 class="q">Data collected</h2><div>Data this app may collect</div>
      <h3 class="zzz">Messages</h3><div class="yyy">Emails and SMS or MMS</div>
      <h3 class="zzz">Location</h3><div class="yyy">Approximate location and Precise location</div>
      <h3 class="zzz">Personal info</h3><div class="yyy">Name, Email address, Phone number</div>
      <h3 class="zzz">App info and performance</h3><div class="yyy">Crash logs</div>
      <h2 class="q">Security practices</h2><div>…</div>
      <h3 class="zzz">Data is encrypted in transit</h3><div>Your data is transferred…</div>
      <h3 class="zzz">You can request that data be deleted</h3><div>The developer provides…</div>`;
    const shared = `
      <h1>Data safety</h1>
      <h2>Data shared with third parties</h2><div>x</div>
      <h3>Contacts</h3><div>Contacts</div>
      <h2>Data collected</h2><div>x</div>
      <h3>Financial info</h3><div>User payment info</div>`;
    const clean = `
      <h1>Data safety</h1>
      <h2>No data shared with third parties</h2><div>x</div>
      <h2>No data collected</h2><div>x</div>
      <h2>Security practices</h2><div>x</div>
      <h3>Data is encrypted in transit</h3><div>y</div>`;
    return {
      j: S.parseDataSafety(juanhand),
      s: S.parseDataSafety(shared),
      c: S.parseDataSafety(clean),
      notAPage: S.parseDataSafety("<h3>Contacts</h3><div>Contacts</div>"),
    };
  });

  r.check("collected categories are read in order",
          out.j.collected.map(e => e.category).join("|") ===
          "Messages|Location|Personal info|App info and performance",
          out.j.collected.map(e => e.category).join("|"));
  r.check("subtypes come through with the category",
          out.j.collected[0].detail === "Emails and SMS or MMS", out.j.collected[0].detail);
  r.check("the NPC-relevant categories are flagged",
          out.j.sensitive.includes("Messages") && out.j.sensitive.includes("Location"),
          JSON.stringify(out.j.sensitive));
  // Personal info is near-universal; only the phone-number subtype is the concern.
  r.check("Personal info counts only when it names a phone number",
          out.j.sensitive.includes("Phone number") &&
          !out.j.sensitive.includes("Personal info"), JSON.stringify(out.j.sensitive));
  r.check("App info and performance is not treated as sensitive",
          !out.j.sensitive.includes("App info and performance"), JSON.stringify(out.j.sensitive));
  r.check("security practices are recorded",
          out.j.encrypted === true && out.j.deletable === true,
          `${out.j.encrypted}/${out.j.deletable}`);
  r.check("shared and collected stay in their own sections",
          out.s.shared.map(e => e.category).join() === "Contacts" &&
          out.s.collected.map(e => e.category).join() === "Financial info",
          JSON.stringify(out.s));
  r.check("a genuinely clean declaration reports nothing collected",
          out.c.collected.length === 0 && out.c.shared.length === 0 &&
          out.c.sensitive.length === 0, JSON.stringify(out.c));
  // The distinction the whole feature turns on: a page we could not read must
  // never render as "this app collects nothing".
  r.check("markup that is not the data-safety page yields null, not an empty result",
          out.notAPage === null, JSON.stringify(out.notAPage));
}

// ── Apple's privacy policy comes from the page, not the API ────────────────
//
// The iTunes lookup API exposes no privacy field, so this is scraped — the same
// route enrich_model_features.py took, and where training's real 0/1 for all 38
// Apple rows came from. Serving `undefined` was honest but not what the model
// was trained on; this closes that gap.
{
  const out = await page.evaluate(() => {
    const S = window.CrediBytesStage3;
    // Apple renders its OWN privacy links first on every app page. A naive
    // "first href mentioning privacy" returns apple.com for every app.
    const real = `
      <a href="https://www.apple.com/legal/privacy/">Privacy Policy</a>
      <a href="https://support.apple.com/privacy">Privacy</a>
      <a href="https://cashmart.ph/privacy-policy/">App Privacy Policy</a>`;
    const looseOnly = `<a href="https://lender.example/p">Privacy</a>`;
    const exactWins = `
      <a href="https://lender.example/loose">Privacy notice</a>
      <a href="https://lender.example/exact">Privacy Policy</a>`;
    return {
      real: S.extractPrivacyPolicy(real),
      none: S.extractPrivacyPolicy(`<a href="https://apple.com/legal/privacy/">Privacy Policy</a>`),
      loose: S.extractPrivacyPolicy(looseOnly),
      exact: S.extractPrivacyPolicy(exactWins),
      relative: S.extractPrivacyPolicy(`<a href="/privacy">Privacy Policy</a>`),
    };
  });

  r.check("the developer's policy is found past Apple's own links",
          out.real === "https://cashmart.ph/privacy-policy/", out.real);
  r.check("a page with only platform links yields none", out.none === "", out.real);
  r.check("a loose 'Privacy' anchor still counts",
          out.loose === "https://lender.example/p", out.loose);
  r.check("an exact 'Privacy Policy' outranks a loose match",
          out.exact === "https://lender.example/exact", out.exact);
  r.check("relative hrefs are ignored", out.relative === "", out.relative);
}

await page.close();
await browser.close();
process.exit(r.finish() ? 1 : 0);
