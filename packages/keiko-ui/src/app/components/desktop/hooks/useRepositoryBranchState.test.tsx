import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { useRepositoryBranchState } from "./useRepositoryBranchState";

const listBranches = vi.hoisted(() => vi.fn());
vi.mock("../widgets/cards/git-client/git-client-seam", () => ({
  DEFAULT_GIT_CLIENT: { listBranches },
}));
const reportClientDiagnostic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic }));
afterEach(() => vi.resetAllMocks());

// The server's read-surface refusal, exactly as the Files/Git routes answer it (files-deny.ts).
const DENIED = new ApiError("DENIED", "The requested path is excluded from the read surface.", 403);

// #3873 F1 (live Gemma qualification): a repository below a denied read-surface path read as "may
// not be a Git repository" while the Git window named the server's `DENIED` refusal. The read keeps
// that refusal apart from a folder Git cannot serve, and its diagnostic carries the closed kind.
it("names a read the server refused under its read-surface policy", async () => {
  listBranches.mockRejectedValueOnce(DENIED);
  const { result } = renderHook(useRepositoryBranchState, { initialProps: "/repository" });
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.denied).toBe(true);
  expect(reportClientDiagnostic).toHaveBeenCalledWith(
    expect.stringContaining("repository branch status failed"),
    expect.objectContaining({ errorKind: "authority-denied" }),
  );
});

it("keeps an ordinary failed read apart from a read-surface refusal", async () => {
  listBranches.mockRejectedValueOnce(new ApiError("INTERNAL", "Git status failed.", 500));
  const { result } = renderHook(useRepositoryBranchState, { initialProps: "/repository" });
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.denied).toBe(false);
  expect(reportClientDiagnostic).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ errorKind: "internal" }),
  );
});

it("drops a previous read-surface refusal once another repository is read", async () => {
  listBranches.mockRejectedValueOnce(DENIED);
  const { result, rerender } = renderHook(useRepositoryBranchState, { initialProps: "/first" });
  await waitFor(() => expect(result.current.denied).toBe(true));
  listBranches.mockResolvedValueOnce({ available: true, branches: [] });
  await act(async () => rerender("/second"));
  expect(result.current.denied).toBe(false);
});

it("marks the new repository loading in its first render before effects run", async () => {
  listBranches.mockResolvedValue({ available: true, branches: [{ name: "main", current: true }] });
  const renders: { loading: boolean; error: string | null; currentBranch: string | null }[] = [];
  const { result, rerender } = renderHook(
    ({ root }) => {
      const state = useRepositoryBranchState(root);
      renders.push(state);
      return state;
    },
    { initialProps: { root: "/first" } },
  );
  await waitFor(() => expect(result.current.currentBranch).toBe("main"));
  listBranches.mockReturnValue(new Promise(() => undefined));
  renders.length = 0;
  rerender({ root: "/second" });
  expect(renders[0]).toMatchObject({ loading: true, error: null, currentBranch: null });
});

it("clears a previous repository error while loading another repository", async () => {
  listBranches.mockRejectedValueOnce(new Error("unavailable"));
  const { result, rerender } = renderHook(useRepositoryBranchState, { initialProps: "/first" });
  await waitFor(() => expect(result.current.error).not.toBeNull());
  listBranches.mockResolvedValueOnce({ available: true, branches: [] });
  await act(async () => rerender("/second"));
  expect(result.current.error).toBeNull();
});

// Owner decision 2026-10-30: the Workbench works in any folder. A folder Git answers as
// `available: false` is an ordinary folder; a rejected, refused or still-loading read is not.
it("marks a root Git answers as not a repository as an ordinary folder", async () => {
  listBranches.mockResolvedValue({ available: false, state: "unavailable", branches: [] });
  const { result } = renderHook(useRepositoryBranchState, { initialProps: "/plain-folder" });
  expect(result.current.ordinaryFolder).toBe(false);
  await waitFor(() => expect(result.current.ordinaryFolder).toBe(true));
});

it.each(["rejected", "refused", "repository"] as const)(
  "never calls a %s read an ordinary folder",
  async (kind) => {
    if (kind === "rejected") listBranches.mockRejectedValue(new ApiError("INTERNAL", "x", 500));
    else if (kind === "refused") listBranches.mockRejectedValue(DENIED);
    else listBranches.mockResolvedValue({ available: true, branches: [] });
    const { result } = renderHook(useRepositoryBranchState, { initialProps: "/root" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ordinaryFolder).toBe(false);
  },
);
