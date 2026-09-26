import type { ToolInvocationBinding } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  type CatalogJsonObject,
  type CompiledCatalogTool,
  type CompiledToolProjection,
  type ToolRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  BoundToolInvocation,
  OfferedToolSet,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import { compileToolProjection } from "./projection.js";
import { lookupCatalogTool, verifyToolCatalogSnapshot } from "./catalog.js";
import { validateToolArguments } from "./arguments.js";
import { assertCompatibilityTime } from "./compatibility.js";
import { catalogDigest, toolRefFrom, toolRefKey, versionRefFrom } from "./identity.js";
import {
  catalogArray,
  catalogObject,
  catalogString,
  copyCatalogJson,
  exactCatalogKeys,
} from "./json.js";
import { requireCatalog } from "./errors.js";

export interface ToolInvocationNormalizer {
  readonly binding: ToolInvocationBinding;
  readonly tools: (referenceTimeMs: number) => readonly CompiledCatalogTool[];
  readonly normalize: (input: unknown, referenceTimeMs: number) => BoundToolInvocation;
  /** Provider aliases are mapped only through the exact server-supplied advertised projection. */
  readonly bindAlias: (
    alias: string,
    argumentsValue: unknown,
    referenceTimeMs: number,
  ) => BoundToolInvocation;
}
const ID = /^[A-Za-z0-9_.-]{1,128}$/u;
function instant(value: unknown): number {
  requireCatalog(typeof value === "string", "invalid-shape");
  const parsed = Date.parse(value);
  requireCatalog(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value,
    "invalid-shape",
  );
  return parsed;
}
function identifier(value: unknown): string {
  requireCatalog(typeof value === "string" && ID.test(value), "invalid-shape");
  return value;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalise(left) === canonicalise(right);
}
function offeredRefs(
  value: CatalogJsonObject,
  projection: CompiledToolProjection,
): readonly ToolRef[] {
  const refs = catalogArray(value.toolRefs).map(toolRefFrom);
  const keys = refs.map(toolRefKey);
  requireCatalog(new Set(keys).size === keys.length, "duplicate-identity");
  requireCatalog(
    refs.every((ref) => projection.tools.some((tool) => same(tool.toolRef, ref))),
    "invalid-identity",
  );
  return refs;
}
function captureOffer(value: unknown, projection: CompiledToolProjection): OfferedToolSet {
  const offer = catalogObject(copyCatalogJson(value));
  exactCatalogKeys(offer, ["binding", "offerId", "toolRefs", "expiresAt"]);
  const binding = catalogObject(offer.binding);
  exactCatalogKeys(binding, [
    "catalogRevision",
    "profile",
    "projectionDigest",
    "handlerSetDigest",
    "readiness",
  ]);
  requireCatalog(
    binding.catalogRevision === projection.catalogRevision &&
      binding.projectionDigest === projection.projectionDigest &&
      same(binding.profile, projection.profile),
    "invalid-identity",
  );
  const refs = offeredRefs(offer, projection);
  requireCatalog(
    binding.readiness === "ready" ||
      (binding.readiness === "unavailable" && refs.length < projection.tools.length) ||
      (refs.length === 0 &&
        ["unavailable", "dry-run", "unsupported", "mismatch"].includes(
          catalogString(binding.readiness),
        )),
    "invalid-identity",
  );
  catalogDigest(binding.handlerSetDigest);
  identifier(offer.offerId);
  instant(offer.expiresAt);
  return deepFreeze({ ...offer, toolRefs: refs }) as unknown as OfferedToolSet;
}
function captureBinding(input: ToolInvocationBinding): ToolInvocationBinding {
  const object = catalogObject(copyCatalogJson(input));
  exactCatalogKeys(object, ["catalog", "projection", "offered"]);
  const catalog = verifyToolCatalogSnapshot(object.catalog);
  const supplied = catalogObject(object.projection);
  const projection = compileToolProjection(catalog, versionRefFrom(supplied.profile));
  requireCatalog(same(supplied, projection), "invalid-identity");
  return deepFreeze({ catalog, projection, offered: captureOffer(object.offered, projection) });
}
function assertLive(binding: ToolInvocationBinding, now: number): void {
  requireCatalog(Number.isSafeInteger(now) && now >= 0, "invalid-compatibility");
  requireCatalog(instant(binding.offered.expiresAt) > now, "expired-compatibility");
  const profile = binding.catalog.profiles.find((item) =>
    same(item.profile, binding.projection.profile),
  );
  requireCatalog(profile !== undefined, "invalid-identity");
  for (const entry of profile.compatibility) assertCompatibilityTime(entry, now);
}
function selectedTools(
  binding: ToolInvocationBinding,
  now: number,
): readonly CompiledCatalogTool[] {
  assertLive(binding, now);
  return Object.freeze(
    binding.projection.tools.filter((tool) =>
      binding.offered.toolRefs.some((ref) => same(ref, tool.toolRef)),
    ),
  );
}
function invocation(
  binding: ToolInvocationBinding,
  ref: ToolRef,
  args: unknown,
  now: number,
): BoundToolInvocation {
  requireCatalog(
    selectedTools(binding, now).some((tool) => same(tool.toolRef, ref)),
    "invalid-identity",
  );
  const descriptor = lookupCatalogTool(binding.catalog, ref);
  requireCatalog(descriptor !== undefined, "invalid-identity");
  return deepFreeze({
    kind: "bound",
    toolRef: descriptor.toolRef,
    projectionDigest: binding.projection.projectionDigest,
    offerId: binding.offered.offerId,
    arguments: validateToolArguments(args, descriptor),
  });
}
function aliasInvocation(
  binding: ToolInvocationBinding,
  alias: string,
  args: unknown,
  now: number,
): BoundToolInvocation {
  const tool = selectedTools(binding, now).find((entry) => entry.alias === alias);
  requireCatalog(tool !== undefined, "invalid-identity");
  return invocation(binding, tool.toolRef, args, now);
}
function normalize(
  binding: ToolInvocationBinding,
  input: unknown,
  now: number,
): BoundToolInvocation {
  const value = catalogObject(copyCatalogJson(input));
  assertLive(binding, now);
  exactCatalogKeys(value, ["kind", "toolRef", "projectionDigest", "offerId", "arguments"]);
  requireCatalog(
    value.kind === "bound" &&
      value.projectionDigest === binding.projection.projectionDigest &&
      value.offerId === binding.offered.offerId,
    "invalid-identity",
  );
  return invocation(binding, toolRefFrom(value.toolRef), value.arguments, now);
}
/** Captures immutable content, not authority; runtime dispatch still re-enters the binding owner. */
export function createToolInvocationNormalizer(
  input: ToolInvocationBinding,
): ToolInvocationNormalizer {
  const binding = captureBinding(input);
  return Object.freeze({
    binding,
    tools: (now: number): readonly CompiledCatalogTool[] => selectedTools(binding, now),
    normalize: (value: unknown, now: number): BoundToolInvocation => normalize(binding, value, now),
    bindAlias: (alias: string, args: unknown, now: number): BoundToolInvocation =>
      aliasInvocation(binding, alias, args, now),
  });
}
