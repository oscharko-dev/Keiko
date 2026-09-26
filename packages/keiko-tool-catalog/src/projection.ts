import type {
  CatalogManifest,
  CatalogProfile,
  CatalogVersionRef,
  CompiledCatalogTool,
  CompiledToolProjection,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { catalogObject, copyCatalogJson } from "./json.js";
import { semanticDigest, versionRefFrom } from "./identity.js";
import { lookupCatalogTool, verifyToolCatalogSnapshot, type ToolCatalog } from "./catalog.js";
import { projectCatalogSchema } from "./dialect.js";
import { requireCatalog } from "./errors.js";

function descriptorProjection(
  descriptor: ToolDescriptor,
  profile: CatalogProfile,
  alias: string,
): CompiledCatalogTool {
  return {
    ...descriptor,
    alias,
    inputSchema: projectCatalogSchema(descriptor.inputSchema, profile.adapterDialect, true),
    resultSchema: projectCatalogSchema(descriptor.resultSchema, profile.adapterDialect, false),
  };
}

function projectionSemanticTool(tool: CompiledCatalogTool): unknown {
  return {
    toolRef: tool.toolRef,
    alias: tool.alias,
    description: tool.description,
    inputSchema: tool.inputSchema,
    resultSchema: tool.resultSchema,
    effects: tool.effects,
    actionMapping: tool.actionMapping,
    policyReferences: tool.policyReferences,
    handlerRequirement: tool.handlerRequirement,
    bounds: tool.bounds,
    descriptorDigest: tool.descriptorDigest,
  };
}

export function compileToolProjection(
  source: ToolCatalog,
  ref: CatalogVersionRef,
): CompiledToolProjection {
  const catalog = verifyToolCatalogSnapshot(source);
  const reference = versionRefFrom(copyCatalogJson(ref));
  const profile = catalog.profiles.find(
    (candidate) =>
      candidate.profile.id === reference.id && candidate.profile.version === reference.version,
  );
  requireCatalog(profile?.catalogRevision === catalog.catalogRevision, "invalid-identity");
  const tools = profile.toolRefs.map((entry): CompiledCatalogTool => {
    const descriptor = lookupCatalogTool(catalog, entry.toolRef);
    requireCatalog(descriptor !== undefined, "invalid-identity");
    return descriptorProjection(descriptor, profile, entry.alias);
  });
  const projectionDigest = semanticDigest("keiko.tool-projection.v1", {
    catalogRevision: catalog.catalogRevision,
    profile: profile.profile,
    adapterDialect: profile.adapterDialect,
    adapterRuntime: profile.adapterRuntime,
    nativeExtensions: profile.nativeExtensions,
    tools: tools.map(projectionSemanticTool),
    compatibility: profile.compatibility,
  });
  return deepFreeze({
    catalogRevision: catalog.catalogRevision,
    profile: profile.profile,
    adapterDialect: profile.adapterDialect,
    adapterRuntime: profile.adapterRuntime,
    nativeExtensions: profile.nativeExtensions,
    tools,
    projectionDigest,
  });
}

/** Transport materialization contains only compiler-owned fields, never handler availability. */
export function gatewayToolDefinitions(
  catalog: ToolCatalog,
  profile: CatalogVersionRef,
): readonly ToolDefinition[] {
  const projection = compileToolProjection(catalog, profile);
  return deepFreeze(
    projection.tools.map((tool) => ({
      name: tool.alias,
      description: tool.description,
      parameters: catalogObject(copyCatalogJson(tool.inputSchema)),
    })),
  );
}

export function createCatalogManifest(
  catalog: ToolCatalog,
  projection: CompiledToolProjection,
): CatalogManifest {
  const profile = catalog.profiles.find(
    (entry) =>
      entry.profile.id === projection.profile.id &&
      entry.profile.version === projection.profile.version,
  );
  requireCatalog(profile !== undefined, "invalid-identity");
  const expected = compileToolProjection(catalog, projection.profile);
  requireCatalog(expected.projectionDigest === projection.projectionDigest, "invalid-identity");
  return deepFreeze({
    schemaVersion: 1,
    catalogRevision: expected.catalogRevision,
    profile: expected.profile,
    projectionDigest: expected.projectionDigest,
    toolRefs: expected.tools.map((tool) => tool.toolRef),
    descriptorDigests: expected.tools.map((tool) => tool.descriptorDigest),
    bounds: expected.tools.map((tool) => tool.bounds),
    compatibility: profile.compatibility,
  });
}
