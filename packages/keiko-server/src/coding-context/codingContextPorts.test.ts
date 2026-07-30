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
import { DEFAULT_SANDBOX_POLICY, type SpawnFn } from "@oscharko-dev/keiko-tools";
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

  // The spawn boundary — not this port — owns the output cap: past `policy.maxOutputBytes` it
  // replaces stdout with a marker, kills the child, and sets `truncated`. Both observable shapes of
  // that one stop (the child had already exited 0, or the kill landed and it died on the signal)
  // must be reported AS a truncation. Before this fix the port ignored `truncated` entirely, so the
  // first shape surfaced as `gh-invalid-json` (the marker is not JSON) and the second as
  // `gh-failed` (the kill) — two different wrong stories for the same cause.
  describe("output-cap classification", () => {
    // Derived from the policy the port actually runs under, never restated as a literal: if the cap
    // moves, these fixtures move with it instead of silently testing the wrong boundary.
    const capBytes = DEFAULT_SANDBOX_POLICY.maxOutputBytes;

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
      if (event === "spawn")
        queueMicrotask(() => {
          (listener as () => void)();
        });
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
