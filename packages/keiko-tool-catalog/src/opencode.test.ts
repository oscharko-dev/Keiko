import { describe, expect, it } from "vitest";
import type { CanonicalToolId } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  DEFAULT_SANDBOX_POLICY,
  GOVERNED_APPROVAL_TOOL_MAX_DURATION_MS,
} from "@oscharko-dev/keiko-contracts/runtime/tools";
import {
  DEFAULT_VERIFICATION_LIMITS,
  VERIFICATION_TOOL_MAX_DURATION_MS,
} from "@oscharko-dev/keiko-contracts/runtime/verification";
import { opencodeRegistrationSet, OPENCODE_NATIVE_EXTENSION_DEFINITIONS } from "./opencode.js";
import * as registrationOwners from "./opencode.js";
import { createKeikoToolCatalog } from "./composer.js";
import { compileToolProjection, gatewayToolDefinitions } from "./projection.js";
import { createCatalogProfileDeclaration } from "./profile.js";
import { matchesCatalogSchema } from "./schema.js";

const OPENCODE_PROFILE = { id: "opencode", version: 1 } as const;

// The tools that wait in place for a local human decision (F44): the four proposal tools, and the
// changeset edit, whose diff the operator confirms in the review panel under every mode below full
// access (ADR-0125 D1). The edit tool was missed when F44 swept the others, so it kept the sandbox
// default and every governed edit was cut off at 30 s mid-decision.
const APPROVAL_WAITING_TOOL_IDS: ReadonlySet<string> = new Set([
  "keiko.git.stage",
  "keiko.git.commit",
  "keiko.git.push",
  "keiko.git.pullrequest",
  "keiko.changeset.edit",
]);

const GIT_DELIVERY_CANONICAL_IDS = [
  "keiko.git.status",
  "keiko.git.diff",
  "keiko.git.stage",
  "keiko.git.commit",
  "keiko.git.push",
  "keiko.git.pullrequest",
  "keiko.git.execute",
  "keiko.ci.status",
];
const GIT_DELIVERY_ALIASES = [
  "keiko_git_status",
  "keiko_git_diff",
  "keiko_git_stage",
  "keiko_git_commit",
  "keiko_git_push",
  "keiko_pull_request",
  "keiko_git_execute",
  "keiko_ci_status",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively asserts the managed-runtime dialect's closed/all-required transform held. */
function assertManagedShape(schema: unknown): void {
  if (!isRecord(schema)) return;
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    expect(schema.required).toEqual(Object.keys(properties).sort());
    for (const value of Object.values(properties)) assertManagedShape(value);
  }
  if (schema.type === "array") assertManagedShape(schema.items);
}

