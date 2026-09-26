import {
  TOOL_CATALOG_LIMITS,
  type CatalogActionMapping,
  type CatalogEffect,
  type CatalogHandlerRequirement,
  type CatalogJsonObject,
  type CatalogJsonValue,
  type ToolDescriptor,
  type ToolDescriptorDeclaration,
  type ToolResultBounds,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { CODING_WORKBENCH_ACTION_CLASSES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import {
  catalogArray,
  catalogObject,
  catalogPositive,
  catalogString,
  copyCatalogJson,
  exactCatalogKeys,
} from "./json.js";
import { catalogBindingReference, semanticDigest, toolRefFrom } from "./identity.js";
import { requireCatalog } from "./errors.js";
import { compileCatalogSchema } from "./schema.js";

const EFFECTS: ReadonlySet<string> = new Set(CODING_WORKBENCH_ACTION_CLASSES);
const DECLARATION_KEYS = [
  "toolRef",
  "description",
  "inputSchema",
  "resultSchema",
  "effects",
  "actionMapping",
  "policyReferences",
  "handlerRequirement",
  "bounds",
  "idempotency",
  "cancellation",
] as const;

function uniqueStrings(value: CatalogJsonValue | undefined): readonly string[] {
  const strings = catalogArray(value).map(catalogBindingReference);
  requireCatalog(
    strings.length > 0 && new Set(strings).size === strings.length,
    "duplicate-identity",
  );
  return [...strings].sort(compareStrings);
}

function effectsFrom(value: CatalogJsonValue | undefined): readonly CatalogEffect[] {
  const effects = uniqueStrings(value);
  requireCatalog(
    effects.every((effect) => EFFECTS.has(effect)),
    "ambiguous-effects",
  );
  return effects as readonly CatalogEffect[];
}

function actionMappings(
  value: CatalogJsonValue | undefined,
  effects: readonly CatalogEffect[],
): readonly CatalogActionMapping[] {
  const mappings = catalogArray(value).map((entry): CatalogActionMapping => {
    const mapping = catalogObject(entry);
    exactCatalogKeys(mapping, ["action", "effects"]);
    return {
      action: catalogBindingReference(mapping.action),
      effects: effectsFrom(mapping.effects),
    };
  });
  requireCatalog(
    mappings.length > 0 &&
      new Set(mappings.map((mapping) => mapping.action)).size === mappings.length,
    "ambiguous-effects",
  );
  const mappedEffects = new Set(mappings.flatMap((mapping) => mapping.effects));
  requireCatalog(
    mappedEffects.size === effects.length && effects.every((effect) => mappedEffects.has(effect)),
    "ambiguous-effects",
  );
  return mappings.sort((left, right) => compareStrings(left.action, right.action));
}

export function resultBoundsFrom(value: CatalogJsonValue | undefined): ToolResultBounds {
  requireCatalog(value !== undefined, "missing-bounds");
  const bounds = catalogObject(value);
  exactCatalogKeys(bounds, [
    "maxArgumentBytes",
    "maxResultBytes",
    "maxResultCount",
    "maxDurationMs",
  ]);
  return {
    maxArgumentBytes: catalogPositive(
      bounds.maxArgumentBytes,
      TOOL_CATALOG_LIMITS.maxArgumentBytes,
    ),
    maxResultBytes: catalogPositive(bounds.maxResultBytes, TOOL_CATALOG_LIMITS.maxResultBytes),
    maxResultCount: catalogPositive(bounds.maxResultCount, TOOL_CATALOG_LIMITS.maxArrayItems),
    maxDurationMs: catalogPositive(bounds.maxDurationMs),
  };
}

function handlerFrom(value: CatalogJsonValue | undefined): CatalogHandlerRequirement {
  const handler = catalogObject(value);
  exactCatalogKeys(handler, ["id", "contractVersion"]);
  return {
    id: catalogBindingReference(handler.id),
    contractVersion: catalogPositive(handler.contractVersion),
  };
}

function declarationFrom(object: CatalogJsonObject): ToolDescriptorDeclaration {
  exactCatalogKeys(object, DECLARATION_KEYS);
  const effects = effectsFrom(object.effects);
  requireCatalog(
    object.idempotency === "read-only" || object.idempotency === "server-key-required",
    "invalid-shape",
  );
  requireCatalog(
    object.cancellation === "cooperative" || object.cancellation === "before-effect",
    "invalid-shape",
  );
  if (object.idempotency === "read-only")
    requireCatalog(
      effects.every((effect) => effect === "workspace-read"),
      "ambiguous-effects",
    );
  return {
    toolRef: toolRefFrom(object.toolRef),
    description: catalogString(object.description),
    inputSchema: compileCatalogSchema(object.inputSchema),
    resultSchema: compileCatalogSchema(object.resultSchema),
    effects,
    actionMapping: actionMappings(object.actionMapping, effects),
    policyReferences: uniqueStrings(object.policyReferences),
    handlerRequirement: handlerFrom(object.handlerRequirement),
    bounds: resultBoundsFrom(object.bounds),
    idempotency: object.idempotency,
    cancellation: object.cancellation,
  };
}

export function createToolDescriptor(value: unknown, previous?: ToolDescriptor): ToolDescriptor {
  const declaration = declarationFrom(catalogObject(copyCatalogJson(value)));
  const descriptorDigest = semanticDigest("keiko.tool-descriptor.v1", declaration);
  if (previous !== undefined) {
    const prior = verifyToolDescriptor(previous);
    requireCatalog(
      prior.toolRef.canonicalId === declaration.toolRef.canonicalId,
      "incompatible-version",
    );
    requireCatalog(
      declaration.toolRef.contractVersion >= prior.toolRef.contractVersion,
      "incompatible-version",
    );
    if (declaration.toolRef.contractVersion === prior.toolRef.contractVersion)
      requireCatalog(descriptorDigest === prior.descriptorDigest, "incompatible-version");
  }
  return deepFreeze({ ...declaration, descriptorDigest });
}

export function verifyToolDescriptor(value: unknown): ToolDescriptor {
  const object = catalogObject(copyCatalogJson(value));
  exactCatalogKeys(object, [...DECLARATION_KEYS, "descriptorDigest"]);
  const { descriptorDigest, ...declaration } = object;
  const descriptor = createToolDescriptor(declaration);
  requireCatalog(descriptor.descriptorDigest === descriptorDigest, "invalid-identity");
  return descriptor;
}
