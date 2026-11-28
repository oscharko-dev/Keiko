import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGitBranches, fetchGitStatus, fetchGitSummary } from "./api";

afterEach(() => vi.unstubAllGlobals());

// A caller that gives up on a read (a timed-out probe, a superseded refresh) aborts it. Every read
// of the repository forwards the option, not only the status read, so the request itself ends.
describe("repository read abort signal", () => {
  const reads: ReadonlyArray<readonly [string, (signal: AbortSignal) => Promise<unknown>]> = [
    ["status", (signal): Promise<unknown> => fetchGitStatus("/repo", { signal })],
    ["branches", (signal): Promise<unknown> => fetchGitBranches("/repo", { signal })],
    ["summary", (signal): Promise<unknown> => fetchGitSummary("/repo", { signal })],
  ];

  it.each(reads)("ends the %s request when the caller aborts", async (_name, read) => {
    const fetchMock = vi.fn((_path: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const settled = expect(read(controller.signal)).rejects.toBeDefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await settled;
  });
});
