import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { computePortableSidecarPayloadTreeDigest } from "./devLanePortableCodingRuntime.js";

describe("computePortableSidecarPayloadTreeDigest (KEIKO-0180)", () => {
  // #3099 KfQ Major follow-up: the manager test fixture derives its expected values from this
  // very function, so a bug HERE would move both the production hash and the fixture in lockstep
  // and no downstream test would catch it. This standalone pin computes the tree digest for a
  // hand-hashed pair with a known relative path and asserts the exact 64-char hex string — a
  // formula change (order, separator, digest algorithm, sort collation) fails this pin loudly.
  it("produces a stable hex digest for a known single-entry input", () => {
    const contentSha = createHash("sha256").update("payload\n", "utf8").digest("hex");
    const expected = createHash("sha256")
      .update(`bin/opencode\0${contentSha}\0`, "utf8")
      .digest("hex");
    expect(
      computePortableSidecarPayloadTreeDigest([
        { relativePath: "bin/opencode", sha256: contentSha },
      ]),
    ).toBe(expected);
  });

  it("locale-sorts entries by relativePath before hashing (order-independent input, deterministic digest)", () => {
    const bin = createHash("sha256").update("x", "utf8").digest("hex");
    const lic = createHash("sha256").update("y", "utf8").digest("hex");
    const forward = computePortableSidecarPayloadTreeDigest([
      { relativePath: "LICENSE", sha256: lic },
      { relativePath: "bin/opencode", sha256: bin },
    ]);
    const reversed = computePortableSidecarPayloadTreeDigest([
      { relativePath: "bin/opencode", sha256: bin },
      { relativePath: "LICENSE", sha256: lic },
    ]);
    expect(forward).toBe(reversed);
    // And it must match the by-hand-sorted concatenation under the SAME sort the helper uses.
    const sortedKeys = ["LICENSE", "bin/opencode"].sort((a, b) => a.localeCompare(b));
    const shas: Record<string, string> = { LICENSE: lic, "bin/opencode": bin };
    const hash = createHash("sha256");
    for (const key of sortedKeys) hash.update(`${key}\0${shas[key] ?? ""}\0`, "utf8");
    expect(forward).toBe(hash.digest("hex"));
  });

  it("empty entry set produces the sha256 of the empty string", () => {
    expect(computePortableSidecarPayloadTreeDigest([])).toBe(
      createHash("sha256").update("", "utf8").digest("hex"),
    );
  });
});
