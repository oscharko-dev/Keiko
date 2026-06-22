import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import type { CliIo } from "./runner.js";
import {
  hasBuiltKeikoLayout,
  localPackageRoot,
  resolvePreferredInstallLayout,
} from "./install-layout.js";

interface PackageJsonLike {
  readonly version?: unknown;
}

interface LocalInstall {
  readonly packageRoot: string;
  readonly cliEntry: string;
  readonly version: string;
}

interface DoctorReport {
  readonly cwd: string;
  readonly runningEntry: string | undefined;
  readonly runningVersion: string;
  readonly localBuildBin: string | undefined;
  readonly localPackageInstall: LocalInstall | undefined;
  readonly warning: string | undefined;
}

export interface DoctorCliDeps {
  readonly cwd?: string | undefined;
  readonly argv?: readonly string[] | undefined;
}

function readVersion(packageJsonPath: string): string | undefined {
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJsonLike;
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function resolveLocalPackageInstall(cwd: string): LocalInstall | undefined {
  const packageRoot = localPackageRoot(cwd);
  const cliEntry = resolve(packageRoot, "dist", "cli", "index.js");
  const version = readVersion(join(packageRoot, "package.json"));
  if (!hasBuiltKeikoLayout(packageRoot) || version === undefined) return undefined;
  return { packageRoot, cliEntry, version };
}

function resolveRunningEntry(argv: readonly string[] | undefined): string | undefined {
  const entry = argv?.[1];
  if (typeof entry !== "string") return undefined;
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(entry);
  if (!isAbsolute(entry) && !windowsAbsolute) return undefined;
  return entry;
}

function staleBinaryWarning(report: DoctorReport): string | undefined {
  const runningEntry = report.runningEntry;
  if (runningEntry === undefined) return undefined;
  if (report.localBuildBin !== undefined && runningEntry !== report.localBuildBin) {
    return (
      "You are running Keiko from a different binary than this checkout's built CLI entry.\n" +
      `  running: ${runningEntry}\n` +
      `  local build: ${report.localBuildBin}\n` +
      "Use `npm run keiko:start` or `node ./dist/cli/index.js start` from this checkout."
    );
  }
  const localInstall = report.localPackageInstall;
  if (localInstall !== undefined && runningEntry !== localInstall.cliEntry) {
    return (
      "You are running a different Keiko binary than the package installed in this workspace.\n" +
      `  running: ${report.runningVersion} (${runningEntry})\n` +
      `  local install: ${localInstall.version} (${localInstall.cliEntry})\n` +
      "Use the local package script (`npm run keiko:start`) or remove the stale global install."
    );
  }
  return undefined;
}

export function collectDoctorReport(deps: DoctorCliDeps = {}): DoctorReport {
  const cwd = deps.cwd ?? process.cwd();
  const runningEntry = resolveRunningEntry(deps.argv ?? process.argv);
  const localBuildBin = resolvePreferredInstallLayout(cwd)?.binPath;
  const localPackageInstall = resolveLocalPackageInstall(cwd);
  const report: DoctorReport = {
    cwd,
    runningEntry,
    runningVersion: SDK_VERSION,
    localBuildBin,
    localPackageInstall,
    warning: undefined,
  };
  return { ...report, warning: staleBinaryWarning(report) };
}

function windowsRemediation(): string {
  return [
    "Windows remediation:",
    "  1. Run `where.exe keiko` to see which global shim wins on PATH.",
    "  2. Prefer `npm run keiko:start` from the project checkout.",
    "  3. If a stale global install is found, run `npm uninstall -g @oscharko-dev/keiko`.",
    "  4. For a direct local launch, run `node .\\dist\\cli\\index.js start`.",
  ].join("\n");
}

function posixRemediation(): string {
  return [
    "macOS/Linux remediation:",
    "  1. Run `which keiko` to see which global binary wins on PATH.",
    "  2. Prefer `npm run keiko:start` from the project checkout.",
    "  3. If a stale global install is found, run `npm uninstall -g @oscharko-dev/keiko`.",
    "  4. For a direct local launch, run `node ./dist/cli/index.js start`.",
  ].join("\n");
}

export function emitDoctorWarning(io: CliIo, deps: DoctorCliDeps = {}): void {
  const report = collectDoctorReport(deps);
  if (report.warning === undefined) return;
  io.err(`keiko warning: stale launch path detected.\n${report.warning}\n`);
}

export function runDoctorCli(
  _args: readonly string[],
  io: CliIo,
  _env: EnvSource,
  deps: DoctorCliDeps = {},
): number {
  const report = collectDoctorReport(deps);
  io.out(`Keiko doctor\n`);
  io.out(`  cwd: ${report.cwd}\n`);
  io.out(`  running version: ${report.runningVersion}\n`);
  io.out(`  running entry: ${report.runningEntry ?? "(unavailable)"}\n`);
  io.out(`  local built CLI: ${report.localBuildBin ?? "(not found)"}\n`);
  io.out(
    `  local installed package: ${report.localPackageInstall?.cliEntry ?? "(not found)"}\n`,
  );
  io.out(`  local installed version: ${report.localPackageInstall?.version ?? "(not found)"}\n`);
  if (report.warning !== undefined) {
    io.out(`\nDiagnosis:\n${report.warning}\n\n`);
  } else {
    io.out("\nDiagnosis:\nNo stale-launch mismatch detected.\n\n");
  }
  io.out(`${process.platform === "win32" ? windowsRemediation() : posixRemediation()}\n`);
  return 0;
}
