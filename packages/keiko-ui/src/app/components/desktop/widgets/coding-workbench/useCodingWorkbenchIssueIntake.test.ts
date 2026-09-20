import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-shared-primitives";
import { useCodingWorkbenchIssueIntake } from "./useCodingWorkbenchIssueIntake";

const preview = vi.hoisted(() => vi.fn());
const log = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ previewCodingWorkbenchIssue: preview }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: log }));
afterEach(() => vi.clearAllMocks());

function mount(
  scope = "task-one",
): RenderHookResult<
  ReturnType<typeof useCodingWorkbenchIssueIntake>,
  { root: string; task: string }
> {
  return renderHook(({ root, task }) => useCodingWorkbenchIssueIntake(root, task), {
    initialProps: { root: "/repo", task: scope },
  });
}

const response = {
  binding: { bindingDigest: "a".repeat(64), issueNumber: 13 },
  preview: { provenance: { ownerAndRepo: "acme/repo", issueNumber: 13 } },
};

describe("prompt-driven issue intake", () => {
  it("submits an ordinary prompt without an issue read", async () => {
    const { result } = mount();
    const start = vi.fn();
    await act(() => result.current.submit("Explain the README", start));
    expect(start).toHaveBeenCalledWith(undefined);
    expect(preview).not.toHaveBeenCalled();
  });

  it("resolves a pasted issue before starting with the server-owned digest", async () => {
    preview.mockResolvedValue(response);
    const { result } = mount();
    const start = vi.fn();
    await act(() =>
      result.current.submit("Implement https://github.com/acme/repo/issues/13", start),
    );
    expect(preview).toHaveBeenCalledWith(
      { repositoryPath: "/repo", issueRef: "https://github.com/acme/repo/issues/13" },
      expect.any(AbortSignal),
    );
    expect(start).toHaveBeenCalledWith({
      issueRef: "https://github.com/acme/repo/issues/13",
      expectedIssueBindingDigest: "a".repeat(64),
    });
    expect(log).toHaveBeenCalledWith("[keiko] coding workbench prompt issue resolved");
    expect(JSON.stringify(log.mock.calls)).not.toContain("acme/repo");
  });

  it.each([
    ["Implement #13", "#13"],
    [
      "Implement https://github.com/acme/repo/issues/13 and verify #13",
      "https://github.com/acme/repo/issues/13",
    ],
    ["Implement acme/repo#13", "https://github.com/acme/repo/issues/13"],
    [
      "[Issue](https://github.com/acme/repo/issues/13). See https://github.com/acme/repo/issues/13",
      "https://github.com/acme/repo/issues/13",
    ],
  ])("recognizes and deduplicates %s", async (prompt, issueRef) => {
    preview.mockResolvedValue(response);
    const { result } = mount();
    const start = vi.fn();
    await act(() => result.current.submit(prompt, start));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ issueRef }));
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ issueRef: prompt.includes("verify #13") ? "#13" : issueRef }),
      expect.any(AbortSignal),
    );
  });

  it("keeps equal issue numbers from different repositories distinct", async () => {
    preview.mockResolvedValue({
      ...response,
      preview: { provenance: { ownerAndRepo: "acme/current", issueNumber: 13 } },
    });
    const { result } = mount();
    const start = vi.fn();
    await act(() =>
      result.current.submit("Implement https://github.com/acme/other/issues/13 and #13", start),
    );
    expect(result.current.state).toMatchObject({ kind: "failed", failure: "multiple-issues" });
    expect(start).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("acme/");
  });

  it.each([
    [
      "Compare https://github.com/acme/repo/issues/1 and https://github.com/acme/repo/issues/2",
      "multiple-issues",
    ],
    ["Implement https://github.com/acme/repo/issues/13 and #14", "multiple-issues"],
    ["Implement #14 with acme/repo#13", "multiple-issues"],
    ["Implement https://github.com/acme/repo/pull/13", "invalid-reference"],
    ["Implement https://github.com/acme/repo/issues/0", "invalid-reference"],
  ])("does not guess a binding for %s", async (prompt, failure) => {
    const { result } = mount();
    const start = vi.fn();
    await act(() => result.current.submit(prompt, start));
    expect(result.current.state).toMatchObject({ kind: "failed", failure });
    expect(start).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([
    ["CODING_WORKBENCH_ISSUE_READ_TRANSIENT_FAILURE", "read-transient-failure"],
    ["UNKNOWN_REPOSITORY", "unknown-repository"],
    ["SOME_UNRELATED_CODE", "unknown"],
  ])("retains bounded failure classification for %s", async (code, failure) => {
    preview.mockRejectedValue(new ApiError(code, "private response body", 503));
    const { result } = mount();
    const start = vi.fn();
    await act(() => result.current.submit("Implement #13", start));
    expect(result.current.state).toMatchObject({ kind: "failed", failure });
    expect(start).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private response body");
  });

  it("abandons a read after a repository or task switch", async () => {
    let resolve!: (value: typeof response) => void;
    preview.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result, rerender } = mount();
    const start = vi.fn();
    let submitted!: Promise<void>;
    act(() => {
      submitted = result.current.submit("Implement #13", start);
    });
    rerender({ root: "/other", task: "task-two" });
    await act(async () => {
      resolve(response);
      await submitted;
    });
    expect(start).not.toHaveBeenCalled();
  });
});
