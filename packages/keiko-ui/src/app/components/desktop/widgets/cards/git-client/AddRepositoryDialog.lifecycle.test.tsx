import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { DEFAULT_GIT_CLIENT, type GitClientSeam } from "./git-client-seam";

const PROJECT = {
  path: "/repos/alpha",
  name: "alpha",
  favorite: false,
  createdAt: 0,
  lastOpenedAt: 0,
  available: true,
  workspaceAvailable: true,
};

type AddMode = "open" | "clone";

function pendingProject(): {
  promise: Promise<{ project: typeof PROJECT }>;
  resolve: (value: { project: typeof PROJECT }) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: { project: typeof PROJECT }) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{ project: typeof PROJECT }>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function submitRepository(mode: AddMode): void {
  if (mode === "open") {
    fireEvent.change(screen.getByLabelText("Local repository path"), {
      target: { value: PROJECT.path },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
    return;
  }
  fireEvent.change(screen.getByLabelText("Repository URL"), {
    target: { value: "https://example.test/private/repo.git" },
  });
  fireEvent.change(screen.getByLabelText("Clone to folder"), {
    target: { value: PROJECT.path },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Clone repository" }).at(-1)!);
}

function renderDialog(
  mode: AddMode,
  client: GitClientSeam,
): {
  onAdded: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  unmount: () => void;
} {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <StrictMode>
      <AddRepositoryDialog client={client} initialMode={mode} onAdded={onAdded} onClose={onClose} />
    </StrictMode>,
  );
  return { onAdded, onClose, unmount: view.unmount };
}

afterEach(resetClientDiagnosticWriter);

describe.each<AddMode>(["open", "clone"])("AddRepositoryDialog lifecycle: %s", (mode) => {
  it("applies a successful response after StrictMode replays the mount effect", async () => {
    const diagnostic = vi.fn<(message: string, meta?: ClientDiagnosticMeta) => void>();
    setClientDiagnosticWriter(diagnostic);
    const pending = pendingProject();
    const request = vi.fn(() => pending.promise);
    const view = renderDialog(mode, {
      ...DEFAULT_GIT_CLIENT,
      registerRepository: request,
      cloneRepository: request,
    });
    submitRepository(mode);
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    await act(async () => pending.resolve({ project: PROJECT }));
    expect(view.onAdded).toHaveBeenCalledExactlyOnceWith(PROJECT);
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Adding…" })).not.toBeInTheDocument();
    const correlationId = diagnostic.mock.calls[0]?.[1]?.correlationId;
    expect(correlationId).toEqual(expect.any(String));
    expect(request).toHaveBeenCalledWith(expect.any(Object), correlationId);
    expect(diagnostic.mock.calls.map((call) => call[1]?.gitClientOperation?.outcome)).toEqual([
      "started",
      "succeeded",
    ]);
    expect(diagnostic.mock.calls[1]?.[1]?.correlationId).toBe(correlationId);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(PROJECT.path);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("example.test");
    expect(diagnostic).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        gitClientOperation: expect.objectContaining({ outcome: "discarded-succeeded" }),
      }),
    );
  });

  it("shows a rejected response and permits retry after StrictMode replays the mount effect", async () => {
    const diagnostic = vi.fn<(message: string, meta?: ClientDiagnosticMeta) => void>();
    setClientDiagnosticWriter(diagnostic);
    const pending = pendingProject();
    const request = vi.fn(() => pending.promise);
    const view = renderDialog(mode, {
      ...DEFAULT_GIT_CLIENT,
      registerRepository: request,
      cloneRepository: request,
    });
    submitRepository(mode);
    await act(async () => pending.reject(new ApiError("INTERNAL", "Registration failed", 500)));
    expect(screen.getByRole("alert")).toHaveTextContent("Registration failed");
    expect(screen.queryByRole("button", { name: "Adding…" })).not.toBeInTheDocument();
    expect(view.onAdded).not.toHaveBeenCalled();
    expect(view.onClose).not.toHaveBeenCalled();
    expect(diagnostic.mock.calls[1]?.[1]).toMatchObject({
      correlationId: diagnostic.mock.calls[0]?.[1]?.correlationId,
      gitClientOperation: { outcome: "failed" },
      errorKind: "internal",
      errorEvidence: { errorClass: "ApiError" },
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("Registration failed");
    request.mockResolvedValueOnce({ project: PROJECT });
    await act(async () => submitRepository(mode));
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.onAdded).toHaveBeenCalledExactlyOnceWith(PROJECT);
  });

  it("still discards a successful response after a real unmount", async () => {
    const diagnostic = vi.fn();
    setClientDiagnosticWriter(diagnostic);
    const pending = pendingProject();
    const request = vi.fn(() => pending.promise);
    const view = renderDialog(mode, {
      ...DEFAULT_GIT_CLIENT,
      registerRepository: request,
      cloneRepository: request,
    });
    submitRepository(mode);
    view.unmount();
    await act(async () => pending.resolve({ project: PROJECT }));
    expect(view.onAdded).not.toHaveBeenCalled();
    expect(view.onClose).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        gitClientOperation: {
          operation: mode === "open" ? "repository-register" : "repository-clone",
          outcome: "discarded-succeeded",
        },
      }),
    );
  });
});
