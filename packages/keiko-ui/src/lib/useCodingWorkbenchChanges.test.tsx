import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitChangedFile,
  GitHistoryResponse,
  GitRepositoryDiffResponse,
  GitRepositoryStatusResponse,
} from "@oscharko-dev/keiko-contracts";

import {
  useCodingWorkbenchChanges,
  type CodingWorkbenchChangesClient,
  type UseCodingWorkbenchChangesInput,
} from "./useCodingWorkbenchChanges";

vi.mock("./coding-app-session-client", () => ({
  codingAppSessionPairingSettled: () => Promise.resolve(true),
}));

const ROOT = "/managed/repository/workspace";
const RUN = "run-2641";

function changedFile(index = 0): GitChangedFile {
  return {
    path: `src/file-${String(index).padStart(3, "0")}.ts`,
    indexStatus: " ",
    worktreeStatus: "M",
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
  };
}

function statusFixture(
  files: readonly GitChangedFile[] = [changedFile(), changedFile(1)],
  available = true,
): GitRepositoryStatusResponse {
  return {
    schemaVersion: "1",
    root: ROOT,
    state: available ? "available" : "unavailable",
    available,
    detached: false,
    clean: files.length === 0,
    stagedCount: files.filter((file) => file.staged).length,
    unstagedCount: files.filter((file) => file.unstaged).length,
    untrackedCount: files.filter((file) => file.untracked).length,
    conflictedCount: files.filter((file) => file.conflicted).length,
    changes: available ? files : [],
    truncated: false,
    maxChanges: 500,
  };
}

function historyFixture(shortSha = "aaaaaaaa", available = true): GitHistoryResponse {
  return {
    schemaVersion: "1",
    root: ROOT,
    state: available ? "available" : "unavailable",
    available,
    entries: available
      ? [
          {
            sha: shortSha.padEnd(40, "0"),
            shortSha,
            subject: "fixture",
            author: "Keiko",
            date: "2026-07-19T12:00:00.000Z",
            refs: ["HEAD -> task"],
            parentCount: 1,
            changedFileCount: 1,
          },
        ]
      : [],
    limit: 1,
    skip: 0,
    truncated: false,
  };
}

