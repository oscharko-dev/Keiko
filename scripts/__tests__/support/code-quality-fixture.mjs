import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createPolicyFixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "keiko-policy-inventory-"));
  mkdirSync(join(root, "packages/alpha/src"), { recursive: true });
  for (const [path, value] of Object.entries({
    "package.json": { name: "fixture", workspaces: ["packages/*"] },
    "package-lock.json": { lockfileVersion: 3 },
    "tsconfig.json": { include: ["packages/alpha/src/**/*.ts"] },
    "tsconfig.build.json": { include: ["packages/alpha/src/index.ts"] },
    "packages/alpha/package.json": { name: "alpha", exports: "./dist/index.js" },
    "packages/alpha/tsconfig.json": { include: ["src/**/*.ts"] },
  }))
    writeFileSync(join(root, path), JSON.stringify(value));
  writeFileSync(join(root, "packages/alpha/src/index.ts"), "export const value = 1;");
  const git = (args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "--initial-branch=fixture"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Create hermetic policy inventory",
  ]);
  return root;
}
