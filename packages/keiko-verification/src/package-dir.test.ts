import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspaceAt, type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { detectScripts } from "./detect.js";
import { resolveVerificationPackage } from "./package-dir.js";
import { buildVerificationPlan, planPackageTargetedTests } from "./plan.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A Maven-style multi-module repository: no package.json at the root.
function mavenRepo(files: Readonly<Record<string, string>>): WorkspaceInfo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-package-dir-")));
  roots.push(root);
  writeFileSync(join(root, "pom.xml"), "<project/>");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return detectWorkspaceAt(root, nodeWorkspaceFs, { scanSourceFilesForLanguages: false });
}

const NESTED = "web/src/main/typescript/app";
const YARN_PACKAGE = {
  [`${NESTED}/package.json`]: JSON.stringify({
    name: "app",
    scripts: { test: "vitest run", lint: "eslint ." },
    devDependencies: { vitest: "4.1.11" },
  }),
  [`${NESTED}/yarn.lock`]: "# yarn lockfile v1\n",
  [`${NESTED}/.yarnrc.yml`]: "nodeLinker: node-modules\n",
  [`${NESTED}/src/widget.test.ts`]: "",
};

describe("resolveVerificationPackage", () => {
  it("finds a single nested package by bounded discovery", () => {
    const workspace = mavenRepo(YARN_PACKAGE);
    const resolution = resolveVerificationPackage(workspace, nodeWorkspaceFs);
    expect(resolution.kind).toBe("package");
    if (resolution.kind !== "package") return;
    expect(resolution.package.dir).toBe(NESTED);
    expect(resolution.package.manager).toBe("yarn");
    expect(resolution.package.installed).toBe(false);
    expect(resolution.package.workspace.testFramework).toBe("vitest");
  });

  it("resolves the nearest package.json above the target path", () => {
    const workspace = mavenRepo({
      ...YARN_PACKAGE,
      "other/package.json": JSON.stringify({ name: "other" }),
    });
    const resolution = resolveVerificationPackage(workspace, nodeWorkspaceFs, {
      targetPath: `${NESTED}/src/widget.test.ts`,
    });
    expect(resolution).toMatchObject({ kind: "package", package: { dir: NESTED } });
  });

  it("honours an explicit packageDir over discovery", () => {
    const workspace = mavenRepo({
      ...YARN_PACKAGE,
      "other/package.json": JSON.stringify({ name: "other", scripts: { test: "node t.js" } }),
    });
    const resolution = resolveVerificationPackage(workspace, nodeWorkspaceFs, {
      packageDir: "other/",
    });
    expect(resolution).toMatchObject({
      kind: "package",
      package: { dir: "other", manager: "npm" },
    });
  });

  it("refuses an ambiguous discovery and lists the relative folders", () => {
    const workspace = mavenRepo({
      ...YARN_PACKAGE,
      "other/package.json": JSON.stringify({ name: "other" }),
    });
    expect(resolveVerificationPackage(workspace, nodeWorkspaceFs)).toEqual({
      kind: "ambiguous",
      candidates: ["other", NESTED],
    });
  });

  it("does not pick a shallow package as unique while a deeper subtree was left unexplored", () => {
    const manifest = JSON.stringify({ name: "frontend" });
    const deep = "modules/a/b/c/d/e/f/g";
    const workspace = mavenRepo({
      "frontend/package.json": manifest,
      [`${deep}/client/package.json`]: manifest,
    });
    expect(resolveVerificationPackage(workspace, nodeWorkspaceFs)).toEqual({
      kind: "ambiguous",
      candidates: ["frontend"],
    });
    // The explicit folder stays the way to choose the deeper package.
    const chosen = resolveVerificationPackage(workspace, nodeWorkspaceFs, {
      packageDir: `${deep}/client`,
    });
    expect(chosen.kind).toBe("package");
  });

  it("still lists the packages beside a subtree the depth limit cut off", () => {
    const manifest = JSON.stringify({ name: "p" });
    const workspace = mavenRepo({
      "frontend/package.json": manifest,
      "modules/a/b/c/d/e/f/g/client/package.json": manifest,
      "zeta/package.json": manifest,
    });
    expect(resolveVerificationPackage(workspace, nodeWorkspaceFs)).toEqual({
      kind: "ambiguous",
      candidates: ["frontend", "zeta"],
    });
  });

  it("keeps a shallow package unique when the depth limit cuts off no subfolder", () => {
    const workspace = mavenRepo({ "frontend/package.json": JSON.stringify({ name: "frontend" }) });
    mkdirSync(join(workspace.root, "modules/a/b/c/d/e/f/g"), { recursive: true });
    const resolution = resolveVerificationPackage(workspace, nodeWorkspaceFs);
    expect(resolution.kind).toBe("package");
  });

  it.each(["../outside", "/etc", "a/../../b", "C:/x", "a\u0000b"])(
    "refuses the escaping or malformed packageDir %j",
    (packageDir) => {
      const workspace = mavenRepo(YARN_PACKAGE);
      const resolution = resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir });
      expect(resolution.kind).toBe("refused");
    },
  );

  it("refuses a packageDir that is a symbolic link leaving the workspace", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "keiko-package-outside-")));
    roots.push(outside);
    writeFileSync(join(outside, "package.json"), "{}");
    const workspace = mavenRepo({});
    symlinkSync(outside, join(workspace.root, "linked"));
    expect(
      resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir: "linked" }),
    ).toEqual({
      kind: "refused",
      reason: "no-package",
    });
  });

  it("refuses a folder without a package.json and a denied folder", () => {
    const workspace = mavenRepo({ "empty/readme.md": "x", ".git/package.json": "{}" });
    expect(resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir: "empty" })).toEqual(
      {
        kind: "refused",
        reason: "no-package",
      },
    );
    expect(resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir: ".git" })).toEqual({
      kind: "refused",
      reason: "no-package",
    });
  });

  it("never follows a linked folder, or enters node_modules and build output, during discovery", () => {
    const workspace = mavenRepo({
      "node_modules/dep/package.json": "{}",
      "target/classes/package.json": "{}",
      "dist/package.json": "{}",
    });
    symlinkSync(join(workspace.root, "node_modules"), join(workspace.root, "alias"));
    expect(resolveVerificationPackage(workspace, nodeWorkspaceFs)).toEqual({ kind: "root" });
  });

  it("keeps the root path when the root has a package.json and no nested target names another", () => {
    const workspace = mavenRepo({ "package.json": "{}", ...YARN_PACKAGE });
    expect(resolveVerificationPackage(workspace, nodeWorkspaceFs)).toEqual({ kind: "root" });
    expect(
      resolveVerificationPackage(workspace, nodeWorkspaceFs, { targetPath: "README.md" }),
    ).toEqual({ kind: "root" });
  });

  it("prefers the nearest package of the target over the root package.json of a monorepo", () => {
    const workspace = mavenRepo({ "package.json": "{}", ...YARN_PACKAGE });
    expect(
      resolveVerificationPackage(workspace, nodeWorkspaceFs, {
        targetPath: `${NESTED}/src/widget.test.ts`,
      }),
    ).toMatchObject({ kind: "package", package: { dir: NESTED } });
  });

  it("detects pnpm from the lockfile and the declared packageManager over a stray lockfile", () => {
    const workspace = mavenRepo({
      "p/package.json": JSON.stringify({ name: "p" }),
      "p/pnpm-lock.yaml": "lockfileVersion: 9",
      "q/package.json": JSON.stringify({ name: "q", packageManager: "yarn@4.1.0" }),
      "q/pnpm-lock.yaml": "lockfileVersion: 9",
    });
    expect(
      resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir: "p" }),
    ).toMatchObject({ package: { manager: "pnpm" } });
    expect(
      resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir: "q" }),
    ).toMatchObject({ package: { manager: "yarn" } });
  });
});