function diffFixture(path = changedFile().path, marker = "old"): GitRepositoryDiffResponse {
  return {
    schemaVersion: "1",
    root: ROOT,
    state: "available",
    available: true,
    path,
    scope: "all",
    diff: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      `-export const value = '${marker}';`,
      `+export const value = '${marker}-next';`,
      "",
    ].join("\n"),
    truncated: false,
    maxBytes: 131_072,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

interface MutableClient extends CodingWorkbenchChangesClient {
  readonly getStatus: ReturnType<typeof vi.fn<CodingWorkbenchChangesClient["getStatus"]>>;
  readonly getHistory: ReturnType<typeof vi.fn<CodingWorkbenchChangesClient["getHistory"]>>;
  readonly getDiff: ReturnType<typeof vi.fn<CodingWorkbenchChangesClient["getDiff"]>>;
}

function client(overrides: Partial<CodingWorkbenchChangesClient> = {}): MutableClient {
  const merged = {
    getStatus: vi.fn(async () => statusFixture()),
    getHistory: vi.fn(async () => historyFixture()),
    getDiff: vi.fn(async (_root: string, path: string) => diffFixture(path)),
    ...overrides,
  };
  return {
    getStatus: vi.fn(merged.getStatus),
    getHistory: vi.fn(merged.getHistory),
    getDiff: vi.fn(merged.getDiff),
  };
}

function baseInput(
  overrides: Partial<UseCodingWorkbenchChangesInput> = {},
): UseCodingWorkbenchChangesInput {
  return {
    root: ROOT,
    runId: RUN,
    changeSignal: null,
    bindingPending: false,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
}

describe("useCodingWorkbenchChanges", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("loads the run's status, history and initial diff of the first changed file", async () => {
    const stub = client();
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      {
        initialProps: { ...baseInput(), client: stub },
      },
    );
    await flush();

    expect(view.result.current.status).toBe("ready");
    expect(view.result.current.files).toHaveLength(2);
    expect(view.result.current.selectedPath).toBe("src/file-000.ts");
    expect(view.result.current.head).toBe("aaaaaaaa");
    expect(view.result.current.diffStatus).toBe("ready");
    expect(view.result.current.diff?.files).toHaveLength(1);
    expect(stub.getDiff).toHaveBeenCalledWith(ROOT, "src/file-000.ts");
  });

  // The regression this issue exists to fix: on every change signal the previous implementation
  // reset state to `{status: "loading", files: []}`, which unmounted the file list and diff pane
  // and destroyed keyboard focus. Stale-while-revalidate must keep the ready state visible.
  it("keeps ready state, files and the previously rendered diff across a change-signal refresh", async () => {
    vi.useFakeTimers();
    const statusGate = deferred<GitRepositoryStatusResponse>();
    const historyGate = deferred<GitHistoryResponse>();
    const diffGate = deferred<GitRepositoryDiffResponse>();
    const initialStatus = vi.fn(async () => statusFixture());
    const initialHistory = vi.fn(async () => historyFixture("aaaaaaaa"));
    const initialDiff = vi.fn(async (_root: string, path: string) => diffFixture(path, "first"));
    const stub = client({
      getStatus: initialStatus,
      getHistory: initialHistory,
      getDiff: initialDiff,
    });
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      { initialProps: { ...baseInput(), client: stub } },
    );
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(view.result.current.status).toBe("ready");
    expect(view.result.current.diff?.files[0]?.hunks[0]?.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "add" })]),
    );
    const firstDiff = view.result.current.diff;

    stub.getStatus.mockClear();
    stub.getHistory.mockClear();
    stub.getDiff.mockClear();
    stub.getStatus.mockImplementation(() => statusGate.promise);
    stub.getHistory.mockImplementation(() => historyGate.promise);
    stub.getDiff.mockImplementation(() => diffGate.promise);

    view.rerender({ ...baseInput({ changeSignal: "cursor-1" }), client: stub });
    await act(async () => vi.advanceTimersByTimeAsync(400));

    // Mid-refresh: the panel MUST still be "ready" with the previous files and diff visible.
    // A regression to the pre-fix "reset to loading" would flip status to "loading" and drop
    // both the files list and the diff pane.
    expect(view.result.current.status).toBe("ready");
    expect(view.result.current.files).toHaveLength(2);
    expect(view.result.current.diff).toBe(firstDiff);
    expect(view.result.current.diffStatus).toBe("ready");
    expect(stub.getStatus).toHaveBeenCalledTimes(1);
    expect(stub.getDiff).toHaveBeenCalledTimes(1);

    await act(async () => {
      statusGate.resolve(statusFixture());
      historyGate.resolve(historyFixture("bbbbbbbb"));
      diffGate.resolve(diffFixture("src/file-000.ts", "second"));
      await Promise.resolve();
    });
    await flush();

    expect(view.result.current.status).toBe("ready");
    expect(view.result.current.head).toBe("bbbbbbbb");
    expect(view.result.current.selectedPath).toBe("src/file-000.ts");
    expect(view.result.current.diffStatus).toBe("ready");
    expect(view.result.current.diff).not.toBe(firstDiff);
  });

  it("does not re-emit a loading status while a change signal is in flight", async () => {
    vi.useFakeTimers();
    const statusGate = deferred<GitRepositoryStatusResponse>();
    const stub = client();
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      { initialProps: { ...baseInput(), client: stub } },
    );
    await flush();
    expect(view.result.current.status).toBe("ready");

    const seenStatuses: string[] = [];
    const dispose = { unsubscribed: false };
    const track = (): void => {
      if (dispose.unsubscribed) return;
      seenStatuses.push(view.result.current.status);
    };
    track();

    stub.getStatus.mockImplementation(() => statusGate.promise);
    view.rerender({ ...baseInput({ changeSignal: "cursor-1" }), client: stub });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    track();

    expect(seenStatuses).not.toContain("loading");

    dispose.unsubscribed = true;
    await act(async () => {
      statusGate.resolve(statusFixture());
      await Promise.resolve();
    });
  });

  it("selects the fallback file and clears the diff when the previously selected file is removed", async () => {
    vi.useFakeTimers();
    const stub = client();
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      { initialProps: { ...baseInput(), client: stub } },
    );
    await flush();
    expect(view.result.current.selectedPath).toBe("src/file-000.ts");

    stub.getStatus.mockImplementation(async () => statusFixture([changedFile(1)]));
    view.rerender({ ...baseInput({ changeSignal: "cursor-1" }), client: stub });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await flush();

    expect(view.result.current.selectedPath).toBe("src/file-001.ts");
    expect(view.result.current.diffStatus).toBe("ready");
    expect(view.result.current.diff?.files[0]?.path).toBe("src/file-001.ts");
  });

  it("empties the view honestly when the run binding is lost after a ready state", async () => {
    const stub = client();
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      { initialProps: { ...baseInput(), client: stub } },
    );
    await flush();
    expect(view.result.current.status).toBe("ready");

    view.rerender({ ...baseInput({ root: "/managed/other" }), client: stub });
    expect(view.result.current.status).toBe("binding-lost");
    expect(view.result.current.files).toHaveLength(0);
    expect(view.result.current.diff).toBeNull();
  });

  it("switches to error status and blanks state when the refresh fetch rejects", async () => {
    vi.useFakeTimers();
    const stub = client();
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      { initialProps: { ...baseInput(), client: stub } },
    );
    await flush();
    expect(view.result.current.status).toBe("ready");

    stub.getStatus.mockImplementation(() => Promise.reject(new Error("bounded transport failure")));
    view.rerender({ ...baseInput({ changeSignal: "cursor-1" }), client: stub });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await flush();

    expect(view.result.current.status).toBe("error");
    expect(view.result.current.files).toHaveLength(0);
    expect(view.result.current.diff).toBeNull();
  });

  it("selectPath switches to a loading diff for the new file, then renders it", async () => {
    const stub = client();
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      { initialProps: { ...baseInput(), client: stub } },
    );
    await flush();

    act(() => view.result.current.selectPath("src/file-001.ts"));
    expect(view.result.current.selectedPath).toBe("src/file-001.ts");
    await flush();
    expect(view.result.current.diff?.files[0]?.path).toBe("src/file-001.ts");
  });

  // Cross-run isolation: the stale-while-revalidate merge preserves the diff only WITHIN a run.
  // If runId changes while the same path is selected, the previous run's diff must not carry
  // over even for a single render — captioning run B's changes panel with run A's diff would
  // be a factual mislabel of what the run produced.
  it("does not carry the previous run's diff over when runId changes", async () => {
    const stub = client();
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      { initialProps: { ...baseInput(), client: stub } },
    );
    await flush();
    expect(view.result.current.status).toBe("ready");
    expect(view.result.current.diff).not.toBeNull();

    view.rerender({ ...baseInput({ runId: "run-2641-other" }), client: stub });
    expect(view.result.current.diff).toBeNull();
    expect(view.result.current.files).toHaveLength(0);
    expect(view.result.current.selectedPath).toBeNull();
    expect(view.result.current.status).toBe("loading");
    await flush();
    expect(view.result.current.status).toBe("ready");
  });

  // A same-file refresh AFTER a failed diff must keep diffStatus non-idle across the merge so
  // the retry surfaces the error state cleanly; useSelectedDiff's own loading guard then
  // self-corrects on the next successful fetch.
  it("preserves the failed diff status across a same-selection refresh, then recovers", async () => {
    vi.useFakeTimers();
    const stub = client();
    stub.getDiff.mockRejectedValueOnce(new Error("bounded diff transport failure"));
    const view = renderHook(
      (input: UseCodingWorkbenchChangesInput) => useCodingWorkbenchChanges(input),
      { initialProps: { ...baseInput(), client: stub } },
    );
    await flush();
    expect(view.result.current.diffStatus).toBe("error");
    expect(view.result.current.diff).toBeNull();

    // Refresh without changing selection — diff error state persists through the merge (still
    // "error" or, after useSelectedDiff kicks in, "loading" while it re-fetches).
    view.rerender({ ...baseInput({ changeSignal: "cursor-1" }), client: stub });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await flush();

    // The next successful diff fetch recovers.
    expect(view.result.current.diffStatus).toBe("ready");
    expect(view.result.current.diff?.files[0]?.path).toBe("src/file-000.ts");
  });
});
