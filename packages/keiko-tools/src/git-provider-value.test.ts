import { describe, expect, it, vi } from "vitest";
import { readGitProviderValue } from "./git-provider-value.js";
import type { CommandResult } from "./types.js";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "gh",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "{}",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}
describe("single provider metadata projections", () => {
  it("retains the original cancellation signal across a caller mutation", async () => {
    const controller = new AbortController();
    const input = {
      argv: ["read"],
      signal: controller.signal,
      run: (): Promise<CommandResult> => {
        controller.abort();
        input.signal = new AbortController().signal;
        return Promise.resolve(result());
      },
    };
    expect(await readGitProviderValue(input)).toMatchObject({
      status: "unavailable",
      failure: { reason: "cancelled" },
    });
  });
  it("passes an immutable argument capture to the existing runner", async () => {
    const args = ["read"];
    const run = vi.fn((captured: readonly string[]): Promise<CommandResult> => {
      args[0] = "changed";
      expect(captured).toEqual(["read"]);
      expect(Object.isFrozen(captured)).toBe(true);
      return Promise.resolve(result());
    });
    expect(await readGitProviderValue({ argv: args, run })).toEqual({
      status: "observed",
      value: {},
    });
  });
  it.each([
    [{ stdout: "{" }, "malformed-response"],
    [{ stdout: "x".repeat(262_145) }, "output-truncated"],
    [{ stderr: "x".repeat(262_145) }, "output-truncated"],
    [{ exitCode: 1, stderr: "HTTP 403" }, "provider-forbidden"],
    [{ timedOut: true }, "timeout"],
    [{ truncated: true }, "output-truncated"],
  ] as const)("keeps malformed/incomplete response unavailable %#", async (overrides, reason) => {
    expect(
      await readGitProviderValue({ argv: [], run: () => Promise.resolve(result(overrides)) }),
    ).toMatchObject({
      status: "unavailable",
      failure: { reason },
    });
  });
  it("classifies thrown transport errors without leaking their message", async () => {
    const run = (): Promise<CommandResult> => Promise.reject(new Error("secret transport details"));
    expect(await readGitProviderValue({ argv: [], run })).toEqual({
      status: "unavailable",
      failure: { reason: "provider-unavailable", state: "pending" },
    });
  });
});
