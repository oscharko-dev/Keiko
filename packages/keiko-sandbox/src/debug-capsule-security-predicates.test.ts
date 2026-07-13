import { describe, expect, it } from "vitest";
import { isDigestPinnedDebugCapsuleImage } from "./debug-capsule-security-predicates.js";

describe("debug capsule security predicates", () => {
  it("accepts only one non-empty whitespace-free repository pinned by an exact digest", () => {
    for (const character of ["0", "9", "a", "f"]) {
      expect(
        isDigestPinnedDebugCapsuleImage(
          `registry.example/team/image@sha256:${character.repeat(64)}`,
        ),
      ).toBe(true);
    }
    const digest = "f".repeat(64);
    for (const value of [
      `@sha256:${digest}`,
      `registry.example/image:${digest}`,
      `registry.example/im age@sha256:${digest}`,
      `registry.example/image@sha256:${digest}@sha256:${digest}`,
      `registry.example/image@sha256:${"f".repeat(63)}`,
      `registry.example/image@sha256:${"F".repeat(64)}`,
      `registry.example/image@sha256:${"g".repeat(64)}`,
      `registry.example/image@sha256:/${"f".repeat(63)}`,
      `registry.example/image@sha256::${"f".repeat(63)}`,
      `registry.example/image@sha256:@${"f".repeat(63)}`,
      `registry.example/image@sha256:${digest}\n`,
    ]) {
      expect(isDigestPinnedDebugCapsuleImage(value)).toBe(false);
    }
  });
});
