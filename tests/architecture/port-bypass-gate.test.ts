import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface DependencyCruiserRuleEndpoint {
  readonly path?: string;
  readonly pathNot?: string;
}

interface DependencyCruiserRule {
  readonly name: string;
  readonly from?: DependencyCruiserRuleEndpoint;
  readonly to?: DependencyCruiserRuleEndpoint;
}

interface DependencyCruiserConfig {
  readonly forbidden?: readonly DependencyCruiserRule[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = resolve(repoRoot, ".dependency-cruiser.cjs");
const require = createRequire(import.meta.url);
const config = require(configPath) as DependencyCruiserConfig;

describe("dependency-cruiser trust rule 7", () => {
  it("stays scoped to cli/server and forbids only sibling package sources", () => {
    const rule = (config.forbidden ?? []).find(
      (entry) => entry.name === "adr-0019-trust-7-cli-server-no-port-bypass",
    );

    expect(rule).toBeTruthy();
    expect(rule?.from?.path).toContain("packages/keiko-(cli|server)/src/");
    expect(rule?.from?.pathNot).toBeUndefined();
    expect(rule?.to?.path).toBe("^packages/keiko-(?!cli|server)[^/]+/src/");
    expect(rule?.to?.pathNot).toBeUndefined();
  });
});

describe("dependency-cruiser workflows boundary", () => {
  it("forbids direct filesystem imports into allow-listed sibling package sources", () => {
    const rule = (config.forbidden ?? []).find(
      (entry) =>
        entry.name ===
        "adr-0019-direction-5a-workflows-only-contracts-security-model-gateway-workspace-tools-harness-evidence",
    );

    expect(rule).toBeTruthy();
    expect(rule?.from?.pathNot).toBe("\\.(test|spec)\\.[cm]?[jt]sx?$");
    expect(rule?.to?.path).toContain("packages/keiko-workspace/src/");
    expect(rule?.to?.path).toContain("packages/keiko-tools/src/");
    expect(rule?.to?.path).toContain("@oscharko-dev/keiko-");
  });
});
