import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT,
  editorBufferReconciliationRequestDetail,
  requestEditorBufferReconciliation,
} from "./editor-buffer-reconciliation-events";

describe("editor buffer reconciliation events", () => {
  it("awaits every registered editor reconciliation without carrying file contents", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const listener = (event: Event): void => {
      const detail = editorBufferReconciliationRequestDetail(event);
      expect(detail?.root).toBe("/repo");
      detail?.register(first());
      detail?.register(second());
    };
    window.addEventListener(EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT, listener);
    await requestEditorBufferReconciliation("/repo");
    window.removeEventListener(EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT, listener);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("fails when a registered editor cannot reconcile and ignores malformed events", async () => {
    expect(editorBufferReconciliationRequestDetail(new CustomEvent("x"))).toBeNull();
    const listener = (event: Event): void => {
      editorBufferReconciliationRequestDetail(event)?.register(Promise.reject(new Error("failed")));
    };
    window.addEventListener(EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT, listener);
    await expect(requestEditorBufferReconciliation("/repo")).rejects.toThrow("failed");
    window.removeEventListener(EDITOR_BUFFER_RECONCILIATION_REQUEST_EVENT, listener);
  });
});
