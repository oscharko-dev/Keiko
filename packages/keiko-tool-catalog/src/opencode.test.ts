import { describe, expect, it } from "vitest";
import { opencodeRegistrationSet, OPENCODE_NATIVE_EXTENSION_DEFINITIONS } from "./opencode.js";
import { createKeikoToolCatalog } from "./composer.js";
import { compileToolProjection, gatewayToolDefinitions } from "./projection.js";

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

  it("declares exactly fifteen governed tools with unique canonical identities and aliases", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.tools).toHaveLength(15);
    const canonicalIds = projection.tools.map((tool) => tool.toolRef.canonicalId);
    const aliases = projection.tools.map((tool) => tool.alias);
    expect(new Set(canonicalIds).size).toBe(15);
    expect(new Set(aliases).size).toBe(15);
  });

  it("classifies push, pull-request and CI observation as delivery-substrate with network-egress, matching gitOperationRequirements.ts", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    for (const alias of ["keiko_git_push", "keiko_pull_request", "keiko_ci_status"]) {
      const tool = projection.tools.find((entry) => entry.alias === alias);
      if (tool === undefined) throw new Error(`Missing tool: ${alias}`);
      expect([...tool.effects].sort()).toEqual(["delivery-substrate", "network-egress"].sort());
    }
    const stage = projection.tools.find((entry) => entry.alias === "keiko_git_stage");
    expect(stage?.effects).toEqual(["workspace-write"]);
    const status = projection.tools.find((entry) => entry.alias === "keiko_git_status");
    expect(status?.effects).toEqual(["workspace-read"]);
    // Matches gitOperationRequirements.ts's COMMIT_REQUIREMENT: a local commit is
    // delivery-substrate but never network-egress (the model proposes; it never touches a remote).
    const commit = projection.tools.find((entry) => entry.alias === "keiko_git_commit");
    expect(commit?.effects).toEqual(["delivery-substrate"]);
    // keiko_git_execute redeems any approved stage/commit/push/pull-request proposal; its own
    // declared effect is the shared delivery-substrate floor, never network-egress by itself --
    // the redeemed action's own effects (e.g. push's network-egress) apply at execution time.
    const execute = projection.tools.find((entry) => entry.alias === "keiko_git_execute");
    expect(execute?.effects).toEqual(["delivery-substrate"]);
  });

  it("never registers the repository-search identity (H1 handler not yet bound)", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    const canonicalIds = projection.tools.map((tool) => tool.toolRef.canonicalId);
    expect(canonicalIds).not.toContain("keiko.repo.search");
    expect(projection.tools.map((tool) => tool.alias)).not.toContain("keiko_repository_search");
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
    expect(definitions).toHaveLength(15);
    expect(new Set(definitions.map((tool) => tool.name)).size).toBe(15);
    for (const tool of definitions) expect(tool.description.length).toBeGreaterThan(0);
  });

  it("is stable across calls (no I/O, no hidden mutable state)", () => {
    const first = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const second = createKeikoToolCatalog([opencodeRegistrationSet()]);
    expect(first.catalogRevision).toBe(second.catalogRevision);
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
