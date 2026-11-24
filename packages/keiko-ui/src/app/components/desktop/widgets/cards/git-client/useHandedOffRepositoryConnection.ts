// #4103 F2: the Files window's Git button hands its folder to the Git window. A folder that was
// never connected in the Git window is not in its repository list, and the window used to discard it
// and show "No repository connected". An explicit hand-off now connects it the way "Open local
// repository" does: the same `registerRepository` call with the path alone (no trust is granted by
// it), the same body-free operation evidence, then the ordinary reconnect. A persisted path or one
// that was not handed off never registers itself.
//
// Each handed-off path is registered at most once while that hand-off is pending, so a re-run of the
// selection effect never repeats the call; once the hand-off settled, a new hand-off may connect any
// path again. A registration settles only the hand-off it started: when a newer hand-off named
// another folder meanwhile, the outcome neither ends that newer hand-off nor selects or persists its
// own path, and the window reloads its list so the newer hand-off proceeds. An outcome that arrives
// after a newer repository action of the window (the person picked another repository meanwhile)
// only ends its hand-off and never moves the selection.

import { useCallback, useLayoutEffect, useRef } from "react";
import { correlationIdOf } from "@/lib/client-error-summary";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind, newClientCorrelationId, responseCorrelationIdOf } from "@/lib/http";
import type { ProjectWithAvailability } from "@/lib/types";
import { reportGitClientOperationDiagnostic } from "./git-client-operation-diagnostics";
import type { GitClientSeam } from "./git-client-seam";

export interface HandedOffRepositoryConnectionInput {
  /**
   * The folder the window's explicit, unsettled hand-off names, or null when there is none (a
   * window locked to the active task workspace never has one).
   */
  readonly handOffPath: string | null;
  readonly client: GitClientSeam;
  /** The window's repository-action sequence; a newer action makes an outcome stale. */
  readonly actionSequence: { current: number };
  readonly onStarted: () => void;
  readonly onAdded: (project: ProjectWithAvailability) => void;
  readonly onFailed: (error: unknown) => void;
  /** Ends the hand-off once it settled, so a later mount never repeats it. */
  readonly onSettled: () => void;
  /** A newer hand-off replaced the one a registration served; the window lets the newer proceed. */
  readonly onSuperseded: () => void;
}

type RegistrationOutcome =
  | { readonly kind: "added"; readonly project: ProjectWithAvailability }
  | { readonly kind: "failed"; readonly error: unknown };

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

/** Returns `connect(path)`, which registers the handed-off path once per pending hand-off. */
export function useHandedOffRepositoryConnection(
  input: HandedOffRepositoryConnectionInput,
): (path: string) => void {
  const { handOffPath, client, actionSequence } = input;
  const { onStarted, onAdded, onFailed, onSettled, onSuperseded } = input;
  const claimedPathsRef = useRef<Set<string>>(new Set());
  // The hand-off pending when an outcome arrives, which may be newer than the one it served. It is
  // updated in the commit that carries a newer hand-off, so an outcome landing before that commit's
  // passive effects already sees it.
  const pendingHandOffRef = useRef(handOffPath);
  useLayoutEffect((): void => {
    pendingHandOffRef.current = handOffPath;
    if (handOffPath === null) claimedPathsRef.current.clear();
  }, [handOffPath]);
  return useCallback(
    (path: string): void => {
      if (path !== handOffPath || claimedPathsRef.current.has(path)) return;
      claimedPathsRef.current.add(path);
      const sequence = actionSequence.current + 1;
      actionSequence.current = sequence;
      const settle = (outcome: RegistrationOutcome): void => {
        const isCurrent = sequence === actionSequence.current;
        if (pendingHandOffRef.current !== path) {
          claimedPathsRef.current.delete(path);
          if (isCurrent) onSuperseded();
          return;
        }
        onSettled();
        if (!isCurrent) return;
        if (outcome.kind === "added") onAdded(outcome.project);
        else onFailed(outcome.error);
      };
      onStarted();
      const correlationId = newClientCorrelationId();
      reportRegistrationStarted(correlationId);
      void client.registerRepository({ path }, correlationId).then(
        (response): void => {
          reportRegistrationSucceeded(correlationId, response);
          settle({ kind: "added", project: response.project });
        },
        (error: unknown): void => {
          reportRegistrationFailed(correlationId, error);
          settle({ kind: "failed", error });
        },
      );
    },
    [actionSequence, client, handOffPath, onAdded, onFailed, onSettled, onStarted, onSuperseded],
  );
}
