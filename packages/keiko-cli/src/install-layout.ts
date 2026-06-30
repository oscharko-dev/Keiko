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

export type KeikoBinarySource = "local-build" | "local-package" | "env-override" | "argv" | "path";

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

function builtCheckoutLayout(cwd: string): PreferredInstallLayout | undefined {
  if (readRootPackageName(cwd) !== ROOT_PACKAGE_NAME) return undefined;
  return builtLayoutAt(cwd);
}

function localPackageLayout(cwd: string): LocalPackageInstallLayout | undefined {
  const packageRoot = localPackageRoot(cwd);
  const preferred = builtLayoutAt(packageRoot);
  if (preferred === undefined) return undefined;
  return { ...preferred, packageRoot };
}

export function resolvePreferredInstallLayout(cwd: string): PreferredInstallLayout | undefined {
  return builtCheckoutLayout(cwd) ?? localPackageLayout(cwd);
}

export function resolveKeikoBinary(
  cwd: string,
  env: EnvSource = process.env,
  argv: readonly string[] = process.argv,
): KeikoBinaryResolution | undefined {
  const checks: readonly {
    readonly source: KeikoBinarySource;
    readonly binPath: string | undefined;
  }[] = [
    {
      source: "env-override",
      binPath: absoluteExistingPath(env.KEIKO_CLI_BIN_PATH ?? process.env.KEIKO_CLI_BIN_PATH),
    },
    { source: "argv", binPath: absoluteExistingPath(argv[1]) },
    { source: "local-build", binPath: builtCheckoutLayout(cwd)?.binPath },
    { source: "local-package", binPath: localPackageLayout(cwd)?.binPath },
  ];

  for (const candidate of checks) {
    if (candidate.binPath !== undefined) {
      return { source: candidate.source, binPath: candidate.binPath };
    }
  }

  const pathHit = resolveKeikoBinaryFromPath(process.platform, env.PATH ?? process.env.PATH);
  if (pathHit !== undefined) {
    return { source: "path", binPath: pathHit };
  }
  return undefined;
}

function absoluteExistingPath(value: unknown): string | undefined {
  return typeof value === "string" && isAbsolute(value) && existsSync(value) ? value : undefined;
}

function resolveKeikoBinaryFromPath(
  platform: NodeJS.Platform,
  pathValue: unknown,
): string | undefined {
  if (typeof pathValue !== "string" || pathValue.length === 0) return undefined;
  const delimiter = platform === "win32" ? ";" : ":";
  const names = platform === "win32" ? ["keiko.cmd", "keiko.exe", "keiko.bat", "keiko"] : ["keiko"];
  return pathValue
    .split(delimiter)
    .flatMap((directory) => names.map((name) => join(directory, name)))
    .find((candidate) => existsSync(candidate));
}
