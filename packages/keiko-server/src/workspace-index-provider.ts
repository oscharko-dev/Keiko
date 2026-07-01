import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createFileWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndex,
} from "@oscharko-dev/keiko-workspace";

interface WorkspaceIndexEnv {
  readonly KEIKO_WORKSPACE_INDEX_DIR?: string | undefined;
}

export interface ServerWorkspaceIndexProviderOptions {
  readonly runtimeStateDir: string;
  readonly env?: WorkspaceIndexEnv | undefined;
}

export type WorkspaceIndexProvider = (workspaceRoot: string) => WorkspaceIndex | undefined;

const WORKSPACE_INDEX_RUNTIME_DIRNAME = "workspace-index";

function resolvedRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    try {
      return resolve(realpathSync(parent), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

function containsPath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isOutsideWorkspace(workspaceRoot: string, runtimeDir: string): boolean {
  const root = resolve(workspaceRoot);
  const runtime = resolve(runtimeDir);
  if (containsPath(root, runtime)) {
    return false;
  }
  return !containsPath(resolvedRealPath(root), resolvedRealPath(runtime));
}

function explicitRuntimeDir(options: ServerWorkspaceIndexProviderOptions): string | undefined {
  const configured = options.env?.KEIKO_WORKSPACE_INDEX_DIR?.trim();
  if (configured === undefined || configured.length === 0) {
    return undefined;
  }
  return isAbsolute(configured)
    ? resolve(configured)
    : resolve(options.runtimeStateDir, configured);
}

export function resolveServerWorkspaceIndexRuntimeDir(
  workspaceRoot: string,
  options: ServerWorkspaceIndexProviderOptions,
): string | undefined {
  const explicit = explicitRuntimeDir(options);
  if (explicit !== undefined) {
    return isOutsideWorkspace(workspaceRoot, explicit) ? explicit : undefined;
  }
  const candidates = [
    join(options.runtimeStateDir, WORKSPACE_INDEX_RUNTIME_DIRNAME),
    join(homedir(), ".keiko", WORKSPACE_INDEX_RUNTIME_DIRNAME),
  ];
  return candidates
    .map((candidate) => resolve(candidate))
    .find((candidate) => isOutsideWorkspace(workspaceRoot, candidate));
}

export function createServerWorkspaceIndexProvider(
  options: ServerWorkspaceIndexProviderOptions,
): WorkspaceIndexProvider {
  const indexes = new Map<string, WorkspaceIndex>();
  return (workspaceRoot: string): WorkspaceIndex | undefined => {
    const runtimeDir = resolveServerWorkspaceIndexRuntimeDir(workspaceRoot, options);
    if (runtimeDir === undefined) {
      return undefined;
    }
    const cacheKey = `${resolve(workspaceRoot)}\u0000${runtimeDir}`;
    const existing = indexes.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }
    try {
      const index = createWorkspaceIndex(
        createFileWorkspaceIndexStore({ runtimeDir, workspaceRoot }),
      );
      indexes.set(cacheKey, index);
      return index;
    } catch {
      return undefined;
    }
  };
}
