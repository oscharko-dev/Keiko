import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  EditorAgentActionDenyReason,
  EditorAgentRootBinding,
  EditorAgentSessionSnapshot,
  WorkspaceManifest,
  WorkspaceRootDescriptor,
} from "@oscharko-dev/keiko-contracts";
import { editorAgentRootBindingDenyReason } from "@oscharko-dev/keiko-contracts/runtime/editor-agent-governance";
import { isContainedAgentPath } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { validateWorkspaceManifest } from "@oscharko-dev/keiko-contracts/runtime/workspace-manifest";
import {
  containedRealPathInfo,
  isWithinWorkspace,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { UiStore, WorkspaceManifestRecordRow } from "../store/index.js";
import { inspectWorkspaceRootIdentity } from "../workspace-root-identity.js";
import { contentFreeErrorClass, emitServerDiagnostic } from "../diagnostics-log.js";
import { correlationIdOrUnknown } from "../correlation.js";
import type { WorkspaceRootAccessOutcome } from "../task-workspace/workspace-root-access.js";

export type EditorAgentRootBoundaryReason = Extract<
  EditorAgentActionDenyReason,
  | "root-binding-required"
  | "root-binding-invalid"
  | "decompose-per-root"
  | "workspace-boundary-escape"
>;

// Issue #2619 (ADR-0147 D1/D4) — one reason-to-wire-code table for every route that reports a root
// boundary denial. `root-binding-required` keeps a code of its own: it says the dispatch named no
// root at all and is the contract expression of "the focused root is never a fallback", while
// `root-binding-invalid` says a root WAS named and did not hold. Collapsing those two makes the
// invariant unobservable at the boundary, so the mapping lives beside the reason union rather than
// being re-derived per route.
//
// `workspace-boundary-escape` deliberately shares `..._INVALID`. That is the code the routes already
// emitted for it, and this table reproduces the previous behaviour exactly rather than changing a
// wire contract from inside an issue about the focused-root fallback. A path escape is a denial of
// the supplied target, not of a missing root, so it belongs on the "a root was named and did not
// hold" side; giving it a distinct code is a separate, deliberate contract change.
export const EDITOR_AGENT_ROOT_BOUNDARY_ERROR_CODE: Readonly<
  Record<EditorAgentRootBoundaryReason, string>
> = {
  "root-binding-required": "EDITOR_AGENT_ROOT_BINDING_REQUIRED",
  "root-binding-invalid": "EDITOR_AGENT_ROOT_BINDING_INVALID",
  "decompose-per-root": "EDITOR_AGENT_DECOMPOSE_PER_ROOT",
  "workspace-boundary-escape": "EDITOR_AGENT_ROOT_BINDING_INVALID",
};

// Issue #2624 — one predicate for "this denial came from the root boundary", owned beside the reason
// union rather than re-listed per route. A boundary denial never resolved a root, so the evidence it
// produces must not report a target the server could not have authorized; both the actions route and
// the verification route suppress target fields on exactly these reasons. Membership is derived from
// the exhaustive `Record<EditorAgentRootBoundaryReason, string>` above, so a reason added to the union
// forces a table entry and is covered on every route at once instead of silently opting out of one.
export function isEditorAgentRootBoundaryDenial(
  reason: EditorAgentActionDenyReason | undefined,
): boolean {
  return reason !== undefined && Object.hasOwn(EDITOR_AGENT_ROOT_BOUNDARY_ERROR_CODE, reason);
}

export interface EditorAgentResolvedRoot {
  readonly workspaceRoot: string;
  readonly rootRef?: WorkspaceRootDescriptor["rootRef"] | undefined;
  readonly binding?: EditorAgentRootBinding | undefined;
  readonly manifest?: WorkspaceManifest | undefined;
  readonly explicitBindingRequired: boolean;
}

export type EditorAgentRootResolution =
  | { readonly ok: true; readonly root: EditorAgentResolvedRoot }
  | { readonly ok: false; readonly reason: EditorAgentRootBoundaryReason };

function parsedManifest(row: WorkspaceManifestRecordRow): WorkspaceManifest | null {
  try {
    const parsed: unknown = JSON.parse(row.recordJson);
    if (!validateWorkspaceManifest(parsed).ok) return null;
    const manifest = parsed as WorkspaceManifest;
    const metadataMatches =
      manifest.workspaceId === row.workspaceId &&
      manifest.manifestRef === row.manifestRef &&
      manifest.revision === row.revision &&
      manifest.manifestDigest === row.manifestDigest;
    const rootsMatch = manifest.roots.every(
      (root, index): boolean => row.rootProjects[index]?.rootRef === root.rootRef,
    );
    return metadataMatches && rootsMatch && row.rootProjects.length === manifest.roots.length
      ? manifest
      : null;
  } catch {
    return null;
  }
}

function manifestRow(
  store: UiStore,
  workspaceRoot: string,
): WorkspaceManifestRecordRow | undefined {
  if (typeof store.findWorkspaceManifestRecordByProject !== "function") return undefined;
  const direct = store.findWorkspaceManifestRecordByProject(workspaceRoot);
  if (direct !== undefined) return direct;
  try {
    return store.findWorkspaceManifestRecordByProject(realpathSync(workspaceRoot));
  } catch {
    return undefined;
  }
}

function canonicalBinding(
  manifest: WorkspaceManifest,
  root: WorkspaceRootDescriptor,
): EditorAgentRootBinding {
  return {
    workspaceId: manifest.workspaceId,
    manifestRef: manifest.manifestRef,
    manifestRevision: manifest.revision,
    manifestDigest: manifest.manifestDigest,
    rootRef: root.rootRef,
    rootIdentityDigest: root.identityDigest,
  };
}

function rootForSnapshot(
  snapshot: EditorAgentSessionSnapshot,
  manifest: WorkspaceManifest,
): WorkspaceRootDescriptor | undefined {
  let canonical: string;
  try {
    canonical = realpathSync(snapshot.workspaceRoot);
  } catch {
    return undefined;
  }
  return manifest.roots.find((root): boolean => root.canonicalRoot === canonical);
}

function identityMatches(root: WorkspaceRootDescriptor, row: WorkspaceManifestRecordRow): boolean {
  try {
    const inspected = inspectWorkspaceRootIdentity(root.canonicalRoot);
    return (
      inspected.rootRef === root.rootRef &&
      inspected.identityDigest === root.identityDigest &&
      inspected.objectIdentityDigest !== undefined &&
      inspected.objectIdentityDigest ===
        row.rootProjects.find((candidate): boolean => candidate.rootRef === root.rootRef)
          ?.objectIdentityDigest
    );
  } catch {
    return false;
  }
}

function bindingMismatchReason(
  supplied: EditorAgentRootBinding,
  expected: EditorAgentRootBinding,
  manifest: WorkspaceManifest,
): EditorAgentRootBoundaryReason | null {
  if (supplied.rootRef !== expected.rootRef) {
    return manifest.roots.some((root): boolean => root.rootRef === supplied.rootRef)
      ? "decompose-per-root"
      : "root-binding-invalid";
  }
  if (supplied.rootIdentityDigest !== expected.rootIdentityDigest) {
    return "root-binding-invalid";
  }
  return editorAgentRootBindingDenyReason(expected, supplied, true);
}

function legacySessionRoot(snapshot: EditorAgentSessionSnapshot): EditorAgentRootResolution {
  const binding = snapshot.rootBinding;
  return {
    ok: true,
    root: {
      workspaceRoot: snapshot.workspaceRoot,
      ...(binding === undefined ? {} : { rootRef: binding.rootRef }),
      binding,
      explicitBindingRequired: binding !== undefined,
    },
  };
}

function storedWorkspaceRoot(
  snapshot: EditorAgentSessionSnapshot,
  manifest: WorkspaceManifest,
  descriptor: WorkspaceRootDescriptor,
): string {
  if (snapshot.rootBinding !== undefined) return descriptor.canonicalRoot;
  return manifest.roots.length === 1 ? snapshot.workspaceRoot : descriptor.canonicalRoot;
}

function storedSessionRoot(
  snapshot: EditorAgentSessionSnapshot,
  store: UiStore,
): EditorAgentRootResolution {
  const row = manifestRow(store, snapshot.workspaceRoot);
  if (row === undefined) return { ok: false, reason: "root-binding-invalid" };
  const manifest = parsedManifest(row);
  if (manifest === null) return { ok: false, reason: "root-binding-invalid" };
  const descriptor = rootForSnapshot(snapshot, manifest);
  if (descriptor === undefined || !identityMatches(descriptor, row)) {
    return { ok: false, reason: "root-binding-invalid" };
  }
  const binding = canonicalBinding(manifest, descriptor);
  if (manifest.roots.length > 1 && snapshot.rootBinding === undefined) {
    return { ok: false, reason: "root-binding-required" };
  }
  if (snapshot.rootBinding !== undefined) {
    const mismatch = bindingMismatchReason(snapshot.rootBinding, binding, manifest);
    if (mismatch !== null) return { ok: false, reason: mismatch };
  }
  return {
    ok: true,
    root: {
      workspaceRoot: storedWorkspaceRoot(snapshot, manifest, descriptor),
      rootRef: descriptor.rootRef,
      ...(snapshot.rootBinding === undefined
        ? {}
        : {
            binding,
          }),
      manifest,
      explicitBindingRequired: manifest.roots.length > 1,
    },
  };
}

export function resolveEditorAgentSessionRoot(
  snapshot: EditorAgentSessionSnapshot,
  store?: UiStore,
): EditorAgentRootResolution {
  return store === undefined ? legacySessionRoot(snapshot) : storedSessionRoot(snapshot, store);
}

export function resolveEditorAgentActionRoot(
  snapshot: EditorAgentSessionSnapshot,
  actionBinding: EditorAgentRootBinding | undefined,
  store?: UiStore,
): EditorAgentRootResolution {
  const session = resolveEditorAgentSessionRoot(snapshot, store);
  if (!session.ok) return session;
  const reason = editorAgentRootBindingDenyReason(
    snapshot.rootBinding,
    actionBinding,
    session.root.explicitBindingRequired,
  );
  if (reason !== null) return { ok: false, reason };
  if (actionBinding !== undefined && session.root.binding !== undefined) {
    const manifest = session.root.manifest;
    const mismatch =
      manifest === undefined
        ? editorAgentRootBindingDenyReason(session.root.binding, actionBinding, true)
        : bindingMismatchReason(actionBinding, session.root.binding, manifest);
    if (mismatch !== null) return { ok: false, reason: mismatch };
  }
  return session;
}

function realCandidate(path: string): string {
  let current = path;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      current = parent;
    }
  }
}

