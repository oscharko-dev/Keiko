import { createHash } from "node:crypto";
import type { TaskWorkspaceDriftMarker } from "@oscharko-dev/keiko-contracts";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import {
  forwardWorkspaceFs,
  nodeWorkspaceFs,
  type WorkspaceDescriptorUtf8Read,
  type WorkspaceFs,
  type WorkspaceStat,
} from "@oscharko-dev/keiko-workspace/internal/fs";

const MAX_GIT_METADATA_BYTES = 64 * 1024;
// v3 binds every component, the worktree root directory included, to its creation time as well as
// its inode (see identityPair).
// The schema string is part of the hashed input, so bumping it is what makes the composition change
// explicit instead of silently reinterpreting identities persisted under the weaker v2 rule.
const IDENTITY_SCHEMA = "managed-linked-worktree-v3";
// The retired composition, kept only to recognise identities persisted before v3. Never granted.
const LEGACY_IDENTITY_SCHEMA = "managed-linked-worktree-v2";

// Two compositions of the SAME observed components. `withCreation` is what v3 binds and the only one
// that ever grants access. `inodeOnly` reproduces the v2 composition byte-for-byte and exists solely
// so a stale persisted value can be RECOGNISED as "registered under the old schema" instead of being
// reported as a replacement attempt. It is compared, never trusted: a v2 identity is forgeable by
// the very inode reuse v3 closes, so accepting one — even once, even to "upgrade" it — would mint a
// trusted v3 identity for an attacker's directory.
interface IdentityPair {
  readonly inodeOnly: string;
  readonly withCreation: string;
}

interface StableContainedRead {
  readonly rawText: string;
  readonly rootIdentity: IdentityPair;
  readonly fileIdentity: IdentityPair;
}

interface LinkedWorktreePointer {
  readonly canonicalAdminDirectory: string;
  readonly worktreeIdentity: IdentityPair;
  readonly pointerIdentity: IdentityPair;
  readonly adminDirectoryIdentity: IdentityPair;
  readonly backpointerIdentity: IdentityPair;
}

interface GitCommonDirectory {
  readonly path: string;
  readonly identity: IdentityPair;
}

export interface ManagedGitdirIdentityInspection {
  readonly identity: string;
  /**
   * The same components composed under the retired v2 rule. For CLASSIFYING a persisted value only:
   * a match means this workspace was registered before creation time was bound and needs an
   * operator-approved re-registration, which is a different operator action — and a different
   * incident — from an identity that matches nothing.
   */
  readonly legacyIdentity: string;
}

// `fileIdentity` is `device:inode`, and an inode number is a SLOT, not an object: deleting a path
// and recreating it at once hands the new object the same number (measured 50/50 on Linux
// ext4/overlayfs; effectively never on APFS, which is why a filesystem-level pin for this passes on
// macOS and fails on Linux). An identity built from it alone therefore cannot distinguish an
// authentic managed worktree from a same-path replacement that copies the Git pointer.
//
// EVERY component is bound to its creation time, the worktree ROOT DIRECTORY included, and
// `birthtimeNs` is the only field that can carry it.
//
// What this is NOT: a nonce, or a security boundary against a local attacker running as the same
// user. Creation time is settable — `SetFileTime` on Windows, `setattrlist`/`utimensat` on macOS —
// and such an attacker can rewrite anything Keiko records anyway. It closes the accidental and the
// cheap replacement, the one an ordinary Linux filesystem hands out by default. Defence in depth.
//
// Stamping just the pointer files is not enough, and assuming otherwise is a hole with a working
// exploit. A local process that can replace the worktree does not have to CREATE a new pointer: it
// can move the original `.git` out, delete and recreate the directory until the inode is handed
// back, then move the same file in again. `rename` preserves both the inode and the birthtime, so
// every pointer component still matches. Reproduced on Linux: root inode reused, pointer inode and
// birthtime both preserved, and only the root directory's birthtime changed. That is why the root
// directory has to be part of the identity — a rename cannot carry it over, so a replacement that
// only shuffles existing objects is caught.
//
// `ctimeNs` is NOT a usable substitute here. A directory's ctime and mtime move whenever an entry is
// created or removed inside it, so binding the root to either would refuse every healthy workspace
// the moment a user saved a file at its root.
//
// Absent creation time FAILS CLOSED, and that is a real, reachable outcome rather than a
// theoretical one: an ext4 volume formatted with 128-byte inodes reports none. Measured on such a
// volume, Node returns birthtimeNs `0` — an honest "unavailable" rather than a substituted ctime —
// which `workspaceStat` maps to absent, so the refusal is correct and is reported as a platform
// limitation, never as a replaced worktree.
function identityPair(stat: WorkspaceStat): IdentityPair | undefined {
  const inode = stat.fileIdentity;
  const created = stat.birthtimeNs;
  if (inode === undefined || inode.length === 0) return undefined;
  if (created === undefined || created.length === 0) return undefined;
  return { inodeOnly: inode, withCreation: `${inode}@${created}` };
}

