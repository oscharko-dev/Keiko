import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type {
  CatalogDigest,
  CompiledCatalogTool,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolInvocationNormalizer, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import {
  createOpenCodeGatewayToolCatalogAdvertisement,
  deriveGatewayCatalogReadiness,
  hasExactOpenCodeVisibleToolContract,
  openCodeGatewayCatalogProjection,
  OPENCODE_MODEL_VISIBLE_TOOLS,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  projectedGatewaySchema,
  type OpenCodeGatewayHandlerCoverage,
  OPENCODE_GATEWAY_OFFER_SETTLEMENT_GRACE_MS,
  opencodeGatewayOfferLifetimeMs,
} from "./opencodeToolSchemas.js";
import { mintProposalId, proposalIdPattern } from "../gitDelivery/proposalId.js";
import { OPENCODE_GOVERNED_SYSTEM_PROMPT } from "./opencodeLaunchProfile.js";
import { createCanonicalOpenCodeHandlerCoverage } from "../tool-catalog/catalogToolFacadeBridge.js";
import type { OpenCodeOptionalToolName } from "./opencodeLaunchProfile.js";

const projectionCompilations = vi.hoisted(() => ({ count: 0, utf8Bytes: 0 }));

vi.mock("@oscharko-dev/keiko-tool-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-tool-catalog")>();
  return {
    ...actual,
    compileToolProjection: (
      ...args: Parameters<typeof actual.compileToolProjection>
    ): ReturnType<typeof actual.compileToolProjection> => {
      const projection = actual.compileToolProjection(...args);
      projectionCompilations.count += 1;
      projectionCompilations.utf8Bytes += Buffer.byteLength(JSON.stringify(projection), "utf8");
      return projection;
    },
  };
});

/** Minimal, independently-constructed `CompiledCatalogTool` fixture -- built here, not through
 * `createToolDescriptor`, since the point of this test is to exercise `handlerRequirement` shapes
 * (an empty id, a shared id) that the real descriptor builder's own validation already rejects
 * before a malformed catalog can ever compile. */
function compiledTool(canonicalId: string, handlerId: string): CompiledCatalogTool {
  return {
    toolRef: createToolRef(canonicalId, 1),
    alias: canonicalId,
    description: "fixture",
    inputSchema: { type: "object", properties: {}, required: [] },
    resultSchema: { type: "string" },
    effects: ["workspace-read"],
    actionMapping: [{ action: canonicalId, effects: ["workspace-read"] }],
    policyReferences: ["workspace-read"],
    handlerRequirement: { id: handlerId, contractVersion: 1 },
    bounds: { maxArgumentBytes: 1, maxResultBytes: 1, maxResultCount: 1, maxDurationMs: 1 },
    idempotency: "read-only",
    cancellation: "before-effect",
    descriptorDigest: "fixture-digest" as CatalogDigest,
  };
}

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

/** Live V2 capture: the real OpenCode 2.0.10 binary's actual `tools` advertisement. */
function realAdvertisementFixture(): readonly RealAdvertisedTool[] {
  const path = new URL(
    "./opencodeToolSchemas.opencode-2.0.10-advertised.fixture.json",
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(path, "utf8")) as readonly {
    readonly name: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }[];
  return parsed.map(({ name, parameters }) => ({ name, parameters }));
}

// A representative deadline-derived lifetime for the structural assertions below (30 s provider
// deadline + settlement grace); the lifetime tests further down pin the derivation itself.
const OFFER_LIFETIME_MS = opencodeGatewayOfferLifetimeMs(30_000);

