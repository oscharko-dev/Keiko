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
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  EDITOR_AGENT_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
  validateCodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchAuthorityEnvelope,
  type EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { createUiServer, UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../index.js";
import { createRunRegistry } from "../runs.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { _resetEditorAgentStateForTests } from "./agentRoutes.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "./agentAuthorityRegistry.js";

const HASH = "a".repeat(64);

let server: Server;
let staticRoot: string;
let port: number;
let handlerDeps: UiHandlerDeps;
let authorityRef: EditorAgentGovernedAuthorityReference;

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
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
  };
}

function registerAuthority(root: string): EditorAgentGovernedAuthorityReference {
  const mode = "autonomous-delivery";
  const envelope: CodingWorkbenchAuthorityEnvelope = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-1392",
    localUser: "local-operator",
    taskRefs: ["issue-1392"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(root),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: mode,
    deploymentCeiling: mode,
    effectiveMode: resolveEffectiveCodingWorkbenchMode(mode, mode),
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "branch-allowlist"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 20,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    approvalProofDigest: HASH,
  };
  const validated = validateCodingWorkbenchAuthorityEnvelope(envelope);
  if (!validated.ok) throw new Error(validated.errors.join("; "));
  const result = editorAgentAuthorityRegistry.register(envelope, mode, new Date().toISOString());
  if (!result.ok) throw new Error(`expected authority registration: ${result.reason}`);
  return result.authorityRef;
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
  handlerDeps = makeDeps();
  handlerDeps.store.createProject(staticRoot, "Agent route security fixture");
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
      workspaceRoot: staticRoot,
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
    authorityRef,
  };
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-agent-routes-"));
  await buildServer();
  authorityRef = registerAuthority(staticRoot);
});

afterEach(async () => {
  _resetEditorAgentStateForTests();
  await closeServer(server);
  handlerDeps.store.close();
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

  it("rejects an out-of-workspace target through the full guard chain (403 OUT_OF_SCOPE, AC4)", async () => {
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
      const body: unknown = await res.json();
      expect({ status: res.status, conflictCode: conflictCodeOf(body) }).toEqual({
        status: 403,
        conflictCode: "OUT_OF_SCOPE",
      });
    } finally {
      dispose();
    }
  });
});
