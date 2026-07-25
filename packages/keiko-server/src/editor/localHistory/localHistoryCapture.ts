import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type {
  EditorLocalHistoryOrigin,
  WorkspaceRootIdentityDigest,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../../deps.js";
import { emitServerDiagnostic } from "../../diagnostics-log.js";
import { WorkspaceManifestService } from "../../workspace-manifests.js";
import { inspectWorkspaceRootIdentity } from "../../workspace-root-identity.js";
import { EditorLocalHistoryError, editorLocalHistoryWorkspaceId } from "./localHistoryStore.js";

export interface EditorLocalHistoryResolvedRoot {
  readonly workspaceId: string;
  readonly rootRef: WorkspaceRootRef;
  readonly rootIdentityDigest: WorkspaceRootIdentityDigest;
  readonly realRoot: string;
}

function unavailableRoot(detail: string): never {
  throw new EditorLocalHistoryError(
    "INVALID_CAPTURE",
    "Local-history workspace is unavailable.",
    detail,
  );
}

export function resolveEditorLocalHistoryRoot(
  deps: Pick<UiHandlerDeps, "store">,
  realRootInput: string,
): EditorLocalHistoryResolvedRoot {
  let realRoot: string;
  let manifests: ReturnType<WorkspaceManifestService["list"]>;
  try {
    realRoot = realpathSync(realRootInput);
    manifests = new WorkspaceManifestService(deps.store).list();
  } catch {
    return unavailableRoot("ROOT_UNRESOLVED");
  }
  for (const manifest of manifests) {
    const root = manifest.roots.find((candidate): boolean => candidate.canonicalRoot === realRoot);
    if (root === undefined) continue;
    let inspected: ReturnType<typeof inspectWorkspaceRootIdentity>;
    try {
      inspected = inspectWorkspaceRootIdentity(realRoot);
    } catch {
      return unavailableRoot("IDENTITY_UNREADABLE");
    }
    if (inspected.rootRef !== root.rootRef || inspected.identityDigest !== root.identityDigest) {
      return unavailableRoot("IDENTITY_DRIFT");
    }
    // Membership still decides ACCESS — a root outside every manifest has no history surface. It
    // no longer decides IDENTITY: the history workspace is derived from the root, so joining or
    // leaving a multi-root workspace carries this root's checkpoints along instead of stranding
    // them under a manifest id the root no longer has (#2616).
    return {
      workspaceId: editorLocalHistoryWorkspaceId(root.rootRef),
      rootRef: root.rootRef,
      rootIdentityDigest: root.identityDigest,
      realRoot,
    };
  }
  return unavailableRoot("NOT_A_MEMBER");
}

function captureFailureCode(error: unknown): string {
  if (!(error instanceof EditorLocalHistoryError)) return "LOCAL_HISTORY_CAPTURE_FAILED";
  return error.detail === undefined
    ? `LOCAL_HISTORY_${error.code}`
    : `LOCAL_HISTORY_${error.code}_${error.detail}`;
}

export function emitEditorLocalHistoryCaptureFailure(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  origin: EditorLocalHistoryOrigin,
  error: unknown,
  nowMs = Date.now(),
): void {
  emitServerDiagnostic(deps.diagnostics, {
    correlationId: `local-history-${randomUUID()}`,
    timestamp: new Date(nowMs).toISOString(),
    operation: origin,
    source: "editor.local-history.capture",
    errorClass: "EditorLocalHistoryCaptureError",
    message: "Editor local-history capture failed.",
    code: captureFailureCode(error),
  });
}

export function captureEditorLocalHistorySafely(input: {
  readonly deps: Pick<UiHandlerDeps, "store" | "editorLocalHistoryStore" | "diagnostics">;
  readonly realRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly origin: EditorLocalHistoryOrigin;
  readonly nowMs?: number | undefined;
}): void {
  if (input.deps.editorLocalHistoryStore === undefined) return;
  try {
    const identity = resolveEditorLocalHistoryRoot(input.deps, input.realRoot);
    input.deps.editorLocalHistoryStore.capture({
      ...identity,
      relativePath: input.relativePath,
      absolutePath: input.absolutePath,
      content: input.content,
      origin: input.origin,
      nowMs: input.nowMs,
    });
  } catch (error) {
    emitEditorLocalHistoryCaptureFailure(input.deps, input.origin, error, input.nowMs);
  }
}