describe("OpenCode visible tool contract", () => {
  it("keeps the runtime and portable verifier on the canonical pinned version", () => {
    const consumers = [
      new URL("./opencodeRuntimeComposition.ts", import.meta.url),
      new URL("../update-portable-sidecar-verification.ts", import.meta.url),
    ];

    for (const consumer of consumers) {
      const source = readFileSync(consumer, "utf8");
      expect(source).toContain("OPENCODE_PINNED_VERSION");
      expect(source).not.toContain('"1.18.30"');
    }
  });

  it("accepts only the pinned V2 verification projection", () => {
    expect(hasExactOpenCodeVisibleToolContract(projectedTools())).toBe(true);
  });

  it("denies the unprojected source verification schema", () => {
    expect(hasExactOpenCodeVisibleToolContract(OPENCODE_MODEL_VISIBLE_TOOLS)).toBe(false);
  });

  // Added by 672387e (#3521): a projected verification schema that lost its verifier enum or its
  // required verifier must never pass the exact-set trust check again, or a model could name an
  // arbitrary verifier id on the native wire. Restored verbatim after #3873's edit-form change had
  // removed it along with the retired patch-pattern test (review, AGENTS.md §7).
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

  // The same pin for the edit form: a projected changeset that reintroduces the retired `patch`
  // member, or whose edits no longer require their strings, is not the pinned contract.
  it.each([
    [
      "a reintroduced patch member",
      (changeset: Record<string, unknown>): Record<string, unknown> => ({
        ...changeset,
        properties: {
          ...(changeset.properties as Record<string, unknown>),
          patch: { type: "string", maxLength: 65_536 },
        },
      }),
    ],
    [
      "edits that do not require their strings",
      (changeset: Record<string, unknown>): Record<string, unknown> => {
        const properties = changeset.properties as Record<string, unknown>;
        const edits = properties.edits as Record<string, unknown>;
        return {
          ...changeset,
          properties: {
            ...properties,
            edits: {
              ...edits,
              items: { ...(edits.items as Record<string, unknown>), required: [] },
            },
          },
        };
      },
    ],
  ])("denies a projected changeset-edit schema with %s", (_name, mutate) => {
    const tools = projectedTools().map((tool) => {
      if (tool.name !== "keiko_changeset_edit") return tool;
      const properties = tool.parameters.properties as Record<string, unknown>;
      const changeset = properties.changeset as Record<string, unknown>;
      return {
        ...tool,
        parameters: { ...tool.parameters, properties: { changeset: mutate(changeset) } },
      };
    });
    expect(hasExactOpenCodeVisibleToolContract(tools)).toBe(false);
  });

  // #3873 review: the system prompt and this schema must describe one edit form. Every changeset
  // property the prompt names must be one the schema declares, and the retired diff form (a patch,
  // a /dev/null source) must not come back into the prompt, or the model receives two contracts.
  it("names in the system prompt no changeset property the schema does not declare, and no diff form", () => {
    const edit = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_changeset_edit");
    const changeset = edit?.parameters.properties.changeset;
    if (changeset === undefined) throw new Error("Expected the changeset schema.");
    const declared = new Set(Object.keys(changeset.properties));
    const named = [...OPENCODE_GOVERNED_SYSTEM_PROMPT.matchAll(/changeset\.([A-Za-z]+)/gu)].map(
      (match) => match[1] ?? "",
    );

    expect(named.length).toBeGreaterThan(0);
    for (const property of named) expect(declared).toContain(property);
    expect(OPENCODE_GOVERNED_SYSTEM_PROMPT).not.toMatch(
      /unified diff|\/dev\/null|changeset\.patch/u,
    );
  });

  it("offers exact replacements as the only model-visible edit form (#3873)", () => {
    const edit = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_changeset_edit");
    const changeset = edit?.parameters.properties.changeset;
    if (changeset === undefined) throw new Error("Expected the changeset schema.");

    expect(changeset.required).toEqual(["edits", "files"]);
    expect(Object.keys(changeset.properties)).toEqual([
      "edits",
      "deletions",
      "renames",
      "files",
      "selectedFiles",
    ]);
    expect(changeset.properties.edits.items.required).toEqual(["file", "oldString", "newString"]);
    expect(Object.keys(changeset.properties.edits.items.properties)).toEqual([
      "file",
      "oldString",
      "newString",
      "replaceAll",
    ]);
  });

  // #3873 follow-up: deletions and renames ride the same closed changeset object. A call that only
  // deletes or moves carries no edits, so `edits` no longer demands an item; both new members are
  // bounded by the same 50 entries and the same workspace-relative path pattern as every other path.
  it("offers deletions and renames beside the edits, bounded like every other path (#3873 follow-up)", () => {
    const edit = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_changeset_edit");
    const changeset = edit?.parameters.properties.changeset;
    if (changeset === undefined) throw new Error("Expected the changeset schema.");
    const path = changeset.properties.files.items.properties.file;

    expect(changeset.properties.edits).not.toHaveProperty("minItems");
    expect(changeset.properties.deletions).toEqual({
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: path,
      description: expect.stringContaining("after edits") as string,
    });
    expect(changeset.properties.renames).toMatchObject({
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { from: { ...path }, to: { ...path } },
        required: ["from", "to"],
      },
    });
    expect(changeset.properties.renames.description).toContain("before edits");
    expect(new RegExp(path.pattern, "u").test(".git/../escape")).toBe(false);
  });

  it("requires a bounded targetPath sentinel on the native provider wire", () => {
    const verification = OPENCODE_MODEL_VISIBLE_TOOLS.find(
      (tool) => tool.name === "keiko_verification",
    );
    expect(verification?.parameters).toMatchObject({
      properties: {
        targetPath: {
          type: "string",
          minLength: 0,
          maxLength: 4096,
        },
      },
      required: ["targetPath", "verifierId"],
    });
  });

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
  it("binds the seventeen governed tools plus the native question extension", () => {
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      undefined,
      OFFER_LIFETIME_MS,
    );
    expect(advertisement.kind).toBe("bound");
    expect(advertisement.projection.nativeExtensions).toEqual([
      { alias: "question", contractVersion: 1 },
    ]);
    expect(advertisement.projection.tools.map((tool) => tool.alias).sort()).toEqual(
      [
        "keiko_changeset_edit",
        "keiko_child_agent",
        "keiko_repository_search",
        "keiko_research_fetch",
        "keiko_skill",
        "keiko_skill_discover",
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
    // descriptor) -- the offered set still names only the seventeen catalog-representable tools
    // (#3414 added keiko_repository_search, #3386's H1 handler, to the original fifteen; #3417
    // adds keiko_skill_discover).
    expect(advertisement.offered.toolRefs).toHaveLength(17);
    expect(advertisement.offered.binding.readiness).toBe("ready");
  });

  // Every model-visible tool is accounted for by exactly one of two sources: the catalog
  // projection, or its one declared native extension (`question`).
  // #3386/#3387/#3388 registered the eight Git/CI tools into the same catalog registration set
  // the original seven tools already came from (opencode.test.ts's "declares all eight
  // #3386/#3387/#3388 Git/CI tools under their canonical identities" test pins that registration),
  // so this stays one exact-equality invariant rather than a two-source partition: every
  // model-visible tool is either a catalog-projected tool or the native question extension.
  it("names all eighteen OpenCode 2.0.10 model-visible tools", () => {
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      undefined,
      OFFER_LIFETIME_MS,
    );
    const modelVisibleNames = new Set([
      ...advertisement.projection.tools.map((tool) => tool.alias),
      ...advertisement.projection.nativeExtensions.map((extension) => extension.alias),
    ]);
    expect(modelVisibleNames).toEqual(new Set(OPENCODE_MODEL_VISIBLE_TOOL_NAMES));
  });

  it("issues a distinct offer identity and expiry per call", () => {
    const lifetime = opencodeGatewayOfferLifetimeMs(120_000);
    const first = createOpenCodeGatewayToolCatalogAdvertisement(1_000, undefined, lifetime);
    const second = createOpenCodeGatewayToolCatalogAdvertisement(1_000, undefined, lifetime);
    expect(first.offered.offerId).not.toBe(second.offered.offerId);
    expect(first.projection.projectionDigest).toBe(second.projection.projectionDigest);
    expect(first.offered.expiresAt).toBe(new Date(1_000 + 120_000 + 5_000).toISOString());
  });

  it("does not recompile the immutable projection while producing fresh request offers", () => {
    const initial = openCodeGatewayCatalogProjection();
    const bytes = JSON.stringify(initial.projection);
    const before = { ...projectionCompilations };
    const first = createOpenCodeGatewayToolCatalogAdvertisement(1_000, undefined, 30_000);
    const second = createOpenCodeGatewayToolCatalogAdvertisement(2_000, undefined, 60_000);

    expect(projectionCompilations).toEqual(before);
    expect(first.projection).toBe(initial.projection);
    expect(second.projection).toBe(initial.projection);
    expect(JSON.stringify(second.projection)).toBe(bytes);
    expect(first.offered.offerId).not.toBe(second.offered.offerId);
    expect(first.offered.expiresAt).toBe(new Date(31_000).toISOString());
    expect(second.offered.expiresAt).toBe(new Date(62_000).toISOString());
  });

  it("shares only recursively immutable catalog facts and returns independent wrappers", () => {
    const first = openCodeGatewayCatalogProjection();
    const second = openCodeGatewayCatalogProjection();
    const bytes = JSON.stringify(second);
    const tool = first.projection.tools[0];
    if (tool === undefined) throw new Error("expected a compiled OpenCode tool");

    expect(first).not.toBe(second);
    expect(first.catalog).toBe(second.catalog);
    expect(first.projection).toBe(second.projection);
    expect(Reflect.set(tool.inputSchema, "type", "string")).toBe(false);
    expect(Reflect.set(first.projection.tools, "0", undefined)).toBe(false);
    expect(Reflect.set(first.catalog, "catalogRevision", "different")).toBe(false);
    expect(Reflect.set(first, "projection", undefined)).toBe(true);
    expect(JSON.stringify(second)).toBe(bytes);
  });

  it("recomputes real handler availability without changing a previous request offer", () => {
    const unavailable = new Set<OpenCodeOptionalToolName>();
    const first = createOpenCodeGatewayToolCatalogAdvertisement(
      1_000,
      createCanonicalOpenCodeHandlerCoverage(unavailable),
      30_000,
    );
    const child = first.projection.tools.find((tool) => tool.alias === "keiko_child_agent");
    if (child === undefined) throw new Error("expected the child tool in the real projection");
    const previous = JSON.stringify(first.offered);
    unavailable.add("keiko_child_agent");
    const second = createOpenCodeGatewayToolCatalogAdvertisement(
      2_000,
      createCanonicalOpenCodeHandlerCoverage(unavailable),
      30_000,
    );

    expect(second.projection).toBe(first.projection);
    expect(second.offered.binding.handlerSetDigest).not.toBe(
      first.offered.binding.handlerSetDigest,
    );
    expect(first.offered.toolRefs.map((ref) => ref.canonicalId)).toContain(
      child.toolRef.canonicalId,
    );
    expect(second.offered.toolRefs.map((ref) => ref.canonicalId)).not.toContain(
      child.toolRef.canonicalId,
    );
    expect(JSON.stringify(first.offered)).toBe(previous);
    expect(second.offered.toolRefs).not.toBe(first.offered.toolRefs);
  });

  // The offer used to expire after a fixed 30 s. A ~6k-token `keiko_changeset_edit` call took 49 s
  // to generate (2026-09-10), so the response bound against a dead offer: `expired-compatibility`,
  // reported as GATEWAY_MALFORMED_TOOL_CALL, chat failed, turn failed, run failed with no change.
  // The lifetime is the request deadline the gateway enforces plus the bridge's settlement grace.
  describe("offer lifetime follows the request deadline", () => {
    it("derives the lifetime from the deadline plus the settlement grace, and refuses a non-positive deadline", () => {
      expect(opencodeGatewayOfferLifetimeMs(120_000)).toBe(
        120_000 + OPENCODE_GATEWAY_OFFER_SETTLEMENT_GRACE_MS,
      );
      expect(opencodeGatewayOfferLifetimeMs(30_000)).toBe(35_000);
      expect(() => opencodeGatewayOfferLifetimeMs(0)).toThrow(RangeError);
      expect(() => opencodeGatewayOfferLifetimeMs(Number.NaN)).toThrow(RangeError);
      expect(() => createOpenCodeGatewayToolCatalogAdvertisement(0, undefined, 0)).toThrow(
        RangeError,
      );
    });

    it("binds a call that arrives 49 s into a 120 s request, and still refuses one past the deadline", () => {
      const now = Date.parse("2026-09-10T05:26:07.000Z");
      const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
        now,
        undefined,
        opencodeGatewayOfferLifetimeMs(120_000),
      );
      const normalizer = createToolInvocationNormalizer({
        catalog: advertisement.catalog,
        projection: advertisement.projection,
        offered: advertisement.offered,
      });
      const args = {};
      expect(normalizer.bindAlias("keiko_git_status", args, now + 49_000).arguments).toEqual(args);
      expect(() => normalizer.bindAlias("keiko_git_status", args, now + 120_000 + 5_000)).toThrow(
        /expired-compatibility/u,
      );
      // The historical fixed lifetime, kept only as the red half of this pin: the same 49 s
      // response is refused against a 30 s offer.
      const fixed = createOpenCodeGatewayToolCatalogAdvertisement(now, undefined, 30_000);
      const fixedNormalizer = createToolInvocationNormalizer({
        catalog: fixed.catalog,
        projection: fixed.projection,
        offered: fixed.offered,
      });
      expect(() => fixedNormalizer.bindAlias("keiko_git_status", args, now + 49_000)).toThrow(
        /expired-compatibility/u,
      );
    });
  });

  // AC5 (#3413-AC5): the advertisement crosses a BFF-owned trust boundary (today BFF -> model
  // gateway -> sidecar/model, per its own composing-module doc comment above) and must contain
  // only the approved descriptor/result-safe projection -- structurally, never merely by
  // convention. Mirrors catalogToolBinder.test.ts:28's real-binder proof against THIS module's
  // actually-wired advertisement, which had no equivalent exact-shape assertion before.
  it("is JSON-safe and carries no handler/authority/secret-bearing material (#3413-AC5)", () => {
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      undefined,
      OFFER_LIFETIME_MS,
    );
    const serialized = JSON.stringify(advertisement.offered);
    // "execute" is deliberately excluded: `keiko.git.execute` is a legitimate canonical tool id,
    // not a leaked handler-execution field.
    expect(serialized).not.toMatch(
      /private|authority|handlerBindings|environment|workspaceRoot|password|secret|token/iu,
    );
    // Round-trips through JSON with no loss (no function/undefined/symbol survives serialization).
    expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(JSON.parse(serialized))));
    expect(Object.keys(advertisement.offered).sort()).toEqual([
      "binding",
      "expiresAt",
      "offerId",
      "toolRefs",
    ]);
    expect(Object.keys(advertisement.offered.binding).sort()).toEqual([
      "catalogRevision",
      "handlerSetDigest",
      "profile",
      "projectionDigest",
      "readiness",
    ]);
  });
});

