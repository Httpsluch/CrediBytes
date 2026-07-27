import { chromium, SRC, read, srcUrl, CHROME_SHIM } from "./_setup.mjs";
// Kviku ad as it actually appears: page name in the header beside "Sponsored",
// and an UNRELATED person's name lower down (reactions / adjacent content).
// The old whole-subtree scan picked the wrong one.
const KVIKU = `
<div class="feed">
  <div class="x1lliihq">
    <div class="hdr">
      <div><span><a role="link" href="https://www.facebook.com/KvikuLoanPH/"><strong><span>Kviku Loan</span></strong></a></span></div>
      <div><span class="x4k7w5x">Sponsored</span></div>
    </div>
    <div>Cash loan up to PHP 25,000, approved in as fast as 5 minutes! 100% online, 1 valid ID lang, walang collateral. Tap Apply Now.</div>
    <a href="https://kvikuloan.ph/apply">Apply now</a>
    <div class="engagement"><h3><a role="link" href="https://www.facebook.com/sherleen"><span>Sherleen Toca</span></a></h3><span>2</span></div>
  </div>
</div>`;

const browser = await chromium.launch({ headless: true });
const results = [];
const check = (n, c, d) => results.push({ n, pass: !!c, d });

// 3. Correct advertiser name
{
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${KVIKU}</body>`);
  await page.addScriptTag({ content: CHROME_SHIM });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(500);
  const p = await page.evaluate(() => window.__sent.find(m => m.type === "SAVE_SCAN")?.payload);
  check("kviku: advertiser is 'Kviku Loan', not 'Sherleen Toca'",
        p?.advertiserName === "Kviku Loan", `got=${JSON.stringify(p?.advertiserName)}`);
  check("kviku: still flagged Unverified", p?.label === "Unverified", p?.label);
  check("kviku: suggestion resolves", /kviku/i.test(p?.suggestion?.company || ""),
        JSON.stringify(p?.suggestion));
  await page.close();
}

// 2. Height — side panel at NARROW width (the reported bug: 359px)
for (const [w, h] of [[359, 900], [367, 700], [500, 800]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route("**/popup.js", r => r.fulfill({ status:200, contentType:"text/javascript", body:"" }));
  await page.goto(srcUrl("popup.html", "?panel=1"));
  await page.waitForTimeout(150);
  const m = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains("is-sidepanel"),
    bodyH: Math.round(document.body.getBoundingClientRect().height),
    feedH: Math.round(document.querySelector(".feed").getBoundingClientRect().height),
    footerBottom: Math.round(document.querySelector(".footer").getBoundingClientRect().bottom),
  }));
  check(`panel ${w}x${h}: detected as side panel`, m.cls, JSON.stringify(m));
  check(`panel ${w}x${h}: body fills viewport`, Math.abs(m.bodyH - h) <= 2, `bodyH=${m.bodyH} vs ${h}`);
  check(`panel ${w}x${h}: footer at bottom (no dead space)`,
        Math.abs(m.footerBottom - h) <= 2, `footerBottom=${m.footerBottom} vs ${h}`);
  check(`panel ${w}x${h}: feed has room`, m.feedH > 200, `feedH=${m.feedH}`);
  await page.close();
}

// 2b. Popup (no ?panel) keeps its fixed height
{
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page.route("**/popup.js", r => r.fulfill({ status:200, contentType:"text/javascript", body:"" }));
  await page.goto(srcUrl("popup.html"));
  await page.waitForTimeout(150);
  const m = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains("is-sidepanel"),
    bodyH: Math.round(document.body.getBoundingClientRect().height),
    feedH: Math.round(document.querySelector(".feed").getBoundingClientRect().height),
  }));
  check("popup: NOT flagged as side panel", m.cls === false, String(m.cls));
  check("popup: fixed 560px height", Math.abs(m.bodyH - 560) <= 2, `bodyH=${m.bodyH}`);
  check("popup: feed not collapsed", m.feedH > 150, `feedH=${m.feedH}`);
  await page.close();
}

// 4. Live timestamps
{
  const scans = [{ ts: Date.now() - 2000, legitimacy:"unverified", status:"no_reference_match",
                   label:"Unverified", reason:"test", advertiserName:"Test Co", isStoreUrl:false }];
  const page = await browser.newPage({ viewport:{width:360,height:600} });
  await page.route("**/popup.js", r => r.fulfill({ status:200, contentType:"text/javascript", body:"" }));
  await page.goto(srcUrl("popup.html"));
  await page.addScriptTag({ content: `window.chrome={storage:{local:{get:(k,cb)=>cb({scans:${JSON.stringify(scans)},settings:{}}),set:(o,cb)=>cb&&cb()},onChanged:{addListener(){}}},runtime:{sendMessage:(m,cb)=>cb&&cb({ok:true})},tabs:{query:(q,cb)=>cb([])},sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
  await page.addScriptTag({ path: SRC + "/popup.js" });
  await page.waitForTimeout(200);
  const t1 = await page.textContent(".scan-time");
  await page.waitForTimeout(3500);
  const t2 = await page.textContent(".scan-time");
  check("timestamps tick live without re-render", t1 !== t2, `"${t1}" -> "${t2}"`);
  check("timestamp has data-ts for cheap updates",
        await page.getAttribute(".scan-time", "data-ts") !== null, "");
  await page.close();
}

console.log("");
let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.n}${r.pass ? "" : "   -> " + r.d}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
