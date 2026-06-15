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

  it("keeps generic errors human-readable and masks unknown thrown values", () => {
    expect(formatError(new Error("Index is rebuilding"))).toBe("Index is rebuilding");
    expect(formatError(500)).toBe("An unexpected error occurred.");
  });
});
