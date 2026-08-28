// Deterministic construction for persisted M11 workspace manifests. Digests cover ordered roots,
// focus, and revision through one canonical tuple so mutation and migration use the same formula.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import {
  WORKSPACE_MANIFEST_SCHEMA_VERSION,
  validateWorkspaceManifest,
} from "@oscharko-dev/keiko-contracts/runtime/workspace-manifest";
import type {
  WorkspaceManifest,
  WorkspaceManifestDigest,
  WorkspaceManifestRef,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { inspectWorkspaceRootIdentity } from "./workspace-root-identity.js";

const REFERENCE_HEX_CHARS = 40;
const DISPLAY_NAME_MAX_CHARS = 120;

function framedDigest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`${String(domain.length)}:${domain}`);
  for (const part of parts) hash.update(`${String(part.length)}:${part}`);
  return hash.digest("hex");
}

function safeDisplayName(value: string, canonicalRoot: string): string {
  const sanitized = Array.from(value)
    .filter((character): boolean => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .slice(0, DISPLAY_NAME_MAX_CHARS);
  return sanitized.length > 0
    ? sanitized
    : basename(canonicalRoot).slice(0, DISPLAY_NAME_MAX_CHARS);
}

function manifestReference(workspaceId: string): WorkspaceManifestRef {
  const digest = framedDigest("keiko.m11.manifest-ref.v1", [workspaceId]);
  return `mf-${digest.slice(0, REFERENCE_HEX_CHARS)}` as WorkspaceManifestRef;
}

/**
 * A workspace keeps the identity derived from the root that founded it even after that root leaves,
 * so restoring a departed founding root would otherwise claim an id its own former workspace still
 * holds (#2620). The discriminator gives the restored workspace an identity of its own. Zero frames
 * exactly the original single-element tuple, so every existing workspace id is byte-identical.
 */
function workspaceIdentity(canonicalRoot: string, discriminator: number): string {
  const parts = discriminator === 0 ? [canonicalRoot] : [canonicalRoot, String(discriminator)];
  const digest = framedDigest("keiko.m11.workspace-id.v1", parts);
  return `workspace-${digest.slice(0, REFERENCE_HEX_CHARS)}`;
}

function rootDigestTuple(root: WorkspaceRootDescriptor): readonly string[] {
  return [
    root.rootRef,
    root.canonicalRoot,
    root.displayName,
    root.identityDigest,
    JSON.stringify(root.sourceDigest),
  ];
}

function manifestDigest(input: Omit<WorkspaceManifest, "manifestDigest">): WorkspaceManifestDigest {
  const roots = input.roots.flatMap(rootDigestTuple);
  return framedDigest("keiko.m11.workspace-manifest.v1", [
    String(input.schemaVersion),
    input.manifestRef,
    input.workspaceId,
    String(input.revision),
    String(input.roots.length),
    ...roots,
    input.focusedRootRef,
  ]) as WorkspaceManifestDigest;
}

function checkedManifest(input: Omit<WorkspaceManifest, "manifestDigest">): WorkspaceManifest {
  const manifest: WorkspaceManifest = { ...input, manifestDigest: manifestDigest(input) };
  if (!validateWorkspaceManifest(manifest).ok) throw new Error("WORKSPACE_MANIFEST_INVALID");
  return manifest;
}

export function inspectWorkspaceRootDescriptor(
  path: string,
  displayName: string,
): WorkspaceRootDescriptor {
  // `realpathSync.native` (#2615) asks the OS for the on-disk canonical spelling: on macOS
  // APFS/HFS+ and case-insensitive Linux mounts it returns the actual stored casing rather than
  // preserving whatever casing the caller typed. Without it, the same directory reached through
  // two case variants produces two distinct canonical roots and therefore two independent trust
  // states (ADR-0155 root-scoped binding). The redundant realpath below the identity call becomes
  // a no-op once the input is already canonical.
  const identity = inspectWorkspaceRootIdentity(realpathSync.native(path));
  return {
    rootRef: identity.rootRef,
    canonicalRoot: identity.canonicalRoot,
    displayName: safeDisplayName(displayName, identity.canonicalRoot),
    identityDigest: identity.identityDigest,
    sourceDigest: { outcome: "unknown" },
  };
}

export function createSingleRootWorkspaceManifest(
  projectPath: string,
  projectName: string,
  discriminator = 0,
): WorkspaceManifest {
  const root = inspectWorkspaceRootDescriptor(projectPath, projectName);
  const workspaceId = workspaceIdentity(root.canonicalRoot, discriminator);
  return checkedManifest({
    kind: "workspace-manifest",
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    manifestRef: manifestReference(workspaceId),
    workspaceId,
    revision: 1,
    roots: [root],
    focusedRootRef: root.rootRef,
  });
}

export function reviseWorkspaceManifest(
  current: WorkspaceManifest,
  roots: readonly WorkspaceRootDescriptor[],
  focusedRootRef: WorkspaceRootRef,
): WorkspaceManifest {
  return checkedManifest({
    kind: "workspace-manifest",
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    manifestRef: current.manifestRef,
    workspaceId: current.workspaceId,
    revision: current.revision + 1,
    roots,
    focusedRootRef,
  });
}
