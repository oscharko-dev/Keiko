// Server-owned, process-local approval for repository-authored package scripts. A grant is bound to
// the registered project's canonical root, the resolved workspace root, and the exact package.json
// digest observed when the human approved it. Any manifest change invalidates the grant before either
// the command runner or editor verification can execute a script.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { CodedHttpError, httpStatusFor } from "@oscharko-dev/keiko-contracts";
import {
  detectWorkspaceAt,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { Project, UiStore } from "./store/index.js";

const PACKAGE_MANIFEST_MAX_BYTES = 262_144;

export const WORKSPACE_SCRIPT_TRUST_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  PACKAGE_MANIFEST_UNAVAILABLE: "PACKAGE_MANIFEST_UNAVAILABLE",
} as const;

export type WorkspaceScriptTrustErrorCode =
  (typeof WORKSPACE_SCRIPT_TRUST_ERROR_CODES)[keyof typeof WORKSPACE_SCRIPT_TRUST_ERROR_CODES];

const STATUS_MAP: Readonly<Record<WorkspaceScriptTrustErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  PACKAGE_MANIFEST_UNAVAILABLE: 422,
};

export class WorkspaceScriptTrustError extends CodedHttpError {
  public readonly code: WorkspaceScriptTrustErrorCode;

  public constructor(code: WorkspaceScriptTrustErrorCode, message: string) {
    super(message, httpStatusFor(STATUS_MAP, code));
    this.code = code;
  }
}

export interface WorkspaceScriptTrustSnapshot {
  readonly trusted: boolean;
}

export interface WorkspaceScriptTrustService {
  readonly grant: (projectId: string) => WorkspaceScriptTrustSnapshot;
  readonly revoke: (projectId: string) => WorkspaceScriptTrustSnapshot;
  readonly isTrusted: (projectId: string, workspace: WorkspaceInfo) => boolean;
}

export interface WorkspaceScriptTrustServiceOptions {
  readonly store: UiStore;
  readonly fs?: WorkspaceFs | undefined;
}

interface TrustBinding {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly manifestDigest: string;
}

function projectFor(store: UiStore, projectId: string): Project | undefined {
  return store.listProjects().find((project) => project.path === projectId);
}

function projectRoot(store: UiStore, fs: WorkspaceFs, projectId: string): string {
  const project = projectFor(store, projectId);
  if (project === undefined) {
    throw new WorkspaceScriptTrustError("PROJECT_NOT_FOUND", "Project not found.");
  }
  try {
    return fs.realPath(project.path);
  } catch {
    throw new WorkspaceScriptTrustError(
      "PROJECT_NOT_FOUND",
      "Project root path could not be resolved.",
    );
  }
}

function manifestDigest(fs: WorkspaceFs, workspaceRoot: string): string {
  const manifestPath = join(workspaceRoot, "package.json");
  try {
    const stat = fs.stat(manifestPath);
    if (!stat.isFile || stat.isSymbolicLink || stat.size > PACKAGE_MANIFEST_MAX_BYTES) {
      throw new Error("manifest is not an approvable regular file");
    }
    const text = fs.readFileUtf8(manifestPath);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("manifest is not a JSON object");
    }
    return createHash("sha256").update(text, "utf8").digest("hex");
  } catch {
    throw new WorkspaceScriptTrustError(
      "PACKAGE_MANIFEST_UNAVAILABLE",
      "The project package manifest is unavailable for script trust.",
    );
  }
}

function bindingFor(
  store: UiStore,
  fs: WorkspaceFs,
  projectId: string,
  suppliedWorkspace?: WorkspaceInfo,
): TrustBinding {
  const canonicalProjectRoot = projectRoot(store, fs, projectId);
  const detected = suppliedWorkspace ?? detectWorkspaceAt(canonicalProjectRoot, fs);
  let canonicalWorkspaceRoot: string;
  try {
    canonicalWorkspaceRoot = fs.realPath(detected.root);
  } catch {
    throw new WorkspaceScriptTrustError(
      "PROJECT_NOT_FOUND",
      "Project workspace path could not be resolved.",
    );
  }
  if (canonicalWorkspaceRoot !== canonicalProjectRoot) {
    throw new WorkspaceScriptTrustError("PROJECT_NOT_FOUND", "Project workspace does not match.");
  }
  return {
    projectRoot: canonicalProjectRoot,
    workspaceRoot: canonicalWorkspaceRoot,
    manifestDigest: manifestDigest(fs, canonicalWorkspaceRoot),
  };
}

class WorkspaceScriptTrustServiceImpl implements WorkspaceScriptTrustService {
  private readonly store: UiStore;
  private readonly fs: WorkspaceFs;
  private readonly grants = new Map<string, TrustBinding>();

  public constructor(options: WorkspaceScriptTrustServiceOptions) {
    this.store = options.store;
    this.fs = options.fs ?? nodeWorkspaceFs;
  }

  public readonly grant = (projectId: string): WorkspaceScriptTrustSnapshot => {
    const binding = bindingFor(this.store, this.fs, projectId);
    this.grants.set(binding.projectRoot, binding);
    return { trusted: true };
  };

  public readonly revoke = (projectId: string): WorkspaceScriptTrustSnapshot => {
    const root = projectRoot(this.store, this.fs, projectId);
    this.grants.delete(root);
    return { trusted: false };
  };

  public readonly isTrusted = (projectId: string, workspace: WorkspaceInfo): boolean => {
    let current: TrustBinding;
    try {
      current = bindingFor(this.store, this.fs, projectId, workspace);
    } catch {
      return false;
    }
    const granted = this.grants.get(current.projectRoot);
    if (granted === undefined) return false;
    const unchanged =
      granted.workspaceRoot === current.workspaceRoot &&
      granted.manifestDigest === current.manifestDigest;
    if (!unchanged) this.grants.delete(current.projectRoot);
    return unchanged;
  };
}

export function createWorkspaceScriptTrustService(
  options: WorkspaceScriptTrustServiceOptions,
): WorkspaceScriptTrustService {
  return new WorkspaceScriptTrustServiceImpl(options);
}
