import { describe, expect, it } from "vitest";
import { EDITOR_AGENT_TOOL_DEFINITIONS } from "./editor-agent-schemas.js";

const TOOL_NAMES = [
  "editor_list_sessions",
  "editor_snapshot",
  "editor_navigate",
  "editor_propose_edit",
  "editor_propose_changeset",
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
  it("exposes exactly the five corrected child tools", () => {
    expect(EDITOR_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(TOOL_NAMES);
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
