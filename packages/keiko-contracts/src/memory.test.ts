// Unit tests for the Governed Enterprise Memory Vault contracts (Epic #204, Issue #205).
// Each negative test mutates exactly one field of a known-good fixture so failures point
// precisely at the broken invariant — the same mutation-robust pattern used by
// local-knowledge.test.ts and connected-context.test.ts.

import { describe, it, expect, expectTypeOf } from "vitest";
import { spawnSync } from "node:child_process";
import * as publicMemory from "@oscharko-dev/keiko-contracts/memory";
import {
  validateMemoryRecord as validatePublicMemoryRecord,
  validateMemoryProposal as validatePublicMemoryProposal,
  validateMemoryAcceptance as validatePublicMemoryAcceptance,
  validateMemoryRejection as validatePublicMemoryRejection,
  validateMemoryUpdate as validatePublicMemoryUpdate,
  validateMemorySupersession as validatePublicMemorySupersession,
  validateMemoryPin as validatePublicMemoryPin,
  validateMemoryUnpin as validatePublicMemoryUnpin,
  validateMemoryArchive as validatePublicMemoryArchive,
  validateMemoryForget as validatePublicMemoryForget,
  validateMemoryAuditRecord as validatePublicMemoryAuditRecord,
  validateMemoryRetrievalRequest as validatePublicMemoryRetrievalRequest,
  validateMemoryScope as validatePublicMemoryScope,
  validateMemoryStructuredPayload as validatePublicMemoryStructuredPayload,
} from "@oscharko-dev/keiko-contracts/runtime/memory";
import type {
  MemoryRecord as PublicMemoryRecord,
  MemoryProposal as PublicMemoryProposal,
  MemoryAcceptance as PublicMemoryAcceptance,
  MemoryRejection as PublicMemoryRejection,
  MemoryUpdate as PublicMemoryUpdate,
  MemorySupersession as PublicMemorySupersession,
  MemoryPin as PublicMemoryPin,
  MemoryUnpin as PublicMemoryUnpin,
  MemoryArchive as PublicMemoryArchive,
  MemoryForget as PublicMemoryForget,
  MemoryAuditRecord as PublicMemoryAuditRecord,
  MemoryRetrievalRequest as PublicMemoryRetrievalRequest,
  MemoryScope as PublicMemoryScope,
  MemoryStructuredPayload as PublicMemoryStructuredPayload,
  MemoryValidation as PublicMemoryValidation,
} from "@oscharko-dev/keiko-contracts";
import {
  MEMORY_AUDIT_ACTION_KINDS,
  MEMORY_EDGE_KINDS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPE_KINDS,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_STATUS_TRANSITIONS,
  MEMORY_TYPES,
} from "./memory-contracts.js";
import { MEMORY_STRUCTURED_PAYLOAD_KINDS } from "./memory-records.js";
import { MEMORY_AUDIT_INITIATOR_SURFACES, MEMORY_UPDATE_FIELDS } from "./memory-operations.js";
import type {
  MemoryEdgeId,
  MemoryId,
  MemoryReviewerId,
  MemoryStatus,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkspaceId,
} from "./memory-contracts.js";
import type { MemoryAuditRecordId } from "./memory-contracts.js";
import type { MemoryRecord, MemoryEdge } from "./memory-records.js";
import {
  checkStatusTransition,
  hasStaleModelMetadata,
  looksLikeSecretShape,
  validateMemoryEdge,
  validateMemoryProvenance,
  validateMemoryScope,
  validateMemoryStructuredPayload,
  validateMemoryValidityInterval,
} from "./memory-validation.js";
import {
  validateMemoryAcceptance,
  validateMemoryArchive,
  validateMemoryForget,
  validateMemoryPin,
  validateMemoryProposal,
  validateMemoryRejection,
  validateMemorySupersession,
  validateMemoryUnpin,
  validateMemoryUpdate,
} from "./memory-operations-validation.js";
import {
  isScopeReachable,
  MEMORY_RETRIEVAL_MAX_BODY_CHARS,
  MEMORY_RETRIEVAL_MAX_RESULTS,
  scopeCoordinateKey,
  validateMemoryRetrievalRequest,
} from "./memory-retrieval-validation.js";
import { validateMemoryAuditRecord } from "./memory-audit-validation.js";
import {
  assertNeverMemoryType,
  isMemoryEdge,
  isMemoryRecord,
  validateMemoryRecord,
} from "./memory-record-validation.js";

// ─── Branded-ID helpers ───────────────────────────────────────────────────────
const mem = (s: string): MemoryId => s as MemoryId;
const reviewer = (s: string): MemoryReviewerId => s as MemoryReviewerId;
const edge = (s: string): MemoryEdgeId => s as MemoryEdgeId;
const audit = (s: string): MemoryAuditRecordId => s as MemoryAuditRecordId;
const user = (s: string): UserId => s as UserId;
const ws = (s: string): WorkspaceId => s as WorkspaceId;
const proj = (s: string): ProjectId => s as ProjectId;

