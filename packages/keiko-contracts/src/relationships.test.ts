// Frozen-table contract tests for the relationship-engine type surface (Epic #532,
// Issue #538). These tests pin the closed-set tables against the taxonomy.md /
// compatibility-matrix.md / denial-reasons.md normative documents so a future edit that
// drops a member or reorders a tuple cannot land silently.

import { describe, expect, it } from "vitest";
import {
  RELATIONSHIP_ACTIVITY_STATES,
  RELATIONSHIP_DENIAL_CODES,
  RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS,
  RELATIONSHIP_LIFECYCLE_STATES,
  RELATIONSHIP_OBJECT_KINDS,
  RELATIONSHIP_SCHEMA_VERSION,
  RELATIONSHIP_SUPPORTED_OBJECT_KINDS,
  RELATIONSHIP_TYPE_DEFINITIONS,
  RELATIONSHIP_TYPES,
} from "./relationships.js";

describe("schema version", () => {
  it("is the literal '1'", () => {
    // A breaking change introduces a NEW literal ("2") and an ADR amendment; never
    // mutate "1" (taxonomy.md §3.2).
    expect(RELATIONSHIP_SCHEMA_VERSION).toBe("1");
  });
});

describe("RELATIONSHIP_OBJECT_KINDS", () => {
  it("contains exactly the 14 taxonomy object kinds", () => {
    expect(RELATIONSHIP_OBJECT_KINDS).toHaveLength(14);
    expect(new Set(RELATIONSHIP_OBJECT_KINDS).size).toBe(14);
  });

  it("contains every kind referenced by taxonomy.md §4", () => {
    const required = [
      "memory",
      "capsule",
      "capsule-set",
      "workflow-run",
      "evidence-run",
      "workspace-path",
      "chat",
      "tool",
      "patch-proposal",
      "agent",
      "connector",
      "data-source",
      "skill",
      "mcp-tool",
    ];
    for (const kind of required) {
      expect(RELATIONSHIP_OBJECT_KINDS).toContain(kind);
    }
  });
});

describe("RELATIONSHIP_SUPPORTED_OBJECT_KINDS", () => {
  it("is a strict subset of RELATIONSHIP_OBJECT_KINDS", () => {
    const all = new Set<string>(RELATIONSHIP_OBJECT_KINDS);
    for (const kind of RELATIONSHIP_SUPPORTED_OBJECT_KINDS) {
      expect(all.has(kind)).toBe(true);
    }
    expect(RELATIONSHIP_SUPPORTED_OBJECT_KINDS.length).toBeLessThan(
      RELATIONSHIP_OBJECT_KINDS.length,
    );
  });

  it("withholds exactly the five forward-looking kinds (taxonomy.md §4.2)", () => {
    const supported = new Set<string>(RELATIONSHIP_SUPPORTED_OBJECT_KINDS);
    const forwardLooking = ["agent", "connector", "data-source", "skill", "mcp-tool"];
    for (const kind of forwardLooking) {
      expect(supported.has(kind)).toBe(false);
    }
  });
});

describe("RELATIONSHIP_TYPES", () => {
  it("contains the seven taxonomy types in the taxonomy.md §5.8 order", () => {
    expect([...RELATIONSHIP_TYPES]).toEqual([
      "reads-context",
      "proposes-patch",
      "uses-tool",
      "starts-workflow",
      "produces-evidence",
      "references-document",
      "depends-on",
    ]);
  });
});

describe("RELATIONSHIP_LIFECYCLE_STATES", () => {
  it("contains the seven lifecycle states (lifecycle.md §1)", () => {
    expect([...RELATIONSHIP_LIFECYCLE_STATES]).toEqual([
      "draft",
      "active",
      "archived",
      "superseded",
      "revoked",
      "blocked",
      "stale",
    ]);
  });
});

describe("RELATIONSHIP_ACTIVITY_STATES", () => {
  it("contains the nine activity states (activity-state.md §2)", () => {
    expect([...RELATIONSHIP_ACTIVITY_STATES]).toEqual([
      "inactive",
      "queued",
      "active",
      "processing",
      "completed",
      "failed",
      "blocked",
      "degraded",
      "high-throughput",
    ]);
  });
});

describe("RELATIONSHIP_DENIAL_CODES", () => {
  it("contains the 18 denial codes in the denial-reasons.md resolution order", () => {
    // The tuple order MUST match the normative "Resolution order" so the validator
    // and reviewers can keep the two views in lock-step.
    expect([...RELATIONSHIP_DENIAL_CODES]).toEqual([
      "denied/non-existent-source",
      "denied/non-existent-target",
      "denied/object-kind-not-yet-supported",
      "denied/source-kind-not-allowed",
      "denied/target-kind-not-allowed",
      "denied/kind-incompatible",
      "denied/cardinality-exceeded",
      "denied/cycle-forbidden",
      "denied/cross-workspace",
      "denied/path-not-contained",
      "denied/denied-by-deny-list",
      "denied/lifecycle-illegal-transition",
      "denied/endpoint-tombstoned",
      "denied/endpoint-retired",
      "denied/endpoint-unavailable",
      "denied/payload-content-not-permitted",
      "denied/authority-insufficient",
      "denied/schema-version-unsupported",
    ]);
  });

  it("has 18 unique entries", () => {
    expect(new Set(RELATIONSHIP_DENIAL_CODES).size).toBe(RELATIONSHIP_DENIAL_CODES.length);
  });
});

