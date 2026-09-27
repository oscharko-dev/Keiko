import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRepositoryBranchState } from "./useRepositoryBranchState";

const listBranches = vi.hoisted(() => vi.fn());
vi.mock("../widgets/cards/git-client/git-client-seam", () => ({
  DEFAULT_GIT_CLIENT: { listBranches },
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
afterEach(() => vi.resetAllMocks());

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
