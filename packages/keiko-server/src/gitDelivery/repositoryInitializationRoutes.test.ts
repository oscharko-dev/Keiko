import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import type { ServerLogEvent } from "../observability/index.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { RouteContext } from "../routes.js";
import { createInMemoryUiStore } from "../store/index.js";
import { GIT_DELIVERY_MAX_BODY_BYTES } from "./requestGuards.js";
import { createHandleGitRepositoryInitialize } from "./repositoryInitializationRoutes.js";

const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const ROUTE = "/api/git-delivery/repository/initialize";

function result(exitCode: number, stderr = "", stdout = ""): GitProcessResult {
  return { exitCode, signal: null, stderr, stdout, truncated: false };
}

function rawContext(body: string): RouteContext {
  const req = Readable.from([Buffer.from(body, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return {
    correlationId: CORRELATION_ID,
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL(`http://127.0.0.1${ROUTE}`),
  };
}

function context(body: unknown): RouteContext {
  return rawContext(JSON.stringify(body));
}

function boundedInitializationBody(extraBytes = 0): string {
  const body = JSON.stringify({ projectId: root, initialBranch: "main" });
  return `${body}${" ".repeat(GIT_DELIVERY_MAX_BODY_BYTES - Buffer.byteLength(body) + extraBytes)}`;
}

let root: string;
let events: ServerLogEvent[];
let diagnostics: ServerDiagnosticRecord[];
let deps: UiHandlerDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-git-init-"));
  const store = createInMemoryUiStore();
  store.createProject(root, "Fixture");
  events = [];
  diagnostics = [];
  deps = {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): ReturnType<UiHandlerDeps["evidenceStore"]["put"]> => "",
      list: (): ReturnType<UiHandlerDeps["evidenceStore"]["list"]> => [],
      get: (): ReturnType<UiHandlerDeps["evidenceStore"]["get"]> => undefined,
      delete: (): ReturnType<UiHandlerDeps["evidenceStore"]["delete"]> => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store,
    activityLog: { write: (event): void => void events.push(event) },
    diagnostics: {
      record: (record): void => {
        diagnostics.push(record);
      },
    },
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("repository initialization route", () => {
  it("constructs a fixed init command for the server-resolved selected project", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(result(128, "fatal: not a git repository"))
      .mockResolvedValueOnce(result(0));
    const handler = createHandleGitRepositoryInitialize({ runner });

    const response = await handler(context({ projectId: root, initialBranch: "main" }), deps);

    expect(response).toEqual({
      status: 200,
      body: { schemaVersion: "1", status: "succeeded", initialized: true },
    });
    expect(runner).toHaveBeenNthCalledWith(
      2,
      ["init", "--quiet", "--initial-branch=main"],
      expect.objectContaining({ cwd: root }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.repository.initialize",
        correlationId: CORRELATION_ID,
        status: 200,
        extra: { outcome: "succeeded" },
      }),
    );
    expect(JSON.stringify(events)).not.toContain(root);
  });

  it("rejects an existing repository before init can run", async () => {
    const runner = vi.fn<GitProcessRunner>().mockResolvedValueOnce(result(0, "", `${root}\n`));
    const handler = createHandleGitRepositoryInitialize({ runner });

    const response = await handler(context({ projectId: root, initialBranch: "main" }), deps);

    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: "GIT_REPOSITORY_ALREADY_INITIALIZED" } },
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown projects, alternate branches, and smuggled arguments", async () => {
    const runner = vi.fn<GitProcessRunner>();
    const handler = createHandleGitRepositoryInitialize({ runner });

    const unknown = await handler(
      context({ projectId: join(root, "missing"), initialBranch: "main" }),
      deps,
    );
    const branch = await handler(context({ projectId: root, initialBranch: "dev" }), deps);
    const argument = await handler(
      context({ projectId: root, initialBranch: "main", args: ["--bare"] }),
      deps,
    );

    expect(unknown.status).toBe(404);
    expect(branch.status).toBe(400);
    expect(argument.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(["", "{ malformed json"])(
    "rejects an unreadable body without invoking Git: %j",
    async (body) => {
      const runner = vi.fn<GitProcessRunner>();
      const response = await createHandleGitRepositoryInitialize({ runner })(
        rawContext(body),
        deps,
      );

      expect(response.status).toBe(400);
      expect(runner).not.toHaveBeenCalled();
      expect(events).toContainEqual(
        expect.objectContaining({
          correlationId: CORRELATION_ID,
          status: 400,
          extra: { outcome: "invalid-request" },
        }),
      );
    },
  );

  it("accepts a request exactly at the bounded body limit", async () => {
    const runner = vi.fn<GitProcessRunner>().mockResolvedValueOnce(result(0));
    const response = await createHandleGitRepositoryInitialize({ runner })(
      rawContext(boundedInitializationBody()),
      deps,
    );

    expect(response.status).toBe(409);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("rejects a request above the bounded body limit before invoking Git", async () => {
    const runner = vi.fn<GitProcessRunner>();
    const response = await createHandleGitRepositoryInitialize({ runner })(
      rawContext(boundedInitializationBody(1)),
      deps,
    );

    expect(response).toMatchObject({
      status: 413,
      body: { error: { code: "GIT_REPOSITORY_INITIALIZE_PAYLOAD_TOO_LARGE" } },
    });
    expect(runner).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ status: 413, extra: { outcome: "invalid-request" } }),
    );
  });

  it.each([
    [
      "timeout",
      { ...result(1), timedOut: true, truncated: true },
      504,
      "GIT_REPOSITORY_INITIALIZE_TIMEOUT",
    ],
    [
      "truncated output",
      { ...result(1), truncated: true },
      409,
      "GIT_REPOSITORY_INITIALIZE_FAILED",
    ],
  ] as const)("maps %s to a bounded failure response", async (_label, process, status, code) => {
    const runner = vi.fn<GitProcessRunner>().mockResolvedValueOnce(process);
    const response = await createHandleGitRepositoryInitialize({ runner })(
      context({ projectId: root, initialBranch: "main" }),
      deps,
    );

    expect(response).toMatchObject({ status, body: { error: { code } } });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("turns an unexpected runner exception into correlated body-free diagnostics", async () => {
    const runner = vi.fn<GitProcessRunner>().mockRejectedValueOnce(new Error("private path"));
    const handler = createHandleGitRepositoryInitialize({ runner });

    const response = await handler(context({ projectId: root, initialBranch: "main" }), deps);

    expect(response).toMatchObject({
      status: 500,
      body: { error: { code: "GIT_REPOSITORY_INITIALIZE_INTERNAL" } },
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        correlationId: CORRELATION_ID,
        operation: "POST /api/git-delivery/{id}/{id}",
        source: "git-repository-initialization-route",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        correlationId: CORRELATION_ID,
        status: 500,
        extra: { outcome: "execution-failed" },
      }),
    );
    expect(JSON.stringify({ diagnostics, events })).not.toContain("private path");
  });
});
