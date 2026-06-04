import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";

export const KEIKO_START_SCRIPT = "keiko start";
export const KEIKO_STOP_SCRIPT = "keiko stop";

const USAGE = `Usage:
  keiko init [--package PATH] [--force] [--dry-run]

Adds local package.json scripts for running Keiko:
  keiko:start  -> keiko start
  keiko:stop   -> keiko stop

Run this from the project where @oscharko-dev/keiko is installed.
`;

interface InitOptions {
  readonly packagePath: string;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export interface InitCliDeps {
  readonly cwd?: string | undefined;
}

interface LoadedPackageJson {
  readonly ok: true;
  readonly packageJson: Record<string, unknown>;
}

interface InitializedPackageJson {
  readonly ok: true;
  readonly value: Record<string, unknown>;
}

interface InitError {
  readonly ok: false;
  readonly message: string;
}

const EXPECTED_SCRIPTS = {
  "keiko:start": KEIKO_START_SCRIPT,
  "keiko:stop": KEIKO_STOP_SCRIPT,
} as const;

function readFlagValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parseInitArgs(args: readonly string[], cwd: string): InitOptions | "help" | null {
  let packagePath = resolve(cwd, "package.json");
  let force = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--package") {
      const value = readFlagValue(args, i);
      if (value === null) return null;
      packagePath = resolve(cwd, value);
      i += 1;
      continue;
    }
    return null;
  }
  return { packagePath, force, dryRun };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyPackageJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function loadPackageJson(packagePath: string): LoadedPackageJson | InitError {
  if (!existsSync(packagePath)) {
    return { ok: false, message: `keiko init: package.json not found at ${packagePath}.\n` };
  }
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    return {
      ok: false,
      message: `keiko init: package.json at ${packagePath} is not valid JSON.\n`,
    };
  }
  if (!isRecord(packageJson)) {
    return { ok: false, message: "keiko init: package.json must contain a JSON object.\n" };
  }
  return { ok: true, packageJson };
}

function initializedPackageJson(
  packageJson: Record<string, unknown>,
  force: boolean,
): InitializedPackageJson | InitError {
  const existingScripts = packageJson.scripts;
  if (existingScripts !== undefined && !isRecord(existingScripts)) {
    return { ok: false, message: "keiko init: package.json scripts must be a JSON object.\n" };
  }
  const scripts: Record<string, unknown> = existingScripts ?? {};
  const conflicts = Object.entries(EXPECTED_SCRIPTS)
    .filter(([name, value]) => scripts[name] !== undefined && scripts[name] !== value)
    .map(([name]) => name);
  if (conflicts.length > 0 && !force) {
    return {
      ok: false,
      message:
        `keiko init: package.json already defines conflicting script(s): ${conflicts.join(", ")}.\n` +
        "Run `npx keiko init --force` to overwrite them.\n",
    };
  }
  return { ok: true, value: { ...packageJson, scripts: { ...scripts, ...EXPECTED_SCRIPTS } } };
}

export function runInitCli(
  args: readonly string[],
  io: CliIo,
  _env: EnvSource,
  deps: InitCliDeps = {},
): number {
  const cwd = deps.cwd ?? process.cwd();
  const parsed = parseInitArgs(args, cwd);
  if (parsed === "help") {
    io.out(USAGE);
    return 0;
  }
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }

  const loaded = loadPackageJson(parsed.packagePath);
  if (!loaded.ok) {
    io.err(loaded.message);
    return 1;
  }
  const initialized = initializedPackageJson(loaded.packageJson, parsed.force);
  if (!initialized.ok) {
    io.err(initialized.message);
    return 1;
  }

  if (parsed.dryRun) {
    io.out(stringifyPackageJson(initialized.value));
    return 0;
  }

  writeFileSync(parsed.packagePath, stringifyPackageJson(initialized.value), "utf8");
  io.out(
    "Keiko scripts added to package.json:\n" + "  npm run keiko:start\n" + "  npm run keiko:stop\n",
  );
  return 0;
}
