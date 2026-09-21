import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validatePublishManifests } from "../check-publish-manifests.mjs";
import { requiredPlatformRuntimePackageNames } from "../release-workspace-policy.mjs";
import { NPM_LANE_RUNTIME_APPROVALS } from "../../packages/keiko-server/src/coding-runtime/npmLaneRuntimeApprovals.ts";

const VERSION = "0.2.11";
const PLATFORM_RUNTIMES = Object.fromEntries(
  requiredPlatformRuntimePackageNames.map((name) => [name, "1.1.3"]),
);

function rootManifest(overrides = {}) {
  return {
    name: "@oscharko-dev/keiko",
    version: VERSION,
    repository: {
      type: "git",
      url: "https://github.com/oscharko-dev/Keiko",
    },
    dependencies: {
      "@oscharko-dev/keiko-contracts": VERSION,
    },
    bundleDependencies: ["@oscharko-dev/keiko-contracts"],
    optionalDependencies: { ...PLATFORM_RUNTIMES },
    ...overrides,
  };
}

function workspace(name, overrides = {}) {
  return {
    relativePath: `packages/${name.replace("@oscharko-dev/", "")}/package.json`,
    manifest: {
      name,
      private: true,
      version: VERSION,
      ...overrides,
    },
  };
}

describe("validatePublishManifests", () => {
  it("accepts root-only publishing with private vendored runtime workspaces", () => {
    const failures = validatePublishManifests(rootManifest(), [
      workspace("@oscharko-dev/keiko-contracts"),
      workspace("@oscharko-dev/keiko-ui"),
      workspace("@oscharko-dev/keiko-editor"),
    ]);

    expect(failures).toEqual([]);
  });

  it("rejects a workspace that can be independently published", () => {
    const failures = validatePublishManifests(rootManifest(), [
      workspace("@oscharko-dev/keiko-contracts", { private: false }),
    ]);

    expect(failures.join("\n")).toContain("must set private: true");
    expect(failures.join("\n")).toContain("only the root package is published");
  });

  it("rejects root manifests without the npm provenance repository url", () => {
    const failures = validatePublishManifests(
      rootManifest({ repository: { type: "git", url: "" } }),
      [workspace("@oscharko-dev/keiko-contracts")],
    );

    expect(failures.join("\n")).toContain("repository.url must be");
    expect(failures.join("\n")).toContain("npm provenance");
  });

  it("rejects build-time-only private workspaces in the root published contract", () => {
    const failures = validatePublishManifests(
      rootManifest({
        dependencies: {
          "@oscharko-dev/keiko-contracts": VERSION,
          "@oscharko-dev/keiko-ui": VERSION,
        },
        bundleDependencies: ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-ui"],
      }),
      [workspace("@oscharko-dev/keiko-contracts"), workspace("@oscharko-dev/keiko-ui")],
    );

    expect(failures.join("\n")).toContain("build-time-only workspace exclusion");
    expect(failures.join("\n")).toContain("must not appear in root dependencies");
  });

  it("rejects a runtime workspace missing from the root bundle", () => {
    const failures = validatePublishManifests(
      rootManifest({
        dependencies: {
          "@oscharko-dev/keiko-contracts": VERSION,
          "@oscharko-dev/keiko-server": VERSION,
        },
        bundleDependencies: ["@oscharko-dev/keiko-contracts"],
      }),
      [workspace("@oscharko-dev/keiko-contracts"), workspace("@oscharko-dev/keiko-server")],
    );

    expect(failures.join("\n")).toContain(
      "runtime workspace @oscharko-dev/keiko-server must be listed in root bundleDependencies",
    );
  });

  it("rejects productive model-gateway provider runtime subpath exports", () => {
    const failures = validatePublishManifests(
      rootManifest({
        dependencies: {
          "@oscharko-dev/keiko-contracts": VERSION,
          "@oscharko-dev/keiko-model-gateway": VERSION,
        },
        bundleDependencies: ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-model-gateway"],
      }),
      [
        workspace("@oscharko-dev/keiko-contracts"),
        workspace("@oscharko-dev/keiko-model-gateway", {
          exports: {
            ".": {
              import: "./dist/index.js",
              types: "./dist/index.d.ts",
            },
            "./internal/openai-adapter": {
              import: "./dist/openai-adapter.js",
              types: "./dist/openai-adapter.d.ts",
            },
            "./internal/normalize": {
              import: "./dist/normalize.js",
              types: "./dist/normalize.d.ts",
            },
          },
        }),
      ],
    );

    expect(failures.join("\n")).toContain(
      "must not export productive provider-runtime subpath ./internal/openai-adapter",
    );
    expect(failures.join("\n")).toContain(
      "must not export productive provider-runtime subpath ./internal/normalize",
    );
  });

  it("rejects local-knowledge test-only exports if that workspace becomes public", () => {
    const failures = validatePublishManifests(
      rootManifest({
        dependencies: {
          "@oscharko-dev/keiko-contracts": VERSION,
          "@oscharko-dev/keiko-local-knowledge": VERSION,
        },
        bundleDependencies: [
          "@oscharko-dev/keiko-contracts",
          "@oscharko-dev/keiko-local-knowledge",
        ],
      }),
      [
        workspace("@oscharko-dev/keiko-contracts"),
        workspace("@oscharko-dev/keiko-local-knowledge", {
          private: false,
          exports: {
            ".": {
              import: "./dist/index.js",
              types: "./dist/index.d.ts",
            },
            "./testing": {
              import: "./dist/testing.js",
              types: "./dist/testing.d.ts",
            },
          },
        }),
      ],
    );

    expect(failures.join("\n")).toContain(
      "public workspace @oscharko-dev/keiko-local-knowledge must not export test-only subpath ./testing",
    );
  });
});

