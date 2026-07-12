import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  type EditorM7WorkspaceSnippetInput,
  type EditorM7WorkspaceSnippetSnapshot,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../../deps.js";
import { createRunRegistry } from "../../runs.js";
import { createInMemoryUiStore, type UiStore } from "../../store/index.js";
import { STREAMING, type RouteContext } from "../../routes.js";
import type {
  WorkspaceSnippetsChangeEvent,
  WorkspaceSnippetsService,
} from "./workspaceSnippetsService.js";
import {
  handleGetWorkspaceSnippets,
  handleMutateWorkspaceSnippets,
  handlePreviewWorkspaceSnippet,
  handleValidateWorkspaceSnippets,
  handleWorkspaceSnippetsEvents,
} from "./workspaceSnippetsRoutes.js";

let root = "";
let store: UiStore;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-snippet-routes-root-")));
  store = createInMemoryUiStore();
  store.createProject(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function snippet(): EditorM7WorkspaceSnippetInput {
  return {
    id: "log-value",
    name: "Log value",
    prefixes: ["logv"],
    description: "Log a selected value",
    languages: ["typescript"],
    include: ["src/**/*.ts"],
    body: ["console.log(${1:value});", "$0"],
  };
}

function snapshot(revision = 0): EditorM7WorkspaceSnippetSnapshot {
  const workspaceFingerprint = "abcdef1234567890";
  return {
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    storeState: revision === 0 ? "absent" : "ready",
    revision,
    etag: `"edsn-${String(revision)}-test"`,
    workspaceFingerprint,
    snippets:
      revision === 0
        ? []
        : [{ ...snippet(), revision, provenance: { source: "workspace", workspaceFingerprint } }],
  };
}

function fakeService(): WorkspaceSnippetsService & {
  readonly read: ReturnType<typeof vi.fn<WorkspaceSnippetsService["read"]>>;
  readonly mutate: ReturnType<typeof vi.fn<WorkspaceSnippetsService["mutate"]>>;
  emit: (event: WorkspaceSnippetsChangeEvent) => void;
} {
  const listeners = new Set<(event: WorkspaceSnippetsChangeEvent) => void>();
  return {
    stateDir: "/state",
    read: vi.fn(() => snapshot()),
    mutate: vi.fn(() =>
      Promise.resolve({
        kind: "ok",
        changed: true,
        revision: 1,
        etag: '"edsn-1-test"',
        snapshot: snapshot(1),
      }),
    ),
    completions: () => [],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event): void => {
      for (const listener of listeners) listener(event);
    },
  };
}

function deps(service: WorkspaceSnippetsService | undefined): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: () => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    env: {},
    redactor: (value: unknown) => value,
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    workspaceSnippets: service,
  };
}

function request(body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return Object.assign(Readable.from(chunks), { headers }) as IncomingMessage;
}

function context(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  res: ServerResponse = {} as ServerResponse,
): RouteContext {
  return {
    req: request(body, headers),
    res,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function mutationBody(action: "replace" | "reset" = "replace"): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
    root,
    expectedRevision: 0,
    action,
    ...(action === "replace" ? { snippets: [snippet()] } : {}),
  };
}

