// Shared resolution of Keiko's runtime state directory and the set of files Keiko
// itself writes there. Consumed by `keiko uninstall` (to reverse them) and
// `keiko repair` (to detect and clean stale ones). Resolution mirrors `lifecycle.ts`
// (`--state-dir` > KEIKO_STATE_DIR > <cwd>/.keiko) so `start`, `uninstall`, and
// `repair` all operate on the same directory.
//
// DELETION SAFETY CONTRACT: callers remove ONLY the explicitly enumerated state
// artifacts below (the fixed `KEIKO_STATE_FILES` plus the launcher's
// `.launcher-state-*` mkdtemp dirs) and then rmdir the state directory when it is
// empty. Nothing here recursively deletes an arbitrary directory, so a mis-pointed
// `--state-dir`/KEIKO_STATE_DIR can never escalate into data loss outside Keiko's
// own files.

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

export const DEFAULT_STATE_DIR_NAME = ".keiko";

// Runtime files Keiko writes under the state dir. `ui.pid`/`ui.log` come from
// `lifecycle.ts`; `launcher-state.json` from `launcher-state.ts`.
export const KEIKO_STATE_FILES = ["ui.pid", "ui.log", "launcher-state.json"] as const;

// `launcher-state.ts` writes ephemeral mkdtemp dirs with this prefix during atomic
// state saves; a crash can leave one behind, so uninstall/repair sweep them by prefix.
export const LAUNCHER_STATE_TMP_PREFIX = ".launcher-state-";

