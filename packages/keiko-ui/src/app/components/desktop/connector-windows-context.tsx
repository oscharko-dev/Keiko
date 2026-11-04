"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";

/** Opens the central management windows behind the connector menu's "Manage" links. */
export interface ConnectorWindows {
  readonly manageServers: () => void;
  readonly managePods: () => void;
}

const ConnectorWindowsContext = createContext<ConnectorWindows | undefined>(undefined);

export function ConnectorWindowsProvider({
  value,
  children,
}: {
  readonly value: ConnectorWindows | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ConnectorWindowsContext.Provider value={value}>{children}</ConnectorWindowsContext.Provider>
  );
}

export function useConnectorWindows(): ConnectorWindows | undefined {
  return useContext(ConnectorWindowsContext);
}

/** The Settings MCP tab and the Knowledge Pods window, opened through the workspace. */
export function useWorkspaceConnectorWindows(
  add: WorkspaceApi["add"] | undefined,
): ConnectorWindows | undefined {
  return useMemo(
    () =>
      add === undefined
        ? undefined
        : {
            manageServers: (): void => {
              add("settings", { initialTab: "mcp" });
            },
            managePods: (): void => {
              add("localKnowledge");
            },
          },
    [add],
  );
}
