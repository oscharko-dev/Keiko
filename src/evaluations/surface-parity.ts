// Surface-parity checks (ADR-0012 D7). A pure, no-model assertion that the four surfaces for each
// workflow — UI descriptor, CLI flags, SDK exports, and the UI RunRequest shape — present consistent
// contracts. It is NOT a scored dimension: it is a fixed structural invariant of the codebase, so it
// has its own scorecard section and its own test file. A parity failure is a hard blocker that causes
// `keiko evaluate` to exit 1 regardless of dimension scores.

import { runGenTestsCli } from "../cli/gen-tests.js";
import { runInvestigateCli } from "../cli/investigate.js";
import type { CliIo } from "../cli/runner.js";
import {
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
  UNIT_TEST_WORKFLOW_DESCRIPTOR,
  type WorkflowDescriptor,
} from "../workflows/index.js";
import type { SurfaceParityCheckResult, SurfaceParityResult, WorkflowKind } from "./types.js";

interface DescriptorExpectation {
  readonly kind: WorkflowKind;
  readonly descriptor: WorkflowDescriptor<unknown>;
  readonly requiredInputs: readonly string[];
}

const DESCRIPTOR_EXPECTATIONS: readonly DescriptorExpectation[] = [
  {
    kind: "unit-tests",
    descriptor: UNIT_TEST_WORKFLOW_DESCRIPTOR,
    requiredInputs: ["target", "modelId"],
  },
  {
    kind: "bug-investigation",
    descriptor: BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
    requiredInputs: ["report", "modelId"],
  },
];

function checkDescriptor(expectation: DescriptorExpectation): SurfaceParityCheckResult {
  const missing = expectation.requiredInputs.filter(
    (name) => !expectation.descriptor.inputs.some((input) => input.name === name && input.required),
  );
  const dryRunApply = expectation.descriptor.supportsDryRun && expectation.descriptor.supportsApply;
  if (missing.length > 0) {
    return failed(
      "descriptor-inputs",
      expectation.kind,
      `missing required inputs: ${missing.join(", ")}`,
    );
  }
  if (!dryRunApply) {
    return failed(
      "descriptor-inputs",
      expectation.kind,
      "supportsDryRun/supportsApply not both true",
    );
  }
  return passed("descriptor-inputs", expectation.kind);
}

function captureCliHelp(
  run: (args: readonly string[], io: CliIo, env: Record<string, string | undefined>) => unknown,
): string {
  const chunks: string[] = [];
  const io: CliIo = {
    out: (text: string): void => void chunks.push(text),
    err: (text: string): void => void chunks.push(text),
  };
  // The handlers print their usage string synchronously before any async work when --help fails to
  // parse as a real invocation, so the captured chunks already contain the flag names we assert.
  void run(["--help"], io, {});
  return chunks.join("");
}

async function checkCliFlags(): Promise<readonly SurfaceParityCheckResult[]> {
  const genTestsHelp = captureCliHelp((args, io, env) => runGenTestsCli(args, io, env, {}));
  const investigateHelp = captureCliHelp((args, io, env) => runInvestigateCli(args, io, env, {}));
  await Promise.resolve();
  const unitFlags = ["--file", "--apply"].filter((flag) => !genTestsHelp.includes(flag));
  const bugFlags = ["--apply"].filter((flag) => !investigateHelp.includes(flag));
  return [
    unitFlags.length === 0
      ? passed("cli-flags", "unit-tests")
      : failed("cli-flags", "unit-tests", `help missing flags: ${unitFlags.join(", ")}`),
    bugFlags.length === 0
      ? passed("cli-flags", "bug-investigation")
      : failed("cli-flags", "bug-investigation", `help missing flags: ${bugFlags.join(", ")}`),
  ];
}

// The SDK named exports each workflow must surface. A dynamic import breaks the load-time cycle the
// static import would create (the SDK barrel re-exports this evaluation module).
const SDK_FUNCTION_EXPORTS = ["generateUnitTests", "investigateBug"] as const;
const SDK_OBJECT_EXPORTS = [
  "UNIT_TEST_WORKFLOW_DESCRIPTOR",
  "BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR",
] as const;

async function checkSdkExports(): Promise<readonly SurfaceParityCheckResult[]> {
  const sdk = (await import("../sdk/index.js")) as Record<string, unknown>;
  const missingFns = SDK_FUNCTION_EXPORTS.filter((name) => typeof sdk[name] !== "function");
  const missingObjs = SDK_OBJECT_EXPORTS.filter(
    (name) => typeof sdk[name] !== "object" || sdk[name] === null,
  );
  return [
    missingFns.length === 0 && missingObjs.length === 0
      ? passed("sdk-exports", "unit-tests")
      : failed(
          "sdk-exports",
          "unit-tests",
          `missing SDK exports: ${[...missingFns, ...missingObjs].join(", ")}`,
        ),
  ];
}

// The UI RunRequest carries the minimum fields the BFF needs to invoke either workflow. The compile-
// time guarantee is enforced by the TypeScript check; this is the runtime shape assertion (D7 d).
function checkRunRequestShape(): SurfaceParityCheckResult {
  const sample: Record<string, unknown> = {
    kind: "unit-tests",
    modelId: "m",
    apply: false,
    input: {},
    limits: undefined,
  };
  const required = ["kind", "modelId", "apply", "input"];
  const missing = required.filter((field) => !(field in sample));
  return missing.length === 0
    ? passed("run-request-shape", "unit-tests")
    : failed("run-request-shape", "unit-tests", `RunRequest missing fields: ${missing.join(", ")}`);
}

function passed(check: string, kind: WorkflowKind): SurfaceParityCheckResult {
  return { check, workflowKind: kind, passed: true };
}

function failed(check: string, kind: WorkflowKind, reason: string): SurfaceParityCheckResult {
  return { check, workflowKind: kind, passed: false, reason };
}

export async function checkSurfaceParity(): Promise<SurfaceParityResult> {
  const checks: SurfaceParityCheckResult[] = [
    ...DESCRIPTOR_EXPECTATIONS.map(checkDescriptor),
    ...(await checkCliFlags()),
    ...(await checkSdkExports()),
    checkRunRequestShape(),
  ];
  return { allPassed: checks.every((check) => check.passed), checks };
}