// Resolves the state directory the same way `keiko start` does. An explicit
// `--state-dir` argument wins, then `KEIKO_STATE_DIR`, then `<cwd>/.keiko`. Relative
// values resolve against `cwd`.
export function resolveStateDir(cwd: string, env: EnvSource, stateDirArg?: string): string {
  const value =
    stateDirArg !== undefined && stateDirArg.length > 0
      ? stateDirArg
      : (env.KEIKO_STATE_DIR ?? DEFAULT_STATE_DIR_NAME);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

// Reads a pid file written by `lifecycle.ts`. Returns the integer pid, or undefined
// when the file is absent or does not contain a positive integer.
export function readPidFile(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}

// Liveness probe identical in semantics to the lifecycle handler: a successful
// signal-0 means alive; an EPERM error means the process exists but is owned by
// another user (still alive); any other error means it is gone. Kept local to this
// leaf module so uninstall/repair do not pull in lifecycle's heavy spawn/net imports.
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export type PidState = "absent" | "stale" | "running";

export interface PidClassification {
  readonly state: PidState;
  readonly pid: number | undefined;
}

// Classifies the UI pid file: `absent` (missing or malformed), `stale` (a pid is
// recorded but the process is gone), or `running` (recorded and alive).
export function classifyPid(
  pidFilePath: string,
  isAlive: (pid: number) => boolean,
): PidClassification {
  const pid = readPidFile(pidFilePath);
  if (pid === undefined) return { state: "absent", pid: undefined };
  return isAlive(pid) ? { state: "running", pid } : { state: "stale", pid };
}

// ── Runtime-state confidentiality manifest (Issue #1321) ──────────────────────
//
// `keiko repair` and `keiko uninstall --state` must reason about EVERY Keiko-owned
// sensitive artifact under the state directory, not only the three lifecycle/launcher
// files above. Rather than a blanket recursive chmod/delete of arbitrary content under
// `.keiko` (which could touch a customer file that merely happens to live there), this
// manifest is an explicit allowlist describing the on-disk layout each Keiko store
// writes:
//
//   <stateDir>/
//     ui.pid, ui.log                        lifecycle.ts
//     launcher-state.json                   launcher-state.ts
//     .launcher-state-*/                    launcher-state.ts atomic-save temp dirs
//     keiko-ui.db[-wal|-shm|.corrupt.*]     keiko-server  store/paths.ts (UI_DB_FILENAME)
//     keiko.config.json                     keiko-server  deps.ts (model-gateway config)
//     credentials/*.vault, *.key            keiko-server  credentialVault.ts (sealed apiKeys + keyfile)
//     memory/keiko-memory.db[-wal|-shm|.*]  keiko-memory-vault paths.ts (MEMORY_DB_FILENAME)
//     local-knowledge/<ns>/capsules.db[…]   keiko-local-knowledge store-paths.ts
//     evidence/<runId>.json|.lock|…         keiko-evidence store.ts
//     evidence/figma/*.vault, *.key         keiko-server  figmaTokenStore.ts (sealed Figma PAT + keyfile)
//     evidence/qi/<runId>.qi.json|…         keiko-evidence qualityIntelligence/*
//     evidence/qi/figma-snapshots/<runId>/… keiko-evidence figmaSnapshot side files
//
// The sealed `*.vault` ciphertext and its `*.key` keyfile (the env/keychain-tier fallback,
// ADR-0046) are the most confidentiality-critical artifacts here, so they are first-class
// manifest entries rather than incidental files.
//
// The filenames are duplicated here ON PURPOSE: keiko-cli is a leaf consumer and must
// not take a package-graph edge onto keiko-local-knowledge / keiko-evidence internals
// just to learn a constant. Each descriptor cites its source of truth so drift stays
// auditable. The walker classifies entries WITHOUT mutating anything — `repair` chmods
// and `uninstall` unlinks, but only entries this allowlist recognizes as Keiko-owned;
// every unrecognized entry is reported as `retained` and left in place.

// POSIX modes Keiko enforces on its own runtime state: private directories and private
// files. NTFS has no equivalent; callers no-op on win32 and emit a diagnostic instead.
export const RUNTIME_STATE_DIR_MODE = 0o700;
export const RUNTIME_STATE_FILE_MODE = 0o600;

const UI_DB_FILENAME = "keiko-ui.db"; // keiko-server/src/store/paths.ts
const MEMORY_DB_FILENAME = "keiko-memory.db"; // keiko-memory-vault/src/paths.ts
const CAPSULES_DB_FILENAME = "capsules.db"; // keiko-local-knowledge/src/store-paths.ts
const GATEWAY_CONFIG_FILENAME = "keiko.config.json"; // keiko-server/src/deps.ts
const CREDENTIALS_SUBDIR = "credentials"; // keiko-server/src/credentialVault.ts (CREDENTIALS_SUBDIR)
const MEMORY_SUBDIR = "memory"; // keiko-memory-vault/src/paths.ts (MEMORY_DIR_NAME)
const LOCAL_KNOWLEDGE_SUBDIR = "local-knowledge"; // keiko-local-knowledge store-paths.ts (SUBSYSTEM_DIR)
const EVIDENCE_SUBDIR = "evidence"; // keiko-evidence/src/store.ts (DEFAULT_EVIDENCE_DIR)
const FIGMA_VAULT_SUBDIR = "figma"; // keiko-server figmaTokenStore.ts (Figma PAT vault dir, under evidence)
const QI_SUBDIR = "qi"; // keiko-evidence/src/qualityIntelligence/store.ts (QI_SUBDIR)
const FIGMA_SNAPSHOTS_SUBDIR = "figma-snapshots"; // keiko-evidence figmaSnapshot/store.ts (SIDE_FILE_SUBDIR)

export type RuntimeStateCategory =
  | "lifecycle"
  | "launcher"
  | "ui-database"
  | "gateway-config"
  | "credential-vault"
  | "memory-vault"
  | "local-knowledge"
  | "evidence"
  | "quality-intelligence";

// A SQLite store file plus its WAL/SHM sidecars and `.corrupt.<ts>` quarantine copies:
// `<base>`, `<base>-wal`, `<base>-shm`, `<base>.corrupt.<ts>`, `<base>-wal.corrupt.<ts>`.
function isSqliteFamily(base: string, name: string): boolean {
  return name === base || name.startsWith(`${base}-`) || name.startsWith(`${base}.`);
}

// Evidence / Quality-Intelligence records and their lock sidecars are all `*.json` /
// `*.lock` (`<runId>.json`, `<runId>.candidates.json`, `<runId>.qi.json`, `<runId>.lock`,
// `<runId>.figma-snapshot.json`, …). Matching by the store's file vocabulary keeps a
// stray non-`.json` user file in these dirs classified as `retained`.
function isEvidenceRecord(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".lock");
}

// Sealed credential material: the AES-256-GCM `*.vault` ciphertext and the `*.key` keyfile
// (the env/keychain-tier fallback). Both must stay owner-only (ADR-0046).
function isVaultFile(name: string): boolean {
  return name.endsWith(".vault") || name.endsWith(".key");
}

const NO_CHILD = (): OwnedSubtree | undefined => undefined;
const OWNS_NO_FILE = (): boolean => false;

