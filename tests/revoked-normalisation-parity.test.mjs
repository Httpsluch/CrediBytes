/**
 * Python and JavaScript must normalise revoked-list company names identically.
 *
 * build_revoked_reference.py writes the KEYS; matcher.js computes the key it
 * LOOKS UP. If the two ever disagree, nothing throws and no test elsewhere
 * fails — the shipped entries simply become unreachable and every advisory
 * silently stops firing. That is the same class of failure as the old
 * update_sec_reference.py, which emitted correct-looking records whose every
 * field read `undefined` while the extension kept running normally.
 *
 * The fixture is committed, so this check runs by default — a guard against a
 * silent failure is worth little if it only runs when someone remembers to
 * generate its input. Regenerate it with `python export_revoked_names.py`
 * whenever the revoked list changes.
 *
 * It still SKIPS rather than fails when absent: a missing fixture is a defect in
 * the checkout, not in the code under test, and a red suite would point at the
 * wrong thing.
 */
import { readFileSync, existsSync } from "node:fs";
import { chromium, read, createReporter } from "./_setup.mjs";

const r = createReporter("revoked normalisation parity");

const FIXTURE = process.env.CB_REVOKED_FIXTURE ||
  "tests/fixtures/revoked_names.json";

if (!existsSync(FIXTURE)) {
  console.log(`  SKIP  fixture not found: ${FIXTURE}`);
  console.log("        regenerate with: python export_revoked_names.py");
  process.exit(0);
}

const { names, python } = JSON.parse(readFileSync(FIXTURE, "utf8"));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route("**/*", route =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
await page.goto("https://www.facebook.com/");
await page.addScriptTag({ content: await read("i18n.js") });
  await page.addScriptTag({ content: await read("verdict-view.js") });
  await page.addScriptTag({ content: await read("sec_reference.js") });
await page.addScriptTag({ content: await read("revoked_reference.js") });
await page.addScriptTag({ content: await read("matcher.js") });

const found = await page.evaluate(
  ns => ns.map(n => { const e = window.CrediBytesMatcher.lookupRevoked(n); return e ? e.k : null; }),
  names);

let unreachable = 0, mismatch = 0, skippedShort = 0;
const examples = [];
for (let i = 0; i < names.length; i++) {
  if (python[i].length < 6) { skippedShort++; continue; }   // dropped at build time
  if (found[i] === null) {
    unreachable++;
    if (examples.length < 5) examples.push(`UNREACHABLE ${names[i]} -> "${python[i]}"`);
  } else if (found[i] !== python[i]) {
    mismatch++;
    if (examples.length < 5) examples.push(`MISMATCH ${names[i]}: py="${python[i]}" js="${found[i]}"`);
  }
}

r.check(`every shipped key is reachable from its source name (${names.length} names)`,
        unreachable === 0, `${unreachable} unreachable — ${examples.join(" | ")}`);
r.check("the two normalisers agree on every key",
        mismatch === 0, `${mismatch} mismatched — ${examples.join(" | ")}`);
r.check("short keys were dropped on both sides",
        skippedShort > 0 && skippedShort < names.length, String(skippedShort));

await browser.close();
process.exit(r.finish() ? 1 : 0);
