import type {
  ToolResultReason,
  ToolResultStatus,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

export class CatalogDispatchFault extends Error {
  public constructor(
    public readonly status: Exclude<ToolResultStatus, "completed">,
    public readonly reason: ToolResultReason,
    cause?: unknown,
  ) {
    super("Catalog dispatch rejected", { cause });
  }
}

export function requireDispatch(
  condition: boolean,
  status: Exclude<ToolResultStatus, "completed">,
  reason: ToolResultReason,
): asserts condition {
  if (!condition) throw new CatalogDispatchFault(status, reason);
}
