// #4103 F2: the Files window's Git button hands its folder to the Git window. A folder that was
// never connected in the Git window is not in its repository list, and the window used to discard it
// and show "No repository connected". An explicit hand-off now connects it the way "Open local
// repository" does: the same `registerRepository` call with the path alone (no trust is granted by
// it), the same body-free operation evidence, then the ordinary reconnect. A persisted path or one
// that was not handed off never registers itself.
//
// Each handed-off path is registered at most once while that hand-off is pending, so a re-run of the
// selection effect never repeats the call; once the hand-off settled, a new hand-off may connect any
// path again. A registration outcome that arrives after a newer repository action of the window (the
// person picked another repository meanwhile) only ends the hand-off and never moves the selection.

import { useCallback, useEffect, useRef } from "react";
import { correlationIdOf } from "@/lib/client-error-summary";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind, newClientCorrelationId, responseCorrelationIdOf } from "@/lib/http";
import type { ProjectWithAvailability } from "@/lib/types";
import { reportGitClientOperationDiagnostic } from "./git-client-operation-diagnostics";
import type { GitClientSeam } from "./git-client-seam";

export interface HandedOffRepositoryConnectionInput {
  /** The window was opened by an explicit hand-off that has not settled yet. */
  readonly enabled: boolean;
  /** A window locked to the active task workspace never connects a hand-off itself. */
  readonly lockedToActiveRoot: boolean;
  readonly client: GitClientSeam;
  /** The window's repository-action sequence; a newer action makes an outcome stale. */
  readonly actionSequence: { current: number };
  readonly onStarted: () => void;
  readonly onAdded: (project: ProjectWithAvailability) => void;
  readonly onFailed: (error: unknown) => void;
  /** Ends the hand-off once it settled, so a later mount never repeats it. */
  readonly onSettled: () => void;
}

const OPERATION = "repository-register";

function reportRegistrationStarted(correlationId: string): void {
  reportGitClientOperationDiagnostic(
    "git-client: handed-off repository-register started",
    { operation: OPERATION, outcome: "started" },
    { correlationId },
  );
}

function reportRegistrationSucceeded(correlationId: string, response: unknown): void {
  reportGitClientOperationDiagnostic(
    "git-client: handed-off repository-register succeeded",
    { operation: OPERATION, outcome: "succeeded" },
    { correlationId: responseCorrelationIdOf(response) ?? correlationId },
  );
}

function reportRegistrationFailed(correlationId: string, error: unknown): void {
  reportGitClientOperationDiagnostic(
    "git-client: handed-off repository-register failed",
    { operation: OPERATION, outcome: "failed" },
    {
      correlationId: correlationIdOf(error) ?? correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    },
  );
}

/** Returns `connect(path)`, which registers a handed-off path once per pending hand-off. */
export function useHandedOffRepositoryConnection(
  input: HandedOffRepositoryConnectionInput,
): (path: string) => void {
  const { enabled, lockedToActiveRoot, client, actionSequence } = input;
  const { onStarted, onAdded, onFailed, onSettled } = input;
  const active = enabled && !lockedToActiveRoot;
  const claimedPathsRef = useRef<Set<string>>(new Set());
  useEffect((): void => {
    if (!active) claimedPathsRef.current.clear();
  }, [active]);
  return useCallback(
    (path: string): void => {
      if (!active || claimedPathsRef.current.has(path)) return;
      claimedPathsRef.current.add(path);
      const sequence = actionSequence.current + 1;
      actionSequence.current = sequence;
      const isCurrent = (): boolean => sequence === actionSequence.current;
      onStarted();
      const correlationId = newClientCorrelationId();
      reportRegistrationStarted(correlationId);
      void client.registerRepository({ path }, correlationId).then(
        (response): void => {
          reportRegistrationSucceeded(correlationId, response);
          onSettled();
          if (isCurrent()) onAdded(response.project);
        },
        (error: unknown): void => {
          reportRegistrationFailed(correlationId, error);
          onSettled();
          if (isCurrent()) onFailed(error);
        },
      );
    },
    [actionSequence, active, client, onAdded, onFailed, onSettled, onStarted],
  );
}