describe("memory status transitions", () => {
  it("freezes the transition map and every destination list", () => {
    expect(Object.isFrozen(MEMORY_STATUS_TRANSITIONS)).toBe(true);
    for (const status of MEMORY_STATUSES) {
      expect(Object.isFrozen(MEMORY_STATUS_TRANSITIONS[status])).toBe(true);
    }
  });
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────
function happyProvenance(): Record<string, unknown> {
  return {
    sourceKind: "explicit-user-instruction",
    capturedAt: 1_700_000_000_000,
    confidence: 0.95,
    sensitivity: "public",
  };
}

function happyValidity(): Record<string, unknown> {
  return { validFrom: 1_700_000_000_000 };
}

function happyScopeUser(): Record<string, unknown> {
  return { kind: "user", userId: "u-1" };
}

function happyScopeProject(): Record<string, unknown> {
  return { kind: "project", projectId: "p-1" };
}

function happyRecord(): Record<string, unknown> {
  return {
    id: "mem-1",
    schemaVersion: MEMORY_SCHEMA_VERSION,
    scope: happyScopeUser(),
    type: "preference",
    body: "Prefer 2-space indentation for TypeScript files.",
    provenance: happyProvenance(),
    validity: happyValidity(),
    status: "accepted",
    pinned: false,
    tags: ["style"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function happyEdge(): Record<string, unknown> {
  return {
    id: "ed-1",
    schemaVersion: MEMORY_SCHEMA_VERSION,
    fromMemoryId: "mem-old",
    toMemoryId: "mem-new",
    kind: "supersedes",
    createdAt: 1_700_000_000_000,
  };
}

function happyProposal(): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    proposalId: "prop-1",
    proposedAt: 1_700_000_000_000,
    scope: happyScopeUser(),
    type: "preference",
    body: "User prefers 2-space indentation.",
    tags: [],
    provenance: happyProvenance(),
    validity: happyValidity(),
    initialStatus: "proposed",
  };
}

function happyAuditRecord(): Record<string, unknown> {
  return {
    id: "ar-1",
    schemaVersion: MEMORY_SCHEMA_VERSION,
    actionKind: "accepted",
    action: {
      kind: "accepted",
      proposalId: "prop-1",
      memoryId: "mem-1",
      scope: happyScopeUser(),
    },
    initiatorSurface: "memory-center",
    occurredAt: 1_700_000_000_000,
    summary: "Reviewer accepted a preference about indentation.",
  };
}

// ─── MEMORY_SCHEMA_VERSION ────────────────────────────────────────────────────
describe("MEMORY_SCHEMA_VERSION", () => {
  it("is the literal string '1'", () => {
    expect(MEMORY_SCHEMA_VERSION).toBe("1");
  });

  it("appears on every record-like envelope as a literal", () => {
    expect((happyRecord() as { schemaVersion: string }).schemaVersion).toBe("1");
    expect((happyEdge() as { schemaVersion: string }).schemaVersion).toBe("1");
    expect((happyProposal() as { schemaVersion: string }).schemaVersion).toBe("1");
    expect((happyAuditRecord() as { schemaVersion: string }).schemaVersion).toBe("1");
  });
});

// ─── Frozen-constant arrays ───────────────────────────────────────────────────
describe("frozen-constant arrays", () => {
  it("MEMORY_SCOPE_KINDS enumerates the five canonical scopes", () => {
    expect(MEMORY_SCOPE_KINDS).toEqual(["user", "workspace", "project", "workflow", "global"]);
  });

  it("MEMORY_TYPES enumerates all eight types including pinned", () => {
    expect(MEMORY_TYPES).toEqual([
      "episodic",
      "semantic-fact",
      "procedural",
      "preference",
      "correction",
      "decision",
      "negative",
      "pinned",
    ]);
  });

  it("MEMORY_SENSITIVITIES is exactly public/confidential/restricted", () => {
    expect(MEMORY_SENSITIVITIES).toEqual(["public", "confidential", "restricted"]);
  });

  it("MEMORY_STATUSES enumerates all eight lifecycle states", () => {
    expect(MEMORY_STATUSES).toEqual([
      "proposed",
      "accepted",
      "rejected",
      "superseded",
      "archived",
      "forgotten",
      "conflicted",
      "expired",
    ]);
  });

  it("MEMORY_SOURCE_KINDS pins the five provenance sources", () => {
    expect(MEMORY_SOURCE_KINDS).toEqual([
      "explicit-user-instruction",
      "accepted-correction",
      "workflow-outcome",
      "consolidation",
      "system-default",
    ]);
  });

  it("MEMORY_EDGE_KINDS enumerates the six edge kinds", () => {
    expect(MEMORY_EDGE_KINDS).toEqual([
      "related",
      "derived-from",
      "supersedes",
      "corrects",
      "conflicts-with",
      "temporal-precedes",
    ]);
  });

  it("MEMORY_AUDIT_ACTION_KINDS covers proposed through retrieved", () => {
    expect(MEMORY_AUDIT_ACTION_KINDS).toEqual([
      "proposed",
      "accepted",
      "rejected",
      "updated",
      "superseded",
      "pinned",
      "unpinned",
      "archived",
      "forgotten",
      "retrieved",
    ]);
  });

  it("MEMORY_AUDIT_INITIATOR_SURFACES enumerates the seven initiator surfaces", () => {
    expect(MEMORY_AUDIT_INITIATOR_SURFACES).toEqual([
      "memory-center",
      "conversation-center",
      "voice",
      "workflow",
      "consolidation",
      "retention",
      "system",
    ]);
  });

  it("MEMORY_UPDATE_FIELDS pins the editable patch fields", () => {
    expect(MEMORY_UPDATE_FIELDS).toEqual([
      "body",
      "payload",
      "tags",
      "validity",
      "sensitivity",
      "retentionHint",
    ]);
  });

  it("MEMORY_STRUCTURED_PAYLOAD_KINDS pins the two initial payload kinds", () => {
    expect(MEMORY_STRUCTURED_PAYLOAD_KINDS).toEqual(["string-list", "key-value"]);
  });
});

// ─── Status transition matrix ─────────────────────────────────────────────────
describe("MEMORY_STATUS_TRANSITIONS", () => {
  it("forgotten is absorbing while rejected can be acknowledged for deletion", () => {
    expect(MEMORY_STATUS_TRANSITIONS.rejected).toEqual(["forgotten"]);
    expect(MEMORY_STATUS_TRANSITIONS.forgotten).toEqual([]);
  });

  it("allows proposed captures to settle or be acknowledged for deletion", () => {
    expect([...MEMORY_STATUS_TRANSITIONS.proposed].sort()).toEqual(
      ["accepted", "conflicted", "expired", "forgotten", "rejected", "superseded"].sort(),
    );
  });

  it("accepted → superseded, archived, forgotten, conflicted, expired are legal", () => {
    expect([...MEMORY_STATUS_TRANSITIONS.accepted].sort()).toEqual(
      ["archived", "conflicted", "expired", "forgotten", "superseded"].sort(),
    );
  });

  it("superseded can only flow to archived or forgotten (monotonic)", () => {
    expect([...MEMORY_STATUS_TRANSITIONS.superseded].sort()).toEqual(
      ["archived", "forgotten"].sort(),
    );
  });

  it("archived can be restored to accepted or acknowledged for deletion", () => {
    expect(MEMORY_STATUS_TRANSITIONS.archived).toContain("accepted");
    expect(MEMORY_STATUS_TRANSITIONS.archived).toContain("forgotten");
  });

  it("conflicted and expired can return to accepted (rehabilitation)", () => {
    expect(MEMORY_STATUS_TRANSITIONS.conflicted).toContain("accepted");
    expect(MEMORY_STATUS_TRANSITIONS.expired).toContain("accepted");
  });
});

describe("checkStatusTransition", () => {
  it("accepts every legal transition encoded in the matrix", () => {
    for (const from of MEMORY_STATUSES) {
      for (const to of MEMORY_STATUS_TRANSITIONS[from]) {
        const result = checkStatusTransition(from, to);
        expect(result.ok, `${from} → ${to}`).toBe(true);
      }
    }
  });

  it("rejects every illegal transition across the full matrix", () => {
    for (const from of MEMORY_STATUSES) {
      const allowed = new Set<MemoryStatus>(MEMORY_STATUS_TRANSITIONS[from]);
      for (const to of MEMORY_STATUSES) {
        if (allowed.has(to) || to === from) {
          continue;
        }
        const result = checkStatusTransition(from, to);
        expect(result.ok, `expected ${from} → ${to} to be illegal`).toBe(false);
        expect(result.reason).toContain("illegal transition");
      }
    }
  });

  it("rejects no-op same-state transitions", () => {
    for (const status of MEMORY_STATUSES) {
      const result = checkStatusTransition(status, status);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("no-op transition");
    }
  });

  it("rejects unknown from/to statuses", () => {
    expect(checkStatusTransition("nope" as MemoryStatus, "accepted").ok).toBe(false);
    expect(checkStatusTransition("accepted", "nope" as MemoryStatus).ok).toBe(false);
  });
});

// ─── validateMemoryScope ──────────────────────────────────────────────────────
describe("validateMemoryScope", () => {
  it("accepts every kind with its required coordinate", () => {
    expect(validateMemoryScope(happyScopeUser()).ok).toBe(true);
    expect(validateMemoryScope({ kind: "workspace", workspaceId: "w-1" }).ok).toBe(true);
    expect(validateMemoryScope(happyScopeProject()).ok).toBe(true);
    expect(validateMemoryScope({ kind: "workflow", workflowDefinitionId: "wf-1" }).ok).toBe(true);
    expect(validateMemoryScope({ kind: "global" }).ok).toBe(true);
  });

  it("rejects unknown kinds", () => {
    expect(validateMemoryScope({ kind: "tenant" }).ok).toBe(false);
  });

  it("rejects non-objects and arrays", () => {
    expect(validateMemoryScope(null).ok).toBe(false);
    expect(validateMemoryScope([]).ok).toBe(false);
    expect(validateMemoryScope("user").ok).toBe(false);
  });

  it("rejects user/workspace/project/workflow scopes with empty coordinate fields", () => {
    expect(validateMemoryScope({ kind: "user", userId: "" }).ok).toBe(false);
    expect(validateMemoryScope({ kind: "workspace", workspaceId: "  " }).ok).toBe(false);
    expect(validateMemoryScope({ kind: "project", projectId: "" }).ok).toBe(false);
    expect(validateMemoryScope({ kind: "workflow", workflowDefinitionId: "" }).ok).toBe(false);
  });

  it("does not require any coordinate for global", () => {
    expect(validateMemoryScope({ kind: "global" }).ok).toBe(true);
  });
});

// ─── validateMemoryValidityInterval ──────────────────────────────────────────
describe("validateMemoryValidityInterval", () => {
  it("accepts validFrom without validUntil", () => {
    expect(validateMemoryValidityInterval({ validFrom: 0 }).ok).toBe(true);
  });

  it("accepts validUntil when greater than or equal to validFrom", () => {
    expect(validateMemoryValidityInterval({ validFrom: 100, validUntil: 200 }).ok).toBe(true);
    expect(validateMemoryValidityInterval({ validFrom: 100, validUntil: 100 }).ok).toBe(true);
  });

  it("rejects validUntil less than validFrom", () => {
    expect(validateMemoryValidityInterval({ validFrom: 200, validUntil: 100 }).ok).toBe(false);
  });

  it("rejects NaN, Infinity, and negative validFrom", () => {
    expect(validateMemoryValidityInterval({ validFrom: Number.NaN }).ok).toBe(false);
    expect(validateMemoryValidityInterval({ validFrom: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateMemoryValidityInterval({ validFrom: -1 }).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateMemoryValidityInterval(null).ok).toBe(false);
  });
});

// ─── validateMemoryProvenance ────────────────────────────────────────────────
describe("validateMemoryProvenance", () => {
  it("accepts the happy fixture", () => {
    expect(validateMemoryProvenance(happyProvenance()).ok).toBe(true);
  });

  it("accepts an optional modelIdentity with provider+modelId", () => {
    const input = {
      ...happyProvenance(),
      modelIdentity: { provider: "anthropic", modelId: "claude-opus-4-7" },
    };
    expect(validateMemoryProvenance(input).ok).toBe(true);
  });

  it("accepts modelIdentity with modelRevision when set", () => {
    const input = {
      ...happyProvenance(),
      modelIdentity: {
        provider: "anthropic",
        modelId: "claude-opus-4-7",
        modelRevision: "rev-2026-01",
      },
    };
    expect(validateMemoryProvenance(input).ok).toBe(true);
  });

  it("rejects unknown sourceKind", () => {
    expect(validateMemoryProvenance({ ...happyProvenance(), sourceKind: "guess" }).ok).toBe(false);
  });

  it("rejects confidence outside [0, 1] and NaN", () => {
    expect(validateMemoryProvenance({ ...happyProvenance(), confidence: -0.01 }).ok).toBe(false);
    expect(validateMemoryProvenance({ ...happyProvenance(), confidence: 1.01 }).ok).toBe(false);
    expect(validateMemoryProvenance({ ...happyProvenance(), confidence: Number.NaN }).ok).toBe(
      false,
    );
  });

  it("rejects negative capturedAt", () => {
    expect(validateMemoryProvenance({ ...happyProvenance(), capturedAt: -1 }).ok).toBe(false);
  });

  it("rejects unknown sensitivity", () => {
    expect(validateMemoryProvenance({ ...happyProvenance(), sensitivity: "secret" }).ok).toBe(
      false,
    );
  });

  it("rejects empty optional reference IDs when present", () => {
    expect(
      validateMemoryProvenance({
        ...happyProvenance(),
        sourceConversationId: "",
      }).ok,
    ).toBe(false);
    expect(
      validateMemoryProvenance({
        ...happyProvenance(),
        sourceWorkflowRunId: "  ",
      }).ok,
    ).toBe(false);
  });

  it("rejects an oversized captureRationale and a control-char-bearing one", () => {
    expect(
      validateMemoryProvenance({
        ...happyProvenance(),
        captureRationale: "x".repeat(1025),
      }).ok,
    ).toBe(false);
    expect(
      validateMemoryProvenance({
        ...happyProvenance(),
        captureRationale: "safe\x00danger",
      }).ok,
    ).toBe(false);
  });

  it("rejects modelIdentity with missing provider", () => {
    expect(
      validateMemoryProvenance({
        ...happyProvenance(),
        modelIdentity: { modelId: "x" },
      }).ok,
    ).toBe(false);
  });
});

// ─── validateMemoryStructuredPayload ─────────────────────────────────────────
describe("validateMemoryStructuredPayload", () => {
  it("accepts a happy string-list", () => {
    expect(validateMemoryStructuredPayload({ kind: "string-list", items: ["a", "b"] }).ok).toBe(
      true,
    );
  });

  it("accepts a happy key-value", () => {
    expect(
      validateMemoryStructuredPayload({
        kind: "key-value",
        entries: [{ key: "indent", value: "2" }],
      }).ok,
    ).toBe(true);
  });

  it("rejects unknown kind", () => {
    expect(validateMemoryStructuredPayload({ kind: "table", rows: [] }).ok).toBe(false);
  });

  it("rejects string-list items with NUL bytes or empty entries", () => {
    expect(validateMemoryStructuredPayload({ kind: "string-list", items: ["a", ""] }).ok).toBe(
      false,
    );
    expect(
      validateMemoryStructuredPayload({ kind: "string-list", items: ["a", "x\x00y"] }).ok,
    ).toBe(false);
  });

  it("rejects key-value entries with empty key or control-char value", () => {
    expect(
      validateMemoryStructuredPayload({
        kind: "key-value",
        entries: [{ key: "", value: "v" }],
      }).ok,
    ).toBe(false);
    expect(
      validateMemoryStructuredPayload({
        kind: "key-value",
        entries: [{ key: "k", value: "v\x07" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects oversized structured payload arrays and strings", () => {
    expect(
      validateMemoryStructuredPayload({
        kind: "string-list",
        items: Array.from({ length: 129 }, () => "item"),
      }).ok,
    ).toBe(false);
    expect(
      validateMemoryStructuredPayload({ kind: "string-list", items: ["x".repeat(4097)] }).ok,
    ).toBe(false);
    expect(
      validateMemoryStructuredPayload({
        kind: "key-value",
        entries: Array.from({ length: 129 }, (_, index) => ({
          key: `key-${String(index)}`,
          value: "value",
        })),
      }).ok,
    ).toBe(false);
    expect(
      validateMemoryStructuredPayload({
        kind: "key-value",
        entries: [{ key: "key", value: "x".repeat(4097) }],
      }).ok,
    ).toBe(false);
  });

  it("rejects control characters and oversized text in key-value keys", () => {
    for (const key of ["unsafe\u0007key", "x".repeat(65)]) {
      expect(
        validateMemoryStructuredPayload({
          kind: "key-value",
          entries: [{ key, value: "value" }],
        }).ok,
      ).toBe(false);
    }
  });
});

// ─── validateMemoryEdge ──────────────────────────────────────────────────────
describe("validateMemoryEdge", () => {
  it("accepts a happy edge", () => {
    expect(validateMemoryEdge(happyEdge()).ok).toBe(true);
  });

  it("rejects schemaVersion drift", () => {
    expect(validateMemoryEdge({ ...happyEdge(), schemaVersion: "2" }).ok).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(validateMemoryEdge({ ...happyEdge(), kind: "loves" }).ok).toBe(false);
  });

  it("rejects self-loop fromMemoryId == toMemoryId", () => {
    expect(validateMemoryEdge({ ...happyEdge(), fromMemoryId: "m", toMemoryId: "m" }).ok).toBe(
      false,
    );
  });

  it("rejects out-of-range confidence", () => {
    expect(validateMemoryEdge({ ...happyEdge(), confidence: 1.5 }).ok).toBe(false);
  });

  it("rejects negative createdAt", () => {
    expect(validateMemoryEdge({ ...happyEdge(), createdAt: -1 }).ok).toBe(false);
  });

  it("rejects empty memory IDs", () => {
    expect(validateMemoryEdge({ ...happyEdge(), fromMemoryId: "" }).ok).toBe(false);
    expect(validateMemoryEdge({ ...happyEdge(), toMemoryId: "" }).ok).toBe(false);
  });
});

// ─── validateMemoryRecord ────────────────────────────────────────────────────
describe("validateMemoryRecord", () => {
  it("accepts a happy record", () => {
    expect(validateMemoryRecord(happyRecord()).ok).toBe(true);
  });

  it("rejects schemaVersion drift", () => {
    expect(validateMemoryRecord({ ...happyRecord(), schemaVersion: "2" }).ok).toBe(false);
  });

  it("rejects unknown type", () => {
    expect(validateMemoryRecord({ ...happyRecord(), type: "rumour" }).ok).toBe(false);
  });

  it("rejects unknown status", () => {
    expect(validateMemoryRecord({ ...happyRecord(), status: "draft" }).ok).toBe(false);
  });

  it("rejects oversized body and empty body", () => {
    expect(validateMemoryRecord({ ...happyRecord(), body: "" }).ok).toBe(false);
    expect(validateMemoryRecord({ ...happyRecord(), body: "x".repeat(4097) }).ok).toBe(false);
  });

  it("rejects control characters in body", () => {
    expect(validateMemoryRecord({ ...happyRecord(), body: "safe\x00danger" }).ok).toBe(false);
  });

  it("rejects updatedAt earlier than createdAt", () => {
    expect(
      validateMemoryRecord({
        ...happyRecord(),
        createdAt: 200,
        updatedAt: 100,
      }).ok,
    ).toBe(false);
  });

  it("rejects non-boolean pinned", () => {
    expect(validateMemoryRecord({ ...happyRecord(), pinned: "yes" }).ok).toBe(false);
  });

  it("rejects too many tags", () => {
    const tags = new Array(33).fill("t");
    expect(validateMemoryRecord({ ...happyRecord(), tags }).ok).toBe(false);
  });

  it("rejects retentionHint with empty policyKey", () => {
    expect(
      validateMemoryRecord({
        ...happyRecord(),
        retentionHint: { policyKey: "" },
      }).ok,
    ).toBe(false);
  });

  it("accepts retentionHint with optional retainUntil and notes", () => {
    expect(
      validateMemoryRecord({
        ...happyRecord(),
        retentionHint: { policyKey: "default", retainUntil: 1_800_000_000_000, notes: "n" },
      }).ok,
    ).toBe(true);
  });

  it("propagates nested scope, provenance, and validity errors with prefixes", () => {
    const result = validateMemoryRecord({
      ...happyRecord(),
      scope: { kind: "user", userId: "" },
      provenance: { ...happyProvenance(), confidence: 2 },
      validity: { validFrom: 200, validUntil: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("record.scope."))).toBe(true);
      expect(result.errors.some((e) => e.startsWith("record.provenance."))).toBe(true);
      expect(result.errors.some((e) => e.startsWith("record.validity."))).toBe(true);
    }
  });
});

// ─── isMemoryRecord / isMemoryEdge / assertNeverMemoryType ───────────────────
describe("type discriminators", () => {
  it("isMemoryRecord narrows happy records", () => {
    expect(isMemoryRecord(happyRecord())).toBe(true);
  });

  it("isMemoryRecord rejects chat messages, KnowledgeCapsules, and ChunkRecords", () => {
    const chatMessage = {
      id: "msg-1",
      role: "user",
      content: "hi",
      createdAt: 0,
    };
    const knowledgeCapsule = {
      id: "cap-1",
      displayName: "Risk Controls",
      sourceIds: ["s-1"],
      retrievalEffort: "default",
      outputMode: "answers",
      answerGroundingPolicy: "require-citations",
      embeddingModelIdentity: {
        provider: "openai",
        modelId: "x",
        vectorDimensions: 1,
        vectorMetric: "cosine",
      },
      lifecycleState: "ready",
      storageReference: "capsules/cap-1",
      createdAt: 0,
      updatedAt: 0,
    };
    const chunkRecord = {
      id: "ch-1",
      capsuleId: "cap-1",
      sourceId: "s-1",
      documentId: "doc-1",
      parsedUnit: {
        kind: "page",
        documentId: "doc-1",
        pageNumber: 1,
        characterStart: 0,
        characterEnd: 1,
      },
      orderIndex: 0,
      tokenCount: 1,
      safeExcerptHash: "abc",
    };
    expect(isMemoryRecord(chatMessage)).toBe(false);
    expect(isMemoryRecord(knowledgeCapsule)).toBe(false);
    expect(isMemoryRecord(chunkRecord)).toBe(false);
  });

  it("isMemoryEdge narrows happy edges and rejects unrelated shapes", () => {
    expect(isMemoryEdge(happyEdge())).toBe(true);
    expect(isMemoryEdge({ from: "a", to: "b" })).toBe(false);
  });

  it("assertNeverMemoryType throws when called", () => {
    expect(() => assertNeverMemoryType("oops" as never)).toThrow(/unhandled MemoryType: oops/);
  });
});

// ─── JSON round-trip ─────────────────────────────────────────────────────────
describe("JSON round-trip", () => {
  it("MemoryRecord survives JSON.stringify / JSON.parse and re-validates", () => {
    const json = JSON.stringify(happyRecord());
    const parsed = JSON.parse(json) as unknown;
    expect(isMemoryRecord(parsed)).toBe(true);
  });

  it("MemoryEdge survives JSON round-trip", () => {
    const json = JSON.stringify(happyEdge());
    const parsed = JSON.parse(json) as unknown;
    expect(isMemoryEdge(parsed)).toBe(true);
  });

  it("MemoryAuditRecord survives JSON round-trip", () => {
    const json = JSON.stringify(happyAuditRecord());
    const parsed = JSON.parse(json) as unknown;
    expect(validateMemoryAuditRecord(parsed).ok).toBe(true);
  });
});

// ─── Branded ID nominal typing ───────────────────────────────────────────────
describe("branded IDs", () => {
  it("are not assignable across kinds at compile time", () => {
    const userId: UserId = user("u-1");
    const projectId: ProjectId = proj("p-1");
    const memoryId: MemoryId = mem("m-1");
    // The next three lines prove the brands are LIVE: a future refactor that drops a
    // brand turns the @ts-expect-error into a "directive unused" compile error.
    // @ts-expect-error — UserId is not assignable to ProjectId.
    const _crossUserProject: ProjectId = userId;
    // @ts-expect-error — ProjectId is not assignable to MemoryId.
    const _crossProjectMemory: MemoryId = projectId;
    // @ts-expect-error — bare string is not assignable to UserId.
    const _bareString: UserId = "u-2";
    expect(userId).toBe("u-1");
    expect(projectId).toBe("p-1");
    expect(memoryId).toBe("m-1");
    // Each @ts-expect-error above is the real compile-time assertion. What is worth asserting at
    // RUNTIME is the complementary fact: the brands are erased, so a cross-assigned value is
    // indistinguishable from its source and `user()` is identity — which is what makes branded ids
    // safe to serialize. The previous lines asserted definedness of a literal, which no change could
    // ever falsify (typescript:S5914).
    expect(_crossUserProject).toBe(userId);
    expect(_crossProjectMemory).toBe(projectId);
    expect(_bareString).toBe(user("u-2"));
  });

  it("survive JSON round-trip as plain strings", () => {
    const id = mem("m-42");
    const round = JSON.parse(JSON.stringify({ id })) as { id: string };
    expect(round.id).toBe("m-42");
  });
});

// ─── isScopeReachable ────────────────────────────────────────────────────────
describe("isScopeReachable", () => {
  it("returns true when the same scope coordinate is in the authorized set", () => {
    expect(
      isScopeReachable({ kind: "user", userId: user("u-1") }, [
        { kind: "user", userId: user("u-1") },
      ]),
    ).toBe(true);
  });

  it("returns false when the kind matches but the coordinate differs", () => {
    expect(
      isScopeReachable({ kind: "user", userId: user("u-1") }, [
        { kind: "user", userId: user("u-2") },
      ]),
    ).toBe(false);
  });

  it("returns false when the kind differs even with matching coordinates", () => {
    expect(
      isScopeReachable({ kind: "user", userId: user("u-1") }, [
        { kind: "workspace", workspaceId: ws("u-1") },
      ]),
    ).toBe(false);
  });

  it("treats global as reachable only when an authorized scope is also global", () => {
    expect(isScopeReachable({ kind: "global" }, [{ kind: "global" }])).toBe(true);
    expect(isScopeReachable({ kind: "global" }, [{ kind: "user", userId: user("u-1") }])).toBe(
      false,
    );
  });

  it("returns false when authorized set is empty", () => {
    expect(isScopeReachable({ kind: "user", userId: user("u-1") }, [])).toBe(false);
  });
});

// ─── scopeCoordinateKey (#2906 KEIKO-0546) ───────────────────────────────────
// Pins the exact string encoding for every MemoryScopeKind so the shared partition-key
// projection cannot silently diverge between callers (governance conflict/forget scans and
// consolidation dedupe/ordering all read this one function).
describe("scopeCoordinateKey", () => {
  it("uses the shared 'kind:coordinate' encoding for every scope kind", () => {
    expect(scopeCoordinateKey({ kind: "global" })).toBe("global:");
    expect(scopeCoordinateKey({ kind: "user", userId: user("u-1") })).toBe("user:u-1");
    expect(scopeCoordinateKey({ kind: "workspace", workspaceId: ws("w-1") })).toBe("workspace:w-1");
    expect(scopeCoordinateKey({ kind: "project", projectId: proj("p-1") })).toBe("project:p-1");
    expect(
      scopeCoordinateKey({
        kind: "workflow",
        workflowDefinitionId: "wf-1" as WorkflowDefinitionId,
      }),
    ).toBe("workflow:wf-1");
  });

  it("yields distinct kind prefixes so two coordinates cannot collide across kinds", () => {
    const userKey = scopeCoordinateKey({ kind: "user", userId: user("shared") });
    const wsKey = scopeCoordinateKey({ kind: "workspace", workspaceId: ws("shared") });
    expect(userKey).not.toBe(wsKey);
  });
});

// ─── Operation validators ────────────────────────────────────────────────────
describe("operation validators", () => {
  it("validateMemoryProposal accepts the happy proposal", () => {
    expect(validateMemoryProposal(happyProposal()).ok).toBe(true);
  });

  it("validateMemoryProposal rejects initialStatus != 'proposed'", () => {
    expect(validateMemoryProposal({ ...happyProposal(), initialStatus: "accepted" }).ok).toBe(
      false,
    );
  });

  it("validateMemoryProposal rejects empty body and unknown type", () => {
    expect(validateMemoryProposal({ ...happyProposal(), body: "" }).ok).toBe(false);
    expect(validateMemoryProposal({ ...happyProposal(), type: "myth" }).ok).toBe(false);
  });

  it("validateMemoryProposal rejects an invalid retention hint", () => {
    expect(
      validateMemoryProposal({
        ...happyProposal(),
        retentionHint: { policyKey: "", retainUntil: -1 },
      }).ok,
    ).toBe(false);
  });

  it("validateMemoryAcceptance accepts a happy acceptance and rejects empty IDs", () => {
    const happy = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      proposalId: "prop-1",
      mintedMemoryId: "mem-1",
      reviewerId: "rev-1",
      acceptedAt: 0,
    };
    expect(validateMemoryAcceptance(happy).ok).toBe(true);
    expect(validateMemoryAcceptance({ ...happy, mintedMemoryId: "" }).ok).toBe(false);
    expect(validateMemoryAcceptance({ ...happy, sensitivityOverride: "secret" }).ok).toBe(false);
  });

  it("validateMemoryRejection requires a non-empty reason", () => {
    const happy = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      proposalId: "prop-1",
      reviewerId: "rev-1",
      rejectedAt: 0,
      reason: "out of scope",
    };
    expect(validateMemoryRejection(happy).ok).toBe(true);
    expect(validateMemoryRejection({ ...happy, reason: "" }).ok).toBe(false);
  });

  it("validateMemoryUpdate rejects a no-op update (no patches set)", () => {
    const noop = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryId: "mem-1",
      reviewerId: "rev-1",
      updatedAt: 0,
    };
    expect(validateMemoryUpdate(noop).ok).toBe(false);
  });

  it("validateMemoryUpdate accepts a single-field patch", () => {
    const update = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryId: "mem-1",
      reviewerId: "rev-1",
      updatedAt: 0,
      bodyPatch: "new body",
    };
    expect(validateMemoryUpdate(update).ok).toBe(true);
  });

  it("validateMemoryUpdate rejects an invalid retentionHintPatch", () => {
    expect(
      validateMemoryUpdate({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        memoryId: "mem-1",
        reviewerId: "rev-1",
        updatedAt: 0,
        retentionHintPatch: { policyKey: "", notes: "\u0000bad" },
      }).ok,
    ).toBe(false);
  });

  it("preserves existing-memory header read order before update fields", () => {
    const reads: string[] = [];
    const getter =
      (field: string, value: unknown): (() => unknown) =>
      () => {
        reads.push(field);
        return value;
      };
    const updateInput: Record<string, unknown> = {};
    Object.defineProperties(updateInput, {
      schemaVersion: { get: getter("schemaVersion", "1") },
      memoryId: { get: getter("memoryId", "mem-1") },
      reviewerId: { get: getter("reviewerId", "rev-1") },
      updatedAt: { get: getter("updatedAt", 0) },
      bodyPatch: { get: getter("bodyPatch", "updated body") },
      payloadPatch: { get: getter("payloadPatch", undefined) },
      tagsPatch: { get: getter("tagsPatch", undefined) },
      validityPatch: { get: getter("validityPatch", undefined) },
      sensitivityPatch: { get: getter("sensitivityPatch", undefined) },
      retentionHintPatch: { get: getter("retentionHintPatch", undefined) },
      reviewerNote: { get: getter("reviewerNote", undefined) },
    });
    const update = validateMemoryUpdate(updateInput);
    expect(update.ok).toBe(true);
    if (update.ok) expect(update.value).toBe(updateInput);
    expect(reads).toEqual([
      "schemaVersion",
      "memoryId",
      "reviewerId",
      "updatedAt",
      "bodyPatch",
      "bodyPatch",
      "payloadPatch",
      "tagsPatch",
      "validityPatch",
      "sensitivityPatch",
      "retentionHintPatch",
      "bodyPatch",
      "payloadPatch",
      "tagsPatch",
      "validityPatch",
      "sensitivityPatch",
      "retentionHintPatch",
      "reviewerNote",
    ]);
  });

  it("preserves existing-memory header read order before forget fields", () => {
    const reads: string[] = [];
    const getter =
      (field: string, value: unknown): (() => unknown) =>
      () => {
        reads.push(field);
        return value;
      };
    const forgetInput: Record<string, unknown> = {};
    Object.defineProperties(forgetInput, {
      schemaVersion: { get: getter("schemaVersion", "1") },
      memoryId: { get: getter("memoryId", "mem-1") },
      reviewerId: { get: getter("reviewerId", "rev-1") },
      forgottenAt: { get: getter("forgottenAt", 0) },
      reason: { get: getter("reason", "user-request") },
      userAcknowledgedDestructive: { get: getter("userAcknowledgedDestructive", true) },
    });
    const forget = validateMemoryForget(forgetInput);
    expect(forget.ok).toBe(true);
    if (forget.ok) expect(forget.value).toBe(forgetInput);
    expect(reads).toEqual([
      "schemaVersion",
      "memoryId",
      "reviewerId",
      "forgottenAt",
      "reason",
      "reason",
      "userAcknowledgedDestructive",
    ]);
  });

  it("keeps existing-memory action header errors operation-specific and ordered", () => {
    const update = validateMemoryUpdate({
      schemaVersion: "2",
      memoryId: "../bad",
      reviewerId: " ",
      updatedAt: 0,
      bodyPatch: "updated body",
    });
    expect(update.ok).toBe(false);
    if (update.ok) throw new Error("Expected malformed update header to fail");
    expect(update.errors).toEqual([
      'schemaVersion must be the literal "1"',
      "update.memoryId contains a forbidden path fragment",
      "update.reviewerId must be a non-empty string",
    ]);

    const forget = validateMemoryForget({
      schemaVersion: "2",
      memoryId: "../bad",
      reviewerId: " ",
      forgottenAt: 0,
      reason: "user-request",
      userAcknowledgedDestructive: true,
    });
    expect(forget.ok).toBe(false);
    if (forget.ok) throw new Error("Expected malformed forget header to fail");
    expect(forget.errors).toEqual([
      'schemaVersion must be the literal "1"',
      "forget.memoryId contains a forbidden path fragment",
      "forget.reviewerId must be a non-empty string",
    ]);
  });

  it("validateMemorySupersession rejects same old/new IDs and missing reason", () => {
    const happy = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      oldMemoryId: "mem-old",
      newMemoryId: "mem-new",
      reviewerId: "rev-1",
      supersededAt: 0,
      reason: "consolidation",
      edgeKind: "supersedes",
    };
    expect(validateMemorySupersession(happy).ok).toBe(true);
    expect(validateMemorySupersession({ ...happy, oldMemoryId: "x", newMemoryId: "x" }).ok).toBe(
      false,
    );
    expect(validateMemorySupersession({ ...happy, edgeKind: "related" }).ok).toBe(false);
  });

  function observedMemoryStateAction(
    timestampField: "pinnedAt" | "unpinnedAt" | "archivedAt",
    reads: string[],
  ): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    const getter =
      (field: string, value: unknown): (() => unknown) =>
      () => {
        reads.push(field);
        return value;
      };
    Object.defineProperty(input, "schemaVersion", { get: getter("schemaVersion", "1") });
    Object.defineProperty(input, "memoryId", { get: getter("memoryId", "mem-1") });
    Object.defineProperty(input, "reviewerId", { get: getter("reviewerId", "rev-1") });
    Object.defineProperty(input, timestampField, { get: getter(timestampField, 0) });
    Object.defineProperty(input, "reason", { get: getter("reason", "reviewed") });
    return input;
  }

  function expectMemoryStateActionReadOrder(reads: string[], timestampField: string): void {
    expect(reads).toEqual([
      "schemaVersion",
      "memoryId",
      "reviewerId",
      timestampField,
      "reason",
      "reason",
    ]);
  }

  it("validateMemoryPin and validateMemoryUnpin accept happy envelopes", () => {
    expect(
      validateMemoryPin({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        memoryId: "mem-1",
        reviewerId: "rev-1",
        pinnedAt: 0,
      }).ok,
    ).toBe(true);
    expect(
      validateMemoryUnpin({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        memoryId: "mem-1",
        reviewerId: "rev-1",
        unpinnedAt: 0,
      }).ok,
    ).toBe(true);
  });

  it("validateMemoryArchive accepts the happy envelope", () => {
    expect(
      validateMemoryArchive({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        memoryId: "mem-1",
        reviewerId: "rev-1",
        archivedAt: 0,
      }).ok,
    ).toBe(true);
  });

  it("keeps pin, unpin, and archive validation errors eager and ordered", () => {
    const invalidAction = (timestampField: string): Record<string, unknown> => ({
      schemaVersion: "2",
      memoryId: "../bad",
      reviewerId: " ",
      [timestampField]: Number.NaN,
      reason: "\u0000bad",
    });
    const pin = validateMemoryPin(invalidAction("pinnedAt"));
    expect(pin.ok).toBe(false);
    if (pin.ok) throw new Error("Expected malformed pin to fail");
    expect(pin.errors).toEqual([
      'schemaVersion must be the literal "1"',
      "pin.memoryId contains a forbidden path fragment",
      "pin.reviewerId must be a non-empty string",
      "pin.pinnedAt must be a finite non-negative number",
      "pin.reason must be a bounded control-free string when set",
    ]);

    const unpin = validateMemoryUnpin(invalidAction("unpinnedAt"));
    expect(unpin.ok).toBe(false);
    if (unpin.ok) throw new Error("Expected malformed unpin to fail");
    expect(unpin.errors).toEqual([
      'schemaVersion must be the literal "1"',
      "unpin.memoryId contains a forbidden path fragment",
      "unpin.reviewerId must be a non-empty string",
      "unpin.unpinnedAt must be a finite non-negative number",
      "unpin.reason must be a bounded control-free string when set",
    ]);

    const archive = validateMemoryArchive(invalidAction("archivedAt"));
    expect(archive.ok).toBe(false);
    if (archive.ok) throw new Error("Expected malformed archive to fail");
    expect(archive.errors).toEqual([
      'schemaVersion must be the literal "1"',
      "archive.memoryId contains a forbidden path fragment",
      "archive.reviewerId must be a non-empty string",
      "archive.archivedAt must be a finite non-negative number",
      "archive.reason must be a bounded control-free string when set",
    ]);
  });

  it("preserves getter order, reason read count, and input identity for all three actions", () => {
    const reads: string[] = [];
    const pinInput = observedMemoryStateAction("pinnedAt", reads);
    const pin = validateMemoryPin(pinInput);
    expect(pin.ok).toBe(true);
    if (pin.ok) expect(pin.value).toBe(pinInput);
    expectMemoryStateActionReadOrder(reads, "pinnedAt");

    reads.length = 0;
    const unpinInput = observedMemoryStateAction("unpinnedAt", reads);
    const unpin = validateMemoryUnpin(unpinInput);
    expect(unpin.ok).toBe(true);
    if (unpin.ok) expect(unpin.value).toBe(unpinInput);
    expectMemoryStateActionReadOrder(reads, "unpinnedAt");

    reads.length = 0;
    const archiveInput = observedMemoryStateAction("archivedAt", reads);
    const archive = validateMemoryArchive(archiveInput);
    expect(archive.ok).toBe(true);
    if (archive.ok) expect(archive.value).toBe(archiveInput);
    expectMemoryStateActionReadOrder(reads, "archivedAt");
  });

  it("validateMemoryForget requires the destructive acknowledgement to be true", () => {
    const happy = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryId: "mem-1",
      reviewerId: "rev-1",
      forgottenAt: 0,
      reason: "user-request",
      userAcknowledgedDestructive: true,
    };
    expect(validateMemoryForget(happy).ok).toBe(true);
    expect(validateMemoryForget({ ...happy, userAcknowledgedDestructive: false }).ok).toBe(false);
    expect(validateMemoryForget({ ...happy, reason: "forget dark mode preference" }).ok).toBe(
      false,
    );
  });

  it("validateMemoryRetrievalRequest requires a non-empty scopes array", () => {
    const happy = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      requestedAt: 0,
      scopes: [happyScopeUser()],
    };
    expect(validateMemoryRetrievalRequest(happy).ok).toBe(true);
    expect(validateMemoryRetrievalRequest({ ...happy, scopes: [] }).ok).toBe(false);
  });

  it("validateMemoryRetrievalRequest enforces enum filters and positive limits", () => {
    const base = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      requestedAt: 0,
      scopes: [happyScopeUser()],
    };
    expect(validateMemoryRetrievalRequest({ ...base, typeFilter: ["preference"] }).ok).toBe(true);
    expect(validateMemoryRetrievalRequest({ ...base, typeFilter: ["rumour"] }).ok).toBe(false);
    expect(validateMemoryRetrievalRequest({ ...base, maxResults: 0 }).ok).toBe(false);
    expect(validateMemoryRetrievalRequest({ ...base, maxResults: 10 }).ok).toBe(true);
    expect(validateMemoryRetrievalRequest({ ...base, includeArchived: "yes" }).ok).toBe(false);
    // KEIKO-1027: MEMORY_RETRIEVAL_MAX_RESULTS and MEMORY_RETRIEVAL_MAX_BODY_CHARS bound the
    // retrieval budget hints at the naming boundary. A hostile producer asking the store to scan
    // 100_000 rows or project a 10 MB body must be refused as a contract violation, not a request
    // the store silently clamps.
    expect(
      validateMemoryRetrievalRequest({ ...base, maxResults: MEMORY_RETRIEVAL_MAX_RESULTS + 1 }).ok,
    ).toBe(false);
    expect(
      validateMemoryRetrievalRequest({ ...base, maxResults: MEMORY_RETRIEVAL_MAX_RESULTS }).ok,
    ).toBe(true);
    expect(
      validateMemoryRetrievalRequest({
        ...base,
        maxBodyChars: MEMORY_RETRIEVAL_MAX_BODY_CHARS + 1,
      }).ok,
    ).toBe(false);
    expect(
      validateMemoryRetrievalRequest({ ...base, maxBodyChars: MEMORY_RETRIEVAL_MAX_BODY_CHARS }).ok,
    ).toBe(true);
  });
});

// ─── Audit record ────────────────────────────────────────────────────────────
describe("validateMemoryAuditRecord", () => {
  it("accepts the happy audit record", () => {
    expect(validateMemoryAuditRecord(happyAuditRecord()).ok).toBe(true);
  });

  it("rejects actionKind / action.kind mismatch", () => {
    const r = happyAuditRecord();
    const mismatched = { ...r, actionKind: "rejected" };
    expect(validateMemoryAuditRecord(mismatched).ok).toBe(false);
  });

  it("requires the kind-specific fields", () => {
    const r = {
      ...happyAuditRecord(),
      action: { kind: "accepted", scope: happyScopeUser() },
    };
    expect(validateMemoryAuditRecord(r).ok).toBe(false);
  });

  it("validates updated action's fieldsChanged contents", () => {
    const r = {
      ...happyAuditRecord(),
      actionKind: "updated",
      action: { kind: "updated", memoryId: "mem-1", fieldsChanged: ["nope"] },
    };
    expect(validateMemoryAuditRecord(r).ok).toBe(false);
  });

  it("validates superseded action edgeKind", () => {
    const r = {
      ...happyAuditRecord(),
      actionKind: "superseded",
      action: {
        kind: "superseded",
        oldMemoryId: "a",
        newMemoryId: "b",
        edgeId: "e-1",
        edgeKind: "loves",
      },
    };
    expect(validateMemoryAuditRecord(r).ok).toBe(false);
  });

  it("rejects audit actions with empty identifier fields", () => {
    const r = {
      ...happyAuditRecord(),
      actionKind: "accepted",
      action: { kind: "accepted", proposalId: "", memoryId: "", scope: happyScopeUser() },
    };
    expect(validateMemoryAuditRecord(r).ok).toBe(false);
  });

  it("validates retrieved action's matchedMemoryIds + scopes", () => {
    const r = {
      ...happyAuditRecord(),
      actionKind: "retrieved",
      action: {
        kind: "retrieved",
        scopes: [happyScopeUser()],
        matchedMemoryIds: ["mem-1", "mem-2"],
      },
    };
    expect(validateMemoryAuditRecord(r).ok).toBe(true);
  });

  it("rejects unknown initiatorSurface", () => {
    expect(validateMemoryAuditRecord({ ...happyAuditRecord(), initiatorSurface: "bot" }).ok).toBe(
      false,
    );
  });

  it("rejects a summary that looks like a credential", () => {
    expect(
      validateMemoryAuditRecord({
        ...happyAuditRecord(),
        summary: "leak: sk-" + "ABCDEF0123456789ABCDEF",
      }).ok,
    ).toBe(false);
  });
});

// ─── looksLikeSecretShape ────────────────────────────────────────────────────
describe("looksLikeSecretShape", () => {
  it("flags OpenAI-style sk- tokens", () => {
    const openAiToken = ["sk-", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("");
    expect(looksLikeSecretShape(`hello ${openAiToken} done`)).toBe(true);
  });

  it("flags AWS access key IDs", () => {
    expect(looksLikeSecretShape("creds AKIAABCDEFGHIJKLMNOP done")).toBe(true);
  });

  it("flags GitHub personal-access tokens", () => {
    expect(looksLikeSecretShape("ghp_" + "A".repeat(36))).toBe(true);
  });

  it("flags Slack tokens", () => {
    expect(looksLikeSecretShape("xoxb-12345678-12345")).toBe(true);
  });

  it("flags JWT shape", () => {
    expect(looksLikeSecretShape("token=eyJABCDEFGH.abcdefghij.klmnopqrst more")).toBe(true);
  });

  it("flags PEM private key fences", () => {
    expect(looksLikeSecretShape("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(looksLikeSecretShape("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("flags a long digit run resembling a credit-card PAN", () => {
    expect(looksLikeSecretShape("card 4111111111111111 end")).toBe(true);
  });

  it("does not flag a plain epoch-millisecond timestamp", () => {
    expect(looksLikeSecretShape("capturedAt=1717603200000")).toBe(false);
  });

  it("does not flag normal prose", () => {
    expect(looksLikeSecretShape("Prefer 2-space indentation for TypeScript files.")).toBe(false);
    expect(looksLikeSecretShape("Use the project-id 'p-1' in URLs.")).toBe(false);
  });

  it("scopes tag validation errors to the caller field", () => {
    const result = validateMemoryRetrievalRequest({
      schemaVersion: MEMORY_SCHEMA_VERSION,
      requestedAt: 0,
      scopes: [happyScopeUser()],
      tagsFilter: [""],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain(
      "retrieval.tagsFilter entry must be a non-empty bounded control-free string",
    );
  });
});

// ─── hasStaleModelMetadata ───────────────────────────────────────────────────
describe("hasStaleModelMetadata", () => {
  function recordWithIdentity(
    identity: { provider: string; modelId: string; modelRevision?: string } | undefined,
  ): MemoryRecord {
    return {
      ...(happyRecord() as unknown as MemoryRecord),
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 0,
        confidence: 0.9,
        sensitivity: "public",
        ...(identity === undefined ? {} : { modelIdentity: identity }),
      },
    };
  }

  it("returns false when the record carries no modelIdentity", () => {
    expect(
      hasStaleModelMetadata({
        record: recordWithIdentity(undefined),
        activeIdentitiesByProvider: new Map(),
      }),
    ).toBe(false);
  });

  it("returns true when the provider is absent from the active map", () => {
    expect(
      hasStaleModelMetadata({
        record: recordWithIdentity({ provider: "anthropic", modelId: "x" }),
        activeIdentitiesByProvider: new Map(),
      }),
    ).toBe(true);
  });

  it("returns true when the active modelId differs from the record's", () => {
    expect(
      hasStaleModelMetadata({
        record: recordWithIdentity({ provider: "anthropic", modelId: "claude-4-7" }),
        activeIdentitiesByProvider: new Map([["anthropic", { modelId: "claude-5-0" }]]),
      }),
    ).toBe(true);
  });

  it("returns true when both have a revision but they differ", () => {
    expect(
      hasStaleModelMetadata({
        record: recordWithIdentity({
          provider: "anthropic",
          modelId: "claude-4-7",
          modelRevision: "rev-a",
        }),
        activeIdentitiesByProvider: new Map([
          ["anthropic", { modelId: "claude-4-7", modelRevision: "rev-b" }],
        ]),
      }),
    ).toBe(true);
  });

  it("returns false when modelId matches and revisions are absent on either side", () => {
    expect(
      hasStaleModelMetadata({
        record: recordWithIdentity({ provider: "anthropic", modelId: "claude-4-7" }),
        activeIdentitiesByProvider: new Map([["anthropic", { modelId: "claude-4-7" }]]),
      }),
    ).toBe(false);
  });
});

// ─── Type-level lineage invariants ───────────────────────────────────────────
describe("type-level scope coordinate invariants", () => {
  it("MemoryRecord rejects construction without a scope", () => {
    const recordWithoutScope = {
      id: mem("m-1"),
      schemaVersion: "1" as const,
      type: "preference" as const,
      body: "ok",
      provenance: {
        sourceKind: "explicit-user-instruction" as const,
        capturedAt: 0,
        confidence: 1,
        sensitivity: "public" as const,
      },
      validity: { validFrom: 0 },
      status: "accepted" as const,
      pinned: false,
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    };
    // @ts-expect-error — MemoryRecord requires `scope`; the structural omission is rejected.
    const assigned: MemoryRecord = recordWithoutScope;
    expect(assigned.id).toBe(mem("m-1"));
  });

  it("MemoryRecord requires provenance at the type level", () => {
    const recordWithoutProvenance = {
      schemaVersion: "1" as const,
      id: mem("m-1"),
      type: "preference" as const,
      scope: { kind: "user" as const, userId: user("u-1") },
      validity: { validFrom: 0 },
      status: "accepted" as const,
      pinned: false,
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    };
    // @ts-expect-error — MemoryRecord requires `provenance`; the structural omission is rejected.
    const assigned: MemoryRecord = recordWithoutProvenance;
    expect(assigned.id).toBe(mem("m-1"));
  });

  it("MemoryScope kind=user requires userId at the type level", () => {
    // The faulty coordinate is the value the type system rejects; assigning a `{ kind: "user" }`
    // object to a `MemoryScope` variable is the exact site that fails compilation.
    const userScopeMissingId = { kind: "user" as const };
    // @ts-expect-error — scope.kind="user" requires `userId`; the structural omission is rejected.
    const assigned: import("./memory-contracts.js").MemoryScope = userScopeMissingId;
    expect(assigned.kind).toBe("user");
  });

  it("MemoryForget.userAcknowledgedDestructive is pinned to the literal true", () => {
    type Forget = import("./memory-operations.js").MemoryForget;
    const happy: Forget = {
      schemaVersion: "1",
      memoryId: mem("m-1"),
      reviewerId: reviewer("rev-1"),
      forgottenAt: 0,
      reason: "user-request",
      userAcknowledgedDestructive: true,
    };
    expect(happy.userAcknowledgedDestructive).toBe(true);

    const forgetWithFalseAck = {
      schemaVersion: "1" as const,
      memoryId: mem("m-1"),
      reviewerId: reviewer("rev-1"),
      forgottenAt: 0,
      reason: "GDPR",
      userAcknowledgedDestructive: false as const,
    };
    // @ts-expect-error — userAcknowledgedDestructive must be the literal `true`.
    const bad: Forget = forgetWithFalseAck;
    expect(bad).toBeDefined();
  });
});

// ─── Mutation-robustness anchors ─────────────────────────────────────────────
// Each anchor names a single-line implementation mutation that would otherwise survive.
describe("mutation-robustness anchors", () => {
  it("confidence range check: 1.0001 must reject", () => {
    expect(validateMemoryProvenance({ ...happyProvenance(), confidence: 1.0001 }).ok).toBe(false);
  });

  it("validUntil < validFrom check: must reject", () => {
    expect(validateMemoryValidityInterval({ validFrom: 5, validUntil: 4 }).ok).toBe(false);
  });

  it("status transition same-state: must reject as no-op", () => {
    expect(checkStatusTransition("accepted", "accepted").ok).toBe(false);
  });

  it("scope coordinate empty-string check: must reject", () => {
    expect(validateMemoryScope({ kind: "user", userId: "" }).ok).toBe(false);
  });

  it("edge self-loop check: must reject", () => {
    expect(validateMemoryEdge({ ...happyEdge(), fromMemoryId: "x", toMemoryId: "x" }).ok).toBe(
      false,
    );
  });

  it("forget acknowledgement check: false must reject", () => {
    expect(
      validateMemoryForget({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        memoryId: "m-1",
        reviewerId: "r-1",
        forgottenAt: 0,
        reason: "x",
        userAcknowledgedDestructive: false,
      }).ok,
    ).toBe(false);
  });

  it("update no-op check: empty patch must reject", () => {
    expect(
      validateMemoryUpdate({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        memoryId: "m-1",
        reviewerId: "r-1",
        updatedAt: 0,
      }).ok,
    ).toBe(false);
  });

  it("audit summary secret-shape check: must reject", () => {
    expect(
      validateMemoryAuditRecord({
        ...happyAuditRecord(),
        summary: "ghp_" + "A".repeat(36),
      }).ok,
    ).toBe(false);
  });

  it("retrieval empty scopes check: must reject", () => {
    expect(
      validateMemoryRetrievalRequest({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        requestedAt: 0,
        scopes: [],
      }).ok,
    ).toBe(false);
  });
});

// ─── Distinguishing-from-neighbouring-contracts proof ────────────────────────
// These tests prove the four "things that look like text with provenance" do not collapse
// into each other in the type system or at runtime.
describe("contract distinction proof", () => {
  it("MemoryRecord ≠ KnowledgeCapsule: structural shape rejected by isMemoryRecord", () => {
    const cap = {
      id: "cap-1",
      displayName: "Risk Controls",
      sourceIds: ["s-1"],
      retrievalEffort: "default",
      outputMode: "answers",
      answerGroundingPolicy: "require-citations",
      embeddingModelIdentity: {
        provider: "openai",
        modelId: "x",
        vectorDimensions: 1,
        vectorMetric: "cosine",
      },
      lifecycleState: "ready",
      storageReference: "capsules/cap-1",
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isMemoryRecord(cap)).toBe(false);
  });

  it("MemoryRecord ≠ chat message", () => {
    expect(isMemoryRecord({ id: "msg-1", role: "user", content: "hi" })).toBe(false);
  });

  it("MemoryEdge ≠ ConnectorEdge", () => {
    expect(
      isMemoryEdge({
        from: { nodeId: "n-1", kind: "files-window" },
        to: { nodeId: "n-2", kind: "local-knowledge" },
        createdAt: 0,
      }),
    ).toBe(false);
  });
});

// Avoid unused-import warnings — pin the audit/edge alias and structural type to silence
// the type checker when verbatimModuleSyntax is strict.
const _unusedTypeAnchor = (): void => {
  const _a: MemoryEdge = {
    id: edge("e-1"),
    schemaVersion: "1",
    fromMemoryId: mem("a"),
    toMemoryId: mem("b"),
    kind: "related",
    createdAt: 0,
  };
  const _b: MemoryAuditRecordId = audit("ar-1");
};

// These ordinary-object controls preserve the existing observation schedule, not a
// guarantee that a getter cannot change after validation. The original before receipt
// retains the pre-migration production behavior.
describe("public memory observation preservation", () => {
  it.each([
    { kind: "global" },
    { kind: "user", userId: "user" },
    { kind: "workspace", workspaceId: "workspace" },
    { kind: "project", projectId: "project" },
    { kind: "workflow", workflowDefinitionId: "workflow" },
  ])("retains each scope arm by identity: $kind", (scope) => {
    const result = publicMemory.validateMemoryScope(scope);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(scope);
  });

  it.each([
    { kind: "string-list", items: ["one", "two"] },
    { kind: "key-value", entries: [{ key: "key", value: "value" }] },
  ])("retains root, nested values and serialized bytes for $kind", (payload) => {
    const record = happyRecord();
    const input = {
      ...record,
      payload,
      retentionHint: { policyKey: "default", retainUntil: 0, notes: "note" },
    };
    const bytes = JSON.stringify(input);
    const result = publicMemory.validateMemoryRecord(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(input);
    expect(result.value.scope).toBe(record.scope);
    expect(result.value.provenance).toBe(record.provenance);
    expect(result.value.validity).toBe(record.validity);
    expect(result.value.tags).toBe(record.tags);
    expect(result.value.retentionHint).toBe(input.retentionHint);
    expect(result.value.payload).toBe(payload);
    expect(JSON.stringify(result.value)).toBe(bytes);
    const checked = publicMemory.validateMemoryStructuredPayload(payload);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value).toBe(payload);
    if (checked.value.kind === "string-list") expect(checked.value.items).toBe(payload.items);
    else {
      expect(checked.value.entries).toBe(payload.entries);
      expect(checked.value.entries[0]).toBe(payload.entries?.[0]);
    }
  });

  it.each(["payload", "staleReason", "retentionHint"])(
    "preserves omitted and own-undefined %s while refusing null",
    (field) => {
      const omitted = happyRecord();
      const explicit = { ...omitted, [field]: undefined };
      for (const input of [omitted, explicit]) {
        const result = publicMemory.validateMemoryRecord(input);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe(input);
          expect(Object.hasOwn(result.value, field)).toBe(Object.hasOwn(input, field));
          expect(JSON.stringify(result.value)).toBe(JSON.stringify(input));
        }
      }
      expect(publicMemory.validateMemoryRecord({ ...omitted, [field]: null }).ok).toBe(false);
    },
  );

  it("preserves open expiry omission and own-undefined beside null refusal", () => {
    for (const input of [{ validFrom: 0 }, { validFrom: 0, validUntil: undefined }]) {
      const result = publicMemory.validateMemoryValidityInterval(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(input);
        expect(Object.hasOwn(result.value, "validUntil")).toBe(Object.hasOwn(input, "validUntil"));
      }
    }
    expect(publicMemory.validateMemoryValidityInterval({ validFrom: 0, validUntil: null }).ok).toBe(
      false,
    );
  });

  it("retains ordered diagnostics across independent record failures", () => {
    const result = publicMemory.validateMemoryRecord({
      ...happyRecord(),
      schemaVersion: "2",
      scope: { kind: "user", userId: "" },
      body: "",
      pinned: 0,
      type: "invalid",
      status: "invalid",
      createdAt: 2,
      updatedAt: 1,
      payload: { kind: "string-list", items: [""] },
      provenance: { ...happyProvenance(), confidence: 2 },
      validity: { validFrom: 2, validUntil: 1 },
      tags: [""],
      retentionHint: { policyKey: "" },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'record.schemaVersion must be the literal "1"',
        "record.scope.userId must be a non-empty string for kind=user",
        "record.body must be a bounded control-free non-empty string",
        "record.pinned must be a boolean",
        "record.type must be one of episodic|semantic-fact|procedural|preference|correction|decision|negative|pinned",
        "record.status must be one of proposed|accepted|rejected|superseded|archived|forgotten|conflicted|expired",
        "record.updatedAt must be greater than or equal to record.createdAt",
        "record.payload.items entry must be a non-empty bounded control-free string",
        "record.provenance.confidence must be a finite number in [0, 1]",
        "record.validity.validUntil must be greater than or equal to validFrom",
        "record.tags entry must be a non-empty bounded control-free string",
        "record.retentionHint.policyKey must be a non-empty string",
      ],
    });
  });

  it("reads scope through its original Proxy receiver in order", () => {
    const reads: string[] = [];
    const scope = new Proxy(
      { kind: "user", userId: "user" },
      {
        get(target, key, receiver): unknown {
          expect(receiver).toBe(scope);
          reads.push(String(key));
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const result = publicMemory.validateMemoryScope(scope);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(scope);
    expect(reads).toEqual(["kind", "kind", "userId"]);
  });

  it("retains repeated validity reads including a changing final getter", () => {
    const reads: string[] = [];
    let untilReads = 0;
    const input = {
      get validFrom(): number {
        reads.push("from");
        return 1;
      },
      get validUntil(): number {
        reads.push("until");
        return ++untilReads === 3 ? 0 : 2;
      },
    };
    expect(publicMemory.validateMemoryValidityInterval(input)).toEqual({
      ok: false,
      errors: ["validity.validUntil must be greater than or equal to validFrom"],
    });
    expect(reads).toEqual(["from", "until", "until", "from", "until", "from"]);
    expect(publicMemory.validateMemoryValidityInterval({ validFrom: 1, validUntil: 2 }).ok).toBe(
      true,
    );
  });

  it("propagates the exact error at the second expiry getter read", () => {
    const failure = new TypeError("fixture getter failure");
    let reads = 0;
    const input = {
      validFrom: 1,
      get validUntil(): number {
        if (++reads === 2) throw failure;
        return 2;
      },
    };
    expect.assertions(3);
    try {
      publicMemory.validateMemoryValidityInterval(input);
    } catch (error: unknown) {
      expect(error).toBe(failure);
    }
    expect(reads).toBe(2);
    expect(publicMemory.validateMemoryValidityInterval({ validFrom: 1 }).ok).toBe(true);
  });

  it("preserves payload array reads, iteration and receiver", () => {
    const reads: string[] = [];
    const items = new Proxy(["item"], {
      get(target, key, receiver): unknown {
        expect(receiver).toBe(items);
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    let itemReads = 0;
    const payload = {
      kind: "string-list",
      get items(): string[] {
        itemReads++;
        return items;
      },
    };
    expect(publicMemory.validateMemoryStructuredPayload(payload).ok).toBe(true);
    expect(itemReads).toBe(3);
    expect(reads).toEqual(["length", "Symbol(Symbol.iterator)", "length", "0", "length"]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "refuses invalid optional expiry and record timestamps %s",
    (value) => {
      expect(
        publicMemory.validateMemoryValidityInterval({ validFrom: 0, validUntil: value }).ok,
      ).toBe(false);
      expect(publicMemory.validateMemoryRecord({ ...happyRecord(), createdAt: value }).ok).toBe(
        false,
      );
      expect(publicMemory.validateMemoryRecord({ ...happyRecord(), updatedAt: value }).ok).toBe(
        false,
      );
      expect(
        publicMemory.validateMemoryRecord({ ...happyRecord(), createdAt: 0, updatedAt: 0 }).ok,
      ).toBe(true);
    },
  );

  it("retains distinct coordinate and record ID grammar", () => {
    const id = " ../\uff41/record ";
    expect(publicMemory.validateMemoryScope({ kind: "user", userId: id }).ok).toBe(true);
    expect(publicMemory.validateMemoryRecord({ ...happyRecord(), id }).ok).toBe(true);
  });

  it("accepts exact payload count/text boundaries without normalization", () => {
    const items = Array.from({ length: 128 }, () => "\uff41\t\n\r" + "x".repeat(4092));
    const payload = { kind: "string-list", items };
    expect(publicMemory.validateMemoryStructuredPayload(payload).ok).toBe(true);
    const entries = Array.from({ length: 128 }, () => ({
      key: "k".repeat(64),
      value: "x".repeat(4096),
    }));
    expect(publicMemory.validateMemoryStructuredPayload({ kind: "key-value", entries }).ok).toBe(
      true,
    );
    expect(items[0]).toBe("\uff41\t\n\r" + "x".repeat(4092));
  });
});

describe("public memory optional and root observation preservation", () => {
  it.each([
    "sourceConversationId",
    "sourceWorkflowRunId",
    "sourceEvidenceManifestId",
    "modelIdentity",
    "captureRationale",
  ])("preserves provenance optional %s and refuses null", (field) => {
    const omitted = happyProvenance();
    for (const input of [omitted, { ...omitted, [field]: undefined }]) {
      const result = publicMemory.validateMemoryProvenance(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(input);
        expect(Object.hasOwn(result.value, field)).toBe(Object.hasOwn(input, field));
      }
    }
    expect(publicMemory.validateMemoryProvenance({ ...omitted, [field]: null }).ok).toBe(false);
  });

  it("retains root field observation order and receiver", () => {
    const reads: string[] = [];
    const input = new Proxy(happyRecord(), {
      get(target, key, receiver): unknown {
        expect(receiver).toBe(input);
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    const result = publicMemory.validateMemoryRecord(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
    expect(reads).toEqual([
      "schemaVersion",
      "scope",
      "id",
      "body",
      "pinned",
      "staleReason",
      "type",
      "status",
      "createdAt",
      "updatedAt",
      "createdAt",
      "updatedAt",
      "updatedAt",
      "createdAt",
      "payload",
      "provenance",
      "validity",
      "tags",
      "retentionHint",
    ]);
  });

  it("propagates a fixture-owned payload iterator failure without rewriting it", () => {
    const failure = new TypeError("fixture iterator failure");
    const items = ["item"];
    Object.defineProperty(items, Symbol.iterator, {
      value(): never {
        throw failure;
      },
    });
    expect.assertions(2);
    try {
      publicMemory.validateMemoryStructuredPayload({ kind: "string-list", items });
    } catch (error: unknown) {
      expect(error).toBe(failure);
    }
    expect(
      publicMemory.validateMemoryStructuredPayload({ kind: "string-list", items: ["item"] }).ok,
    ).toBe(true);
  });
});

it("keeps own-undefined expiry in the public presence-branch type", () => {
  const input = { validFrom: 0, validUntil: undefined };
  const result = publicMemory.validateMemoryValidityInterval(input);
  expect(result.ok).toBe(true);
  if (result.ok && "validUntil" in result.value) {
    expectTypeOf(result.value.validUntil).toEqualTypeOf<number | undefined>();
    expect(result.value.validUntil).toBeUndefined();
    expect(result.value).toBe(input);
  }
});

it("keeps the proven public optional types honest under required presence", () => {
  expectTypeOf<Required<publicMemory.MemoryValidityInterval>["validUntil"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryModelIdentity>["modelRevision"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryProvenance>["sourceConversationId"]>().toEqualTypeOf<
    publicMemory.ConversationId | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryProvenance>["sourceWorkflowRunId"]>().toEqualTypeOf<
    publicMemory.WorkflowRunId | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryProvenance>["sourceEvidenceManifestId"]>().toEqualTypeOf<
    publicMemory.EvidenceManifestId | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryProvenance>["modelIdentity"]>().toEqualTypeOf<
    publicMemory.MemoryModelIdentity | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryProvenance>["captureRationale"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryRetentionHint>["retainUntil"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryRetentionHint>["notes"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryRecord>["payload"]>().toEqualTypeOf<
    publicMemory.MemoryStructuredPayload | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryRecord>["staleReason"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryRecord>["retentionHint"]>().toEqualTypeOf<
    publicMemory.MemoryRetentionHint | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryEdge>["confidence"]>().toEqualTypeOf<
    number | undefined
  >();
  expectTypeOf<Required<publicMemory.MemoryEdge>["provenanceSummary"]>().toEqualTypeOf<
    string | undefined
  >();
});

// MEM4013-HOSTILE-EVERY-001 / MEM4013-HOSTILE-PUSH-001: intrinsic mutations stay
// inside disposable processes; each challenge has a production healthy control.
const MEMORY_INTRINSIC_CONTROL = `
import { strict as assert } from "node:assert";
import { validateMemoryScope, validateMemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
const healthy = {
  id: "memory-fixture", schemaVersion: "1", scope: { kind: "global" },
  type: "episodic", body: "fixture", status: "accepted", pinned: false, tags: [],
  provenance: { sourceKind: "explicit-user-instruction", capturedAt: 0, confidence: 1, sensitivity: "public" },
  validity: { validFrom: 0 }, createdAt: 0, updatedAt: 0,
};
const scopeControl = validateMemoryScope(healthy.scope);
const recordControl = validateMemoryRecord(healthy);
assert.equal(scopeControl.ok, true);
assert.equal(scopeControl.value, healthy.scope);
assert.equal(recordControl.ok, true);
assert.equal(recordControl.value, healthy);
const push = Object.getOwnPropertyDescriptor(Array.prototype, "push");
const every = Object.getOwnPropertyDescriptor(Array.prototype, "every");
let reads = 0;
let result;
try {
  if (process.argv[1] === "push") {
    result = validateMemoryScope({ get kind() {
      reads++;
      Array.prototype.push = function () { throw new Error("fixture-push"); };
      return "invalid-fixture-kind";
    } });
  } else {
    result = validateMemoryRecord({ ...healthy, schemaVersion: "invalid-fixture-version", get id() {
      reads++;
      Array.prototype.every = function () { return true; };
      return "memory-fixture";
    } });
  }
} finally {
  Object.defineProperty(Array.prototype, "push", push);
  Object.defineProperty(Array.prototype, "every", every);
}
assert.equal(reads, 1);
assert.deepEqual(result, { ok: false, errors: [process.argv[1] === "push"
  ? "scope.kind must be one of user|workspace|project|workflow|global"
  : 'record.schemaVersion must be the literal "1"'] });
`;

it.each(["push", "every"])(
  "preserves public refusal after a getter replaces Array.%s",
  (method) => {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", MEMORY_INTRINSIC_CONTROL, method],
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 },
    );
    expect(child.error).toBeUndefined();
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
  },
);

// Original-first obligations for the remaining DTO chains. Both actual source and built
// public calls must reach their healthy controls before a refusal is called a regression red.
describe("remaining memory DTO physical admission (#3918)", () => {
  it.each(["source", "public"])("retains %s healthy envelope references", (surface) => {
    const proposal = happyProposal();
    const auditRecord = happyAuditRecord();
    const retrieval = { schemaVersion: "1", requestedAt: 0, scopes: [happyScopeUser()] };
    const proposalResult =
      surface === "source"
        ? validateMemoryProposal(proposal)
        : publicMemory.validateMemoryProposal(proposal);
    const auditResult =
      surface === "source"
        ? validateMemoryAuditRecord(auditRecord)
        : publicMemory.validateMemoryAuditRecord(auditRecord);
    const retrievalResult =
      surface === "source"
        ? validateMemoryRetrievalRequest(retrieval)
        : publicMemory.validateMemoryRetrievalRequest(retrieval);
    expect(proposalResult.ok).toBe(true);
    if (proposalResult.ok) expect(proposalResult.value).toBe(proposal);
    expect(auditResult.ok).toBe(true);
    if (auditResult.ok) expect(auditResult.value).toBe(auditRecord);
    expect(retrievalResult.ok).toBe(true);
    if (retrievalResult.ok) expect(retrievalResult.value).toBe(retrieval);
  });

  it.each(["source", "public"])("rejects %s own undefined required audit proposalId", (surface) => {
    const input = {
      ...happyAuditRecord(),
      action: {
        kind: "accepted",
        proposalId: undefined,
        memoryId: "mem-1",
        scope: happyScopeUser(),
      },
    };
    const result =
      surface === "source"
        ? validateMemoryAuditRecord(input)
        : publicMemory.validateMemoryAuditRecord(input);
    expect(result).toEqual({ ok: false, errors: ["action.proposalId must be a non-empty string"] });
  });

  it.each(["source", "public"])("rejects %s own undefined required audit memoryId", (surface) => {
    const input = {
      ...happyAuditRecord(),
      action: {
        kind: "accepted",
        proposalId: "prop-1",
        memoryId: undefined,
        scope: happyScopeUser(),
      },
    };
    const result =
      surface === "source"
        ? validateMemoryAuditRecord(input)
        : publicMemory.validateMemoryAuditRecord(input);
    expect(result).toEqual({ ok: false, errors: ["action.memoryId must be a non-empty string"] });
  });

  it.each(["source", "public"])(
    "refuses %s malformed physical retrieval scope hidden by iterator",
    (surface) => {
      const scopes: unknown[] = [{}];
      Object.defineProperty(scopes, Symbol.iterator, {
        value: function* (): Generator {
          yield happyScopeUser();
        },
      });
      const input = { schemaVersion: "1", requestedAt: 0, scopes };
      const result =
        surface === "source"
          ? validateMemoryRetrievalRequest(input)
          : publicMemory.validateMemoryRetrievalRequest(input);
      expect(result.ok).toBe(false);
    },
  );

  it.each(["source", "public"])(
    "refuses %s malformed physical retrieved audit scope hidden by iterator",
    (surface) => {
      const scopes: unknown[] = [{}];
      Object.defineProperty(scopes, Symbol.iterator, {
        value: function* (): Generator {
          yield happyScopeUser();
        },
      });
      const input = {
        ...happyAuditRecord(),
        actionKind: "retrieved",
        action: { kind: "retrieved", scopes, matchedMemoryIds: ["mem-1"] },
      };
      const result =
        surface === "source"
          ? validateMemoryAuditRecord(input)
          : publicMemory.validateMemoryAuditRecord(input);
      expect(result.ok).toBe(false);
    },
  );

  it.each(["source", "public"])("refuses %s physical type filter hidden by iterator", (surface) => {
    const typeFilter = ["not-a-memory-type"];
    Object.defineProperty(typeFilter, Symbol.iterator, {
      value: function* (): Generator {
        yield "preference";
      },
    });
    const input = { schemaVersion: "1", requestedAt: 0, scopes: [happyScopeUser()], typeFilter };
    const result =
      surface === "source"
        ? validateMemoryRetrievalRequest(input)
        : publicMemory.validateMemoryRetrievalRequest(input);
    expect(result).toEqual({
      ok: false,
      errors: [`retrieval.typeFilter entry must be one of ${MEMORY_TYPES.join("|")}`],
    });
  });

  it.each(["source", "public"])(
    "refuses %s physical numeric tag hidden by every and iterator",
    (surface) => {
      const tags: unknown[] = [5];
      Object.defineProperty(tags, "every", {
        value(): boolean {
          return true;
        },
      });
      Object.defineProperty(tags, Symbol.iterator, {
        value: function* (): Generator {
          yield "healthy";
        },
      });
      const input = { ...happyProposal(), tags };
      const result =
        surface === "source"
          ? validateMemoryProposal(input)
          : publicMemory.validateMemoryProposal(input);
      expect(result).toEqual({ ok: false, errors: ["proposal.tags must be a string array"] });
    },
  );
});

it.each(["source", "public"])(
  "preserves %s omitted and own-undefined proposal options",
  (surface) => {
    const omitted = happyProposal();
    const explicit = {
      ...happyProposal(),
      payload: undefined,
      retentionHint: undefined,
      captureReason: undefined,
    };
    const validate =
      surface === "source" ? validateMemoryProposal : publicMemory.validateMemoryProposal;
    const first = validate(omitted);
    const second = validate(explicit);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toBe(omitted);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe(explicit);
    expect(Object.hasOwn(omitted, "captureReason")).toBe(false);
    expect(Object.hasOwn(explicit, "captureReason")).toBe(true);
  },
);

export function parsePublicMemoryRecord(
  input: unknown,
): PublicMemoryValidation<PublicMemoryRecord> {
  const result = validatePublicMemoryRecord(input);
  return result;
}

export function parsePublicMemoryScope(input: unknown): PublicMemoryValidation<PublicMemoryScope> {
  const result = validatePublicMemoryScope(input);
  return result;
}

export function parsePublicMemoryPayload(
  input: unknown,
): PublicMemoryValidation<PublicMemoryStructuredPayload> {
  const result = validatePublicMemoryStructuredPayload(input);
  return result;
}

describe("Memory public parsers (#3918)", () => {
  it("preserves original record, scope and payload references and optional presence", () => {
    const payload = { kind: "string-list", items: ["fixture-item"] };
    const input = { ...happyRecord(), scope: happyScopeUser(), payload };
    const record = parsePublicMemoryRecord(input);
    expect(record.ok).toBe(true);
    if (!record.ok) throw new TypeError("healthy public memory refused");
    expect(record.value).toBe(input);
    expect(record.value.scope).toBe(input.scope);
    expect(record.value.payload).toBe(payload);
    expect(record.value).not.toHaveProperty("staleReason");
    const ownUndefined = { ...input, staleReason: undefined };
    expect(parsePublicMemoryRecord(ownUndefined)).toEqual({ ok: true, value: ownUndefined });
    expect(Object.hasOwn(ownUndefined, "staleReason")).toBe(true);
    const scope = parsePublicMemoryScope(input.scope);
    const parsedPayload = parsePublicMemoryPayload(payload);
    if (!scope.ok || !parsedPayload.ok) throw new TypeError("healthy public nested memory refused");
    expect(scope.value).toBe(input.scope);
    expect(parsedPayload.value).toBe(payload);
  });

  it("refuses malformed values through each actual public parser with owning reasons", () => {
    for (const input of [undefined, null, 12, "record", []]) {
      expect(parsePublicMemoryRecord(input).ok).toBe(false);
      expect(parsePublicMemoryScope(input).ok).toBe(false);
      expect(parsePublicMemoryPayload(input).ok).toBe(false);
    }
    const record = { ...happyRecord(), schemaVersion: "2", type: "bad", updatedAt: -1 };
    expect(parsePublicMemoryRecord(record)).toEqual(validateMemoryRecord(record));
    expect(parsePublicMemoryRecord(record)).toMatchObject({
      ok: false,
      errors: [
        'record.schemaVersion must be the literal "1"',
        `record.type must be one of ${MEMORY_TYPES.join("|")}`,
        "record.updatedAt must be a finite non-negative number",
      ],
    });
    expect(parsePublicMemoryScope({ kind: "user", userId: "" })).toEqual({
      ok: false,
      errors: ["scope.userId must be a non-empty string for kind=user"],
    });
    expect(parsePublicMemoryPayload({ kind: "string-list", items: [12] })).toEqual({
      ok: false,
      errors: ["payload.items entry must be a non-empty bounded control-free string"],
    });
  });

  it("retains global coordinates and payload bounds and literal domain result identities", () => {
    const scope = { kind: "global", userId: "ignored" };
    const parsedScope = parsePublicMemoryScope(scope);
    expect(parsedScope).toEqual({ ok: true, value: scope });
    for (const payload of [
      { kind: "string-list", items: [] },
      { kind: "key-value", entries: [{ key: "label", value: "" }] },
    ])
      expect(parsePublicMemoryPayload(payload)).toEqual({ ok: true, value: payload });
    expect(
      parsePublicMemoryPayload({
        kind: "string-list",
        items: Array.from({ length: 129 }, () => "item"),
      }).ok,
    ).toBe(false);
    expectTypeOf(parsePublicMemoryRecord).returns.toEqualTypeOf<
      PublicMemoryValidation<PublicMemoryRecord>
    >();
    expectTypeOf(parsePublicMemoryScope).returns.toEqualTypeOf<
      PublicMemoryValidation<PublicMemoryScope>
    >();
    expectTypeOf(parsePublicMemoryPayload).returns.toEqualTypeOf<
      PublicMemoryValidation<PublicMemoryStructuredPayload>
    >();
  });
});

export function parsePublicMemoryProposal(
  input: unknown,
): PublicMemoryValidation<PublicMemoryProposal> {
  const result = validatePublicMemoryProposal(input);
  return result;
}

export function parsePublicMemoryAcceptance(
  input: unknown,
): PublicMemoryValidation<PublicMemoryAcceptance> {
  const result = validatePublicMemoryAcceptance(input);
  return result;
}

export function parsePublicMemoryRejection(
  input: unknown,
): PublicMemoryValidation<PublicMemoryRejection> {
  const result = validatePublicMemoryRejection(input);
  return result;
}

export function parsePublicMemoryUpdate(
  input: unknown,
): PublicMemoryValidation<PublicMemoryUpdate> {
  const result = validatePublicMemoryUpdate(input);
  return result;
}

export function parsePublicMemorySupersession(
  input: unknown,
): PublicMemoryValidation<PublicMemorySupersession> {
  const result = validatePublicMemorySupersession(input);
  return result;
}

export function parsePublicMemoryPin(input: unknown): PublicMemoryValidation<PublicMemoryPin> {
  const result = validatePublicMemoryPin(input);
  return result;
}

export function parsePublicMemoryUnpin(input: unknown): PublicMemoryValidation<PublicMemoryUnpin> {
  const result = validatePublicMemoryUnpin(input);
  return result;
}

export function parsePublicMemoryArchive(
  input: unknown,
): PublicMemoryValidation<PublicMemoryArchive> {
  const result = validatePublicMemoryArchive(input);
  return result;
}

export function parsePublicMemoryForget(
  input: unknown,
): PublicMemoryValidation<PublicMemoryForget> {
  const result = validatePublicMemoryForget(input);
  return result;
}

export function parsePublicMemoryAuditRecord(
  input: unknown,
): PublicMemoryValidation<PublicMemoryAuditRecord> {
  const result = validatePublicMemoryAuditRecord(input);
  return result;
}

export function parsePublicMemoryRetrievalRequest(
  input: unknown,
): PublicMemoryValidation<PublicMemoryRetrievalRequest> {
  const result = validatePublicMemoryRetrievalRequest(input);
  return result;
}

interface RemainingMemoryCase {
  readonly parse: (input: unknown) => PublicMemoryValidation<unknown>;
  readonly input: Record<string, unknown>;
  readonly invalid: Record<string, unknown>;
  readonly errors: readonly string[];
  readonly optionalField: string;
}

function lifecycleProofInput(fields: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: "1", memoryId: "mem-1", reviewerId: "rev-1", ...fields };
}

function remainingMemoryCase(
  parse: RemainingMemoryCase["parse"],
  input: Record<string, unknown>,
  patch: Record<string, unknown>,
  error: string,
  optionalField = "fixtureExtension",
): RemainingMemoryCase {
  return { parse, input, invalid: { ...input, ...patch }, errors: [error], optionalField };
}

function remainingInitialMemoryCases(): readonly RemainingMemoryCase[] {
  return [
    remainingMemoryCase(
      parsePublicMemoryProposal,
      happyProposal(),
      { initialStatus: "accepted" },
      'proposal.initialStatus must be the literal "proposed"',
      "captureReason",
    ),
    remainingMemoryCase(
      parsePublicMemoryAcceptance,
      lifecycleProofInput({ proposalId: "prop-1", mintedMemoryId: "mem-1", acceptedAt: 0 }),
      { acceptedAt: -1 },
      "acceptance.acceptedAt must be a finite non-negative number",
      "bodyOverride",
    ),
    remainingMemoryCase(
      parsePublicMemoryRejection,
      lifecycleProofInput({ proposalId: "prop-1", rejectedAt: 0, reason: "fixture" }),
      { reason: "" },
      "rejection.reason must be a bounded control-free non-empty string",
    ),
    remainingMemoryCase(
      parsePublicMemoryUpdate,
      lifecycleProofInput({ updatedAt: 0, bodyPatch: "fixture" }),
      { bodyPatch: undefined },
      "update must change at least one field",
      "reviewerNote",
    ),
  ];
}

function remainingLifecycleMemoryCases(): readonly RemainingMemoryCase[] {
  return [
    remainingMemoryCase(
      parsePublicMemorySupersession,
      lifecycleProofInput({
        oldMemoryId: "old",
        newMemoryId: "new",
        supersededAt: 0,
        reason: "fixture",
        edgeKind: "supersedes",
      }),
      { edgeKind: "related" },
      'supersession.edgeKind must be the literal "supersedes"',
    ),
    remainingMemoryCase(
      parsePublicMemoryPin,
      lifecycleProofInput({ pinnedAt: 0 }),
      { pinnedAt: -1 },
      "pin.pinnedAt must be a finite non-negative number",
      "reason",
    ),
    remainingMemoryCase(
      parsePublicMemoryUnpin,
      lifecycleProofInput({ unpinnedAt: 0 }),
      { unpinnedAt: -1 },
      "unpin.unpinnedAt must be a finite non-negative number",
      "reason",
    ),
    remainingMemoryCase(
      parsePublicMemoryArchive,
      lifecycleProofInput({ archivedAt: 0 }),
      { archivedAt: -1 },
      "archive.archivedAt must be a finite non-negative number",
      "reason",
    ),
  ];
}

function remainingOtherMemoryCases(): readonly RemainingMemoryCase[] {
  return [
    remainingMemoryCase(
      parsePublicMemoryForget,
      lifecycleProofInput({
        forgottenAt: 0,
        reason: "user-request",
        userAcknowledgedDestructive: true,
      }),
      { userAcknowledgedDestructive: false },
      "forget.userAcknowledgedDestructive must be the literal true",
    ),
    remainingMemoryCase(
      parsePublicMemoryAuditRecord,
      happyAuditRecord(),
      { actionKind: "archived" },
      "auditRecord.action.kind must match auditRecord.actionKind",
      "initiatorReviewerId",
    ),
    remainingMemoryCase(
      parsePublicMemoryRetrievalRequest,
      { schemaVersion: "1", requestedAt: 0, scopes: [happyScopeUser()] },
      { scopes: [] },
      "retrieval.scopes must be a non-empty array",
      "includeSuperseded",
    ),
  ];
}

function initialAuditProofActions(): readonly Record<string, unknown>[] {
  return [
    { kind: "proposed", proposalId: "prop-1", scope: happyScopeUser() },
    { kind: "accepted", proposalId: "prop-1", memoryId: "mem-1", scope: happyScopeUser() },
    { kind: "rejected", proposalId: "prop-1", reason: "fixture" },
    { kind: "updated", memoryId: "mem-1", fieldsChanged: ["body"] },
    {
      kind: "superseded",
      oldMemoryId: "old",
      newMemoryId: "new",
      edgeId: "edge-1",
      edgeKind: "supersedes",
    },
  ];
}

function remainingAuditProofActions(): readonly Record<string, unknown>[] {
  return [
    { kind: "pinned", memoryId: "mem-1" },
    { kind: "unpinned", memoryId: "mem-1" },
    { kind: "archived", memoryId: "mem-1" },
    { kind: "forgotten", memoryId: "mem-1", scope: happyScopeUser(), reason: "user-request" },
    { kind: "retrieved", scopes: [happyScopeUser()], matchedMemoryIds: ["mem-1"] },
  ];
}

function auditMemoryProofCases(): readonly RemainingMemoryCase[] {
  return [...initialAuditProofActions(), ...remainingAuditProofActions()].map((action) =>
    remainingMemoryCase(
      parsePublicMemoryAuditRecord,
      { ...happyAuditRecord(), actionKind: action.kind, action },
      { actionKind: action.kind === "accepted" ? "archived" : "accepted" },
      "auditRecord.action.kind must match auditRecord.actionKind",
      "initiatorReviewerId",
    ),
  );
}

function allRemainingMemoryCases(): readonly RemainingMemoryCase[] {
  return [
    ...remainingInitialMemoryCases(),
    ...remainingLifecycleMemoryCases(),
    ...remainingOtherMemoryCases(),
    ...auditMemoryProofCases(),
  ];
}

function expectRemainingMemoryIdentity(own: RemainingMemoryCase): void {
  const parsed = own.parse(own.input);
  if (!parsed.ok) throw new TypeError("healthy remaining public memory refused");
  expect(parsed.value).toBe(own.input);
  const descriptors = Object.getOwnPropertyDescriptors(parsed.value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(own.input))) {
    expect(descriptors[key]?.value).toBe(descriptor.value);
  }
  expect(Object.hasOwn(own.input, own.optionalField)).toBe(false);
  const explicit = { ...own.input, [own.optionalField]: undefined };
  const result = own.parse(explicit);
  expect(result).toEqual({ ok: true, value: explicit });
  if (!result.ok) throw new TypeError("public own-undefined memory refused");
  expect(result.value).toBe(explicit);
  expect(Object.hasOwn(explicit, own.optionalField)).toBe(true);
}

function assertRemainingInitialMemoryTypes(): void {
  expectTypeOf(validatePublicMemoryProposal).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryProposal>
  >();
  expectTypeOf(parsePublicMemoryProposal).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryProposal>
  >();
  expectTypeOf(validatePublicMemoryAcceptance).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryAcceptance>
  >();
  expectTypeOf(parsePublicMemoryAcceptance).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryAcceptance>
  >();
  expectTypeOf(validatePublicMemoryRejection).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryRejection>
  >();
  expectTypeOf(parsePublicMemoryRejection).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryRejection>
  >();
  expectTypeOf(validatePublicMemoryUpdate).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryUpdate>
  >();
  expectTypeOf(parsePublicMemoryUpdate).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryUpdate>
  >();
}

function assertRemainingLifecycleMemoryTypes(): void {
  expectTypeOf(validatePublicMemorySupersession).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemorySupersession>
  >();
  expectTypeOf(parsePublicMemorySupersession).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemorySupersession>
  >();
  expectTypeOf(validatePublicMemoryPin).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryPin>
  >();
  expectTypeOf(parsePublicMemoryPin).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryPin>
  >();
  expectTypeOf(validatePublicMemoryUnpin).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryUnpin>
  >();
  expectTypeOf(parsePublicMemoryUnpin).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryUnpin>
  >();
  expectTypeOf(validatePublicMemoryArchive).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryArchive>
  >();
  expectTypeOf(parsePublicMemoryArchive).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryArchive>
  >();
}

function assertRemainingOtherMemoryTypes(): void {
  expectTypeOf(validatePublicMemoryForget).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryForget>
  >();
  expectTypeOf(parsePublicMemoryForget).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryForget>
  >();
  expectTypeOf(validatePublicMemoryAuditRecord).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryAuditRecord>
  >();
  expectTypeOf(parsePublicMemoryAuditRecord).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryAuditRecord>
  >();
  expectTypeOf(validatePublicMemoryRetrievalRequest).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryRetrievalRequest>
  >();
  expectTypeOf(parsePublicMemoryRetrievalRequest).returns.toEqualTypeOf<
    PublicMemoryValidation<PublicMemoryRetrievalRequest>
  >();
}

function expectRemainingMemoryAccumulation(): void {
  expect(parsePublicMemoryProposal({ ...happyProposal(), proposedAt: -1, body: "" })).toEqual({
    ok: false,
    errors: [
      "proposal.proposedAt must be a finite non-negative number",
      "proposal.body must be a bounded control-free non-empty string",
    ],
  });
  expect(
    parsePublicMemoryAuditRecord({
      ...happyAuditRecord(),
      occurredAt: -1,
      summary: "",
      actionKind: "archived",
    }),
  ).toEqual({
    ok: false,
    errors: [
      "auditRecord.occurredAt must be a finite non-negative number",
      "auditRecord.summary must be a bounded control-free non-empty string",
      "auditRecord.action.kind must match auditRecord.actionKind",
    ],
  });
  expect(
    parsePublicMemoryRetrievalRequest({
      schemaVersion: "1",
      requestedAt: -1,
      scopes: [],
      includeArchived: "yes",
      includeSuperseded: "yes",
    }),
  ).toEqual({
    ok: false,
    errors: [
      "retrieval.requestedAt must be a finite non-negative number",
      "retrieval.scopes must be a non-empty array",
      "retrieval.includeArchived must be a boolean when set",
      "retrieval.includeSuperseded must be a boolean when set",
    ],
  });
}

describe("Memory remaining public parsers (#3918)", () => {
  it("preserves operation audit and retrieval identities and optional presence", () => {
    expect(auditMemoryProofCases().map(({ input }) => input.actionKind)).toEqual(
      MEMORY_AUDIT_ACTION_KINDS,
    );
    for (const own of allRemainingMemoryCases()) expectRemainingMemoryIdentity(own);
  });

  it("refuses malformed Memory envelopes with exact owning diagnostics", () => {
    expectRemainingMemoryAccumulation();
    for (const own of allRemainingMemoryCases()) {
      expect
        .soft(own.parse(own.invalid), own.parse.name)
        .toEqual({ ok: false, errors: own.errors });
      for (const input of [undefined, null, 12, "memory", []]) {
        expect(own.parse(input).ok).toBe(false);
      }
    }
  });

  it("retains branded domain result types acknowledgement and array admission", () => {
    assertRemainingInitialMemoryTypes();
    assertRemainingLifecycleMemoryTypes();
    assertRemainingOtherMemoryTypes();
    expect(
      parsePublicMemoryForget(
        lifecycleProofInput({
          forgottenAt: 0,
          reason: "user-request",
          userAcknowledgedDestructive: false,
        }),
      ).ok,
    ).toBe(false);
    const scopes = new Array<unknown>(1);
    expect(
      parsePublicMemoryRetrievalRequest({ schemaVersion: "1", requestedAt: 0, scopes }).ok,
    ).toBe(false);
    const input = { schemaVersion: "1", requestedAt: 0, scopes: [happyScopeUser()] };
    for (const toggle of ["includeArchived", "includeSuperseded"]) {
      for (const value of [undefined, false, true]) {
        const healthy = { ...input, [toggle]: value };
        expect(parsePublicMemoryRetrievalRequest(healthy)).toEqual({ ok: true, value: healthy });
      }
      expect(parsePublicMemoryRetrievalRequest({ ...input, [toggle]: "yes" })).toEqual({
        ok: false,
        errors: [`retrieval.${toggle} must be a boolean when set`],
      });
    }
  });
});