// #3577. The platform coding-runtime packages share the scope but are not workspaces: ~75 MB of one
// platform's binaries, published on their own and selected by npm through os/cpu. The workspace
// rules (dependencies only, product-version pin, bundled) would either refuse them or put them into
// every tarball.
describe("platform coding-runtime packages", () => {
  const RUNTIME = "@oscharko-dev/keiko-coding-runtime-darwin-arm64";
  const workspaces = [workspace("@oscharko-dev/keiko-contracts")];
  const failuresFor = (overrides) =>
    validatePublishManifests(rootManifest(overrides), workspaces).join("\n");

  it("accepts them as exactly pinned, unbundled optional dependencies", () => {
    expect(validatePublishManifests(rootManifest(), workspaces)).toStrictEqual([]);
  });

  // The server carries compiled-in approvals for exactly these packages. One that is no longer
  // declared takes the coding runtime away from every npm installation on that platform, silently:
  // npm just has nothing optional left to install.
  it("requires exactly the packages the server holds approvals for", () => {
    expect([...requiredPlatformRuntimePackageNames].sort()).toStrictEqual(
      Object.values(NPM_LANE_RUNTIME_APPROVALS)
        .map((approval) => approval.packageName)
        .sort(),
    );
  });

  it("refuses a manifest that declares none of them", () => {
    const failures = failuresFor({ optionalDependencies: {} });
    for (const name of requiredPlatformRuntimePackageNames) {
      expect(failures).toContain(`platform runtime ${name} is not declared`);
    }
  });

  it.each(requiredPlatformRuntimePackageNames)("refuses a manifest that drops %s", (dropped) => {
    const remaining = Object.fromEntries(
      Object.entries(PLATFORM_RUNTIMES).filter(([name]) => name !== dropped),
    );
    const failures = failuresFor({ optionalDependencies: remaining });
    expect(failures).toContain(`platform runtime ${dropped} is not declared`);
    expect(failures.match(/is not declared/gu)).toHaveLength(1);
  });

  it.each([
    [
      "a required dependency",
      {
        dependencies: { "@oscharko-dev/keiko-contracts": VERSION, [RUNTIME]: "1.1.3" },
        optionalDependencies: { ...PLATFORM_RUNTIMES, [RUNTIME]: undefined },
      },
      "must be an optionalDependency",
    ],
    [
      "a version range",
      { optionalDependencies: { ...PLATFORM_RUNTIMES, [RUNTIME]: "^1.1.3" } },
      "exact version",
    ],
    [
      "a bundled entry",
      { bundleDependencies: ["@oscharko-dev/keiko-contracts", RUNTIME] },
      "must not be bundled",
    ],
  ])("refuses %s", (_label, overrides, message) => {
    expect(failuresFor(overrides)).toContain(message);
  });

  it("refuses a workspace that takes a platform runtime's name", () => {
    const failures = validatePublishManifests(rootManifest(), [...workspaces, workspace(RUNTIME)]);
    expect(failures.join("\n")).toContain("must not be a workspace package");
  });
});

describe("publish lifecycle gates", () => {
  it("requires workspace supply-chain verification in prepack and prepublishOnly", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));

    for (const scriptName of ["prepack", "prepublishOnly"]) {
      const script = scripts[scriptName];
      expect(script).toContain("npm run prune:package-build-artifacts");
      expect(script.indexOf("npm run prune:package-build-artifacts")).toBeLessThan(
        script.indexOf("npm run check:package-surface"),
      );
      expect(script).toContain("npm run check:workspace-supply-chain");
      expect(script.indexOf("npm run check:workspace-supply-chain")).toBeLessThan(
        script.indexOf("npm run check:package-surface"),
      );
      expect(script.indexOf("npm run check:workspace-supply-chain")).toBeLessThan(
        script.indexOf("npm run check:publish-manifests"),
      );
      expect(script).toContain("npm run check:shell-spawn-guardrails");
      expect(script).toContain("npm run check:security-regression-matrix");
      expect(script.indexOf("npm run check:shell-spawn-guardrails")).toBeLessThan(
        script.indexOf("npm run check:package-surface"),
      );
      expect(script.indexOf("npm run check:security-regression-matrix")).toBeLessThan(
        script.indexOf("npm run check:package-surface"),
      );
    }
  });
});
