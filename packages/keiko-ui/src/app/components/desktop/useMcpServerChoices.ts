"use client";
import { useEffect, useState } from "react";
import type { McpSettingsSnapshot } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { bffFetchJson } from "@/lib/http";
import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "@/lib/coding-app-session-client";

/** One centrally configured, enabled MCP server a Chat or a Coding run can select. */
export interface McpServerChoice {
  readonly name: string;
  readonly state: "connected" | "attention" | "idle";
}

function serverChoices(snapshot: McpSettingsSnapshot): readonly McpServerChoice[] {
  return snapshot.servers
    .filter((server) => server.enabled)
    .map((server) => {
      const connection = snapshot.connections?.find((entry) => entry.name === server.name);
      if (connection?.authentication === "required" || connection?.state === "failed") {
        return { name: server.name, state: "attention" };
      }
      return { name: server.name, state: connection?.state === "connected" ? "connected" : "idle" };
    });
}

function readMcpServers(signal: AbortSignal): Promise<McpSettingsSnapshot> {
  return bffFetchJson<McpSettingsSnapshot>("/api/mcp/servers", { signal });
}

/**
 * The central MCP owner's enabled servers, read once per mount and again on `reload`. The list is a
 * projection only: selecting a server never grants more than the server-side authority allows.
 */
export function useMcpServerChoices(fetchSnapshot = readMcpServers): {
  readonly servers: readonly McpServerChoice[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly reload: () => void;
} {
  const [state, setState] = useState<{
    servers?: readonly McpServerChoice[];
    failed?: boolean;
  }>({});
  const [version, setVersion] = useState(0);
  const redemptions = useCodingAppSessionRedemptions();
  useEffect(() => {
    const controller = new AbortController();
    void codingAppSessionPairingSettled(controller.signal)
      .then(() => fetchSnapshot(controller.signal))
      .then((snapshot) => {
        if (!controller.signal.aborted) setState({ servers: serverChoices(snapshot) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, failed: true }));
      });
    return (): void => controller.abort();
  }, [fetchSnapshot, version, redemptions]);
  return {
    servers: state.servers ?? [],
    loading: state.servers === undefined && state.failed !== true,
    failed: state.failed === true,
    reload: (): void => setVersion((value) => value + 1),
  };
}
