import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createOpenCodeGatewayToolCatalogAdvertisement,
  hasExactOpenCodeVisibleToolContract,
  OPENCODE_MODEL_VISIBLE_TOOLS,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
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
  it("keeps the runtime and portable verifier on the canonical pinned version", () => {
    const consumers = [
      new URL("./opencodeRuntimeComposition.ts", import.meta.url),
      new URL("../update-portable-sidecar-verification.ts", import.meta.url),
    ];

    for (const consumer of consumers) {
      const source = readFileSync(consumer, "utf8");
      expect(source).toContain("OPENCODE_PINNED_VERSION");
      expect(source).not.toContain('"1.17.17"');
    }
  });

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

describe("createOpenCodeGatewayToolCatalogAdvertisement", () => {
  it("binds the seven catalog-representable governed tools plus its two native extensions (#3414 follow-up)", () => {
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(0);
    expect(advertisement.kind).toBe("bound");
    expect(advertisement.projection.nativeExtensions).toEqual([
      { alias: "question", contractVersion: 1 },
      { alias: "todowrite", contractVersion: 1 },
    ]);
    expect(advertisement.projection.tools.map((tool) => tool.alias).sort()).toEqual(
      [
        "keiko_changeset_edit",
        "keiko_child_agent",
        "keiko_research_fetch",
        "keiko_skill",
        "keiko_verification",
        "keiko_workspace_discover",
        "keiko_workspace_read",
      ].sort(),
    );
    // Catalog toolRefs never carry a native extension (ADR-0175 D2: never a Keiko tool
    // descriptor) -- the offered set still names only the seven catalog-representable tools.
    expect(advertisement.offered.toolRefs).toHaveLength(7);
    expect(advertisement.offered.binding.readiness).toBe("ready");
  });

  it("names all nine OpenCode 1.17.17 model-visible tools once native extensions are included", () => {
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(0);
    const modelVisibleNames = new Set([
      ...advertisement.projection.tools.map((tool) => tool.alias),
      ...advertisement.projection.nativeExtensions.map((extension) => extension.alias),
    ]);
    expect(modelVisibleNames).toEqual(new Set(OPENCODE_MODEL_VISIBLE_TOOL_NAMES));
  });

  it("issues a distinct offer identity and expiry per call", () => {
    const first = createOpenCodeGatewayToolCatalogAdvertisement(1_000);
    const second = createOpenCodeGatewayToolCatalogAdvertisement(1_000);
    expect(first.offered.offerId).not.toBe(second.offered.offerId);
    expect(first.projection.projectionDigest).toBe(second.projection.projectionDigest);
    expect(first.offered.expiresAt).toBe(new Date(31_000).toISOString());
  });
});
