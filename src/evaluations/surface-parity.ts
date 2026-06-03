// Surface-parity checks (ADR-0012 D7). A pure, no-model assertion that the four surfaces for each
// workflow — UI descriptor, CLI flags, SDK exports, and the UI RunRequest shape — present consistent
// contracts. It is NOT a scored dimension: it is a fixed structural invariant of the codebase, so it
// has its own scorecard section and its own test file. A parity failure is a hard blocker that causes
// `keiko evaluate` to exit 1 regardless of dimension scores.

import { runGenTestsCli, runInvestigateCli, type CliIo } from "@oscharko-dev/keiko-cli";
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

interface CliExpectation {
  readonly kind: WorkflowKind;
  readonly help: string;
  readonly requiredTokens: readonly string[];
}

interface SdkExportExpectation {
  readonly kind: WorkflowKind;
  readonly functionExport: string;
  readonly descriptorExport: string;
}

interface RunRequestExpectation {
  readonly kind: WorkflowKind;
  readonly workflowId: string;
  readonly input: Record<string, unknown>;
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

const SDK_EXPORT_EXPECTATIONS: readonly SdkExportExpectation[] = [
  {
    kind: "unit-tests",
    functionExport: "generateUnitTests",
    descriptorExport: "UNIT_TEST_WORKFLOW_DESCRIPTOR",
  },
  {
    kind: "bug-investigation",
    functionExport: "investigateBug",
    descriptorExport: "BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR",
  },
];

const RUN_REQUEST_EXPECTATIONS: readonly RunRequestExpectation[] = [
  {
    kind: "unit-tests",
    workflowId: "unit-test-generation",
    input: {
      workspaceRoot: "/tmp/keiko-surface-parity",
      target: { kind: "file", filePath: "src/example.ts" },
    },
  },
  {
    kind: "bug-investigation",
    workflowId: "bug-investigation",
    input: {
      workspaceRoot: "/tmp/keiko-surface-parity",
      report: { description: "example failure" },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkDescriptor(expectation: DescriptorExpectation): SurfaceParityCheckResult {
  const missing = expectation.requiredInputs.filter(
    (name) => !expectation.descriptor.inputs.some((input) => input.name === name && input.required),
  );
  const hasLimitsInput = expectation.descriptor.inputs.some(
    (input) => input.name === "limits" && input.type === "object" && !input.required,
  );
  const hasDefaultLimits =
    isRecord(expectation.descriptor.defaultLimits) &&
    Object.keys(expectation.descriptor.defaultLimits).length > 0;
  const dryRunApply = expectation.descriptor.supportsDryRun && expectation.descriptor.supportsApply;
  if (missing.length > 0) {
    return failed(
      "descriptor-inputs",
      expectation.kind,
      `missing required inputs: ${missing.join(", ")}`,
    );
  }
  if (!hasLimitsInput || !hasDefaultLimits) {
    return failed(
      "descriptor-inputs",
      expectation.kind,
      "descriptor must expose optional limits input and non-empty defaultLimits",
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
  const expectations: readonly CliExpectation[] = [
    {
      kind: "unit-tests",
      help: genTestsHelp,
      requiredTokens: ["--file", "--dir", "--changed", "--model", "--apply"],
    },
    {
      kind: "bug-investigation",
      help: investigateHelp,
      requiredTokens: [
        "--description",
        "--output",
        "--output-file",
        "--stack",
        "--stack-file",
        "--file",
        "--model",
        "--apply",
      ],
    },
  ];
  return expectations.map(checkCliExpectation);
}

function checkCliExpectation(expectation: CliExpectation): SurfaceParityCheckResult {
  const missing = expectation.requiredTokens.filter((token) => !expectation.help.includes(token));
  const hasDryRunDefault = expectation.help.toLowerCase().includes("dry-run by default");
  if (missing.length > 0) {
    return failed("cli-flags", expectation.kind, `help missing flags: ${missing.join(", ")}`);
  }
  if (!hasDryRunDefault) {
    return failed("cli-flags", expectation.kind, "help does not state dry-run by default");
  }
  return passed("cli-flags", expectation.kind);
}

// The SDK named exports each workflow must surface. A dynamic import breaks the load-time cycle the
// static import would create (the SDK barrel re-exports this evaluation module).
async function checkSdkExports(): Promise<readonly SurfaceParityCheckResult[]> {
  const sdk = (await import("../sdk/index.js")) as Record<string, unknown>;
  return SDK_EXPORT_EXPECTATIONS.map((expectation) => {
    const missing = [
      ...(typeof sdk[expectation.functionExport] === "function"
        ? []
        : [expectation.functionExport]),
      ...(typeof sdk[expectation.descriptorExport] === "object" &&
      sdk[expectation.descriptorExport] !== null
        ? []
        : [expectation.descriptorExport]),
    ];
    return missing.length === 0
      ? passed("sdk-exports", expectation.kind)
      : failed("sdk-exports", expectation.kind, `missing SDK exports: ${missing.join(", ")}`);
  });
}

// The UI RunRequest carries the minimum fields the BFF needs to invoke either workflow. The compile-
// time guarantee is enforced by the TypeScript check; this is the runtime shape assertion (D7 d).
// Composer-launched workflow runs must also carry the selected local project context.
async function checkRunRequestShapes(): Promise<readonly SurfaceParityCheckResult[]> {
  const { parseRunRequest } = await import("../ui/index.js");
  return RUN_REQUEST_EXPECTATIONS.map((expectation) => {
    const parsed = parseRunRequest(
      JSON.stringify({
        workflowId: expectation.workflowId,
        modelId: "m",
        input: expectation.input,
        apply: true,
        limits: { maxPromptBytes: 1 },
      }),
    );
    if ("code" in parsed) {
      return failed("run-request-shape", expectation.kind, parsed.message);
    }
    const required = ["kind", "modelId", "apply", "input", "limits"];
    const missing = required.filter((field) => !(field in parsed));
    if (missing.length > 0) {
      return failed(
        "run-request-shape",
        expectation.kind,
        `RunRequest missing fields: ${missing.join(", ")}`,
      );
    }
    if (
      parsed.kind !== expectation.kind ||
      typeof parsed.modelId !== "string" ||
      parsed.apply ||
      !isRecord(parsed.input) ||
      !isRecord(parsed.limits)
    ) {
      return failed("run-request-shape", expectation.kind, "RunRequest field types mismatch");
    }
    return passed("run-request-shape", expectation.kind);
  });
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
    ...(await checkRunRequestShapes()),
  ];
  return { allPassed: checks.every((check) => check.passed), checks };
}