function directoryIdentity(stat: WorkspaceStat): IdentityPair | undefined {
  if (!stat.isDirectory || stat.isSymbolicLink) return undefined;
  return identityPair(stat);
}

function fileIdentity(read: WorkspaceDescriptorUtf8Read): IdentityPair | undefined {
  if (!read.stat.isFile || read.stat.isSymbolicLink) return undefined;
  return identityPair(read.stat);
}

/**
 * How a persisted identity relates to what this worktree proves right now.
 *
 * ONE owner for the three-way decision, because every site that compares a persisted identity has to
 * reach the same verdict: the access boundary, the provisioning resume, and reconciliation. Splitting
 * it produced the defect this exists to avoid — a workspace registered before the identity rule
 * changed being reported as a replaced worktree, which is a false statement about the customer's
 * disk and sends them to the wrong recovery.
 *
 * `schema-retired` still refuses. A v2 identity is forgeable by exactly the inode reuse v3 closes, so
 * it is recognised and never accepted.
 */
export type ManagedIdentityDrift = "matches" | "schema-retired" | "unsupported" | "changed";

/**
 * Four outcomes, because three of them need different operator actions and collapsing any pair
 * sends the operator to the wrong one:
 *   matches         — nothing to do.
 *   schema-retired  — authenticity is unproven under the retired rule (a same-path replacement
 *                     can reproduce every inode-only term); re-register to reissue the proof.
 *   unsupported     — this filesystem reports no creation time; relocate the root (ADR-0155).
 *   changed         — the worktree really is not the one that was registered.
 *
 * `unsupported` is NOT `changed`: nothing about the customer's disk changed, and reporting a
 * platform limitation as a replaced worktree is a false statement that sends them hunting an attack.
 *
 * A `failed` proof is not a drift verdict at all: an EIO or EACCES says nothing about the worktree,
 * so it is rethrown with its cause for the caller's error path (frames, correlation) rather than
 * folded into `changed` — which would persist a false replacement on the row.
 */
export function managedIdentityDriftFor(
  outcome: ManagedGitdirIdentityOutcome,
  persisted: string,
): ManagedIdentityDrift {
  if (outcome.kind === "failed") throw proofFailure(outcome.cause);
  if (outcome.kind === "unsupported") return "unsupported";
  if (outcome.kind === "unproven") return "changed";
  if (outcome.inspection.identity === persisted) return "matches";
  return outcome.inspection.legacyIdentity === persisted ? "schema-retired" : "changed";
}

/**
 * Thrown by the drift classifier when the proof itself could not run (EIO, EACCES, a vanished path).
 * `cause` is the I/O failure. Callers narrow on this class: a read path answers it as a classified
 * retryable error, a batch path isolates it per instance, a destructive path fails closed on it.
 */
