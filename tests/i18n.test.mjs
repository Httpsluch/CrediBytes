/**
 * English / Tagalog.
 *
 * Panel 1 asked how a digitally or financially illiterate user would be
 * informed. A Filipino reading English verdict text is exactly that user, so
 * the language is a user-facing setting rather than the browser locale.
 *
 * Most of the risk in an i18n layer is silent: a missing key renders blank, a
 * dropped placeholder loses the company name from a sentence that accuses
 * someone, and a stale copy of the string table leaves one surface in the wrong
 * language. These assertions target that class of failure rather than checking
 * that a handful of strings were translated.
 */
import { chromium, read, createReporter, SRC, srcUrl } from "./_setup.mjs";

const r = createReporter("i18n");
const browser = await chromium.launch({ headless: true });

// ── The tables themselves ────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.addScriptTag({ content: await read("i18n.js") });

  const out = await page.evaluate(() => {
    const I = window.CrediBytesI18n;
    const en = Object.keys(I.STRINGS.en), tl = Object.keys(I.STRINGS.tl);
    const ph = s => (String(s).match(/\{(\w+)\}/g) || []).sort().join(",");
    return {
      langs: Object.keys(I.LANGS),
      enCount: en.length,
      missingInTl: en.filter(k => I.STRINGS.tl[k] === undefined),
      extraInTl: tl.filter(k => I.STRINGS.en[k] === undefined),
      // A placeholder dropped in translation silently deletes a company name
      // from a sentence that names one.
      badPlaceholders: en.filter(k => I.STRINGS.tl[k] !== undefined &&
                                      ph(I.STRINGS.en[k]) !== ph(I.STRINGS.tl[k])),
      empty: en.filter(k => !String(I.STRINGS.en[k]).trim() ||
                            !String(I.STRINGS.tl[k] ?? "x").trim()),
      // Untranslated copies are usually an oversight rather than a decision.
      // Proper nouns and codes legitimately match, so this is reported, not failed.
      identical: en.filter(k => I.STRINGS.en[k] === I.STRINGS.tl[k]).length,
    };
  });

  r.check("both languages are offered", out.langs.join(",") === "en,tl", out.langs.join(","));
  r.check("the table is substantial", out.enCount > 120, String(out.enCount));
  r.check("every English key exists in Tagalog", out.missingInTl.length === 0,
          out.missingInTl.slice(0, 8).join(", "));
  r.check("no orphan Tagalog keys", out.extraInTl.length === 0,
          out.extraInTl.slice(0, 8).join(", "));
  r.check("placeholders survive translation", out.badPlaceholders.length === 0,
          out.badPlaceholders.slice(0, 8).join(", "));
  r.check("no blank strings either side", out.empty.length === 0,
          out.empty.slice(0, 8).join(", "));
  r.check("most strings are actually translated", out.identical < out.enCount * 0.15,
          `${out.identical} identical of ${out.enCount}`);
  await page.close();
}

// ── t(): substitution, fallback, nesting ─────────────────────────────────────
{
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.addScriptTag({ content: await read("i18n.js") });

  const out = await page.evaluate(() => {
    const I = window.CrediBytesI18n;
    return {
      sub: I.t("ev.playDeclared", { pkg: "com.x", company: "Acme" }, "en"),
      // A missing key must degrade to the key, never to "" — a blank line in the
      // evidence trail silently removes a step of the reasoning.
      missing: I.t("no.such.key"),
      // An unknown language falls back rather than rendering keys.
      unknownLang: I.t("ui.settings", null, "zz"),
      // A placeholder with no matching param is left visible, not blanked.
      noParam: I.t("ev.playDeclared", { pkg: "com.x" }, "en"),
      // Nested { key, params } — the revoked status clause.
      nested: I.t("ev.revokedVerdict", {
        company: "Acme",
        status: { key: "revoked.on", params: { what: { key: "revoked.RF" }, date: "2025-05-19" } },
      }, "en"),
      nestedTl: I.t("ev.revokedVerdict", {
        company: "Acme",
        status: { key: "revoked.on", params: { what: { key: "revoked.RF" }, date: "2025-05-19" } },
      }, "tl"),
      renderLegacy: I.render({ state: "info", text: "old stored sentence" }, "tl"),
    };
  });

  r.check("placeholders substitute", out.sub === "Play package com.x is declared by Acme.", out.sub);
  r.check("a missing key degrades to the key, not blank", out.missing === "no.such.key", out.missing);
  r.check("an unknown language falls back to English", out.unknownLang === "Settings", out.unknownLang);
  r.check("an unmatched placeholder stays visible", /\{company\}/.test(out.noParam), out.noParam);
  r.check("nested descriptors resolve", /financing company was revoked on 2025-05-19/.test(out.nested),
          out.nested);
  r.check("nested descriptors resolve in Tagalog too",
          /financing company noong 2025-05-19/.test(out.nestedTl), out.nestedTl);
  r.check("pre-i18n stored rows still render",
          out.renderLegacy === "old stored sentence", out.renderLegacy);
  await page.close();
}

