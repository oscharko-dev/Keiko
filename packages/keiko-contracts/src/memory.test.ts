// Unit tests for the Governed Enterprise Memory Vault contracts (Epic #204, Issue #205).
// Each negative test mutates exactly one field of a known-good fixture so failures point
// precisely at the broken invariant — the same mutation-robust pattern used by
// local-knowledge.test.ts and connected-context.test.ts.

import { describe, it, expect } from "vitest";
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
} from "./memory.js";
import { MEMORY_STRUCTURED_PAYLOAD_KINDS } from "./memory-records.js";
import { MEMORY_AUDIT_INITIATOR_SURFACES, MEMORY_UPDATE_FIELDS } from "./memory-operations.js";
import type {
  MemoryEdgeId,
  MemoryId,
  MemoryReviewerId,
  MemoryStatus,
  ProjectId,
  UserId,
  WorkspaceId,
} from "./memory.js";
import type { MemoryAuditRecordId } from "./memory.js";
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
import { isScopeReachable, validateMemoryRetrievalRequest } from "./memory-retrieval-validation.js";
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

  it("MEMORY_AUDIT_INITIATOR_SURFACES enumerates the six initiator surfaces", () => {
    expect(MEMORY_AUDIT_INITIATOR_SURFACES).toEqual([
      "memory-center",
      "conversation-center",
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
  it("rejected and forgotten are absorbing", () => {
    expect(MEMORY_STATUS_TRANSITIONS.rejected).toEqual([]);
    expect(MEMORY_STATUS_TRANSITIONS.forgotten).toEqual([]);
  });

  it("proposed → accepted, rejected, expired are the only legal next states", () => {
    expect([...MEMORY_STATUS_TRANSITIONS.proposed].sort()).toEqual(
      ["accepted", "expired", "rejected"].sort(),
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

  it("archived can be restored to accepted (non-destructive)", () => {
    expect(MEMORY_STATUS_TRANSITIONS.archived).toContain("accepted");
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
    expect(_crossUserProject).toBeDefined();
    expect(_crossProjectMemory).toBeDefined();
    expect(_bareString).toBeDefined();
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

  it("validateMemoryForget requires the destructive acknowledgement to be true", () => {
    const happy = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      memoryId: "mem-1",
      reviewerId: "rev-1",
      forgottenAt: 0,
      reason: "GDPR",
      userAcknowledgedDestructive: true,
    };
    expect(validateMemoryForget(happy).ok).toBe(true);
    expect(validateMemoryForget({ ...happy, userAcknowledgedDestructive: false }).ok).toBe(false);
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
    expect(looksLikeSecretShape("hello sk-ABCDEFGHIJKLMNOPQRSTUVWX done")).toBe(true);
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
    expect(result.errors).toContain("retrieval.tagsFilter entry must be a non-empty bounded control-free string");
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
    const assigned: import("./memory.js").MemoryScope = userScopeMissingId;
    expect(assigned.kind).toBe("user");
  });

  it("MemoryForget.userAcknowledgedDestructive is pinned to the literal true", () => {
    type Forget = import("./memory-operations.js").MemoryForget;
    const happy: Forget = {
      schemaVersion: "1",
      memoryId: mem("m-1"),
      reviewerId: reviewer("rev-1"),
      forgottenAt: 0,
      reason: "GDPR",
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
  void _a;
  void _b;
};
void _unusedTypeAnchor;
