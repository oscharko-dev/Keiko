export const EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT =
  "keiko:editor-buffer-reconciliation-request";

export interface EditorBufferReconciliationRequestDetail {
  readonly root: string;
  readonly register: (reconciliation: Promise<void>) => void;
}

export function editorBufferReconciliationRequestDetail(
  event: Event,
): EditorBufferReconciliationRequestDetail | null {
  if (
    !(event instanceof CustomEvent) ||
    typeof event.detail !== "object" ||
    event.detail === null
  ) {
    return null;
  }
  const detail = event.detail as Record<string, unknown>;
  return typeof detail.root === "string" &&
    detail.root.length > 0 &&
    typeof detail.register === "function"
    ? {
        root: detail.root,
        register: detail.register as (reconciliation: Promise<void>) => void,
      }
    : null;
}

export async function requestEditorBufferReconciliation(root: string): Promise<void> {
  const reconciliations: Promise<void>[] = [];
  window.dispatchEvent(
    new CustomEvent<EditorBufferReconciliationRequestDetail>(
      EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT,
      {
        detail: {
          root,
          register: (reconciliation): void => {
            reconciliations.push(reconciliation);
          },
        },
      },
    ),
  );
  await Promise.all(reconciliations);
}
