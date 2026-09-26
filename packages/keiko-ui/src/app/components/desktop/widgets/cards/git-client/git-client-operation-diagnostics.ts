// Shared Git-client operation settlement diagnostic (PR #3625 review).
//
// A Git-client operation can settle after the surface that asked for it is already gone: the
// Add-repository dialog can be closed while its clone/register request is still in flight, and a
// manual retry of the status/branches/summary reads can recover or fail after its own panel
// unmounted. Reporting only a generic failure-shaped message collapsed every one of these into one
// indistinguishable warn-level digest — it could not show that a repository was created but
// deliberately not activated, tell a discarded clone from a discarded register, or tell a recovered
// retry from one that failed again.
//
// AddRepositoryDialog.tsx and GitClientWindow.tsx's manual Retry controls both settle through this
// one helper, so the closed `operation`/`outcome` vocabulary (packages/keiko-contracts/src/
// diagnostics.ts) and the correlation id / error kind plumbing stay in exactly one place instead of
// being hand-built at each call site.

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type {
  ClientDiagnosticGitClientOperation,
  ClientErrorEvidence,
  ClientGitRetryOperation,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type { ActivityLogErrorKind } from "@oscharko-dev/keiko-contracts/runtime/observability";

export interface GitClientOperationDiagnosticOptions {
  // The originating request's correlation id, when the caller has one (`correlationIdOf(error)` for
  // a failed request). A succeeded request rarely carries one — `ProjectResponse`
  // (keiko-contracts/bff-wire.ts) has no general-purpose correlation id on success — so callers
  // reporting a discarded success typically omit this.
  readonly correlationId?: string | undefined;
  // The closed class of the failure, when the settlement is a failure outcome (`bffRequestErrorKind`).
  readonly errorKind?: ActivityLogErrorKind | undefined;
  // Body-free error evidence (`clientErrorEvidence(error)`) for a failed settlement raised by a
  // thrown error: the error's class, its dist-anchored frames and cause chain — never its message
  // (PR #3625 review). Omitted for a settlement with no thrown error (a resolved unavailable
  // response, a discarded success, a recovered or superseded retry).
  readonly errorEvidence?: ClientErrorEvidence | undefined;
}

/**
 * Reports a Git-client operation settling after its own surface (a dialog, a panel) is already
 * gone: which operation, and how it settled — never the repository, path or URL involved. `message`
 * is the already-redacted, body-free console text `reportClientDiagnostic` requires; only the
 * closed `gitClientOperation` fields, `correlationId`, `errorKind` and `errorEvidence` reach the
 * activity log.
 */
export function reportGitClientOperationDiagnostic(
  message: string,
  gitClientOperation: ClientDiagnosticGitClientOperation,
  options?: GitClientOperationDiagnosticOptions,
): void {
  reportClientDiagnostic(message, {
    kind: "other",
    gitClientOperation,
    ...(options?.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    ...(options?.errorKind === undefined ? {} : { errorKind: options.errorKind }),
    ...(options?.errorEvidence === undefined ? {} : { errorEvidence: options.errorEvidence }),
  });
}

/**
 * Reports a manual retry's attempt the moment it starts, minting no evidence beyond which read and
 * a correlation id the caller has already minted (`newClientCorrelationId()`). Its settlement —
 * recovered, failed or superseded — reuses the SAME id, so the pair joins on one timeline even when
 * a newer automatic read supersedes the retry before it settles (PR #3625 review).
 */
export function reportGitClientRetryAttempt(
  message: string,
  operation: ClientGitRetryOperation,
  correlationId: string,
): void {
  reportClientDiagnostic(message, { gitRetryAttemptReport: { operation, correlationId } });
}
