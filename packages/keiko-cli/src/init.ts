import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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

function detectSpaceUnit(depths: readonly number[]): number {
  if (depths.length === 0) return 2;
  // PR-review follow-up (Codex thread 3771469014): reduce instead of Math.min(...depths).
  // A large generated package.json can produce enough space-depth samples to exceed V8's
  // function-argument limit and throw RangeError on the spread call.
  const minDepth = depths.reduce((acc, depth) => (depth < acc ? depth : acc), depths[0] ?? 0);
  // PR-review follow-up (KfQ thread 3771862601): use the shallowest observed indent depth
  // rather than the GCD of all observed depths. The shallowest captured line is the closest
  // proxy for the file's top-level indent step; the GCD of nested-only depths (e.g. depths
  // [4,8,12] → GCD 4) can exceed the actual top-level width when the top-level key sits on
  // the same line as `{` and never gets captured by the leading-whitespace regex, which
  // would rewrite the whole file with a deeper indent and force a spurious full-file diff.
  // A shallowest of 1 comes out of hand-authored JSON with a single leading space and is
  // clamped up to 2 because no convention writes a 1-space JSON file.
  return Math.max(minDepth, 2);
}

function detectIndent(raw: string): string | number {
  const { tab, spaceDepths } = detectIndentSignals(raw);
  const total = tab + spaceDepths.length;
  if (total === 0) return 2;
  // Tabs vs spaces: whichever side holds a STRICT two-thirds plurality wins (`>` not `>=`)
  // so a marginal split like 4:6 defaults to 2 spaces instead of forcing a whole-file
  // reformat on a hair-line majority.
  if (tab * 3 > total * 2) return "\t";
  if (spaceDepths.length * 3 <= total * 2) return 2;
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
const INIT_STAGING_PREFIX = ".keiko-init-";
// PR-review follow-up (KfQ thread 3769767223): a marker file dropped by our writer inside
// each mkdtemp'd staging directory. sweepStaleInitStagingDirs requires the marker's presence
// AND age before removing an entry, so a user directory that happens to match the
// .keiko-init-XXXXXX prefix+suffix shape stays untouched even if it's older than the cutoff.
const INIT_STAGING_MARKER = ".keiko-init-owned";

function writePackageJsonAtomically(packagePath: string, content: string): void {
  // PR-review follow-up: if the caller passed a symlink to package.json, replace the REAL
  // target atomically instead of the symlink entry itself. `renameSync` operates on
  // directory entries, so writing "next to the symlink" and renaming it in place would
  // sever the link and leave the canonical target unchanged, while still reporting
  // success. `realpathSync` on a non-symlink returns the same path unchanged.
  const canonicalPath = resolveCanonicalPackagePath(packagePath);
  const dir = dirname(canonicalPath);
  // PR-review follow-up: sweep any leftover .keiko-init-* staging dirs before creating a new
  // one so an earlier interrupted `keiko init` (SIGKILL between mkdtempSync and rmSync) does
  // not leave the user's repo permanently dirty across retries. Match the exact mkdtemp
  // suffix shape so a customer-created directory with the same prefix is left untouched.
  sweepStaleInitStagingDirs(dir);
  const originalMode = capturePackageMode(canonicalPath);
  const tmpDir = mkdtempSync(join(dir, INIT_STAGING_PREFIX));
  const tmpFile = join(tmpDir, "package.json");
  try {
    // KfQ thread 3769767223: touch the ownership marker BEFORE writing the payload so the
    // sweep can positively identify this directory as one of our staging dirs even if we die
    // before renameSync. writeFileSync throwing here surfaces the same way as any other
    // atomic-write failure — the finally block still removes the dir.
    writeFileSync(join(tmpDir, INIT_STAGING_MARKER), "", "utf8");
    writeFileSync(tmpFile, content, "utf8");
    // PR-review follow-up: apply the preserved mode to the TEMP file BEFORE the rename so
    // the replacement is published at its correct permissions atomically. Applying chmod
    // AFTER the rename briefly widened access under the default umask. On POSIX, chmodSync
    // failures are surfaced (a preservation failure now aborts the rewrite rather than
    // silently widening the file's permissions).
    if (originalMode !== undefined && process.platform !== "win32") {
      chmodSync(tmpFile, originalMode);
    }
    renameSync(tmpFile, canonicalPath);
  } finally {
    // PR-review follow-up (Codex thread 3771128762): rmSync failure MUST NOT masquerade as a
    // failed atomic rewrite. If renameSync succeeded, the new package.json is already
    // published; a cleanup failure on the marker-only tmpDir (EACCES / EBUSY / EIO) is a
    // separate concern the sweep on the next run will clean up. Swallow rmSync errors so
    // the primary outcome (success or the rename error itself) reaches the caller.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort staging cleanup; sweepStaleInitStagingDirs will remove it on the next
      // init run once the ownership marker + age cutoff match.
    }
  }
}

