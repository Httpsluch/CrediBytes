/**
 * Stage 1 source precedence.
 *
 * The backend is preferred so the deployed service receives real traffic and
 * its logs reflect usage. The bundled model is the safety net: a spun-down
 * free-tier instance takes 30-60s to boot, and no badge should wait for that.
 *
 * Covers:
 *   - a warm backend wins the race (source=remote)
 *   - a cold/hanging backend falls back within the wait window (source=local)
 *   - an unreachable backend falls back
 *   - the profile score is never lost, whichever path serves it
 */
import { chromium, read, createReporter } from "./_setup.mjs";

const r = createReporter("Stage 1 backend precedence");
const browser = await chromium.launch({ headless: true });

const AD = `
<div role="article">
  <a role="link" href="https://www.facebook.com/p/"><strong><span>Cash Mart Asia Lending Inc.</span></strong></a>
  <span>Sponsored</span>
  <div>Instant cash loan online, apply for loan, walang collateral.</div>
  <a href="https://cashmart.ph/apply">Apply now</a>
</div>`;

// PREDICT answers after `delayMs`; never answers when delayMs is null.
function shim(delayMs, prediction) {
  return `
  window.__store={settings:{scanningEnabled:true,displayMode:"badge"},scans:[]};
  window.__sent=[];
  window.chrome={
    storage:{local:{get:(k,cb)=>cb(window.__store),
                    set:(o,cb)=>{Object.assign(window.__store,o);cb&&cb();}},
             onChanged:{addListener(){}}},
    runtime:{id:"t",lastError:null,sendMessage:(m,cb)=>{
      window.__sent.push(m);
      if (m.type!=="PREDICT" || !cb) { cb && cb({ok:true}); return; }
      ${delayMs === null
        ? "/* never answers — instance still booting */"
        : `setTimeout(()=>cb({ok:true,prediction:${JSON.stringify(prediction)}}), ${delayMs});`}
    }},
  };`;
}

const REMOTE = {
  is_app: true, probability: 0.9111, pct: 91, risk_label: "High",
  risk_desc: "Profile score: 91% — profile strongly matches patterns of SEC-registered OLA platforms.",
  company: "Cash Mart Asia Lending Inc.", source: "remote",
};

async function run(delayMs, prediction) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${AD}</body>`);
  await page.addScriptTag({ content: shim(delayMs, prediction) });
  await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("verdict-view.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("stage1_model.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("stage1.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(4200);          // longer than BACKEND_WAIT_MS
  const out = await page.evaluate(() => {
    const saved = window.__sent.filter(m => m.type === "SAVE_SCAN")[0]?.payload;
    return {
      predictSent: window.__sent.filter(m => m.type === "PREDICT").length,
      prob: saved?.prob ?? null,
      riskDesc: saved?.riskDesc ?? null,
      badged: !!document.querySelector(".credibytes-badge"),
    };
  });
  await page.close();
  return out;
}

// 1. Warm backend answers quickly and wins.
{
  const o = await run(150, REMOTE);
  r.check("warm: backend is asked", o.predictSent === 1, `PREDICT=${o.predictSent}`);
  r.check("warm: backend result used", o.prob === 0.9111, `prob=${o.prob}`);
  r.check("warm: ad badged", o.badged, "");
}

// 2. Cold backend never answers — local must fill in.
{
  const t0 = Date.now();
  const o = await run(null);
  r.check("cold: backend still asked (this wakes it)", o.predictSent === 1, `PREDICT=${o.predictSent}`);
  r.check("cold: fell back to local", typeof o.prob === "number" && o.prob !== 0.9111,
          `prob=${o.prob}`);
  r.check("cold: profile score not lost", !!o.riskDesc, `desc=${o.riskDesc}`);
  r.check("cold: ad still badged", o.badged, "");
  r.check("cold: resolved without waiting for the boot", Date.now() - t0 < 12000, "");
}

// 3. Backend answers null (unreachable / non-200).
{
  const o = await run(120, null);
  r.check("unreachable: fell back to local", typeof o.prob === "number", `prob=${o.prob}`);
  r.check("unreachable: profile score present", !!o.riskDesc, "");
}

// 4. Backend answering slower than the wait window must not win.
{
  const o = await run(3500, REMOTE);   // BACKEND_WAIT_MS is 2500
  r.check("slow: local used instead of a late answer",
          o.prob !== 0.9111, `prob=${o.prob}`);
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