describe("opencode registration set", () => {
  it("declares the seven original representable managed tools under their reserved canonical identities", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    const canonicalIds = projection.tools.map((tool) => tool.toolRef.canonicalId);
    const aliases = projection.tools.map((tool) => tool.alias);
    for (const id of [
      "keiko.changeset.edit",
      "keiko.child.run",
      "keiko.research.fetch",
      "keiko.skill.invoke",
      "keiko.verification.run",
      "keiko.workspace.discover",
      "keiko.workspace.read",
    ]) {
      expect(canonicalIds).toContain(id);
    }
    for (const alias of [
      "keiko_changeset_edit",
      "keiko_child_agent",
      "keiko_research_fetch",
      "keiko_skill",
      "keiko_verification",
      "keiko_workspace_discover",
      "keiko_workspace_read",
    ]) {
      expect(aliases).toContain(alias);
    }
  });

  // The catalog settles every governed tool call at its descriptor's `bounds.maxDurationMs`, and
  // every managed tool inherited the sandbox default of 30 s — which no real test or build run
  // fits, so the first verification a Coding Workbench run actually executed would have been cut
  // off as an opaque timeout before it could report (2026-09-10). The same default cut off the four
  // proposal tools while they waited up to five minutes for the operator's approval (F44). The
  // verification tool declares the budget its own enforced limits need, the proposal tools their
  // wait on top of their own work; the others keep the default, so a reader who widened it for
  // everything would fail here too.
  it("gives the verification and the proposal tools the budget their work needs and no other tool more", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    const byId = new Map(projection.tools.map((tool) => [tool.toolRef.canonicalId, tool]));
    const verification = byId.get("keiko.verification.run" as CanonicalToolId);
    expect(verification?.bounds.maxDurationMs).toBe(VERIFICATION_TOOL_MAX_DURATION_MS);
    expect(VERIFICATION_TOOL_MAX_DURATION_MS).toBeGreaterThan(
      DEFAULT_VERIFICATION_LIMITS.wallTimeMs,
    );
    for (const id of APPROVAL_WAITING_TOOL_IDS) {
      expect(byId.get(id as CanonicalToolId)?.bounds.maxDurationMs).toBe(
        GOVERNED_APPROVAL_TOOL_MAX_DURATION_MS,
      );
    }
    for (const [id, tool] of byId) {
      if (id === "keiko.verification.run" || APPROVAL_WAITING_TOOL_IDS.has(id)) continue;
      expect(tool.bounds.maxDurationMs).toBe(DEFAULT_SANDBOX_POLICY.defaultTimeoutMs);
    }
  });

  // #3386/#3387/#3388: the Git status/diff/stage/commit, push/pull-request and CI-observation
  // tools are catalog-registered so the sidecar-gateway's outgoing "toolCatalog" advertisement
  // (built from this same registration set) actually shows them to the real underlying model --
  // without this, a real model could never choose to call them even though the incoming wire
  // dispatch (opencodeToolSchemas.ts / opencodeRuntimeAdapter.ts) is ready to handle a call.
  it("declares all eight #3386/#3387/#3388 Git/CI tools under their canonical identities", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    const canonicalIds = projection.tools.map((tool) => tool.toolRef.canonicalId);
    const aliases = projection.tools.map((tool) => tool.alias);
    for (const id of GIT_DELIVERY_CANONICAL_IDS) expect(canonicalIds).toContain(id);
    for (const alias of GIT_DELIVERY_ALIASES) expect(aliases).toContain(alias);
  });

  it("requires the verification target sentinel on the managed provider wire", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const verification = compileToolProjection(catalog, OPENCODE_PROFILE).tools.find(
      (tool) => tool.alias === "keiko_verification",
    );
    expect(verification?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        targetPath: { type: "string", minLength: 0, maxLength: 4096 },
      },
      required: ["targetPath", "verifierId"],
    });
  });

  it("declares exactly seventeen governed tools with unique canonical identities and aliases", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.tools).toHaveLength(17);
    const canonicalIds = projection.tools.map((tool) => tool.toolRef.canonicalId);
    const aliases = projection.tools.map((tool) => tool.alias);
    expect(new Set(canonicalIds).size).toBe(17);
    expect(new Set(aliases).size).toBe(17);
  });

  // #3417: the catalog owns only the discovery descriptor; it reads, takes no argument, carries the
  // default budget and names its own handler, apart from the invocation it points to.
  it("declares skill discovery as a read-only, argument-free descriptor beside skill invocation", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    const discover = projection.tools.find((tool) => tool.alias === "keiko_skill_discover");
    expect(discover?.toolRef.canonicalId).toBe("keiko.skill.discover");
    expect(discover?.inputSchema).toMatchObject({ type: "object", properties: {} });
    expect(discover?.bounds.maxDurationMs).toBe(DEFAULT_SANDBOX_POLICY.defaultTimeoutMs);
    const entry = opencodeRegistrationSet().entries.find(
      (candidate) => candidate.alias === "keiko_skill_discover",
    );
    expect(entry?.descriptor.effects).toEqual(["workspace-read"]);
    expect(entry?.descriptor.idempotency).toBe("read-only");
    expect(entry?.descriptor.handlerRequirement.id).toBe("opencode-skill-discovery-port");
  });

  it("keeps Git mutation, CI observation, and local skill effects distinct", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    for (const alias of ["keiko_git_push", "keiko_pull_request"]) {
      const tool = projection.tools.find((entry) => entry.alias === alias);
      if (tool === undefined) throw new Error(`Missing tool: ${alias}`);
      expect([...tool.effects].sort()).toEqual(["delivery-substrate", "network-egress"].sort());
    }
    const ci = projection.tools.find((entry) => entry.alias === "keiko_ci_status");
    expect([...(ci?.effects ?? [])].sort()).toEqual(
      ["workspace-read", "connector-access", "network-egress"].sort(),
    );
    const stage = projection.tools.find((entry) => entry.alias === "keiko_git_stage");
    expect(stage?.effects).toEqual(["workspace-write"]);
    const status = projection.tools.find((entry) => entry.alias === "keiko_git_status");
    expect(status?.effects).toEqual(["workspace-read"]);
    // Matches gitOperationRequirements.ts's COMMIT_REQUIREMENT: a local commit is
    // delivery-substrate but never network-egress (the model proposes; it never touches a remote).
    const commit = projection.tools.find((entry) => entry.alias === "keiko_git_commit");
    expect(commit?.effects).toEqual(["delivery-substrate"]);
    const skill = projection.tools.find((entry) => entry.alias === "keiko_skill");
    expect(skill?.effects).toEqual(["workspace-read"]);
    // The redemption descriptor must conservatively cover every kind it can dispatch. Inner
    // per-kind authority checks remain required; they cannot repair an incomplete advertisement.
    const redeemedAliases = new Set([
      "keiko_git_stage",
      "keiko_git_commit",
      "keiko_git_push",
      "keiko_pull_request",
    ]);
    const requiredEffects = new Set(
      projection.tools
        .filter((tool) => redeemedAliases.has(tool.alias))
        .flatMap((tool) => tool.effects),
    );
    const execute = projection.tools.find((entry) => entry.alias === "keiko_git_execute");
    expect(new Set(execute?.effects)).toEqual(requiredEffects);
  });

  // #3414: #3386's H1 local repository-search handler is implemented and mounted server-side, so
  // this issue projects it as the model-visible tool `keiko_repository_search` under its reserved
  // canonical identity `keiko.repo.search@1`. Read-only, search-only: `keiko_workspace_discover`
  // stays path-only and `keiko_workspace_read` remains the bounded-range read handoff.
  it("registers the repository-search identity now that the H1 handler is bound (#3414)", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    const canonicalIds = projection.tools.map((tool) => tool.toolRef.canonicalId);
    expect(canonicalIds).toContain("keiko.repo.search");
    const tool = projection.tools.find((entry) => entry.alias === "keiko_repository_search");
    if (tool === undefined) throw new Error("Missing tool: keiko_repository_search");
    expect(tool.toolRef).toEqual({ canonicalId: "keiko.repo.search", contractVersion: 1 });
    expect(tool.description).toContain("Git repositories and ordinary folders");
    expect(tool.description).not.toContain("tracked workspace text");
    expect(tool.effects).toEqual(["workspace-read"]);
  });

  it("declares question as a native extension, never as a tool descriptor", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.nativeExtensions).toEqual([{ alias: "question", contractVersion: 1 }]);
    expect(projection.tools.map((tool) => tool.alias)).not.toContain("question");
    expect(projection.tools.map((tool) => tool.alias)).not.toContain("todowrite");
  });

  it("pins the managed-runtime dialect: opencode 2.0.10, every projected schema all-required and closed", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.adapterDialect).toEqual({ id: "managed-runtime-json-schema", version: 1 });
    expect(projection.adapterRuntime).toEqual({ id: "opencode", version: "2.0.10" });
    for (const tool of projection.tools) assertManagedShape(tool.inputSchema);
  });

  it("is the source coding-sidecar-gateway.ts derives its outgoing gateway advertisement from", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const definitions = gatewayToolDefinitions(catalog, OPENCODE_PROFILE);
    expect(definitions).toHaveLength(17);
    expect(new Set(definitions.map((tool) => tool.name)).size).toBe(17);
    for (const tool of definitions) expect(tool.description.length).toBeGreaterThan(0);
  });

  it("is stable across calls (no I/O, no hidden mutable state)", () => {
    const first = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const second = createKeikoToolCatalog([opencodeRegistrationSet()]);
    expect(first.catalogRevision).toBe(second.catalogRevision);
  });

  // #3414 AC1: these fields carry the exact real OpenCode wire pattern (opencodeToolSchemas.ts) now
  // that schema.ts supports `pattern`. Fails-before: prior to schema.ts gaining `pattern` support,
  // `compileCatalogSchema` rejected any schema carrying that keyword outright (see
  // validation.test.ts), so this projection could only omit the format check entirely.
  function toolProperties(alias: string): Record<string, unknown> {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    const tool = projection.tools.find((entry) => entry.alias === alias);
    if (tool === undefined) throw new Error(`Missing tool: ${alias}`);
    return (tool.inputSchema as { properties: Record<string, unknown> }).properties;
  }
  it.each([
    ["keiko_workspace_read", "relativePath", "src/index.ts", "../escape"],
    ["keiko_research_fetch", "target", "https://example.com/doc", "http://example.com"],
    ["keiko_skill", "skillId", "skl_a@1", "not-a-skill-id"],
  ])("enforces the real wire pattern for %s.%s", (alias, field, valid, invalid) => {
    const schema = toolProperties(alias)[field];
    expect(matchesCatalogSchema(schema as never, valid)).toBe(true);
    expect(matchesCatalogSchema(schema as never, invalid)).toBe(false);
  });
  it("enforces the real wire pattern for keiko_changeset_edit's expectedContentHash", () => {
    const changeset = toolProperties("keiko_changeset_edit").changeset as {
      properties: { files: { items: { properties: Record<string, unknown> } } };
    };
    const schema = changeset.properties.files.items.properties.expectedContentHash;
    expect(matchesCatalogSchema(schema as never, "a".repeat(64))).toBe(true);
    expect(matchesCatalogSchema(schema as never, "not-a-hash")).toBe(false);
  });

  // #3873 follow-up: the model deletes and moves files through the same closed changeset object.
  // The managed-runtime dialect requires every member, so a call that only edits still names both
  // as empty arrays, and a call that only renames or deletes names no edits at all.
  it("requires deletions and renames as closed changeset members that may be empty (#3873 follow-up)", () => {
    const changeset = toolProperties("keiko_changeset_edit").changeset as {
      required: readonly string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(changeset.required).toEqual(["deletions", "edits", "files", "renames", "selectedFiles"]);
    expect(changeset.properties.edits).not.toHaveProperty("minItems");
    expect(changeset.properties.deletions).toEqual({
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 512 },
    });
    expect(changeset.properties.renames).toEqual({
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          from: { type: "string", minLength: 1, maxLength: 512 },
          to: { type: "string", minLength: 1, maxLength: 512 },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    });
    const files = [{ file: "src/a.ts", expectedContentHash: "a".repeat(64) }];
    const renameOnly = {
      edits: [],
      deletions: [],
      renames: [{ from: "src/a.ts", to: "src/b.ts" }],
      files,
      selectedFiles: ["src/a.ts"],
    };
    expect(matchesCatalogSchema(changeset as never, renameOnly)).toBe(true);
    const withoutDeletions = {
      edits: [],
      renames: renameOnly.renames,
      files,
      selectedFiles: renameOnly.selectedFiles,
    };
    expect(matchesCatalogSchema(changeset as never, withoutDeletions)).toBe(false);
    expect(
      matchesCatalogSchema(changeset as never, {
        ...renameOnly,
        renames: [{ from: "src/a.ts", to: "src/b.ts", mode: "move" }],
      }),
    ).toBe(false);
    const description = opencodeRegistrationSet().entries.find(
      (entry) => entry.alias === "keiko_changeset_edit",
    )?.descriptor.description;
    expect(description).toContain("renames first, then edits");
    expect(description).toContain("then deletions");
  });
});

