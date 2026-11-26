import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { useChatMarkdownSkill } from "./useChatMarkdownSkill";

const approvals = vi.hoisted(() => {
  let finishLoad = (): void => undefined;
  const loading = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });
  return { loadCount: 0, delayLoad: false, loading, finishLoad, inspect: vi.fn() };
});
const skills = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/lib/browser-approval-api", async () => {
  approvals.loadCount += 1;
  if (approvals.delayLoad) await approvals.loading;
  return { inspectBrowserApprovals: approvals.inspect };
});
vi.mock("@/lib/markdown-skills-api", () => ({ fetchMarkdownSkillSelection: skills.read }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
vi.mock("@/lib/coding-app-session-client", () => ({
  useCodingAppSessionRedemptions: (): number => 0,
}));

afterEach(cleanup);

it("loads browser approval validation only after a concealed private skill read", async () => {
  // This observes module evaluation, not just whether its HTTP function was called.
  expect(approvals.loadCount).toBe(0);
  const empty = { availability: "none", selection: { revision: 0, skill: null } };
  skills.read.mockResolvedValueOnce(empty);
  const hook = renderHook(({ chatId }) => useChatMarkdownSkill(chatId), {
    initialProps: { chatId: "synthetic-chat" },
  });
  await waitFor(() => expect(hook.result.current.view).toEqual(empty));
  expect(approvals.loadCount).toBe(0);

  skills.read.mockRejectedValueOnce(new ApiError("UNAVAILABLE", "Unavailable", 503));
  await act(async () => hook.result.current.refresh());
  expect(hook.result.current.failed).toBe(true);
  expect(approvals.loadCount).toBe(0);

  approvals.delayLoad = true;
  skills.read.mockRejectedValueOnce(new ApiError("NOT_FOUND", "Not found", 404));
  let firstRefresh: Promise<void> | undefined;
  act(() => {
    firstRefresh = hook.result.current.refresh();
  });
  await waitFor(() => expect(approvals.loadCount).toBe(1));
  expect(hook.result.current.failed).toBe(true);
  expect(hook.result.current.view).toEqual(empty);
  skills.read.mockResolvedValueOnce(empty);
  hook.rerender({ chatId: "replacement-chat" });
  await waitFor(() => expect(hook.result.current.view).toEqual(empty));
  await act(async () => {
    approvals.finishLoad();
    await firstRefresh;
  });
  expect(approvals.inspect).not.toHaveBeenCalled();
  expect(hook.result.current.failed).toBe(false);
  expect(hook.result.current.connectionRequired).toBe(false);

  skills.read.mockRejectedValueOnce(new ApiError("NOT_FOUND", "Not found", 404));
  approvals.inspect.mockResolvedValueOnce({ state: "unavailable" });
  await act(async () => hook.result.current.refresh());
  expect(approvals.loadCount).toBe(1);
  expect(approvals.inspect).toHaveBeenCalledOnce();
  expect(hook.result.current.view).toEqual(empty);
  expect(hook.result.current.connectionRequired).toBe(true);
});

// #4492 review: Enter waits while the selection loads, so a failed first read must end the loading
// state, or the person would wait on "Loading skills…" for a read that already failed.
it("ends the loading state when the first selection read fails", async () => {
  skills.read.mockRejectedValueOnce(new ApiError("UNAVAILABLE", "Unavailable", 503));
  const hook = renderHook(() => useChatMarkdownSkill("failed-first-read"));
  expect(hook.result.current.busy).toBe(true);
  await waitFor(() => expect(hook.result.current.failed).toBe(true));
  expect(hook.result.current.busy).toBe(false);
  expect(hook.result.current.view).toBeUndefined();
});
