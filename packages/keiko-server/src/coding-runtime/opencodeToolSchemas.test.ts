import { describe, expect, it } from "vitest";

import {
  hasExactOpenCodeVisibleToolContract,
  OPENCODE_MODEL_VISIBLE_TOOLS,
} from "./opencodeToolSchemas.js";

function projectedTools(): readonly {
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}[] {
  return OPENCODE_MODEL_VISIBLE_TOOLS.map(({ name, parameters }) => ({
    name,
    parameters:
      name === "keiko_verification"
        ? {
            type: "object",
            properties: {
              verifierId: {
                type: "string",
                enum: ["test", "targeted-test", "typecheck", "lint", "build"],
              },
            },
            required: ["verifierId"],
          }
        : parameters,
  }));
}

describe("OpenCode visible tool contract", () => {
  it("accepts only the pinned v1.17.17 verification projection", () => {
    expect(hasExactOpenCodeVisibleToolContract(projectedTools())).toBe(true);
  });

  it("denies the unprojected source verification schema", () => {
    expect(hasExactOpenCodeVisibleToolContract(OPENCODE_MODEL_VISIBLE_TOOLS)).toBe(false);
  });

  it.each([
    [
      "the verifier enum",
      { type: "object", properties: { verifierId: { type: "string" } }, required: ["verifierId"] },
    ],
    [
      "the required verifier",
      {
        type: "object",
        properties: {
          verifierId: {
            type: "string",
            enum: ["test", "targeted-test", "typecheck", "lint", "build"],
          },
        },
      },
    ],
  ])(
    "denies a projected verification schema missing %s",
    (_name, parameters: Readonly<Record<string, unknown>>) => {
      const tools = projectedTools().map((tool) =>
        tool.name === "keiko_verification" ? { ...tool, parameters } : tool,
      );
      expect(hasExactOpenCodeVisibleToolContract(tools)).toBe(false);
    },
  );
});
