import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "./types.js";
import { CommandCancelledError, CommandDeniedError, CommandTimeoutError } from "./errors.js";
import {
  classifyGitProviderReadFailure,
  readGitProviderPages,
} from "./git-provider-observation.js";

function response(value: unknown, extra: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "gh",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: "",
    durationMs: 0,
    timedOut: false,
    truncated: false,
    ...extra,
  };
}

describe("governed provider read failures", () => {
  it.each([
    ["gh: API rate limit exceeded (HTTP 403)", "rate-limited"],
    ["gh: secondary rate limit (HTTP 403)", "rate-limited"],
    ["gh: request failed (HTTP 429)", "rate-limited"],
    ["gh: forbidden (HTTP 403)", "provider-forbidden"],
    ["gh: not found (HTTP 404)", "provider-not-found"],
    ["gh: unauthorized (HTTP 401)", "auth-required"],
    ["gh: upstream failed (HTTP 503)", "provider-unavailable"],
  ])("classifies actual provider response %s as %s", (stderr, reason) => {
    expect(classifyGitProviderReadFailure(response(null, { exitCode: 1, stderr }))).toMatchObject({
      reason,
    });
  });
  it("never interprets local error prose as an actual provider status", () => {
    expect(classifyGitProviderReadFailure(new CommandDeniedError("HTTP 403", "gh"))).toEqual({
      reason: "authority-denied",
      state: "blocked",
    });
    expect(classifyGitProviderReadFailure(new Error("HTTP 403 rate limit"))).toMatchObject({
      reason: "provider-unavailable",
    });
    expect(classifyGitProviderReadFailure(new CommandCancelledError("stopped"))).toMatchObject({
      reason: "cancelled",
    });
    expect(classifyGitProviderReadFailure(new CommandTimeoutError("deadline", 1))).toMatchObject({
      reason: "timeout",
    });
  });
  it("treats truncated successful JSON and terminated processes as incomplete", () => {
    expect(classifyGitProviderReadFailure(response([], { truncated: true }))).toMatchObject({
      reason: "output-truncated",
    });
    expect(classifyGitProviderReadFailure(response([], { timedOut: true }))).toMatchObject({
      reason: "timeout",
    });
    expect(classifyGitProviderReadFailure(response([], { signal: "SIGTERM" }))).toMatchObject({
      reason: "provider-unavailable",
    });
    expect(classifyGitProviderReadFailure(response([]))).toBeUndefined();
  });
});

describe("explicit finite provider pagination", () => {
  it("does not return a completed read after cancellation during the last provider call", async () => {
    const controller = new AbortController();
    const result = await readGitProviderPages({
      run: () => {
        controller.abort();
        return Promise.resolve(response([]));
      },
      argv: () => [],
      pageSize: 2,
      maxPages: 2,
      maxBytes: 100,
      signal: controller.signal,
    });
    expect(result.completeness).toMatchObject({
      complete: false,
      failure: { reason: "cancelled" },
    });
  });
  it("captures finite bounds before any asynchronous provider call", async () => {
    const input = {
      run: (): Promise<CommandResult> => {
        input.maxPages = 5;
        return Promise.resolve(response([1, 2]));
      },
      argv: (): readonly string[] => [],
      pageSize: 2,
      maxPages: 1,
      maxBytes: 100,
    };
    const result = await readGitProviderPages(input);
    expect(result.completeness.pages).toBe(1);
  });
  it("reads the next page explicitly and retains a positive completeness fact", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(response([1, 2]))
      .mockResolvedValueOnce(response([3]));
    const result = await readGitProviderPages({
      run,
      argv: (page) => [String(page)],
      pageSize: 2,
      maxPages: 2,
      maxBytes: 100,
    });
    expect(result).toMatchObject({
      values: [1, 2, 3],
      completeness: { complete: true, pages: 2, entries: 3 },
    });
    expect(run.mock.calls).toEqual([[["1"]], [["2"]]]);
  });
  it("does not call a full final page complete just because its JSON is valid", async () => {
    const result = await readGitProviderPages({
      run: () => Promise.resolve(response([1, 2])),
      argv: () => [],
      pageSize: 2,
      maxPages: 1,
      maxBytes: 100,
    });
    expect(result.completeness).toMatchObject({
      complete: false,
      failure: { reason: "pagination-exhausted", state: "unknown" },
    });
  });
  it("uses total_count when provided and rejects changing or impossible counts", async () => {
    for (const second of [
      { total: 2, values: [3] },
      { total: 4, values: [] },
    ]) {
      const run = vi
        .fn()
        .mockResolvedValueOnce(response({ total: 3, values: [1, 2] }))
        .mockResolvedValueOnce(response(second));
      const result = await readGitProviderPages({
        run,
        argv: () => [],
        pageSize: 2,
        maxPages: 2,
        maxBytes: 100,
        counted: true,
      });
      expect(result.completeness).toMatchObject({
        complete: false,
        failure: { reason: "revision-changed" },
      });
    }
    const result = await readGitProviderPages({
      run: () => Promise.resolve(response({ total: 2, values: [1, 2] })),
      argv: () => [],
      pageSize: 2,
      maxPages: 1,
      maxBytes: 100,
      counted: true,
    });
    expect(result.completeness.complete).toBe(true);
  });
  it("carries partial counts but cannot bless malformed, truncated or oversized pages", async () => {
    for (const page of [
      response([1], { truncated: true }),
      response({}, { stdout: "{" }),
      response({ values: [], total: -1 }),
      response([1, 2, 3]),
      response(["x".repeat(101)]),
    ]) {
      const result = await readGitProviderPages({
        run: () => Promise.resolve(page),
        argv: () => [],
        pageSize: 2,
        maxPages: 2,
        maxBytes: 100,
      });
      expect(result.completeness.complete).toBe(false);
    }
  });
  it("rejects invalid bounds and cancelled observations before provider IO", async () => {
    const run = vi.fn();
    for (const bounds of [{ maxPages: 0 }, { pageSize: 101 }, { maxBytes: Infinity }]) {
      const result = await readGitProviderPages({
        run,
        argv: () => [],
        maxPages: 2,
        pageSize: 2,
        maxBytes: 100,
        ...bounds,
      });
      expect(result.completeness).toMatchObject({ failure: { reason: "invalid-binding" } });
    }
    const result = await readGitProviderPages({
      run,
      argv: () => [],
      pageSize: 2,
      maxPages: 2,
      maxBytes: 100,
      signal: AbortSignal.abort(),
    });
    expect(result.completeness).toMatchObject({ failure: { reason: "cancelled" } });
    expect(run).not.toHaveBeenCalled();
  });
});
