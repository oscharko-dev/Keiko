"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import type { ProjectWithAvailability } from "@/lib/types";
import { DEFAULT_GIT_CLIENT } from "../cards/git-client/git-client-seam";
import { needsReconnect } from "./codingWorkbenchRepositoryAvailability";

export interface RepositoryReconnect {
  /** The picker's selection handler: reconnects a changed folder, selects any other directly. */
  readonly choose: (path: string) => void;
  readonly failed: boolean;
}

// Body-free: the class of failure and the request's correlation id, never the folder path.
function reportReconnectFailure(error: unknown): void {
  const correlationId = correlationIdOf(error);
  reportClientDiagnostic("[keiko] coding workbench repository reconnect failed", {
    kind: "other",
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

/**
 * Reconnects a drifted folder through the same `reconnectProject` call the Git window uses. It runs
 * only from `reconnect`, which the picker calls on the person's selection click — never on mount.
 * On success the catalog is read again and the folder is selected.
 */
export function useRepositoryReconnect(
  repositories: readonly ProjectWithAvailability[],
  reload: () => void,
  onSelect: (root: string) => void,
): RepositoryReconnect {
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const reconnect = useCallback(
    (path: string): void => {
      setFailed(false);
      void DEFAULT_GIT_CLIENT.reconnectRepository(path).then(
        (response): void => {
          if (!mounted.current) return;
          if (response.project.workspaceAvailable !== true) {
            setFailed(true);
            reportReconnectFailure(new Error("workspace not restored"));
            return;
          }
          reload();
          onSelect(path);
        },
        (error: unknown): void => {
          if (!mounted.current) return;
          setFailed(true);
          reportReconnectFailure(error);
        },
      );
    },
    [onSelect, reload],
  );
  const choose = useCallback(
    (path: string): void => {
      const project = repositories.find((entry) => entry.path === path);
      if (project !== undefined && needsReconnect(project)) reconnect(path);
      else onSelect(path);
    },
    [onSelect, reconnect, repositories],
  );
  return { choose, failed };
}
