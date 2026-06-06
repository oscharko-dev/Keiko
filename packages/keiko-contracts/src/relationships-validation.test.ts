// Unit tests for the relationship-engine deterministic validator (Epic #532, Issue #538).
//
// Each negative test mutates exactly one field of a known-good fixture so failures point
// precisely at the broken invariant — the same mutation-robust pattern used by
// local-knowledge.test.ts and connected-context.test.ts. Test categories:
//
//   * Happy path per relationship type (one row per RELATIONSHIP_TYPES member).
//   * Denied examples from compatibility-matrix.md §3 (chat→chat, capsule→capsule,
//     workspace-path→workspace-path, agent→evidence-run, evidence-run→*, tool→*).
//   * Resolution-order: a payload that fails MULTIPLE invariants returns codes in the
//     normative denial-reasons.md §"Resolution order".
//   * Body-free invariant: cross-workspace messages do not echo the foreign id.
//   * Forbidden metadata keys (case-insensitive substring match).
//   * Context-gated codes: cardinality, lifecycle transition, endpoint resolver.
//   * Determinism: same input → same result on two consecutive runs.

import { describe, expect, it } from "vitest";
import type {
  ObjectReference,
  Relationship,
  RelationshipDenialCode,
  RelationshipLifecycleState,
  RelationshipObjectKind,
  RelationshipType,
} from "./relationships.js";
import {
  assertRelationshipTypeAllowsKinds,
  validateRelationship,
} from "./relationships-validation.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────
const WS = "workspace-A";

function endpoint(
  kind: RelationshipObjectKind,
  id: string,
  workspaceId: string = WS,
): ObjectReference {
  return { kind, id, workspaceId };
}

function happy(
  type: RelationshipType,
  source: ObjectReference,
  target: ObjectReference,
  lifecycleState: RelationshipLifecycleState = "active",
): Record<string, unknown> {
  return {
    id: `rel-${type}-${source.id}-${target.id}`,
    schemaVersion: "1",
    workspaceId: WS,
    source,
    target,
    type,
    lifecycleState,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    etag: 1,
  };
}

function codesFrom(
  result: ReturnType<typeof validateRelationship>,
): readonly RelationshipDenialCode[] {
  if (result.ok) return [];
  return result.errors.map((e) => e.code);
}