describe("OPENCODE_NATIVE_EXTENSION_DEFINITIONS", () => {
  it("is the single source for the profile's declared native extensions", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.nativeExtensions).toEqual(
      OPENCODE_NATIVE_EXTENSION_DEFINITIONS.filter((entry) => entry.alias === "question").map(
        ({ alias, contractVersion }) => ({
          alias,
          contractVersion,
        }),
      ),
    );
  });

  it("keeps only question active by default and declares the inactive execute definition", () => {
    expect(opencodeRegistrationSet().nativeExtensions).toEqual([
      { alias: "question", contractVersion: 1 },
    ]);
    expect(OPENCODE_NATIVE_EXTENSION_DEFINITIONS.map((entry) => entry.alias)).toEqual([
      "question",
      "execute",
    ]);
    for (const entry of OPENCODE_NATIVE_EXTENSION_DEFINITIONS) {
      expect(entry.contractVersion).toBe(1);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.inputSchema.type).toBe("object");
    }
  });
});

describe("inactive Code Mode catalog", () => {
  it("keeps all governed descriptors in a separate explicit question/execute profile", () => {
    const direct = opencodeRegistrationSet();
    const grouped = opencodeRegistrationSet("code-mode");
    expect(grouped.entries).toEqual(direct.entries);
    expect(grouped.entries).toHaveLength(17);
    expect(grouped.profile).toEqual({ id: "opencode-code-mode", version: 1 });
    expect(grouped.nativeExtensions).toEqual([
      { alias: "question", contractVersion: 1 },
      { alias: "execute", contractVersion: 1 },
    ]);
  });
});

