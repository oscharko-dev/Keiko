import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

const ROOT_PACKAGE_NAME = "@oscharko-dev/keiko";

export interface PreferredInstallLayout {
  readonly binPath: string;
  readonly staticRoot: string;
}

export interface LocalPackageInstallLayout extends PreferredInstallLayout {
  readonly packageRoot: string;
}

export type KeikoBinarySource =
  | "local-build"
  | "local-package"
  | "env-override"
  | "argv"
  | "path";

export interface KeikoBinaryResolution {
  readonly binPath: string;
  readonly source: KeikoBinarySource;
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

export function builtCheckoutLayout(cwd: string): PreferredInstallLayout | undefined {
  if (readRootPackageName(cwd) !== ROOT_PACKAGE_NAME) return undefined;
  return builtLayoutAt(cwd);
}

function localPackageLayout(cwd: string): LocalPackageInstallLayout | undefined {
  const packageRoot = localPackageRoot(cwd);
  const preferred = builtLayoutAt(packageRoot);
  if (preferred === undefined) return undefined;
  return { ...preferred, packageRoot };
}

export function resolvePreferredInstallLayout(
  cwd: string,
): PreferredInstallLayout | undefined {
  return builtCheckoutLayout(cwd) ?? localPackageLayout(cwd);
}

export function resolveKeikoBinary(
  cwd: string,
  env: EnvSource = process.env,
  argv: readonly string[] = process.argv,
): KeikoBinaryResolution | undefined {
  const built = builtCheckoutLayout(cwd);
  if (built !== undefined) {
    return { source: "local-build", binPath: built.binPath };
  }
  const local = localPackageLayout(cwd);
  if (local !== undefined) {
    return { source: "local-package", binPath: local.binPath };
  }
  const fromEnv = env.KEIKO_CLI_BIN_PATH ?? process.env.KEIKO_CLI_BIN_PATH;
  if (typeof fromEnv === "string" && isAbsolute(fromEnv) && existsSync(fromEnv)) {
    return { source: "env-override", binPath: fromEnv };
  }
  const entry = argv[1];
  if (typeof entry === "string" && isAbsolute(entry) && existsSync(entry)) {
    return { source: "argv", binPath: entry };
  }
  const cwdEnv = env.PATH ?? process.env.PATH;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const names =
    process.platform === "win32" ? ["keiko.cmd", "keiko.exe", "keiko.bat", "keiko"] : ["keiko"];
  if (typeof cwdEnv === "string" && cwdEnv.length > 0) {
    for (const dir of cwdEnv.split(delimiter)) {
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) {
          return { source: "path", binPath: candidate };
        }
      }
    }
  }
  return undefined;
}