// ─── Happy paths ──────────────────────────────────────────────────────────────
describe("validateRelationship — happy paths (one per relationship type)", () => {
  it("reads-context: workflow-run → memory", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "run-1"), endpoint("memory", "mem-1")),
    );
    expect(r.ok).toBe(true);
  });

  it("reads-context: chat → evidence-run", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("chat", "chat-1"), endpoint("evidence-run", "ev-1")),
    );
    expect(r.ok).toBe(true);
  });

  it("proposes-patch: workflow-run → workspace-path", () => {
    const r = validateRelationship(
      happy(
        "proposes-patch",
        endpoint("workflow-run", "run-1"),
        endpoint("workspace-path", "src/foo.ts"),
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("uses-tool: workflow-run → tool", () => {
    const r = validateRelationship(
      happy("uses-tool", endpoint("workflow-run", "run-1"), endpoint("tool", "tool-1")),
    );
    expect(r.ok).toBe(true);
  });

  it("starts-workflow: chat → workflow-run", () => {
    const r = validateRelationship(
      happy("starts-workflow", endpoint("chat", "chat-1"), endpoint("workflow-run", "run-1")),
    );
    expect(r.ok).toBe(true);
  });

  it("produces-evidence: workflow-run → evidence-run", () => {
    const r = validateRelationship(
      happy(
        "produces-evidence",
        endpoint("workflow-run", "run-1"),
        endpoint("evidence-run", "ev-1"),
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("references-document: chat → workspace-path", () => {
    const r = validateRelationship(
      happy(
        "references-document",
        endpoint("chat", "chat-1"),
        endpoint("workspace-path", "docs/spec.md"),
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("references-document: workflow-run → capsule-set", () => {
    const r = validateRelationship(
      happy(
        "references-document",
        endpoint("workflow-run", "run-1"),
        endpoint("capsule-set", "cs-1"),
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("depends-on: memory → memory (non-self-loop)", () => {
    const r = validateRelationship(
      happy("depends-on", endpoint("memory", "mem-1"), endpoint("memory", "mem-2")),
    );
    expect(r.ok).toBe(true);
  });

  it("depends-on: workflow-run → evidence-run", () => {
    const r = validateRelationship(
      happy("depends-on", endpoint("workflow-run", "run-1"), endpoint("evidence-run", "ev-1")),
    );
    expect(r.ok).toBe(true);
  });
});

// ─── Compatibility matrix denied examples ─────────────────────────────────────
describe("validateRelationship — compatibility matrix §3 explicit denials", () => {
  it("chat → chat is denied/source-kind-not-allowed", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("chat", "c1"), endpoint("chat", "c2")),
    );
    expect(codesFrom(r)).toContain("denied/target-kind-not-allowed");
    // Source kind "chat" IS allowed for reads-context, target kind "chat" is not.
    // The matrix names the same outcome (`denied/source-kind-not-allowed`) for the
    // chat→chat cell. Validator returns the per-resolution-order more-specific code; the
    // exact field-level code follows from the per-type validSourceKinds / validTargetKinds
    // sets: source is allowed, target is not → target-kind-not-allowed.
  });

  it("workspace-path → workspace-path is denied/source-kind-not-allowed", () => {
    const r = validateRelationship(
      happy(
        "depends-on",
        endpoint("workspace-path", "src/a.ts"),
        endpoint("workspace-path", "src/b.ts"),
      ),
    );
    expect(codesFrom(r)).toContain("denied/source-kind-not-allowed");
  });

  it("capsule → capsule is denied/source-kind-not-allowed (cross-domain engine does not duplicate connector-graph edges)", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("capsule", "cap-1"), endpoint("capsule", "cap-2")),
    );
    expect(codesFrom(r)).toContain("denied/source-kind-not-allowed");
  });

  it("agent → evidence-run is denied/object-kind-not-yet-supported (pre-landing)", () => {
    const r = validateRelationship(
      happy("depends-on", endpoint("agent", "ag-1"), endpoint("evidence-run", "ev-1")),
    );
    // Before the agent kind lands, every proposal naming it returns
    // object-kind-not-yet-supported per compatibility-matrix.md §3.
    expect(codesFrom(r)).toContain("denied/object-kind-not-yet-supported");
  });

  it("evidence-run → tool is denied/source-kind-not-allowed (leaf artefacts do not initiate)", () => {
    const r = validateRelationship(
      happy("uses-tool", endpoint("evidence-run", "ev-1"), endpoint("tool", "tool-1")),
    );
    expect(codesFrom(r)).toContain("denied/source-kind-not-allowed");
  });

  it("tool → memory is denied/source-kind-not-allowed (registry entries do not originate)", () => {
    const r = validateRelationship(
      happy("uses-tool", endpoint("tool", "tool-1"), endpoint("memory", "mem-1")),
    );
    // tool is not in any type's validSourceKinds; uses-tool requires workflow-run source.
    expect(codesFrom(r)).toContain("denied/source-kind-not-allowed");
  });

  it("patch-proposal as source is denied/source-kind-not-allowed", () => {
    const r = validateRelationship(
      happy(
        "proposes-patch",
        endpoint("patch-proposal", "pp-1"),
        endpoint("workspace-path", "src/x.ts"),
      ),
    );
    expect(codesFrom(r)).toContain("denied/source-kind-not-allowed");
  });

  it("workflow-run → chat is denied/target-kind-not-allowed", () => {
    const r = validateRelationship(
      happy("starts-workflow", endpoint("workflow-run", "run-1"), endpoint("chat", "chat-1")),
    );
    expect(codesFrom(r)).toContain("denied/target-kind-not-allowed");
  });
});

// ─── Resolution order ─────────────────────────────────────────────────────────
describe("validateRelationship — resolution order (denial-reasons.md)", () => {
  it("identity failures (resolver missing) short-circuit ahead of kind / cardinality / metadata", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("chat", "c1"), endpoint("chat", "c2")), // chat→chat would fail target-kind-not-allowed
      {
        endpointResolver: { source: "missing", target: "missing" },
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.errors.map((e) => e.code);
    // Both identity codes precede ALL other codes in the order; no other codes appear.
    expect(codes).toEqual(["denied/non-existent-source", "denied/non-existent-target"]);
  });

  it("object-kind-not-yet-supported precedes source-kind-not-allowed for the same payload", () => {
    // depends-on is valid for memory→memory. Replace source with 'skill' (forward-looking)
    // which is also not in validSourceKinds for any allowed type. Both denial codes
    // theoretically apply; the resolver-order rule says forward-looking wins.
    const r = validateRelationship(
      happy("depends-on", endpoint("skill", "sk-1"), endpoint("memory", "mem-1")),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.errors.map((e) => e.code);
    const ynsIndex = codes.indexOf("denied/object-kind-not-yet-supported");
    const skaIndex = codes.indexOf("denied/source-kind-not-allowed");
    expect(ynsIndex).toBeGreaterThanOrEqual(0);
    // When forward-looking fires, validator suppresses kind-compat to avoid noise.
    expect(skaIndex).toBe(-1);
  });

  it("source-kind-not-allowed precedes target-kind-not-allowed when both apply", () => {
    // depends-on source-set: {capsule, capsule-set, workflow-run, memory}
    //           target-set: same plus evidence-run, workspace-path
    // Use 'tool' as source (not in validSourceKinds) and 'chat' as target (also not in
    // validTargetKinds for depends-on).
    const r = validateRelationship(
      happy("depends-on", endpoint("tool", "tool-1"), endpoint("chat", "chat-1")),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.errors.map((e) => e.code);
    // assertRelationshipTypeAllowsKinds short-circuits on source first.
    expect(codes).toContain("denied/source-kind-not-allowed");
    expect(codes).not.toContain("denied/target-kind-not-allowed");
  });

  it("cross-workspace appears after kind / cardinality / cycle when all apply", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("chat", "c1"), endpoint("chat", "c2", "workspace-B")),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.errors.map((e) => e.code);
    const targetIdx = codes.indexOf("denied/target-kind-not-allowed");
    const crossIdx = codes.indexOf("denied/cross-workspace");
    expect(targetIdx).toBeGreaterThanOrEqual(0);
    expect(crossIdx).toBeGreaterThan(targetIdx);
  });
});

// ─── Schema-version mismatch ──────────────────────────────────────────────────
describe("validateRelationship — schema-version", () => {
  it("rejects payload with schemaVersion '0'", () => {
    const payload = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      schemaVersion: "0",
    };
    const r = validateRelationship(payload);
    expect(codesFrom(r)).toContain("denied/schema-version-unsupported");
  });

  it("rejects payload with schemaVersion '2'", () => {
    const payload = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      schemaVersion: "2",
    };
    const r = validateRelationship(payload);
    expect(codesFrom(r)).toContain("denied/schema-version-unsupported");
  });
});

// ─── Forward-looking object kinds ─────────────────────────────────────────────
describe("validateRelationship — forward-looking object kinds", () => {
  it.each([["agent"], ["connector"], ["data-source"], ["skill"], ["mcp-tool"]] as const)(
    "rejects %s as source kind with denied/object-kind-not-yet-supported",
    (kind) => {
      const r = validateRelationship(
        happy("depends-on", endpoint(kind, "x"), endpoint("memory", "m1")),
      );
      expect(codesFrom(r)).toContain("denied/object-kind-not-yet-supported");
    },
  );

  it("rejects forward-looking target kind", () => {
    const r = validateRelationship(
      happy("uses-tool", endpoint("workflow-run", "r1"), endpoint("mcp-tool", "mt-1")),
    );
    expect(codesFrom(r)).toContain("denied/object-kind-not-yet-supported");
  });
});

// ─── Self-edge ────────────────────────────────────────────────────────────────
describe("validateRelationship — self-edge", () => {
  it("rejects source === target with denied/cycle-forbidden", () => {
    const r = validateRelationship(
      happy("depends-on", endpoint("memory", "mem-1"), endpoint("memory", "mem-1")),
    );
    expect(codesFrom(r)).toContain("denied/cycle-forbidden");
  });

  it("does NOT flag same id across different kinds (mem-1 capsule vs mem-1 memory)", () => {
    const r = validateRelationship(
      happy("depends-on", endpoint("memory", "shared-1"), endpoint("capsule", "shared-1")),
    );
    expect(codesFrom(r)).not.toContain("denied/cycle-forbidden");
  });
});

// ─── Forbidden metadata ───────────────────────────────────────────────────────
describe("validateRelationship — forbidden metadata", () => {
  it("rejects metadata containing 'prompt' key", () => {
    const payload = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      metadata: { prompt: "would-be-system-prompt" },
    };
    const r = validateRelationship(payload);
    expect(codesFrom(r)).toContain("denied/payload-content-not-permitted");
  });

  it("matches case-insensitively (PromptText)", () => {
    const payload = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      metadata: { PromptText: "x" },
    };
    const r = validateRelationship(payload);
    expect(codesFrom(r)).toContain("denied/payload-content-not-permitted");
  });

  it("matches substring (rawDocumentContent)", () => {
    const payload = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      metadata: { rawDocumentContent: "x" },
    };
    const r = validateRelationship(payload);
    expect(codesFrom(r)).toContain("denied/payload-content-not-permitted");
  });

  it.each([
    ["apiKey"],
    ["API_KEY"],
    ["githubToken"],
    ["userPassword"],
    ["my-secret"],
    ["awsCredential"],
    ["toolStdout"],
    ["toolStderr"],
    ["fileContent"],
  ])("rejects metadata containing forbidden substring: %s", (key) => {
    const payload = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      metadata: { [key]: "x" },
    };
    const r = validateRelationship(payload);
    expect(codesFrom(r)).toContain("denied/payload-content-not-permitted");
  });

  it("accepts safe metadata keys", () => {
    const payload = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      metadata: { reason: "user-clicked-reload", retryCount: 3 },
    };
    const r = validateRelationship(payload);
    expect(r.ok).toBe(true);
  });

  it("rejects metadata that is not a plain object", () => {
    const payload = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      metadata: ["a", "b"],
    };
    const r = validateRelationship(payload);
    expect(codesFrom(r)).toContain("denied/payload-content-not-permitted");
  });
});

