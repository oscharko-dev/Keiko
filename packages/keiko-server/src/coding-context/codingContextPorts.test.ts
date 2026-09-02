import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  createGitHubCodeContextApiPort,
  GitHubCodeContextPortError,
} from "./githubCodeContextPort.js";
import { createGovernedJiraCodeContextHttpPort } from "./jiraCodeContextPort.js";
import { GOVERNED_GIT_REMOTE_SANDBOX_POLICY, type SpawnFn } from "@oscharko-dev/keiko-tools";
import type { AtlassianHttpBodyPort } from "@oscharko-dev/keiko-connectors";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";

const WORKSPACE: WorkspaceInfo = {
  root: process.cwd(),
  selectedRoot: process.cwd(),
  name: undefined,
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

function githubPortWith(spawn: SpawnFn): ReturnType<typeof createGitHubCodeContextApiPort> {
  return createGitHubCodeContextApiPort({
    workspace: WORKSPACE,
    processEnv: { PATH: process.env.PATH },
    spawn,
    resolveExecutable: () => "/test-bin/gh",
    timeoutMs: 1_000,
  });
}

const READ_ARGV: readonly string[] = ["api", "repos/oscharko-dev/Keiko/issues/1"];

describe("github code context port", () => {
  it("rejects non-api subcommands, mutation flags, and non-repos endpoints before spawn", async () => {
    let spawned = 0;
    const port = githubPortWith(() => {
      spawned += 1;
      throw new Error("must not spawn");
    });

    const denied: readonly (readonly string[])[] = [
      ["pr", "create"],
      ["api", "repos/o/r/issues/1", "--method", "DELETE"],
      ["api", "repos/o/r/issues/1", "-X", "POST"],
      ["api", "repos/o/r/issues/1", "-f", "body=x"],
      ["api", "user"],
      [],
    ];
    for (const argv of denied) {
      await expect(port.readJson(argv)).rejects.toMatchObject({ code: "gh-denied" });
    }
    expect(spawned).toBe(0);
  });

  it("keeps failures content-free: non-zero exit and bad JSON never leak output", async () => {
    const failing = githubPortWith(((..._args: readonly unknown[]) =>
      fakeChild(1, "SECRET-STDOUT with ghp_token")) as unknown as SpawnFn);
    const failure = await failing.readJson(READ_ARGV).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubCodeContextPortError);
    expect((failure as Error).message).not.toContain("SECRET-STDOUT");

    const badJson = githubPortWith(((..._args: readonly unknown[]) =>
      fakeChild(0, "not json {{{")) as unknown as SpawnFn);
    await expect(badJson.readJson(READ_ARGV)).rejects.toMatchObject({ code: "gh-invalid-json" });
  });

  // The spawn boundary — not this port — owns the output cap: past `policy.maxOutputBytes` it
  // replaces stdout with a marker, kills the child, and sets `truncated`. Both observable shapes of
  // that one stop (the child had already exited 0, or the kill landed and it died on the signal)
  // must be reported AS a truncation. Before this fix the port ignored `truncated` entirely, so the
  // first shape surfaced as `gh-invalid-json` (the marker is not JSON) and the second as
  // `gh-failed` (the kill) — two different wrong stories for the same cause.
  describe("output-cap classification", () => {
    // Derived from the policy the port actually runs under, never restated as a literal: if the cap
    // moves, these fixtures move with it instead of silently testing the wrong boundary.
    const capBytes = GOVERNED_GIT_REMOTE_SANDBOX_POLICY.maxOutputBytes;

    function jsonOfExactByteLength(totalBytes: number): string {
      const envelope = '{"a":""}';
      return `{"a":"${"x".repeat(totalBytes - envelope.length)}"}`;
    }

    it("reports an over-cap read as truncated when the child still exits zero", async () => {
      const port = githubPortWith(((..._args: readonly unknown[]) =>
        fakeGhChild({
          chunks: [jsonOfExactByteLength(capBytes + 1)],
          exitCode: 0,
          signal: null,
        })) as unknown as SpawnFn);

      const failure = await port.readJson(READ_ARGV).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GitHubCodeContextPortError);
      expect(failure).toMatchObject({ code: "gh-output-truncated" });
      expect((failure as Error).message).not.toContain("xxx");
    });

    it("reports an over-cap read as truncated when the flood kill terminates the child", async () => {
      const port = githubPortWith(((..._args: readonly unknown[]) =>
        fakeGhChild({
          chunks: [jsonOfExactByteLength(capBytes + 1)],
          exitCode: null,
          signal: "SIGTERM",
        })) as unknown as SpawnFn);

      await expect(port.readJson(READ_ARGV)).rejects.toMatchObject({
        code: "gh-output-truncated",
      });
    });

    it("still parses a complete response that lands exactly on the cap", async () => {
      const body = jsonOfExactByteLength(capBytes);
      expect(Buffer.byteLength(body, "utf8")).toBe(capBytes);
      const port = githubPortWith(((..._args: readonly unknown[]) =>
        fakeGhChild({ chunks: [body], exitCode: 0, signal: null })) as unknown as SpawnFn);

      await expect(port.readJson(READ_ARGV)).resolves.toEqual(JSON.parse(body) as unknown);
    });
  });
});

interface FakeGhChildOptions {
  readonly chunks: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
}