function belongsToOtherRoot(root: EditorAgentResolvedRoot, candidate: string): boolean {
  return (
    root.manifest?.roots.some(
      (entry): boolean =>
        entry.rootRef !== root.rootRef && isWithinWorkspace(entry.canonicalRoot, candidate),
    ) === true
  );
}

// `fs` is the filesystem port the root's own authority resolved — for a Keiko-managed task worktree
// the owned-root port the managed access minted (workspace-root-access.ts). The check answers "does
// the path leave the resolved root"; with the plain node port that answer re-admitted the root under
// the user-workspace rules, and a worktree below the state directory's always-denied segment
// (`~/.keiko/…/task-workspaces`) refused every path inside it as an escape, which denied every
// governed coding edit (workbench end-to-end run, 2026-09-03).
/**
 * The dependency slice the containment port needs. Named here so BOTH editor route families can
 * pass themselves: `agentRoutes.ts` and `agentVerificationRoute.ts` each carried a near-verbatim
 * private copy of this resolution, and a fix applied to one copy but not the other would silently
 * re-open the managed-root containment defect this boundary exists to close (cursor review,
 * PR #3381).
 */
export interface EditorAgentContainmentDeps {
  readonly workspaceRootAccessResolver?:
    ((requestedRoot: string, correlationId?: string) => WorkspaceRootAccessOutcome) | undefined;
}

