/**
 * The side panel and the popup share popup.html and are told apart by the
 * ?panel=1 query parameter.
 *
 * The earlier layout tests navigated directly to popup.html?panel=1, so they
 * proved the CSS honours the parameter but never that the extension SUPPLIES
 * it. Two chrome.sidePanel.setOptions() calls passed a bare
 * "src/popup.html", which overrides the manifest's default_path — so the panel
 * opened with popup sizing and left dead space below the footer, exactly as
 * reported, while every test passed.
 *
 * These are static source checks plus a runtime fallback check.
 */
import { chromium, SRC, srcUrl, createReporter } from "./_setup.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const r = createReporter("side-panel path wiring");

const popupJs = await fs.readFile(path.join(SRC, "popup.js"), "utf8");
const manifest = JSON.parse(
  await fs.readFile(path.join(SRC, "..", "manifest.json"), "utf8"));

// 1. Manifest default_path must carry the parameter.
r.check("manifest side_panel.default_path has ?panel=1",
        (manifest.side_panel?.default_path || "").includes("panel=1"),
        manifest.side_panel?.default_path);

// 2. Every setOptions({path}) must carry it too, or it overrides the manifest.
const pathArgs = [...popupJs.matchAll(/setOptions\(\{[^}]*?path:\s*([^,}]+)/g)]
  .map(m => m[1].trim());
r.check("setOptions calls specifying a path were found", pathArgs.length > 0,
        `found ${pathArgs.length}`);

const resolved = pathArgs.map(a => {
  if (/^["'`]/.test(a)) return a.replace(/["'`]/g, "");
  const decl = popupJs.match(
    new RegExp(`const\\s+${a}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`));
  return decl ? decl[1] : `<unresolved ${a}>`;
});
r.check("every setOptions path includes ?panel=1",
        resolved.length > 0 && resolved.every(p => p.includes("panel=1")),
        JSON.stringify(resolved));

// 3. No bare "src/popup.html" left as a panel path.
r.check("no bare src/popup.html passed as a panel path",
        !resolved.some(p => p === "src/popup.html"),
        JSON.stringify(resolved));

// 4. Runtime fallback: a tall viewport with NO parameter must still lay out
//    as a panel, covering a stale per-tab path stored by an older build.
const browser = await chromium.launch({ headless: true });
for (const [w, h, param, expectPanel] of [
  [360, 985, "",          true ],   // stale path, tall window -> fallback
  [360, 600, "",          false],   // genuine popup            -> stays popup
  [360, 985, "?panel=1",  true ],   // correct path             -> panel
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(srcUrl("popup.html", param));
  await page.addScriptTag({ content: `window.chrome={storage:{local:{get:(k,cb)=>cb({scans:[],settings:{}}),set:(o,cb)=>cb&&cb()},onChanged:{addListener(){}}},runtime:{id:"t",sendMessage:(m,cb)=>cb&&cb({ok:true})},tabs:{query:(q,cb)=>cb([])},sidePanel:{open(){},setOptions(){return Promise.resolve();}}};` });
  await page.waitForTimeout(250);

  const m = await page.evaluate(() => ({
    isPanel: document.documentElement.classList.contains("is-sidepanel"),
    bodyH: Math.round(document.body.getBoundingClientRect().height),
    footerBottom: Math.round(document.querySelector(".footer").getBoundingClientRect().bottom),
  }));

  const label = `${w}x${h}${param || " (no param)"}`;
  r.check(`${label}: panel layout = ${expectPanel}`, m.isPanel === expectPanel,
          JSON.stringify(m));
  if (expectPanel) {
    r.check(`${label}: footer sits at the bottom, no dead space`,
            Math.abs(m.footerBottom - h) <= 2, `footerBottom=${m.footerBottom} vs ${h}`);
  } else {
    r.check(`${label}: popup keeps its fixed height`,
            Math.abs(m.bodyH - 600) <= 2, `bodyH=${m.bodyH}`);
  }
  await page.close();
}

await browser.close();
process.exit(r.finish() ? 1 : 0);
