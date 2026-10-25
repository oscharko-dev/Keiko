import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type {
  CatalogDigest,
  CompiledCatalogTool,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { isGatewayNativeToolAdvertisement } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  createToolInvocationNormalizer,
  createToolRef,
  OPENCODE_NATIVE_EXTENSION_DEFINITIONS,
} from "@oscharko-dev/keiko-tool-catalog";
import {
  createOpenCodeGatewayToolCatalogAdvertisement,
  createOpenCodeNativeToolAdvertisement,
  deriveGatewayCatalogReadiness,
  hasExactOpenCodeVisibleToolContract,
  openCodeGatewayCatalogProjection,
  openCodeVisibleToolNames,
  OPENCODE_MODEL_VISIBLE_TOOLS,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  OPENCODE_PINNED_VERSION,
  projectedGatewaySchema,
  type OpenCodeGatewayHandlerCoverage,
  OPENCODE_GATEWAY_OFFER_SETTLEMENT_GRACE_MS,
  opencodeGatewayOfferLifetimeMs,
} from "./opencodeToolSchemas.js";
import {
  OPENCODE_NATIVE_TOOL_CONTRACT_MAX_SCHEMA_BYTES,
  OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOOLS,
  OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOTAL_BYTES,
  OPENCODE_NATIVE_TOOL_DEFINITIONS,
  OPENCODE_NATIVE_TOOL_NAMES,
  openCodeNativeToolSetDigest,
} from "./opencodeNativeTools.js";
import { mintProposalId, proposalIdPattern } from "../gitDelivery/proposalId.js";
import { OPENCODE_GOVERNED_SYSTEM_PROMPT } from "./opencodeLaunchProfile.js";
import { createCanonicalOpenCodeHandlerCoverage } from "../tool-catalog/catalogToolFacadeBridge.js";
import type { OpenCodeOptionalToolName } from "./opencodeLaunchProfile.js";
import { gatewayNativeToolDefinitionBytes } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";

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

/**
 * Live capture: the pinned OpenCode 2.1.4 binary's actual direct-profile `tools` advertisement,
 * recorded by opencodeNativeQualification.real.test.ts.
 */
