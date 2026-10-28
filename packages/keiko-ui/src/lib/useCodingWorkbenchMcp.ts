"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodingWorkbenchMcpAuthorizationRefusal,
  CodingWorkbenchMcpServer,
} from "@oscharko-dev/keiko-contracts";

import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "./coding-app-session-client";
import {
  fetchCodingWorkbenchRuntimeMcp,
  readCodingWorkbenchMcpAuthorization,
  startCodingWorkbenchMcpAuthorization,
} from "./coding-workbench-runtime-api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";

export type CodingWorkbenchMcpListStatus = "idle" | "loading" | "ready" | "unavailable";

/** What the human sees of an authorization: running, waiting on the browser, or its outcome. */
export type CodingWorkbenchMcpAuthorization =
  | { readonly phase: "starting"; readonly server: string }
  | {
      readonly phase: "waiting";
      readonly server: string;
      readonly attemptId: string;
      readonly authorizationUrl: string;
      readonly expiresAtMs: number;
    }
  | {
      readonly phase: "settled";
      readonly server: string;
      readonly outcome: "complete" | "failed" | "expired" | CodingWorkbenchMcpAuthorizationRefusal;
    };

export interface UseCodingWorkbenchMcpResult {
  readonly status: CodingWorkbenchMcpListStatus;
  readonly servers: readonly CodingWorkbenchMcpServer[];
  readonly authorization: CodingWorkbenchMcpAuthorization | undefined;
  readonly authorize: (server: string) => void;
  readonly cancel: () => void;
  readonly retry: () => void;
}

/** How often an open attempt is read while the human authorizes in the browser. */
export const MCP_AUTHORIZATION_POLL_MS = 2_000;

interface ListState {
  readonly runId: string | undefined;
  readonly status: CodingWorkbenchMcpListStatus;
  readonly servers: readonly CodingWorkbenchMcpServer[];
}

/**
 * A live run's MCP servers and the human's OAuth authorization of one (#3903 AC3). The list comes
 * from the run's authenticated channel; an authorization is started on the server, which answers
 * with the authorization page only once it belongs to the operator's expected issuer.
 */
export function useCodingWorkbenchMcp(input: {
  readonly runId: string | undefined;
  readonly revision: number | undefined;
}): UseCodingWorkbenchMcpResult {
  const { runId, revision } = input;
  const [list, setList] = useState<ListState>({ runId, status: "idle", servers: [] });
  const [epoch, setEpoch] = useState(0);
  const [authorization, setAuthorization] = useState<CodingWorkbenchMcpAuthorization>();
  const redemptions = useCodingAppSessionRedemptions();
  const retry = useCallback((): void => setEpoch((value) => value + 1), []);

  useEffect(() => {
    if (runId === undefined) {
      setList({ runId, status: "idle", servers: [] });
      return;
    }
    setList((current) => ({ runId, status: "loading", servers: current.servers }));
    return startMcpRead(runId, setList);
  }, [runId, revision, epoch, redemptions]);

  const authorize = useAuthorize(runId, setAuthorization);
  usePolling(runId, authorization, setAuthorization, retry);
  const cancel = useCallback((): void => {
    if (runId === undefined || authorization?.phase !== "waiting") return;
    const { server, attemptId } = authorization;
    setAuthorization(undefined);
    void readCodingWorkbenchMcpAuthorization(runId, { server, attemptId }, true).catch(
      (error: unknown) => {
        reportMcpFailure("cancel", error);
      },
    );
  }, [runId, authorization]);

  const current = list.runId === runId ? list : { runId, status: "idle" as const, servers: [] };
  return {
    status: current.status,
    servers: current.servers,
    authorization: authorization,
    authorize,
    cancel,
    retry,
  };
}

function startMcpRead(runId: string, publish: (state: ListState) => void): () => void {
  const controller = new AbortController();
  const pairingSettled = codingAppSessionPairingSettled();
  async function read(): Promise<void> {
    try {
      await pairingSettled;
      if (controller.signal.aborted) return;
      const payload = await fetchCodingWorkbenchRuntimeMcp(runId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      publish(
        payload.session === "unpaired"
          ? { runId, status: "unavailable", servers: [] }
          : { runId, status: "ready", servers: payload.servers ?? [] },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      reportMcpFailure("list", error);
      publish({ runId, status: "unavailable", servers: [] });
    }
  }
  void read();
  return (): void => {
    controller.abort();
  };
}

function useAuthorize(
  runId: string | undefined,
  publish: (state: CodingWorkbenchMcpAuthorization | undefined) => void,
): (server: string) => void {
  return useCallback(
    (server: string): void => {
      if (runId === undefined) return;
      publish({ phase: "starting", server });
      startCodingWorkbenchMcpAuthorization(runId, server).then(
        (start) => {
          publish(
            start.outcome === "started"
              ? {
                  phase: "waiting",
                  server,
                  attemptId: start.attemptId,
                  authorizationUrl: start.authorizationUrl,
                  expiresAtMs: start.expiresAtMs,
                }
              : { phase: "settled", server, outcome: start.reason },
          );
        },
        (error: unknown) => {
          reportMcpFailure("start", error);
          publish({ phase: "settled", server, outcome: "failed" });
        },
      );
    },
    [runId, publish],
  );
}

// While an attempt waits on the browser, its state is read on an interval until it settles or its
// time is up; a settled success re-reads the list so the server shows as connecting or connected.
function usePolling(
  runId: string | undefined,
  authorization: CodingWorkbenchMcpAuthorization | undefined,
  publish: (state: CodingWorkbenchMcpAuthorization | undefined) => void,
  reload: () => void,
): void {
  const busy = useRef(false);
  useEffect(() => {
    if (runId === undefined || authorization?.phase !== "waiting") return;
    const { server, attemptId, expiresAtMs } = authorization;
    const timer = setInterval(() => {
      if (busy.current) return;
      if (Date.now() >= expiresAtMs) {
        publish({ phase: "settled", server, outcome: "expired" });
        return;
      }
      busy.current = true;
      readCodingWorkbenchMcpAuthorization(runId, { server, attemptId })
        .then((status) => {
          settleAttempt(server, status.state, publish, reload);
        })
        .catch((error: unknown) => {
          reportMcpFailure("status", error);
        })
        .finally(() => {
          busy.current = false;
        });
    }, MCP_AUTHORIZATION_POLL_MS);
    return (): void => {
      clearInterval(timer);
    };
  }, [runId, authorization, publish, reload]);
}

function settleAttempt(
  server: string,
  state: string,
  publish: (state: CodingWorkbenchMcpAuthorization | undefined) => void,
  reload: () => void,
): void {
  if (state === "pending") return;
  if (state === "complete") {
    publish({ phase: "settled", server, outcome: "complete" });
    reload();
    return;
  }
  publish({ phase: "settled", server, outcome: state === "expired" ? "expired" : "failed" });
}

function reportMcpFailure(step: "list" | "start" | "status" | "cancel", error: unknown): void {
  reportClientDiagnostic(`[keiko] mcp ${step} failed: ${clientErrorSummary(error)}`, {
    correlationId: correlationIdOf(error),
  });
}