// #3413 F8 review, findings b1-1/b1-2 and #3414-AC4/AC9: this module has no reach into which
// handler ids the running dispatcher actually has bound, so it must accept that ground truth from
// its caller rather than fabricate it. These pin the accepting primitive in isolation (a
// synthetic, obviously-real coverage map) since no production composition wires a real one through
// yet -- that wiring is tracked outOfScopeNeeds against codingToolAuthorityPort.ts's
// catalogFacadeBridgeFor.
describe("createOpenCodeGatewayToolCatalogAdvertisement with real handlerCoverage", () => {
  function coverageFrom(
    readiness: (canonicalId: string) => "ready" | "unavailable",
  ): OpenCodeGatewayHandlerCoverage {
    const base = createOpenCodeGatewayToolCatalogAdvertisement(0, undefined, OFFER_LIFETIME_MS);
    const readinessByToolId = new Map(
      base.projection.tools.map((tool) => [
        tool.toolRef.canonicalId,
        readiness(tool.toolRef.canonicalId),
      ]),
    );
    return { readinessByToolId, handlerSetDigest: "real-handler-set-digest" as never };
  }

  it("preserves the prior structural-only behaviour byte-for-byte when coverage is omitted", () => {
    const withoutCoverage = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      undefined,
      OFFER_LIFETIME_MS,
    );
    expect(withoutCoverage.offered.toolRefs).toHaveLength(17);
    expect(withoutCoverage.offered.binding.readiness).toBe("ready");
    expect(withoutCoverage.offered.binding.handlerSetDigest).toBe(
      withoutCoverage.projection.projectionDigest,
    );
  });

  it("drops a tool from the offered set when its real binding is not ready, without killing the rest", () => {
    const coverage = coverageFrom((id) => (id === "keiko.repo.search" ? "unavailable" : "ready"));
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      coverage,
      OFFER_LIFETIME_MS,
    );
    expect(advertisement.offered.toolRefs.map((ref) => ref.canonicalId)).not.toContain(
      "keiko.repo.search",
    );
    expect(advertisement.offered.toolRefs).toHaveLength(16);
    // One unready optional tool must not swing the whole advertisement to unavailable, matching
    // catalogToolBinder.ts's own per-tool offer semantics (buildCatalogOffer) -- but the TOP-LEVEL
    // readiness signal still reflects that at least one real binding was not ready.
    expect(advertisement.offered.binding.readiness).toBe("unavailable");
  });

  it("treats a tool absent from the coverage map as unavailable (fail closed)", () => {
    const base = createOpenCodeGatewayToolCatalogAdvertisement(0, undefined, OFFER_LIFETIME_MS);
    const partial = new Map(
      base.projection.tools
        .filter((tool) => tool.toolRef.canonicalId !== "keiko.repo.search")
        .map((tool) => [tool.toolRef.canonicalId, "ready" as const]),
    );
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      {
        readinessByToolId: partial,
        handlerSetDigest: "real-handler-set-digest" as never,
      },
      OFFER_LIFETIME_MS,
    );
    expect(advertisement.offered.toolRefs.map((ref) => ref.canonicalId)).not.toContain(
      "keiko.repo.search",
    );
  });

  it("is ready, and offers every tool, only when every real binding is ready", () => {
    const coverage = coverageFrom(() => "ready");
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      coverage,
      OFFER_LIFETIME_MS,
    );
    expect(advertisement.offered.binding.readiness).toBe("ready");
    expect(advertisement.offered.toolRefs).toHaveLength(17);
  });

  it("uses the caller-supplied real handlerSetDigest verbatim, never the projection digest alias (#3414-AC4)", () => {
    const coverage = coverageFrom(() => "ready");
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      coverage,
      OFFER_LIFETIME_MS,
    );
    expect(advertisement.offered.binding.handlerSetDigest).toBe("real-handler-set-digest");
    expect(advertisement.offered.binding.handlerSetDigest).not.toBe(
      advertisement.projection.projectionDigest,
    );
  });
});

