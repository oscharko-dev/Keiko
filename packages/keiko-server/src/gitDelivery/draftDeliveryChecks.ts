// The "Checks" section of the server-owned pull-request body (ADR-0086 D9, F57): the run's governed
// verification history, read back from the commit proof's evidence record that the verified-commit
// receipt binds, and rendered deterministically. It holds closed vocabulary, numbers and the
// evidence id only, so no model, repository or command text can reach the pull request through it.

import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { localDraftDeliverySource } from "../coding-runtime/codingRuntimeDraftDeliverySource.js";
import { describeError } from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/server-log.js";
import type { CodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import type { GitDeliveryMutationDeps } from "./execution.js";
import {
  verificationCheckHistoryFromEvidence,
  type VerificationCheckHistory,
  type VerificationCheckInstall,
  type VerificationCheckRecord,
  type VerificationCheckStep,
} from "./verificationChecks.js";

export type DraftDeliveryChecksUnavailableReason =
  "receipt-missing" | "evidence-missing" | "evidence-unreadable" | "evidence-invalid";

export type DraftDeliveryChecks =
  | {
      readonly status: "listed";
      readonly evidenceId: string;
      readonly headSha: string;
      readonly committedTreeDigest: string;
      readonly history: VerificationCheckHistory;
    }
  | { readonly status: "unavailable"; readonly reason: DraftDeliveryChecksUnavailableReason };

export interface DraftDeliveryChecksInput {
  readonly snapshots: Pick<CodingRuntimeSnapshotStore, "get" | "getLastSuccessfulVerifiedCommit">;
  readonly evidenceStore: Pick<GitDeliveryMutationDeps["evidenceStore"], "get">;
  /** The delivery the pull request is for: its binding names the commit the checks belong to. */
  readonly record: DraftDeliveryRecord;
  readonly correlationId: string;
  readonly activityLog: ServerLogSink;
}

interface ChecksRead {
  readonly checks: DraftDeliveryChecks;
  readonly error?: unknown;
}

function unavailable(reason: DraftDeliveryChecksUnavailableReason, error?: unknown): ChecksRead {
  return { checks: { status: "unavailable", reason }, ...(error === undefined ? {} : { error }) };
}

// The receipt of the commit this delivery carries, never merely the run's latest result: a later
// proposal replaces the latest public result, while the successful HEAD lineage keeps the delivered
// commit. The same resolution the draft store and the orchestrator apply (ADR-0086 D9).
function deliveredReceipt(input: DraftDeliveryChecksInput): VerifiedCommitResult | undefined {
  const runId = input.record.binding.runId;
  const snapshot = input.snapshots.get(runId);
  if (snapshot === undefined) return undefined;
  return localDraftDeliverySource(
    snapshot,
    input.record,
    input.snapshots.getLastSuccessfulVerifiedCommit?.(runId),
  );
}

function readChecks(input: DraftDeliveryChecksInput): ChecksRead {
  const receipt = deliveredReceipt(input);
  if (receipt?.headSha === undefined) return unavailable("receipt-missing");
  let json: string | undefined;
  try {
    json = input.evidenceStore.get(receipt.verificationEvidenceId);
  } catch (error) {
    return unavailable("evidence-unreadable", error);
  }
  if (json === undefined) return unavailable("evidence-missing");
  const history = verificationCheckHistoryFromEvidence(json);
  if (history === undefined) return unavailable("evidence-invalid");
  return {
    checks: {
      status: "listed",
      evidenceId: receipt.verificationEvidenceId,
      headSha: receipt.headSha,
      committedTreeDigest: receipt.committedTreeDigest ?? receipt.stagedTreeDigest,
      history,
    },
  };
}

function checksFields(checks: DraftDeliveryChecks): Readonly<Record<string, unknown>> {
  return checks.status === "listed"
    ? {
        verificationEvidenceId: checks.evidenceId,
        recordCount: checks.history.records.length,
        omittedCount: checks.history.omitted,
      }
    : { reason: checks.reason };
}

/** Reads the committed change's verification history and logs the outcome body-free. */
export function readDraftDeliveryChecks(input: DraftDeliveryChecksInput): DraftDeliveryChecks {
  const { checks, error } = readChecks(input);
  input.activityLog.write({
    category: "process",
    op: "git.draft-checks",
    correlationId: input.correlationId,
    ...(checks.status === "listed" ? {} : { level: "warn" as const }),
    ...(error === undefined ? {} : { errorKind: "internal" as const }),
    extra: {
      runId: input.record.binding.runId,
      state: checks.status,
      ...checksFields(checks),
      ...(error === undefined ? {} : describeError(error)),
    },
  });
  return checks;
}

// ─── Rendering: closed vocabulary only ─────────────────────────────────────────────────────────

const KIND_LABEL: Readonly<Record<VerificationCheckStep["kind"], string>> = {
  build: "build",
  test: "tests",
  "targeted-test": "targeted tests",
  typecheck: "type check",
  lint: "lint",
};
const STATUS_LABEL: Readonly<Record<VerificationCheckStep["status"], string>> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  denied: "denied",
  "timed-out": "timed out",
  cancelled: "cancelled",
  "resource-exceeded": "resource limit exceeded",
};
const INSTALL_LABEL: Readonly<Record<VerificationCheckInstall["state"], string>> = {
  none: "not needed",
  current: "already current",
  installed: "installed",
  refused: "refused",
  failed: "failed",
  "timed-out": "timed out",
  cancelled: "cancelled",
};
const LOCKFILE_LABEL: Readonly<Record<VerificationCheckInstall["lockfile"], string>> = {
  present: "from the lockfile",
  created: "lockfile created",
  absent: "no lockfile",
};
// A verification that found the dependencies already installed ran no install worth a row.
const INSTALL_ROW_STATES: ReadonlySet<VerificationCheckInstall["state"]> = new Set([
  "installed",
  "refused",
  "failed",
  "timed-out",
  "cancelled",
]);