export class ManagedIdentityProofError extends Error {
  public constructor(cause: unknown) {
    super("managed worktree identity proof failed", { cause });
    this.name = "ManagedIdentityProofError";
  }
}

function proofFailure(cause: unknown): ManagedIdentityProofError {
  return new ManagedIdentityProofError(cause);
}

export const RETIRED_IDENTITY_SCHEMA_MESSAGE =
  "managed worktree identity predates the current identity rule; re-register to reissue it";
export const UNSUPPORTED_IDENTITY_MESSAGE =
  "managed worktree filesystem cannot report a durable creation time; relocate the workspace root";

// One mapping from the verdict to what is persisted and what the operator is told, shared by every
// path that may expose an operational binding or readiness state — provisioning resume and
// completion, activation, handoff, the active-pointer read — so no path can re-label a migration or
// a platform limitation as a replaced pointer (#3376 review P1).
export function managedIdentityDriftMarker(drift: ManagedIdentityDrift): TaskWorkspaceDriftMarker {
  if (drift === "schema-retired") return "identity-schema-retired";
  if (drift === "unsupported") return "identity-unsupported";
  return "pointer-stale";
}

export function managedIdentityDriftMessage(drift: ManagedIdentityDrift): string {
  if (drift === "schema-retired") return RETIRED_IDENTITY_SCHEMA_MESSAGE;
  if (drift === "unsupported") return UNSUPPORTED_IDENTITY_MESSAGE;
  return "managed worktree git identity changed";
}

/** The live four-way verdict for one persisted registration; an I/O failure inside the proof throws. */
export function liveManagedIdentityDrift(
  worktreePath: string,
  repositoryRoot: string,
  persisted: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
): ManagedIdentityDrift {
  return managedIdentityDriftFor(
    inspectManagedGitdirIdentityOutcome(worktreePath, repositoryRoot, fs),
    persisted,
  );
}

/** Convenience for the callers that already hold an inspection rather than a full outcome. */
export function managedIdentityDrift(
  inspection: ManagedGitdirIdentityInspection | undefined,
  persisted: string,
): ManagedIdentityDrift {
  return managedIdentityDriftFor(
    inspection === undefined ? { kind: "unproven" } : { kind: "identified", inspection },
    persisted,
  );
}

/**
 * Why one inspection produced no identity.
 *
 * A refusal caused by the platform is not the same incident as a refusal caused by a replaced
 * worktree, and reporting both as an identity mismatch sends an operator hunting an attack that never
 * happened. ADR-0155 already names this outcome at the workspace-root boundary
 * (`FILESYSTEM_IDENTITY_UNSUPPORTED`); this keeps the managed-worktree boundary symmetric with it.
 */
export type ManagedGitdirIdentityOutcome =
  | { readonly kind: "identified"; readonly inspection: ManagedGitdirIdentityInspection }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unproven" }
  // The port threw (EIO, EACCES, EMFILE, a stat race). Kept apart from `unproven` so the denial that
  // follows can carry `errorKind`, frames and cause instead of looking like a malformed pointer.
  | { readonly kind: "failed"; readonly cause: unknown };

/**
 * Wraps a port so one inspection can report whether any component it actually consulted lacked a
 * creation time.
 *
 * Deliberately not a second probe. An independent re-stat would look at a different set of objects at
 * a different moment and could contradict the very failure it is explaining — an earlier version of
 * this classification probed two of the five hashed objects and mislabelled the rest, which review
 * caught. Answering from inside the failing pass cannot drift from it.
 */