function realAdvertisementFixture(): readonly RealAdvertisedTool[] {
  const path = new URL(
    "./opencodeToolSchemas.opencode-2.1.4-direct-advertised.fixture.json",
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

    // #3908: the version registry is the one owner of version identities; consumers resolve the
    // discovered runtime's pin instead of restating a version or digest literal.
    for (const consumer of consumers) {
      const source = readFileSync(consumer, "utf8");
      expect(source).toContain("openCodeRuntimeVersionPin");
      expect(source).not.toContain('"1.18.30"');
      expect(source).not.toContain('"2.0.10"');
      expect(source).not.toMatch(/[a-f0-9]{64}/u);
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

  it("accepts the exact projected surface including the Git/CI tools and #3414's repository search", () => {
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

  it("requires kind and proposalId for keiko_git_execute, bounding proposalId to the four server-issued prefixes", () => {
    const execute = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_git_execute");
    const pattern = execute?.parameters.properties.proposalId.pattern;
    if (pattern === undefined) throw new TypeError("Expected keiko_git_execute proposalId schema.");
    expect(execute?.parameters.required).toEqual(["kind", "proposalId"]);
    expect(execute?.parameters.properties.kind.enum).toEqual([
      "stage",
      "unstage",
      "commit",
      "push",
      "pull-request",
    ]);
    // The schema pattern is derived from proposalId.ts's shared PROPOSAL_ID_PREFIXES rather than
    // hand-typed, so this equality catches the two sources drifting apart.
    expect(pattern).toBe(proposalIdPattern());
    const accepted = new RegExp(pattern, "u");
    // stage-* and unstage-* (runtimeGitService.ts), delivery-* (draftDeliveryFacts.ts,
    // push/pull-request), and commit-* (verifiedCommitService.ts's VerifiedCommitService.propose())
    // are the four shapes the server actually mints; a real minted commit proposal id must be redeemable through this
    // tool (regression: the pattern previously omitted "commit", making #3386's commit-redemption
    // path unreachable through the model-visible schema even though "commit" is a valid `kind`).
    expect(accepted.test(mintProposalId("stage"))).toBe(true);
    expect(accepted.test(mintProposalId("unstage"))).toBe(true);
    expect(accepted.test(mintProposalId("delivery"))).toBe(true);
    expect(accepted.test(mintProposalId("commit"))).toBe(true);
    expect(accepted.test("other-1")).toBe(false);
  });

  // #3902 AC2: unstaging is an explicit choice on every stage proposal, never an omitted default.
  it("requires paths and the unstage choice for keiko_git_stage", () => {
    const stage = OPENCODE_MODEL_VISIBLE_TOOLS.find((tool) => tool.name === "keiko_git_stage");
    expect(stage?.parameters.required).toEqual(["paths", "unstage"]);
    expect(stage?.parameters.properties.unstage.type).toBe("boolean");
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
  it("names all eighteen OpenCode model-visible tools", () => {
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

// Captured directly from a real OpenCode 2.1.4 provider call in the direct profile. The gateway
// must accept its closed top-level schemas while rejecting altered tools, including the two
// empty-parameter tools.
describe("OpenCode 2.1.4 real advertisement fidelity", () => {
  it("accepts the unchanged live-captured tools with the current verification projection", () => {
    expect(hasExactOpenCodeVisibleToolContract(realAdvertisementFixture())).toBe(true);
  });

  it.each(["mode", "directory"])("denies a discovery schema missing its %s scope", (field) => {
    const tools = realAdvertisementFixture().map((tool) => {
      if (tool.name !== "keiko_workspace_discover") return tool;
      const properties = Object.fromEntries(
        Object.entries(tool.parameters.properties as Record<string, unknown>).filter(
          ([key]) => key !== field,
        ),
      );
      const required = (tool.parameters.required as readonly string[]).filter(
        (key) => key !== field,
      );
      return { ...tool, parameters: { ...tool.parameters, properties, required } };
    });
    expect(hasExactOpenCodeVisibleToolContract(tools)).toBe(false);
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

interface NativeAdvertisedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

function nativeTool(name: string, parameters: Record<string, unknown> = {}): NativeAdvertisedTool {
  return { name, description: `The ${name} tool.`, parameters: { type: "object", ...parameters } };
}

/** The tools a native-profile provider request carries: the producer's own inventory. */
function nativeAdvertisedTools(): readonly NativeAdvertisedTool[] {
  return OPENCODE_NATIVE_TOOL_NAMES.map((name) => nativeTool(name));
}

/** A parameters object whose serialized UTF-8 size is exactly `bytes`. */
function parametersOfUtf8Bytes(bytes: number): Record<string, unknown> {
  const overhead = Buffer.byteLength(JSON.stringify({ p: "" }), "utf8");
  const parameters = { p: "x".repeat(bytes - overhead) };
  expect(Buffer.byteLength(JSON.stringify(parameters), "utf8")).toBe(bytes);
  return parameters;
}

function uniquelyNamed(count: number): NativeAdvertisedTool[] {
  return Array.from({ length: count }, (_unused, index) => nativeTool(`tool_${String(index)}`));
}

describe("openCodeVisibleToolNames", () => {
  it("names the Keiko-governed tools for the default and the direct profile", () => {
    expect(openCodeVisibleToolNames()).toEqual(OPENCODE_MODEL_VISIBLE_TOOL_NAMES);
    expect(openCodeVisibleToolNames("direct")).toEqual(OPENCODE_MODEL_VISIBLE_TOOL_NAMES);
  });

  it("names the producer's own non-Code-Mode inventory for the native profile (#3897)", () => {
    const names = openCodeVisibleToolNames("native");
    expect(names).toBe(OPENCODE_NATIVE_TOOL_NAMES);
    expect(names.length).toBeGreaterThan(0);
    const codeModeOnly = OPENCODE_NATIVE_TOOL_DEFINITIONS.filter((tool) => tool.codemode);
    expect(codeModeOnly.length).toBeGreaterThan(0);
    for (const tool of codeModeOnly) expect(names).not.toContain(tool.id);
  });

  it("names the native extension aliases for the Code Mode profile", () => {
    expect(openCodeVisibleToolNames("code-mode")).toEqual(
      OPENCODE_NATIVE_EXTENSION_DEFINITIONS.map((definition) => definition.alias),
    );
  });

  it.each([["unknown"], ["NATIVE"], [null], [7]])(
    "refuses the profile %s instead of falling back to another contract",
    (profile) => {
      expect(() => {
        Reflect.apply(openCodeVisibleToolNames, undefined, [profile]);
      }).toThrow(new TypeError("Invalid OpenCode profile"));
    },
  );
});

describe("hasExactOpenCodeVisibleToolContract for the native profile (#3897)", () => {
  const MAX_TOOLS = OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOOLS;
  const MAX_SCHEMA_BYTES = OPENCODE_NATIVE_TOOL_CONTRACT_MAX_SCHEMA_BYTES;
  const MAX_TOTAL_BYTES = OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOTAL_BYTES;

  it("admits the producer's own advertisement without pinning any Keiko schema digest", () => {
    expect(hasExactOpenCodeVisibleToolContract(nativeAdvertisedTools(), "native")).toBe(true);
    expect(hasExactOpenCodeVisibleToolContract(projectedTools(), "native")).toBe(true);
  });

  it("admits MCP and plugin tools beside the native ones, which the mapped profiles refuse", () => {
    const withExtension = [...nativeAdvertisedTools(), nativeTool("github.create-issue_2")];
    expect(hasExactOpenCodeVisibleToolContract(withExtension, "native")).toBe(true);
    expect(hasExactOpenCodeVisibleToolContract(withExtension, "direct")).toBe(false);
    expect(hasExactOpenCodeVisibleToolContract(withExtension, "code-mode")).toBe(false);
  });

  it("still refuses the native advertisement under the mapped profiles", () => {
    expect(hasExactOpenCodeVisibleToolContract(nativeAdvertisedTools())).toBe(false);
    expect(hasExactOpenCodeVisibleToolContract(nativeAdvertisedTools(), "code-mode")).toBe(false);
  });

  it("fails closed for an unknown profile, even for an otherwise admissible tool set", () => {
    const tools = nativeAdvertisedTools();
    expect(Reflect.apply(hasExactOpenCodeVisibleToolContract, undefined, [tools, "unknown"])).toBe(
      false,
    );
    expect(Reflect.apply(hasExactOpenCodeVisibleToolContract, undefined, [tools, null])).toBe(
      false,
    );
  });

  it.each([
    ["no advertisement", undefined],
    ["an empty advertisement", []],
    ["a repeated tool name", [nativeTool("read"), nativeTool("glob"), nativeTool("read")]],
    ["an empty tool name", [nativeTool("")]],
    ["a name starting with a digit", [nativeTool("1read")]],
    ["a name containing a space", [nativeTool("read file")]],
    ["a name containing a slash", [nativeTool("mcp/read")]],
    ["a name longer than 64 characters", [nativeTool("a".repeat(65))]],
  ])("refuses %s", (_label, tools) => {
    expect(hasExactOpenCodeVisibleToolContract(tools, "native")).toBe(false);
  });

  it("admits a 64-character tool name", () => {
    expect(hasExactOpenCodeVisibleToolContract([nativeTool("a".repeat(64))], "native")).toBe(true);
  });

  it("admits exactly the maximum tool count and refuses one more", () => {
    expect(hasExactOpenCodeVisibleToolContract(uniquelyNamed(MAX_TOOLS), "native")).toBe(true);
    expect(hasExactOpenCodeVisibleToolContract(uniquelyNamed(MAX_TOOLS + 1), "native")).toBe(false);
  });

  it("admits a schema of exactly the per-tool byte limit and refuses one byte more", () => {
    const atLimit = {
      name: "read",
      description: "r",
      parameters: parametersOfUtf8Bytes(MAX_SCHEMA_BYTES),
    };
    const overByOne = {
      name: "read",
      description: "r",
      parameters: parametersOfUtf8Bytes(MAX_SCHEMA_BYTES + 1),
    };
    expect(hasExactOpenCodeVisibleToolContract([atLimit], "native")).toBe(true);
    expect(hasExactOpenCodeVisibleToolContract([overByOne], "native")).toBe(false);
  });

  it("measures a schema in UTF-8 bytes, not in characters", () => {
    const characters = Math.floor(MAX_SCHEMA_BYTES * 0.6);
    const parameters = { p: "\u00e9".repeat(characters) };
    expect(JSON.stringify(parameters).length).toBeLessThan(MAX_SCHEMA_BYTES);
    expect(Buffer.byteLength(JSON.stringify(parameters), "utf8")).toBeGreaterThan(MAX_SCHEMA_BYTES);
    expect(hasExactOpenCodeVisibleToolContract([{ name: "read", parameters }], "native")).toBe(
      false,
    );
  });

  // #3897 review: admission counts every complete definition (name, description, schema) as UTF-8
  // JSON with the gateway contract's own formula, so what it admits the gateway also captures.
  it("admits complete definitions up to the total budget exactly and refuses one byte over it", () => {
    const toolOf = (name: string, bytes: number): NativeAdvertisedTool => {
      const empty = gatewayNativeToolDefinitionBytes({
        name,
        description: "",
        parameters: { p: "" },
      });
      return { name, description: "", parameters: { p: "x".repeat(bytes - empty) } };
    };
    const count = MAX_TOTAL_BYTES / MAX_SCHEMA_BYTES;
    const atBudget = Array.from({ length: count }, (_unused, index) =>
      toolOf(`full_${String(index)}`, MAX_SCHEMA_BYTES),
    );
    expect(hasExactOpenCodeVisibleToolContract(atBudget, "native")).toBe(true);
    const overByOne = [
      ...atBudget.slice(0, -1),
      toolOf(`full_${String(count - 1)}`, MAX_SCHEMA_BYTES + 1),
    ];
    expect(hasExactOpenCodeVisibleToolContract(overByOne, "native")).toBe(false);
    const longDescription = { ...nativeTool("read"), description: "d".repeat(16_385) };
    expect(hasExactOpenCodeVisibleToolContract([longDescription], "native")).toBe(false);
  });
});

describe("createOpenCodeNativeToolAdvertisement (#3897)", () => {
  const NOW = 1_000;
  const LIFETIME_MS = 9_000;

  it("advertises the admitted definitions, pinned by the tool-set digest and runtime version", () => {
    const tools = nativeAdvertisedTools();
    const advertisement = createOpenCodeNativeToolAdvertisement(tools, NOW, LIFETIME_MS);
    expect(advertisement.kind).toBe("native");
    expect(advertisement.runtime).toEqual({ id: "opencode", version: OPENCODE_PINNED_VERSION });
    expect(advertisement.tools).toEqual(tools);
    expect(advertisement.toolSetDigest).toBe(openCodeNativeToolSetDigest(tools));
    expect(advertisement.offered.expiresAt).toBe(new Date(NOW + LIFETIME_MS).toISOString());
    expect(advertisement.offered.offerId).toMatch(/^opencode-native-[0-9a-f-]{36}$/u);
  });

  it("produces an advertisement the gateway contract admits, for the producer's whole inventory", () => {
    const advertisement = createOpenCodeNativeToolAdvertisement(
      nativeAdvertisedTools(),
      NOW,
      LIFETIME_MS,
    );
    expect(isGatewayNativeToolAdvertisement(advertisement)).toBe(true);
  });

  // #3908 AC4: the committed capture of the pinned 2.1.4 producer's model-visible tools, which the
  // real-binary qualification compares against the live advertisement on every pinned run.
  it("admits the pinned 2.1.4 producer's captured tools, each native one a classified tool", () => {
    const captured = JSON.parse(
      readFileSync(
        new URL("./opencodeToolSchemas.opencode-2.1.4-advertised.fixture.json", import.meta.url),
        "utf8",
      ),
    ) as readonly RealAdvertisedTool[];
    const tools = captured.map(({ name, parameters }) => ({ name, description: "", parameters }));
    const advertisement = createOpenCodeNativeToolAdvertisement(tools, NOW, LIFETIME_MS);
    expect(isGatewayNativeToolAdvertisement(advertisement)).toBe(true);
    const classified = new Set(OPENCODE_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.id));
    const native = captured.map(({ name }) => name).filter((name) => !name.startsWith("keiko_"));
    expect(native.filter((name) => !classified.has(name))).toEqual([]);
  });

  it("forwards only name, description and parameters of each tool, as independent wrappers", () => {
    const input: NativeAdvertisedTool = nativeTool("read", { properties: { path: {} } });
    const carrying = { ...input, handler: "/usr/bin/anything", authority: "root" };
    const advertisement = createOpenCodeNativeToolAdvertisement([carrying], NOW, LIFETIME_MS);
    const [forwarded] = advertisement.tools;
    expect(Object.keys(forwarded ?? {}).sort()).toEqual(["description", "name", "parameters"]);
    expect(forwarded).toEqual(input);
    expect(forwarded).not.toBe(carrying);
    expect(isGatewayNativeToolAdvertisement(advertisement)).toBe(true);
  });

  it("issues a distinct offer identity per call and an expiry from the supplied clock", () => {
    const tools = nativeAdvertisedTools();
    const first = createOpenCodeNativeToolAdvertisement(tools, NOW, LIFETIME_MS);
    const second = createOpenCodeNativeToolAdvertisement(tools, NOW, LIFETIME_MS);
    expect(first.offered.offerId).not.toBe(second.offered.offerId);
    expect(first.toolSetDigest).toBe(second.toolSetDigest);
    const later = createOpenCodeNativeToolAdvertisement(tools, NOW + 60_000, 1);
    expect(later.offered.expiresAt).toBe(new Date(NOW + 60_001).toISOString());
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses the offer lifetime %s",
    (lifetime) => {
      expect(() =>
        createOpenCodeNativeToolAdvertisement(nativeAdvertisedTools(), NOW, lifetime),
      ).toThrow(
        new RangeError("the gateway offer lifetime must be a positive number of milliseconds"),
      );
    },
  );

  it.each([
    ["no tools", []],
    ["a repeated tool", [nativeTool("read"), nativeTool("read")]],
    ["an inadmissible tool name", [nativeTool("read file")]],
    [
      "an oversized schema",
      [
        nativeTool(
          "read",
          parametersOfUtf8Bytes(OPENCODE_NATIVE_TOOL_CONTRACT_MAX_SCHEMA_BYTES + 1),
        ),
      ],
    ],
    ["too many tools", uniquelyNamed(OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOOLS + 1)],
  ])("refuses to advertise %s", (_label, tools) => {
    expect(() => createOpenCodeNativeToolAdvertisement(tools, NOW, LIFETIME_MS)).toThrow(
      new TypeError("native-tool-contract-invalid"),
    );
  });

  it("checks the offer lifetime before the tool contract", () => {
    expect(() => createOpenCodeNativeToolAdvertisement([], NOW, 0)).toThrow(RangeError);
  });
});
