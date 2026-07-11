// Connector source metadata persistence tests (Issue #2242): approved-scope round-trip, additive
// sync bookkeeping, fail-closed reads, and citation-target resolution edges not reachable through
// the pod-level suite.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { DEFAULT_EMBEDDING, freshStore } from "./_support.js";
import { createCapsule } from "./capsule-lifecycle.js";
import {
  listConnectorSourceMetadata,
  persistConnectorSourceMetadata,
  readConnectorSourceMetadata,
  updateConnectorSyncState,
  type ConnectorSourceDefinition,
} from "./connector-source-metadata.js";
import type { KnowledgeStore } from "./store.js";

const CAPSULE_ID = "cap-meta" as KnowledgeCapsuleId;
const SOURCE_ID = "src-meta" as KnowledgeSourceId;

let store: KnowledgeStore;
let cleanup: () => void;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  createCapsule(store, {
    id: CAPSULE_ID,
    displayName: "Connector Pod",
    tags: [],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "best-effort",
    embeddingModelIdentity: DEFAULT_EMBEDDING,
    lifecycleState: "draft",
    storageReference: `capsules/${CAPSULE_ID}`,
  });
});

afterEach(() => {
  cleanup();
});

function definition(overrides: Partial<ConnectorSourceDefinition> = {}): ConnectorSourceDefinition {
  return {
    provider: "confluence",
    connectorId: "cred-meta",
    baseUrl: "https://tenant.example",
    scopeKeys: ["ENG", "OPS"],
    bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
    ...overrides,
  };
}

describe("connector source metadata", () => {
  it("round-trips the approved scope and lists it per capsule", () => {
    persistConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID, definition());
    const metadata = readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID);
    expect(metadata).toMatchObject({
      capsuleId: CAPSULE_ID,
      sourceId: SOURCE_ID,
      provider: "confluence",
      connectorId: "cred-meta",
      baseUrl: "https://tenant.example",
      scopeKeys: ["ENG", "OPS"],
      bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
    });
    expect(metadata?.lastSyncAt).toBeUndefined();
    expect(metadata?.lastSyncStatus).toBeUndefined();
    expect(listConnectorSourceMetadata(store, CAPSULE_ID)).toHaveLength(1);
    expect(
      readConnectorSourceMetadata(store, CAPSULE_ID, "src-other" as KnowledgeSourceId),
    ).toBeUndefined();
  });

  it("records additive sync bookkeeping without touching the approved scope", () => {
    persistConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID, definition());
    updateConnectorSyncState(store, CAPSULE_ID, SOURCE_ID, {
      lastSyncAt: 1_700_000_000_000,
      lastSyncRunId: "run-77",
      lastSyncStatus: "partial",
      lastFailureReason: "rate-limited",
      changeSummaryJson: "{}",
    });
    const metadata = readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID);
    expect(metadata).toMatchObject({
      lastSyncAt: 1_700_000_000_000,
      lastSyncRunId: "run-77",
      lastSyncStatus: "partial",
      lastFailureReason: "rate-limited",
      lastChangeSummaryJson: "{}",
      scopeKeys: ["ENG", "OPS"],
    });
    // A later clean run clears the failure reason (nullable column round-trip).
    updateConnectorSyncState(store, CAPSULE_ID, SOURCE_ID, {
      lastSyncAt: 1_700_000_000_001,
      lastSyncRunId: "run-78",
      lastSyncStatus: "succeeded",
      changeSummaryJson: "{}",
    });
    expect(
      readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID)?.lastFailureReason,
    ).toBeUndefined();
  });

  it("ignores an unknown persisted status value instead of surfacing it", () => {
    persistConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID, definition());
    store._internal.db
      .prepare(
        "UPDATE connector_sources SET last_sync_status = 'exploded' WHERE capsule_id = :c AND source_id = :s",
      )
      .run({ c: CAPSULE_ID, s: SOURCE_ID });
    expect(
      readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID)?.lastSyncStatus,
    ).toBeUndefined();
  });

  it("fails closed on unreadable persisted scope keys and on widened bounds", () => {
    persistConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID, definition());
    store._internal.db
      .prepare(
        "UPDATE connector_sources SET scope_keys_json = 'not-json' WHERE capsule_id = :c AND source_id = :s",
      )
      .run({ c: CAPSULE_ID, s: SOURCE_ID });
    expect(() => readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID)).toThrow(
      /scope keys are unreadable/u,
    );
    store._internal.db
      .prepare(
        "UPDATE connector_sources SET scope_keys_json = '{\"a\":1}' WHERE capsule_id = :c AND source_id = :s",
      )
      .run({ c: CAPSULE_ID, s: SOURCE_ID });
    expect(() => readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID)).toThrow(
      /scope keys are unreadable/u,
    );
    store._internal.db
      .prepare(
        "UPDATE connector_sources SET scope_keys_json = '[\"ENG\"]', max_items = 999999 WHERE capsule_id = :c AND source_id = :s",
      )
      .run({ c: CAPSULE_ID, s: SOURCE_ID });
    // A widened persisted bound (beyond the D5 defaults) is invalid state, not a wider budget.
    expect(() => readConnectorSourceMetadata(store, CAPSULE_ID, SOURCE_ID)).toThrow(
      /bounds are invalid/u,
    );
  });
});