/**
 * A resolved containment port, or the refusal that resolving it produced. The refusal is NOT
 * collapsible into the node port: doing that ran the boundary check for a root whose authority had
 * just been refused (revoked lifecycle, replaced identity, unproven gitdir identity) against the
 * plain user-workspace rules, where a managed worktree under the state directory's always-denied
 * segment fails on every path — so the operator was told the target escapes its workspace when the
 * truth was that the workspace's own authority no longer held (P3, PR #3381 review).
 */
export type EditorAgentContainmentPort =
  | { readonly ok: true; readonly fs: WorkspaceFs }
  | { readonly ok: false; readonly reason: EditorAgentRootBoundaryReason };

/**
 * Resolves the filesystem port the root's own authority grants: the owned-root port a proven
 * managed task worktree minted, the plain node port for an ordinary root, and a refusal when the
 * resolver denied the root or could not complete the proof at all.
 *
 * `correlationId` is threaded into the resolver so the body-free `workspace.root.denied` line it
 * already emits for a denial (workspace-root-access.ts) lands on the caller's timeline instead of
 * UNKNOWN_CORRELATION_ID — one denial-logging vocabulary, not a second one at this boundary.
 */
export function resolveEditorAgentContainmentPort(
  deps: EditorAgentContainmentDeps | undefined,
  workspaceRoot: string,
  correlationId?: string,
): EditorAgentContainmentPort {
  const resolveAccess = deps?.workspaceRootAccessResolver;
  if (resolveAccess === undefined) return { ok: true, fs: nodeWorkspaceFs };
  let outcome: WorkspaceRootAccessOutcome;
  try {
    outcome = resolveAccess(workspaceRoot, correlationId);
  } catch (error) {
    // The production resolver reports every classified denial itself and never throws; a throw
    // means the proof could not be completed at all, so it is the one refusal with no record of
    // its own. Report it here rather than letting it disappear into a boundary escape.
    recordContainmentPortFailure(error, correlationId);
    return { ok: false, reason: "root-binding-invalid" };
  }
  if (outcome.decision === "granted") return { ok: true, fs: outcome.access.fs };
  // "denied" is a policy refusal of THIS root and is already on the activity log under the
  // correlation id above. "unresolved" is an ordinary missing/unreadable root, which the boundary
  // check itself answers, so it keeps the node port and its previous outcome.
  return outcome.decision === "denied"
    ? { ok: false, reason: "root-binding-invalid" }
    : { ok: true, fs: nodeWorkspaceFs };
}