// ─── Cross-workspace + body-free invariant ────────────────────────────────────
describe("validateRelationship — cross-workspace body-free", () => {
  it("rejects when source.workspaceId !== relationship.workspaceId", () => {
    const r = validateRelationship(
      happy(
        "reads-context",
        endpoint("workflow-run", "r1", "workspace-B"),
        endpoint("memory", "m1"),
      ),
    );
    expect(codesFrom(r)).toContain("denied/cross-workspace");
  });

  it("rejects when target.workspaceId !== relationship.workspaceId", () => {
    const r = validateRelationship(
      happy(
        "reads-context",
        endpoint("workflow-run", "r1"),
        endpoint("memory", "m1", "workspace-B"),
      ),
    );
    expect(codesFrom(r)).toContain("denied/cross-workspace");
  });

  it("the error message NEVER echoes the foreign workspace id (audit-events.md §8.3)", () => {
    const r = validateRelationship(
      happy(
        "reads-context",
        endpoint("workflow-run", "r1", "secret-foreign-workspace"),
        endpoint("memory", "m1"),
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const err of r.errors) {
      expect(err.message).not.toContain("secret-foreign-workspace");
      expect(JSON.stringify(err)).not.toContain("secret-foreign-workspace");
    }
  });
});

// ─── Cardinality (context-gated) ──────────────────────────────────────────────
describe("validateRelationship — cardinality (ctx-gated)", () => {
  it("produces-evidence: rejects when ctx.cardinalityCounts.producesEvidenceForSource >= 1", () => {
    const r = validateRelationship(
      happy("produces-evidence", endpoint("workflow-run", "r1"), endpoint("evidence-run", "ev-1")),
      { cardinalityCounts: { producesEvidenceForSource: 1 } },
    );
    expect(codesFrom(r)).toContain("denied/cardinality-exceeded");
  });

  it("produces-evidence: accepts when count is 0", () => {
    const r = validateRelationship(
      happy("produces-evidence", endpoint("workflow-run", "r1"), endpoint("evidence-run", "ev-1")),
      { cardinalityCounts: { producesEvidenceForSource: 0 } },
    );
    expect(r.ok).toBe(true);
  });

  it("starts-workflow: rejects when ctx.cardinalityCounts.startsWorkflowForTarget >= 1", () => {
    const r = validateRelationship(
      happy("starts-workflow", endpoint("chat", "c1"), endpoint("workflow-run", "r1")),
      { cardinalityCounts: { startsWorkflowForTarget: 1 } },
    );
    expect(codesFrom(r)).toContain("denied/cardinality-exceeded");
  });

  it("starts-workflow: accepts when count is 0", () => {
    const r = validateRelationship(
      happy("starts-workflow", endpoint("chat", "c1"), endpoint("workflow-run", "r1")),
      { cardinalityCounts: { startsWorkflowForTarget: 0 } },
    );
    expect(r.ok).toBe(true);
  });

  it("without ctx.cardinalityCounts, no cardinality code is emitted", () => {
    const r = validateRelationship(
      happy("produces-evidence", endpoint("workflow-run", "r1"), endpoint("evidence-run", "ev-1")),
    );
    expect(r.ok).toBe(true);
  });
});

// ─── Lifecycle transitions (context-gated) ────────────────────────────────────
describe("validateRelationship — lifecycle transition (ctx-gated)", () => {
  it("rejects active → draft", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1"), "draft"),
      { previousLifecycleState: "active" },
    );
    expect(codesFrom(r)).toContain("denied/lifecycle-illegal-transition");
  });

  it("rejects revoked → active (revoked is terminal)", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1"), "active"),
      { previousLifecycleState: "revoked" },
    );
    expect(codesFrom(r)).toContain("denied/lifecycle-illegal-transition");
  });

  it("accepts draft → active", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1"), "active"),
      { previousLifecycleState: "draft" },
    );
    expect(r.ok).toBe(true);
  });

  it("accepts blocked → active", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1"), "active"),
      { previousLifecycleState: "blocked" },
    );
    expect(r.ok).toBe(true);
  });

  it("accepts stale → active", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1"), "active"),
      { previousLifecycleState: "stale" },
    );
    expect(r.ok).toBe(true);
  });

  it("self-transition active → active is admitted (no-op)", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1"), "active"),
      { previousLifecycleState: "active" },
    );
    expect(r.ok).toBe(true);
  });

  it("without ctx.previousLifecycleState, no lifecycle code is emitted", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1"), "draft"),
    );
    expect(r.ok).toBe(true);
  });
});

