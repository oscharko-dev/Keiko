import type { ActivityLogErrorKind } from "@oscharko-dev/keiko-contracts/runtime/observability";

/** A local canonical artifact exceeded its declared byte budget. */
export class SupportReportBudgetExceeded extends RangeError {
  constructor() {
    super("Support report budget exceeded.");
  }
}

export function localSupportReportErrorKind(error: unknown): ActivityLogErrorKind {
  if (error instanceof SupportReportBudgetExceeded) return "validation-failed";
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError") return "timeout";
    if (error.name === "AbortError") return "cancelled";
  }
  return "internal";
}