function recordContainmentPortFailure(error: unknown, correlationId: string | undefined): void {
  emitServerDiagnostic(undefined, {
    correlationId: correlationIdOrUnknown(correlationId),
    timestamp: new Date().toISOString(),
    operation: "editor.agent.root-containment",
    source: "editor.agent-root-boundary",
    errorClass: contentFreeErrorClass(error),
    message: "editor-agent-root-authority-unresolvable",
  });
}

/**
 * The one call every route makes: resolve the root's containment port, then run the path-boundary
 * check through it. A refused port surfaces as its own denial reason instead of being mistaken for
 * a path escape.
 */
export function editorAgentRootContainmentReason(
  root: EditorAgentResolvedRoot,
  paths: readonly string[],
  deps: EditorAgentContainmentDeps | undefined,
  correlationId?: string,
): EditorAgentRootBoundaryReason | null {
  const port = resolveEditorAgentContainmentPort(deps, root.workspaceRoot, correlationId);
  return port.ok ? editorAgentPathBoundaryReason(root, paths, port.fs) : port.reason;
}

export function editorAgentPathBoundaryReason(
  root: EditorAgentResolvedRoot,
  paths: readonly string[],
  fs: WorkspaceFs = nodeWorkspaceFs,
): Extract<
  EditorAgentRootBoundaryReason,
  "decompose-per-root" | "workspace-boundary-escape"
> | null {
  if (root.binding === undefined && root.manifest === undefined) return null;
  for (const path of paths) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(root.workspaceRoot, path);
    try {
      if (!isContainedAgentPath(path)) throw new Error("lexical escape");
      containedRealPathInfo(fs, root.workspaceRoot, absolute);
    } catch {
      return belongsToOtherRoot(root, realCandidate(absolute))
        ? "decompose-per-root"
        : "workspace-boundary-escape";
    }
  }
  return null;
}