describe("workspace snippet routes", () => {
  it("returns no-store snapshots through a resolved workspace root", async () => {
    const service = fakeService();
    const result = await handleGetWorkspaceSnippets(
      context(`/api/editor/snippets?root=${encodeURIComponent(root)}`),
      deps(service),
    );

    expect(result).toMatchObject({ status: 200, body: snapshot() });
    expect(result.headers).toMatchObject({ ETag: '"edsn-0-test"', "Cache-Control": "no-store" });
    expect(service.read).toHaveBeenCalledWith(root);
  });

  it("fails closed when snippets are unavailable or the root is invalid", async () => {
    const unavailable = await handleGetWorkspaceSnippets(
      context(`/api/editor/snippets?root=${encodeURIComponent(root)}`),
      deps(undefined),
    );
    const invalidRoot = await handleGetWorkspaceSnippets(
      context("/api/editor/snippets"),
      deps(fakeService()),
    );

    expect(unavailable.status).toBe(503);
    expect(invalidRoot.status).toBe(400);
  });

  it("applies guarded mutations and maps conflicts without raw workspace content", async () => {
    const service = fakeService();
    const changed = await handleMutateWorkspaceSnippets(
      context("/api/editor/snippets", mutationBody(), {
        "idempotency-key": "replace-snippets",
        "if-match": '"edsn-0-test"',
      }),
      deps(service),
    );
    service.mutate.mockResolvedValueOnce({ kind: "conflict", code: "STALE_REVISION", etag: "v1" });
    const conflict = await handleMutateWorkspaceSnippets(
      context("/api/editor/snippets", mutationBody("reset"), {
        "idempotency-key": "reset-snippets",
        "if-match": '"edsn-0-test"',
      }),
      deps(service),
    );

    expect(changed).toMatchObject({ status: 200, body: { kind: "ok", revision: 1 } });
    expect(conflict).toMatchObject({ status: 409, headers: { ETag: "v1" } });
    expect(JSON.stringify(changed)).not.toContain(root);
  });

  it("rejects missing idempotency keys, mismatched etags, and reused request keys", async () => {
    const service = fakeService();
    service.mutate.mockResolvedValueOnce({
      kind: "idempotencyConflict",
      code: "IDEMPOTENCY_KEY_REUSED",
      etag: "v1",
    });
    const missingKey = await handleMutateWorkspaceSnippets(
      context("/api/editor/snippets", mutationBody(), { "if-match": '"edsn-0-test"' }),
      deps(service),
    );
    const staleHeader = await handleMutateWorkspaceSnippets(
      context("/api/editor/snippets", mutationBody(), {
        "idempotency-key": "replace-snippets",
        "if-match": '"edsn-1-test"',
      }),
      deps(service),
    );
    const reused = await handleMutateWorkspaceSnippets(
      context("/api/editor/snippets", mutationBody(), {
        "idempotency-key": "replace-snippets",
        "if-match": '"edsn-0-test"',
      }),
      deps(service),
    );

    expect(missingKey.status).toBe(400);
    expect(staleHeader.status).toBe(400);
    expect(reused).toMatchObject({ status: 409, headers: { ETag: "v1" } });
  });

  it("validates and previews snippets with bounded error bodies", async () => {
    const valid = await handleValidateWorkspaceSnippets(
      context("/api/editor/snippets/validate", {
        schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
        revision: 0,
        snippets: snapshot(1).snippets,
      }),
    );
    const invalid = await handleValidateWorkspaceSnippets(
      context("/api/editor/snippets/validate", { schemaVersion: "wrong" }),
    );
    const preview = await handlePreviewWorkspaceSnippet(
      context("/api/editor/snippets/preview", { body: ["value: ${1:name}", "$0"] }),
    );

    expect(valid).toMatchObject({ status: 200, body: { ok: true, snippetCount: 1 } });
    expect(invalid).toMatchObject({ status: 400, body: { ok: false } });
    expect(preview).toMatchObject({ status: 200, body: { ok: true } });
    expect(JSON.stringify(preview.body)).toContain("value:");
  });

  it("streams snippet change events and closes subscriptions on request close", () => {
    const service = fakeService();
    const chunks: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        chunks.push(chunk);
        return true;
      }),
    }) as unknown as ServerResponse;
    const eventContext = context("/api/editor/snippets/events", undefined, {}, res);
    const result = handleWorkspaceSnippetsEvents(eventContext, deps(service));

    service.emit({
      schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
      sequence: 1,
      workspaceFingerprint: "abcdef1234567890",
      revision: 1,
      action: "replace",
      snippetCount: 1,
    });
    eventContext.req.emit("close");

    expect(result).toBe(STREAMING);
    expect(chunks.join("")).toContain("event: ready");
    expect(chunks.join("")).toContain("editor-snippets:changed");
  });
});
