// Shared server-side identity for M11 workspace roots. The identity includes the canonical path
// and filesystem object fields so replacing a directory at the same path changes the digest.

import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { WorkspaceRootIdentityDigest, WorkspaceRootRef } from "@oscharko-dev/keiko-contracts";

const REFERENCE_HEX_CHARS = 40;

export interface WorkspaceRootIdentity {
  readonly canonicalRoot: string;
  readonly identityDigest: WorkspaceRootIdentityDigest;
  /**
   * Server-private identity for the filesystem object itself. Unlike `identityDigest`, this does
   * not contain a path and retains exact bigint stat fields. `undefined` means the filesystem
   * cannot provide a durable creation identity, so persisted authority must fail closed.
   */
  readonly objectIdentityDigest: string | undefined;
  readonly rootRef: WorkspaceRootRef;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly ownerUid: number;
}

function framedDigest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`${String(domain.length)}:${domain}`);
  for (const part of parts) hash.update(`${String(part.length)}:${part}`);
  return hash.digest("hex");
}

function rootReference(canonicalRoot: string): WorkspaceRootRef {
  const digest = framedDigest("keiko.m11.root-ref.v1", [canonicalRoot]);
  return `root-${digest.slice(0, REFERENCE_HEX_CHARS)}` as WorkspaceRootRef;
}

export function deriveWorkspaceRootRef(canonicalRoot: string): WorkspaceRootRef {
  return rootReference(canonicalRoot);
}

/**
 * The filesystem identity digest for a path that is already canonical. Callers that resolved and
 * alias-checked the root earlier use this to re-derive the same digest without repeating the
 * alias rejection — re-imposing it would reject a legitimately canonical root reached through a
 * symlinked parent, which is exactly how the debug capsule receives its execution root.
 */
export function workspaceRootIdentityDigestFor(
  canonicalRoot: string,
  stat: { readonly dev: number; readonly ino: number; readonly mode: number; readonly uid: number },
): WorkspaceRootIdentityDigest {
  return framedDigest("keiko.m11.root-identity.fs.v1", [
    canonicalRoot,
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.uid),
  ]) as WorkspaceRootIdentityDigest;
}

export function workspaceRootObjectIdentityDigestFor(stat: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}): string | undefined {
  if (stat.birthtimeNs <= 0n) return undefined;
  return framedDigest("keiko.m11.root-object.fs.v1", [
    String(stat.dev),
    String(stat.ino),
    String(stat.birthtimeNs),
  ]);
}

export function inspectWorkspaceRootIdentity(path: string): WorkspaceRootIdentity {
  const supplied = lstatSync(path);
  if (supplied.isSymbolicLink()) throw new Error("WORKSPACE_ROOT_ALIAS_DENIED");
  // `.native` (#2615) returns the on-disk canonical spelling on case-insensitive filesystems.
  // Otherwise the caller's casing survives realpath, and the same directory keyed as
  // `/Users/Alice/proj` and `/users/alice/proj` produces distinct identity digests and root
  // references — two independent trust states over one filesystem object.
  const canonicalRoot = realpathSync.native(path);
  const stat = lstatSync(canonicalRoot, { bigint: true });
  if (!stat.isDirectory()) throw new Error("WORKSPACE_ROOT_INVALID");
  const legacyStat = {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mode: Number(stat.mode),
    uid: Number(stat.uid),
  };
  // Through the exported helper, not a second inline copy of the same framed digest. The producer
  // and the debug-launch validator drifting onto two formulas is exactly what broke every Linux
  // debug launch in #2643; two derivations of one digest in one file is the same latent defect,
  // one edit away.
  const identityDigest = workspaceRootIdentityDigestFor(canonicalRoot, legacyStat);
  return Object.freeze({
    canonicalRoot,
    identityDigest,
    objectIdentityDigest: workspaceRootObjectIdentityDigestFor(stat),
    rootRef: rootReference(canonicalRoot),
    device: legacyStat.dev,
    inode: legacyStat.ino,
    mode: legacyStat.mode,
    ownerUid: legacyStat.uid,
  });
}
