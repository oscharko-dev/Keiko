import { describe, expect, it } from "vitest";
import { parseDotEnvTokenLine } from "../dotenv-token.mjs";

describe("parseDotEnvTokenLine", () => {
  it("parses NODE_AUTH_TOKEN with no surrounding whitespace", () => {
    expect(parseDotEnvTokenLine("NODE_AUTH_TOKEN=abc123")).toBe("abc123");
  });

  it("parses NPM_TOKEN with whitespace around the '='", () => {
    expect(parseDotEnvTokenLine("NPM_TOKEN   =   abc123")).toBe("abc123");
  });

  it("strips a double-quoted value", () => {
    expect(parseDotEnvTokenLine('NODE_AUTH_TOKEN="abc123"')).toBe("abc123");
  });

  it("strips a single-quoted value", () => {
    expect(parseDotEnvTokenLine("NODE_AUTH_TOKEN='abc123'")).toBe("abc123");
  });

  it("trims trailing whitespace from an unquoted value", () => {
    expect(parseDotEnvTokenLine("NPM_TOKEN=abc123   ")).toBe("abc123");
  });

  it("returns an empty string for a key with no value", () => {
    expect(parseDotEnvTokenLine("NODE_AUTH_TOKEN=")).toBe("");
  });

  it("returns undefined for an unrelated key", () => {
    expect(parseDotEnvTokenLine("SOME_OTHER_VAR=abc123")).toBeUndefined();
  });

  it("returns undefined for a line with no '='", () => {
    expect(parseDotEnvTokenLine("NODE_AUTH_TOKEN")).toBeUndefined();
  });

  it("returns undefined when the key name is only a prefix of a longer identifier", () => {
    expect(parseDotEnvTokenLine("NODE_AUTH_TOKEN_EXTRA=abc123")).toBeUndefined();
  });

  it("uses the first '=' when the value itself contains '='", () => {
    expect(parseDotEnvTokenLine("NPM_TOKEN=abc=123==")).toBe("abc=123==");
  });

  // Regression for S8786: the old `/^(NODE_AUTH_TOKEN|NPM_TOKEN)\s*=\s*(.*)$/u` pattern was
  // anchored (so only ever a single match attempt) and measured linear in local timing, but the
  // shape — two `\s*` runs plus a trailing `.*` — is exactly what the lint rule flags. The
  // rewritten plain-JS parser can't backtrack at all; this asserts it stays fast even against a
  // pathologically long non-matching line.
  it("stays well within a tight time budget for a long non-matching line", () => {
    const adversarialLine = "X".repeat(20_000) + " ".repeat(20_000) + "=" + "Y".repeat(20_000);
    const start = Date.now();
    const result = parseDotEnvTokenLine(adversarialLine);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(200);
    expect(result).toBeUndefined();
  });
});
