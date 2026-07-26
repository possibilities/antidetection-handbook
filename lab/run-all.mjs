// Run the whole suite and write a provenance-stamped result file.
//
// A reference body nobody can re-run is a document with extra steps. This
// records what was actually under test — binary versions, browser build, OS,
// arch — alongside the results, because every finding in FINDINGS.md is
// version-specific and a result without its provenance cannot be compared to a
// later one.
//
//   node run-all.mjs                 # everything runnable with the PATH binary
//   AB_BIN=$(pnpm bin -g)/agent-browser node run-all.mjs
//
// Note the AB_BIN caveat below: the wrapper on PATH in the authoring
// environment turns every launch into a CDP attach, which silently changes the
// subject for anything touching the launch line.

import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LAB_DIR, AB_BIN } from './lib.mjs';

const quiet = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch {
    return null;
  }
};

function provenance() {
  const abVersion = quiet(AB_BIN, ['--version']);
  const chrome = quiet('bash', [
    '-lc',
    `ls -d "$HOME/.cache/ms-playwright"/* 2>/dev/null | head -1; ` +
      `"$(command -v google-chrome || command -v chromium || echo /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome)" --version 2>/dev/null`,
  ]);
  const vendor = {};
  for (const f of readdirSync(join(LAB_DIR, 'vendor'))) {
    vendor[f] = createHash('sha256').update(readFileSync(join(LAB_DIR, 'vendor', f))).digest('hex').slice(0, 16);
  }
  return {
    when: new Date().toISOString(),
    agentBrowser: abVersion,
    agentBrowserBinary: AB_BIN,
    usingWrapper: AB_BIN === 'agent-browser',
    chrome,
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    uname: quiet('uname', ['-mrs']),
    gitCommit: quiet('git', ['-C', LAB_DIR, 'rev-parse', '--short', 'HEAD']),
    vendorDigests: vendor,
  };
}

const prov = provenance();
console.log('provenance:', JSON.stringify(prov, null, 2));

if (prov.usingWrapper) {
  console.log(
    '\n  WARNING: AB_BIN is unset, so `agent-browser` from PATH is under test.\n' +
      '  If that is a wrapper which attaches over --cdp, any result about the\n' +
      '  LAUNCH LINE describes a browser this project did not start. See\n' +
      '  FINDINGS.md, "A confound that invalidated part of an earlier round".\n',
  );
}

const experiments = readdirSync(join(LAB_DIR, 'experiments'))
  .filter((f) => f.endsWith('.mjs'))
  .sort();

const runs = [];
for (const f of experiments) {
  process.stdout.write(`\n>>> ${f}\n`);
  const started = Date.now();
  let output = '';
  let code = 0;
  try {
    output = execFileSync('node', [join(LAB_DIR, 'experiments', f)], {
      encoding: 'utf8',
      timeout: 900_000,
      env: process.env,
    });
  } catch (e) {
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    code = e.status ?? 1;
  }
  console.log(output);
  const confirmed = (output.match(/^CONFIRMED/gm) ?? []).length;
  const refuted = (output.match(/^REFUTED/gm) ?? []).length;
  runs.push({ experiment: f, exitCode: code, confirmed, refuted, seconds: Math.round((Date.now() - started) / 1000) });
}

const out = join(LAB_DIR, 'last-run.json');
writeFileSync(out, JSON.stringify({ provenance: prov, runs }, null, 2));

console.log(`\n${'='.repeat(72)}\nSUITE SUMMARY\n${'='.repeat(72)}`);
for (const r of runs) {
  console.log(`  ${r.experiment.padEnd(38)} ${String(r.confirmed).padStart(2)} confirmed  ${String(r.refuted).padStart(2)} refuted  ${r.seconds}s`);
}
console.log(`\n  written to ${out}`);
console.log(
  '\n  A REFUTED line is not necessarily a failure: several experiments assert\n' +
    '  a claim the document makes, so a refutation means the DOCUMENT is wrong.\n' +
    '  Read the claim text before treating any of this as a red build.\n',
);
