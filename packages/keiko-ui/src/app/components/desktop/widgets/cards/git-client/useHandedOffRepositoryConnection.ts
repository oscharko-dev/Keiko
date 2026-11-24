// #4103 F2: the Files window's Git button hands its folder to the Git window. A folder that was
// never connected in the Git window is not in its repository list, and the window used to discard it
// and show "No repository connected". An explicit hand-off now connects it the way "Open local
// repository" does: the same `registerRepository` call with the path alone (no trust is granted by
// it), the same body-free operation evidence, then the ordinary reconnect. A persisted path or one
// that was not handed off never registers itself; each hand-off is tried once per window mount.

import { useCallback, useRef } from "react";
import { correlationIdOf } from "@/lib/client-error-summary";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind, newClientCorrelationId, responseCorrelationIdOf } from "@/lib/http";
import type { ProjectWithAvailability } from "@/lib/types";
import { reportGitClientOperationDiagnostic } from "./git-client-operation-diagnostics";
import type { GitClientSeam } from "./git-client-seam";

export interface HandedOffRepositoryConnectionInput {
  /** The window was opened by an explicit hand-off of `configuredPath`. */
  readonly enabled: boolean;
  /** A window locked to the active task workspace never connects a hand-off itself. */
  readonly lockedToActiveRoot: boolean;
  readonly configuredPath: string | null;
  readonly client: GitClientSeam;
  readonly onStarted: () => void;
  readonly onAdded: (project: ProjectWithAvailability) => void;
  readonly onFailed: (error: unknown) => void;
  /** Ends the hand-off once it settled, so a later mount never repeats it. */
  readonly onSettled: () => void;
}

/** Returns `claim(path)`: true when the hand-off took over connecting that path. */
export function useHandedOffRepositoryConnection(
  input: HandedOffRepositoryConnectionInput,
): (path: string) => boolean {
  const { enabled, lockedToActiveRoot, configuredPath, client } = input;
  const { onStarted, onAdded, onFailed, onSettled } = input;
  const active = enabled && !lockedToActiveRoot;
  const claimedRef = useRef(false);
  return useCallback(
    (path: string): boolean => {
      if (!active || claimedRef.current || path !== configuredPath) return false;
      claimedRef.current = true;
      onStarted();
      const correlationId = newClientCorrelationId();
      const operation = "repository-register";
      reportGitClientOperationDiagnostic(
        "git-client: handed-off repository-register started",
        { operation, outcome: "started" },
        { correlationId },
      );
      void client.registerRepository({ path }, correlationId).then(
        (response): void => {
          reportGitClientOperationDiagnostic(
            "git-client: handed-off repository-register succeeded",
            { operation, outcome: "succeeded" },
            { correlationId: responseCorrelationIdOf(response) ?? correlationId },
          );
          onSettled();
          onAdded(response.project);
        },
        (error: unknown): void => {
          reportGitClientOperationDiagnostic(
            "git-client: handed-off repository-register failed",
            { operation, outcome: "failed" },
            {
              correlationId: correlationIdOf(error) ?? correlationId,
              errorKind: bffRequestErrorKind(error),
              errorEvidence: clientErrorEvidence(error),
            },
          );
          onSettled();
          onFailed(error);
        },
      );
      return true;
    },
    [active, client, configuredPath, onAdded, onFailed, onSettled, onStarted],
  );
}
