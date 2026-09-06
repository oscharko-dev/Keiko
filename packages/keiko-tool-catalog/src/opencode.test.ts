import { describe, expect, it } from "vitest";
import { opencodeRegistrationSet, OPENCODE_NATIVE_EXTENSION_DEFINITIONS } from "./opencode.js";
import { createKeikoToolCatalog } from "./composer.js";
import { compileToolProjection, gatewayToolDefinitions } from "./projection.js";
import { matchesCatalogSchema } from "./schema.js";

const OPENCODE_PROFILE = { id: "opencode", version: 1 } as const;

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

/** Recursively asserts the managed-runtime dialect's stripped/all-required transform held. */
function assertManagedShape(schema: unknown): void {
  if (!isRecord(schema)) return;
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBeUndefined();
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

  it("declares exactly sixteen governed tools with unique canonical identities and aliases", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.tools).toHaveLength(16);
    const canonicalIds = projection.tools.map((tool) => tool.toolRef.canonicalId);
    const aliases = projection.tools.map((tool) => tool.alias);
    expect(new Set(canonicalIds).size).toBe(16);
    expect(new Set(aliases).size).toBe(16);
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
    expect(tool.effects).toEqual(["workspace-read"]);
  });

  it("declares question and todowrite as native extensions, never as tool descriptors", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.nativeExtensions).toEqual([
      { alias: "question", contractVersion: 1 },
      { alias: "todowrite", contractVersion: 1 },
    ]);
    expect(projection.tools.map((tool) => tool.alias)).not.toContain("question");
    expect(projection.tools.map((tool) => tool.alias)).not.toContain("todowrite");
  });

  it("pins the managed-runtime dialect: opencode 1.17.17, every projected schema all-required and additionalProperties stripped", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.adapterDialect).toEqual({ id: "managed-runtime-json-schema", version: 1 });
    expect(projection.adapterRuntime).toEqual({ id: "opencode", version: "1.17.17" });
    for (const tool of projection.tools) assertManagedShape(tool.inputSchema);
  });

  it("is the source coding-sidecar-gateway.ts derives its outgoing gateway advertisement from", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const definitions = gatewayToolDefinitions(catalog, OPENCODE_PROFILE);
    expect(definitions).toHaveLength(16);
    expect(new Set(definitions.map((tool) => tool.name)).size).toBe(16);
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
});

describe("OPENCODE_NATIVE_EXTENSION_DEFINITIONS", () => {
  it("is the single source for the profile's declared native extensions", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.nativeExtensions).toEqual(
      OPENCODE_NATIVE_EXTENSION_DEFINITIONS.map(({ alias, contractVersion }) => ({
        alias,
        contractVersion,
      })),
    );
  });

  it("declares exactly question and todowrite, each with a non-empty description and an object schema", () => {
    expect(OPENCODE_NATIVE_EXTENSION_DEFINITIONS.map((entry) => entry.alias).sort()).toEqual([
      "question",
      "todowrite",
    ]);
    for (const entry of OPENCODE_NATIVE_EXTENSION_DEFINITIONS) {
      expect(entry.contractVersion).toBe(1);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.inputSchema.type).toBe("object");
    }
  });
});
