import { describe, expect, it } from "vitest";

import { parseCodingSidecarEventLine } from "./codingSidecarEventParser.js";

const VALID_APPROVAL_EVENT = {
  type: "permission-request",
  expiresAt: "2026-07-07T13:05:00.000Z",
  requestId: "permission-verification",
  kind: "command-execution",
  actionClass: "command-execution",
  reasonCode: "approval-required",
  actionKind: "verification-command",
  scopeLabel: "workspace-scope",
  risk: "low",
  policyReason: "approval-required",
  commandLabel: "typecheck",
  actionId: "session:call",
  idempotencyKey: "session:call",
  approvalId: "session:call",
  approvalDigest: "b".repeat(64),
};

describe("coding sidecar approval proof events", () => {
  it("preserves a structurally valid verification approval binding", () => {
    expect(parseCodingSidecarEventLine(JSON.stringify(VALID_APPROVAL_EVENT))).toEqual({
      status: "parsed",
      event: VALID_APPROVAL_EVENT,
    });
  });

  it.each(["short", "g".repeat(64), "A".repeat(64)])(
    "rejects a malformed approval digest at the parser boundary (%s)",
    (approvalDigest) => {
      expect(
        parseCodingSidecarEventLine(JSON.stringify({ ...VALID_APPROVAL_EVENT, approvalDigest })),
      ).toEqual({ status: "invalid" });
    },
  );
});

// KEIKO-0459: the 318-line parser previously had only two co-located tests and left every
// non-approvalDigest branch — empty line, invalid JSON, unknown event type, health-state
// coverage, permission-request per-field malformed variants, connectorScopes shape,
// counts, and approvalToken absent/malformed/valid — untested. The suite below closes those
// gaps so a change to a field validator is caught at the closest layer.
describe("parseCodingSidecarEventLine framing and unknown types", () => {
  it("returns empty for an empty line", () => {
    expect(parseCodingSidecarEventLine("")).toEqual({ status: "empty" });
  });

  it.each(["not-json", "{", "[", "42", '"raw-string"', "null", "true"])(
    "returns invalid for a non-record or unparseable JSON body (%s)",
    (raw) => {
      expect(parseCodingSidecarEventLine(raw)).toEqual({ status: "invalid" });
    },
  );

  it("returns invalid for a record without a recognized `type`", () => {
    expect(parseCodingSidecarEventLine(JSON.stringify({ type: "unknown", foo: 1 }))).toEqual({
      status: "invalid",
    });
  });
});

describe("parseCodingSidecarEventLine health events", () => {
  it.each(["ready", "busy", "degraded", "stopped"])(
    "accepts a canonical runtime health state (%s)",
    (health) => {
      expect(parseCodingSidecarEventLine(JSON.stringify({ type: "health", health }))).toEqual({
        status: "parsed",
        event: { type: "health", health },
      });
    },
  );

  it("rejects a health event with a non-string or unknown state", () => {
    expect(parseCodingSidecarEventLine(JSON.stringify({ type: "health", health: 42 }))).toEqual({
      status: "invalid",
    });
    expect(
      parseCodingSidecarEventLine(JSON.stringify({ type: "health", health: "unknown-state" })),
    ).toEqual({ status: "invalid" });
    expect(parseCodingSidecarEventLine(JSON.stringify({ type: "health" }))).toEqual({
      status: "invalid",
    });
  });
});

describe("parseCodingSidecarEventLine permission-request required fields", () => {
  const requiredFields: readonly [
    "requestId" | "kind" | "actionClass" | "reasonCode" | "expiresAt",
  ][] = [["requestId"], ["kind"], ["actionClass"], ["reasonCode"], ["expiresAt"]];

  it.each(requiredFields)("rejects a permission-request missing %s", (field) => {
    // Rebuild the record without `field` — spreading and then filtering keeps this
    // no-dynamic-delete clean.
    const record: Record<string, unknown> = Object.fromEntries(
      Object.entries(VALID_APPROVAL_EVENT).filter(([key]) => key !== field),
    );
    expect(parseCodingSidecarEventLine(JSON.stringify(record))).toEqual({ status: "invalid" });
  });

  it("rejects a permission-request with an unknown kind", () => {
    expect(
      parseCodingSidecarEventLine(
        JSON.stringify({ ...VALID_APPROVAL_EVENT, kind: "not-a-real-kind" }),
      ),
    ).toEqual({ status: "invalid" });
  });

  it("rejects a permission-request with an unknown actionClass", () => {
    expect(
      parseCodingSidecarEventLine(
        JSON.stringify({ ...VALID_APPROVAL_EVENT, actionClass: "not-a-real-class" }),
      ),
    ).toEqual({ status: "invalid" });
  });

  it("drops an unknown optional actionKind / scopeLabel / risk / policyReason without failing the whole event", () => {
    const record = {
      ...VALID_APPROVAL_EVENT,
      actionKind: "not-a-real-action",
      risk: "not-a-real-risk",
      policyReason: "not-a-real-reason",
    };
    const result = parseCodingSidecarEventLine(JSON.stringify(record));
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.event.type === "permission-request") {
      expect(result.event).not.toHaveProperty("actionKind");
      expect(result.event).not.toHaveProperty("risk");
      expect(result.event).not.toHaveProperty("policyReason");
    }
  });
});

