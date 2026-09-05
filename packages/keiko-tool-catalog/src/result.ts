import {
  TOOL_CATALOG_LIMITS,
  TOOL_PAGE_REASONS,
  TOOL_RESULT_REASONS,
  type CatalogDigest,
  type CatalogJsonObject,
  type CatalogJsonValue,
  type ToolDescriptor,
  type ToolResultEnvelope,
  type ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import {
  catalogBytes,
  catalogObject,
  catalogString,
  copyCatalogJson,
  exactCatalogKeys,
} from "./json.js";
import { catalogDigest, toolRefFrom, toolRefKey } from "./identity.js";
import { verifyToolDescriptor } from "./descriptor.js";
import { matchesCatalogSchema } from "./schema.js";
import { requireCatalog, ToolCatalogError } from "./errors.js";

export interface ToolResultValidationBinding {
  readonly descriptor: ToolDescriptor;
  readonly projectionDigest: CatalogDigest;
}
const PAGE_REASONS: ReadonlySet<string> = new Set(TOOL_PAGE_REASONS);

function boundedMetric(value: CatalogJsonValue | undefined, maximum: number): void {
  requireCatalog(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum,
    "result-contract-failed",
  );
}

function validateMetrics(
  value: CatalogJsonValue | undefined,
  binding: ToolResultValidationBinding | undefined,
): CatalogJsonObject {
  const metrics = catalogObject(value);
  exactCatalogKeys(metrics, ["inputBytes", "outputBytes", "resultCount", "durationMs"]);
  boundedMetric(
    metrics.inputBytes,
    binding?.descriptor.bounds.maxArgumentBytes ?? TOOL_CATALOG_LIMITS.maxArgumentBytes,
  );
  boundedMetric(
    metrics.outputBytes,
    binding?.descriptor.bounds.maxResultBytes ?? TOOL_CATALOG_LIMITS.maxResultBytes,
  );
  boundedMetric(
    metrics.resultCount,
    binding?.descriptor.bounds.maxResultCount ?? TOOL_CATALOG_LIMITS.maxArrayItems,
  );
  boundedMetric(metrics.durationMs, Number.MAX_SAFE_INTEGER);
  return metrics;
}

function validatePage(value: CatalogJsonValue | undefined): void {
  const page = catalogObject(value);
  exactCatalogKeys(page, ["truncated", "reason", "cursor"]);
  requireCatalog(
    typeof page.truncated === "boolean" && PAGE_REASONS.has(catalogString(page.reason)),
    "result-contract-failed",
  );
  requireCatalog(page.truncated === (page.reason !== "none"), "result-contract-failed");
  if (!page.truncated) requireCatalog(page.cursor === null, "result-contract-failed");
  if (page.cursor !== null) {
    const cursor = catalogString(page.cursor);
    requireCatalog(
      cursor.length <= TOOL_CATALOG_LIMITS.maxCursorBytes && /^[A-Za-z0-9_-]+$/u.test(cursor),
      "result-contract-failed",
    );
  }
}

function validateIdentity(
  object: CatalogJsonObject,
  binding: ToolResultValidationBinding | undefined,
): void {
  requireCatalog(
    object.schemaVersion === 1 && typeof object.effectStarted === "boolean",
    "result-contract-failed",
  );
  const id = catalogString(object.invocationId);
  requireCatalog(id.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(id), "result-contract-failed");
  if (object.toolRef !== null) toolRefFrom(object.toolRef);
  if (object.projectionDigest !== null) catalogDigest(object.projectionDigest);
  if (object.toolRef === null || object.projectionDigest === null)
    requireCatalog(
      !object.effectStarted && object.status !== "completed",
      "result-contract-failed",
    );
  if (binding !== undefined) {
    requireCatalog(
      object.toolRef !== null &&
        toolRefKey(toolRefFrom(object.toolRef)) === toolRefKey(binding.descriptor.toolRef),
      "result-contract-failed",
    );
    requireCatalog(object.projectionDigest === binding.projectionDigest, "result-contract-failed");
  }
}

function validateOutcome(
  object: CatalogJsonObject,
  binding: ToolResultValidationBinding | undefined,
): void {
  const status = catalogString(object.status);
  requireCatalog(Object.hasOwn(TOOL_RESULT_REASONS, status), "result-contract-failed");
  const reasons: readonly string[] = TOOL_RESULT_REASONS[status as ToolResultStatus];
  requireCatalog(reasons.includes(catalogString(object.reason)), "result-contract-failed");
  const metrics = validateMetrics(object.metrics, binding);
  if (status !== "completed") {
    requireCatalog(object.data === null && object.page === null, "result-contract-failed");
    return;
  }
  requireCatalog(binding !== undefined && object.data !== undefined, "result-contract-failed");
  validatePage(object.page);
  requireCatalog(
    matchesCatalogSchema(binding.descriptor.resultSchema, object.data),
    "result-contract-failed",
  );
  requireCatalog(metrics.outputBytes === catalogBytes(object.data), "result-contract-failed");
}

/** Pure envelope qualification. Cursor storage, authority, invocation settlement and clocks stay out. */
export function validateToolResultEnvelope(
  value: unknown,
  binding?: ToolResultValidationBinding,
): ToolResultEnvelope {
  try {
    const qualified =
      binding === undefined
        ? undefined
        : { ...binding, descriptor: verifyToolDescriptor(binding.descriptor) };
    const object = catalogObject(
      copyCatalogJson(value, qualified?.descriptor.bounds.maxResultBytes),
    );
    exactCatalogKeys(object, [
      "schemaVersion",
      "invocationId",
      "toolRef",
      "projectionDigest",
      "status",
      "reason",
      "effectStarted",
      "metrics",
      "page",
      "data",
    ]);
    validateIdentity(object, qualified);
    validateOutcome(object, qualified);
    return deepFreeze(object) as unknown as ToolResultEnvelope;
  } catch (error) {
    if (error instanceof ToolCatalogError && error.reason === "result-contract-failed") throw error;
    throw new ToolCatalogError("result-contract-failed");
  }
}