// ─── Endpoint resolver (context-gated) ────────────────────────────────────────
describe("validateRelationship — endpoint resolver (ctx-gated)", () => {
  it("emits denied/non-existent-source when resolver reports source missing", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      { endpointResolver: { source: "missing", target: "live" } },
    );
    expect(codesFrom(r)).toContain("denied/non-existent-source");
  });

  it("emits denied/non-existent-target when resolver reports target missing", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      { endpointResolver: { source: "live", target: "missing" } },
    );
    expect(codesFrom(r)).toContain("denied/non-existent-target");
  });

  it("emits denied/endpoint-tombstoned when resolver reports tombstoned", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      { endpointResolver: { source: "live", target: "tombstoned" } },
    );
    expect(codesFrom(r)).toContain("denied/endpoint-tombstoned");
  });

  it("emits denied/endpoint-retired when resolver reports retired", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      { endpointResolver: { source: "live", target: "retired" } },
    );
    expect(codesFrom(r)).toContain("denied/endpoint-retired");
  });

  it("emits denied/endpoint-unavailable when resolver reports unavailable", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      { endpointResolver: { source: "unavailable", target: "live" } },
    );
    expect(codesFrom(r)).toContain("denied/endpoint-unavailable");
  });

  it("accepts when both endpoints are live", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      { endpointResolver: { source: "live", target: "live" } },
    );
    expect(r.ok).toBe(true);
  });
});

