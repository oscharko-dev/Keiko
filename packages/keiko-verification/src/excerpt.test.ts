import { describe, expect, it } from "vitest";
import { VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS, outputExcerpt } from "./excerpt.js";

describe("outputExcerpt — below the cap", () => {
  it("combines stdout and stderr with a newline and trims the result", () => {
    expect(outputExcerpt({ stdout: "  built successfully  ", stderr: "" })).toBe(
      "built successfully",
    );
  });

  it("keeps both streams when neither is empty", () => {
    expect(outputExcerpt({ stdout: "out-line", stderr: "err-line" })).toBe("out-line\nerr-line");
  });

  it("returns an empty string when both streams are empty", () => {
    expect(outputExcerpt({ stdout: "", stderr: "" })).toBe("");
  });
});

describe("outputExcerpt — the cap boundary", () => {
  it("returns the content unmodified exactly at the cap", () => {
    const atCap = "x".repeat(5);
    expect(outputExcerpt({ stdout: atCap, stderr: "" }, 5)).toBe(atCap);
  });

  it("truncates to the tail, prefixed with an ellipsis, one char above the cap", () => {
    const tail = "x".repeat(5);
    const result = outputExcerpt({ stdout: `y${tail}`, stderr: "" }, 5);
    expect(result).toBe(`…${tail}`);
    expect(result).toHaveLength(6);
  });

  it("returns the tail bounded to VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS by default, dropping the head", () => {
    const head = "H".repeat(200);
    const tail = "T".repeat(VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS);
    const result = outputExcerpt({ stdout: head + tail, stderr: "" });
    expect(result).toBe(`…${tail}`);
    expect(result).toHaveLength(VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS + 1);
    expect(result).not.toContain("H");
  });
});

describe("outputExcerpt — redaction (defence in depth)", () => {
  it("redacts a GitHub-token-shaped secret embedded in stdout", () => {
    const token = "ghp_" + "A".repeat(36);
    const result = outputExcerpt({ stdout: `npm warn using token=${token}`, stderr: "" });
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });

  it("redacts a secret shape that spans into the retained tail of a truncated excerpt", () => {
    const token = "ghp_" + "B".repeat(36);
    const head = "H".repeat(200);
    // The limit (20) is smaller than the 40-char token, so the retained tail crosses the token's
    // own boundary: an implementation that truncated BEFORE redacting would keep only a headless
    // fragment of the token (no "ghp_" prefix), which the token-shape pattern can never match, so
    // "[REDACTED]" would not appear. Only redact-then-truncate (the real order) passes this.
    const result = outputExcerpt({ stdout: `${head}token=${token}`, stderr: "" }, 20);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });
});
