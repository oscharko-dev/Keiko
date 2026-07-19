// Issue #2524, ADR-0146 — server-owned multi-root workspace model. Every mutation validates one
// explicit current-root dispatch, rebuilds the closed manifest, and delegates the manifest/trust
// transition to one SQLite transaction through UiStore.

import {
  validateWorkspaceManifest,
  validateWorkspaceRootDispatch,
  WORKSPACE_MANIFEST_MAX_ROOTS,
} from "@oscharko-dev/keiko-contracts";
import type {
  WorkspaceBindingV2,
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootDispatch,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import type {
  Project,
  UiStore,
  WorkspaceManifestRecordRow,
  WorkspaceManifestRootProject,
} from "./store/index.js";
import { buildBinding } from "./task-workspace/binding.js";
import {
  inspectWorkspaceRootDescriptor,
  reviseWorkspaceManifest,
} from "./workspace-manifest-identity.js";
import { inspectWorkspaceRootIdentity } from "./workspace-root-identity.js";

export type WorkspaceManifestErrorCode =
  | "WORKSPACE_MANIFEST_UNAVAILABLE"
  | "WORKSPACE_DISPATCH_INVALID"
  | "WORKSPACE_DISPATCH_STALE"
  | "WORKSPACE_ROOT_NOT_MEMBER"
  | "WORKSPACE_ROOT_IDENTITY_CHANGED"
  | "WORKSPACE_ROOT_ALREADY_BOUND"
  | "WORKSPACE_ROOT_LIMIT_REACHED"
  | "WORKSPACE_LAST_ROOT"
  | "WORKSPACE_ROOT_SET_INVALID"
  | "WORKSPACE_PROJECT_NOT_FOUND"
  | "WORKSPACE_REVISION_CONFLICT";

export class WorkspaceManifestError extends Error {
  public readonly code: WorkspaceManifestErrorCode;

  public constructor(code: WorkspaceManifestErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceManifestError";
    this.code = code;
  }
}

export interface WorkspaceManifestMutationResult {
  readonly manifest: WorkspaceManifest;
  readonly affectedRoots: readonly string[];
}

function unavailable(): never {
  throw new WorkspaceManifestError(
    "WORKSPACE_MANIFEST_UNAVAILABLE",
    "Workspace manifest state is unavailable.",
  );
}

function parseManifest(row: WorkspaceManifestRecordRow): WorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.recordJson);
  } catch {
    return unavailable();
  }
  if (!validateWorkspaceManifest(parsed).ok) return unavailable();
  const manifest = parsed as WorkspaceManifest;
  const metadataMatches =
    manifest.workspaceId === row.workspaceId &&
    manifest.schemaVersion === row.schemaVersion &&
    manifest.manifestRef === row.manifestRef &&
    manifest.revision === row.revision &&
    manifest.manifestDigest === row.manifestDigest;
  const rootsMatch = manifest.roots.every(
    (root, index): boolean => row.rootProjects[index]?.rootRef === root.rootRef,
  );
  if (!metadataMatches || !rootsMatch || row.rootProjects.length !== manifest.roots.length) {
    return unavailable();
  }
  return manifest;
}

function requireManifest(store: UiStore, workspaceId: string): WorkspaceManifestRecordRow {
  const row = store.readWorkspaceManifestRecord(workspaceId);
  if (row === undefined) return unavailable();
  return row;
}

function requireMutatingDispatch(dispatch: WorkspaceRootDispatch): void {
  if (dispatch.operationClass !== "mutating") {
    throw new WorkspaceManifestError(
      "WORKSPACE_DISPATCH_INVALID",
      "Workspace mutation requires a mutating root dispatch.",
    );
  }
}

function dispatchMatchesManifest(
  dispatch: WorkspaceRootDispatch,
  manifest: WorkspaceManifest,
): boolean {
  return (
    dispatch.workspaceId === manifest.workspaceId &&
    dispatch.manifestRef === manifest.manifestRef &&
    dispatch.manifestRevision === manifest.revision &&
    dispatch.manifestDigest === manifest.manifestDigest
  );
}

function requireDispatchRoot(
  dispatch: WorkspaceRootDispatch,
  manifest: WorkspaceManifest,
): WorkspaceRootDescriptor {
  const root = manifest.roots.find((candidate) => candidate.rootRef === dispatch.rootRef);
  if (root === undefined) {
    throw new WorkspaceManifestError(
      "WORKSPACE_ROOT_NOT_MEMBER",
      "The selected root is not a workspace member.",
    );
  }
  return root;
}

