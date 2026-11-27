"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind, newClientCorrelationId } from "@/lib/http";
import type { ProjectWithAvailability } from "@/lib/types";
import { DEFAULT_GIT_CLIENT } from "../cards/git-client/git-client-seam";
import { needsReconnect } from "./codingWorkbenchRepositoryAvailability";

export interface RepositoryReconnect {
  /** The picker's selection handler: reconnects a changed folder, selects any other directly. */
  readonly choose: (path: string) => void;
  readonly failed: boolean;
}

// A reconnect that failed: a rejected request carries its error, a request that answered but left
// the workspace unavailable carries none.
type ReconnectFailure = { readonly error: unknown } | null;

// Body-free: the class of failure and a correlation id, never the folder path. A rejected request
// reports its own kind; a reconnect that answered but left the workspace unavailable is a `conflict`
// (the folder's identity still does not match what was registered).
function reportReconnectFailure(failure: { readonly error: unknown }): void {
  const rejected = failure.error !== undefined;
  reportClientDiagnostic("[keiko] coding workbench repository reconnect failed", {
    kind: "other",
    errorKind: rejected ? bffRequestErrorKind(failure.error) : "conflict",
    ...(rejected ? { errorEvidence: clientErrorEvidence(failure.error) } : {}),
    correlationId: correlationIdOf(failure.error) ?? newClientCorrelationId(),
  });
}

function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * Reconnects a drifted folder through the same `reconnectProject` call the Git window uses. It runs
 * only from `choose`, which the picker calls on the person's selection click — never on mount.
 * On success the catalog is read again and the folder is selected, but only while it is still the
 * person's latest choice; one request is in flight per folder.
 */
export function useRepositoryReconnect(
  repositories: readonly ProjectWithAvailability[],
  reload: () => void,
  onSelect: (root: string) => void,
): RepositoryReconnect {
  const [failed, setFailed] = useState(false);
  const mounted = useMounted();
  const latest = useRef<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const settle = useCallback(
    (path: string, failure: ReconnectFailure): void => {
      inFlight.current.delete(path);
      if (!mounted.current) return;
      if (failure !== null) reportReconnectFailure(failure);
      if (latest.current !== path) return;
      if (failure !== null) {
        setFailed(true);
        return;
      }
      reload();
      onSelect(path);
    },
    [mounted, onSelect, reload],
  );
  const reconnect = useCallback(
    (path: string): void => {
      if (inFlight.current.has(path)) return;
      inFlight.current.add(path);
      void DEFAULT_GIT_CLIENT.reconnectRepository(path).then(
        (response): void =>
          settle(path, response.project.workspaceAvailable === true ? null : { error: undefined }),
        (error: unknown): void => settle(path, { error }),
      );
    },
    [settle],
  );
  const choose = useCallback(
    (path: string): void => {
      latest.current = path;
      setFailed(false);
      const project = repositories.find((entry) => entry.path === path);
      if (project !== undefined && needsReconnect(project)) reconnect(path);
      else onSelect(path);
    },
    [onSelect, reconnect, repositories],
  );
  return { choose, failed };
}
