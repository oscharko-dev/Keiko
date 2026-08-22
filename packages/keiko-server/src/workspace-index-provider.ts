import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createFileWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceIndexSnapshot,
} from "@oscharko-dev/keiko-workspace";
import {
  resolveLocalVaultKey,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
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
  // Optional activity-log seam (ADR-0019); the deps.ts composition root supplies
  // `processServerLogSink()`.
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export type WorkspaceIndexProvider = (workspaceRoot: string) => WorkspaceIndex | undefined;

const WORKSPACE_INDEX_RUNTIME_DIRNAME = "workspace-index";
const WORKSPACE_INDEX_KEY_ENV = "KEIKO_WORKSPACE_INDEX_KEY";
const WORKSPACE_INDEX_KEYCHAIN_SERVICE = "keiko-workspace-index-vault";
const WORKSPACE_INDEX_KEYFILE = "workspace-index-vault.key";

interface CachedWorkspaceIndex {
  readonly generation: WorkspaceIndexGeneration;
  readonly keyFingerprint: string;
  readonly index: WorkspaceIndex;
}

interface WorkspaceIndexGeneration {
  active: boolean;
  reported: boolean;
}

interface RuntimeWorkspaceIndexGeneration {
  readonly keyFingerprint: string;
  readonly generation: WorkspaceIndexGeneration;
}

type WorkspaceIndexLoadFailureReason = "authentication-or-corruption" | "invalid-snapshot";

class WorkspaceIndexSnapshotLoadError extends Error {
  readonly code: string;

  constructor(reason: WorkspaceIndexLoadFailureReason) {
    super("Encrypted workspace index snapshot was rejected.");
    this.code =
      reason === "authentication-or-corruption"
        ? "WORKSPACE_INDEX_AUTH_OR_CORRUPTION"
        : "WORKSPACE_INDEX_INVALID_SNAPSHOT";
  }
}

class WorkspaceIndexSnapshotSaveError extends Error {
  readonly code = "WORKSPACE_INDEX_WRITE_REJECTED";

  constructor() {
    super("Encrypted workspace index snapshot write was rejected.");
  }
}

class WorkspaceIndexKeyRotatedError extends Error {
  readonly code = "WORKSPACE_INDEX_KEY_ROTATED";

  constructor() {
    super("Stale workspace index generation was rejected after key rotation.");
  }
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

function reportWorkspaceIndexLoadFailure(
  options: ServerWorkspaceIndexProviderOptions,
  reason: WorkspaceIndexLoadFailureReason,
): void {
  emitServerDiagnostic(
    options.diagnostics,
    serverDiagnosticFromError({
      correlationId: randomUUID(),
      operation: "workspace.index.load",
      source: "workspace-index-provider",
      error: new WorkspaceIndexSnapshotLoadError(reason),
      redact: () => "Encrypted workspace index snapshot was rejected.",
    }),
  );
}

function reportWorkspaceIndexSaveFailure(options: ServerWorkspaceIndexProviderOptions): void {
  emitServerDiagnostic(
    options.diagnostics,
    serverDiagnosticFromError({
      correlationId: randomUUID(),
      operation: "workspace.index.save",
      source: "workspace-index-provider",
      error: new WorkspaceIndexSnapshotSaveError(),
      redact: () => "Encrypted workspace index snapshot write was rejected.",
    }),
  );
}

function reportStaleWorkspaceIndexGeneration(
  options: ServerWorkspaceIndexProviderOptions,
  generation: WorkspaceIndexGeneration,
): void {
  if (generation.reported) return;
  generation.reported = true;
  emitServerDiagnostic(
    options.diagnostics,
    serverDiagnosticFromError({
      correlationId: randomUUID(),
      operation: "workspace.index.generation",
      source: "workspace-index-provider",
      error: new WorkspaceIndexKeyRotatedError(),
      redact: () => "Stale workspace index generation was rejected after key rotation.",
    }),
  );
}

function generationBoundWorkspaceIndex(
  index: WorkspaceIndex,
  generation: WorkspaceIndexGeneration,
  options: ServerWorkspaceIndexProviderOptions,
): WorkspaceIndex {
  const stale = (): boolean => {
    if (generation.active) return false;
    reportStaleWorkspaceIndexGeneration(options, generation);
    return true;
  };
  return {
    loadSnapshot: async (scopeKey): Promise<WorkspaceIndexSnapshot | undefined> => {
      if (stale()) return undefined;
      const snapshot = await index.loadSnapshot(scopeKey);
      return stale() ? undefined : snapshot;
    },
    saveSnapshot: async (scopeKey, snapshot): Promise<void> => {
      if (stale()) throw new WorkspaceIndexKeyRotatedError();
      try {
        await index.saveSnapshot(scopeKey, snapshot);
      } catch (error) {
        if (stale()) throw new WorkspaceIndexKeyRotatedError();
        throw error;
      }
      if (stale()) throw new WorkspaceIndexKeyRotatedError();
    },
  };
}

function activeRuntimeGeneration(
  generations: Map<string, RuntimeWorkspaceIndexGeneration>,
  runtimeDir: string,
  keyFingerprint: string,
): WorkspaceIndexGeneration {
  const existing = generations.get(runtimeDir);
  if (existing?.generation.active === true && existing.keyFingerprint === keyFingerprint) {
    return existing.generation;
  }
  if (existing !== undefined) existing.generation.active = false;
  const generation: WorkspaceIndexGeneration = { active: true, reported: false };
  generations.set(runtimeDir, { generation, keyFingerprint });
  return generation;
}

function retireRuntimeGeneration(
  generations: Map<string, RuntimeWorkspaceIndexGeneration>,
  runtimeDir: string,
): void {
  const existing = generations.get(runtimeDir);
  if (existing !== undefined) existing.generation.active = false;
}

function createGenerationWorkspaceIndex(
  options: ServerWorkspaceIndexProviderOptions,
  runtimeDir: string,
  workspaceRoot: string,
  key: Buffer,
  generation: WorkspaceIndexGeneration,
): WorkspaceIndex {
  const fileIndex = createWorkspaceIndex(
    createFileWorkspaceIndexStore({
      runtimeDir,
      workspaceRoot,
      encryptionKey: key,
      isGenerationActive: (): boolean => generation.active,
      onLoadFailure: (failure): void => {
        reportWorkspaceIndexLoadFailure(options, failure.reason);
      },
      onSaveFailure: (): void => {
        reportWorkspaceIndexSaveFailure(options);
      },
    }),
  );
  return generationBoundWorkspaceIndex(fileIndex, generation, options);
}

export function createServerWorkspaceIndexProvider(
  options: ServerWorkspaceIndexProviderOptions,
): WorkspaceIndexProvider {
  const indexes = new Map<string, CachedWorkspaceIndex>();
  const generations = new Map<string, RuntimeWorkspaceIndexGeneration>();
  return (workspaceRoot: string): WorkspaceIndex | undefined => {
    const runtimeDir = resolveServerWorkspaceIndexRuntimeDir(workspaceRoot, options);
    if (runtimeDir === undefined) {
      return undefined;
    }
    const cacheKey = `${resolve(workspaceRoot)}\u0000${runtimeDir}`;
    const existing = indexes.get(cacheKey);
    try {
      const { key } = resolveLocalVaultKey({
        env: options.env ?? process.env,
        vaultDir: runtimeDir,
        envVarName: WORKSPACE_INDEX_KEY_ENV,
        keychainService: WORKSPACE_INDEX_KEYCHAIN_SERVICE,
        keyfileName: WORKSPACE_INDEX_KEYFILE,
        ...(options.keychainAccess === undefined ? {} : { keychainAccess: options.keychainAccess }),
        sink: options.securityLogSink,
      });
      const keyFingerprint = workspaceIndexKeyFingerprint(key);
      if (existing?.generation.active === true && existing.keyFingerprint === keyFingerprint) {
        return existing.index;
      }
      if (existing !== undefined) existing.generation.active = false;
      const generation = activeRuntimeGeneration(generations, runtimeDir, keyFingerprint);
      const index = createGenerationWorkspaceIndex(
        options,
        runtimeDir,
        workspaceRoot,
        key,
        generation,
      );
      indexes.set(cacheKey, { generation, keyFingerprint, index });
      return index;
    } catch (error) {
      if (existing !== undefined) existing.generation.active = false;
      retireRuntimeGeneration(generations, runtimeDir);
      reportWorkspaceIndexFailure(options, error);
      return undefined;
    }
  };
}
