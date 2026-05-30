/**
 * Issue #66 — Pure summary builder for the chat run-summary message.
 *
 * Given a terminal RunReport (or an EvidenceManifest run-outcome fallback), produce
 * { workflowStatus, shortResult } that the PATCH route writes onto the chat row.
 *
 * Defensive by design: the input may be `unknown` (live BFF projection during catch-up,
 * unknown-shape failures). The function never throws; on any shape mismatch it returns the
 * conservative fallback ("Completed." / "Failed." / "Cancelled.") so the chat never crashes
 * on a wider-than-expected RunReport.
 *
 * The output `shortResult` is ALWAYS ≤ 200 chars; the BFF re-runs the same truncation server-
 * side, but bounding here avoids round-tripping oversized text on the wire.
 */
import type { ChatWorkflowStatus } from "./types";

export interface RunSummaryFallbackKind {
  readonly workflowId?: string;
  readonly taskType?: string;
}

export interface RunSummary {
  readonly workflowStatus: ChatWorkflowStatus;
  readonly shortResult: string;
}

// Issue #66 — discriminator returned by classifyRunReport so the caller can tell a real
// terminal/running classification from an "unknown shape, keep polling" decision. PATCHing
// callers MUST NOT write a terminal status on `kind: "unknown"`. The terminal-summary status
// is narrowed to the three terminal values so callers don't have to re-narrow inline.
export type TerminalWorkflowStatus = "completed" | "failed" | "cancelled";
export interface TerminalRunSummary {
  readonly workflowStatus: TerminalWorkflowStatus;
  readonly shortResult: string;
}
export type RunSummaryOutcome =
  | { readonly kind: "terminal"; readonly summary: TerminalRunSummary }
  | { readonly kind: "running" }
  | { readonly kind: "unknown" };

const MAX_SHORT_RESULT = 200;

// Subset of RunStatus we care about; any other status string is mapped to "running" or the
// terminal fallback depending on whether we have a fall-through path (we don't here — see D6).
type KnownRunStatus =
  | "completed"
  | "dry-run"
  | "fix-applied"
  | "fix-proposed"
  | "investigation-only"
  | "cancelled"
  | "failed"
  | "rejected"
  | "running";

const TERMINAL_COMPLETED: ReadonlySet<KnownRunStatus> = new Set([
  "completed",
  "dry-run",
  "fix-applied",
  "fix-proposed",
  "investigation-only",
]);

