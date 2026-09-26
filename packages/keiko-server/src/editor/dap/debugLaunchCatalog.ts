import { createHash } from "node:crypto";
import { extname, isAbsolute, relative, sep } from "node:path";
import type { CommandTask, CommandTaskCatalog } from "@oscharko-dev/keiko-contracts";
import {
  assertContainedRealPath,
  resolveWithinWorkspace,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { sha256Json } from "./debugIdentityDigest.js";
import {
  isSafeDebugScriptName,
  isSupportedNodeDebugExtension,
} from "./debugLaunchSecurityPredicates.js";

const MAX_DEBUG_TARGET_BYTES = 4_194_304;

export type DebugLaunchTarget =
  | {
      readonly kind: "catalog";
      readonly targetId: string;
      readonly scriptName: string;
      readonly targetIdentityDigest: string;
    }
  | {
      readonly kind: "file";
      readonly fileId: string;
      readonly hostPath: string;
      readonly capsulePath: string;
      readonly targetIdentityDigest: string;
    };

export class DebugLaunchTargetError extends Error {
  public readonly code: "INVALID_TARGET" | "WORKSPACE_ESCAPE" | "WORKSPACE_UNTRUSTED";
  public constructor(code: DebugLaunchTargetError["code"]) {
    super(code);
    this.name = "DebugLaunchTargetError";
    this.code = code;
  }
}

export interface DebugLaunchCatalogDeps {
  readonly discover: (projectId: string) => CommandTaskCatalog;
  readonly fs: WorkspaceFs;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly workspaceTrusted: boolean;
}

function trustedTask(task: CommandTask | undefined): {
  readonly task: CommandTask;
  readonly scriptName: string;
} {
  if (task === undefined) throw new DebugLaunchTargetError("INVALID_TARGET");
  if (task.trustState !== "trusted") throw new DebugLaunchTargetError("WORKSPACE_UNTRUSTED");
  if (task.executable !== "npm") {
    throw new DebugLaunchTargetError("INVALID_TARGET");
  }
  const [run, scriptName, ...extra] = task.args;
  if (run !== "run" || extra.length > 0) {
    throw new DebugLaunchTargetError("INVALID_TARGET");
  }
  if (scriptName === undefined) throw new DebugLaunchTargetError("INVALID_TARGET");
  if (!isSafeDebugScriptName(scriptName) || task.id !== `npm-script:${scriptName}`) {
    throw new DebugLaunchTargetError("INVALID_TARGET");
  }
  return { task, scriptName };
}

function readCatalogManifest(deps: DebugLaunchCatalogDeps): {
  readonly stat: ReturnType<WorkspaceFs["stat"]>;
  readonly content: string;
} {
  try {
    const lexical = resolveWithinWorkspace(deps.workspaceRoot, "package.json");
    // Stryker disable StringLiteral: Workspace containment intentionally ignores this
    // diagnostic-only label; mutating it cannot change the accepted path or closed error.
    const hostPath = assertContainedRealPath(
      deps.fs,
      deps.workspaceRoot,
      lexical,
      "debug catalog manifest",
    );
    // Stryker restore StringLiteral
    const stat = deps.fs.stat(hostPath);
    const content = deps.fs.readFileUtf8(hostPath);
    return { stat, content };
  } catch {
    throw new DebugLaunchTargetError("INVALID_TARGET");
  }
}

function catalogManifestIdentity(deps: DebugLaunchCatalogDeps): string {
  const { stat, content } = readCatalogManifest(deps);
  if (!stat.isFile || stat.size > MAX_DEBUG_TARGET_BYTES) {
    throw new DebugLaunchTargetError("INVALID_TARGET");
  }
  if (Buffer.byteLength(content) !== stat.size) {
    throw new DebugLaunchTargetError("INVALID_TARGET");
  }
  return createHash("sha256").update(content).digest("hex");
}

export function deriveCatalogDebugTarget(
  targetId: string,
  deps: DebugLaunchCatalogDeps,
): Extract<DebugLaunchTarget, { readonly kind: "catalog" }> {
  const catalog = deps.discover(deps.projectId);
  if (!deps.workspaceTrusted) throw new DebugLaunchTargetError("WORKSPACE_UNTRUSTED");
  if (
    catalog.projectId !== deps.projectId ||
    new Set(catalog.tasks.map((task) => task.id)).size !== catalog.tasks.length
  ) {
    throw new DebugLaunchTargetError("INVALID_TARGET");
  }
  const { task, scriptName } = trustedTask(catalog.tasks.find((entry) => entry.id === targetId));
  return Object.freeze({
    kind: "catalog",
    targetId: task.id,
    scriptName,
    targetIdentityDigest: sha256Json([catalog.projectId, task, catalogManifestIdentity(deps)]),
  });
}

export function deriveFileDebugTarget(
  fileId: string,
  deps: DebugLaunchCatalogDeps,
): Extract<DebugLaunchTarget, { readonly kind: "file" }> {
  if (!deps.workspaceTrusted) throw new DebugLaunchTargetError("WORKSPACE_UNTRUSTED");
  if (fileId.length === 0 || fileId.includes("\u0000") || isAbsolute(fileId))
    throw new DebugLaunchTargetError("INVALID_TARGET");
  try {
    const lexical = resolveWithinWorkspace(deps.workspaceRoot, fileId);
    // Stryker disable next-line StringLiteral: Workspace containment intentionally ignores this
    // diagnostic-only label; mutating it cannot change the accepted path or closed error.
    const hostPath = assertContainedRealPath(deps.fs, deps.workspaceRoot, lexical, "debug target");
    return buildFileTarget(fileId, hostPath, deps);
  } catch (error: unknown) {
    if (error instanceof DebugLaunchTargetError) throw error;
    throw new DebugLaunchTargetError("WORKSPACE_ESCAPE");
  }
}

function buildFileTarget(
  fileId: string,
  hostPath: string,
  deps: DebugLaunchCatalogDeps,
): Extract<DebugLaunchTarget, { readonly kind: "file" }> {
  const stat = deps.fs.stat(hostPath);
  const extensionAllowed = isSupportedNodeDebugExtension(extname(hostPath));
  if (!stat.isFile || !extensionAllowed) {
    throw new DebugLaunchTargetError("INVALID_TARGET");
  }
  if (stat.size > MAX_DEBUG_TARGET_BYTES) throw new DebugLaunchTargetError("INVALID_TARGET");
  const content = deps.fs.readFileUtf8(hostPath);
  if (Buffer.byteLength(content) !== stat.size) throw new DebugLaunchTargetError("INVALID_TARGET");
  const rel = relative(deps.fs.realPath(deps.workspaceRoot), hostPath);
  return Object.freeze({
    kind: "file",
    fileId,
    hostPath,
    capsulePath: `/keiko-execution-root/${rel.split(sep).join("/")}`,
    targetIdentityDigest: sha256Json([
      hostPath,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      createHash("sha256").update(content).digest("hex"),
    ]),
  });
}
