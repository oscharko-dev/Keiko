// `check:local-state` / `audit:local-state` — the maintainer- and CI-runnable local-state audit for
// Issue #1325 (Epic #1319). It proves a local `.keiko` runtime-state tree matches the implemented
// local-at-rest contract (docs/local-runtime-state-contract.md).
//
// Two modes:
//   node scripts/check-local-state.mjs [--state-dir PATH]   audit an existing `.keiko` tree (default
//                                                           <cwd>/.keiko). Read-only; no key needed.
//   node scripts/check-local-state.mjs --self-test          generate a genuinely-encrypted healthy
//                                                           fixture AND a deliberately drifted one,
//                                                           then assert the auditor passes the former
//                                                           and fails the latter. This is the CI gate.
//
// Run with `--experimental-sqlite` on Node 22 (the npm scripts add it). Exit code: 0 on success,
// 1 on an audit failure (or a self-test that did not behave as specified), 2 on a usage error.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditLocalState } from "./lib/local-state-audit.mjs";

const TAG = { pass: "PASS", fail: "FAIL", skip: "skip" };

function reportAudit(label, result) {
  console.log(`\n${label} — ${result.stateDir}`);
  for (const cls of result.classes) {
    console.log(`  [${TAG[cls.status]}] ${cls.title}`);
    for (const finding of cls.findings) console.log(`        - ${finding}`);
  }
  console.log(`  => ${result.ok ? "PASS" : "FAIL"}`);
}

function parseArgs(argv) {
  const args = { stateDir: undefined, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") args.selfTest = true;
    else if (arg === "--state-dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return "usage";
      args.stateDir = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") return "help";
    else return "usage";
  }
  return args;
}

const USAGE = `Usage:
  node scripts/check-local-state.mjs [--state-dir PATH]   audit an existing .keiko tree
  node scripts/check-local-state.mjs --self-test          generate fixtures and self-verify the audit

Exit code: 0 healthy, 1 audit failure, 2 usage error.`;

function runAudit(stateDir) {
  const result = auditLocalState(stateDir);
  reportAudit("local-state audit", result);
  if (result.ok) {
    console.log("\nlocal-state: PASS");
    return 0;
  }
  console.error("\nlocal-state: FAIL");
  return 1;
}

async function runSelfTest() {
  const { createHealthyFixture, createDriftedFixture } =
    await import("./lib/local-state-fixture.mjs");
  // realpathSync resolves the macOS `/var` -> `/private/var` symlink so the credential vault's
  // symlinked-path-segment guard does not reject the fixture directory.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-local-state-selftest-")));
  try {
    const healthy = auditLocalState(createHealthyFixture(join(root, "healthy", ".keiko")));
    reportAudit("self-test: healthy fixture (expect PASS)", healthy);
    const drifted = auditLocalState(createDriftedFixture(join(root, "drifted", ".keiko")));
    reportAudit("self-test: drifted fixture (expect FAIL)", drifted);

    const healthyOk = healthy.ok;
    const driftCaught = !drifted.ok;
    const driftedClasses = drifted.classes.filter((c) => c.status === "fail").map((c) => c.id);
    if (healthyOk && driftCaught) {
      console.log(`\nself-test: drift detected in classes: ${driftedClasses.join(", ")}`);
      console.log("local-state: PASS");
      return 0;
    }
    if (!healthyOk) console.error("\nself-test FAILED: the healthy fixture did not pass the audit");
    if (!driftCaught) console.error("\nself-test FAILED: the drifted fixture was not detected");
    console.error("local-state: FAIL");
    return 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed === "usage") {
    console.error(USAGE);
    return 2;
  }
  if (parsed.selfTest) return runSelfTest();
  return runAudit(parsed.stateDir ?? join(process.cwd(), ".keiko"));
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`local-state: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
