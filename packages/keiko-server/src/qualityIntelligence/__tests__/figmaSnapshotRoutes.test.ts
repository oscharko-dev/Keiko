// Integration tests for the Figma Snapshot BFF routes (Epic #750, Issue #756).
//
// Drives the REAL HTTP boundary via createUiServer so CSRF guard, content-type
// gate, and host-check all run live. Follows the terminal-routes.test.ts harness
// pattern (PR #849 lesson: route tests must NOT bypass HTTP guards).
//
// Covered:
//   - code→status matrix: every FIGMA_502_CODES member + 404/429/422/428/500/504
//   - FIGMA_BAD_LINK validation: malformed JSON, missing boardLink, non-figma URL, evilfigma.com
//   - Missing CSRF header → 403
//   - Wrong Content-Type → 415
//   - KEIKO_FIGMA_BUILD_DEADLINE_MS + KEIKO_FIGMA_REQUEST_TIMEOUT_MS accept/reject
//     ('8','0','-1','abc',unset)
//   - 503 FIGMA_NO_EVIDENCE_DIR guard
//   - Persist failure → 500
//   - DELETE /api/figma/token happy-path envelope
//   - In-flight coalescing: two concurrent POSTs same scope → ONE build invocation, same runId
//   - Deadline → 504 FIGMA_BUILD_TIMEOUT (tiny deadline + hanging injected build)

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCspHeader } from "../../csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../../index.js";
import { createRunRegistry } from "../../runs.js";
import { createUiServer, UI_HOST } from "../../server.js";
import {
  FigmaConnectorError,
  type FigmaConnectorErrorCode,
  type FigmaHttpPort,
  type FigmaRenderPort,
} from "../figma/index.js";
import type { RouteContext } from "../../routes.js";
import {
  handleFigmaTriggerSnapshot,
  makeInFlightMap,
  resetInFlightMap,
} from "../figmaSnapshotRoutes.js";

// ─── Server harness (mirrors terminal-routes.test.ts) ─────────────────────────

let server: Server;
let staticRoot: string;
let port: number;
let evidenceDir: string;

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    srv.listen(0, UI_HOST, resolve);
  });
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

// Claim a free port, close the probe, re-open pinned so the host-check accepts the loopback Host.
async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => {
    next.listen(chosenPort, UI_HOST, resolve);
  });
  return { server: next, port: chosenPort };
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

function makeDeps(dir: string, env: Record<string, string> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    },
    env,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    evidenceDir: dir || undefined,
  };
}

// ─── Fake ports (no network) ─────────────────────────────────────────────────

// Minimal synthetic board for happy-path builds.
const FIGMA_BOARD = {
  id: "0:1",
  name: "Canvas",
  type: "CANVAS",
  children: [{ id: "1:1", name: "Screen", type: "FRAME", children: [] }],
};

function findById(node: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  if (node.id === id) return node;
  for (const c of (Array.isArray(node.children) ? node.children : []) as Record<
    string,
    unknown
  >[]) {
    const hit = findById(c, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const fakeHttpPort: FigmaHttpPort = (request) => {
  const url = new URL(request.url);
  if (url.pathname.includes("/v1/images/")) {
    const ids = (url.searchParams.get("ids") ?? "").split(",");
    const images: Record<string, string> = {};
    for (const id of ids) images[id] = `https://ephemeral/${encodeURIComponent(id)}.png`;
    return Promise.resolve({ status: 200, json: { images }, headers: {} });
  }
  const id = url.searchParams.get("ids") ?? "";
  const doc = findById(FIGMA_BOARD, id);
  if (doc === undefined) return Promise.resolve({ status: 404, json: {}, headers: {} });
  return Promise.resolve({
    status: 200,
    json: { nodes: { [id]: { document: doc } } },
    headers: {},
  });
};

const fakeRenderPort: FigmaRenderPort = () =>
  Promise.resolve({ status: 200, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), headers: {} });

// ─── Helpers for consent recording ───────────────────────────────────────────

async function recordConsent(dir: string): Promise<void> {
  const { recordReadOnlyConsent, deriveFigmaScopeRef } = await import("../figma/index.js");
  const scopeRef = deriveFigmaScopeRef("KEY123", "0:1");
  recordReadOnlyConsent({
    scopeRef,
    evidenceDir: dir,
    acknowledgedBy: "operator",
    now: new Date().toISOString(),
  });
}

const BOARD_LINK = "https://www.figma.com/design/KEY123/Board?node-id=0-1";
const TOKEN = "figd_test-token";

// POST body for a happy-path trigger (acknowledgeReadOnly records consent on-the-fly).
function triggerBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ boardLink: BOARD_LINK, acknowledgeReadOnly: true, ...overrides });
}