// ── The point of keys: a stored scan re-reads in the new language ────────────
{
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  for (const f of ["i18n.js", "sec_reference.js", "revoked_reference.js", "matcher.js"])
    await page.addScriptTag({ content: await read(f) });

  const out = await page.evaluate(() => {
    const M = window.CrediBytesMatcher, I = window.CrediBytesI18n;
    I.setLang("en");
    const res = M.matchUrl("https://goldenfinancing.com/apply", "", "");
    // Exactly what lands in chrome.storage — no live objects, no closures.
    const stored = JSON.parse(JSON.stringify(res.evidence));
    return {
      keyed: stored.every(e => typeof e.key === "string" && e.key.length > 0),
      en: stored.map(e => I.render(e, "en")),
      tl: stored.map(e => I.render(e, "tl")),
      legitimacy: res.legitimacy,
      // Verdicts and statuses are language-independent identifiers.
      reasonKey: res.reasonKey,
    };
  });

  r.check("every trail entry carries a key", out.keyed, JSON.stringify(out.en));
  r.check("a scan stored in English renders in Tagalog",
          out.tl.every((s, i) => s && s !== out.en[i]),
          JSON.stringify({ en: out.en, tl: out.tl }));
  r.check("the revocation clause translates, not just the frame",
          out.tl.some(s => /binawian/i.test(s) && /2025-05-19/.test(s)),
          out.tl.join(" | "));
  r.check("company names are NOT translated",
          out.tl.every(s => !/Golden Legacy/.test(s) || /Golden Legacy/.test(s)) &&
          out.tl.some(s => /The Golden Legacy Financing Corporation/.test(s)),
          out.tl.join(" | "));

  // The verdict must be an identifier, never localised text — background.js and
  // popup.js branch on it, and a translated value would silently break tiering.
  r.check("legitimacy stays a language-independent identifier",
          out.legitimacy === "revoked", out.legitimacy);
  r.check("reasonKey is exposed for re-rendering",
          typeof out.reasonKey === "string" && out.reasonKey.startsWith("reason."),
          String(out.reasonKey));
  await page.close();
}

