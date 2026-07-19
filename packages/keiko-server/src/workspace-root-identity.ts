// Shared server-side identity for M11 workspace roots. The identity includes the canonical path
// and filesystem object fields so replacing a directory at the same path changes the digest.

import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { WorkspaceRootIdentityDigest, WorkspaceRootRef } from "@oscharko-dev/keiko-contracts";

const REFERENCE_HEX_CHARS = 40;

export interface WorkspaceRootIdentity {
  readonly canonicalRoot: string;
  readonly identityDigest: WorkspaceRootIdentityDigest;
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

export function inspectWorkspaceRootIdentity(path: string): WorkspaceRootIdentity {
  const supplied = lstatSync(path);
  if (supplied.isSymbolicLink()) throw new Error("WORKSPACE_ROOT_ALIAS_DENIED");
  const canonicalRoot = realpathSync(path);
  const stat = lstatSync(canonicalRoot);
  if (!stat.isDirectory()) throw new Error("WORKSPACE_ROOT_INVALID");
  const identityDigest = framedDigest("keiko.m11.root-identity.fs.v1", [
    canonicalRoot,
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.uid),
  ]) as WorkspaceRootIdentityDigest;
  return Object.freeze({
    canonicalRoot,
    identityDigest,
    rootRef: rootReference(canonicalRoot),
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    ownerUid: stat.uid,
  });
}
