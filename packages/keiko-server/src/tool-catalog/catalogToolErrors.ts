import type {
  CatalogJsonObject,
  ToolResultReason,
  ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

export class CatalogDispatchFault extends Error {
  readonly #providerResult: CatalogJsonObject | undefined;
  public constructor(
    public readonly status: Exclude<ToolResultStatus, "completed">,
    public readonly reason: ToolResultReason,
    cause?: unknown,
    providerResult?: CatalogJsonObject,
  ) {
    super("Catalog dispatch rejected", { cause });
    this.#providerResult = providerResult;
  }
  public get providerResult(): CatalogJsonObject | undefined {
    return this.#providerResult;
  }
}

export function requireDispatch(
  condition: boolean,
  status: Exclude<ToolResultStatus, "completed">,
  reason: ToolResultReason,
): asserts condition {
  if (!condition) throw new CatalogDispatchFault(status, reason);
}
