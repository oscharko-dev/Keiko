import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  createGitHubCodeContextApiPort,
  GitHubCodeContextPortError,
} from "./githubCodeContextPort.js";
import {
  createJiraCodeContextHttpPort,
  JiraCodeContextPortError,
  parseJiraCodeContextPortConfig,
} from "./jiraCodeContextPort.js";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";

const WORKSPACE: WorkspaceInfo = {
  root: process.cwd(),
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
});

function fakeChild(exitCode: number, stdout: string): unknown {
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
      if (event === "spawn")
        queueMicrotask(() => {
          (listener as () => void)();
        });
      return child;
    },
    kill: (): boolean => true,
    pid: 4242,
  };
  queueMicrotask(() => {
    for (const listener of stdoutListeners) listener(Buffer.from(stdout, "utf8"));
    queueMicrotask(() => {
      for (const listener of closeListeners) listener(exitCode, null);
    });
  });
  return child;
}

describe("jira code context port", () => {
  const CONFIG = { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "token-1" };

  function jsonResponse(body: unknown, url = ""): Response {
    return {
      ok: true,
      status: 200,
      url,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  it("parses config only when every field is present", () => {
    expect(parseJiraCodeContextPortConfig({})).toBeUndefined();
    expect(parseJiraCodeContextPortConfig({ KEIKO_JIRA_BASE_URL: "https://x" })).toBeUndefined();
    expect(
      parseJiraCodeContextPortConfig({
        KEIKO_JIRA_BASE_URL: "https://example.atlassian.net",
        KEIKO_JIRA_EMAIL: "a@b.c",
        KEIKO_JIRA_API_TOKEN: "t",
      }),
    ).toMatchObject({ baseUrl: "https://example.atlassian.net" });
  });

  it("rejects non-https base urls and embedded credentials fail-closed", () => {
    expect(() =>
      createJiraCodeContextHttpPort({ ...CONFIG, baseUrl: "http://example.atlassian.net" }),
    ).toThrow(JiraCodeContextPortError);
    expect(() =>
      createJiraCodeContextHttpPort({ ...CONFIG, baseUrl: "https://user:pw@example.net" }),
    ).toThrow(JiraCodeContextPortError);
  });

  it("pins requests to the configured host and GET /rest/api/ paths", async () => {
    const seen: string[] = [];
    const port = createJiraCodeContextHttpPort(CONFIG, {
      fetchFn: ((input: URL) => {
        seen.push(String(input));
        return Promise.resolve(jsonResponse({ fields: {} }));
      }) as unknown as typeof fetch,
    });

    await port.readJson({ method: "GET", path: "/rest/api/3/issue/KEIKO-1", query: {} });
    expect(seen[0]).toBe("https://example.atlassian.net/rest/api/3/issue/KEIKO-1");

    await expect(
      port.readJson({ method: "GET", path: "/other/path", query: {} }),
    ).rejects.toMatchObject({ code: "jira-denied" });
  });

  it("rejects cross-host redirects and keeps auth material off errors", async () => {
    const port = createJiraCodeContextHttpPort(CONFIG, {
      fetchFn: (() =>
        Promise.resolve(
          jsonResponse({ fields: {} }, "https://evil.example.com/rest/api/3/issue/K-1"),
        )) as unknown as typeof fetch,
    });
    const failure = await port
      .readJson({ method: "GET", path: "/rest/api/3/issue/K-1", query: {} })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "jira-denied" });
    expect((failure as Error).message).not.toContain("token-1");
  });

  it("bounds oversized responses fail-closed", async () => {
    const port = createJiraCodeContextHttpPort(CONFIG, {
      fetchFn: (() =>
        Promise.resolve({
          ok: true,
          status: 200,
          url: "",
          text: () => Promise.resolve(`"${"x".repeat(5 * 1024 * 1024)}"`),
        } as unknown as Response)) as unknown as typeof fetch,
    });
    await expect(
      port.readJson({ method: "GET", path: "/rest/api/3/issue/K-1", query: {} }),
    ).rejects.toMatchObject({ code: "jira-invalid-json" });
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
