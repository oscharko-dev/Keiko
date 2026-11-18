import type {
  KnowledgeCitationEditorTargetRequest,
  KnowledgeCitationEditorTargetResponse,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { FilesError, readFilesContent, resolveRequestRoot } from "./files.js";
import { openStoreForDeps } from "./local-knowledge-grounded-qa.js";
import {
  selectKnowledgeCitationForEditor,
  resolveKnowledgeCitationEditorSource,
} from "./local-knowledge-preview-service.js";
import {
  verifyKnowledgeCitationEditorSourceBytes,
  knowledgeCitationEditorSourceIsCurrent,
  type KnowledgeCitationEditorSource,
} from "./local-knowledge-preview-delivery.js";
import type { RouteContext } from "./routes.js";

function currentSource(
  deps: UiHandlerDeps,
  input: KnowledgeCitationEditorTargetRequest,
): KnowledgeCitationEditorSource {
  const selected = selectKnowledgeCitationForEditor(deps, input);
  if (selected.kind !== "selected") return selected;
  const session = openStoreForDeps(deps);
  try {
    return resolveKnowledgeCitationEditorSource(session.store, selected.citation);
  } finally {
    session.close();
  }
}

function sameTarget(
  first: { readonly root: string; readonly path: string },
  second: { readonly root: string; readonly path: string },
): boolean {
  return first.root === second.root && first.path === second.path;
}

function sameVerifiedSource(
  current: Extract<KnowledgeCitationEditorSource, { kind: "ok" }>,
  source: Extract<KnowledgeCitationEditorSource, { kind: "ok" }>,
): boolean {
  return (
    sameTarget(current, source) &&
    current.contentHash === source.contentHash &&
    knowledgeCitationEditorSourceIsCurrent(source)
  );
}

export async function resolveKnowledgeCitationEditorTarget(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  input: KnowledgeCitationEditorTargetRequest,
): Promise<KnowledgeCitationEditorTargetResponse> {
  const source = currentSource(deps, input);
  if (source.kind !== "ok") return { outcome: "rejected", reason: source.reason };
  try {
    const root = await resolveRequestRoot(ctx, deps, source.root);
    // The ordinary Editor owns editable UTF-8, byte limits, descriptor-safe reads, denied
    // paths and managed-root session authority. A citation grants none of their exceptions.
    const content = await readFilesContent(
      deps.store,
      source.root,
      source.path,
      deps.redactor,
      root,
    );
    if (content.symlink || !sameTarget(content, source)) {
      return { outcome: "rejected", reason: "editor-read-refused" };
    }
    if (!(await verifyKnowledgeCitationEditorSourceBytes(source))) {
      return { outcome: "rejected", reason: "source-modified" };
    }
    await resolveRequestRoot(ctx, deps, source.root);
    // Reads await: source rebind/removal, message deletion or conflicting stored provenance
    // must not outlive the current click. There is no cached grant or citation session.
    const current = currentSource(deps, input);
    if (current.kind !== "ok") return { outcome: "rejected", reason: current.reason };
    if (!sameVerifiedSource(current, source)) {
      return { outcome: "rejected", reason: "source-modified" };
    }
    return { outcome: "authorized", target: { root: content.root, path: content.path } };
  } catch (error) {
    if (!(error instanceof FilesError)) throw error;
    return { outcome: "rejected", reason: "editor-read-refused" };
  }
}
