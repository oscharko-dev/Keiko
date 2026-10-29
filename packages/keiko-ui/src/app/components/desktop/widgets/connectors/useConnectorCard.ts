"use client";
import { useState } from "react";
import type { AtlassianLivePodUpdateRequest } from "@oscharko-dev/keiko-contracts";
import type {
  AtlassianConnectorMetadata,
  AtlassianConnectorsClient,
  AtlassianConnectorVerifyStatus,
} from "@/lib/atlassian-connectors-api";
import { useConnectorOperation, type ConnectorOperation } from "./useConnectorOperation";
export type ConnectorEditMode = "rename" | "rotate";
interface CardPanels {
  readonly expanded: boolean;
  readonly confirming: boolean;
  readonly editing: ConnectorEditMode | undefined;
  readonly toggle: () => void;
  readonly askDelete: () => void;
  readonly cancelDelete: () => void;
  readonly edit: (mode: ConnectorEditMode) => void;
  readonly cancelEdit: () => void;
}
export interface CardController extends CardPanels {
  readonly verifyStatus: AtlassianConnectorVerifyStatus | undefined;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly operation: ConnectorOperation | undefined;
  readonly unconfirmed: boolean;
  readonly verify: () => void;
  readonly refresh: () => void;
  readonly confirmDelete: () => void;
  readonly update: (patch: AtlassianLivePodUpdateRequest) => void;
}
function useCardPanels(identity: string, busy: boolean): CardPanels {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editor, setEditor] = useState<{ key: string; mode: ConnectorEditMode }>();
  return {
    expanded,
    confirming,
    editing: editor?.key === identity ? editor.mode : undefined,
    toggle: (): void => {
      if (!busy) setExpanded((value) => !value);
    },
    askDelete: (): void => {
      if (!busy) setConfirming(true);
    },
    cancelDelete: (): void => {
      if (!busy) setConfirming(false);
    },
    edit: (mode): void => {
      if (!busy) setEditor({ key: identity, mode });
    },
    cancelEdit: (): void => {
      setEditor(undefined);
    },
  };
}
interface LocalVerification {
  readonly key: string;
  readonly status: AtlassianConnectorVerifyStatus;
}
export function useConnectorCard(
  client: AtlassianConnectorsClient,
  connector: AtlassianConnectorMetadata,
  onDeleted: (authRef: string) => void,
  onUpdated: (metadata: AtlassianConnectorMetadata) => void,
): CardController {
  const identity = `${connector.authRef}:${connector.generation ?? 1}`;
  const operation = useConnectorOperation(identity);
  const panels = useCardPanels(identity, operation.busy);
  const [verification, setVerification] = useState<LocalVerification>();
  const publish = (metadata: AtlassianConnectorMetadata | undefined): void => {
    if (metadata === undefined) onDeleted(connector.authRef);
    else onUpdated(metadata);
  };
  const inspect = async (): Promise<AtlassianConnectorMetadata | undefined> =>
    (await client.listConnectors()).find((item) => item.authRef === connector.authRef);
  return {
    ...operation,
    ...panels,
    verifyStatus: verification?.key === identity ? verification.status : undefined,
    refresh: () => operation.run("refresh", inspect, publish),
    verify: () =>
      operation.run(
        "verify",
        async () => ({
          result: await client.verifyConnector(connector.authRef),
          metadata: await inspect(),
        }),
        ({ result, metadata }) => {
          setVerification({ key: identity, status: result.status });
          publish(metadata);
        },
      ),
    confirmDelete: () =>
      operation.run(
        "delete",
        () => client.deleteConnector(connector.authRef),
        () => onDeleted(connector.authRef),
      ),
    update: (patch) =>
      operation.run(
        patch.apiToken === undefined ? "rename" : "rotate",
        () => client.updateConnector(connector.authRef, patch),
        (metadata) => {
          panels.cancelEdit();
          publish(metadata);
        },
      ),
  };
}