function codeModeProfileDeclaration(): Record<string, unknown> {
  const set = opencodeRegistrationSet("code-mode");
  const profile = createKeikoToolCatalog([set]).profiles[0];
  if (profile === undefined) throw new TypeError("Missing producer profile");
  return Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "catalogRevision"));
}

describe("closed inactive native extension profile", () => {
  it("compiles the exact governed descriptors and native extensions without granting effects", () => {
    const set = opencodeRegistrationSet("code-mode");
    const catalog = createKeikoToolCatalog([set]);
    const projection = compileToolProjection(catalog, set.profile);
    expect(projection.nativeExtensions).toEqual([
      { alias: "execute", contractVersion: 1 },
      { alias: "question", contractVersion: 1 },
    ]);
    expect(projection.tools.map((tool) => tool.descriptorDigest)).toEqual(
      compileToolProjection(
        createKeikoToolCatalog([opencodeRegistrationSet()]),
        OPENCODE_PROFILE,
      ).tools.map((tool) => tool.descriptorDigest),
    );
    expect(Object.isFrozen(projection.nativeExtensions)).toBe(true);
  });
  it.each([
    { profile: { id: "opencode", version: 1 } },
    { profile: { id: "opencode-code-mode", version: 2 } },
    { adapterRuntime: { id: "opencode", version: "2.0.11" } },
    { adapterRuntime: { id: "keiko", version: "1.1.1" } },
    { nativeExtensions: [{ alias: "execute", contractVersion: 1 }] },
    {
      nativeExtensions: [
        { alias: "question", contractVersion: 1 },
        { alias: "execute", contractVersion: 2 },
      ],
    },
    {
      nativeExtensions: [
        { alias: "question", contractVersion: 1 },
        { alias: "shell", contractVersion: 1 },
      ],
    },
    {
      nativeExtensions: [
        { alias: "question", contractVersion: 1 },
        { alias: "execute", contractVersion: 1 },
        { alias: "execute", contractVersion: 1 },
      ],
    },
  ])("refuses an unqualified or ambiguous native declaration %j", (change) => {
    expect(() =>
      createCatalogProfileDeclaration({ ...codeModeProfileDeclaration(), ...change }),
    ).toThrow();
  });
  it("refuses a caller-supplied unknown profile instead of selecting Code Mode", () => {
    expect(() => {
      Reflect.apply(opencodeRegistrationSet, undefined, ["unknown"]);
    }).toThrow(TypeError);
  });
});

