"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCodingWorkbenchReconnectOutcome } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportCodingWorkbenchInteraction } from "@/lib/coding-workbench-interaction";
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
  /** Reconnects the folder that is already selected; on success it tells the caller, never selects. */
  readonly reconnectSelected: (path: string) => void;
  readonly failed: boolean;
  /** Where the failed attempt started: the Reconnect button or a choice in the picker. */
  readonly failedFrom: ReconnectOrigin | null;
  /** A reconnect is running: the picker stays locked so no choice can be dropped or replaced. */
  readonly reconnecting: boolean;
}

export type ReconnectOrigin = "button" | "picker";

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

// Body-free: the closed outcome and a fresh correlation id, never the folder path.
function reportReconnected(outcome: ClientCodingWorkbenchReconnectOutcome): void {
  reportCodingWorkbenchInteraction(
    { interaction: "repository-reconnected", outcome },
    newClientCorrelationId(),
  );
}

// Where a settled request lands. A selector that is gone applies nothing — the window closed or
// rebuilt it (U-44) — and a choice a later one replaced is not applied either; `selected` is the
// live choice, which a failure also shows.
function reconnectOutcome(
  mounted: boolean,
  latest: boolean,
): ClientCodingWorkbenchReconnectOutcome {
  if (!mounted) return "selector-gone";
  return latest ? "selected" : "superseded";
}

// A reconnect is a state-changing request, which the shared client gives no read deadline. The
// picker stays locked while it runs, so a hung request would lock it for good: the wait ends as a
// `TimeoutError` failure instead (U-44). A server-side reconnect that finishes after the deadline
// still shows the failure; the catalog is read again the next time the picker opens.
export const RECONNECT_TIMEOUT_MS = 30_000;

function withReconnectDeadline<T>(request: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException("The reconnect did not answer in time.", "TimeoutError"));
    }, RECONNECT_TIMEOUT_MS);
    request.then(resolve, reject).finally(() => clearTimeout(timer));
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

// The caller's own handler (select, window rebind) must not turn a reconnect that worked into an
// unhandled rejection: its throw is reported on its own, body-free, and never as a reconnect failure.
function applyReconnected(apply: (path: string) => void, path: string): void {
  try {
    apply(path);
  } catch (error) {
    reportClientDiagnostic("[keiko] coding workbench repository reconnect follow-up failed", {
      kind: "other",
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
      correlationId: correlationIdOf(error) ?? newClientCorrelationId(),
    });
  }
}

function useReconnectStatus(): {
  readonly failedFrom: ReconnectOrigin | null;
  readonly setFailedFrom: (origin: ReconnectOrigin | null) => void;
  readonly reconnecting: boolean;
  readonly setReconnecting: (reconnecting: boolean) => void;
} {
  const [failedFrom, setFailedFrom] = useState<ReconnectOrigin | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  return { failedFrom, setFailedFrom, reconnecting, setReconnecting };
}

// One request per folder; where it settles follows the person's latest choice (see `settle`).
function useReconnectRequest(
  reload: () => void,
  latest: { readonly current: string | null },
  { setFailedFrom, setReconnecting }: ReturnType<typeof useReconnectStatus>,
): (path: string, apply: (path: string) => void, origin: ReconnectOrigin) => void {
  const mounted = useMounted();
  const inFlight = useRef(new Set<string>());
  const settle = useCallback(
    (
      path: string,
      failure: ReconnectFailure,
      apply: (path: string) => void,
      origin: ReconnectOrigin,
    ): void => {
      inFlight.current.delete(path);
      if (mounted.current) setReconnecting(inFlight.current.size > 0);
      const outcome = reconnectOutcome(mounted.current, latest.current === path);
      if (failure !== null) {
        if (outcome !== "selector-gone") reportReconnectFailure(failure);
        if (outcome === "selected") setFailedFrom(origin);
        return;
      }
      // The catalog is read again for every successful reconnect, even a superseded one, so the
      // folder stops reading as changed.
      if (outcome !== "selector-gone") reload();
      if (outcome === "selected") applyReconnected(apply, path);
      reportReconnected(outcome);
    },
    [mounted, latest, reload, setFailedFrom, setReconnecting],
  );
  return useCallback(
    (path: string, apply: (path: string) => void, origin: ReconnectOrigin): void => {
      if (inFlight.current.has(path)) return;
      inFlight.current.add(path);
      setReconnecting(true);
      void withReconnectDeadline(DEFAULT_GIT_CLIENT.reconnectRepository(path)).then(
        (response): void =>
          settle(
            path,
            response.project.workspaceAvailable === true ? null : { error: undefined },
            apply,
            origin,
          ),
        (error: unknown): void => settle(path, { error }, apply, origin),
      );
    },
    [settle, setReconnecting],
  );
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
  onReconnected?: (() => void) | undefined,
): RepositoryReconnect {
  const status = useReconnectStatus();
  const { failedFrom, setFailedFrom, reconnecting } = status;
  const latest = useRef<string | null>(null);
  const reconnect = useReconnectRequest(reload, latest, status);
  const choose = useCallback(
    (path: string): void => {
      latest.current = path;
      setFailedFrom(null);
      const project = repositories.find((entry) => entry.path === path);
      if (project !== undefined && needsReconnect(project)) reconnect(path, onSelect, "picker");
      else onSelect(path);
    },
    [onSelect, reconnect, repositories, setFailedFrom],
  );
  const reconnectSelected = useCallback(
    (path: string): void => {
      latest.current = path;
      setFailedFrom(null);
      reconnect(path, () => onReconnected?.(), "button");
    },
    [onReconnected, reconnect, setFailedFrom],
  );
  return { choose, reconnectSelected, failed: failedFrom !== null, failedFrom, reconnecting };
}
