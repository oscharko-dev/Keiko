// Issue #197 — shared types for the connector graph surface.

import type { KnowledgeCapsuleId, CapsuleLifecycleState } from "@oscharko-dev/keiko-contracts";
import type {
  fetchCapsules,
  createCapsule,
  startIndexing,
  cancelIndexing,
  disconnectCapsule,
  CapsuleListEntry,
  CapsulesResponse,
  CapsuleActionResponse,
} from "@/lib/local-knowledge-api";

export type { CapsuleListEntry, CapsulesResponse, CapsuleActionResponse };

export type LoadStatus = "loading" | "ready" | "error";

export interface ConnectorGraphProps {
  readonly fetchCapsulesImpl?: typeof fetchCapsules;
  readonly createCapsuleImpl?: typeof createCapsule;
  readonly startIndexingImpl?: typeof startIndexing;
  readonly cancelIndexingImpl?: typeof cancelIndexing;
  readonly disconnectCapsuleImpl?: typeof disconnectCapsule;
}

export interface ConnectorGraphState {
  readonly capsules: readonly CapsuleListEntry[];
  readonly loadStatus: LoadStatus;
  readonly loadError: string | null;
  readonly actionBusy: KnowledgeCapsuleId | null;
  readonly actionError: string | null;
  readonly creating: boolean;
  readonly createError: string | null;
  readonly reload: () => void;
  readonly handleStartIndexing: (id: KnowledgeCapsuleId) => void;
  readonly handleCancelIndexing: (id: KnowledgeCapsuleId) => void;
  readonly handleDisconnect: (id: KnowledgeCapsuleId) => void;
  readonly handleOpenHealth: (id: KnowledgeCapsuleId) => void;
  readonly handleCreateCapsule: (name: string) => Promise<void>;
}

export const STATUS_LABELS: Record<CapsuleLifecycleState, string> = {
  draft: "Draft",
  indexing: "Indexing",
  ready: "Indexed",
  stale: "Stale",
  deleting: "Deleting",
  error: "Failed",
};

export type ActionVariant = "primary" | "ghost" | "danger";