// No `pid`: the exec boundary kills the whole process GROUP on a flood, and a fabricated pid in a
// unit test would signal an unrelated real process group on the host.
function fakeGhChild(options: FakeGhChildOptions): unknown {
  const stdoutListeners: ((chunk: Buffer) => void)[] = [];
  const closeListeners: ((code: number | null, signal: string | null) => void)[] = [];
  const child = {
    stdout: {
      on: (event: string, listener: (chunk: Buffer) => void): unknown => {
        if (event === "data") stdoutListeners.push(listener);
        return child.stdout;
      },
    },
    stderr: {
      on: (): unknown => child.stderr,
    },
    on: (
      event: string,
      listener: (code: number | null, signal: string | null) => void,
    ): unknown => {
      if (event === "close") closeListeners.push(listener);
      return child;
    },
    once: (event: string, listener: () => void): unknown => {
      if (event === "spawn") queueMicrotask(listener);
      return child;
    },
    kill: (): boolean => true,
    pid: undefined,
  };
  queueMicrotask(() => {
    for (const listener of stdoutListeners) {
      for (const chunk of options.chunks) listener(Buffer.from(chunk, "utf8"));
    }
    queueMicrotask(() => {
      for (const listener of closeListeners) listener(options.exitCode, options.signal);
    });
  });
  return child;
}

function fakeChild(exitCode: number, stdout: string): unknown {
  return fakeGhChild({ chunks: [stdout], exitCode, signal: null });
}

describe("jira code context port", () => {
  it("reads through exactly one governed Jira credential", async () => {
    const requests: unknown[] = [];
    const port = createGovernedJiraCodeContextHttpPort({
      custody: {
        list: () => [
          {
            authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
            provider: "jira",
            baseUrl: "https://example.atlassian.net",
          },
        ],
      } as never,
      httpBodyPortFactory: (): AtlassianHttpBodyPort => (request) => {
        requests.push(request);
        return Promise.resolve({
          kind: "response" as const,
          status: 200,
          bodyText: '{"fields":{"summary":"Issue"}}',
          bodyBytes: 30,
          truncated: false,
        });
      },
    });

    await expect(
      port.readJson({
        method: "GET",
        path: "/rest/api/3/issue/PROJ-1",
        query: { fields: "summary" },
      }),
    ).resolves.toMatchObject({ fields: { summary: "Issue" } });
    expect(requests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "https://example.atlassian.net/rest/api/3/issue/PROJ-1?fields=summary",
      }),
    ]);
  });

  it.each([
    [[]],
    [
      [
        {
          authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
          provider: "jira",
          baseUrl: "https://one.example",
        },
        {
          authRef: "atlassian-cred:BBBBBBBBBBBBBBBBBBBBBB",
          provider: "jira",
          baseUrl: "https://two.example",
        },
      ],
    ],
  ] as const)("rejects ambiguous Jira credential selection", async (credentials) => {
    const port = createGovernedJiraCodeContextHttpPort({
      custody: { list: (): typeof credentials => credentials } as never,
      httpBodyPortFactory: (): AtlassianHttpBodyPort => () =>
        Promise.reject(new Error("must not execute")),
    });

    await expect(
      port.readJson({ method: "GET", path: "/rest/api/3/issue/PROJ-1", query: {} }),
    ).rejects.toMatchObject({ code: "jira-denied" });
  });

  it.each([
    "/rest/api/../admin",
    "/rest/api/%2e%2e/admin",
    "//evil.example/rest/api/3/issue/PROJ-1",
    "not-a-path",
  ])("rejects a path outside the normalized REST API boundary: %s", async (path) => {
    const port = createGovernedJiraCodeContextHttpPort({
      custody: {
        list: () => [
          {
            authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
            provider: "jira",
            baseUrl: "https://example.atlassian.net",
          },
        ],
      } as never,
      httpBodyPortFactory: (): AtlassianHttpBodyPort => () =>
        Promise.reject(new Error("must not execute")),
    });

    await expect(port.readJson({ method: "GET", path, query: {} })).rejects.toMatchObject({
      code: "jira-denied",
    });
  });
});

// The read-only `gh api` port is the same credential lane as governed PR/merge: under the fully
// isolated default sandbox profile `gh` receives neither GH_TOKEN/GITHUB_TOKEN nor a HOME holding
// `~/.config/gh`, so every call against a private repository fails to authenticate.
describe("github code context port — `gh` can authenticate", () => {
  async function spawnedEnv(): Promise<Record<string, string>> {
    let captured: Record<string, string> = {};
    const spawn: SpawnFn = (_command, _args, options): ChildProcess => {
      captured = options.env;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 5150;
      child.kill = (): boolean => true;
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("{}"));
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const port = createGitHubCodeContextApiPort({
      workspace: WORKSPACE,
      processEnv: {
        PATH: process.env.PATH ?? "",
        HOME: "/Users/dev",
        GH_TOKEN: "gho_code_context_token_value",
        AWS_SECRET_ACCESS_KEY: "aws-must-not-reach-gh",
      },
      spawn,
      resolveExecutable: () => "/test-bin/gh",
      timeoutMs: 1_000,
    });
    await port.readJson(READ_ARGV);
    return captured;
  }

  it("forwards the GitHub token and the real HOME so gh resolves its own credentials", async () => {
    const env = await spawnedEnv();
    expect(env.GH_TOKEN).toBe("gho_code_context_token_value");
    expect(env.HOME).toBe("/Users/dev");
  });

  it("still copies by name only — an unrelated ambient secret never reaches gh", async () => {
    const env = await spawnedEnv();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
