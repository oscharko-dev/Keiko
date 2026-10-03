import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorProjectConnection } from "./useEditorProjectConnection";

const createProject = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  createProject,
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: report }));

function response(): Record<string, unknown> {
  return { project: { path: "/next", workspaceAvailable: true } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("editor project connection", () => {
  it("passes a registered project's warning and Support ID to the applied root", async () => {
    createProject.mockResolvedValue({
      ...response(),
      warning: {
        code: "PROJECT_TRUST_GRANT_FAILED",
        message: "Project remains restricted.",
        correlationId: "server-warning-123",
      },
    });
    const ready = vi.fn();
    const notice = vi.fn();
    const view = renderHook(() => useEditorProjectConnection({ root: "/repo", onNotice: notice }));
    await act(async () => {
      await view.result.current("/next", ready);
    });
    expect(ready).toHaveBeenCalledWith(
      "/next",
      expect.any(String),
      "Project remains restricted. Support ID: server-warning-123",
      "server-warning-123",
    );
  });

  it("releases busy state when a hidden/root-changed effect cancels the connection", async () => {
    let release: (value: unknown) => void = () => undefined;
    createProject.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const busy = vi.fn();
    const ready = vi.fn();
    const notice = vi.fn();
    const view = renderHook(
      ({ root }) => useEditorProjectConnection({ root, onNotice: notice, onBusy: busy }),
      {
        initialProps: { root: "/repo" },
      },
    );
    let task = Promise.resolve();
    act(() => {
      task = view.result.current("/next", ready);
    });
    view.rerender({ root: "/different" });
    expect(busy).toHaveBeenLastCalledWith(false);
    await act(async () => {
      release(response());
      await task;
    });
    expect(ready).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      "Workspace navigation settled",
      expect.objectContaining({
        stageReport: expect.objectContaining({ navigationOutcome: "cancelled" }),
      }),
    );
  });

  it("records a concurrent selection as dropped without another project mutation", async () => {
    createProject.mockReturnValue(new Promise(() => undefined));
    const notice = vi.fn();
    const view = renderHook(() => useEditorProjectConnection({ root: "/repo", onNotice: notice }));
    act(() => {
      void view.result.current("/next", vi.fn());
    });
    await act(async () => {
      await view.result.current("/another", vi.fn());
    });
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      "Workspace navigation settled",
      expect.objectContaining({
        stageReport: expect.objectContaining({ navigationOutcome: "dropped" }),
      }),
    );
  });
});
