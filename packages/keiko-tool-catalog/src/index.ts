export { ToolCatalogError } from "./errors.js";
export type { CatalogFailureReason } from "./errors.js";
export { createToolRef } from "./identity.js";
export { createToolDescriptor, verifyToolDescriptor } from "./descriptor.js";
export { createCatalogProfileDeclaration } from "./profile.js";
export { createToolCatalog, lookupCatalogTool, verifyToolCatalogSnapshot } from "./catalog.js";
export type { ToolCatalog, CatalogCompilationContext } from "./catalog.js";
export {
  compileToolProjection,
  createCatalogManifest,
  gatewayToolDefinitions,
} from "./projection.js";
export { CATALOG_DIALECTS } from "./dialect.js";
export { validateToolResultEnvelope } from "./result.js";
export type { ToolResultValidationBinding } from "./result.js";

export { createInitialToolCatalog, legacyNativeRegistrationSet } from "./legacy.js";
export { childRegistrationSet, CHILD_WORKSPACE_READ_ALIAS } from "./child.js";
export { createKeikoToolCatalog } from "./composer.js";
export type { CatalogRegistrationSet, CatalogSetEntry } from "./composer.js";
export { assertIdentityCompatibility, assertCompatibilityTime } from "./compatibility.js";
export { validateToolArguments } from "./arguments.js";
export { copyCatalogJson as captureCatalogJson, catalogBytes as catalogJsonBytes } from "./json.js";
export { createToolInvocationNormalizer } from "./invocation.js";
export type { ToolInvocationNormalizer } from "./invocation.js";