const HEADING = "## Checks";
const INTRO =
  "Keiko ran these checks through its verification tool in the task workspace. The results come " +
  "from its verification evidence, not from model output; commands run by other means are not " +
  "listed.";
const TABLE_HEAD =
  "| Check | Result | Exit code | Duration | Ran on |\n| --- | --- | --- | --- | --- |";
const UNAVAILABLE =
  "Keiko could not read its verification evidence for this commit, so no checks are listed here.";
const NO_STEPS = "Keiko recorded no verification step for this commit.";
// Review on PR #3452: the column is only as useful as its meaning is stated.
const LEGEND =
  '"Ran on" names the state each check verified: "committed change" is the exact tree of the ' +
  'commit named below; "earlier staged change" and "working tree" are earlier states of the work, ' +
  "so their results do not prove that commit.";

function formatDuration(durationMs: number): string {
  return durationMs < 1000
    ? `${String(Math.round(durationMs))} ms`
    : `${(durationMs / 1000).toFixed(1)} s`;
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? "none" : String(exitCode);
}

function ranOn(record: VerificationCheckRecord, committedTreeDigest: string): string {
  if (record.stagedTreeDigest === undefined) return "working tree";
  return record.stagedTreeDigest === committedTreeDigest
    ? "committed change"
    : "earlier staged change";
}

function installResult(install: VerificationCheckInstall): string {
  const egress =
    install.egressAllowed === undefined || install.egressRefused === undefined
      ? ""
      : `; ${String(install.egressAllowed)} registry connections, ${String(install.egressRefused)} refused`;
  return `${INSTALL_LABEL[install.state]}, ${LOCKFILE_LABEL[install.lockfile]}${egress}`;
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function recordRows(record: VerificationCheckRecord, committedTreeDigest: string): string[] {
  const where = ranOn(record, committedTreeDigest);
  const install = record.install;
  const rows: string[] =
    install !== undefined && INSTALL_ROW_STATES.has(install.state)
      ? [
          tableRow([
            "dependency install",
            installResult(install),
            formatExitCode(install.exitCode),
            formatDuration(install.durationMs),
            where,
          ]),
        ]
      : [];
  for (const step of record.steps)
    rows.push(
      tableRow([
        KIND_LABEL[step.kind],
        STATUS_LABEL[step.status],
        formatExitCode(step.exitCode),
        formatDuration(step.durationMs),
        where,
      ]),
    );
  return rows;
}

function omittedLine(omitted: number): string {
  if (omitted === 0) return "";
  return `\n\n${String(omitted)} earlier verification ${omitted === 1 ? "call is" : "calls are"} not listed.`;
}

// The section describes one commit. A later commit pushed to the same pull request is not covered
// by it, and the section says so rather than letting a reader assume it (review on PR #3452).
function evidenceLine(checks: Extract<DraftDeliveryChecks, { status: "listed" }>): string {
  return `Evidence for commit ${checks.headSha.slice(0, 12)}: ${checks.evidenceId}. Later commits on this branch are not covered here.`;
}

export interface RenderedDraftDeliveryChecks {
  readonly markdown: string;
  readonly rowCount: number;
}

/** The deterministic "Checks" section: every word is closed vocabulary, every value a number or id. */
export function renderDraftDeliveryChecks(
  checks: DraftDeliveryChecks,
): RenderedDraftDeliveryChecks {
  if (checks.status === "unavailable")
    return { markdown: `${HEADING}\n\n${UNAVAILABLE}`, rowCount: 0 };
  const rows = checks.history.records.flatMap((record) =>
    recordRows(record, checks.committedTreeDigest),
  );
  const table = rows.length === 0 ? NO_STEPS : `${TABLE_HEAD}\n${rows.join("\n")}\n\n${LEGEND}`;
  return {
    markdown: `${HEADING}\n\n${INTRO}\n\n${table}${omittedLine(checks.history.omitted)}\n\n${evidenceLine(checks)}`,
    rowCount: rows.length,
  };
}