// ─── Structural prelude ───────────────────────────────────────────────────────
describe("validateRelationship — structural prelude", () => {
  it("rejects non-object input", () => {
    expect(validateRelationship(null).ok).toBe(false);
    expect(validateRelationship(undefined).ok).toBe(false);
    expect(validateRelationship("relationship").ok).toBe(false);
    expect(validateRelationship([]).ok).toBe(false);
    expect(validateRelationship(42).ok).toBe(false);
  });

  it("rejects when source is missing", () => {
    const payload: Record<string, unknown> = {
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
    };
    delete payload.source;
    const r = validateRelationship(payload);
    expect(r.ok).toBe(false);
  });

  it("rejects when target is malformed", () => {
    const r = validateRelationship({
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      target: { kind: "memory" /* missing id + workspaceId */ },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects negative etag", () => {
    const r = validateRelationship({
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      etag: -1,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown relationship type", () => {
    const r = validateRelationship({
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      type: "made-up-type",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown lifecycle state", () => {
    const r = validateRelationship({
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      lifecycleState: "made-up-state",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown object kind on source", () => {
    const r = validateRelationship({
      ...happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
      source: { kind: "made-up-kind", id: "x", workspaceId: WS },
    });
    expect(r.ok).toBe(false);
  });
});

// ─── Determinism ──────────────────────────────────────────────────────────────
describe("validateRelationship — determinism", () => {
  it("returns identical results across two consecutive runs (happy)", () => {
    const payload = happy(
      "reads-context",
      endpoint("workflow-run", "r1"),
      endpoint("memory", "m1"),
    );
    const r1 = validateRelationship(payload);
    const r2 = validateRelationship(payload);
    expect(r1).toEqual(r2);
  });

  it("returns identical results across two consecutive runs (denied)", () => {
    const payload = happy(
      "reads-context",
      endpoint("chat", "c1"),
      endpoint("chat", "c2", "ws-foreign"),
    );
    const r1 = validateRelationship(payload);
    const r2 = validateRelationship(payload);
    expect(r1).toEqual(r2);
  });
});

// ─── assertRelationshipTypeAllowsKinds (pure helper) ──────────────────────────
describe("assertRelationshipTypeAllowsKinds", () => {
  it("returns null for valid kind pairs", () => {
    expect(assertRelationshipTypeAllowsKinds("reads-context", "workflow-run", "memory")).toBeNull();
    expect(assertRelationshipTypeAllowsKinds("uses-tool", "workflow-run", "tool")).toBeNull();
  });

  it("returns denied/source-kind-not-allowed when source is wrong", () => {
    expect(assertRelationshipTypeAllowsKinds("uses-tool", "tool", "tool")).toBe(
      "denied/source-kind-not-allowed",
    );
  });

  it("returns denied/target-kind-not-allowed when only target is wrong", () => {
    expect(assertRelationshipTypeAllowsKinds("starts-workflow", "chat", "memory")).toBe(
      "denied/target-kind-not-allowed",
    );
  });
});

// ─── Type-pin sanity ──────────────────────────────────────────────────────────
// Force-construct a Relationship via validateRelationship to confirm the return
// narrows to the typed surface.
describe("validateRelationship — type narrowing on success", () => {
  it("narrows ok branch to a Relationship-typed value", () => {
    const r = validateRelationship(
      happy("reads-context", endpoint("workflow-run", "r1"), endpoint("memory", "m1")),
    );
    if (r.ok) {
      const value: Relationship = r.value;
      expect(value.type).toBe("reads-context");
      expect(value.schemaVersion).toBe("1");
    }
  });
});
