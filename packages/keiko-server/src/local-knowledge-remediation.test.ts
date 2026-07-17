import { describe, expect, it } from "vitest";

import { normalizedEndpointFingerprint } from "./local-knowledge-remediation.js";

describe("normalizedEndpointFingerprint", () => {
  it("produces the same fingerprint regardless of trailing slashes", () => {
    const bare = normalizedEndpointFingerprint("https://example.com/v1");
    expect(normalizedEndpointFingerprint("https://example.com/v1/")).toBe(bare);
    expect(normalizedEndpointFingerprint("https://example.com/v1///")).toBe(bare);
    expect(normalizedEndpointFingerprint("  https://example.com/v1/  ")).toBe(bare);
  });

  it("distinguishes endpoints that differ beyond trailing slashes", () => {
    expect(normalizedEndpointFingerprint("https://example.com/v1")).not.toBe(
      normalizedEndpointFingerprint("https://example.com/v2"),
    );
  });

  // Regression for typescript/javascript:S8786. The trailing-slash strip used to be
  // `.replace(/\/+$/, "")`: that pattern's greedy run is not left-anchored, so a `.replace()`
  // search over a long run of slashes that never reaches the true string end (a slash run
  // followed by more path text) re-tried the same greedy-then-backtrack walk from every offset
  // inside the run, which is quadratic in the run length. A 40,000-slash adversarial baseUrl
  // would have taken the better part of a second; the backward index scan is linear.
  it("resolves an adversarial slash run in linear time", () => {
    const adversarialBaseUrl = `https://example.com${"/".repeat(40_000)}not-the-end`;
    const start = Date.now();
    const fingerprint = normalizedEndpointFingerprint(adversarialBaseUrl);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1500);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