function creationTimeWitness(fs: WorkspaceFs): {
  readonly fs: WorkspaceFs;
  readonly sawMissingCreationTime: () => boolean;
} {
  let missing = false;
  const note = (stat: WorkspaceStat): WorkspaceStat => {
    if (stat.birthtimeNs === undefined || stat.birthtimeNs.length === 0) missing = true;
    return stat;
  };
  const containedRead = fs.readFileUtf8WithinRootSameDescriptor;
  // Built on the port's OWN forwarder, not on `{ ...fs }`. A class-based port keeps its methods on
  // the prototype, and a spread copies only own enumerable properties — measured on a
  // prototype-backed WorkspaceFs: ZERO methods survive. The wrapper would then throw inside the
  // inspection, whose catch reports the tree as unproven: a fail-closed for a reason that has
  // nothing to do with the worktree, which is the exact confusion this classification removes.
  // `forwardWorkspaceFs` already delegates every method with the right receiver.
  const forwarded = forwardWorkspaceFs(fs);
  return {
    fs: {
      ...forwarded,
      stat: (absolutePath: string): WorkspaceStat => note(fs.stat(absolutePath)),
      ...(containedRead === undefined
        ? {}
        : {
            readFileUtf8WithinRootSameDescriptor: (
              canonicalRoot: string,
              absolutePath: string,
              maxBytes: number,
              hardLinkPolicy: Parameters<typeof containedRead>[3],
              completeness: Parameters<typeof containedRead>[4],
            ): WorkspaceDescriptorUtf8Read => {
              const result = containedRead.call(
                fs,
                canonicalRoot,
                absolutePath,
                maxBytes,
                hardLinkPolicy,
                completeness,
              );
              note(result.stat);
              return result;
            },
          }),
    },
    sawMissingCreationTime: (): boolean => missing,
  };
}

/** The identity plus, when there is none, the reason an operator needs to act on the right thing. */
export function inspectManagedGitdirIdentityOutcome(
  worktreePath: string,
  repositoryRoot: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
): ManagedGitdirIdentityOutcome {
  const witness = creationTimeWitness(fs);
  let inspection: ManagedGitdirIdentityInspection | undefined;
  try {
    inspection = inspectManagedGitdirIdentityOrThrow(worktreePath, repositoryRoot, witness.fs);
  } catch (cause) {
    return { kind: "failed", cause };
  }
  if (inspection !== undefined) return { kind: "identified", inspection };
  return witness.sawMissingCreationTime() ? { kind: "unsupported" } : { kind: "unproven" };
}

function readStableContainedFile(
  fs: WorkspaceFs,
  canonicalRoot: string,
  absolutePath: string,
): StableContainedRead | undefined {
  const read = fs.readFileUtf8WithinRootSameDescriptor;
  if (read === undefined) return undefined;
  const before = directoryIdentity(fs.stat(canonicalRoot));
  if (before === undefined) return undefined;
  const result = read.call(
    fs,
    canonicalRoot,
    absolutePath,
    MAX_GIT_METADATA_BYTES,
    "reject",
    "complete",
  );
  const after = directoryIdentity(fs.stat(canonicalRoot));
  const targetIdentity = fileIdentity(result);
  if (after?.withCreation !== before.withCreation || targetIdentity === undefined) return undefined;
  // The bytes came from a descriptor opened on the OLD file; re-stat the pathname after the read so a
  // pointer replaced between the read and here cannot pair authentic stale bytes with a path that
  // now points elsewhere. Same generation, or nothing.
  const current = fs.stat(absolutePath);
  if (!current.isFile || current.isSymbolicLink) return undefined;
  if (identityPair(current)?.withCreation !== targetIdentity.withCreation) return undefined;
  return { rawText: result.rawText, rootIdentity: before, fileIdentity: targetIdentity };
}

function parseAbsoluteSingleLine(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) return undefined;
  return isAbsolute(value) ? normalize(value) : undefined;
}