describe("nested packages of a workspace whose lockfile and dependencies sit at the root", () => {
  it("takes the manager and the installed tree from the nearest folder up to the root", () => {
    const workspace = mavenRepo({
      "yarn.lock": "# yarn lockfile v1\n",
      "node_modules/.keep": "",
      "packages/a/package.json": JSON.stringify({ name: "a", scripts: { test: "vitest run" } }),
      "packages/b/package.json": JSON.stringify({ name: "b" }),
      "packages/b/package-lock.json": "{}",
    });
    expect(
      resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir: "packages/a" }),
    ).toMatchObject({ package: { manager: "yarn", installed: true } });
    expect(
      resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir: "packages/b" }),
    ).toMatchObject({ package: { manager: "npm", installed: true } });
  });

  it("answers npm and not installed when no folder up to the root says otherwise", () => {
    const workspace = mavenRepo({ "packages/a/package.json": JSON.stringify({ name: "a" }) });
    expect(
      resolveVerificationPackage(workspace, nodeWorkspaceFs, { packageDir: "packages/a" }),
    ).toMatchObject({ package: { manager: "npm", installed: false } });
  });
});

describe("nested package plans", () => {
  it("plans yarn scripts in the package folder and skips them as native-shell until installed", () => {
    const workspace = mavenRepo(YARN_PACKAGE);
    const resolution = resolveVerificationPackage(workspace, nodeWorkspaceFs);
    if (resolution.kind !== "package") throw new Error("expected a package");
    const catalog = detectScripts(workspace, nodeWorkspaceFs, resolution.package.dir);
    expect(catalog.mapping.test).toBe("test");
    const plan = buildVerificationPlan(
      workspace,
      catalog,
      { only: ["test", "lint"], package: resolution.package },
      nodeWorkspaceFs,
    );
    expect(plan).toMatchObject({ packageDir: NESTED, packageManager: "yarn" });
    const test = plan.steps.find((step) => step.kind === "test");
    expect(test).toMatchObject({ command: "yarn", args: ["run", "test"], cwd: NESTED });
    expect(test?.skipReason).toBe("native shell required: yarn dependencies are not installed");
  });

  it("runs yarn scripts once the package's own tree is installed", () => {
    const workspace = mavenRepo({ ...YARN_PACKAGE, [`${NESTED}/node_modules/.keep`]: "" });
    const resolution = resolveVerificationPackage(workspace, nodeWorkspaceFs);
    if (resolution.kind !== "package") throw new Error("expected a package");
    const plan = buildVerificationPlan(
      workspace,
      detectScripts(workspace, nodeWorkspaceFs, resolution.package.dir),
      { only: ["test"], package: resolution.package },
      nodeWorkspaceFs,
    );
    expect(plan.steps[0]?.skipReason).toBeUndefined();
  });

  it("plans a targeted test inside the package with package-relative paths", () => {
    const workspace = mavenRepo({ ...YARN_PACKAGE, [`${NESTED}/node_modules/.keep`]: "" });
    const resolution = resolveVerificationPackage(workspace, nodeWorkspaceFs, {
      targetPath: `${NESTED}/src/widget.test.ts`,
    });
    if (resolution.kind !== "package") throw new Error("expected a package");
    const steps = planPackageTargetedTests(
      resolution.package,
      [`${NESTED}/src/widget.test.ts`, "web/elsewhere.test.ts"],
      nodeWorkspaceFs,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: "targeted-test",
      command: "npx",
      args: ["vitest", "run", "--root", NESTED, "src/widget.test.ts"],
    });
    // Vitest starts at the workspace root, so hoisted tools stay inside the execution root.
    expect(steps[0]?.cwd).toBeUndefined();
  });
});
