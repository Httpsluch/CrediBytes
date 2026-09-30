/**
 * Stage 1 runs in the page and nowhere else.
 *
 * It used to go to the backend first — so the deployed service logged real
 * traffic — with the bundled model as the fallback. The two are identical
 * (verify_export.py asserts it), so the round trip changed no score; what it
 * did was send every scanned advertiser's name and app title off the user's
 * machine. This suite pins the replacement down: no PREDICT is ever sent, even
 * if something were listening and ready to answer, and the score is still
 * there, from the bundled model.
 *
 * Replaces backend-precedence.test.mjs, which asserted the race.
 */
import { chromium, read, createReporter } from "./_setup.mjs";

const r = createReporter("Stage 1 in the browser only");
const browser = await chromium.launch({ headless: true });

const AD = `
<div role="article">
  <a role="link" href="https://www.facebook.com/p/"><strong><span>Cash Mart Asia Lending Inc.</span></strong></a>
  <span>Sponsored</span>
  <div>Instant cash loan online, apply for loan, walang collateral.</div>
  <a href="https://cashmart.ph/apply">Apply now</a>
</div>`;

// A chrome shim that WOULD answer PREDICT instantly with a distinctive score,
// as the old backend path did. If that score ever reaches the scan, the
// extension asked.
const SHIM = `
  window.__store={settings:{scanningEnabled:true,displayMode:"badge"},scans:[]};
  window.__sent=[];
  window.chrome={
    storage:{local:{get:(k,cb)=>cb(window.__store),
                    set:(o,cb)=>{Object.assign(window.__store,o);cb&&cb();}},
             onChanged:{addListener(){}}},
    runtime:{id:"t",lastError:null,sendMessage:(m,cb)=>{
      window.__sent.push(m);
      if (m.type === "PREDICT") { cb && cb({ok:true,prediction:{probability:0.9111,risk_desc:"remote",source:"remote"}}); return; }
      cb && cb({ok:true});
    }},
  };`;

async function run({ withModel = true } = {}) {
  const page = await browser.newPage();
  let networkCalls = 0;
  await page.route("**://credibytes-backend.onrender.com/**", route => { networkCalls++; route.abort(); });
  await page.setContent(`<!doctype html><body>${AD}</body>`);
  await page.addScriptTag({ content: SHIM });
  const files = ["i18n.js", "verdict-view.js", "sec_reference.js",
                 ...(withModel ? ["stage1_model.js"] : []), "matcher.js", "stage1.js", "content.js"];
  for (const f of files) await page.addScriptTag({ content: await read(f) });
  await page.waitForTimeout(1500);
  const out = await page.evaluate(() => {
    const saved = window.__sent.filter(m => m.type === "SAVE_SCAN").map(m => m.payload);
    return {
      types: [...new Set(window.__sent.map(m => m.type))],
      saved,
      badged: !!document.querySelector(".credibytes-badge"),
      // The same inputs content.js used: the website flag comes from whether the
      // ad matched a registrant with a declared website, which the scan records.
      expected: window.CrediBytesStage1?.predict(
        "Cash Mart Asia Lending Inc.", "", saved[0]?.officialUrl ? 1 : 0)?.probability ?? null,
    };
  });
  await page.close();
  return { ...out, networkCalls };
}

// 1. With the bundled model.
{
  const o = await run();
  const p = o.saved[0];
  r.check("no PREDICT is ever sent", !o.types.includes("PREDICT"), `messages: ${o.types.join(", ")}`);
  r.check("nothing but the scan itself leaves the content script",
          o.types.length === 1 && o.types[0] === "SAVE_SCAN", `messages: ${o.types.join(", ")}`);
  r.check("no request reaches the backend", o.networkCalls === 0, `calls=${o.networkCalls}`);
  r.check("the ad is badged", o.badged, "");
  r.check("the stored score is the bundled model's, not a relayed one",
          p && p.prob !== 0.9111 && p.prob === o.expected, `stored=${p?.prob} model=${o.expected}`);
  r.check("the profile description and its breakdown are recorded",
          !!p?.riskDesc && Array.isArray(p?.contributions) && p.contributions.length > 0,
          `desc=${p?.riskDesc} contributions=${p?.contributions?.length}`);
}

// 2. Without it: the score is unknown, and recorded as unknown — the backend
//    is not a fallback any more, so nothing is sent to find one.
{
  const o = await run({ withModel: false });
  const p = o.saved[0];
  r.check("model missing: still no PREDICT sent", !o.types.includes("PREDICT"), `messages: ${o.types.join(", ")}`);
  r.check("model missing: the ad is still badged and stored", o.badged && !!p, "");
  r.check("model missing: the score is recorded as unknown, not as a default",
          p?.prob === null && p?.riskDesc === null, `prob=${p?.prob} desc=${p?.riskDesc}`);
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
