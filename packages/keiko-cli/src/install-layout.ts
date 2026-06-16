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

function builtLayoutAt(root: string): PreferredInstallLayout | undefined {
  const binPath = resolve(root, "dist", "cli", "index.js");
  const staticRoot = resolve(root, "dist", "ui", "static");
  if (!existsSync(binPath) || !existsSync(join(staticRoot, "index.html"))) return undefined;
  return { binPath, staticRoot };
}

function builtCheckoutLayout(cwd: string): PreferredInstallLayout | undefined {
  if (readRootPackageName(cwd) !== ROOT_PACKAGE_NAME) return undefined;
  return builtLayoutAt(cwd);
}

function localPackageLayout(cwd: string): PreferredInstallLayout | undefined {
  return builtLayoutAt(resolve(cwd, "node_modules", "@oscharko-dev", "keiko"));
}

// Precedence: built monorepo checkout first, then a local node_modules package.
// Env/argv/PATH fallbacks live in the caller (lifecycle.cliEntryPath).
export function resolvePreferredInstallLayout(cwd: string): PreferredInstallLayout | undefined {
  return builtCheckoutLayout(cwd) ?? localPackageLayout(cwd);
}
