import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../routes.js";
import {
  defaultGitNetworkProcessRunner,
  classifyGitRemoteFailure,
  type GitProcessResult,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import { classifyCloneOutcome } from "../gitRepositoryRoutes.js";
import { runSyncExecute } from "./syncExecution.js";

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public kill(): boolean {
    return true;
  }
}
const spawned: (readonly string[])[] = [];
let listing = { stdout: "", exitCode: 1 };
let beforeListing: (() => void) | undefined;
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_file: string, args: readonly string[]): FakeChild => {
      const child = new FakeChild();
      spawned.push(args);
      queueMicrotask(() => {
        const config = args.includes("config");
        if (config) beforeListing?.();
        child.stdout.end(config ? listing.stdout : "");
        child.stderr.end(config ? "synthetic-private-config-detail" : "");
        child.emit("close", config ? listing.exitCode : 0, null);
      });
      return child;
    },
  };
});
afterEach(() => {
  spawned.length = 0;
  beforeListing = undefined;
  vi.restoreAllMocks();
});

const ok = (stdout: string): GitProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  truncated: false,
});
function syncRunner(network: GitProcessResult): GitProcessRunner {
  return (args): Promise<GitProcessResult> => {
    if (args[4] === "status")
      return Promise.resolve(
        ok("# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0"),
      );
    if (args[4] === "remote") return Promise.resolve(ok("origin\n"));
    return Promise.resolve(network);
  };
}

describe("credential admission cannot masquerade as remote success (#4411 review)", () => {
  it("uses only the remaining operation deadline for the remote command", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const timers = vi.spyOn(globalThis, "setTimeout");
    beforeListing = (): void => {
      now.mockReturnValue(80);
    };
    listing = { stdout: "", exitCode: 0 };
    const result = await defaultGitNetworkProcessRunner(["fetch", "origin"], {
      cwd: process.cwd(),
      timeoutMs: 100,
      maxBytes: 1024,
    });
    expect(spawned).toHaveLength(2);
    expect(timers.mock.calls.map((call) => call[1])).toEqual([100, 20]);
    expect(classifyGitRemoteFailure(result)).toBe("none");
  });

  it("does not start the remote command after discovery consumes the shared deadline", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    beforeListing = (): void => {
      now.mockReturnValue(100);
    };
    listing = { stdout: "", exitCode: 0 };
    const result = await defaultGitNetworkProcessRunner(["fetch", "origin"], {
      cwd: process.cwd(),
      timeoutMs: 100,
      maxBytes: 1024,
    });
    expect(spawned).toHaveLength(1);
    expect(result).toMatchObject({ timedOut: true, aborted: false, truncated: true });
    expect(result.refusal).toBeUndefined();
    expect(classifyGitRemoteFailure(result)).toBe("timeout");
    expect(result.stdout + result.stderr).toBe("");
  });

  it("preserves a caller cancellation during discovery and never starts the remote command", async () => {
    const controller = new AbortController();
    beforeListing = (): void => {
      controller.abort();
    };
    listing = { stdout: "", exitCode: 0 };
    const result = await defaultGitNetworkProcessRunner(["fetch", "origin"], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxBytes: 1024,
      abortSignal: controller.signal,
    });
    expect(spawned).toHaveLength(1);
    expect(result.refusal).toBeUndefined();
    expect(classifyGitRemoteFailure(result)).toBe("cancelled");
    expect(result.stdout + result.stderr).toBe("");
  });

  it.each([0, 1])(
    "continues to the remote operation after a complete empty listing (exit %s)",
    async (exitCode) => {
      listing = { stdout: "", exitCode };
      const result = await defaultGitNetworkProcessRunner(["fetch", "origin"], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        maxBytes: 1024,
      });
      expect(spawned).toHaveLength(2);
      expect(spawned[1]).toContain("fetch");
      expect(result).toMatchObject({ exitCode: 0, credentialHelperSource: "none" });
      expect(classifyGitRemoteFailure(result)).toBe("none");
    },
  );

  it.each([
    ["truncated exit zero", "global\0credential.helper\n" + "x".repeat(40_000) + "\0", 0],
    ["failed configuration read", "", 2],
    ["malformed listing", "global\0credential.helper\nmissing-terminator", 0],
  ] as const)(
    "refuses %s before fetch and projects a failure for sync and clone",
    async (_name, stdout, exitCode) => {
      listing = { stdout, exitCode };
      const network = await defaultGitNetworkProcessRunner(["fetch", "origin"], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        maxBytes: 1024,
      });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toContain("config");
      expect(network.exitCode).not.toBe(0);
      expect(network).toMatchObject({
        refusal: "credential-discovery-unavailable",
        credentialHelperSource: "unavailable",
        stdout: "",
        stderr: "",
        truncated: false,
      });
      expect(classifyGitRemoteFailure(network)).toBe("credential-discovery-unavailable");
      const sync = await runSyncExecute("fetch", process.cwd(), undefined, {
        runner: syncRunner(network),
      });
      expect(sync.outcome).toBe("git-error");
      expect(classifyCloneOutcome(network)).toMatchObject({
        status: 409,
        body: { error: { code: "GIT_CLONE_FAILED" } },
      });
      expect(JSON.stringify(sync)).not.toContain("synthetic-private-config-detail");
    },
  );
});
