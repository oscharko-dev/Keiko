import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createFileWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndex,
} from "@oscharko-dev/keiko-workspace";
import {
  resolveLocalVaultKey,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";

interface WorkspaceIndexEnv extends Readonly<Record<string, string | undefined>> {
  readonly KEIKO_WORKSPACE_INDEX_DIR?: string | undefined;
  readonly KEIKO_WORKSPACE_INDEX_KEY?: string | undefined;
}

export interface ServerWorkspaceIndexProviderOptions {
  readonly runtimeStateDir: string;
  readonly env?: WorkspaceIndexEnv | undefined;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

export type WorkspaceIndexProvider = (workspaceRoot: string) => WorkspaceIndex | undefined;

const WORKSPACE_INDEX_RUNTIME_DIRNAME = "workspace-index";
const WORKSPACE_INDEX_KEY_ENV = "KEIKO_WORKSPACE_INDEX_KEY";
const WORKSPACE_INDEX_KEYCHAIN_SERVICE = "keiko-workspace-index-vault";
const WORKSPACE_INDEX_KEYFILE = "workspace-index-vault.key";

interface CachedWorkspaceIndex {
  readonly keyFingerprint: string;
  readonly index: WorkspaceIndex;
}

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

function workspaceIndexKeyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex");
}

function reportWorkspaceIndexFailure(
  options: ServerWorkspaceIndexProviderOptions,
  error: unknown,
): void {
  emitServerDiagnostic(
    options.diagnostics,
    serverDiagnosticFromError({
      correlationId: randomUUID(),
      operation: "workspace.index.open",
      source: "workspace-index-provider",
      error,
      redact: () => "Workspace index key resolution or initialization failed.",
    }),
  );
}

export function createServerWorkspaceIndexProvider(
  options: ServerWorkspaceIndexProviderOptions,
): WorkspaceIndexProvider {
  const indexes = new Map<string, CachedWorkspaceIndex>();
  return (workspaceRoot: string): WorkspaceIndex | undefined => {
    const runtimeDir = resolveServerWorkspaceIndexRuntimeDir(workspaceRoot, options);
    if (runtimeDir === undefined) {
      return undefined;
    }
    const cacheKey = `${resolve(workspaceRoot)}\u0000${runtimeDir}`;
    try {
      const { key } = resolveLocalVaultKey({
        env: options.env ?? process.env,
        vaultDir: runtimeDir,
        envVarName: WORKSPACE_INDEX_KEY_ENV,
        keychainService: WORKSPACE_INDEX_KEYCHAIN_SERVICE,
        keyfileName: WORKSPACE_INDEX_KEYFILE,
        ...(options.keychainAccess === undefined ? {} : { keychainAccess: options.keychainAccess }),
      });
      const keyFingerprint = workspaceIndexKeyFingerprint(key);
      const existing = indexes.get(cacheKey);
      if (existing?.keyFingerprint === keyFingerprint) {
        return existing.index;
      }
      const index = createWorkspaceIndex(
        createFileWorkspaceIndexStore({ runtimeDir, workspaceRoot, encryptionKey: key }),
      );
      indexes.set(cacheKey, { keyFingerprint, index });
      return index;
    } catch (error) {
      reportWorkspaceIndexFailure(options, error);
      return undefined;
    }
  };
}