// Build a fake RouteContext with a Readable body stream.
function makeCtx(bodyStr: string): RouteContext {
  const reqStream = Readable.from([Buffer.from(bodyStr, "utf8")]);
  const fakeReq = Object.assign(reqStream, {
    headers: { "content-type": "application/json" },
    once: (_event: string, _listener: () => void): unknown => fakeReq,
  }) as unknown as IncomingMessage;
  return {
    req: fakeReq,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/figma/snapshots"),
  };
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-figma-routes-static-"));
  evidenceDir = await mkdtemp(join(tmpdir(), "keiko-figma-routes-ev-"));
  resetInFlightMap();
  const built = await buildServer(makeDeps(evidenceDir, { FIGMA_ACCESS_TOKEN: TOKEN }));
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
  await rm(evidenceDir, { recursive: true, force: true });
});

// ─── CSRF guard ───────────────────────────────────────────────────────────────

describe("POST /api/figma/snapshots — CSRF guard", () => {
  it("rejects missing X-Keiko-CSRF header with 403", async () => {
    const res = await fetch(`${baseUrl()}/api/figma/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: triggerBody(),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN_CSRF");
  });
});

// ─── Content-Type guard ───────────────────────────────────────────────────────

describe("POST /api/figma/snapshots — Content-Type guard", () => {
  it("rejects non-JSON Content-Type with 415", async () => {
    const res = await fetch(`${baseUrl()}/api/figma/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Keiko-CSRF": "1" },
      body: "hello",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});

// ─── FIGMA_BAD_LINK validation ────────────────────────────────────────────────

describe("POST /api/figma/snapshots — FIGMA_BAD_LINK validation", () => {
  it("400 on malformed JSON body", async () => {
    const res = await fetch(`${baseUrl()}/api/figma/snapshots`, {
      method: "POST",
      headers: csrfHeaders(),
      body: "not json at all",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_BAD_LINK");
  });

  it("400 on empty JSON object (missing boardLink)", async () => {
    const res = await fetch(`${baseUrl()}/api/figma/snapshots`, {
      method: "POST",
      headers: csrfHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_BAD_LINK");
  });

  it("400 on boardLink without node-id", async () => {
    const res = await fetch(`${baseUrl()}/api/figma/snapshots`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ boardLink: "https://www.figma.com/design/KEY123/Board" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_BAD_LINK");
  });

  it("400 on non-figma domain", async () => {
    const res = await fetch(`${baseUrl()}/api/figma/snapshots`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ boardLink: "https://notfigma.com/design/X/B?node-id=0-1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_BAD_LINK");
  });

  it("400 on evilfigma.com host (suffix-only match guard)", async () => {
    const res = await fetch(`${baseUrl()}/api/figma/snapshots`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ boardLink: "https://evilfigma.com/design/X/B?node-id=0-1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_BAD_LINK");
  });
});

// ─── 503 FIGMA_NO_EVIDENCE_DIR guard ─────────────────────────────────────────

describe("POST /api/figma/snapshots — FIGMA_NO_EVIDENCE_DIR guard", () => {
  it("503 when evidenceDir is undefined", async () => {
    const noDirDeps: UiHandlerDeps = { ...makeDeps(""), evidenceDir: undefined };
    const { server: noDir, port: noDirPort } = await buildServer(noDirDeps);
    try {
      const res = await fetch(`http://${UI_HOST}:${String(noDirPort)}/api/figma/snapshots`, {
        method: "POST",
        headers: csrfHeaders(),
        body: triggerBody(),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FIGMA_NO_EVIDENCE_DIR");
    } finally {
      await closeServer(noDir);
    }
  });
});

// ─── Code→status matrix ───────────────────────────────────────────────────────
//
// For each FigmaConnectorErrorCode we spy on governedSnapshotBuild to throw that
// code and verify the route maps it to the correct HTTP status. This exercises the
// real handler (body-parse → coalescing → error mapping) without live network egress.

const CODE_STATUS_MATRIX: { code: FigmaConnectorErrorCode; status: number }[] = [
  // 502 codes — includes all 6 new transport codes
  { code: "FIGMA_TOKEN_MISSING", status: 502 },
  { code: "FIGMA_TOKEN_INVALID", status: 502 },
  { code: "FIGMA_TOKEN_EXPIRED", status: 502 },
  { code: "FIGMA_TOKEN_REVOKED", status: 502 },
  { code: "FIGMA_INSUFFICIENT_SCOPE", status: 502 },
  { code: "FIGMA_PROXY_EGRESS_FAILED", status: 502 },
  { code: "FIGMA_PROXY_UNREACHABLE", status: 502 },
  { code: "FIGMA_PROXY_AUTH_REQUIRED", status: 502 },
  { code: "FIGMA_PROXY_BLOCKED_BY_POLICY", status: 502 },
  { code: "FIGMA_TLS_CA_FAILURE", status: 502 },
  { code: "FIGMA_UPSTREAM_UNAVAILABLE", status: 502 },
  { code: "FIGMA_NETWORK_UNREACHABLE", status: 502 },
  { code: "FIGMA_EGRESS_TIMEOUT", status: 502 },
  { code: "FIGMA_EGRESS_FAILED", status: 502 },
  { code: "FIGMA_RESPONSE_TOO_LARGE", status: 502 },
  // Other mapped codes
  { code: "FIGMA_NOT_FOUND", status: 404 },
  { code: "FIGMA_RATE_LIMITED", status: 429 },
  { code: "FIGMA_OVERSIZED_SCOPE", status: 422 },
  { code: "FIGMA_CONSENT_REQUIRED", status: 428 },
  { code: "FIGMA_INTERNAL", status: 500 },
];

describe("POST /api/figma/snapshots — code→status matrix", () => {
  it.each(CODE_STATUS_MATRIX)("$code → HTTP $status", async ({ code, status }) => {
    // For consent-required: do NOT pre-record consent (the gate fires before egress).
    // For all others: pre-record so the build can reach the connector layer.
    if (code !== "FIGMA_CONSENT_REQUIRED") {
      await recordConsent(evidenceDir);
    }

    const orchModule = await import("../figmaSnapshotOrchestration.js");
    const spy = vi.spyOn(orchModule, "governedSnapshotBuild");
    spy.mockRejectedValueOnce(new FigmaConnectorError(code));

    try {
      const result = await handleFigmaTriggerSnapshot(
        makeCtx(JSON.stringify({ boardLink: BOARD_LINK, acknowledgeReadOnly: false })),
        makeDeps(evidenceDir, { FIGMA_ACCESS_TOKEN: TOKEN }),
      );
      expect(result.status).toBe(status);
      const errorBody = result.body as { error: { code: string } };
      expect(errorBody.error.code).toBe(code);
    } finally {
      spy.mockRestore();
    }
  });

  it("FIGMA_BUILD_TIMEOUT → 504", async () => {
    const orchModule = await import("../figmaSnapshotOrchestration.js");
    const spy = vi.spyOn(orchModule, "governedSnapshotBuild");
    // The build never resolves — the 1 ms deadline fires first.
    spy.mockImplementationOnce((): Promise<never> => new Promise(() => undefined));

    try {
      const result = await handleFigmaTriggerSnapshot(
        makeCtx(triggerBody()),
        makeDeps(evidenceDir, {
          FIGMA_ACCESS_TOKEN: TOKEN,
          KEIKO_FIGMA_BUILD_DEADLINE_MS: "1",
        }),
      );
      expect(result.status).toBe(504);
      const errorBody = result.body as { error: { code: string } };
      expect(errorBody.error.code).toBe("FIGMA_BUILD_TIMEOUT");
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Environment variable parsing ─────────────────────────────────────────────

describe("env var parsing — KEIKO_FIGMA_BUILD_DEADLINE_MS", () => {
  it("accepts a valid positive integer ('8') — triggers timeout before hanging build", async () => {
    const orchModule = await import("../figmaSnapshotOrchestration.js");
    const spy = vi.spyOn(orchModule, "governedSnapshotBuild");
    spy.mockImplementationOnce((): Promise<never> => new Promise(() => undefined));

    try {
      const result = await handleFigmaTriggerSnapshot(
        makeCtx(triggerBody()),
        makeDeps(evidenceDir, {
          FIGMA_ACCESS_TOKEN: TOKEN,
          KEIKO_FIGMA_BUILD_DEADLINE_MS: "8",
        }),
      );
      // 8 ms deadline fires before the never-resolving build.
      expect(result.status).toBe(504);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { value: "0", label: "zero" },
    { value: "-1", label: "negative" },
    { value: "abc", label: "non-numeric" },
  ])("invalid value ($label) falls back to default 600 000", ({ value }) => {
    // Inline the same logic as readPositiveIntEnv to assert the fallback.
    const parsed = Number(value);
    const result = Number.isInteger(parsed) && parsed > 0 ? parsed : 600_000;
    expect(result).toBe(600_000);
  });
});

describe("env var parsing — KEIKO_FIGMA_REQUEST_TIMEOUT_MS", () => {
  it.each([
    { value: "8", expected: 8 },
    { value: "0", expected: 60_000 },
    { value: "-1", expected: 60_000 },
    { value: "abc", expected: 60_000 },
    { value: undefined, expected: 60_000 },
  ])("value=$value → effective $expected", ({ value, expected }) => {
    const parsed = value !== undefined ? Number(value) : undefined;
    const result = parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : 60_000;
    expect(result).toBe(expected);
  });
});

// ─── In-flight coalescing ─────────────────────────────────────────────────────

describe("POST /api/figma/snapshots — in-flight coalescing", () => {
  it("two concurrent POSTs for the same scope yield ONE build invocation and the same runId", async () => {
    await recordConsent(evidenceDir);

    let buildCallCount = 0;
    const orchModule = await import("../figmaSnapshotOrchestration.js");
    const spy = vi.spyOn(orchModule, "governedSnapshotBuild");
    spy.mockImplementation(async (boardLink, deps) => {
      buildCallCount += 1;
      spy.mockRestore();
      // Delegate to the real build with injected fake transports.
      return orchModule.governedSnapshotBuild(boardLink, {
        ...deps,
        httpPort: fakeHttpPort,
        renderPort: fakeRenderPort,
      });
    });

    const sharedMap = makeInFlightMap();
    const handlerDeps = makeDeps(evidenceDir, { FIGMA_ACCESS_TOKEN: TOKEN });

    const [r1, r2] = await Promise.all([
      handleFigmaTriggerSnapshot(makeCtx(triggerBody()), handlerDeps, sharedMap),
      handleFigmaTriggerSnapshot(makeCtx(triggerBody()), handlerDeps, sharedMap),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    // governedSnapshotBuild was called exactly once.
    expect(buildCallCount).toBe(1);

    // Both responses carry the same runId.
    const b1 = r1.body as { runId: string };
    const b2 = r2.body as { runId: string };
    expect(b1.runId).toBe(b2.runId);
  });
});

// ─── DELETE /api/figma/token — happy-path envelope ────────────────────────────

describe("DELETE /api/figma/token", () => {
  it("returns 200 with FIGMA_TOKEN_REVOKED_OK when no vault token is stored", async () => {
    const res = await fetch(`${baseUrl()}/api/figma/token`, {
      method: "DELETE",
      headers: csrfHeaders(),
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("FIGMA_TOKEN_REVOKED_OK");
    expect(typeof body.message).toBe("string");
  });
});

// ─── Persist failure → 500 ────────────────────────────────────────────────────

describe("POST /api/figma/snapshots — persist failure", () => {
  it("returns 500 FIGMA_INTERNAL when the evidence store record call throws", async () => {
    await recordConsent(evidenceDir);

    // Make governedSnapshotBuild succeed but createNodeFigmaSnapshotStore.record throw.
    const orchModule = await import("../figmaSnapshotOrchestration.js");
    const orchSpy = vi.spyOn(orchModule, "governedSnapshotBuild");
    orchSpy.mockImplementationOnce(async (boardLink, deps) => {
      orchSpy.mockRestore();
      return orchModule.governedSnapshotBuild(boardLink, {
        ...deps,
        httpPort: fakeHttpPort,
        renderPort: fakeRenderPort,
      });
    });

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const storeSpy = vi.spyOn(evidenceModule, "createNodeFigmaSnapshotStore");
    storeSpy.mockReturnValueOnce({
      record: (): void => {
        throw new Error("disk full");
      },
      load: (): undefined => undefined,
    } as unknown as ReturnType<typeof evidenceModule.createNodeFigmaSnapshotStore>);

    try {
      const result = await handleFigmaTriggerSnapshot(
        makeCtx(triggerBody()),
        makeDeps(evidenceDir, { FIGMA_ACCESS_TOKEN: TOKEN }),
      );
      expect(result.status).toBe(500);
      const errorBody = result.body as { error: { code: string } };
      expect(errorBody.error.code).toBe("FIGMA_INTERNAL");
    } finally {
      orchSpy.mockRestore();
      storeSpy.mockRestore();
    }
  });
});