describe("parseCodingSidecarEventLine connectorScopes shape", () => {
  it("accepts an omitted connectorScopes and preserves an all-canonical array", () => {
    const withCanonical = {
      ...VALID_APPROVAL_EVENT,
      connectorScopes: ["source-control.read", "issue-tracker.read"],
    };
    const result = parseCodingSidecarEventLine(JSON.stringify(withCanonical));
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.event.type === "permission-request") {
      expect(result.event.connectorScopes).toEqual(["source-control.read", "issue-tracker.read"]);
    }
  });

  it("rejects when any entry in connectorScopes is malformed or unknown", () => {
    for (const bad of [
      { connectorScopes: "not-an-array" },
      { connectorScopes: [{}] },
      { connectorScopes: ["atlassian:read", "not-a-real-scope"] },
      { connectorScopes: 42 },
    ]) {
      expect(
        parseCodingSidecarEventLine(JSON.stringify({ ...VALID_APPROVAL_EVENT, ...bad })),
      ).toEqual({ status: "invalid" });
    }
  });
});

describe("parseCodingSidecarEventLine file-edit and verification metadata", () => {
  it("preserves fileCount / addedLines / deletedLines / allowedRelativePaths when valid", () => {
    const record = {
      ...VALID_APPROVAL_EVENT,
      targetPath: "src/a.ts",
      allowedRelativePaths: ["src/a.ts", "src/b.ts"],
      fileCount: 2,
      addedLines: 7,
      deletedLines: 3,
    };
    const result = parseCodingSidecarEventLine(JSON.stringify(record));
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.event.type === "permission-request") {
      expect(result.event.targetPath).toBe("src/a.ts");
      expect(result.event.allowedRelativePaths).toEqual(["src/a.ts", "src/b.ts"]);
      expect(result.event.fileCount).toBe(2);
      expect(result.event.addedLines).toBe(7);
      expect(result.event.deletedLines).toBe(3);
    }
  });

  it("drops negative or non-integer counts and non-string array entries silently", () => {
    const record = {
      ...VALID_APPROVAL_EVENT,
      fileCount: -1,
      addedLines: 1.5,
      deletedLines: Number.NaN,
      allowedRelativePaths: ["src/a.ts", 42],
    };
    const result = parseCodingSidecarEventLine(JSON.stringify(record));
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.event.type === "permission-request") {
      expect(result.event).not.toHaveProperty("fileCount");
      expect(result.event).not.toHaveProperty("addedLines");
      expect(result.event).not.toHaveProperty("deletedLines");
      expect(result.event).not.toHaveProperty("allowedRelativePaths");
    }
  });

  it("preserves passedCount / failedCount / skippedCount when valid", () => {
    const record = {
      ...VALID_APPROVAL_EVENT,
      executable: "npm",
      args: ["run", "typecheck"],
      passedCount: 42,
      failedCount: 0,
      skippedCount: 3,
    };
    const result = parseCodingSidecarEventLine(JSON.stringify(record));
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.event.type === "permission-request") {
      expect(result.event.passedCount).toBe(42);
      expect(result.event.failedCount).toBe(0);
      expect(result.event.skippedCount).toBe(3);
      expect(result.event.args).toEqual(["run", "typecheck"]);
    }
  });
});

describe("parseCodingSidecarEventLine approvalToken three-way distinction", () => {
  const eventWithoutTokenField = { ...VALID_APPROVAL_EVENT };

  it("accepts a permission-request that omits approvalToken entirely (no malformed flag)", () => {
    const result = parseCodingSidecarEventLine(JSON.stringify(eventWithoutTokenField));
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.event.type === "permission-request") {
      expect(result.event).not.toHaveProperty("approvalToken");
      expect(result.event).not.toHaveProperty("approvalTokenMalformed");
    }
  });

  it("flags a permission-request whose approvalToken is present but malformed", () => {
    const result = parseCodingSidecarEventLine(
      JSON.stringify({ ...eventWithoutTokenField, approvalToken: { not: "a-real-claim" } }),
    );
    expect(result.status).toBe("parsed");
    if (result.status === "parsed" && result.event.type === "permission-request") {
      expect(result.event.approvalTokenMalformed).toBe(true);
      expect(result.event.approvalToken).toBeUndefined();
    }
  });
});
