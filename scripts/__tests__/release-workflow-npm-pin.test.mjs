import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { EXPECTED_PACKAGE_MANAGER } from "../check-runtime-toolchain.mjs";

const WORKFLOW_PATH = resolve(
  import.meta.dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "release.yml",
);

describe("release workflow npm pin", () => {
  it("installs exactly the governed npm the toolchain contract demands", () => {
    // The publish job upgrades npm for OIDC trusted publishing, and prepack re-verifies the
    // executed npm against the governed contract. A drifted pin kills every publish from the tag
    // that freezes it — the 0.3.1 CI publish died exactly this way (11.18.0 vs 11.16.0). The
    // workflow line is compared against the SAME constant the runtime check enforces, so the two
    // cannot drift apart unnoticed again.
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    const installs = [...workflow.matchAll(/npm install --global --ignore-scripts (npm@\S+)/gu)];

    expect(installs.length).toBeGreaterThan(0);
    for (const [, pinned] of installs) {
      expect(pinned).toBe(EXPECTED_PACKAGE_MANAGER);
    }
  });
});