// Any staging dir whose mtime is older than this counts as truly abandoned. A concurrent
// `keiko init` completes in well under a second even on slow disks, so a 60-second cutoff is
// generous while still surfacing dirs left behind by a SIGKILL between mkdtempSync and rmSync.
const INIT_STAGING_STALE_AFTER_MS = 60_000;

function sweepStaleInitStagingDirs(dir: string): void {
  if (!existsSync(dir)) return;
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const staleBefore = Date.now() - INIT_STAGING_STALE_AFTER_MS;
  for (const name of entries) {
    if (!name.startsWith(INIT_STAGING_PREFIX)) continue;
    // Match Node's mkdtemp suffix shape (6 alphanumerics) so a customer-created directory
    // that happens to share the prefix is left alone.
    const suffix = name.slice(INIT_STAGING_PREFIX.length);
    if (!/^[A-Za-z0-9]{6}$/u.test(suffix)) continue;
    // PR-review follow-up (Codex thread 3769557880): only sweep dirs that are demonstrably
    // stale. Two concurrent `keiko init` processes race on the same package.json — without
    // this age check the second process would rmSync the first's live .keiko-init-XXXXXX dir
    // between its mkdtempSync and renameSync, so the first invocation would fail during
    // write even though neither hit a real manifest conflict.
    const staging = join(dir, name);
    // KfQ thread 3769767223: BOTH age AND our ownership marker must be present before we
    // remove the entry. The prefix+suffix shape is only a first filter; if a customer creates
    // .keiko-init-XXXXXX by hand and leaves it older than the cutoff the sweep still leaves
    // it alone because the ownership marker is missing.
    if (!isStagingDirOlderThan(staging, staleBefore)) continue;
    if (!existsSync(join(staging, INIT_STAGING_MARKER))) continue;
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; a stale dir that we cannot remove (locked, mount-boundary)
      // does not block the current rewrite because mkdtempSync will pick its own name.
    }
  }
}

function isStagingDirOlderThan(path: string, staleBefore: number): boolean {
  try {
    return statSync(path).mtimeMs < staleBefore;
  } catch {
    // A vanished entry (already reclaimed) is treated as not-old-enough: leave the sweep for a
    // future run rather than racing against another process that already cleaned it up.
    return false;
  }
}

function resolveCanonicalPackagePath(packagePath: string): string {
  // PR-review follow-up (Codex thread 3769557875): propagate lstat/realpath failures instead
  // of falling back to the symlink path. A transient EACCES/EIO/EBUSY on a symlink here used
  // to skip canonicalization silently, and if access recovered before renameSync the rewrite
  // replaced the symlink entry — severing the link and leaving the canonical target stale —
  // while `keiko init` reported success. Surfacing the error keeps the invariant that a
  // reported-success rewrite always updated the target the symlink pointed at.
  //
  // PR-review follow-up (Codex thread 3770211407): call lstatSync directly. Gating it behind
  // existsSync used to collapse EIO/EACCES to "return original path", which reintroduced the
  // same silent-canonicalisation bug the earlier fix removed. Only ENOENT (the file does not
  // exist yet — first run of `keiko init`) means "no canonical target to resolve"; any other
  // errno propagates.
  let stat;
  try {
    stat = lstatSync(packagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return packagePath;
    throw error;
  }
  return stat.isSymbolicLink() ? realpathSync(packagePath) : packagePath;
}

function capturePackageMode(packagePath: string): number | undefined {
  // PR-review follow-up: only the "file does not exist yet" case returns undefined (the caller
  // has no mode to preserve). A statSync failure on an existing file (I/O, EACCES) propagates
  // so writePackageJsonAtomically does not silently skip the chmod and widen the file to the
  // umask default while reporting success.
  //
  // PR-review follow-up (Codex thread 3769903830): use statSync directly and inspect the errno
  // instead of going through existsSync. existsSync collapses EIO/EACCES to `false`, which
  // returned undefined here and made the atomic writer skip the pre-rename chmod — if access
  // recovered for the following write, a 0600 manifest was published at the umask default
  // while the command reported success. Only ENOENT (genuinely absent) yields undefined.
  try {
    return statSync(packagePath).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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
