import { useRef, type ReactElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePersistenceBoundary } from "./WorkspacePersistenceBoundary";
import { useWorkspace } from "./hooks/useWorkspace";

const STORAGE_ID = "a".repeat(64);

function Workspace(): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace(ref);
  return (
    <main ref={ref} data-testid="workspace">
      {workspace.wins?.map((item) => item.id).join(",")}
    </main>
  );
}

function renderWorkspace(): ReturnType<typeof render> {
  return render(
    <WorkspacePersistenceBoundary>
      <Workspace />
    </WorkspacePersistenceBoundary>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("workspace restoration boot boundary", () => {
  it.each([null, [], {}, { workspace: null }, { workspace: [] }])(
    "refuses a malformed ownership response: %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
      renderWorkspace();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    },
  );

  it("bounds a stalled startup and keeps the saved layout untouched", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    window.localStorage.setItem("keiko.workspace.v4", "[]");
    renderWorkspace();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("keiko.workspace.v4")).toBe("[]");
  });
  it("waits for the current data store before mounting or overwriting a saved layout", async () => {
    let complete: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const legacy = '[{"id":"former-chat","type":"chat","cfg":{"chatId":"former"}}]';
    window.localStorage.setItem("keiko.workspace.v4", legacy);
    renderWorkspace();
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("keiko.workspace.v4")).toBe(legacy);
    await act(async () => {
      complete?.(new Response(JSON.stringify({ workspace: { storageId: STORAGE_ID } })));
    });
    expect(await screen.findByTestId("workspace")).toBeEmptyDOMElement();
    expect(window.localStorage.getItem("keiko.workspace.v4")).toBe(legacy);
  });

  it.each([undefined, "", "../other-store", "a".repeat(65)])(
    "refuses an invalid storage identity: %s",
    async (storageId) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspace: { storageId } }))),
      );
      renderWorkspace();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Your workspace could not be opened",
      );
      expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    },
  );

  it("offers a retry after the local server becomes available", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ workspace: { storageId: STORAGE_ID } })),
        ),
    );
    renderWorkspace();
    await screen.findByRole("alert");
    act(() => screen.getByRole("button", { name: "Retry" }).click());
    expect(await screen.findByTestId("workspace")).toBeInTheDocument();
  });
});
