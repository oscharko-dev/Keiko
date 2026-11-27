import type { CodingWorkbenchVerificationPreview } from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS,
  CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS,
  type CodingWorkbenchVerificationPreviewUnavailableReason,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import { redact, redactContent } from "@oscharko-dev/keiko-security";
import { emitServerDiagnostic, type ServerDiagnosticSink } from "../diagnostics-log.js";
import type {
  VerificationCommandPreview,
  VerificationPreviewStep,
} from "../editor/verificationRunner.js";
import { VerificationRunnerError } from "../editor/verificationRunnerErrors.js";
import type { CodingVerificationPreviewPort } from "./codingRuntimeManager.js";

/** The verifier ids whose command lines come from the project's own scripts. */
const SCRIPT_VERIFIERS = ["test", "typecheck", "lint", "build"] as const;
type ScriptVerifier = (typeof SCRIPT_VERIFIERS)[number];

const ELLIPSIS = "…";

export interface VerificationApprovalPreviewInput {
  /** The run's workspace root: the project the governed verification would run in. */
  readonly workspaceRoot: string;
  readonly runner: {
    readonly previewCommands: (input: {
      readonly projectId: string;
      readonly kinds: readonly ScriptVerifier[];
    }) => VerificationCommandPreview;
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

function commandLine(step: VerificationPreviewStep): string {
  const line = [step.command, ...step.args].map(shellWord).join(" ");
  return step.cwd === undefined ? line : `${line}  (in ${step.cwd})`;
}

/**
 * The person reads this line, so it loses only the credential floor (owner decision 2026-11-04);
 * the strict projection then masks the flag shapes the floor leaves (`--password=`, `--token=`).
 * Both are the existing redactors. Never evidence: the preview lives on the review channel only.
 */
function projectLine(line: string): string {
  return redact(redactContent(line, "preserve"));
}

function cutVisibly(line: string): { readonly text: string; readonly cut: boolean } {
  const max = CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS;
  return line.length <= max
    ? { text: line, cut: false }
    : { text: `${line.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`, cut: true };
}

/** Pure projection of a planned set of steps into the card's bounded, redacted lines. */
export function previewFromSteps(
  steps: readonly VerificationPreviewStep[],
): CodingWorkbenchVerificationPreview {
  if (steps.length === 0) return { status: "unavailable", reason: "no-runnable-step" };
  const kept = steps.slice(0, CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS);
  const lines = kept.map((step) => cutVisibly(projectLine(commandLine(step))));
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
    case "unresolved":
      return { status: "unavailable", reason: "workspace-unresolved" };
  }
}

function failureReason(error: unknown): CodingWorkbenchVerificationPreviewUnavailableReason {
  return error instanceof VerificationRunnerError && error.code === "PROJECT_NOT_FOUND"
    ? "workspace-unresolved"
    : "preview-failed";
}

function reportUnavailable(
  input: VerificationApprovalPreviewInput,
  correlationId: string,
  reason: CodingWorkbenchVerificationPreviewUnavailableReason,
): void {
  // Body-free: a closed reason and the run's correlation id; never a command line or a path.
  emitServerDiagnostic(input.diagnostics, {
    correlationId,
    timestamp: (input.now?.() ?? new Date()).toISOString(),
    operation: "coding-runtime.approval",
    source: "verification-approval-preview",
    errorClass: reason,
    message: "approval-preview-unavailable",
  });
}

/**
 * Builds the preview the approval card shows for a pending governed verification (ADR-0124 D6). A
 * targeted test and an unresolved monorepo package name no command yet and say so; a failing or
 * empty plan falls back to the class label with a closed, logged reason.
 */
export function createVerificationApprovalPreview(
  input: VerificationApprovalPreviewInput,
): CodingVerificationPreviewPort {
  return (verifierId, correlationId): CodingWorkbenchVerificationPreview => {
    if (!isScriptVerifier(verifierId)) return { status: "deferred", reason: "targeted-test" };
    let preview: CodingWorkbenchVerificationPreview;
    try {
      preview = previewFromPlan(
        input.runner.previewCommands({ projectId: input.workspaceRoot, kinds: [verifierId] }),
      );
    } catch (error) {
      preview = { status: "unavailable", reason: failureReason(error) };
      reportUnavailable(input, correlationId, preview.reason);
      return preview;
    }
    if (preview.status === "unavailable") reportUnavailable(input, correlationId, preview.reason);
    return preview;
  };
}