describe("complete explicit Code Mode native declaration", () => {
  it("refuses a qualified profile that lost execute", () => {
    expect(() =>
      createCatalogProfileDeclaration({
        ...codeModeProfileDeclaration(),
        nativeExtensions: [{ alias: "question", contractVersion: 1 }],
      }),
    ).toThrow("unrepresentable-projection");
  });
});

describe("private native text snapshot registration", () => {
  it("compiles one honest path-only private contract without changing model advertisements", () => {
    expect(registrationOwners.nativeTextSnapshotRegistrationSet).toBeTypeOf("function");
    const set = registrationOwners.nativeTextSnapshotRegistrationSet();
    const catalog = createKeikoToolCatalog([set]);
    const projection = compileToolProjection(catalog, set.profile);
    expect(projection.tools).toHaveLength(1);
    const tool = projection.tools[0];
    if (tool === undefined) throw new TypeError("Expected private snapshot descriptor");
    expect(tool.toolRef.canonicalId).toBe("keiko.native.workspace.text.snapshot");
    expect(matchesCatalogSchema(tool.inputSchema, { relativePath: "src/deep/file.ts" })).toBe(true);
    expect(
      matchesCatalogSchema(tool.inputSchema, {
        relativePath: "src/deep/file.ts",
        startLine: 1,
        maxLines: 1,
      }),
    ).toBe(false);
    expect(matchesCatalogSchema(tool.inputSchema, { relativePath: "../secret.ts" })).toBe(false);
    for (const profile of [undefined, "code-mode"] as const) {
      const original = opencodeRegistrationSet(profile);
      expect(
        original.entries.some(
          (entry) => entry.descriptor.toolRef.canonicalId === tool.toolRef.canonicalId,
        ),
      ).toBe(false);
      expect(original.nativeExtensions).not.toContainEqual({
        alias: tool.alias,
        contractVersion: 1,
      });
    }
  });
});

