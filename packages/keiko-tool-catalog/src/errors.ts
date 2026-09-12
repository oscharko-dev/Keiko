export type CatalogFailureReason =
  | "invalid-shape"
  | "input-bound"
  | "invalid-identity"
  | "duplicate-identity"
  | "invalid-schema"
  | "unsupported-schema"
  | "ambiguous-effects"
  | "missing-bounds"
  | "unsupported-dialect"
  | "unrepresentable-projection"
  | "incompatible-version"
  | "invalid-compatibility"
  | "expired-compatibility"
  | "result-contract-failed";

/**
 * Body-free account of why a value fails a compiled catalog schema. Every path is built from the
 * schema's own property names (array items as `[]`, additional properties as `*`), never from the
 * value: the value is caller text and reaches a log or a correction only as the count of properties
 * the schema does not declare. Lists are capped, so a hostile value cannot grow the report.
 */
export interface CatalogSchemaMismatch {
  /** Required properties the value lacks, as schema paths, sorted. */
  readonly missingRequired: readonly string[];
  /** Declared properties (or items) whose value fails its own schema, as schema paths, sorted. */
  readonly invalidPaths: readonly string[];
  /** Properties the value carries that a closed object schema does not declare. */
  readonly unexpectedPropertyCount: number;
  /**
   * Distinct mismatching paths the two list caps left out; 0 when every distinct path is listed. The
   * lists never repeat a path, so this counts genuinely different violations, not repeated items.
   */
  readonly droppedPathCount: number;
}

/**
 * Body-free compiler error; declaration bodies never become diagnostic messages. An `invalid-shape`
 * raised for a value carries the schema's own account of the mismatch, so the layer that reports the
 * rejection can say which declared property was missing or invalid without ever quoting the value
 * (run 7 of the Workbench engagement, 2026-09-10: three identical `invalid-shape` rejections of one
 * tool call exhausted the retry budget, and neither the log nor the model learned which property).
 */
export class ToolCatalogError extends TypeError {
  public constructor(
    public readonly reason: CatalogFailureReason,
    public readonly shape?: CatalogSchemaMismatch | undefined,
  ) {
    super(`tool catalog ${reason}`);
    this.name = "ToolCatalogError";
  }
}

export function requireCatalog(
  condition: boolean,
  reason: CatalogFailureReason,
): asserts condition {
  if (!condition) throw new ToolCatalogError(reason);
}
