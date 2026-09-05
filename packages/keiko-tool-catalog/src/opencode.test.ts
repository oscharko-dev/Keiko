import { describe, expect, it } from "vitest";
import { opencodeRegistrationSet, OPENCODE_NATIVE_EXTENSION_DEFINITIONS } from "./opencode.js";
import { createKeikoToolCatalog } from "./composer.js";
import { compileToolProjection, gatewayToolDefinitions } from "./projection.js";

const OPENCODE_PROFILE = { id: "opencode", version: 1 } as const;

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
  it("declares the seven representable managed tools under their reserved canonical identities", () => {
    const catalog = createKeikoToolCatalog([opencodeRegistrationSet()]);
    const projection = compileToolProjection(catalog, OPENCODE_PROFILE);
    expect(projection.tools.map((tool) => tool.toolRef.canonicalId).sort()).toEqual(
      [
        "keiko.changeset.edit",
        "keiko.child.run",
        "keiko.research.fetch",
        "keiko.skill.invoke",
        "keiko.verification.run",
        "keiko.workspace.discover",
        "keiko.workspace.read",
      ].sort(),
    );
    expect(projection.tools.map((tool) => tool.alias).sort()).toEqual(
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
    expect(definitions).toHaveLength(7);
    expect(new Set(definitions.map((tool) => tool.name)).size).toBe(7);
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
