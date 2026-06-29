// Issue #1392 — security tests for the editor-agent BFF routes at the REAL HTTP boundary.
//
// These drive createUiServer (not the handlers directly) so the same-origin host check, the CSRF
// guard, and the JSON content-type gate all run live for the mutating routes (AC3). Workspace
// containment of an agent-supplied target file (AC4) is also asserted through the full guard chain,
// reusing the Issue #1394 OUT_OF_SCOPE containment gate. Mirrors the figmaSnapshotRoutes.test.ts
// harness (route tests must NOT bypass HTTP guards).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import { createUiServer, UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../index.js";
import { createRunRegistry } from "../runs.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { _resetEditorAgentStateForTests } from "./agentRoutes.js";

const HASH = "a".repeat(64);

let server: Server;
let staticRoot: string;
let port: number;

function makeDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
  };
}

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    srv.listen(0, UI_HOST, resolve);
  });
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

// Pin the port across a probe→close→reopen so the loopback Host header is accepted by the host check.
async function buildServer(): Promise<void> {
  const handlerDeps = makeDeps();
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  port = await listen(probe);
  await closeServer(probe);
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps });
  await new Promise<void>((resolve) => {
    server.listen(port, UI_HOST, resolve);
  });
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

function errorCodeOf(value: unknown): string | undefined {
  const body = value as { error?: { code?: unknown } };
  return typeof body.error?.code === "string" ? body.error.code : undefined;
}

function conflictCodeOf(value: unknown): string | undefined {
  const body = value as { result?: { conflict?: { code?: unknown } } };
  return typeof body.result?.conflict?.code === "string" ? body.result.conflict.code : undefined;
}

// Low-level request that can forge the Host header (undici/fetch forbids overriding it), to exercise
// the same-origin / DNS-rebinding host check on a mutating route.
function rawPostWithHost(
  path: string,
  hostHeader: string,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: UI_HOST,
        port,
        path,
        method: "POST",
        headers: { ...csrfHeaders(), Host: hostHeader },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function snapshotBody(): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    kind: "snapshot",
    snapshot: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      sessionId: "session-1",
      windowId: "window-1",
      workspaceRoot: "/repo",
      activePaneId: "pane-1",
      panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
      dirtyFiles: [],
      activeFile: "src/a.ts",
      cursor: null,
      selection: null,
      diagnosticsSummary: null,
      documentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
      activeFileContentHash: HASH,
      textMode: "none",
      updatedAt: 1,
    },
  };
}

function saveActionBody(file: string): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: "action-1",
    idempotencyKey: "idempotency-1",
    sessionId: "session-1",
    type: "save",
    target: { file },
    expectedContentHash: HASH,
  };
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-agent-routes-"));
  await buildServer();
});

afterEach(async () => {
  _resetEditorAgentStateForTests();
  await closeServer(server);
  await rm(staticRoot, { recursive: true, force: true });
});

describe("editor agent routes — HTTP security boundary (Issue #1392)", () => {
  it("rejects a snapshot POST without the CSRF header (403)", async () => {
    const res = await fetch(`${baseUrl()}/api/editor/agent/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshotBody()),
    });
    expect(res.status).toBe(403);
    expect(errorCodeOf(await res.json())).toBe("FORBIDDEN_CSRF");
  });

  it("rejects an action POST without the CSRF header (403)", async () => {
    const res = await fetch(`${baseUrl()}/api/editor/agent/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saveActionBody("src/a.ts")),
    });
    expect(res.status).toBe(403);
    expect(errorCodeOf(await res.json())).toBe("FORBIDDEN_CSRF");
  });

  it("rejects a non-JSON content type on a mutating route (415)", async () => {
    const res = await fetch(`${baseUrl()}/api/editor/agent/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Keiko-CSRF": "1" },
      body: "not json",
    });
    expect(res.status).toBe(415);
  });

  it("rejects a non-loopback Host header (403 FORBIDDEN_HOST)", async () => {
    const res = await rawPostWithHost(
      "/api/editor/agent/snapshot",
      "evil.example.com",
      JSON.stringify(snapshotBody()),
    );
    expect(res.status).toBe(403);
    expect(errorCodeOf(JSON.parse(res.text))).toBe("FORBIDDEN_HOST");
  });

  it("accepts a snapshot POST that carries the CSRF guard (200)", async () => {
    const res = await fetch(`${baseUrl()}/api/editor/agent/snapshot`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify(snapshotBody()),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an out-of-workspace target through the full guard chain (409 OUT_OF_SCOPE, AC4)", async () => {
    const registered = await fetch(`${baseUrl()}/api/editor/agent/snapshot`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify(snapshotBody()),
    });
    expect(registered.status).toBe(200);

    // Establish bridge liveness directly so the request under test exercises the containment branch
    // (not the upstream NO_ACTIVE_BRIDGE gate) over the real HTTP guard chain.
    const dispose = editorAgentRegistry.connect("session-1", () => undefined);
    try {
      const res = await fetch(`${baseUrl()}/api/editor/agent/actions`, {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify(saveActionBody("../../etc/passwd")),
      });
      expect(res.status).toBe(409);
      expect(conflictCodeOf(await res.json())).toBe("OUT_OF_SCOPE");
    } finally {
      dispose();
    }
  });
});