// ── Badges render in the selected language ───────────────────────────────────
{
  for (const [lang, expect] of [["en", /AD VERIFIED/], ["tl", /VERIFIED ANG AD/]]) {
    const page = await browser.newPage();
    await page.route("**/*", route =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
    await page.goto("https://www.facebook.com/");
    await page.setContent(`
      <div role="article">
        <a role="link" href="https://www.facebook.com/x/"><strong><span>JuanHand</span></strong></a>
        <span>Sponsored</span>
        <div>Cash loan online, fast approval.</div>
        <a href="https://play.google.com/store/apps/details?id=com.juanhand.fast.cash.peso.loan.app">Install</a>
      </div>`);
    await page.addScriptTag({ content:
      `window.__sent=[];window.__listeners=[];
       window.__store={settings:{scanningEnabled:true,displayMode:"badge",lang:"${lang}"},scans:[]};
       window.chrome={storage:{local:{
         get(k,cb){const ks=typeof k==="string"?[k]:(Array.isArray(k)?k:Object.keys(k||{}));
                   const o={};ks.forEach(x=>{if(x in window.__store)o[x]=window.__store[x];});cb&&cb(o);},
         set(o,cb){Object.assign(window.__store,o);cb&&cb();}},
         onChanged:{addListener(fn){window.__listeners.push(fn);}}},
         runtime:{id:"t",lastError:null,sendMessage(m,cb){window.__sent.push(m);cb&&cb({ok:true});}},
         tabs:{query:(q,cb)=>cb([])},
         sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
    for (const f of ["i18n.js", "sec_reference.js", "revoked_reference.js",
                     "stage1_model.js", "matcher.js", "stage1.js", "content.js"])
      await page.addScriptTag({ content: await read(f) });
    await page.waitForTimeout(3400);

    const got = await page.evaluate(() => {
      document.querySelector(".cb-toggle")?.click();
      return {
        bar: document.querySelector(".cb-label")?.textContent || "",
        detail: document.querySelector(".cb-detail")?.textContent || "",
        saved: window.__sent.find(m => m.type === "SAVE_SCAN")?.payload || null,
      };
    });

    r.check(`badge bar renders in ${lang}`, expect.test(got.bar), got.bar);
    r.check(`evidence trail renders in ${lang}`,
            lang === "en" ? /is declared by/.test(got.detail)
                          : /ay idineklara ng/.test(got.detail),
            got.detail.slice(0, 120));
    // The tier is what background.js counts and popup.js colours by. It must be
    // the same identifier in both languages.
    r.check(`tier is language-independent (${lang})`,
            got.saved?.tier === "legitimate", String(got.saved?.tier));
    // The bug this whole refactor exists to prevent: a saved scan holding
    // language-specific text with no way to re-render it.
    r.check(`saved evidence carries keys (${lang})`,
            Array.isArray(got.saved?.evidence) &&
            got.saved.evidence.every(e => typeof e.key === "string"),
            JSON.stringify(got.saved?.evidence?.slice(0, 2)));
    await page.close();
  }
}

// ── Popup: the control, and that it translates everything ────────────────────
{
  const page = await browser.newPage({ viewport: { width: 360, height: 700 } });
  await page.route("**/popup.js", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(srcUrl("popup.html"));
  await page.addScriptTag({ content:
    `window.__saved=null;
     window.chrome={storage:{local:{
       get:(k,cb)=>cb({scans:[],totals:null,settings:{lang:"en"}}),
       set:(o,cb)=>{window.__saved=o;cb&&cb();}},onChanged:{addListener(){}}},
       runtime:{sendMessage:(m,cb)=>cb&&cb({ok:true}),getManifest:()=>({version:"1.2.0"})},
       tabs:{query:(q,cb)=>cb([])},
       sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(200);

  const before = await page.evaluate(() => ({
    buttons: document.querySelectorAll(".seg-btn[data-lang]").length,
    settingsTab: document.querySelector('[data-i18n="ui.settings"]')?.textContent,
    tagged: document.querySelectorAll("[data-i18n]").length,
  }));
  r.check("a language control exists with both options", before.buttons === 2,
          String(before.buttons));
  r.check("static strings are tagged for translation", before.tagged > 20,
          String(before.tagged));
  r.check("English renders by default", before.settingsTab === "Settings", before.settingsTab);

  // The control lives in Settings, which is not the default tab.
  await page.click('.tab[data-tab="settings"]');
  await page.click('.seg-btn[data-lang="tl"]');
  await page.waitForTimeout(150);

  const after = await page.evaluate(() => ({
    settingsTab: document.querySelector('[data-i18n="ui.settings"]')?.textContent,
    htmlLang: document.documentElement.lang,
    checked: document.querySelector('.seg-btn[data-lang="tl"]')?.getAttribute("aria-checked"),
    // Persisted so content.js can pick it up and rebuild the badges.
    saved: window.__saved,
    mirror: localStorage.getItem("cb-lang"),
    // Nothing may be left in English once switched.
    untranslated: [...document.querySelectorAll("[data-i18n]")]
      .filter(el => el.textContent === window.CrediBytesI18n.STRINGS.en[el.dataset.i18n] &&
                    window.CrediBytesI18n.STRINGS.en[el.dataset.i18n] !==
                    window.CrediBytesI18n.STRINGS.tl[el.dataset.i18n])
      .map(el => el.dataset.i18n),
  }));

  r.check("clicking Tagalog translates the UI", after.settingsTab === "Mga Setting",
          after.settingsTab);
  r.check("nothing is left untranslated", after.untranslated.length === 0,
          after.untranslated.join(", "));
  r.check("the choice is announced", after.checked === "true", String(after.checked));
  r.check("<html lang> follows, for screen readers", after.htmlLang === "tl", after.htmlLang);
  r.check("the choice reaches settings, so badges follow",
          after.saved?.settings?.lang === "tl", JSON.stringify(after.saved));
  r.check("and is mirrored for pre-paint", after.mirror === "tl", String(after.mirror));
  await page.close();
}

// ── Switching language re-renders, but must not re-RECORD ───────────────────
//
// Changing the language calls applySettings(), which clears the PROCESSED marks
// and rescans so the badges are rebuilt in the new language. That is by design —
// badge DOM is built once per ad and never touched again, so unlike the theme
// (a class swap) the nodes have to be recreated.
//
// The hazard is that a rescan used to send another SAVE_SCAN for every visible
// ad. background.js increments cumulative totals per save, so flipping a setting
// inflated the tiles and duplicated the feed. Measured before the fix: one ad,
// three settings changes, three saved scans.
//
// This predates the language work — display mode already used the same path —
// which is why the display-mode case is asserted here too.
{
  const page = await browser.newPage();
  await page.route("**/*", route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("https://www.facebook.com/");
  await page.setContent(`
    <div role="article">
      <a role="link" href="https://www.facebook.com/x/"><strong><span>JuanHand</span></strong></a>
      <span>Sponsored</span><div>Cash loan online, fast approval.</div>
      <a href="https://play.google.com/store/apps/details?id=com.juanhand.fast.cash.peso.loan.app">Install</a>
    </div>`);
  await page.addScriptTag({ content:
    `window.__sent=[];window.__listeners=[];
     window.__store={settings:{scanningEnabled:true,displayMode:"badge",lang:"en"},scans:[]};
     window.chrome={storage:{local:{
       get(k,cb){const ks=typeof k==="string"?[k]:(Array.isArray(k)?k:Object.keys(k||{}));
         const o={};ks.forEach(x=>{if(x in window.__store)o[x]=window.__store[x];});cb&&cb(o);},
       set(o,cb){Object.assign(window.__store,o);cb&&cb();}},
       onChanged:{addListener(fn){window.__listeners.push(fn);}}},
       runtime:{id:"t",lastError:null,sendMessage(m,cb){window.__sent.push(m);cb&&cb({ok:true});}},
       tabs:{query:(q,cb)=>cb([])},sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
  for (const f of ["i18n.js", "sec_reference.js", "revoked_reference.js",
                   "stage1_model.js", "matcher.js", "stage1.js", "content.js"])
    await page.addScriptTag({ content: await read(f) });
  await page.waitForTimeout(3400);

  const saves = () => page.evaluate(() =>
    window.__sent.filter(m => m.type === "SAVE_SCAN").length);
  const flip = async (next) => {
    await page.evaluate((s) => {
      window.__store.settings = s;
      window.__listeners.forEach(fn => fn({ settings: { newValue: s } }, "local"));
    }, next);
    await page.waitForTimeout(3400);
  };

  r.check("one ad records one scan", (await saves()) === 1, String(await saves()));

  await flip({ scanningEnabled: true, displayMode: "badge", lang: "tl" });
  r.check("switching language does not record it again", (await saves()) === 1,
          String(await saves()));
  const barTl = await page.evaluate(() => document.querySelector(".cb-label")?.textContent);
  r.check("but the badge IS rebuilt in the new language", /VERIFIED ANG AD/.test(barTl || ""),
          String(barTl));

  await flip({ scanningEnabled: true, displayMode: "badge", lang: "en" });
  r.check("switching back does not record it again", (await saves()) === 1,
          String(await saves()));

  await flip({ scanningEnabled: true, displayMode: "floating", lang: "en" });
  r.check("changing display mode does not record it again", (await saves()) === 1,
          String(await saves()));

  // The mark must not suppress a genuinely new ad.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.setAttribute("role", "article");
    d.innerHTML = `<a role="link" href="https://www.facebook.com/y/"><strong><span>Loan Online</span></strong></a>
      <span>Sponsored</span><div>Cash loan online fast approval</div>
      <a href="https://loanonline.ph/apply">Apply</a>`;
    document.body.appendChild(d);
  });
  await page.waitForTimeout(3400);
  r.check("a genuinely new ad still records", (await saves()) === 2, String(await saves()));
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
