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

export function resolvePreferredInstallLayout(
  cwd: string,
): PreferredInstallLayout | undefined {
  if (readRootPackageName(cwd) !== ROOT_PACKAGE_NAME) return undefined;
  const binPath = resolve(cwd, "dist", "cli", "index.js");
  const staticRoot = resolve(cwd, "dist", "ui", "static");
  if (!existsSync(binPath) || !existsSync(join(staticRoot, "index.html"))) return undefined;
  return { binPath, staticRoot };
}
