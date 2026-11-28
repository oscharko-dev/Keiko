import type { CodingWorkbenchVerificationPreview } from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS,
  CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS,
  type CodingWorkbenchVerificationPreviewUnavailableReason,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import { redact, redactContent } from "@oscharko-dev/keiko-security";
import { emitServerDiagnostic, type ServerDiagnosticSink } from "../diagnostics-log.js";
import { VerificationRunnerError } from "../editor/verificationRunnerErrors.js";
import {
  verificationPlanDigest,
  type VerificationCommandPreview,
  type VerificationPreviewInput,
  type VerificationPreviewStep,
} from "../editor/verificationRunner.js";
import type {
  CodingVerificationPreviewPort,
  CodingVerificationPreviewResult,
} from "./codingRuntimeManager.js";
import { redactCommandLineCredentials } from "./commandLineRedaction.js";

/** The verifier ids whose command lines come from the project's own scripts. */
const SCRIPT_VERIFIERS = ["test", "typecheck", "lint", "build"] as const;
type ScriptVerifier = (typeof SCRIPT_VERIFIERS)[number];

const ELLIPSIS = "…";
/** The script body shown beside `npm run x`; the whole step line is cut again at the line bound. */
const SCRIPT_BODY_MAX_CHARS = 400;

export interface VerificationApprovalPreviewInput {
  /** The run's workspace root: the project the governed verification would run in. */
  readonly workspaceRoot: string;
  readonly runner: {
    readonly previewCommands: (input: VerificationPreviewInput) => VerificationCommandPreview;
  };
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly now?: (() => Date) | undefined;
}

function isScriptVerifier(value: string): value is ScriptVerifier {
  return (SCRIPT_VERIFIERS as readonly string[]).includes(value);
}

/** Quotes an argument the way a person would type it, so the line reads as the real command. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : JSON.stringify(word);
}

// The digest of what a plan runs lives with the runner that plans it, so the preview and the
// effect's own check cannot drift apart.
export { verificationPlanDigest };

/**
 * The person reads this text, so it loses only the credential floor (owner decision 2026-11-04);
 * the credential-named options are masked first, and the strict projection then covers the shapes
 * left. Never evidence: the preview lives on the review channel only.
 */
function projectText(text: string): string {
  return redact(redactContent(redactCommandLineCredentials(text), "preserve"));
}

const HIGH_SURROGATE = /^[\ud800-\udbff]$/u;

/** Cuts at a code point, never inside a surrogate pair, and ends the cut text in an ellipsis. */
export function cutVisibly(
  text: string,
  max: number,
): { readonly text: string; readonly cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max - ELLIPSIS.length;
  // A high surrogate at the cut has lost its low half: drop it with it.
  if (HIGH_SURROGATE.test(text.charAt(end - 1))) end -= 1;
  return { text: `${text.slice(0, end)}${ELLIPSIS}`, cut: true };
}

/**
 * The step's text, already projected. The script body is projected whole BEFORE it is cut, so a
 * credential the cut would split is masked first and no part of it is shown.
 */
function stepText(step: VerificationPreviewStep): string {
  const line = [step.command, ...step.args].map(shellWord).join(" ");
  const where = projectText(step.cwd === undefined ? line : `${line}  (in ${step.cwd})`);
  if (step.scriptName === undefined || step.scriptBody === undefined) return where;
  const body = cutVisibly(projectText(step.scriptBody), SCRIPT_BODY_MAX_CHARS).text;
  return `${where}\n  runs the project's own "${projectText(step.scriptName)}" script: ${body}`;
}

/** Pure projection of a planned set of steps into the card's bounded, redacted lines. */
export function previewFromSteps(
  steps: readonly VerificationPreviewStep[],
): CodingWorkbenchVerificationPreview {
  if (steps.length === 0) return { status: "unavailable", reason: "no-runnable-step" };
  const kept = steps.slice(0, CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS);
  const lines = kept.map((step) =>
    cutVisibly(stepText(step), CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS),
  );
  return {
    status: "commands",
    commands: lines.map((line) => line.text),
    truncated: kept.length < steps.length || lines.some((line) => line.cut),
  };
}

function previewFromPlan(plan: VerificationCommandPreview): CodingWorkbenchVerificationPreview {
  switch (plan.kind) {
    case "steps":
      return previewFromSteps(plan.steps);
    case "package-selection-required":
      return { status: "deferred", reason: "package-selection" };
    case "host-dependent":
      return { status: "deferred", reason: "host-setup" };
    case "unresolved":
      return { status: "unavailable", reason: "workspace-unresolved" };
  }
}

function failureReason(error: unknown): CodingWorkbenchVerificationPreviewUnavailableReason {
  return error instanceof VerificationRunnerError && error.code === "PROJECT_NOT_FOUND"
    ? "workspace-unresolved"
    : "preview-failed";
}

function reportPreview(
  input: VerificationApprovalPreviewInput,
  correlationId: string,
  errorClass: string,
  code?: string,
): void {
  // Body-free: a closed reason, a count and the run's correlation id; never a command or a path.
  emitServerDiagnostic(input.diagnostics, {
    correlationId,
    timestamp: (input.now?.() ?? new Date()).toISOString(),
    operation: "coding-runtime.approval",
    source: "verification-approval-preview",
    errorClass,
    message: "approval-preview-unavailable",
    ...(code === undefined ? {} : { code }),
  });
}

/**
 * Builds the preview the approval card shows for a pending governed verification (ADR-0124 D6). The
 * ask names the verifier and the package folder the call asked for, so the plan is the one the
 * runner will make. A targeted test, an unresolved package and a Maven project (whether Maven runs
 * depends on this computer's isolation backend) name no command and say so; a failing or empty plan
 * falls back to the class label with a closed, logged reason. A shown command binds its digest to
 * the ask's tool call, so the run refuses a project that changed after approval.
 */
export function createVerificationApprovalPreview(
  input: VerificationApprovalPreviewInput,
): CodingVerificationPreviewPort {
  return (verifierId, runId, ask): CodingVerificationPreviewResult => {
    if (!isScriptVerifier(verifierId)) {
      return { preview: { status: "deferred", reason: "targeted-test" } };
    }
    let plan: VerificationCommandPreview;
    try {
      plan = input.runner.previewCommands({
        projectId: input.workspaceRoot,
        kinds: [verifierId],
        ...(ask.packageDir === undefined ? {} : { packageDir: ask.packageDir }),
      });
    } catch (error) {
      const reason = failureReason(error);
      reportPreview(input, runId, reason);
      return { preview: { status: "unavailable", reason } };
    }
    return previewOf(input, runId, plan);
  };
}

function previewOf(
  input: VerificationApprovalPreviewInput,
  runId: string,
  plan: VerificationCommandPreview,
): CodingVerificationPreviewResult {
  const failures = plan.probeFailures;
  if (failures > 0)
    reportPreview(input, runId, "package-probe-failed", `failures=${String(failures)}`);
  const preview = previewFromPlan(plan);
  if (preview.status === "unavailable") reportPreview(input, runId, preview.reason);
  // The digest travels with the ask and is stored on the approval record the call itself spends.
  return plan.kind === "steps" && preview.status === "commands"
    ? { preview, planDigest: verificationPlanDigest(plan.steps) }
    : { preview };
}
