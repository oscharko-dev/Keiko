import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const loadJson = async (path) => JSON.parse(await readFile(path, "utf8"));

describe("supply-chain risk acceptances", () => {
  it("binds every acceptance to the exact locked artifact", async () => {
    const [policy, lockfile] = await Promise.all([
      loadJson("docs/qa/supply-chain-risk-acceptances.json"),
      loadJson("package-lock.json"),
    ]);

    expect(policy.policy.automaticExpiry).toContain("version or lockfile integrity change");
    expect(policy.acceptances).not.toHaveLength(0);

    for (const acceptance of policy.acceptances) {
      const locked = lockfile.packages[`node_modules/${acceptance.package}`];
      expect(locked, `${acceptance.package} must remain in the lockfile`).toBeDefined();
      expect(locked.version).toBe(acceptance.version);
      expect(locked.integrity).toBe(acceptance.integrity);
      expect(locked.dev).toBe(true);
    }
  });

  it("does not contain an unscoped Socket suppression", async () => {
    const policyText = await readFile("docs/qa/supply-chain-risk-acceptances.json", "utf8");

    expect(policyText).not.toContain("ignore-all");
    expect(policyText).not.toContain("ignore_all");
  });
});