/** Parses the complete contents of a linked-worktree `.git` pointer. */
export function parseGitdirPointerTarget(raw: string): string | undefined {
  const value = raw.trim();
  if (!value.startsWith("gitdir:")) return undefined;
  return parseAbsoluteSingleLine(value.slice("gitdir:".length));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function validBackpointer(
  raw: string,
  requestedWorktree: string,
  canonicalWorktree: string,
): boolean {
  const target = parseAbsoluteSingleLine(raw);
  if (target === undefined) return false;
  return (
    samePath(target, join(requestedWorktree, ".git")) ||
    samePath(target, join(canonicalWorktree, ".git"))
  );
}

function validAdminDirectoryShape(path: string): boolean {
  const worktreesDirectory = dirname(path);
  return basename(path).length > 0 && basename(worktreesDirectory) === "worktrees";
}

function resolveAdminDirectory(
  fs: WorkspaceFs,
  rawPointer: string,
  expectedParent: string | undefined,
): string | undefined {
  const target = parseGitdirPointerTarget(rawPointer);
  if (target === undefined || !validAdminDirectoryShape(target)) return undefined;
  if (expectedParent !== undefined && !samePath(dirname(target), expectedParent)) return undefined;
  const canonical = fs.realPath(target);
  if (!validAdminDirectoryShape(canonical)) return undefined;
  if (expectedParent !== undefined && !samePath(dirname(canonical), expectedParent))
    return undefined;
  return canonical;
}

function inspectLinkedWorktreePointer(
  fs: WorkspaceFs,
  requestedWorktree: string,
  expectedAdminParent?: string,
): LinkedWorktreePointer | undefined {
  const canonicalWorktree = fs.realPath(requestedWorktree);
  const pointer = readStableContainedFile(fs, canonicalWorktree, join(canonicalWorktree, ".git"));
  if (pointer === undefined) return undefined;
  const canonicalAdminDirectory = resolveAdminDirectory(fs, pointer.rawText, expectedAdminParent);
  if (canonicalAdminDirectory === undefined) return undefined;
  const backpointer = readStableContainedFile(
    fs,
    canonicalAdminDirectory,
    join(canonicalAdminDirectory, "gitdir"),
  );
  if (
    backpointer === undefined ||
    !validBackpointer(backpointer.rawText, requestedWorktree, canonicalWorktree)
  ) {
    return undefined;
  }
  return {
    canonicalAdminDirectory,
    worktreeIdentity: pointer.rootIdentity,
    pointerIdentity: pointer.fileIdentity,
    adminDirectoryIdentity: backpointer.rootIdentity,
    backpointerIdentity: backpointer.fileIdentity,
  };
}

function commonDirectoryAt(fs: WorkspaceFs, path: string): GitCommonDirectory | undefined {
  const identity = directoryIdentity(fs.stat(path));
  return identity === undefined ? undefined : { path, identity };
}

function repositoryCommonDirectory(
  fs: WorkspaceFs,
  repositoryRoot: string,
): GitCommonDirectory | undefined {
  const canonicalRepository = fs.realPath(repositoryRoot);
  const dotGit = join(canonicalRepository, ".git");
  const dotGitStat = fs.stat(dotGit);
  if (dotGitStat.isDirectory && !dotGitStat.isSymbolicLink) {
    return commonDirectoryAt(fs, fs.realPath(dotGit));
  }
  const pointer = inspectLinkedWorktreePointer(fs, repositoryRoot);
  if (pointer === undefined) return undefined;
  return commonDirectoryAt(fs, dirname(dirname(pointer.canonicalAdminDirectory)));
}

// The walk proved each component at a different moment. Before the identity is handed out, every
// one of them is re-stat'ed and must still be the generation that was proven — otherwise a root or
// pointer swapped after its own check but before this point would be hashed from stale, authentic
// observations while the authority granted on the pathname lands on the replacement. This is still a
// point-in-time proof; the effect that follows must re-prove at its own boundary.
function stillCurrent(
  fs: WorkspaceFs,
  worktreePath: string,
  pointer: LinkedWorktreePointer,
  commonDirectory: GitCommonDirectory,
): boolean {
  const canonicalWorktree = fs.realPath(worktreePath);
  const same = (path: string, expected: IdentityPair, kind: "directory" | "file"): boolean => {
    const stat = fs.stat(path);
    const pair = kind === "directory" ? directoryIdentity(stat) : identityPair(stat);
    return (
      pair?.withCreation === expected.withCreation &&
      !stat.isSymbolicLink &&
      (kind === "directory" ? stat.isDirectory : stat.isFile)
    );
  };
  return (
    same(commonDirectory.path, commonDirectory.identity, "directory") &&
    same(canonicalWorktree, pointer.worktreeIdentity, "directory") &&
    same(join(canonicalWorktree, ".git"), pointer.pointerIdentity, "file") &&
    same(pointer.canonicalAdminDirectory, pointer.adminDirectoryIdentity, "directory") &&
    same(join(pointer.canonicalAdminDirectory, "gitdir"), pointer.backpointerIdentity, "file")
  );
}

function underCommonWorktrees(adminDirectory: string, commonDirectory: string): boolean {
  return samePath(dirname(adminDirectory), join(commonDirectory, "worktrees"));
}

function composeIdentity(
  schema: string,
  paths: readonly string[],
  components: readonly string[],
): string {
  const fields = [schema, ...paths, ...components];
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex").slice(0, 32);
}

// Both compositions are produced from ONE set of observations, so the legacy value can never drift
// into describing a different filesystem state than the current one it is compared against.
function identitiesFor(
  pointer: LinkedWorktreePointer,
  commonDirectory: GitCommonDirectory,
): ManagedGitdirIdentityInspection {
  const paths = [pointer.canonicalAdminDirectory, commonDirectory.path];
  // Order is load-bearing: LEGACY_IDENTITY_SCHEMA only reproduces a persisted v2 value while this
  // sequence stays exactly as v2 hashed it.
  const pairs = [
    commonDirectory.identity,
    pointer.worktreeIdentity,
    pointer.pointerIdentity,
    pointer.adminDirectoryIdentity,
    pointer.backpointerIdentity,
  ];
  return {
    identity: composeIdentity(
      IDENTITY_SCHEMA,
      paths,
      pairs.map((pair) => pair.withCreation),
    ),
    legacyIdentity: composeIdentity(
      LEGACY_IDENTITY_SCHEMA,
      paths,
      pairs.map((pair) => pair.inodeOnly),
    ),
  };
}

/**
 * Re-proves a real Git linked worktree and returns a body-free identity bound to its stable on-disk
 * directory and pointer descriptors. Any unavailable safe lane, malformed pointer, replacement, or
 * non-reciprocal Git admin directory fails closed.
 */
export function inspectManagedGitdirIdentity(
  worktreePath: string,
  repositoryRoot: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
): ManagedGitdirIdentityInspection | undefined {
  try {
    return inspectManagedGitdirIdentityOrThrow(worktreePath, repositoryRoot, fs);
  } catch {
    return undefined;
  }
}

// The proof itself. Throws on an I/O failure so `inspectManagedGitdirIdentityOutcome` can report the
// cause; `inspectManagedGitdirIdentity` is the fail-closed wrapper for callers that only need yes/no.
function inspectManagedGitdirIdentityOrThrow(
  worktreePath: string,
  repositoryRoot: string,
  fs: WorkspaceFs,
): ManagedGitdirIdentityInspection | undefined {
  const commonDirectory = repositoryCommonDirectory(fs, repositoryRoot);
  const pointer =
    commonDirectory === undefined
      ? undefined
      : inspectLinkedWorktreePointer(fs, worktreePath, join(commonDirectory.path, "worktrees"));
  if (
    commonDirectory === undefined ||
    pointer === undefined ||
    !underCommonWorktrees(pointer.canonicalAdminDirectory, commonDirectory.path) ||
    !stillCurrent(fs, worktreePath, pointer, commonDirectory)
  ) {
    return undefined;
  }
  return identitiesFor(pointer, commonDirectory);
}
