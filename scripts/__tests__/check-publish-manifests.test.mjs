import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { validatePublishManifests } from "../check-publish-manifests.mjs";

const VERSION = "0.2.11";

function rootManifest(overrides = {}) {
  return {
    name: "@oscharko-dev/keiko",
    version: VERSION,
    dependencies: {
      "@oscharko-dev/keiko-contracts": VERSION,
    },
    bundleDependencies: ["@oscharko-dev/keiko-contracts"],
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
  it("accepts root-only publishing with private bundled runtime workspaces", () => {
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
