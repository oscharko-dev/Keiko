import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { formatError } from "./format-error";

describe("local-knowledge formatError", () => {
  it("renders API messages before their diagnostic code", () => {
    expect(formatError(new ApiError("LK_VALIDATION", "Capsule title is required", 400))).toBe(
      "Capsule title is required (LK_VALIDATION)",
    );
  });

  it("falls back to a recovery-oriented message for empty API messages", () => {
    expect(formatError(new ApiError("INTERNAL", "", 500))).toBe(
      "Something went wrong. Try again. (INTERNAL)",
    );
  });

  it("adds recovery guidance and support id for local knowledge unavailable errors", () => {
    const error = new ApiError(
      "LOCAL_KNOWLEDGE_UNAVAILABLE",
      "Local knowledge storage is unavailable.",
      503,
    );
    error.correlationId = "lk-support-123";

    expect(formatError(error)).toBe(
      [
        "Local knowledge storage is unavailable.",
        "Restart Keiko, reopen Local Knowledge, then try again.",
        "If it still fails, run the local-state repair or Knowledge Pod reindex remediation.",
        "(LOCAL_KNOWLEDGE_UNAVAILABLE; support ID lk-support-123)",
      ].join(" "),
    );
  });

  it("adds restart guidance when the runtime cannot be reached after standby", () => {
    expect(formatError(new TypeError("Failed to fetch"))).toBe(
      [
        "Failed to fetch.",
        "Keiko runtime could not be reached.",
        "Restart Keiko, reopen Local Knowledge, then try again.",
      ].join(" "),
    );
  });

  it("keeps generic errors human-readable and masks unknown thrown values", () => {
    expect(formatError(new Error("Index is rebuilding"))).toBe("Index is rebuilding");
    expect(formatError(500)).toBe("An unexpected error occurred.");
  });
});
