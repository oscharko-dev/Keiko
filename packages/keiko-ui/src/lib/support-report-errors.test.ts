import { expect, it } from "vitest";
import { SupportReportBudgetExceeded, localSupportReportErrorKind } from "./support-report-errors";

it.each([
  [new SupportReportBudgetExceeded(), "validation-failed"],
  [new DOMException("Private", "TimeoutError"), "timeout"],
  [new DOMException("Private", "AbortError"), "cancelled"],
  [new DOMException("Private", "NotSupportedError"), "internal"],
  [new TypeError("Private"), "internal"],
  [new RangeError("Private"), "internal"],
  ["private thrown value", "internal"],
] as const)(
  "classifies local failure %s without treating it as BFF availability",
  (error, expected) => {
    expect(localSupportReportErrorKind(error)).toBe(expected);
  },
);
