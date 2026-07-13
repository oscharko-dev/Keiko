import { describe, expect, it } from "vitest";
import { EDITOR_AGENT_TOOL_DEFINITIONS } from "./editor-agent-schemas.js";

const TOOL_NAMES = [
  "editor_list_sessions",
  "editor_snapshot",
  "editor_navigate",
  "editor_navigate_symbol",
  "editor_search_workspace",
  "editor_git_context",
  "editor_propose_edit",
  "editor_propose_changeset",
  "editor_request_verification",
] as const;

function assertFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Object.getOwnPropertyNames(value)) {
    assertFrozen(Reflect.get(value, key));
  }
}

function assertStrictObjects(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Reflect.get(value, "type") === "object") {
    expect(Reflect.get(value, "required")).toBeInstanceOf(Array);
    expect(Reflect.get(value, "additionalProperties")).toBe(false);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    assertStrictObjects(Reflect.get(value, key));
  }
}

describe("EDITOR_AGENT_TOOL_DEFINITIONS", () => {
  it("exposes the governed editor tool set", () => {
    expect(EDITOR_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  // Issue #2214 AC1 — the verification tool has a valid, model-consumable, strict JSON Schema.
  it("exposes editor_request_verification with a bounded verification-kind schema", () => {
    const tool = EDITOR_AGENT_TOOL_DEFINITIONS.find(
      (definition) => definition.name === "editor_request_verification",
    );
    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1 },
        kind: { type: "string", enum: ["test", "targeted-test", "typecheck", "lint", "build"] },
        targetPath: { type: "string", minLength: 1 },
      },
      required: ["sessionId", "kind"],
      additionalProperties: false,
      oneOf: [
        {
          properties: { kind: { const: "targeted-test" } },
          required: ["targetPath"],
        },
        {
          properties: {
            kind: { enum: ["test", "typecheck", "lint", "build"] },
          },
          not: { required: ["targetPath"] },
        },
      ],
    });
  });

  it("exposes bounded symbol-navigation and workspace-search schemas", () => {
    expect(
      EDITOR_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === "editor_navigate_symbol")
        ?.parameters,
    ).toMatchObject({
      required: ["sessionId", "idempotencyKey", "file", "operation", "position"],
      additionalProperties: false,
      properties: {
        operation: {
          enum: [
            "diagnostics",
            "definition",
            "typeDefinition",
            "implementation",
            "references",
            "callHierarchy",
            "inlayHints",
            "renamePrepare",
            "codeActions",
            "signatureHelp",
          ],
        },
      },
    });
    expect(
      EDITOR_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === "editor_search_workspace")
        ?.parameters,
    ).toMatchObject({
      required: ["sessionId", "idempotencyKey", "query", "mode"],
      additionalProperties: false,
      properties: { mode: { enum: ["text", "symbol"] } },
    });
  });

  // Issue #2298 — the read-only git-query tool exposes a bounded, strict, aspect-enum schema.
  it("exposes editor_git_context with a bounded read-only git-aspect schema", () => {
    expect(
      EDITOR_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === "editor_git_context")?.parameters,
    ).toMatchObject({
      required: ["sessionId", "idempotencyKey", "path", "aspects"],
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1 },
        aspects: {
          type: "array",
          items: { type: "string", enum: ["status", "diff", "blame"] },
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
      },
    });
  });

  it("deep-freezes every definition and strict object schema", () => {
    assertFrozen(EDITOR_AGENT_TOOL_DEFINITIONS);
    assertStrictObjects(EDITOR_AGENT_TOOL_DEFINITIONS);
  });

  it("keeps injected authority and generated action ids outside model arguments", () => {
    const schemas = JSON.stringify(EDITOR_AGENT_TOOL_DEFINITIONS);
    expect(schemas).not.toContain("authorityRef");
    expect(schemas).not.toContain("approvalRef");
    expect(schemas).not.toContain("actionId");
  });

  it.each(["editor_navigate", "editor_propose_edit", "editor_propose_changeset"])(
    "requires a model-supplied idempotency key for %s",
    (name) => {
      const definition = EDITOR_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name);
      expect(definition?.parameters).toMatchObject({
        properties: { idempotencyKey: { type: "string", minLength: 1 } },
      });
      const required: unknown = Reflect.get(definition?.parameters ?? {}, "required");
      expect(required).toBeInstanceOf(Array);
      expect(required).toContain("idempotencyKey");
    },
  );

  it("defaults snapshots to content-free text mode", () => {
    const snapshot = EDITOR_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === "editor_snapshot");
    expect(snapshot?.parameters).toMatchObject({
      properties: { textMode: { default: "none" } },
      required: ["sessionId"],
      additionalProperties: false,
    });
  });
});