// #3413 F8 review, finding b1-2: before this, `createOpenCodeGatewayToolCatalogAdvertisement`
// wrote a bare `"ready"` literal with no handler-binding check at all, so a descriptor whose
// handler id was emptied or accidentally duplicated across two tools would still be advertised as
// ready to the model. These pin the real check in isolation from the fixed seventeen-tool catalog
// (which can never itself produce either malformed shape -- `createToolDescriptor`'s own
// validation already rejects an empty or duplicate handler id before a catalog can compile).
describe("deriveGatewayCatalogReadiness", () => {
  it("is ready when every tool declares its own distinct handler id", () => {
    const tools = [
      compiledTool("keiko.fixture.one", "handler-one"),
      compiledTool("keiko.fixture.two", "handler-two"),
    ];
    expect(deriveGatewayCatalogReadiness(tools)).toBe("ready");
  });

  it("is ready for the empty catalog (vacuously -- no tool is unready)", () => {
    expect(deriveGatewayCatalogReadiness([])).toBe("ready");
  });

  it("is unavailable when a handler id is empty", () => {
    const tools = [compiledTool("keiko.fixture.one", "")];
    expect(deriveGatewayCatalogReadiness(tools)).toBe("unavailable");
  });

  it("is unavailable when two tools share the same handler id", () => {
    const tools = [
      compiledTool("keiko.fixture.one", "shared-handler"),
      compiledTool("keiko.fixture.two", "shared-handler"),
    ];
    expect(deriveGatewayCatalogReadiness(tools)).toBe("unavailable");
  });

  it("advertises the real seventeen-tool production catalog as ready", () => {
    const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(
      0,
      undefined,
      OFFER_LIFETIME_MS,
    );
    expect(deriveGatewayCatalogReadiness(advertisement.projection.tools)).toBe("ready");
  });
});

