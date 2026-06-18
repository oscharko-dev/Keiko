import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT_PACKAGE_NAME = "@oscharko-dev/keiko";

export interface PreferredInstallLayout {
  readonly binPath: string;
  readonly staticRoot: string;
}

interface RootPackageJson {
  readonly name?: unknown;
}

function readRootPackageName(cwd: string): string | undefined {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as RootPackageJson;
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

// The single predicate for "this root is a usable Keiko layout `keiko start`
// will actually launch": both the built CLI entry and the built UI static asset
// must exist. doctor.ts shares this so it never reports a local install that
// `keiko start` would skip for missing static assets.
export function hasBuiltKeikoLayout(root: string): boolean {
  return (
    existsSync(resolve(root, "dist", "cli", "index.js")) &&
    existsSync(resolve(root, "dist", "ui", "static", "index.html"))
  );
}

export function localPackageRoot(cwd: string): string {
  return resolve(cwd, "node_modules", "@oscharko-dev", "keiko");
}

function builtLayoutAt(root: string): PreferredInstallLayout | undefined {
  if (!hasBuiltKeikoLayout(root)) return undefined;
  return {
    binPath: resolve(root, "dist", "cli", "index.js"),
    staticRoot: resolve(root, "dist", "ui", "static"),
  };
}

// The rung-1 monorepo built checkout only (cwd is the `@oscharko-dev/keiko`
// package root). doctor.ts uses this to distinguish a built checkout from a
// node_modules install, which it reports separately.
export function builtCheckoutLayout(cwd: string): PreferredInstallLayout | undefined {
  if (readRootPackageName(cwd) !== ROOT_PACKAGE_NAME) return undefined;
  return builtLayoutAt(cwd);
}

function localPackageLayout(cwd: string): PreferredInstallLayout | undefined {
  return builtLayoutAt(localPackageRoot(cwd));
}

// Precedence: built monorepo checkout first, then a local node_modules package.
// When neither matches, the caller (lifecycle.cliEntryPath) falls back to
// KEIKO_CLI_BIN_PATH and then the import.meta.url package-relative entry.
export function resolvePreferredInstallLayout(cwd: string): PreferredInstallLayout | undefined {
  return builtCheckoutLayout(cwd) ?? localPackageLayout(cwd);
}