// A Keiko-owned subtree under the state directory.
//   * `whole` subtrees are leaf areas only Keiko ever writes (the figma-snapshot side-file
//     tree, launcher atomic-save temp dirs): every descendant file/dir is owned.
//   * classified subtrees own the direct files matched by `ownsFile` and recurse into the
//     child directory returned by `childSubtree`; everything else is `retained`.
interface OwnedSubtree {
  readonly category: RuntimeStateCategory;
  readonly whole: boolean;
  readonly ownsFile: (name: string) => boolean;
  readonly childSubtree: (name: string) => OwnedSubtree | undefined;
}

const figmaSnapshotsSubtree: OwnedSubtree = {
  category: "quality-intelligence",
  whole: true,
  ownsFile: OWNS_NO_FILE,
  childSubtree: NO_CHILD,
};

const qiSubtree: OwnedSubtree = {
  category: "quality-intelligence",
  whole: false,
  ownsFile: isEvidenceRecord,
  childSubtree: (name) => (name === FIGMA_SNAPSHOTS_SUBDIR ? figmaSnapshotsSubtree : undefined),
};

// `evidence/figma/` holds the sealed Figma PAT vault + keyfile (figmaTokenStore.ts).
const figmaVaultSubtree: OwnedSubtree = {
  category: "credential-vault",
  whole: false,
  ownsFile: isVaultFile,
  childSubtree: NO_CHILD,
};

function evidenceChildSubtree(name: string): OwnedSubtree | undefined {
  if (name === QI_SUBDIR) return qiSubtree;
  if (name === FIGMA_VAULT_SUBDIR) return figmaVaultSubtree;
  return undefined;
}

const evidenceSubtree: OwnedSubtree = {
  category: "evidence",
  whole: false,
  ownsFile: isEvidenceRecord,
  childSubtree: evidenceChildSubtree,
};

// `credentials/` holds the sealed provider-credential vault + keyfile (credentialVault.ts).
const credentialsSubtree: OwnedSubtree = {
  category: "credential-vault",
  whole: false,
  ownsFile: isVaultFile,
  childSubtree: NO_CHILD,
};

const memorySubtree: OwnedSubtree = {
  category: "memory-vault",
  whole: false,
  ownsFile: (name) => isSqliteFamily(MEMORY_DB_FILENAME, name),
  childSubtree: NO_CHILD,
};

const knowledgeNamespaceSubtree: OwnedSubtree = {
  category: "local-knowledge",
  whole: false,
  ownsFile: (name) => isSqliteFamily(CAPSULES_DB_FILENAME, name),
  childSubtree: NO_CHILD,
};

// `local-knowledge/` holds one directory per namespace; each namespace directory is a
// Keiko-owned store root (`local-knowledge/<ns>/capsules.db`).
const localKnowledgeSubtree: OwnedSubtree = {
  category: "local-knowledge",
  whole: false,
  ownsFile: OWNS_NO_FILE,
  childSubtree: () => knowledgeNamespaceSubtree,
};

const launcherTmpSubtree: OwnedSubtree = {
  category: "launcher",
  whole: true,
  ownsFile: OWNS_NO_FILE,
  childSubtree: NO_CHILD,
};

function topLevelFileCategory(name: string): RuntimeStateCategory | undefined {
  if (name === "ui.pid" || name === "ui.log") return "lifecycle";
  if (name === "launcher-state.json") return "launcher";
  if (name === GATEWAY_CONFIG_FILENAME) return "gateway-config";
  if (isSqliteFamily(UI_DB_FILENAME, name)) return "ui-database";
  return undefined;
}

function topLevelChildSubtree(name: string): OwnedSubtree | undefined {
  if (name === CREDENTIALS_SUBDIR) return credentialsSubtree;
  if (name === MEMORY_SUBDIR) return memorySubtree;
  if (name === LOCAL_KNOWLEDGE_SUBDIR) return localKnowledgeSubtree;
  if (name === EVIDENCE_SUBDIR) return evidenceSubtree;
  if (name.startsWith(LAUNCHER_STATE_TMP_PREFIX)) return launcherTmpSubtree;
  return undefined;
}

// A Keiko-owned file or directory the manifest recognizes under the state directory.
export interface RuntimeStateNode {
  readonly relPath: string; // POSIX-style path relative to the state directory
  readonly absPath: string;
  readonly category: RuntimeStateCategory;
}

