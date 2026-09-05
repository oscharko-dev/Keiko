import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createOpenCodeGatewayToolCatalogAdvertisement,
  hasExactOpenCodeVisibleToolContract,
  OPENCODE_MODEL_VISIBLE_TOOLS,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  projectedGatewaySchema,
} from "./opencodeToolSchemas.js";
import { mintProposalId, proposalIdPattern } from "../gitDelivery/proposalId.js";

function projectedTools(): readonly {
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}[] {
  return OPENCODE_MODEL_VISIBLE_TOOLS.map(({ name, parameters }) => ({
    name,
    parameters: projectedGatewaySchema(name, parameters),
  }));
}

interface RealAdvertisedTool {
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** #3390 live-run capture: the real OpenCode 1.17.17 binary's actual `tools` advertisement. */
function realAdvertisementFixture(): readonly RealAdvertisedTool[] {
  const path = new URL(
    "./opencodeToolSchemas.opencode-1.17.17-advertised.fixture.json",
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(path, "utf8")) as readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }[];
  return parsed.map(({ name, parameters }) => ({ name, parameters }));
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

  it("accepts the exact projected surface including the eight new Git/CI tools and #3414's repository search", () => {
    expect(hasExactOpenCodeVisibleToolContract(projectedTools())).toBe(true);
    expect(OPENCODE_MODEL_VISIBLE_TOOLS).toHaveLength(18);
  });

  it("bounds keiko_git_diff to CODING_RUNTIME_GIT_MAX_PATHS paths", () => {
    const diff = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_git_diff");
    const paths = diff?.parameters.properties.paths;
    if (paths === undefined) throw new TypeError("Expected keiko_git_diff paths schema.");
    expect(diff?.parameters.required).toContain("paths");
    expect(paths.maxItems).toBe(50);
  });

  it("requires kind and proposalId for keiko_git_execute, bounding proposalId to the three server-issued prefixes", () => {
    const execute = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_git_execute");
    const pattern = execute?.parameters.properties.proposalId.pattern;
    if (pattern === undefined) throw new TypeError("Expected keiko_git_execute proposalId schema.");
    expect(execute?.parameters.required).toEqual(["kind", "proposalId"]);
    expect(execute?.parameters.properties.kind.enum).toEqual([
      "stage",
      "commit",
      "push",
      "pull-request",
    ]);
    // The schema pattern is derived from proposalId.ts's shared PROPOSAL_ID_PREFIXES rather than
    // hand-typed, so this equality catches the two sources drifting apart.
    expect(pattern).toBe(proposalIdPattern());
    const accepted = new RegExp(pattern, "u");
    // stage-* (runtimeGitService.ts), delivery-* (draftDeliveryFacts.ts, push/pull-request), and
    // commit-* (verifiedCommitService.ts's VerifiedCommitService.propose()) are the three shapes
    // the server actually mints; a real minted commit proposal id must be redeemable through this
    // tool (regression: the pattern previously omitted "commit", making #3386's commit-redemption
    // path unreachable through the model-visible schema even though "commit" is a valid `kind`).
    expect(accepted.test(mintProposalId("stage"))).toBe(true);
    expect(accepted.test(mintProposalId("delivery"))).toBe(true);
    expect(accepted.test(mintProposalId("commit"))).toBe(true);
    expect(accepted.test("other-1")).toBe(false);
  });

  it("requires forceFresh as a boolean for keiko_ci_status", () => {
    const ci = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_ci_status");
    expect(ci?.parameters.required).toEqual(["forceFresh"]);
    expect(ci?.parameters.properties.forceFresh.type).toBe("boolean");
  });

  it("rejects a control-character pull-request title", () => {
    const pullRequest = OPENCODE_MODEL_VISIBLE_TOOLS.find(
      (tool) => tool.name === "keiko_pull_request",
    );
    const pattern = pullRequest?.parameters.properties.title.pattern;
    if (pattern === undefined) throw new TypeError("Expected keiko_pull_request title schema.");
    const accepted = new RegExp(pattern, "u");
    expect(accepted.test("Fix the flaky retry loop")).toBe(true);
    expect(accepted.test("bad\ntitle")).toBe(false);
    expect(accepted.test("bad\0title")).toBe(false);
  });
});

