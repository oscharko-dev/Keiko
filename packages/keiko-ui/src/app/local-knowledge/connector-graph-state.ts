// Issue #197 — state management hook for the connector graph, split out to keep
// connector-graph.tsx under 400 LOC and each function under 50 LOC.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type {
  KnowledgeCapsuleId,
  CapsuleSetId,
  KnowledgePodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";
import {
  capsulesForKnowledgePodUi,
  capsuleSetsForKnowledgePodUi,
  fetchCapsules,
  fetchCapsuleSets,
  createCapsule,
  startIndexing,
  cancelIndexing,
  disconnectCapsule,
  deleteCapsuleSet,
} from "@/lib/local-knowledge-api";
import { formatError } from "./format-error";
import type {
  ConnectorGraphProps,
  ConnectorGraphState,
  CapsuleListEntry,
  CapsuleActionResponse,
  LoadStatus,
  RowActionKind,
} from "./connector-graph-types";

function emptyCapsuleSets(): ReturnType<typeof fetchCapsuleSets> {
  return Promise.resolve({ capsuleSets: [] });
}

function useCapsuleLoader(
  fetchCapsulesImpl: typeof fetchCapsules,
  fetchCapsuleSetsImpl: typeof fetchCapsuleSets,
): {
  capsules: readonly CapsuleListEntry[];
  capsuleSets: ConnectorGraphState["capsuleSets"];
  loadStatus: LoadStatus;
  loadError: string | null;
  reload: () => void;
} {
  const [capsules, setCapsules] = useState<readonly CapsuleListEntry[]>([]);
  const [capsuleSets, setCapsuleSets] = useState<ConnectorGraphState["capsuleSets"]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoadStatus("loading");
    setLoadError(null);
    try {
      const [capsuleResponse, capsuleSetResponse] = await Promise.all([
        fetchCapsulesImpl({ includeKnowledgePods: true }),
        fetchCapsuleSetsImpl({ includeKnowledgePods: true }),
      ]);
      setCapsules(capsulesForKnowledgePodUi(capsuleResponse));
      setCapsuleSets(capsuleSetsForKnowledgePodUi(capsuleSetResponse));
      setLoadStatus("ready");
    } catch (error) {
      setLoadError(formatError(error));
      setLoadStatus("error");
    }
  }, [fetchCapsulesImpl, fetchCapsuleSetsImpl]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Wrap the async callback in a void-returning function so that callers typed
  // as `() => void` (button onClick, useConnectorGraph return) never receive a
  // Promise — satisfying @typescript-eslint/no-misused-promises.
  function triggerReload(): void {
    void reload();
  }

  return { capsules, capsuleSets, loadStatus, loadError, reload: triggerReload };
}

function useCapsuleActions(
  reload: () => void,
  startIndexingImpl: typeof startIndexing,
  cancelIndexingImpl: typeof cancelIndexing,
  disconnectCapsuleImpl: typeof disconnectCapsule,
  onOpenCapsule: ((id: KnowledgeCapsuleId) => void) | undefined,
): {
  actionBusy: KnowledgeCapsuleId | null;
  actionKind: RowActionKind | null;
  actionError: string | null;
  clearActionError: () => void;
  handleStartIndexing: (id: KnowledgeCapsuleId) => void;
  handleCancelIndexing: (id: KnowledgeCapsuleId) => void;
  handleDisconnect: (id: KnowledgeCapsuleId) => void;
  handleOpenHealth: (id: KnowledgeCapsuleId) => void;
} {
  const router = useRouter();
  const [actionBusy, setActionBusy] = useState<KnowledgeCapsuleId | null>(null);
  // Tracked alongside the busy id so the row can swap the triggered button's
  // label to "Indexing…" / "Cancelling…" / "Disconnecting…" — matching the
  // detail page's busy feedback (uiux-fix F048, C233).
  const [actionKind, setActionKind] = useState<RowActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runAction(
    id: KnowledgeCapsuleId,
    kind: RowActionKind,
    action: () => Promise<CapsuleActionResponse>,
  ): Promise<void> {
    setActionBusy(id);
    setActionKind(kind);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setActionBusy(null);
      setActionKind(null);
    }
  }

  function handleStartIndexing(id: KnowledgeCapsuleId): void {
    void runAction(id, "index", () => startIndexingImpl(id));
  }
  function handleCancelIndexing(id: KnowledgeCapsuleId): void {
    void runAction(id, "cancel", () => cancelIndexingImpl(id));
  }
  function handleDisconnect(id: KnowledgeCapsuleId): void {
    void runAction(id, "disconnect", () => disconnectCapsuleImpl(id));
  }
  function handleOpenHealth(id: KnowledgeCapsuleId): void {
    if (onOpenCapsule !== undefined) {
      onOpenCapsule(id);
      return;
    }
    router.push(`/local-knowledge/capsule?capsuleId=${encodeURIComponent(id)}`);
  }

  // Error banners need an explicit dismiss — previously they stuck around
  // until the next action replaced them (uiux-fix F032, C230).
  function clearActionError(): void {
    setActionError(null);
  }

  return {
    actionBusy,
    actionKind,
    actionError,
    clearActionError,
    handleStartIndexing,
    handleCancelIndexing,
    handleDisconnect,
    handleOpenHealth,
  };
}

