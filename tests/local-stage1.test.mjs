/**
 * The bundled Stage 1 model — the safety net behind the backend.
 *
 * The backend is preferred (see backend-precedence.test.mjs) so the deployed
 * service receives real traffic. This suite covers the model itself: that it
 * loads, predicts deterministically, returns the backend's response shape, and
 * takes over whenever the backend does not answer — so a Render cold start can
 * never strip the profile score off a badge.
 *
 * Numerical equivalence with the served model is asserted separately and far
 * more strictly by CrediBytes-Backend/verify_export.py, which diffs against
 * LightGBM itself.
 */
import { chromium, SRC, read, createReporter } from "./_setup.mjs";

const r = createReporter("local Stage 1 evaluation");

const AD = `
<div role="article" id="ad1">
  <span>Sponsored</span>
  <h3><a role="link" href="https://www.facebook.com/x"><span>Kviku Loan</span></a></h3>
  <div>Cash loan up to PHP 25,000, approved in 5 minutes, walang collateral.</div>
  <a href="https://kvikuloan.ph/apply">Apply now</a>
</div>`;

// A shim whose sendMessage NEVER answers, standing in for a cold-started
// backend. If the local path is working, the badge must not depend on it.
const DEAD_BACKEND_SHIM = `
window.__store={settings:{scanningEnabled:true,displayMode:"badge"},scans:[]};
window.__sent=[];
window.chrome={
  storage:{local:{get:(k,cb)=>cb(window.__store),
                  set:(o,cb)=>{Object.assign(window.__store,o);cb&&cb();}},
           onChanged:{addListener(){}}},
  runtime:{id:"t",lastError:null,
           sendMessage:(m,cb)=>{ window.__sent.push(m); /* never calls cb */ }},
};`;

const browser = await chromium.launch({ headless: true });

// ── 1. Model loads and predicts without any messaging ───────────────────────
{
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: await read("stage1_model.js") });
  await page.addScriptTag({ content: await read("stage1.js") });

  const m = await page.evaluate(() => {
    const s = window.CrediBytesStage1;
    return {
      ready: s.isReady(),
      trees: window.CrediBytesStage1Model.trees.length,
      features: window.CrediBytesStage1Model.features.length,
      withSite:    s.predict("Cash Mart Asia Lending Inc.", "Cash Mart", 1),
      withoutSite: s.predict("Cash Mart Asia Lending Inc.", "Cash Mart", 0),
    };
  });

  r.check("model reports ready", m.ready === true, JSON.stringify(m.ready));
  r.check("100 trees bundled", m.trees === 100, `trees=${m.trees}`);
  r.check("7 features", m.features === 7, `features=${m.features}`);
  r.check("returns the backend's response shape",
          m.withSite && "probability" in m.withSite && "risk_label" in m.withSite
            && "risk_desc" in m.withSite && "pct" in m.withSite,
          JSON.stringify(m.withSite));
  r.check("tagged source=local", m.withSite?.source === "local", m.withSite?.source);

  // The train/serve fix, observable end to end: this feature must move the score.
  r.check("has_official_website changes the prediction",
          m.withSite.probability !== m.withoutSite.probability,
          `${m.withoutSite.probability} vs ${m.withSite.probability}`);
  r.check("known registered lender scores High with its website",
          m.withSite.risk_label === "High",
          `${m.withSite.risk_label} @ ${m.withSite.probability}`);

  // Determinism — no randomness anywhere in the walk.
  const again = await page.evaluate(() =>
    window.CrediBytesStage1.predict("Cash Mart Asia Lending Inc.", "Cash Mart", 1).probability);
  r.check("deterministic across calls", again === m.withSite.probability,
          `${again} vs ${m.withSite.probability}`);
  await page.close();
}

// ── 2. Full pipeline with a backend that never responds ─────────────────────
{
  const page = await browser.newPage();
  let networkCalls = 0;
  await page.route("**://credibytes-backend.onrender.com/**", route => {
    networkCalls++; route.abort();
  });

  await page.setContent(`<!doctype html><body>${AD}</body>`);
  await page.addScriptTag({ content: DEAD_BACKEND_SHIM });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("stage1_model.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("stage1.js") });
  await page.addScriptTag({ content: await read("content.js") });
  // Must exceed BACKEND_WAIT_MS (2500ms) — the fallback is on a timer, since a
  // booting instance never answers at all rather than answering with an error.
  await page.waitForTimeout(3600);

  const res = await page.evaluate(() => {
    const badge = document.querySelector(".credibytes-badge");
    const saved = window.__sent.filter(m => m.type === "SAVE_SCAN")[0]?.payload;
    return {
      badged: !!badge,
      predictSent: window.__sent.filter(m => m.type === "PREDICT").length,
      riskDesc: saved?.riskDesc || null,
      prob: saved?.prob ?? null,
      detailText: badge?.querySelector(".cb-detail")?.textContent || "",
    };
  });

  r.check("ad still badged with backend unreachable", res.badged, "");
  // Backend-first by design: the deployed service must receive the traffic so
  // its logs reflect real usage. The local model is the safety net, not the
  // default. (This assertion was inverted when the order was local-first.)
  r.check("backend is asked first", res.predictSent === 1,
          `PREDICT messages=${res.predictSent}`);
  r.check("content script makes no direct network call", networkCalls === 0,
          `calls=${networkCalls}`);
  r.check("local model fills in when the backend never answers",
          typeof res.prob === "number" && !!res.riskDesc,
          `prob=${res.prob} desc=${res.riskDesc}`);
  r.check("badge detail shows the profile signal",
          /Profile score: \d+%/.test(res.detailText),
          res.detailText.slice(0, 90));
  await page.close();
}

// ── 3. Backend fallback when the model is absent ────────────────────────────
{
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${AD}</body>`);
  // stage1_model.js deliberately NOT loaded.
  await page.addScriptTag({ content: DEAD_BACKEND_SHIM });
  await page.addScriptTag({ content: await read("sec_reference.js") });
  await page.addScriptTag({ content: await read("matcher.js") });
  await page.addScriptTag({ content: await read("stage1.js") });
  await page.addScriptTag({ content: await read("content.js") });
  await page.waitForTimeout(900);

  const res = await page.evaluate(() => ({
    ready: window.CrediBytesStage1.isReady(),
    predictSent: window.__sent.filter(m => m.type === "PREDICT").length,
  }));
  r.check("isReady() false when the model is missing", res.ready === false, "");
  // With no bundled model there is no safety net, so the backend is the only
  // source — it is still asked exactly once.
  r.check("backend is the sole source in that case",
          res.predictSent === 1, `PREDICT messages=${res.predictSent}`);
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