describe("createOpenCodeGatewayToolCatalogAdvertisement", () => {
  it("binds the sixteen catalog-representable governed tools plus its two native extensions (#3414 follow-up)", () => {
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
        "keiko_repository_search",
        "keiko_research_fetch",
        "keiko_skill",
        "keiko_verification",
        "keiko_workspace_discover",
        "keiko_workspace_read",
        "keiko_git_status",
        "keiko_git_diff",
        "keiko_git_stage",
        "keiko_git_commit",
        "keiko_git_push",
        "keiko_pull_request",
        "keiko_git_execute",
        "keiko_ci_status",
      ].sort(),
    );
    // Catalog toolRefs never carry a native extension (ADR-0175 D2: never a Keiko tool
    // descriptor) -- the offered set still names only the sixteen catalog-representable tools
    // (#3414 adds keiko_repository_search, #3386's H1 handler, to the original fifteen).
    expect(advertisement.offered.toolRefs).toHaveLength(16);
    expect(advertisement.offered.binding.readiness).toBe("ready");
  });

  // Every model-visible tool is accounted for by exactly one of two sources: the catalog
  // projection, or its two exhaustively-declared native extensions (`question`, `todowrite`).
  // #3386/#3387/#3388 registered the eight Git/CI tools into the same catalog registration set
  // the original seven tools already came from (opencode.test.ts's "declares all eight
  // #3386/#3387/#3388 Git/CI tools under their canonical identities" test pins that registration),
  // so this stays one exact-equality invariant rather than a two-source partition: every
  // model-visible tool is either a catalog-projected tool or one of its two native extensions.
  it("names all eighteen OpenCode 1.17.17 model-visible tools once native extensions are included", () => {
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

// #3390: a real OpenCode 1.17.17 run on macOS with the pinned binary refused every chat
// completion with 403 CODING_GATEWAY_TOOL_CONTRACT_DRIFT because OpenCode projects an
// empty-parameter tool's schema differently from every other tool: for `keiko_git_status` and
// `keiko_git_push` (source `{"type":"object","properties":{},"required":[]}`) the real binary
// sends `{"$schema":"https://json-schema.org/draft/2020-12/schema","properties":{},"type":
// "object"}` -- no `required` key. The fixture below is that exact live capture, unmodified.
describe("OpenCode 1.17.17 real advertisement fidelity (#3390 live-run evidence)", () => {
  it("accepts the real OpenCode 1.17.17 advertisement byte-for-byte", () => {
    expect(hasExactOpenCodeVisibleToolContract(realAdvertisementFixture())).toBe(true);
  });

  it("denies the real advertisement with one tool removed", () => {
    const withoutOneTool = realAdvertisementFixture().slice(1);
    expect(hasExactOpenCodeVisibleToolContract(withoutOneTool)).toBe(false);
  });

  it("denies the real advertisement with one schema altered", () => {
    const tampered = realAdvertisementFixture().map((tool) =>
      tool.name === "keiko_git_status"
        ? { ...tool, parameters: { ...tool.parameters, properties: { extra: { type: "string" } } } }
        : tool,
    );
    expect(hasExactOpenCodeVisibleToolContract(tampered)).toBe(false);
  });

  it("denies the pinned source schemas unprojected for the two empty-parameter tools", () => {
    // Regression for the #3390 defect itself: the raw generated source shape (`required: []`,
    // no `$schema`) that the sidecar gateway was wrongly requiring must never be re-accepted.
    const sourceShaped = realAdvertisementFixture().map((tool) =>
      tool.name === "keiko_git_status" || tool.name === "keiko_git_push"
        ? { ...tool, parameters: { type: "object", properties: {}, required: [] } }
        : tool,
    );
    expect(hasExactOpenCodeVisibleToolContract(sourceShaped)).toBe(false);
  });
});
