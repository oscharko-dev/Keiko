// Issue #197 — state management hook for the connector graph, split out to keep
// connector-graph.tsx under 400 LOC and each function under 50 LOC.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  fetchCapsules,
  createCapsule,
  startIndexing,
  cancelIndexing,
  disconnectCapsule,
} from "@/lib/local-knowledge-api";
import { ApiError } from "@/lib/api";
import type {
  ConnectorGraphProps,
  ConnectorGraphState,
  CapsuleListEntry,
  CapsuleActionResponse,
  LoadStatus,
} from "./connector-graph-types";

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

function useCapsuleLoader(fetchCapsulesImpl: typeof fetchCapsules): {
  capsules: readonly CapsuleListEntry[];
  loadStatus: LoadStatus;
  loadError: string | null;
  reload: () => void;
} {
  const [capsules, setCapsules] = useState<readonly CapsuleListEntry[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoadStatus("loading");
    setLoadError(null);
    try {
      const response = await fetchCapsulesImpl();
      setCapsules(response.capsules);
      setLoadStatus("ready");
    } catch (error) {
      setLoadError(formatError(error));
      setLoadStatus("error");
    }
  }, [fetchCapsulesImpl]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Wrap the async callback in a void-returning function so that callers typed
  // as `() => void` (button onClick, useConnectorGraph return) never receive a
  // Promise — satisfying @typescript-eslint/no-misused-promises.
  function triggerReload(): void {
    void reload();
  }

  return { capsules, loadStatus, loadError, reload: triggerReload };
}

function useCapsuleActions(
  reload: () => void,
  startIndexingImpl: typeof startIndexing,
  cancelIndexingImpl: typeof cancelIndexing,
  disconnectCapsuleImpl: typeof disconnectCapsule,
): {
  actionBusy: KnowledgeCapsuleId | null;
  actionError: string | null;
  handleStartIndexing: (id: KnowledgeCapsuleId) => void;
  handleCancelIndexing: (id: KnowledgeCapsuleId) => void;
  handleDisconnect: (id: KnowledgeCapsuleId) => void;
  handleOpenHealth: (id: KnowledgeCapsuleId) => void;
} {
  const router = useRouter();
  const [actionBusy, setActionBusy] = useState<KnowledgeCapsuleId | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runAction(
    id: KnowledgeCapsuleId,
    action: () => Promise<CapsuleActionResponse>,
  ): Promise<void> {
    setActionBusy(id);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setActionBusy(null);
    }
  }

  function handleStartIndexing(id: KnowledgeCapsuleId): void {
    void runAction(id, () => startIndexingImpl(id));
  }
  function handleCancelIndexing(id: KnowledgeCapsuleId): void {
    void runAction(id, () => cancelIndexingImpl(id));
  }
  function handleDisconnect(id: KnowledgeCapsuleId): void {
    void runAction(id, () => disconnectCapsuleImpl(id));
  }
  function handleOpenHealth(id: KnowledgeCapsuleId): void {
    router.push(`/local-knowledge/capsule?capsuleId=${encodeURIComponent(id)}`);
  }

  return {
    actionBusy,
    actionError,
    handleStartIndexing,
    handleCancelIndexing,
    handleDisconnect,
    handleOpenHealth,
  };
}

function useCapsuleCreate(
  createCapsuleImpl: typeof createCapsule,
  reload: () => void,
): {
  creating: boolean;
  createError: string | null;
  handleCreateCapsule: (name: string) => Promise<void>;
} {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function doCreate(name: string): Promise<void> {
    setCreating(true);
    setCreateError(null);
    try {
      await createCapsuleImpl({ displayName: name });
      reload();
    } catch (error) {
      setCreateError(formatError(error));
    } finally {
      setCreating(false);
    }
  }

  return { creating, createError, handleCreateCapsule: doCreate };
}

export function useConnectorGraph(props: ConnectorGraphProps): ConnectorGraphState {
  const {
    fetchCapsulesImpl = fetchCapsules,
    createCapsuleImpl = createCapsule,
    startIndexingImpl = startIndexing,
    cancelIndexingImpl = cancelIndexing,
    disconnectCapsuleImpl = disconnectCapsule,
  } = props;

  const { capsules, loadStatus, loadError, reload } = useCapsuleLoader(fetchCapsulesImpl);
  const {
    actionBusy,
    actionError,
    handleStartIndexing,
    handleCancelIndexing,
    handleDisconnect,
    handleOpenHealth,
  } = useCapsuleActions(reload, startIndexingImpl, cancelIndexingImpl, disconnectCapsuleImpl);
  const { creating, createError, handleCreateCapsule } = useCapsuleCreate(
    createCapsuleImpl,
    reload,
  );

  return {
    capsules,
    loadStatus,
    loadError,
    actionBusy,
    actionError,
    creating,
    createError,
    reload,
    handleStartIndexing,
    handleCancelIndexing,
    handleDisconnect,
    handleOpenHealth,
    handleCreateCapsule,
  };
}
