import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { formatUserError } from "./format-error";

describe("formatUserError", () => {
  it("keeps user-facing API messages first while preserving the support code", () => {
    expect(
      formatUserError(new ApiError("GATEWAY_UPSTREAM_FAILURE", "Model timed out", 502), "Retry"),
    ).toBe("Model timed out (GATEWAY_UPSTREAM_FAILURE)");
  });

  it("uses the caller fallback when an API error has no human message", () => {
    expect(formatUserError(new ApiError("INTERNAL", "  ", 500), "Could not send message")).toBe(
      "Could not send message (INTERNAL)",
    );
  });

  it("does not expose raw unknown values to alert regions", () => {
    expect(formatUserError({ code: "INTERNAL" }, "Something went wrong")).toBe(
      "Something went wrong",
    );
  });
});
