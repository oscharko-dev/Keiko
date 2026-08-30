import { captureActivityLog } from "./activityLogCapture.test-support.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitProcessResult } from "@oscharko-dev/keiko-git";
import {
  classifyCloneOutcome,
  createCloneRepositoryHandler,
  type CloneRepositoryRunner,
} from "./gitRepositoryRoutes.js";
import type { RouteContext } from "./routes.js";
import { createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, UiStoreError, type UiStore } from "./store/index.js";
import { writeNodeExecutableFixture } from "./editor/lsp/testing/executableFixture.js";

let tmp: string;
let store: UiStore;

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: (value: unknown) => value,
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function ctx(body: unknown): RouteContext {
  return {
    correlationId: undefined,
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/repositories/clone"),
  };
}

function ctxRaw(rawBody: string): RouteContext {
  return {
    correlationId: undefined,
    req: Readable.from([Buffer.from(rawBody, "utf8")]) as IncomingMessage,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/repositories/clone"),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-repo-route-"));
  store = createInMemoryUiStore();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("git repository routes", () => {
  it("clones a repository into a destination folder and registers it", async () => {
    const destination = join(tmp, "app");
    const cloneRunner = vi.fn((_repositoryUrl: string, destinationPath: string) => {
      mkdirSync(destinationPath);
      return Promise.resolve(null);
    });
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "https://github.com/acme/app.git",
        destinationPath: destination,
        name: "Customer App",
      }),
      deps(),
    );

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      project: {
        path: destination,
        name: "Customer App",
        available: true,
        workspaceAvailable: true,
      },
    });
    expect(cloneRunner).toHaveBeenCalledWith(
      "https://github.com/acme/app.git",
      destination,
      // The handler now hands the clone the OBSERVED network runner, so a failed clone
      // reports itself on the activity log under this request's correlation id.
      expect.any(Function),
    );
    expect(store.listProjects()).toContainEqual(
      expect.objectContaining({ path: destination, name: "Customer App" }),
    );
    expect(store.listWorkspaceManifestRecords()).toHaveLength(1);
  });

  it("clones a repository URL containing a supplementary-plane character (not a control character)", async () => {
    // "😀" (U+1F600) is a 2-UTF-16-code-unit surrogate pair. The control-character scan iterates
    // by Unicode code point and must not misclassify it as a control character (codes < 32 or 127).
    const destination = join(tmp, "app");
    const cloneRunner = vi.fn((_repositoryUrl: string, destinationPath: string) => {
      mkdirSync(destinationPath);
      return Promise.resolve(null);
    });
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "https://github.com/acme/app-😀.git",
        destinationPath: destination,
        name: "Emoji App",
      }),
      deps(),
    );

    expect(result.status).toBe(201);
    expect(cloneRunner).toHaveBeenCalledWith(
      "https://github.com/acme/app-😀.git",
      destination,
      // The handler now hands the clone the OBSERVED network runner, so a failed clone
      // reports itself on the activity log under this request's correlation id.
      expect.any(Function),
    );
  });

  it("uses the shared hardened network git env for the clone spawn boundary", async () => {
    const destination = join(tmp, "app");
    const capturePath = join(tmp, "clone-env.json");
    const trustedBin = mkdtempSync(join(tmpdir(), "keiko-repo-route-bin-"));
    writeNodeExecutableFixture(
      trustedBin,
      "git",
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));`,
        "fs.mkdirSync(process.argv.at(-1), { recursive: true });",
        "process.exit(0);",
      ].join("\n"),
    );
    vi.stubEnv("PATH", `${trustedBin}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret-that-must-not-reach-git");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/tmp/attacker.gitconfig");
    vi.stubEnv("GIT_ASKPASS", "/tmp/unsafe-askpass");
    vi.stubEnv("SSH_ASKPASS", "/tmp/unsafe-ssh-askpass");
    try {
      const result = await createCloneRepositoryHandler()(
        ctx({
          repositoryUrl: "https://github.com/acme/app.git",
          destinationPath: destination,
        }),
        deps(),
      );

      expect(result.status).toBe(201);
      const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
        readonly args: readonly string[];
        readonly env: NodeJS.ProcessEnv;
      };
      expect(capture.args.slice(-4)).toEqual([
        "clone",
        "--",
        "https://github.com/acme/app.git",
        destination,
      ]);
      expect(capture.args).toContain("protocol.ext.allow=never");
      expect(capture.args).toContain("credential.helper=");
      expect(capture.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(capture.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
      expect(capture.env.GIT_SSH_COMMAND).toContain("NumberOfPasswordPrompts=0");
      expect(capture.env.GIT_ASKPASS).not.toBe("/tmp/unsafe-askpass");
      expect(capture.env.SSH_ASKPASS).not.toBe("/tmp/unsafe-ssh-askpass");
      expect(capture.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(capture.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(trustedBin, { recursive: true, force: true });
    }
  });

  it("the default clone path never spawns git for an option-like repository URL", async () => {
    // The injected-runner tests bypass the real cloneRepository. This drives the DEFAULT clone
    // path end to end with an option-like URL and proves git is never spawned: a fake git on PATH
    // writes a marker file if invoked, and the marker must never appear.
    const capturePath = join(tmp, "should-not-spawn.marker");
    writeNodeExecutableFixture(
      tmp,
      "git",
      [
        `require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, "spawned");`,
        "process.exit(0);",
      ].join("\n"),
    );
    vi.stubEnv("PATH", `${tmp}${delimiter}${process.env.PATH ?? ""}`);
    try {
      const result = await createCloneRepositoryHandler()(
        ctx({
          repositoryUrl: "--upload-pack=touch /tmp/pwned",
          destinationPath: join(tmp, "app"),
        }),
        deps(),
      );
      expect(result.status).toBe(400);
      expect(existsSync(capturePath)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects repository URLs that embed credentials", async () => {
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "https://token@example.test/acme/app.git",
        destinationPath: join(tmp, "app"),
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  it.each([
    "--upload-pack=touch /tmp/pwned",
    "-oProxyCommand=evil",
    "--config=core.fsmonitor=evil",
  ])("rejects an option-like repository URL that git could execute (%s)", async (repositoryUrl) => {
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(ctx({ repositoryUrl, destinationPath: join(tmp, "app") }), deps());

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  it.each([
    "https://169.254.169.254/acme/app.git",
    "https://10.0.0.5/acme/app.git",
    "ssh://git@192.168.1.10/acme/app.git",
    "git@172.16.0.9:acme/app.git",
    "https://localhost/acme/app.git",
  ])("rejects private or local repository clone target %s", async (repositoryUrl) => {
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl,
        destinationPath: join(tmp, "app"),
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  it("rejects an already existing destination before invoking git", async () => {
    const destination = join(tmp, "app");
    mkdirSync(destination);
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "git@example.test:acme/app.git",
        destinationPath: destination,
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  it("preserves PROJECT_EXISTS after a successful clone", async () => {
    const destination = join(tmp, "registered-app");
    const cloneRunner = vi.fn((_repositoryUrl: string, destinationPath: string) => {
      mkdirSync(destinationPath);
      return Promise.resolve(null);
    });
    const baseDeps = deps();
    const failingStore = new Proxy(baseDeps.store, {
      get(target, property, receiver): unknown {
        if (property === "createProject") {
          return (): never => {
            throw new UiStoreError("PROJECT_EXISTS", "Project already registered.", 409);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await createCloneRepositoryHandler(cloneRunner)(
      ctx({
        repositoryUrl: "https://github.com/acme/app.git",
        destinationPath: destination,
      }),
      { ...baseDeps, store: failingStore },
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "PROJECT_EXISTS" } });
  });

  // KEIKO-0341: parse/shape/validation failures must produce pairwise distinguishable
  // messages instead of collapsing into one opaque "The clone request is invalid."
  it("distinguishes malformed JSON, missing repositoryUrl, and missing destinationPath in the error message", async () => {
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);
    const malformed = await handler(ctxRaw("{not json at all"), deps());
    const missingRepositoryUrl = await handler(
      ctx({ destinationPath: join(tmp, "app-a") }),
      deps(),
    );
    const missingDestination = await handler(
      ctx({ repositoryUrl: "https://github.com/acme/app.git" }),
      deps(),
    );

    const messages = [malformed, missingRepositoryUrl, missingDestination].map((result) => {
      expect(result.status).toBe(400);
      const body = result.body as { readonly error?: { readonly message?: unknown } };
      const message = body.error?.message;
      expect(typeof message).toBe("string");
      return message as string;
    });
    expect(new Set(messages).size).toBe(3);
    expect(messages[0]).toMatch(/JSON/u);
    expect(messages[1]).toMatch(/repositoryUrl/u);
    expect(messages[2]).toMatch(/destinationPath/u);
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  // KEIKO-0341 coverage extension: prove each remaining typed error class also
  // surfaces its own distinguishable message and never invokes cloneRunner.
  it.each([
    {
      caseName: "non-object body (bare JSON array)",
      rawBody: JSON.stringify([{ repositoryUrl: "x", destinationPath: "/tmp/a" }]),
      matcher: /object/u,
    },
    {
      caseName: "non-string repositoryUrl (numeric)",
      rawBody: JSON.stringify({ repositoryUrl: 42, destinationPath: "/tmp/app" }),
      matcher: /repositoryUrl.*string/u,
    },
    {
      caseName: "whitespace-only repositoryUrl (empty after trim)",
      rawBody: JSON.stringify({ repositoryUrl: "   ", destinationPath: "/tmp/app" }),
      matcher: /repositoryUrl.*required/u,
    },
  ])(
    "rejects a $caseName with a distinguishable message and never runs the cloner",
    async (input) => {
      const cloneRunner = vi.fn(() => Promise.resolve(null));
      const handler = createCloneRepositoryHandler(cloneRunner);
      const result = await handler(ctxRaw(input.rawBody), deps());
      expect(result.status).toBe(400);
      const body = result.body as { readonly error?: { readonly message?: unknown } };
      const message = body.error?.message;
      expect(typeof message).toBe("string");
      expect(message as string).toMatch(input.matcher);
      expect(cloneRunner).not.toHaveBeenCalled();
    },
  );
});

// The clone outcome projection is exercised directly: it is the only place that decides what a user
// is told about a failed clone, and the runner's two self-imposed stops (wall clock vs byte cap) plus
// the remote-cause vocabulary must never collapse into one opaque "check the URL and credentials".
function cloneResult(overrides: Partial<GitProcessResult>): GitProcessResult {
  return {
    exitCode: 128,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    ...overrides,
  };
}

function cloneCode(result: GitProcessResult): string | undefined {
  const outcome = classifyCloneOutcome(result);
  if (outcome === null) return undefined;
  const body = outcome.body as { readonly error?: { readonly code?: string } };
  return body.error?.code;
}

describe("classifyCloneOutcome", () => {
  it("returns no failure for a clean clone", () => {
    expect(classifyCloneOutcome(cloneResult({ exitCode: 0 }))).toBeNull();
  });

  it("separates the wall-clock timeout from the output byte cap", () => {
    const timedOut = classifyCloneOutcome(cloneResult({ truncated: true, timedOut: true }));
    expect(timedOut?.status).toBe(504);
    expect(cloneCode(cloneResult({ truncated: true, timedOut: true }))).toBe("GIT_CLONE_TIMEOUT");
    expect(cloneCode(cloneResult({ truncated: true, timedOut: false }))).toBe(
      "GIT_CLONE_OUTPUT_TRUNCATED",
    );
  });

  it("keeps git-missing on its own status", () => {
    const outcome = classifyCloneOutcome(
      cloneResult({ exitCode: 127, stderr: "git executable unavailable" }),
    );
    expect(outcome?.status).toBe(503);
    expect(cloneCode(cloneResult({ exitCode: 127 }))).toBe("GIT_UNAVAILABLE");
  });

  it("distinguishes credentials, a missing repository, and an unreachable host", () => {
    expect(
      cloneCode(cloneResult({ stderr: "fatal: Authentication failed for 'https://x/'" })),
    ).toBe("GIT_CLONE_AUTH_FAILED");
    expect(
      cloneCode(cloneResult({ stderr: "remote: Permission to acme/app.git denied to user." })),
    ).toBe("GIT_CLONE_PERMISSION_DENIED");
    expect(cloneCode(cloneResult({ stderr: "ERROR: Repository not found." }))).toBe(
      "GIT_CLONE_NOT_FOUND",
    );
    expect(
      cloneCode(
        cloneResult({
          stderr: "fatal: unable to access 'https://x/': Could not resolve host: x",
        }),
      ),
    ).toBe("GIT_CLONE_REMOTE_UNAVAILABLE");
    expect(cloneCode(cloneResult({ stderr: "Host key verification failed." }))).toBe(
      "GIT_CLONE_HOST_KEY_UNTRUSTED",
    );
  });

  it("still falls back to the generic failure for an unrecognized non-zero exit", () => {
    const outcome = classifyCloneOutcome(
      cloneResult({ stderr: "fatal: something else", exitCode: 1 }),
    );
    expect(outcome?.status).toBe(409);
    expect(cloneCode(cloneResult({ stderr: "fatal: something else", exitCode: 1 }))).toBe(
      "GIT_CLONE_FAILED",
    );
  });

  it("never echoes the raw git output into the user-visible message", () => {
    const secretish = "fatal: unable to access 'https://user:hunter2@example.com/x.git/'";
    const outcome = classifyCloneOutcome(cloneResult({ stderr: secretish }));
    expect(JSON.stringify(outcome?.body)).not.toContain("hunter2");
  });

  // KEIKO-0341/#2903: `aborted: true` (the bounded caller disconnected) must classify as its own
  // request-scope cancellation, never as the output-truncation or generic-failure rows it would
  // otherwise fall through to.
  it("reports a caller-aborted clone as a 499 cancellation, not truncation or a generic failure", () => {
    const outcome = classifyCloneOutcome(cloneResult({ truncated: true, aborted: true }));
    expect(outcome?.status).toBe(499);
    expect(cloneCode(cloneResult({ truncated: true, aborted: true }))).toBe("GIT_CLONE_CANCELLED");
  });
});

describe("clone route activity log (AGENTS.md §8 Rule 1)", () => {
  // A failed clone answers with a content-free typed message (CLONE_FAILURE) and nothing else: the
  // git output that says WHY stays at the spawn boundary by design. Without a log line the
  // operator's whole record of a failed clone was one `http`/`request` line and a status code.

  function ctxWithCorrelation(body: unknown, correlationId: string): RouteContext {
    return { ...ctx(body), correlationId };
  }

  it("reports a failed clone under the request's correlation id, with no git output in the line", async () => {
    const activity = captureActivityLog();
    // Hermetic on purpose: cloning a local path that does not exist fails inside git in
    // milliseconds with no DNS lookup and no socket. A remote URL — even a reserved `.invalid`
    // one — would put a real name resolution in the test's path.
    const missingSource = join(tmp, "no-such-source");
    const cloneRunner: CloneRepositoryRunner = async (_repositoryUrl, destinationPath, runner) => {
      // Drives the OBSERVED runner the handler built, exactly as the production clone does — the
      // wiring is what is under test, so the test must not re-implement it.
      await runner(["clone", "--", missingSource, destinationPath], {
        cwd: tmp,
        maxBytes: 4096,
        timeoutMs: 30_000,
      });
      return null;
    };
    const handler = createCloneRepositoryHandler(cloneRunner, activity.sink);

    await handler(
      ctxWithCorrelation(
        {
          repositoryUrl: "https://github.com/acme/app.git",
          destinationPath: join(tmp, "clone-target"),
        },
        "corr-clone-000001",
      ),
      deps(),
    );

    const failures = activity.events.filter((event) => event.op === "git.process.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      category: "diagnostic",
      correlationId: "corr-clone-000001",
      extra: { subcommand: "clone" },
    });
    // The source path is in the argv the observed runner was handed and in git's own stderr; the
    // line records the subcommand and the exit status, and neither of those.
    expect(JSON.stringify(failures[0])).not.toContain("no-such-source");
  });
});