// Captured directly from a real OpenCode 2.0.10 provider call. The gateway must accept its
// closed top-level schemas while rejecting altered tools, including the two empty-parameter tools.
describe("OpenCode 2.0.10 real advertisement fidelity", () => {
  it("accepts the unchanged live-captured tools with the current verification projection", () => {
    expect(hasExactOpenCodeVisibleToolContract(realAdvertisementFixture())).toBe(true);
  });

  it("denies a historical verification projection without targetPath", () => {
    const historicalAdvertisement = realAdvertisementFixture().map((tool) =>
      tool.name === "keiko_verification"
        ? {
            ...tool,
            parameters: {
              type: "object",
              properties: {
                verifierId: {
                  type: "string",
                  enum: ["test", "targeted-test", "typecheck", "lint", "build"],
                },
              },
              required: ["verifierId"],
            },
          }
        : tool,
    );
    expect(hasExactOpenCodeVisibleToolContract(historicalAdvertisement)).toBe(false);
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

function codeModeFixture(): readonly RealAdvertisedTool[] {
  const value = JSON.parse(
    readFileSync(
      new URL("./opencodeToolSchemas.opencode-2.0.10-codemode.fixture.json", import.meta.url),
      "utf8",
    ),
  ) as { readonly tools: readonly RealAdvertisedTool[] };
  return value.tools;
}

describe("inactive native Code Mode qualification", () => {
  it("accepts the original pinned snapshot only under the explicit Code Mode profile", () => {
    expect(hasExactOpenCodeVisibleToolContract(codeModeFixture(), "code-mode")).toBe(true);
    expect(hasExactOpenCodeVisibleToolContract(codeModeFixture())).toBe(false);
  });
});

describe("explicit native Code Mode schema boundary", () => {
  it("rejects mixed direct/inner, empty, duplicate and altered outer schemas", () => {
    const tools = codeModeFixture();
    const execute = tools.find((tool) => tool.name === "execute");
    const question = tools.find((tool) => tool.name === "question");
    if (execute === undefined || question === undefined)
      throw new TypeError("Missing native producer tools");
    const invalid = [
      [],
      [execute],
      [question, question],
      [...tools, ...projectedTools().slice(0, 1)],
      [question, { ...execute, parameters: { ...execute.parameters, additionalProperties: true } }],
      [question, { ...execute, parameters: { type: "object", properties: {}, required: [] } }],
      [question, { ...execute, parameters: { ...execute.parameters, maxProperties: 1 } }],
    ];
    for (const value of invalid)
      expect(hasExactOpenCodeVisibleToolContract(value, "code-mode")).toBe(false);
    expect(hasExactOpenCodeVisibleToolContract(realAdvertisementFixture(), "code-mode")).toBe(
      false,
    );
  });

  it("retains actual inner handler coverage, offer lifetime and the entire canonical projection", () => {
    const projection = openCodeGatewayCatalogProjection("code-mode").projection;
    const coverage: OpenCodeGatewayHandlerCoverage = {
      readinessByToolId: new Map(
        projection.tools.map((tool) => [
          tool.toolRef.canonicalId,
          tool.toolRef.canonicalId === "keiko.repo.search" ? "unavailable" : "ready",
        ]),
      ),
      handlerSetDigest: "caller-owned-handler-digest" as CatalogDigest,
    };
    const offer = createOpenCodeGatewayToolCatalogAdvertisement(1000, coverage, 9000, "code-mode");
    expect(offer.projection.tools).toHaveLength(17);
    expect(offer.offered.toolRefs).toHaveLength(16);
    expect(offer.offered.toolRefs.some((ref) => ref.canonicalId === "keiko.repo.search")).toBe(
      false,
    );
    expect(offer.offered.binding).toMatchObject({
      readiness: "unavailable",
      handlerSetDigest: coverage.handlerSetDigest,
    });
    expect(offer.offered.expiresAt).toBe(new Date(10000).toISOString());
    expect(offer.projection).toBe(projection);
    const before = { ...projectionCompilations };
    createOpenCodeGatewayToolCatalogAdvertisement(1000, coverage, 9000, "code-mode");
    expect(projectionCompilations).toEqual(before);
    expect(openCodeGatewayCatalogProjection().projection.tools).toEqual(projection.tools);
    expect(openCodeGatewayCatalogProjection().projection.nativeExtensions).toEqual([
      { alias: "question", contractVersion: 1 },
    ]);
  });

  it("refuses an unknown explicit profile at the immutable projection owner", () => {
    expect(() => {
      Reflect.apply(openCodeGatewayCatalogProjection, undefined, ["unknown"]);
    }).toThrow(TypeError);
  });
});
