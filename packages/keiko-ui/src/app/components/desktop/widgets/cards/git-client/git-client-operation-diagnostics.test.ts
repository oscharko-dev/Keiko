// PR #3625 review: this helper is the one place a Git-client operation settlement is built, shared
// by AddRepositoryDialog.tsx (a discarded clone/register result) and GitClientWindow.tsx's manual
// Retry controls (a status/branches/summary read). These tests pin its exact `reportClientDiagnostic`
// call shape directly, independent of either call site.

import { afterEach, describe, expect, it } from "vitest";
import {
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { reportGitClientOperationDiagnostic } from "./git-client-operation-diagnostics";

interface CapturedDiagnostic {
  readonly message: string;
  readonly meta: ClientDiagnosticMeta | undefined;
}

function captureDiagnostics(): CapturedDiagnostic[] {
  const diagnostics: CapturedDiagnostic[] = [];
  setClientDiagnosticWriter((message, meta) => diagnostics.push({ message, meta }));
  return diagnostics;
}

afterEach(() => {
  resetClientDiagnosticWriter();
});

describe("reportGitClientOperationDiagnostic", () => {
  it("reports the settlement with kind other and no correlation id or error kind when omitted", () => {
    const diagnostics = captureDiagnostics();

    reportGitClientOperationDiagnostic("git-client: status retry recovered", {
      operation: "status-read",
      outcome: "retry-recovered",
    });

    expect(diagnostics).toEqual([
      {
        message: "git-client: status retry recovered",
        meta: {
          kind: "other",
          gitClientOperation: { operation: "status-read", outcome: "retry-recovered" },
        },
      },
    ]);
  });

  it("carries the correlation id and error kind through when supplied, and only then", () => {
    const diagnostics = captureDiagnostics();

    reportGitClientOperationDiagnostic(
      "git-client: branches retry failed",
      { operation: "branches-read", outcome: "retry-failed" },
      { correlationId: "corr-branches-retry-1", errorKind: "unavailable" },
    );

    expect(diagnostics).toEqual([
      {
        message: "git-client: branches retry failed",
        meta: {
          kind: "other",
          gitClientOperation: { operation: "branches-read", outcome: "retry-failed" },
          correlationId: "corr-branches-retry-1",
          errorKind: "unavailable",
        },
      },
    ]);
  });

  it("omits an undefined correlation id or error kind rather than sending the key with an undefined value", () => {
    const diagnostics = captureDiagnostics();

    reportGitClientOperationDiagnostic(
      "git-client: summary retry recovered",
      { operation: "summary-read", outcome: "retry-recovered" },
      { correlationId: undefined, errorKind: undefined },
    );

    expect(diagnostics[0]?.meta).not.toHaveProperty("correlationId");
    expect(diagnostics[0]?.meta).not.toHaveProperty("errorKind");
  });

  it("delegates to the shared reportClientDiagnostic sink rather than a private transport", () => {
    // A structural check that this helper is a thin wrapper, not a second diagnostic pipeline
    // (AGENTS.md §5): calling it must be observable through the SAME writer every other
    // `reportClientDiagnostic` call site installs.
    let sawIt = false;
    setClientDiagnosticWriter(() => {
      sawIt = true;
    });
    reportGitClientOperationDiagnostic("git-client: repository-clone discarded", {
      operation: "repository-clone",
      outcome: "discarded-succeeded",
    });
    expect(sawIt).toBe(true);
    expect(reportClientDiagnostic).toBeTypeOf("function");
  });
});