function revalidateRoot(dispatch: WorkspaceRootDispatch, root: WorkspaceRootDescriptor): void {
  let inspected: ReturnType<typeof inspectWorkspaceRootIdentity>;
  try {
    inspected = inspectWorkspaceRootIdentity(root.canonicalRoot);
  } catch {
    throw new WorkspaceManifestError(
      "WORKSPACE_ROOT_IDENTITY_CHANGED",
      "Workspace root identity could not be revalidated.",
    );
  }
  if (
    inspected.rootRef !== root.rootRef ||
    inspected.identityDigest !== root.identityDigest ||
    dispatch.rootIdentityDigest !== root.identityDigest
  ) {
    throw new WorkspaceManifestError(
      "WORKSPACE_ROOT_IDENTITY_CHANGED",
      "Workspace root identity changed.",
    );
  }
}

function authorizeDispatch(
  store: UiStore,
  input: unknown,
): { readonly dispatch: WorkspaceRootDispatch; readonly manifest: WorkspaceManifest } {
  if (!validateWorkspaceRootDispatch(input).ok) {
    throw new WorkspaceManifestError(
      "WORKSPACE_DISPATCH_INVALID",
      "Workspace root dispatch is invalid.",
    );
  }
  const dispatch = input as WorkspaceRootDispatch;
  const manifest = parseManifest(requireManifest(store, dispatch.workspaceId));
  if (!dispatchMatchesManifest(dispatch, manifest)) {
    throw new WorkspaceManifestError(
      "WORKSPACE_DISPATCH_STALE",
      "Workspace root dispatch is stale.",
    );
  }
  revalidateRoot(dispatch, requireDispatchRoot(dispatch, manifest));
  return { dispatch, manifest };
}

function projectByPath(store: UiStore, projectPath: string): Project {
  const project = store.listProjects().find((candidate) => candidate.path === projectPath);
  if (project === undefined) {
    throw new WorkspaceManifestError(
      "WORKSPACE_PROJECT_NOT_FOUND",
      "Workspace project is not registered.",
    );
  }
  return project;
}

function inspectProjectRoot(project: Project): WorkspaceRootDescriptor {
  try {
    return inspectWorkspaceRootDescriptor(project.path, project.name);
  } catch {
    throw new WorkspaceManifestError(
      "WORKSPACE_ROOT_IDENTITY_CHANGED",
      "Workspace project root could not be inspected.",
    );
  }
}

function revisedManifest(
  manifest: WorkspaceManifest,
  roots: readonly WorkspaceRootDescriptor[],
  focusedRootRef: WorkspaceRootRef,
): WorkspaceManifest {
  try {
    return reviseWorkspaceManifest(manifest, roots, focusedRootRef);
  } catch {
    throw new WorkspaceManifestError(
      "WORKSPACE_ROOT_SET_INVALID",
      "Workspace root set is invalid.",
    );
  }
}

function projectMap(row: WorkspaceManifestRecordRow): Map<string, string> {
  return new Map(row.rootProjects.map((root) => [root.rootRef, root.projectPath] as const));
}

function rootProjects(
  roots: readonly WorkspaceRootDescriptor[],
  projects: ReadonlyMap<string, string>,
): readonly WorkspaceManifestRootProject[] {
  return roots.map((root) => {
    const projectPath = projects.get(root.rootRef);
    if (projectPath === undefined) return unavailable();
    return { rootRef: root.rootRef, projectPath };
  });
}

function affectedRootPaths(before: WorkspaceManifest, after: WorkspaceManifest): readonly string[] {
  return [...new Set([...before.roots, ...after.roots].map((root) => root.canonicalRoot))];
}

function persistRevision(
  store: UiStore,
  row: WorkspaceManifestRecordRow,
  dispatch: WorkspaceRootDispatch,
  current: WorkspaceManifest,
  next: WorkspaceManifest,
  projects: ReadonlyMap<string, string>,
  absorbedWorkspaceIds: readonly string[] = [],
): WorkspaceManifestMutationResult {
  authorizeDispatch(store, dispatch);
  const replaced = store.replaceWorkspaceManifest({
    manifest: next,
    expectedRevision: current.revision,
    absorbedWorkspaceIds,
    rootProjects: rootProjects(next.roots, projects),
  });
  if (!replaced || row.revision !== current.revision) {
    throw new WorkspaceManifestError(
      "WORKSPACE_REVISION_CONFLICT",
      "Workspace manifest changed concurrently.",
    );
  }
  return { manifest: next, affectedRoots: affectedRootPaths(current, next) };
}

export class WorkspaceManifestService {
  private readonly store: UiStore;

  public constructor(store: UiStore) {
    this.store = store;
  }

  public list(): readonly WorkspaceManifest[] {
    return this.store.listWorkspaceManifestRecords().map(parseManifest);
  }

  public get(workspaceId: string): WorkspaceManifest {
    return parseManifest(requireManifest(this.store, workspaceId));
  }

