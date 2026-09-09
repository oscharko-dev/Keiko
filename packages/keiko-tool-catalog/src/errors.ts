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

/** Body-free compiler error; declaration bodies never become diagnostic messages. */
export class ToolCatalogError extends TypeError {
  public constructor(public readonly reason: CatalogFailureReason) {
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
