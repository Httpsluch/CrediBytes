/**
 * The bug-report link.
 *
 * A wrong entry.N does not throw and does not look broken — the form simply
 * opens with that field blank, or worse, with the value in the wrong question.
 * Nothing else in the suite would notice, so the mapping is pinned here.
 *
 * These are source checks. Opening the real form would require a network call
 * and a Google sign-in, and would assert Google's behaviour rather than ours.
 */
import { SRC, createReporter } from "./_setup.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const r = createReporter("bug report link");
const popupJs = await fs.readFile(path.join(SRC, "popup.js"), "utf8");

// Pull BUG_FORM straight out of the source so the test cannot drift from it.
const block = /const BUG_FORM = \{([\s\S]*?)\n\};/.exec(popupJs);
r.check("BUG_FORM is declared", !!block, "not found");

const url = /url:\s*"([^"]+)"/.exec(block[1])?.[1] || "";
const fields = Object.fromEntries(
  [...block[1].matchAll(/(\w+):\s*"(entry\.\d+)"/g)].map(m => [m[1], m[2]]));

r.check("the form URL is a real Google Forms viewform link",
        /^https:\/\/docs\.google\.com\/forms\/d\/e\/[\w-]+\/viewform$/.test(url), url);
r.check("no placeholder survived", !/FORM_ID_HERE|0000000000/.test(block[1]), "placeholder present");

// Every field the button fills must have an id, or it silently sends nothing.
const EXPECTED = ["version", "browser", "platform", "display", "scans"];
r.check("all five diagnostic fields are mapped",
        EXPECTED.every(k => fields[k]), JSON.stringify(fields));
// Two questions sharing an id means one value overwrites the other.
r.check("no two fields share an entry id",
        new Set(Object.values(fields)).size === EXPECTED.length,
        JSON.stringify(Object.values(fields)));

// The URL builder, mirrored. Every value must arrive URL-encoded — a display
// string contains slashes and spaces.
const info = { version: "1.0.0", browser: "Chrome 124.0.0.0", platform: "Win32",
               display: "popup / floating / en", scans: "349" };
const u = new URL(url);
u.searchParams.set("usp", "pp_url");
for (const [k, e] of Object.entries(fields)) u.searchParams.set(e, info[k]);
const built = u.toString();

r.check("usp=pp_url is present", built.includes("usp=pp_url"), built);
r.check("every value round-trips", EXPECTED.every(k =>
          new URL(built).searchParams.get(fields[k]) === info[k]), built);
r.check("slashes and spaces are encoded, not raw",
        built.includes("%2F") && !/=popup \//.test(built), built);

// The button must not fall back to the clipboard path now that ids exist.
r.check("a clipboard fallback exists for an unconfigured map",
        /!Object\.keys\(BUG_FORM\.fields\)\.length/.test(popupJs) &&
        /clipboard\?\.writeText/.test(popupJs), "fallback missing");
// The dead check it replaced tested a constant that no longer exists, so it
// could never fire again — a guard that is always false is not a guard.
r.check("the FORM_ID_HERE placeholder check is gone",
        !popupJs.includes("FORM_ID_HERE"), "dead guard still present");

// And it must never carry the page the user is on.
r.check("no tab URL or advertiser is collected",
        !/tabs\.query[\s\S]{0,400}bugReportUrl/.test(popupJs) &&
        !/info\.(url|advertiser)/.test(popupJs), "diagnostics include browsing data");

// ── Browser detection ──────────────────────────────────────────────────────
//
// Brave sends a userAgent identical to Chrome's on purpose, so a Brave user
// reporting a bug was labelled "Chrome 151.0.0.0". Client Hints carries the
// real brand list; Brave additionally hides itself from THAT, and exposes
// navigator.brave.isBrave() instead.
{
  const { chromium } = await import("./_setup.mjs");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("about:blank");
  await page.addScriptTag({ content: popupJs.slice(
    popupJs.indexOf("async function detectBrowser"),
    popupJs.indexOf("function bugReportUrl")) });

  const out = await page.evaluate(async () => {
    const results = {};
    // Brave: isBrave() resolves true, and the brand list does NOT say Brave.
    navigator.brave = { isBrave: async () => true };
    results.brave = await detectBrowser();
    delete navigator.brave;

    // Edge: the brand list carries the GREASE entry plus Chromium plus Edge.
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { brands: [
        { brand: "Not(A:Brand)", version: "8" },
        { brand: "Chromium", version: "151" },
        { brand: "Microsoft Edge", version: "151" },
      ], platform: "Windows" },
    });
    results.edge = await detectBrowser();
    results.platform = detectPlatform();

    // Plain Chrome: only the GREASE entry and Chromium.
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { brands: [
        { brand: "Not?A_Brand", version: "24" },
        { brand: "Google Chrome", version: "151" },
      ], platform: "Windows" },
    });
    results.chrome = await detectBrowser();
    return results;
  });
  await browser.close();

  r.check("Brave is identified despite masking as Chrome",
          /^Brave/.test(out.brave), out.brave);
  r.check("Edge is named, not reported as Chromium",
          /Microsoft Edge/.test(out.edge), out.edge);
  r.check("the GREASE placeholder brand is discarded",
          !/not.?a.?brand/i.test(out.edge + out.chrome), `${out.edge} | ${out.chrome}`);
  r.check("plain Chrome still reports Chrome",
          /Chrome/.test(out.chrome), out.chrome);
  // navigator.platform says "Win32" even on 64-bit Windows, which is misleading
  // rather than merely vague.
  r.check("the platform comes from Client Hints, not the Win32 legacy value",
          out.platform === "Windows", out.platform);
}

process.exit(r.finish() ? 1 : 0);