  public binding(workspaceId: string): WorkspaceBindingV2 {
    const manifest = this.get(workspaceId);
    return buildBinding(manifest, manifest.workspaceId);
  }

  public resolveDispatch(input: unknown): WorkspaceRootDescriptor {
    const { dispatch, manifest } = authorizeDispatch(this.store, input);
    return requireDispatchRoot(dispatch, manifest);
  }

  public addRoot(input: unknown, projectPath: string): WorkspaceManifestMutationResult {
    const { dispatch, manifest } = authorizeDispatch(this.store, input);
    requireMutatingDispatch(dispatch);
    if (manifest.roots.length >= WORKSPACE_MANIFEST_MAX_ROOTS) {
      throw new WorkspaceManifestError(
        "WORKSPACE_ROOT_LIMIT_REACHED",
        "Workspace root limit reached.",
      );
    }
    const project = projectByPath(this.store, projectPath);
    const root = inspectProjectRoot(project);
    if (manifest.roots.some((candidate) => candidate.rootRef === root.rootRef)) {
      throw new WorkspaceManifestError(
        "WORKSPACE_ROOT_ALREADY_BOUND",
        "Workspace root is already a member.",
      );
    }
    const owner = this.store.findWorkspaceManifestRecordByProject(project.path);
    const absorbed = owner === undefined ? [] : [parseManifest(owner)];
    if (absorbed.some((candidate) => candidate.roots.length !== 1)) {
      throw new WorkspaceManifestError(
        "WORKSPACE_ROOT_ALREADY_BOUND",
        "Workspace root is already bound to another multi-root workspace.",
      );
    }
    const row = requireManifest(this.store, manifest.workspaceId);
    const projects = projectMap(row);
    projects.set(root.rootRef, project.path);
    const next = revisedManifest(manifest, [...manifest.roots, root], manifest.focusedRootRef);
    return persistRevision(
      this.store,
      row,
      dispatch,
      manifest,
      next,
      projects,
      absorbed.map((candidate) => candidate.workspaceId),
    );
  }

  public removeRoot(input: unknown, targetRootRef: string): WorkspaceManifestMutationResult {
    const { dispatch, manifest } = authorizeDispatch(this.store, input);
    requireMutatingDispatch(dispatch);
    if (manifest.roots.length === 1) {
      throw new WorkspaceManifestError("WORKSPACE_LAST_ROOT", "A workspace must retain one root.");
    }
    const roots = manifest.roots.filter((root) => root.rootRef !== targetRootRef);
    if (roots.length === manifest.roots.length) {
      throw new WorkspaceManifestError(
        "WORKSPACE_ROOT_NOT_MEMBER",
        "The selected root is not a workspace member.",
      );
    }
    const focused =
      manifest.focusedRootRef === targetRootRef ? roots[0]?.rootRef : manifest.focusedRootRef;
    if (focused === undefined) return unavailable();
    const row = requireManifest(this.store, manifest.workspaceId);
    const next = revisedManifest(manifest, roots, focused);
    return persistRevision(this.store, row, dispatch, manifest, next, projectMap(row));
  }

  public reorderRoots(
    input: unknown,
    orderedRootRefs: readonly string[],
  ): WorkspaceManifestMutationResult {
    const { dispatch, manifest } = authorizeDispatch(this.store, input);
    requireMutatingDispatch(dispatch);
    const byRef = new Map(manifest.roots.map((root) => [root.rootRef, root] as const));
    const roots = orderedRootRefs.flatMap((rootRef) => {
      const root = byRef.get(rootRef as WorkspaceRootRef);
      return root === undefined ? [] : [root];
    });
    if (
      roots.length !== manifest.roots.length ||
      new Set(orderedRootRefs).size !== manifest.roots.length
    ) {
      throw new WorkspaceManifestError(
        "WORKSPACE_ROOT_SET_INVALID",
        "Workspace root order must name every current root exactly once.",
      );
    }
    const row = requireManifest(this.store, manifest.workspaceId);
    const next = revisedManifest(manifest, roots, manifest.focusedRootRef);
    return persistRevision(this.store, row, dispatch, manifest, next, projectMap(row));
  }

  public focusRoot(input: unknown, focusedRootRef: string): WorkspaceManifestMutationResult {
    const { dispatch, manifest } = authorizeDispatch(this.store, input);
    requireMutatingDispatch(dispatch);
    if (!manifest.roots.some((root) => root.rootRef === focusedRootRef)) {
      throw new WorkspaceManifestError(
        "WORKSPACE_ROOT_NOT_MEMBER",
        "The selected root is not a workspace member.",
      );
    }
    const row = requireManifest(this.store, manifest.workspaceId);
    const next = revisedManifest(manifest, manifest.roots, focusedRootRef as WorkspaceRootRef);
    return persistRevision(this.store, row, dispatch, manifest, next, projectMap(row));
  }
}
