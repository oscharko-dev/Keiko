import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prunePackageBuildArtifacts } from "../prune-package-build-artifacts.mjs";

let root;

function write(path, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

describe("prune-package-build-artifacts", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-prune-build-artifacts-"));
    mkdirSync(join(root, "packages", "keiko-server", "dist", "__tests__"), { recursive: true });
    mkdirSync(join(root, "packages", "keiko-server", "dist", "runtime"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes build metadata and compiled test artifacts without deleting runtime dist files", () => {
    write(join(root, "packages", "keiko-server", "dist", "index.js"), "export {};\n");
    write(join(root, "packages", "keiko-server", "dist", ".tsbuildinfo"), "{}\n");
    write(join(root, "packages", "keiko-server", "dist", "routes.test.js"), "export {};\n");
    write(join(root, "packages", "keiko-server", "dist", "routes.test.d.ts"), "export {};\n");
    write(
      join(root, "packages", "keiko-server", "dist", "__tests__", "fixture.js"),
      "export {};\n",
    );
    write(join(root, "packages", "keiko-server", "dist", "runtime", "testGeneration.js"));

    const removed = prunePackageBuildArtifacts(root).map((path) => path.replace(root, "<root>"));
    expect(removed).toEqual(
      expect.arrayContaining([
        "<root>/packages/keiko-server/dist/.tsbuildinfo",
        "<root>/packages/keiko-server/dist/routes.test.js",
        "<root>/packages/keiko-server/dist/routes.test.d.ts",
        "<root>/packages/keiko-server/dist/__tests__",
      ]),
    );

    expect(existsSync(join(root, "packages", "keiko-server", "dist", "index.js"))).toBe(true);
    expect(
      existsSync(join(root, "packages", "keiko-server", "dist", "runtime", "testGeneration.js")),
    ).toBe(true);
    expect(existsSync(join(root, "packages", "keiko-server", "dist", ".tsbuildinfo"))).toBe(false);
    expect(existsSync(join(root, "packages", "keiko-server", "dist", "routes.test.js"))).toBe(
      false,
    );
    expect(existsSync(join(root, "packages", "keiko-server", "dist", "__tests__"))).toBe(false);
  });
});
