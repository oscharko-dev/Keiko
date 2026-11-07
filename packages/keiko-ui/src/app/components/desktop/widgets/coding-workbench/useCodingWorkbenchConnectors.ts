"use client";

import { useEffect, useState } from "react";
import type { CodingWorkbenchConnectorScope } from "@oscharko-dev/keiko-contracts";

import { listAtlassianConnectors } from "@/lib/atlassian-connectors-api";

import type { ConnectorsMenuProps } from "../../ConnectorsMenu";
import { usePodChoices } from "../../useJiraPodChoices";
import { useMcpServerChoices } from "../../useMcpServerChoices";

/** What the composer's connector menu shows and changes; the window owns the selection. */
export type CodingWorkbenchConnectors = Pick<
  ConnectorsMenuProps,
  | "servers"
  | "selectedServers"
  | "pods"
  | "boundPodId"
  | "jiraAdministrationEnabled"
  | "onJiraAdministrationChange"
  | "loading"
  | "failed"
  | "onServersChange"
  | "onPodChange"
  | "onOpen"
>;

/**
 * The connectors the human selects for the next run (owner decision 2026-11-02): the centrally
 * configured MCP servers, every one offered until the person narrows them, and at most one Jira
 * Pod, none by default. The selection is sent with the start; the server alone decides what the
 * run may use. It is never remembered beyond this window, and a Pod only counts while it is still
 * offered as ready, so a Pod that stopped being usable can never ride along unseen.
 */
export function useCodingWorkbenchConnectors(list = listAtlassianConnectors): {
  readonly menu: CodingWorkbenchConnectors;
  readonly jiraPodId: string | undefined;
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly mcpServers: readonly string[] | undefined;
} {
  const servers = useMcpServerChoices();
  const catalog = usePodChoices(list, true);
  const [picked, setPicked] = useState("");
  const [administrationPodId, setAdministrationPodId] = useState<string>();
  const [mcpServers, setMcpServers] = useState<readonly string[] | undefined>(undefined);
  const jiraPodId = catalog.pods.some((pod) => pod.id === picked && pod.ready) ? picked : undefined;
  const jiraAdministrationEnabled = !catalog.failed && jiraPodId !== undefined && administrationPodId === jiraPodId;
  // Clear the next-start selection permanently when readiness is lost; this does not revoke a run.
  useEffect(() => {
    if (administrationPodId !== undefined && (catalog.failed || administrationPodId !== jiraPodId))
      setAdministrationPodId(undefined);
  }, [administrationPodId, catalog.failed, jiraPodId]);
  return {
    menu: {
      servers: servers.servers,
      selectedServers: mcpServers,
      pods: catalog.pods,
      boundPodId: jiraPodId,
      jiraAdministrationEnabled,
      onJiraAdministrationChange: (enabled) => setAdministrationPodId(enabled && !catalog.failed ? jiraPodId : undefined),
      loading: servers.loading || catalog.loading,
      failed: servers.failed || catalog.failed,
      onServersChange: (selection) => setMcpServers(selection ?? undefined),
      onPodChange: (podId) => {
        setAdministrationPodId(undefined);
        setPicked(podId ?? "");
      },
      onOpen: (): void => {
        servers.reload();
        catalog.reload();
      },
    },
    jiraPodId,
    connectorScopes: jiraAdministrationEnabled ? ["issue-tracker.admin"] : undefined,
    mcpServers,
  };
}
