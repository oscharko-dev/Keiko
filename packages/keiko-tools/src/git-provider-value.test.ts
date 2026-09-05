import { describe, expect, it, vi } from "vitest";
import { buildGitHubApiGetArgv, readGitProviderValue } from "./git-provider-value.js";
import { buildPrReadArgv, GIT_PR_IDENTITY_JQ } from "./git-pr-gateway.js";
import { buildPrBodyReadArgv } from "./git-pr-body.js";
import { buildGitCiReadArgv } from "./git-ci-read-argv.js";
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

// F32 (#3384 audit): one owner for the GitHub REST GET argv envelope. Every governed GET builder in
// this package must produce EXACTLY buildGitHubApiGetArgv's output — this pins the envelope shape
// itself and proves each of the (now three in-scope) call sites delegates to it rather than
// reconstructing it, so the existing byte-identical argv pins on those call sites stay authoritative.
describe("buildGitHubApiGetArgv — the one GitHub REST GET argv envelope owner", () => {
  it("builds the exact governed envelope: api, host pin, method GET, endpoint, jq projection", () => {
    expect(buildGitHubApiGetArgv("/repos/o/r/pulls/1", ".number")).toEqual([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "/repos/o/r/pulls/1",
      "--jq",
      ".number",
    ]);
  });

  it("is the exact function every in-scope GET-read call site delegates to", () => {
    const prRead = buildPrReadArgv({ ownerAndRepo: "o/r", prExternalId: "1" });
    expect(prRead).toEqual(buildGitHubApiGetArgv("/repos/o/r/pulls/1", GIT_PR_IDENTITY_JQ));

    const bodyRead = buildPrBodyReadArgv({ ownerAndRepo: "o/r", prExternalId: "1" });
    expect(bodyRead).toEqual(
      buildGitHubApiGetArgv(
        "/repos/o/r/pulls/1",
        `{identity:${GIT_PR_IDENTITY_JQ},body,updatedAt:.updated_at}`,
      ),
    );

    const ciRead = buildGitCiReadArgv(
      "branch",
      { ownerAndRepo: "o/r", prExternalId: "1", baseBranchName: "dev", headSha: "a".repeat(40) },
      1,
    );
    expect(ciRead).toEqual(
      buildGitHubApiGetArgv("/repos/o/r/branches/dev", "{name,protected,sha:.commit.sha}"),
    );
  });
});
