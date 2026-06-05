// Persistent record of generated launcher shortcut paths, written under the existing
// `.keiko/` state dir alongside `ui.pid` / `ui.log` (see `lifecycle.ts`). The state file
// is plaintext JSON and contains ONLY:
//   - the absolute path of each generated shortcut,
//   - the SHA-256 hash of the content Keiko generated for that path at install time,
//   - the platform id and an ISO timestamp for human inspection.
//
// It MUST NOT contain credentials, model identifiers, workspace data, or any
// deployment-specific value (spec §"Security-critical patterns to NOT miss").
//
// SAFETY CONTRACT (spec §"Filesystem safety contract"):
//   - State file is opened with `O_NOFOLLOW` on POSIX; symlinks at the state path are
//     refused. On Windows the equivalent is to refuse if `lstat` reports a symlink.
//   - All writes are atomic via mkdtemp → write → rename (atomic on POSIX; on Windows we
//     accept the standard rename semantics; the file lives under the user's `.keiko/`).
//   - The state dir itself is created with mode 0o700.
//   - `loadState` returns an empty state when the file is missing OR malformed; we never
//     throw on a missing/corrupt state file at read-time, but we DO refuse to write into
//     a symlinked state path.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LauncherError, launcherFor, type Platform } from "./launcher-platforms.js";
import { isRealpathContained } from "./launcher-paths.js";

export const LAUNCHER_STATE_VERSION = 1 as const;
const STATE_FILE_NAME = "launcher-state.json";
const HASH_HEX_RE = /^[0-9a-f]{64}$/;

export interface LauncherStateEntry {
  readonly path: string;
  readonly platform: Platform;
  readonly contentSha256: string;
  readonly createdAt: string;
}

export interface LauncherState {
  readonly version: 1;
  readonly entries: readonly LauncherStateEntry[];
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function stateFilePath(stateDir: string): string {
  return join(stateDir, STATE_FILE_NAME);
}

function emptyState(): LauncherState {
  return { version: LAUNCHER_STATE_VERSION, entries: [] };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPlatform(v: unknown): v is Platform {
  return v === "linux" || v === "darwin" || v === "win32";
}

// F1 parse-time barrier: when a homedir is provided, every entry's `path` must realpath-
// contain to the approved installDir for its declared platform. An attacker who plants
// a state file with `path: "/home/u/.ssh/authorized_keys"` will have the entry SILENTLY
// DROPPED at parse time so neither `cmdRemove` (which would `unlinkSync`) nor `cmdStatus`
// (which would `readFileSync`) ever sees the attacker-controlled path. A stderr warning
// is emitted via `onWarn` so a planted entry is OBSERVABLE without crashing the workflow.
//
// When no homedir is provided (legacy callers and the low-level parse-shape tests in
// `launcher-state.test.ts`), the containment check is skipped — that callers don't
// touch the filesystem on the parsed value, so a shape-only check is acceptable. Every
// `launcher.ts` consumer threads homedir through.
export interface ParseOptions {
  readonly homedir?: string | undefined;
  readonly onWarn?: ((message: string) => void) | undefined;
}

function parseEntryShape(raw: unknown): LauncherStateEntry | null {
  if (!isObject(raw)) return null;
  const { path, platform, contentSha256, createdAt } = raw;
  if (typeof path !== "string" || path.length === 0) return null;
  if (!isPlatform(platform)) return null;
  if (typeof contentSha256 !== "string" || !HASH_HEX_RE.test(contentSha256)) return null;
  if (typeof createdAt !== "string") return null;
  return { path, platform, contentSha256, createdAt };
}

function isEntryContained(entry: LauncherStateEntry, options: ParseOptions): boolean {
  if (options.homedir === undefined) return true;
  const approvedDir = launcherFor(entry.platform).installDirFor(options.homedir);
  if (isRealpathContained(approvedDir, entry.path)) return true;
  options.onWarn?.(
    `keiko launcher: refusing tampered state entry — path is outside the approved directory.\n  approved: ${approvedDir}\n  path:     ${entry.path}\n`,
  );
  return false;
}

function parseEntry(raw: unknown, options: ParseOptions = {}): LauncherStateEntry | null {
  const entry = parseEntryShape(raw);
  if (entry === null) return null;
  return isEntryContained(entry, options) ? entry : null;
}

export function parseState(raw: unknown, options: ParseOptions = {}): LauncherState {
  if (!isObject(raw)) return emptyState();
  if (raw.version !== LAUNCHER_STATE_VERSION) return emptyState();
  if (!Array.isArray(raw.entries)) return emptyState();
  const entries: LauncherStateEntry[] = [];
  for (const item of raw.entries) {
    const parsed = parseEntry(item, options);
    if (parsed !== null) entries.push(parsed);
  }
  return { version: LAUNCHER_STATE_VERSION, entries };
}

type WarnFn = (msg: string) => void;

function defaultWarn(msg: string): void {
  process.stderr.write(msg);
}

// Returns the lstat result, OR `null` to signal "treat as empty state". Refuses
// (throws LauncherError) when the state path is a symlink (defense-in-depth).
function statStateFile(file: string, warn: WarnFn): ReturnType<typeof lstatSync> | null {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warn(`keiko launcher: cannot stat state file (${code ?? "unknown error"}): ${file}\n`);
    }
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw new LauncherError(
      "STATE_SYMLINK_REFUSED",
      `keiko launcher: state file is a symlink and was refused: ${file}`,
    );
  }
  if (!stat.isFile()) return null;
  return stat;
}

