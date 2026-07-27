/**
 * Runs every *.test.mjs in this directory and exits non-zero if any fails.
 *
 *   node tests/run-all.mjs
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const files = (await readdir(HERE)).filter(f => f.endsWith(".test.mjs")).sort();
if (!files.length) {
  console.error("No test files found.");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const code = await new Promise(res => {
    spawn(process.execPath, [path.join(HERE, f)], { stdio: "inherit" })
      .on("close", res);
  });
  if (code !== 0) {
    failed++;
    console.log(`  ^ ${f} exited ${code}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed ? 1 : 0);