describe("RELATIONSHIP_TYPE_DEFINITIONS", () => {
  it("has an entry for every relationship type", () => {
    for (const type of RELATIONSHIP_TYPES) {
      expect(RELATIONSHIP_TYPE_DEFINITIONS[type]).toBeDefined();
      expect(RELATIONSHIP_TYPE_DEFINITIONS[type].id).toBe(type);
    }
  });

  it("has no entries outside RELATIONSHIP_TYPES", () => {
    const typeSet = new Set<string>(RELATIONSHIP_TYPES);
    for (const id of Object.keys(RELATIONSHIP_TYPE_DEFINITIONS)) {
      expect(typeSet.has(id)).toBe(true);
    }
  });

  it("every validSourceKinds entry is in RELATIONSHIP_OBJECT_KINDS", () => {
    const allKinds = new Set<string>(RELATIONSHIP_OBJECT_KINDS);
    for (const def of Object.values(RELATIONSHIP_TYPE_DEFINITIONS)) {
      for (const kind of def.validSourceKinds) {
        expect(allKinds.has(kind)).toBe(true);
      }
    }
  });

  it("every validTargetKinds entry is in RELATIONSHIP_OBJECT_KINDS", () => {
    const allKinds = new Set<string>(RELATIONSHIP_OBJECT_KINDS);
    for (const def of Object.values(RELATIONSHIP_TYPE_DEFINITIONS)) {
      for (const kind of def.validTargetKinds) {
        expect(allKinds.has(kind)).toBe(true);
      }
    }
  });

  it("pins the compatibility matrix anchor rows from compatibility-matrix.md §4", () => {
    // One positive case per type, lifted from the matrix.
    const readsContext = RELATIONSHIP_TYPE_DEFINITIONS["reads-context"];
    expect(readsContext.validSourceKinds).toContain("workflow-run");
    expect(readsContext.validTargetKinds).toContain("memory");

    const proposesPatch = RELATIONSHIP_TYPE_DEFINITIONS["proposes-patch"];
    expect(proposesPatch.validSourceKinds).toEqual(["workflow-run"]);
    expect(proposesPatch.validTargetKinds).toContain("workspace-path");
    expect(proposesPatch.validTargetKinds).toContain("patch-proposal");

    const usesTool = RELATIONSHIP_TYPE_DEFINITIONS["uses-tool"];
    expect(usesTool.validSourceKinds).toEqual(["workflow-run"]);
    expect(usesTool.validTargetKinds).toContain("tool");

    const startsWorkflow = RELATIONSHIP_TYPE_DEFINITIONS["starts-workflow"];
    expect(startsWorkflow.validSourceKinds).toContain("chat");
    expect(startsWorkflow.validSourceKinds).toContain("workflow-run");
    expect(startsWorkflow.validTargetKinds).toEqual(["workflow-run"]);
    expect(startsWorkflow.cardinality).toBe("1:N");

    const producesEvidence = RELATIONSHIP_TYPE_DEFINITIONS["produces-evidence"];
    expect(producesEvidence.validSourceKinds).toEqual(["workflow-run"]);
    expect(producesEvidence.validTargetKinds).toEqual(["evidence-run"]);
    expect(producesEvidence.cardinality).toBe("1:1");

    const referencesDocument = RELATIONSHIP_TYPE_DEFINITIONS["references-document"];
    expect(referencesDocument.validSourceKinds).toContain("chat");
    expect(referencesDocument.validTargetKinds).toContain("workspace-path");
    expect(referencesDocument.validTargetKinds).toContain("capsule");

    const dependsOn = RELATIONSHIP_TYPE_DEFINITIONS["depends-on"];
    expect(dependsOn.validSourceKinds).toEqual([
      "capsule",
      "capsule-set",
      "workflow-run",
      "memory",
    ]);
    expect(dependsOn.validTargetKinds).toEqual([
      "capsule",
      "capsule-set",
      "workflow-run",
      "memory",
      "evidence-run",
      "workspace-path",
    ]);
  });
});

describe("RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS", () => {
  it("covers the audit-events.md §8.3 FORBIDDEN-field categories", () => {
    // Each substring is lowercase and chosen so a case-insensitive substring scan
    // catches the obvious accidental key names ("prompt", "promptText", "rawPrompt",
    // "apiKey", "API_KEY", "githubToken", etc.).
    const set = new Set<string>(RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS);
    expect(set.has("prompt")).toBe(true);
    expect(set.has("documentcontent")).toBe(true);
    expect(set.has("secret")).toBe(true);
    expect(set.has("apikey")).toBe(true);
    expect(set.has("token")).toBe(true);
  });
});