function truncate(s: string): string {
  return s.length > MAX_SHORT_RESULT ? s.slice(0, MAX_SHORT_RESULT) : s;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function readStatus(report: Record<string, unknown>): KnownRunStatus | undefined {
  const raw = report.status;
  if (typeof raw !== "string") return undefined;
  // Narrow without listing every case explicitly; only "running" plus the terminal status
  // strings produced by src/ui/runs.ts and src/workflows/* matter.
  return raw as KnownRunStatus;
}

function readFailureMessage(report: Record<string, unknown>): string | undefined {
  const failure = asObject(report.failure);
  const message = failure?.message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

// `unit-tests` (or `unit-test-generation`) completion text — pulls counts defensively.
function formatUnitTestsCompleted(report: Record<string, unknown>): string {
  let testCount: number | undefined;
  const addedTestFiles = report.addedTestFiles;
  if (Array.isArray(addedTestFiles)) {
    let sum = 0;
    let any = false;
    for (const entry of addedTestFiles) {
      const obj = asObject(entry);
      const c = obj?.estimatedTestCount;
      if (typeof c === "number" && Number.isFinite(c)) {
        sum += c;
        any = true;
      }
    }
    if (any) testCount = sum;
  }
  const filesCount = Array.isArray(addedTestFiles) ? addedTestFiles.length : 0;
  if (filesCount > 0 && testCount !== undefined) {
    return `Generated ${String(filesCount)} test files; ${String(testCount)} tests proposed.`;
  }
  if (filesCount > 0) {
    return `Generated ${String(filesCount)} test files.`;
  }
  return "Completed.";
}

function formatBugCompleted(): string {
  return "Investigation complete; root cause documented.";
}

function formatVerifyCompleted(report: Record<string, unknown>): string {
  const verification = asObject(report.verificationSummary);
  const results = verification?.results;
  if (Array.isArray(results) && results.length > 0) {
    return `Verification passed: ${String(results.length)} classifications.`;
  }
  return "Verification passed.";
}

function formatExplainCompleted(report: Record<string, unknown>): string {
  const dryRunPreview = report.dryRunPreview;
  if (typeof dryRunPreview === "string" && dryRunPreview.length > 0) {
    // Crude step count: number of non-empty lines. Defensive; never blocks.
    const lines = dryRunPreview.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) return `Plan generated; ${String(lines.length)} steps.`;
  }
  return "Plan generated.";
}

function classifyKind(fallbackKind: RunSummaryFallbackKind): "unit-tests" | "bug" | "verify" | "explain" | "other" {
  const wid = fallbackKind.workflowId;
  if (wid === "unit-test-generation" || wid === "unit-tests") return "unit-tests";
  if (wid === "bug-investigation") return "bug";
  if (fallbackKind.taskType === "verify") return "verify";
  if (fallbackKind.taskType === "explain-plan") return "explain";
  return "other";
}

function formatCompleted(report: Record<string, unknown>, kind: ReturnType<typeof classifyKind>): string {
  if (kind === "unit-tests") return formatUnitTestsCompleted(report);
  if (kind === "bug") return formatBugCompleted();
  if (kind === "verify") return formatVerifyCompleted(report);
  if (kind === "explain") return formatExplainCompleted(report);
  return "Completed.";
}

function formatFailed(report: Record<string, unknown>): string {
  const msg = readFailureMessage(report);
  if (msg !== undefined) return truncate(`Run failed: ${msg}.`);
  return "Run failed.";
}

/**
 * Classifies a RunReport-like value into terminal / running / unknown. The hook uses the
 * "unknown" branch to keep polling rather than PATCHing the row to a synthetic terminal
 * status — guards against a malformed BFF response forcing a still-running row to completed
 * (self-critique #3).
 */
export function classifyRunReport(
  report: unknown,
  fallbackKind: RunSummaryFallbackKind,
): RunSummaryOutcome {
  const reportObj = asObject(report);
  if (reportObj === undefined) return { kind: "unknown" };
  const status = readStatus(reportObj);
  const fkind = classifyKind(fallbackKind);

  if (status === "running") return { kind: "running" };
  if (status === "cancelled") {
    return {
      kind: "terminal",
      summary: { workflowStatus: "cancelled", shortResult: "Run cancelled." },
    };
  }
  if (status === "failed" || status === "rejected") {
    return {
      kind: "terminal",
      summary: { workflowStatus: "failed", shortResult: truncate(formatFailed(reportObj)) },
    };
  }
  if (status !== undefined && TERMINAL_COMPLETED.has(status)) {
    return {
      kind: "terminal",
      summary: {
        workflowStatus: "completed",
        shortResult: truncate(formatCompleted(reportObj, fkind)),
      },
    };
  }
  return { kind: "unknown" };
}

/**
 * Thin wrapper preserved for direct callers (tests, future surfaces) that want a "best-effort"
 * summary regardless of shape. The polling hook uses classifyRunReport so the conservative
 * "Completed." fallback below is never observed on the unknown-shape path.
 */
export function formatRunSummary(
  report: unknown,
  fallbackKind: RunSummaryFallbackKind,
): RunSummary {
  const outcome = classifyRunReport(report, fallbackKind);
  if (outcome.kind === "terminal") return outcome.summary;
  if (outcome.kind === "running") return { workflowStatus: "running", shortResult: "" };
  return { workflowStatus: "completed", shortResult: "Completed." };
}

/**
 * Issue #66 — Build the summary from an EvidenceManifest's terminal `run.outcome`. Used by the
 * sync hook's 404-fallback path where /api/runs/:runId no longer holds the record but the
 * persistent manifest still does.
 *
 * `manifest.run.outcome` values come from src/audit/types.ts:
 *   "completed" | "cancelled" | "failed" | "limit-exceeded"
 *
 * "limit-exceeded" is mapped to "failed" because the chat's status set has no resource-class.
 */
export function formatRunSummaryFromManifest(
  manifest: unknown,
  fallbackKind: RunSummaryFallbackKind,
): RunSummary {
  const m = asObject(manifest);
  const run = m === undefined ? undefined : asObject(m.run);
  const outcome = run === undefined ? undefined : run.outcome;
  const kind = classifyKind(fallbackKind);

  if (outcome === "cancelled") {
    return { workflowStatus: "cancelled", shortResult: "Run cancelled." };
  }
  if (outcome === "failed" || outcome === "limit-exceeded") {
    return { workflowStatus: "failed", shortResult: "Run failed." };
  }
  if (outcome === "completed") {
    // The manifest does not always carry the rich per-kind details, so we use the kind default.
    const text =
      kind === "bug"
        ? formatBugCompleted()
        : kind === "verify"
          ? "Verification passed."
          : kind === "explain"
            ? "Plan generated."
            : kind === "unit-tests"
              ? "Generated tests."
              : "Completed.";
    return { workflowStatus: "completed", shortResult: truncate(text) };
  }
  return { workflowStatus: "completed", shortResult: "Completed." };
}
