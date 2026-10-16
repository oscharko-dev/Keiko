import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import { isMainModule } from "../lib/is-main-module.mjs";

const executePolicy = promisify(execFile);
export function closedChildStatus(value) {
  if (value === null || (typeof value === "number" && Number.isInteger(value))) return value;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : "unavailable";
}
export function capturedByteCount(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : "unavailable";
}
// Convert the actual child failure to closed causal facts before it can be printed.
function policyChildFailure(error) {
  const details = typeof error === "object" && error !== null ? error : {};
  const status = {
    code: closedChildStatus(details.code),
    signal: closedChildStatus(details.signal),
    killed: typeof details.killed === "boolean" ? details.killed : "unavailable",
    stdoutBytes: capturedByteCount(details.stdout),
    stderrBytes: capturedByteCount(details.stderr),
  };
  return new Error(`policy child failed: ${JSON.stringify(status)}`, { cause: status });
}
export async function executePolicyWithDiagnostics(args, options) {
  try {
    return await executePolicy(process.execPath, args, options);
  } catch (error) {
    throw policyChildFailure(error);
  }
}

export async function isolatedPolicyReport(repositoryRoot, timeout = 180_000) {
  const entry = new URL("../check-code-quality-policy.mjs", import.meta.url);
  const args =
    repositoryRoot === undefined
      ? [fileURLToPath(entry), "--json"]
      : [
          "--input-type=module",
          "-e",
          `const { codeQualityPolicyMain } = await import(${JSON.stringify(entry.href)}); process.exitCode = await codeQualityPolicyMain(["--json"], ${JSON.stringify(repositoryRoot)});`,
        ];
  const { stdout } = await executePolicyWithDiagnostics(args, {
    cwd: new URL("../../", import.meta.url),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function assertRepositoryPolicyReport(report) {
  assert.deepEqual(
    {
      outcome: report.outcome,
      enforcementOutcome: report.enforcementOutcome,
      mode: report.mode,
      scope: { id: report.scope.id, partial: report.scope.partial },
    },
    {
      outcome: "failed",
      enforcementOutcome: "passed",
      mode: "enforce",
      scope: { id: "repository", partial: false },
    },
  );
  assert.equal(report.counts.expected, report.counts.visited);
  assert.equal(report.counts.packages, 27);
  assert.equal(report.counts.violations, 0);
  assert.equal(report.rules.length, 22);
  assert.deepEqual(
    {
      ready: report.responsibilities.counts.ready,
      pending: report.responsibilities.counts.pending,
      qualified: report.responsibilities.counts.qualified,
    },
    { ready: 24, pending: 24, qualified: 0 },
  );
  assert.equal(
    report.responsibilities.assessments.every(({ proofs }) =>
      proofs.every(({ executed }) => executed === false),
    ),
    true,
  );
  assert.equal(report.pack.length, 27);
}

if (isMainModule(import.meta.url)) {
  test(
    "reports a full actual candidate verdict through the enforcing CLI owner",
    { timeout: 375_000 },
    async () => {
      // Complete four-CPU ARM evaluation measured 249s; retain a finite integration allowance.
      const report = await isolatedPolicyReport(undefined, 360_000);
      assertRepositoryPolicyReport(report);
    },
  );
}