function useCapsuleSetActions(
  reload: () => void,
  deleteCapsuleSetImpl: typeof deleteCapsuleSet,
): {
  capsuleSetActionBusy: CapsuleSetId | null;
  capsuleSetActionError: string | null;
  clearCapsuleSetActionError: () => void;
  handleDeleteCapsuleSet: (id: CapsuleSetId) => void;
} {
  const [capsuleSetActionBusy, setCapsuleSetActionBusy] = useState<CapsuleSetId | null>(null);
  const [capsuleSetActionError, setCapsuleSetActionError] = useState<string | null>(null);

  async function runDelete(id: CapsuleSetId): Promise<void> {
    setCapsuleSetActionBusy(id);
    setCapsuleSetActionError(null);
    try {
      await deleteCapsuleSetImpl(id);
      reload();
    } catch (error) {
      setCapsuleSetActionError(formatError(error));
    } finally {
      setCapsuleSetActionBusy(null);
    }
  }

  function handleDeleteCapsuleSet(id: CapsuleSetId): void {
    void runDelete(id);
  }

  function clearCapsuleSetActionError(): void {
    setCapsuleSetActionError(null);
  }

  return {
    capsuleSetActionBusy,
    capsuleSetActionError,
    clearCapsuleSetActionError,
    handleDeleteCapsuleSet,
  };
}

function useCapsuleCreate(
  createCapsuleImpl: typeof createCapsule,
  reload: () => void,
): {
  creating: boolean;
  createError: string | null;
  clearCreateError: () => void;
  handleCreateCapsule: (name: string, modelUsePolicy: KnowledgePodModelUsePolicy) => Promise<void>;
} {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function doCreate(name: string, modelUsePolicy: KnowledgePodModelUsePolicy): Promise<void> {
    setCreating(true);
    setCreateError(null);
    try {
      await createCapsuleImpl({ displayName: name, modelUsePolicy });
      reload();
    } catch (error) {
      setCreateError(formatError(error));
    } finally {
      setCreating(false);
    }
  }

  function clearCreateError(): void {
    setCreateError(null);
  }

  return { creating, createError, clearCreateError, handleCreateCapsule: doCreate };
}

export function useConnectorGraph(props: ConnectorGraphProps): ConnectorGraphState {
  const {
    fetchCapsulesImpl = fetchCapsules,
    fetchCapsuleSetsImpl = props.fetchCapsulesImpl === undefined
      ? fetchCapsuleSets
      : emptyCapsuleSets,
    createCapsuleImpl = createCapsule,
    startIndexingImpl = startIndexing,
    cancelIndexingImpl = cancelIndexing,
    disconnectCapsuleImpl = disconnectCapsule,
    deleteCapsuleSetImpl = deleteCapsuleSet,
    onOpenCapsule,
  } = props;

  const { capsules, capsuleSets, loadStatus, loadError, reload } = useCapsuleLoader(
    fetchCapsulesImpl,
    fetchCapsuleSetsImpl,
  );
  const {
    actionBusy,
    actionKind,
    actionError,
    clearActionError,
    handleStartIndexing,
    handleCancelIndexing,
    handleDisconnect,
    handleOpenHealth,
  } = useCapsuleActions(
    reload,
    startIndexingImpl,
    cancelIndexingImpl,
    disconnectCapsuleImpl,
    onOpenCapsule,
  );
  const { creating, createError, clearCreateError, handleCreateCapsule } = useCapsuleCreate(
    createCapsuleImpl,
    reload,
  );
  const {
    capsuleSetActionBusy,
    capsuleSetActionError,
    clearCapsuleSetActionError,
    handleDeleteCapsuleSet,
  } = useCapsuleSetActions(reload, deleteCapsuleSetImpl);

  return {
    capsules,
    capsuleSets,
    loadStatus,
    loadError,
    actionBusy,
    actionKind,
    actionError,
    creating,
    createError,
    reload,
    clearCreateError,
    clearActionError,
    handleStartIndexing,
    handleCancelIndexing,
    handleDisconnect,
    handleOpenHealth,
    handleCreateCapsule,
    capsuleSetActionBusy,
    capsuleSetActionError,
    clearCapsuleSetActionError,
    handleDeleteCapsuleSet,
  };
}
