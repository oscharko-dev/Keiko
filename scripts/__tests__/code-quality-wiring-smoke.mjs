import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import { isMainModule } from "../lib/is-main-module.mjs";

import { lastPolicyProgress } from "../lib/code-quality-policy.mjs";
import { createCollectiveParserFixture } from "./support/code-quality-responsibility-fixture.mjs";

const executePolicy = promisify(execFile);
export function closedChildStatus(value) {
  if (value === null || (typeof value === "number" && Number.isInteger(value))) return value;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : "unavailable";
}
export function capturedByteCount(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : "unavailable";
}
// Convert the actual child failure to closed causal facts before it can be printed.
function policyChildFailure(error, progress) {
  const details = typeof error === "object" && error !== null ? error : {};
  const status = {
    code: closedChildStatus(details.code),
    signal: closedChildStatus(details.signal),
    killed: typeof details.killed === "boolean" ? details.killed : "unavailable",
    stdoutBytes: capturedByteCount(details.stdout),
    stderrBytes: capturedByteCount(details.stderr),
  };
  if (progress) status.progress = lastPolicyProgress(details.stderr) ?? "unavailable";
  return new Error(`policy child failed: ${JSON.stringify(status)}`, { cause: status });
}
export async function executePolicyWithDiagnostics(args, options, progress = false) {
  try {
    return await executePolicy(process.execPath, args, options);
  } catch (error) {
    throw policyChildFailure(error, progress);
  }
}

export async function isolatedPolicyReport(repositoryRoot, timeout = 180_000, progress = false) {
  const entry = new URL("../check-code-quality-policy.mjs", import.meta.url);
  const flags = ["--json", ...(progress ? ["--progress"] : [])];
  const args =
    repositoryRoot === undefined
      ? [fileURLToPath(entry), ...flags]
      : [
          "--input-type=module",
          "-e",
          `const { codeQualityPolicyMain } = await import(${JSON.stringify(entry.href)}); process.exitCode = await codeQualityPolicyMain(${JSON.stringify(flags)}, ${JSON.stringify(repositoryRoot)});`,
        ];
  const { stdout } = await executePolicyWithDiagnostics(
    args,
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    },
    progress,
  );
  return JSON.parse(stdout);
}

export function assertFixturePolicyReport(report, policy) {
  assert.deepEqual(
    {
      outcome: report.outcome,
      enforcementOutcome: report.enforcementOutcome,
      mode: report.mode,
      scope: report.scope,
    },
    {
      outcome: "failed",
      enforcementOutcome: "passed",
      mode: "enforce",
      scope: { id: "repository", partial: false },
    },
  );
  assert.equal(report.counts.expected, report.counts.visited);
  assert.equal(report.counts.visited, report.inventory.files.length);
  assert.ok(report.counts.visited > 0);
  assert.equal(report.counts.packages, 1);
  assert.equal(report.pack.length, 1);
  assert.equal(report.counts.violations, 0);
  assert.equal(report.rules.length, 22);
  assertFixtureResponsibilities(report, policy);
}

function assertFixtureResponsibilities(report, policy) {
  assert.deepEqual(
    policy.responsibilities.map(({ id }) => id),
    ["fixture-first", "fixture-second"],
  );
  assert.deepEqual(report.responsibilities.counts, {
    ready: 2,
    incomplete: 0,
    invalid: 0,
    qualified: 0,
    pending: 2,
    rejected: 0,
  });
  assert.deepEqual(
    report.responsibilities.assessments.map(({ id }) => id),
    policy.responsibilities.map(({ id }) => id),
  );
  assert.ok(
    report.responsibilities.assessments.every(
      ({ proofs }) => proofs.length > 0 && proofs.every(({ executed }) => executed === false),
    ),
  );
  report.responsibilities.assessments.forEach((assessment, index) => {
    assert.equal(assessment.structural, "ready");
    assert.equal(assessment.semantic, "pending");
    assert.deepEqual(
      assessment.proofs.map(({ path }) => path),
      policy.responsibilities[index].proofs,
    );
    assert.ok(policy.responsibilities[index].proofAssertions.length > 0);
  });
}

if (isMainModule(import.meta.url)) {
  test(
    "reports a complete nonempty default CLI fixture without executing declared proofs",
    { timeout: 375_000 },
    async () => {
      const own = createCollectiveParserFixture("direct");
      try {
        const proof = "packages/alpha/src/proof.test.ts";
        own.put(
          proof,
          `${readFileSync(join(own.root, proof), "utf8")}\nthrow new Error("default proof must not execute");\n`,
        );
        // Finite CLI integration allowance; complete production qualification has its own owner.
        const report = await isolatedPolicyReport(own.root, 360_000, true);
        assertFixturePolicyReport(report, own.policy);
      } finally {
        rmSync(own.root, { recursive: true, force: true });
      }
    },
  );
}
