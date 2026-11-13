import { describe, expect, it } from "vitest";
import type { CatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { schemaMismatchGuidance, toolSchemaCorrectionMessage } from "./toolSchemaCorrection.js";

const NONE = {
  missingRequired: [],
  invalidPaths: [],
  unexpectedPropertyCount: 0,
  droppedPathCount: 0,
};
function repair(
  shape: Partial<CatalogSchemaMismatch>,
): Parameters<typeof schemaMismatchGuidance>[0] {
  return { toolCallId: "call-1", offeredAlias: "jira_x", shape: { ...NONE, ...shape } };
}

describe("schema correction guidance", () => {
  it("keeps the managed-runtime rule that every declared property is required", () => {
    expect(
      schemaMismatchGuidance(repair({ missingRequired: ["caseSensitive", "includeGlobs"] })),
    ).toBe(
      " Missing required properties: caseSensitive, includeGlobs. Every property the schema declares is required; pass an explicit value such as false or [] when a property does not apply.",
    );
  });

  // #4357: an external JSON Schema declares optional properties. Telling a model that every
  // property is required and to pass `false` made it send `expectAbsent: false`, which a guarded
  // Jira write refuses.
  it("never claims every property is required for an external schema", () => {
    const text = schemaMismatchGuidance(
      repair({ missingRequired: ["issueIdOrKey"], optionalProperties: true }),
    );
    expect(text).toBe(" Missing required properties: issueIdOrKey.");
  });

  it("states the exclusive choice instead of one alternative as missing", () => {
    const text = schemaMismatchGuidance(
      repair({
        missingRequired: ["expectedValueNodes"],
        optionalProperties: true,
        choice: { kind: "exactly-one", alternatives: [["expectedValueNodes"], ["expectAbsent"]] },
      }),
    );
    expect(text).toBe(" Supply exactly one of: expectedValueNodes, expectAbsent; omit the others.");
    const either = schemaMismatchGuidance(
      repair({
        optionalProperties: true,
        choice: { kind: "at-least-one", alternatives: [["a", "b"], ["c"]] },
      }),
    );
    expect(either).toBe(" Supply at least one of: a and b, c.");
  });

  it("names the declared properties beside the count of undeclared ones", () => {
    const text = schemaMismatchGuidance(
      repair({
        unexpectedPropertyCount: 2,
        optionalProperties: true,
        declaredProperties: ["issueIdOrKey", "startAt", "maxResults"],
      }),
    );
    expect(text).toBe(
      " 2 properties are not declared by the schema and must be removed; it declares only: issueIdOrKey, startAt, maxResults.",
    );
    expect(schemaMismatchGuidance(repair({ unexpectedPropertyCount: 1 }))).toBe(
      " 1 property is not declared by the schema and must be removed.",
    );
  });

  it("states the values a constant or enumerated property accepts", () => {
    const text = schemaMismatchGuidance(
      repair({
        invalidPaths: ["expectAbsent"],
        optionalProperties: true,
        allowed: { path: "expectAbsent", values: [true] },
      }),
    );
    expect(text).toBe(
      " Properties whose value does not match the schema: expectAbsent. The value of expectAbsent must be one of: true.",
    );
    expect(toolSchemaCorrectionMessage(repair({ invalidPaths: ["x"] }))).toContain(
      "Retry tool call call-1 for offered tool jira_x",
    );
  });
});