it("compiles an inactive original-read lifetime without advertising another model tool", () => {
  const set = registrationOwners.nativeTextSnapshotRegistrationSet("invocation");
  const projection = compileToolProjection(createKeikoToolCatalog([set]), set.profile);
  const tool = projection.tools[0];
  if (tool === undefined) throw new TypeError("Expected native invocation descriptor");
  expect(tool.toolRef.canonicalId).toBe("keiko.native.workspace.read.invocation");
  const input = {
    relativePath: "src/file.ts",
    context: { sessionID: "session", messageID: "message", id: "call", agent: "build" },
    offset: [],
    limit: [],
  };
  expect(matchesCatalogSchema(tool.inputSchema, input)).toBe(true);
  expect(matchesCatalogSchema(tool.inputSchema, { ...input, offset: [0], limit: [20] })).toBe(true);
  for (const invalid of [
    { ...input, context: { ...input.context, tool: "shell" } },
    { ...input, limit: [0] },
    { ...input, offset: [0, 1] },
    { ...input, relativePath: "../escape" },
    { ...input, capability: "forged" },
  ])
    expect(matchesCatalogSchema(tool.inputSchema, invalid)).toBe(false);
  expect(
    matchesCatalogSchema(tool.resultSchema, {
      status: "completed",
      evidence: [{ kind: "native-read-invocation", code: "completed" }],
    }),
  ).toBe(true);
  expect(
    matchesCatalogSchema(tool.resultSchema, {
      status: "completed",
      evidence: [{ kind: "native-read-invocation", code: "completed" }],
      text: "PRIVATE_BYTES",
    }),
  ).toBe(false);
  for (const profile of [undefined, "code-mode"] as const)
    expect(
      opencodeRegistrationSet(profile).entries.some((entry) => entry.alias === tool.alias),
    ).toBe(false);
});
