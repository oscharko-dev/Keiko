import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePreferredInstallLayout } from "./install-layout.js";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-install-layout-"));
  tempRoots.push(root);
  return root;
}

function writeBuiltCheckout(root: string): void {
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  mkdirSync(join(root, "dist", "ui", "static"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"@oscharko-dev/keiko"}\n', "utf8");
  writeFileSync(join(root, "dist", "cli", "index.js"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(join(root, "dist", "ui", "static", "index.html"), "<html></html>\n", "utf8");
}

function nodeModulesPackageRoot(root: string): string {
  return join(root, "node_modules", "@oscharko-dev", "keiko");
}

function writeNodeModulesPackage(root: string): void {
  const packageRoot = nodeModulesPackageRoot(root);
  mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
  mkdirSync(join(packageRoot, "dist", "ui", "static"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "cli", "index.js"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "ui", "static", "index.html"), "<html></html>\n", "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolvePreferredInstallLayout", () => {
  it("prefers the built monorepo checkout over a local node_modules package", () => {
    const root = makeRoot();
    writeBuiltCheckout(root);
    writeNodeModulesPackage(root);

    const layout = resolvePreferredInstallLayout(root);

    expect(layout?.binPath).toBe(resolve(root, "dist", "cli", "index.js"));
    expect(layout?.staticRoot).toBe(resolve(root, "dist", "ui", "static"));
  });

  it("resolves the local node_modules package when no built checkout exists", () => {
    const root = makeRoot();
    writeNodeModulesPackage(root);
    const packageRoot = nodeModulesPackageRoot(root);

    const layout = resolvePreferredInstallLayout(root);

    expect(layout?.binPath).toBe(resolve(packageRoot, "dist", "cli", "index.js"));
    expect(layout?.staticRoot).toBe(resolve(packageRoot, "dist", "ui", "static"));
  });

  it("returns undefined when neither a built checkout nor a local package is present", () => {
    const root = makeRoot();

    expect(resolvePreferredInstallLayout(root)).toBeUndefined();
  });

  it("ignores a local package whose static assets were not built", () => {
    const root = makeRoot();
    const packageRoot = nodeModulesPackageRoot(root);
    mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
    writeFileSync(join(packageRoot, "dist", "cli", "index.js"), "#!/usr/bin/env node\n", "utf8");

    expect(resolvePreferredInstallLayout(root)).toBeUndefined();
  });
});
