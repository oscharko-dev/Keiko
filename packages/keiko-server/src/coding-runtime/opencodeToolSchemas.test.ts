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

  it("requires strict unified headers or the bounded single-file raw-index fallback", () => {
    const edit = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_changeset_edit");
    const pattern = edit?.parameters.properties.changeset.properties.patch.pattern;
    if (pattern === undefined) throw new Error("Expected changeset patch pattern.");
    const accepted = new RegExp(pattern, "u");

    expect(accepted.test("--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n")).toBe(true);
    expect(
      accepted.test(
        "diff --git a/README.md b/README.md\nindex 1d9d46e..9a35d11 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
      ),
    ).toBe(true);
    expect(accepted.test(":100644 100644 1d9d46e 0000000 M README.md\n@@ -1 +1 @@\n")).toBe(true);
    expect(accepted.test(":100644 100644 1d9d46e 0000000 A README.md\n@@ -1 +1 @@\n")).toBe(false);
    expect(accepted.test(":100644 100644 1d9d46e 0000000 M README.md\n-old\n+new\n")).toBe(false);
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
