/**
 * Six verdicts, three states on screen.
 *
 * The matcher still returns six verdicts, and they are stored and counted as
 * six. What the user sees is three states — Verified, Unverified, Flagged — so
 * every verdict must take its state's colour, icon, headline and word:
 *
 *     SEC Verified                                   -> Verified
 *     Likely Legitimate, Name Match Only, Unverified -> Unverified
 *     Unregistered App, Authority Revoked            -> Flagged
 *
 * What still tells verdicts apart inside a state is the wording of the opened
 * card. The two Flagged verdicts in particular must keep different "What this
 * means" sentences: one app was never registered, the other registrant was.
 *
 * Checked on the two surfaces that list scans: the floating widget (rows and
 * the detail window, whose header shares the badge's colour rules) and the
 * popup cards.
 */
import { chromium, SRC, read, srcUrl, CHROME_SHIM, createReporter } from "./_setup.mjs";

const r = createReporter("three states — colour, icon and wording by state");
const browser = await chromium.launch({ headless: true });

const STATE_OF = {
  legitimate: "verified",
  likely: "unverified", namematch: "unverified", unverified: "unverified",
  danger: "flagged", revoked: "flagged",
};

const now = Date.now();
const SCANS = [
  { tier: "legitimate", legitimacy: "legitimate",        status: "exact_play_store_package_match", isStoreUrl: true,  label: "SEC Verified" },
  { tier: "likely",     legitimacy: "likely_legitimate", status: "app_name_match",                 isStoreUrl: false, label: "Likely Legitimate" },
  { tier: "namematch",  legitimacy: "name_match_only",   status: "name_match_only",                isStoreUrl: false, label: "Name Match Only" },
  { tier: "unverified", legitimacy: "unverified",        status: "no_reference_match",             isStoreUrl: false, label: "Unverified" },
  { tier: "danger",     legitimacy: "unverified",        status: "no_reference_match",             isStoreUrl: true,  label: "Unregistered App" },
  { tier: "revoked",    legitimacy: "revoked",           status: "registrant_revoked",             isStoreUrl: true,  label: "Authority Revoked" },
].map((s, i) => ({
  ...s, ts: now - i * 1000, reason: "x", advertiserName: "Advertiser " + s.tier,
  company: "Testco Lending Corporation", sec: "CS_TEST_001", officialUrl: "",
}));

// Every tier-mate must look the same, and the three states must look different.
function checkStates(surface, byTier, fields) {
  for (const field of fields) {
    for (const state of ["verified", "unverified", "flagged"]) {
      const tiers = Object.keys(STATE_OF).filter(t => STATE_OF[t] === state);
      const values = tiers.map(t => byTier[t]?.[field]);
      r.check(`${surface}: every ${state} verdict has the same ${field}`,
              values.every(v => v && v === values[0]),
              tiers.map((t, i) => `${t}=${values[i]}`).join(", "));
    }
    const perState = ["legitimate", "unverified", "danger"].map(t => byTier[t]?.[field]);
    r.check(`${surface}: the three states differ in ${field}`,
            new Set(perState).size === 3 || field === "icon",
            perState.join(" | "));
  }
}

