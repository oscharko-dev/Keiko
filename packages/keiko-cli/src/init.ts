import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";

export const KEIKO_START_SCRIPT = "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js start";
export const KEIKO_STOP_SCRIPT = "node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js stop";

const USAGE = `Usage:
  keiko init [--package PATH] [--force] [--dry-run]

Adds local package.json scripts for running Keiko:
  keiko:start  -> node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js start
  keiko:stop   -> node ./node_modules/@oscharko-dev/keiko/dist/cli/index.js stop

Rewrites package.json atomically (temp file + rename) and preserves the file's
existing indentation style (2 spaces, 4 spaces, or tabs).

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
  readonly indent: string | number;
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

// #KEIKO-0503: detect the file's existing indentation instead of unconditionally
// re-emitting with 2 spaces. A project that uses tabs or 4-space indentation
// should not see a whole-file reformat diff when `keiko init` adds two scripts.
//
// PR-review follow-up: instead of picking the very first indented line (which may be a
// comment-style non-representative or an odd continuation), scan every property-open line
// and pick the STYLE that appears MOST OFTEN. If tabs vs spaces are mixed, fall back to
// 2 spaces so a mis-detected width does not cause a whole-file reformat.
// PR-review follow-up on KEIKO-0503: don't count absolute indent DEPTH — a conventional
// 2-space file with many nested scripts entries would report "4" (or "6", "8") as the
// dominant depth and JSON.stringify would rewrite the whole file with a 4-space unit.
// Split into two decisions:
//   1. tabs vs spaces: majority of indented lines wins, threshold 2/3.
//   2. width unit: greatest common divisor of all observed space depths, clamped to the
//      shallowest observed depth (so `[2, 4, 6]` → 2, `[4, 8]` → 4, `[3]` → 3).
// This mirrors the algorithm used by editorconfig-style detectors and is robust against
// deep nesting overwhelming the top level.
function detectIndentSignals(raw: string): {
  readonly tab: number;
  readonly spaceDepths: number[];
} {
  let tab = 0;
  const spaceDepths: number[] = [];
  for (const match of raw.matchAll(/\r?\n([ \t]+)"/gu)) {
    const first = match[1];
    if (first === undefined || first.length === 0) continue;
    if (first.startsWith("\t")) {
      tab += 1;
    } else {
      spaceDepths.push(first.length);
    }
  }
  return { tab, spaceDepths };
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return Math.max(a, 0);
}

function detectSpaceUnit(depths: readonly number[]): number {
  if (depths.length === 0) return 2;
  const unit = depths.reduce((acc, depth) => gcd(acc, depth), depths[0] ?? 0);
  if (unit <= 0) return 2;
  const minDepth = Math.min(...depths);
  return Math.min(unit, minDepth);
}

function detectIndent(raw: string): string | number {
  const { tab, spaceDepths } = detectIndentSignals(raw);
  const total = tab + spaceDepths.length;
  if (total === 0) return 2;
  // Tabs vs spaces: whichever side holds a two-thirds plurality wins; otherwise default 2.
  if (tab * 3 >= total * 2) return "\t";
  if (spaceDepths.length * 3 < total * 2) return 2;
  return detectSpaceUnit(spaceDepths);
}

function stringifyPackageJson(data: unknown, indent: string | number): string {
  return `${JSON.stringify(data, null, indent)}\n`;
}

function loadPackageJson(packagePath: string): LoadedPackageJson | InitError {
  if (!existsSync(packagePath)) {
    return { ok: false, message: `keiko init: package.json not found at ${packagePath}.\n` };
  }
  let raw: string;
  try {
    raw = readFileSync(packagePath, "utf8");
  } catch {
    return {
      ok: false,
      message: `keiko init: package.json at ${packagePath} is not readable.\n`,
    };
  }
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      message: `keiko init: package.json at ${packagePath} is not valid JSON.\n`,
    };
  }
  if (!isRecord(packageJson)) {
    return { ok: false, message: "keiko init: package.json must contain a JSON object.\n" };
  }
  return { ok: true, packageJson, indent: detectIndent(raw) };
}

// #KEIKO-0503: temp-file-then-renameSync in the same directory as parsed.packagePath
// so a crash between truncate and write can never leave a truncated package.json —
// the file that makes the project installable. Mirrors launcher-state.ts saveState.
//
// PR-review follow-up: preserve the existing file's permission bits across the rename so a
// project that had, e.g., a 0o600 or otherwise tightened package.json does not silently
// widen to the current umask default. Node's fs API cannot preserve owner/group or ACLs
// without root, and Windows lacks POSIX mode entirely; on POSIX we at minimum re-apply the
// captured mode, which covers the observable regression the reviewer flagged.
function writePackageJsonAtomically(packagePath: string, content: string): void {
  const dir = dirname(packagePath);
  const originalMode = capturePackageMode(packagePath);
  const tmpDir = mkdtempSync(join(dir, ".keiko-init-"));
  const tmpFile = join(tmpDir, "package.json");
  try {
    writeFileSync(tmpFile, content, "utf8");
    // PR-review follow-up: apply the preserved mode to the TEMP file BEFORE the rename so
    // the replacement is published at its correct permissions atomically. Applying chmod
    // AFTER the rename briefly widened access under the default umask. On POSIX, chmodSync
    // failures are surfaced (a preservation failure now aborts the rewrite rather than
    // silently widening the file's permissions).
    if (originalMode !== undefined && process.platform !== "win32") {
      chmodSync(tmpFile, originalMode);
    }
    renameSync(tmpFile, packagePath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function capturePackageMode(packagePath: string): number | undefined {
  if (!existsSync(packagePath)) return undefined;
  try {
    return statSync(packagePath).mode & 0o777;
  } catch {
    return undefined;
  }
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

  const rendered = stringifyPackageJson(initialized.value, loaded.indent);
  if (parsed.dryRun) {
    io.out(rendered);
    return 0;
  }

  writePackageJsonAtomically(parsed.packagePath, rendered);
  io.out(
    "Keiko scripts added to package.json:\n" + "  npm run keiko:start\n" + "  npm run keiko:stop\n",
  );
  return 0;
}
