import {
  normalizeSupportReportCorrelationId,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { recordClientDiagnosticLoss } from "./client-diagnostics.js";

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

/** Preserve only a reportable selected request ID and count one discarded supplied identity. */
export function selectedSupportReportCorrelationId(value: string | undefined): string | undefined {
  const selected = normalizeSupportReportCorrelationId(value);
  if (value !== undefined && selected === undefined) recordClientDiagnosticLoss("errorsSuppressed");
  return selected;
}
