export const WORKSPACE_FILE_MUTATED_EVENT = "keiko:workspace-file-mutated";

export interface WorkspaceFileMutationDetail {
  readonly root: string;
  readonly relativePath?: string | undefined;
  readonly kind?: string | undefined;
  readonly sequence?: number | undefined;
  readonly provenance?: "local" | "watch" | "agent" | undefined;
}

export function notifyWorkspaceFileMutated(
  root: string,
  detail: Omit<WorkspaceFileMutationDetail, "root"> = {},
): void {
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_FILE_MUTATED_EVENT, {
      detail: { root, ...detail },
    }),
  );
}

export function workspaceFileMutationDetail(event: Event): WorkspaceFileMutationDetail | null {
  if (
    !(event instanceof CustomEvent) ||
    typeof event.detail !== "object" ||
    event.detail === null
  ) {
    return null;
  }
  const detail = event.detail as Record<string, unknown>;
  const root = detail.root;
  if (typeof root !== "string" || root.length === 0) return null;
  return {
    root,
    ...(typeof detail.relativePath === "string" ? { relativePath: detail.relativePath } : {}),
    ...(typeof detail.kind === "string" ? { kind: detail.kind } : {}),
    ...(typeof detail.sequence === "number" && Number.isSafeInteger(detail.sequence)
      ? { sequence: detail.sequence }
      : {}),
    ...(detail.provenance === "local" ||
    detail.provenance === "watch" ||
    detail.provenance === "agent"
      ? { provenance: detail.provenance }
      : {}),
  };
}

export function workspaceFileMutationRoot(event: Event): string | null {
  return workspaceFileMutationDetail(event)?.root ?? null;
}