// An entry the manifest does NOT remove or chmod: a customer file (`reason: "unknown"`)
// or a symlink that is never followed (`reason: "symlink"`). `owned` is true when the entry
// sits in a slot the manifest WOULD own (e.g. a `keiko-ui.db` that is actually a symlink) —
// `repair` flags those as an action item, while a customer symlink (`owned: false`) is left
// silently in place. Both kinds keep their containing directory from being removed.
export interface RetainedNode {
  readonly relPath: string;
  readonly absPath: string;
  readonly reason: "unknown" | "symlink";
  readonly owned: boolean;
}

export interface RuntimeStateScan {
  readonly present: boolean;
  readonly files: readonly RuntimeStateNode[]; // owned files
  readonly directories: readonly RuntimeStateNode[]; // owned directories, shallowest first
  readonly retained: readonly RetainedNode[]; // unrecognized entries + refused symlinks, any depth
}

interface ScanAccumulator {
  readonly files: RuntimeStateNode[];
  readonly directories: RuntimeStateNode[];
  readonly retained: RetainedNode[];
}

function childRelPath(relDir: string, name: string): string {
  return relDir === "" ? name : `${relDir}/${name}`;
}

// `"root"` models the state directory itself: its owned files come from
// `topLevelFileCategory` and its owned child directories from `topLevelChildSubtree`.
type ScanScope = OwnedSubtree | "root";

function ownedFileCategory(scope: ScanScope, name: string): RuntimeStateCategory | undefined {
  if (scope === "root") return topLevelFileCategory(name);
  if (scope.whole) return scope.category;
  return scope.ownsFile(name) ? scope.category : undefined;
}

function ownedChildSubtree(scope: ScanScope, name: string): OwnedSubtree | undefined {
  if (scope === "root") return topLevelChildSubtree(name);
  if (scope.whole) return scope; // a whole subtree owns all of its descendant directories
  return scope.childSubtree(name);
}

function classifyEntry(
  absDir: string,
  relDir: string,
  name: string,
  scope: ScanScope,
  acc: ScanAccumulator,
): void {
  const absPath = join(absDir, name);
  const relPath = childRelPath(relDir, name);
  const stat = lstatSync(absPath);
  if (stat.isSymbolicLink()) {
    // Never follow a symlink in any position: chmod-through and delete-through a symlink can
    // escape `.keiko`. Flag it when it occupies a slot the manifest would otherwise own.
    const owned =
      ownedFileCategory(scope, name) !== undefined || ownedChildSubtree(scope, name) !== undefined;
    acc.retained.push({ relPath, absPath, reason: "symlink", owned });
    return;
  }
  if (stat.isDirectory()) {
    const child = ownedChildSubtree(scope, name);
    if (child === undefined) {
      acc.retained.push({ relPath, absPath, reason: "unknown", owned: false });
      return;
    }
    acc.directories.push({ relPath, absPath, category: child.category });
    walkOwnedDir(absPath, relPath, child, acc);
    return;
  }
  if (stat.isFile()) {
    const category = ownedFileCategory(scope, name);
    if (category === undefined)
      acc.retained.push({ relPath, absPath, reason: "unknown", owned: false });
    else acc.files.push({ relPath, absPath, category });
    return;
  }
  // Sockets, FIFOs, devices: not a Keiko artifact — retain untouched.
  acc.retained.push({ relPath, absPath, reason: "unknown", owned: false });
}

function walkOwnedDir(
  absDir: string,
  relDir: string,
  scope: ScanScope,
  acc: ScanAccumulator,
): void {
  for (const name of readdirSync(absDir)) {
    classifyEntry(absDir, relDir, name, scope, acc);
  }
}

// Classifies every entry under `stateDir` against the runtime-state manifest. Pure
// read-only traversal (lstat-based, never follows symlinks); the directories list is
// ordered shallowest-first so callers can reverse it to remove leaves before parents.
export function scanRuntimeState(stateDir: string): RuntimeStateScan {
  if (!existsSync(stateDir)) {
    return { present: false, files: [], directories: [], retained: [] };
  }
  const acc: ScanAccumulator = { files: [], directories: [], retained: [] };
  walkOwnedDir(stateDir, "", "root", acc);
  return { present: true, files: acc.files, directories: acc.directories, retained: acc.retained };
}

// True when `descendant` lies inside `ancestor` (used to decide whether an owned directory
// can be removed: it can only be removed when no retained entry survives beneath it).
export function isInsidePath(ancestor: string, descendant: string): boolean {
  return descendant === ancestor || descendant.startsWith(`${ancestor}${sep}`);
}
