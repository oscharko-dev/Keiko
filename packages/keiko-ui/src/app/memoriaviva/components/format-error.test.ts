import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { formatError } from "./format-error";

describe("memoriaviva formatError", () => {
  it("maps known memory API codes to actionable user copy", () => {
    expect(formatError(new ApiError("NOT_FOUND", "raw not found", 404))).toBe(
      "The memory could not be found. It may have been deleted. (NOT_FOUND)",
    );
    expect(formatError(new ApiError("PAYLOAD_TOO_LARGE", "raw too large", 413))).toBe(
      "The submitted content is too large. Shorten it and try again. (PAYLOAD_TOO_LARGE)",
    );
  });

  it("preserves unknown API messages and avoids empty alerts", () => {
    expect(formatError(new ApiError("CUSTOM_MEMORY_CODE", "Vault refused write", 500))).toBe(
      "Vault refused write (CUSTOM_MEMORY_CODE)",
    );
    expect(formatError(new ApiError("CUSTOM_MEMORY_CODE", "  ", 500))).toBe(
      "Something went wrong. Retry, or check the server log. (CUSTOM_MEMORY_CODE)",
    );
  });

  it("handles non-API failures without leaking opaque values", () => {
    expect(formatError(new Error("Local cache unavailable"))).toBe("Local cache unavailable");
    expect(formatError(null)).toBe("An unexpected error occurred.");
  });
});