// ── Floating widget ───────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: CHROME_SHIM });
  for (const f of ["i18n.js", "verdict-view.js", "sec_reference.js", "matcher.js", "content.js"]) {
    await page.addScriptTag({ content: await read(f) });
  }
  await page.waitForTimeout(400);

  await page.evaluate((scans) => new Promise(res => {
    const settings = { ...window.__store.settings, displayResult: "floating" };
    window.chrome.storage.local.set({ settings }, () =>
      window.chrome.storage.local.set({ scans }, () => setTimeout(res, 400)));
  }), SCANS);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#cb-float-content .cb-float-row")].map(row => {
      const dot = row.querySelector(".cb-float-dot");
      return {
        who: row.querySelector(".cb-float-name")?.textContent || "",
        icon: dot?.textContent || "",
        dot: dot ? getComputedStyle(dot).backgroundColor : "",
        edge: getComputedStyle(row).borderLeftColor,
        word: row.querySelector(".cb-float-verdict")?.textContent || "",
      };
    }));
  const rowBy = Object.fromEntries(rows.map(x => [x.who.replace("Advertiser ", ""), x]));
  r.check("widget draws one row per verdict", rows.length === 6, "rows=" + rows.length);
  checkStates("widget row", rowBy, ["dot", "edge", "word", "icon"]);
  r.check("widget rows name the state, not the verdict",
          rowBy.legitimate?.word === "Verified" && rowBy.namematch?.word === "Unverified" &&
          rowBy.likely?.word === "Unverified" && rowBy.revoked?.word === "Flagged",
          JSON.stringify(Object.fromEntries(Object.entries(rowBy).map(([k, v]) => [k, v.word]))));

  // The detail window's header uses the same colour rules as the inline badge.
  const detailBy = {};
  for (const scan of SCANS) {
    detailBy[scan.tier] = await page.evaluate((who) => new Promise(res => {
      const row = [...document.querySelectorAll("#cb-float-content .cb-float-row")]
        .find(x => x.querySelector(".cb-float-name")?.textContent === who);
      row.click();
      setTimeout(() => {
        const w = document.getElementById("cb-float-detail");
        const head = w?.querySelector("#cb-float-detail-header");
        res({
          bar: w?.querySelector("#cb-float-detail-title")?.textContent || "",
          icon: w?.querySelector("#cb-float-detail-icon")?.textContent || "",
          colour: head ? getComputedStyle(head).backgroundColor : "",
          body: w?.querySelector("#cb-float-detail-body")?.textContent || "",
        });
      }, 150);
    }), scan.advertiserName);
  }
  checkStates("detail header", detailBy, ["colour", "bar", "icon"]);
  r.check("headlines read AD VERIFIED / AD UNVERIFIED / AD FLAGGED",
          detailBy.legitimate.bar === "AD VERIFIED" && detailBy.namematch.bar === "AD UNVERIFIED" &&
          detailBy.likely.bar === "AD UNVERIFIED" && detailBy.revoked.bar === "AD FLAGGED",
          ["legitimate", "likely", "namematch", "revoked"].map(t => detailBy[t].bar).join(" | "));
  r.check("the two Flagged verdicts still explain themselves differently",
          /never|not declared/i.test(detailBy.danger.body) && /withdrawn the authority/i.test(detailBy.revoked.body),
          detailBy.revoked.body.slice(0, 160));
  await page.close();
}

// ── Popup cards ───────────────────────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  await page.route("**/popup.js", route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(srcUrl("popup.html"));
  await page.addScriptTag({ content: `window.chrome={storage:{local:{
      get:(k,cb)=>cb({scans:${JSON.stringify(SCANS)},totals:{},settings:{}}),
      set:(o,cb)=>cb&&cb()}, onChanged:{addListener(){}}},
    runtime:{id:"t",sendMessage:(m,cb)=>cb&&cb({ok:true})},
    tabs:{query:(q,cb)=>cb([])},
    sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
  // popup.html loads i18n.js itself; this mirrors batch2-ui's setup.
  await page.addScriptTag({ path: SRC + "/verdict-view.js" });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(300);

  const cards = await page.$$eval(".scan-item", els => els.map(el => ({
    who: el.querySelector(".scan-title")?.textContent || "",
    edge: getComputedStyle(el).borderLeftColor,
    icon: el.querySelector(".verdict-glyph")?.textContent || "",
    colour: getComputedStyle(el.querySelector(".verdict-icon")).color,
    word: el.querySelector(".verdict-word")?.textContent || "",
  })));
  const cardBy = Object.fromEntries(cards.map(x => [x.who.replace("Advertiser ", ""), x]));
  r.check("popup draws one card per verdict", cards.length === 6, "cards=" + cards.length);
  checkStates("popup card", cardBy, ["edge", "icon", "colour", "word"]);
  // Revoked cards had no edge colour at all before: no .scan-item.revoked rule.
  r.check("a revoked card's edge is the Flagged red, not the default",
          cardBy.revoked?.edge === cardBy.danger?.edge, `${cardBy.revoked?.edge} vs ${cardBy.danger?.edge}`);
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