function readStateRaw(file: string, warn: WarnFn): string | null {
  try {
    return readWithoutFollow(file);
  } catch (e) {
    if (e instanceof LauncherError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    warn(`keiko launcher: cannot read state file (${code ?? "unknown error"}): ${file}\n`);
    return null;
  }
}

// Reads the state file, refusing to follow symlinks at the state path. Returns the empty
// state if the file is missing, unreadable, malformed, or contains an unrecognised version.
// Throws LauncherError ONLY when the state path exists as a symlink (defense-in-depth).
//
// When `options.homedir` is provided, every parsed entry is also containment-checked
// against the approved installDir for its declared platform (F1 parse-time barrier).
// Tampered entries are silently dropped and reported via `options.onWarn`.
//
// F6 error classification: ENOENT (missing file) is the silent-empty path; any other
// `lstat`/read failure (EACCES/EIO/EISDIR) is surfaced via `options.onWarn` so the user
// sees a signal instead of a phantom empty state. We still return `emptyState()` so the
// workflow continues — `loadState` is best-effort by contract.
export function loadState(stateDir: string, options: ParseOptions = {}): LauncherState {
  const file = stateFilePath(stateDir);
  const warn: WarnFn = options.onWarn ?? defaultWarn;
  if (statStateFile(file, warn) === null) return emptyState();
  const raw = readStateRaw(file, warn);
  if (raw === null) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`keiko launcher: state file is not valid JSON; ignoring: ${file}\n`);
    return emptyState();
  }
  return parseState(parsed, options);
}

// F5: cap on the state-file size we will allocate a Buffer for. The launcher records
// a handful of entries (~ a few hundred bytes each); 1 MiB is overwhelming headroom
// and prevents a hostile/corrupt 1 GB state file from OOM-ing the launcher.
export const MAX_STATE_FILE_BYTES = 1 << 20;

// O_NOFOLLOW-based read: refuses to traverse a symlink at the final path component.
// We avoid `readFileSync(file)` because it would follow a symlink. On Windows the
// O_NOFOLLOW flag is undefined; we fall back to a normal open after the `lstat` check
// in `loadState` has already proved the path is not a link.
function readWithoutFollow(file: string): string {
  const nofollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(file, fsConstants.O_RDONLY | nofollow);
  try {
    const stat = fstatSync(fd);
    if (stat.size > MAX_STATE_FILE_BYTES) {
      throw new LauncherError(
        "STATE_TOO_LARGE",
        `keiko launcher: state file exceeds ${String(MAX_STATE_FILE_BYTES)} bytes (got ${String(stat.size)}); refusing to load.`,
      );
    }
    if (stat.size === 0) return "";
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Atomic write via mkdtemp → write → rename. The state dir is created with mode 0o700.
// The final rename is atomic on POSIX and best-effort on Windows; both are acceptable
// for a user-local state file. If the final path is a symlink we refuse before write
// (defense-in-depth: a hostile state-dir actor could plant a symlink to /etc/passwd).
export function saveState(stateDir: string, state: LauncherState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = stateFilePath(stateDir);
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      throw new LauncherError(
        "STATE_SYMLINK_REFUSED",
        `keiko launcher: state file is a symlink and was refused: ${file}`,
      );
    }
  } catch (e) {
    if (e instanceof LauncherError) throw e;
    // ENOENT — fine; we're about to create it.
  }
  const tmpDir = mkdtempSync(join(stateDir, ".launcher-state-"));
  const tmpFile = join(tmpDir, "state.json");
  try {
    writeFileSync(tmpFile, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpFile, file);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function upsertEntry(state: LauncherState, entry: LauncherStateEntry): LauncherState {
  const others = state.entries.filter((e) => e.path !== entry.path);
  return { version: LAUNCHER_STATE_VERSION, entries: [...others, entry] };
}

export function removeEntry(state: LauncherState, path: string): LauncherState {
  return {
    version: LAUNCHER_STATE_VERSION,
    entries: state.entries.filter((e) => e.path !== path),
  };
}

export function findEntry(state: LauncherState, path: string): LauncherStateEntry | undefined {
  return state.entries.find((e) => e.path === path);
}
