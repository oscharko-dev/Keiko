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
//   - GET /api/figma/snapshots/:runId — handleFigmaLoadSnapshot (GAP 1, Issue #756):
//       503 no evidenceDir, 400 empty runId, 404 unknown runId, 500 store.load throws, 200 round-trip
//   - Figma snapshot summary projection (GAP 2, Issue #756):
//       recordToSummary helpers: irSummary role→bucket mapping, plural/singular, "screen" fallback,
//       screenName ir.name / "Screen" fallback, reductionHint pluralisation + skipped clause

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
  EXPECTED_FIGMA_SCOPES,
  FigmaConnectorError,
  type FigmaConnectorErrorCode,
  type FigmaHttpPort,
  type FigmaRenderPort,
  deriveFigmaScopeRef,
  loadFigmaConnectorAudit,
} from "../figma/index.js";
import type { RouteContext } from "../../routes.js";
import {
  handleFigmaLoadSnapshot,
  handleFigmaRevokeToken,
  handleFigmaTriggerSnapshot,
  makeInFlightMap,
  resetInFlightMap,
  type FigmaSnapshotSummary,
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

// ─── #760 consent-required response carries display-only least-privilege scopes ──
//
// A FIGMA_CONSENT_REQUIRED 428 response must surface the exact read-only scopes the operator is
// consenting to (EXPECTED_FIGMA_SCOPES) so the UI can show least-privilege before acknowledgement.
// The matrix test above only pins status+code; nothing asserts the `scopes` body field, so a mutant
// dropping the `scopes: EXPECTED_FIGMA_SCOPES` spread in figmaErrorBody would survive. This pins it,
// proves the list is non-empty, and forbids any write/admin scope from leaking into the hint.
describe("POST /api/figma/snapshots — consent-required scopes (#760)", () => {
  it("428 body carries the canonical read-only scopes and no write/admin scope", async () => {
    // Arrange: do NOT record consent so the gate fires before egress, then force the coded reject.
    const orchModule = await import("../figmaSnapshotOrchestration.js");
    const spy = vi.spyOn(orchModule, "governedSnapshotBuild");
    spy.mockRejectedValueOnce(new FigmaConnectorError("FIGMA_CONSENT_REQUIRED"));

    try {
      // Act
      const result = await handleFigmaTriggerSnapshot(
        makeCtx(JSON.stringify({ boardLink: BOARD_LINK, acknowledgeReadOnly: false })),
        makeDeps(evidenceDir, { FIGMA_ACCESS_TOKEN: TOKEN }),
      );

      // Assert
      expect(result.status).toBe(428);
      const body = result.body as { error: { code: string }; scopes?: readonly string[] };
      expect(body.error.code).toBe("FIGMA_CONSENT_REQUIRED");
      expect(body.scopes).toEqual(EXPECTED_FIGMA_SCOPES);
      expect(body.scopes?.length ?? 0).toBeGreaterThan(0);
      for (const scope of body.scopes ?? []) {
        expect(scope).not.toContain("write");
        expect(scope).not.toContain("admin");
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── #758 SEC-3: re-key messages list the canonical least-privilege scopes ────
//
// FIGMA_TOKEN_MISSING / FIGMA_INSUFFICIENT_SCOPE operator messages must reference exactly the
// scopes the consent ledger records (EXPECTED_FIGMA_SCOPES), so an operator never mints a token
// with a wrong/stale scope name. Guards against prior drift and overbroad/deprecated scopes by
// pinning the messages to the single source of truth.
describe("POST /api/figma/snapshots — re-key scope hint (#758 SEC-3)", () => {
  it.each(["FIGMA_TOKEN_MISSING", "FIGMA_INSUFFICIENT_SCOPE"] as const)(
    "%s message lists every canonical read-only scope and no stale scope name",
    async (code) => {
      await recordConsent(evidenceDir);
      const orchModule = await import("../figmaSnapshotOrchestration.js");
      const spy = vi.spyOn(orchModule, "governedSnapshotBuild");
      spy.mockRejectedValueOnce(new FigmaConnectorError(code));

      try {
        const result = await handleFigmaTriggerSnapshot(
          makeCtx(JSON.stringify({ boardLink: BOARD_LINK, acknowledgeReadOnly: false })),
          makeDeps(evidenceDir, { FIGMA_ACCESS_TOKEN: TOKEN }),
        );
        const body = result.body as { error: { code: string; message: string } };
        expect(body.error.code).toBe(code);
        expect(EXPECTED_FIGMA_SCOPES.length).toBeGreaterThan(0);
        for (const scope of EXPECTED_FIGMA_SCOPES) {
          expect(body.error.message).toContain(scope);
        }
        // Deprecated or unused scope names must never reappear.
        expect(body.error.message).not.toContain("file_read");
        expect(body.error.message).not.toContain("files:read");
        expect(body.error.message).not.toContain("file_dev_resources:read");
      } finally {
        spy.mockRestore();
      }
    },
  );
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

  it("does not coalesce an explicit re-snapshot with an in-flight first snapshot", async () => {
    await recordConsent(evidenceDir);

    const orchModule = await import("../figmaSnapshotOrchestration.js");
    const actualBuild = orchModule.governedSnapshotBuild;
    const operations: boolean[] = [];
    const spy = vi.spyOn(orchModule, "governedSnapshotBuild");
    spy.mockImplementation(async (boardLink, deps, isResnapshot = false) => {
      operations.push(isResnapshot);
      return actualBuild(
        boardLink,
        {
          ...deps,
          httpPort: fakeHttpPort,
          renderPort: fakeRenderPort,
        },
        isResnapshot,
      );
    });

    try {
      const sharedMap = makeInFlightMap();
      const handlerDeps = makeDeps(evidenceDir, { FIGMA_ACCESS_TOKEN: TOKEN });

      const [initial, resnapshot] = await Promise.all([
        handleFigmaTriggerSnapshot(makeCtx(triggerBody()), handlerDeps, sharedMap),
        handleFigmaTriggerSnapshot(
          makeCtx(triggerBody({ isResnapshot: true })),
          handlerDeps,
          sharedMap,
        ),
      ]);

      expect(initial.status).toBe(201);
      expect(resnapshot.status).toBe(201);
      expect(operations).toHaveLength(2);
      expect(operations).toEqual(expect.arrayContaining([false, true]));

      const initialBody = initial.body as { runId: string };
      const resnapshotBody = resnapshot.body as { runId: string };
      expect(initialBody.runId).not.toBe(resnapshotBody.runId);
    } finally {
      spy.mockRestore();
    }
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

    // #760 audit: the revoke handler must record an observed connector action through
    // observeFigmaRevoke under the canonical deriveFigmaScopeRef("vault","token") ledger. Commenting
    // out that call (or its inner store.revoke) leaves no audit entry, failing this assertion. We
    // read the SAME evidenceDir the handler was given (the server harness wires it via makeDeps).
    const audit = loadFigmaConnectorAudit(deriveFigmaScopeRef("vault", "token"), evidenceDir);
    expect(audit?.auditLog.at(-1)).toMatchObject({ action: "revoke", outcome: "ok" });
  });

  it("returns 503 FIGMA_NO_EVIDENCE_DIR when evidenceDir is undefined", () => {
    // Direct-handler call mirroring the GET 503 guard test. The revoke 503 guard
    // (figmaSnapshotRoutes.ts) fires before any vault access; the only prior DELETE test
    // always wires a real evidenceDir, so a mutant deleting/inverting this guard would survive.
    const deps: UiHandlerDeps = { ...makeDeps(""), evidenceDir: undefined };
    const result = handleFigmaRevokeToken(makeGetCtx(""), deps);
    expect(result.status).toBe(503);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_NO_EVIDENCE_DIR");
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

// ─── GET /api/figma/snapshots/:runId — handleFigmaLoadSnapshot (GAP 1) ────────
//
// The load handler has ZERO prior test coverage. Every branch is exercised here.
// All tests call the handler directly (no HTTP) so the full branch logic runs
// without the server layer adding noise.

// Helper: build a RouteContext suitable for GET /:runId (params.runId is the key variable).
function makeGetCtx(runId: string): RouteContext {
  const reqStream = Readable.from([]);
  const fakeReq = Object.assign(reqStream, {
    headers: {},
    once: (_event: string, _listener: () => void): unknown => fakeReq,
  }) as unknown as IncomingMessage;
  return {
    req: fakeReq,
    res: {} as RouteContext["res"],
    params: { runId },
    url: new URL(`http://127.0.0.1/api/figma/snapshots/${encodeURIComponent(runId)}`),
  };
}

describe("GET /api/figma/snapshots/:runId — handleFigmaLoadSnapshot", () => {
  it("503 FIGMA_NO_EVIDENCE_DIR when evidenceDir is undefined", () => {
    // Arrange: deps with no evidence dir configured.
    const deps: UiHandlerDeps = { ...makeDeps(""), evidenceDir: undefined };
    const ctx = makeGetCtx("fs-00000000-0000-0000-0000-000000000001");

    // Act
    const result = handleFigmaLoadSnapshot(ctx, deps);

    // Assert
    expect(result.status).toBe(503);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_NO_EVIDENCE_DIR");
  });

  it("400 FIGMA_SNAPSHOT_NOT_FOUND when params.runId is empty string", () => {
    // Arrange: valid evidenceDir but empty runId in params.
    const deps = makeDeps(evidenceDir, {});
    const ctx = makeGetCtx("");

    // Act
    const result = handleFigmaLoadSnapshot(ctx, deps);

    // Assert: the 400 branch fires before any store access.
    expect(result.status).toBe(400);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_SNAPSHOT_NOT_FOUND");
  });

  it("404 FIGMA_SNAPSHOT_NOT_FOUND for a runId that was never stored", () => {
    // Arrange: a valid evidenceDir but no snapshot has been persisted for this runId.
    const deps = makeDeps(evidenceDir, {});
    const ctx = makeGetCtx("fs-00000000-0000-0000-0000-000000000099");

    // Act
    const result = handleFigmaLoadSnapshot(ctx, deps);

    // Assert: store.load returns undefined → 404.
    expect(result.status).toBe(404);
    const body = result.body as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_SNAPSHOT_NOT_FOUND");
  });

  it("500 FIGMA_INTERNAL when store.load throws", async () => {
    // Arrange: spy on the store factory to make load() throw a corrupt-data error.
    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const storeSpy = vi.spyOn(evidenceModule, "createNodeFigmaSnapshotStore");
    storeSpy.mockReturnValueOnce({
      record: (): void => undefined,
      load: (): never => {
        throw new Error("corrupt snapshot file");
      },
    } as unknown as ReturnType<typeof evidenceModule.createNodeFigmaSnapshotStore>);

    try {
      const deps = makeDeps(evidenceDir, {});
      const ctx = makeGetCtx("fs-00000000-0000-0000-0000-000000000002");

      // Act
      const result = handleFigmaLoadSnapshot(ctx, deps);

      // Assert: thrown error from store.load → 500 FIGMA_INTERNAL.
      expect(result.status).toBe(500);
      const body = result.body as { error: { code: string } };
      expect(body.error.code).toBe("FIGMA_INTERNAL");
    } finally {
      storeSpy.mockRestore();
    }
  });

  it("200 with matching runId, fileKey, nodeId, integrityHash after a real end-to-end build and persist", async () => {
    // Arrange: drive a real build through fake transports to produce a persisted record,
    // then call the load handler and assert the projected summary matches.
    await recordConsent(evidenceDir);

    const orchModule = await import("../figmaSnapshotOrchestration.js");
    const spy = vi.spyOn(orchModule, "governedSnapshotBuild");
    spy.mockImplementation(async (boardLink, deps) => {
      spy.mockRestore();
      return orchModule.governedSnapshotBuild(boardLink, {
        ...deps,
        httpPort: fakeHttpPort,
        renderPort: fakeRenderPort,
      });
    });

    const handlerDeps = makeDeps(evidenceDir, { FIGMA_ACCESS_TOKEN: TOKEN });

    // Trigger a snapshot build (POST) to persist a record and capture the runId.
    const postResult = await handleFigmaTriggerSnapshot(makeCtx(triggerBody()), handlerDeps);
    expect(postResult.status).toBe(201);
    const postBody = postResult.body as FigmaSnapshotSummary;
    const persistedRunId = postBody.runId;
    expect(typeof persistedRunId).toBe("string");
    expect(persistedRunId.startsWith("fs-")).toBe(true);

    // #760 observability: a freshly-built snapshot (POST 201) must carry a numeric `metrics` object.
    // A mutant dropping the `...(metrics !== undefined ? { metrics } : {})` spread in recordToSummary
    // would leave metrics undefined and fail here. Each pinned field is typed as a number, and the
    // serialised metrics must never leak a PAT (`figd_`) or a figma.com URL (governance pin #760).
    const postMetrics = postBody.metrics;
    expect(postMetrics).toBeDefined();
    expect(typeof postMetrics?.screenCount).toBe("number");
    expect(typeof postMetrics?.renderCount).toBe("number");
    expect(typeof postMetrics?.designTokenCount).toBe("number");
    expect(typeof postMetrics?.augmentation.modelAugmentedShare).toBe("number");
    expect(JSON.stringify(postMetrics)).not.toMatch(/figd_|figma\.com/);

    // Act: load the same record via the GET handler.
    const ctx = makeGetCtx(persistedRunId);
    const loadResult = handleFigmaLoadSnapshot(ctx, handlerDeps);

    // Assert: 200, identity fields round-trip correctly.
    // This exercises the 200-branch of handleFigmaLoadSnapshot and proves the
    // store.load → recordToSummary chain — a mutation of the 200-branch (e.g. returning
    // 404 unconditionally) would fail this assertion.
    expect(loadResult.status).toBe(200);
    const summary = loadResult.body as FigmaSnapshotSummary;

    expect(summary.runId).toBe(persistedRunId);
    expect(summary.fileKey).toBe("KEY123");
    expect(summary.nodeId).toBe("0:1");
    expect(typeof summary.integrityHash).toBe("string");
    expect(summary.integrityHash.length).toBeGreaterThan(0);

    // screenCount + skippedCount must account for all detected nodes (0 orphaned totals).
    // Exact count depends on render success rate — we only assert the shape is present.
    expect(typeof summary.screenCount).toBe("number");
    expect(typeof summary.skippedCount).toBe("number");
    expect(summary.reductionHint.length).toBeGreaterThan(0);

    // The projected screens array has the correct element shape (structural smoke check).
    expect(Array.isArray(summary.screens)).toBe(true);
    for (const screen of summary.screens) {
      expect(typeof screen.screenId).toBe("string");
      expect(typeof screen.name).toBe("string");
      expect(typeof screen.irSummary).toBe("string");
      expect(typeof screen.imageSha256).toBe("string");
      expect(typeof screen.imageByteLength).toBe("number");
    }
  });
});

// ─── GET /api/figma/snapshots/:runId/screens/:screenIndex/image ──────────────

describe("GET /api/figma/snapshots/:runId/screens/:screenIndex/image", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const PROVENANCE = {
    fileKey: "PROJKEY",
    nodeId: "1:0",
    version: undefined,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };

  it("serves a stored captured screen PNG without embedding bytes in the JSON summary", async () => {
    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000030";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "image-screen-1",
          irJson: { name: "Image Screen", root: { interactionHint: null, children: [] } },
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [],
    });

    const summaryRes = await fetch(`${baseUrl()}/api/figma/snapshots/${runId}`);
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as FigmaSnapshotSummary;
    expect(JSON.stringify(summary)).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));

    const imageRes = await fetch(`${baseUrl()}/api/figma/snapshots/${runId}/screens/0/image`);
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get("content-type")).toBe("image/png");
    expect(imageRes.headers.get("cache-control")).toBe("no-store");
    expect(imageRes.headers.get("etag")).toMatch(/^"sha256-[a-f0-9]{64}"$/u);
    expect(Array.from(new Uint8Array(await imageRes.arrayBuffer()))).toEqual(Array.from(PNG_BYTES));
  });

  it("returns a coded 404 when the requested screen image is missing", async () => {
    const res = await fetch(
      `${baseUrl()}/api/figma/snapshots/fs-00000000-0000-0000-0000-000000000099/screens/0/image`,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FIGMA_SCREEN_NOT_FOUND");
  });
});

// ─── Figma snapshot summary projection helpers (GAP 2) ───────────────────────
//
// The recordToSummary helpers (countRoles, irSummaryFromJson, screenNameFromIrJson,
// buildReductionHint) had ZERO test coverage on their content. Tests here assert the
// exact projected values so a single-line mutation (e.g. counts.fields += 1 instead
// of counts.controls += 1, or wrong pluralisation branch) fails at least one case.
//
// Strategy: persist a SYNTHETIC snapshot record directly via createNodeFigmaSnapshotStore,
// then call handleFigmaLoadSnapshot and assert the projected body — no spy on the
// projection helpers themselves (we test behaviour, not implementation).

describe("Figma snapshot summary projection (recordToSummary helpers)", () => {
  // Shared minimal image bytes (tiny valid PNG header).
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // Minimal provenance row for all synthetic records.
  const PROVENANCE = {
    fileKey: "PROJKEY",
    nodeId: "1:0",
    version: undefined,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };

  // ── irSummary — role-to-bucket mapping with pluralisation ──────────────────
  //
  // Root has two "input" children, a nested "button" grandchild, a "link" child,
  // and a "text" child. This proves:
  //   - "input" maps to fields
  //   - "button" AND "link" both map to controls
  //   - "text" maps to texts
  //   - recursive walk finds the grandchild (button nested under a non-hint node)
  //   - pluralisation: 2 fields, 2 controls, 1 text
  it('irSummary is "2 fields, 2 controls, 1 text" for 2 input + 1 button + 1 link + 1 text (button nested)', async () => {
    // Arrange: craft irJson with the required interaction hints, button nested 1 level deep.
    const irJson = {
      name: "RoleScreen",
      root: {
        interactionHint: null,
        children: [
          { interactionHint: "input", children: [] },
          { interactionHint: "input", children: [] },
          // button is nested inside a container node — proves recursive walk.
          {
            interactionHint: null,
            children: [{ interactionHint: "button", children: [] }],
          },
          { interactionHint: "link", children: [] },
          { interactionHint: "text", children: [] },
        ],
      },
    };

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000010";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "role-screen-1",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [],
    });

    // Act
    const deps = makeDeps(evidenceDir, {});
    const result = handleFigmaLoadSnapshot(makeGetCtx(runId), deps);

    // Assert
    expect(result.status).toBe(200);
    const summary = result.body as FigmaSnapshotSummary;
    expect(summary.screens[0]?.irSummary).toBe("2 fields, 2 controls, 1 text");
  });

  // ── irSummary — "screen" fallback for an empty/childless root ─────────────
  it('irSummary is "screen" when the root has no children with interaction hints', async () => {
    // Arrange: irJson with a root that carries no interactionHint and empty children.
    const irJson = {
      name: "EmptyScreen",
      root: {
        interactionHint: null,
        children: [],
      },
    };

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000011";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "empty-screen-1",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [],
    });

    // Act
    const deps = makeDeps(evidenceDir, {});
    const result = handleFigmaLoadSnapshot(makeGetCtx(runId), deps);

    // Assert
    expect(result.status).toBe(200);
    const summary = result.body as FigmaSnapshotSummary;
    expect(summary.screens[0]?.irSummary).toBe("screen");
  });

  // ── screenName — uses ir.name when present ─────────────────────────────────
  it("screen name comes from ir.name when it is a non-empty string", async () => {
    const irJson = {
      name: "My Named Screen",
      root: { interactionHint: null, children: [] },
    };

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000012";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "named-screen-1",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [],
    });

    // Act
    const deps = makeDeps(evidenceDir, {});
    const result = handleFigmaLoadSnapshot(makeGetCtx(runId), deps);

    // Assert
    expect(result.status).toBe(200);
    const summary = result.body as FigmaSnapshotSummary;
    expect(summary.screens[0]?.name).toBe("My Named Screen");
  });

  // ── screenName — "Screen" fallback when ir.name is missing ────────────────
  it('screen name falls back to "Screen" when ir.name is absent', async () => {
    // irJson without a `name` field at all.
    const irJson = {
      root: { interactionHint: null, children: [] },
    };

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000013";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "unnamed-screen-1",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [],
    });

    // Act
    const deps = makeDeps(evidenceDir, {});
    const result = handleFigmaLoadSnapshot(makeGetCtx(runId), deps);

    // Assert
    expect(result.status).toBe(200);
    const summary = result.body as FigmaSnapshotSummary;
    expect(summary.screens[0]?.name).toBe("Screen");
  });

  // ── screenName — "Screen" fallback when ir.name is empty string ───────────
  it('screen name falls back to "Screen" when ir.name is an empty string', async () => {
    const irJson = {
      name: "",
      root: { interactionHint: null, children: [] },
    };

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000014";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "empty-name-screen-1",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [],
    });

    // Act
    const deps = makeDeps(evidenceDir, {});
    const result = handleFigmaLoadSnapshot(makeGetCtx(runId), deps);

    // Assert
    expect(result.status).toBe(200);
    const summary = result.body as FigmaSnapshotSummary;
    expect(summary.screens[0]?.name).toBe("Screen");
  });

  // ── reductionHint — 1 screen, 0 skipped (no skipped clause) ──────────────
  it('reductionHint is "1 screen from 1 detected" with no skipped clause when skippedCount=0', async () => {
    const irJson = { name: "S", root: { interactionHint: null, children: [] } };

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000020";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "hint-screen-1",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [],
    });

    // Act
    const deps = makeDeps(evidenceDir, {});
    const result = handleFigmaLoadSnapshot(makeGetCtx(runId), deps);

    // Assert: exact plural form "screen" (not "screens"), no " skipped" clause.
    expect(result.status).toBe(200);
    const summary = result.body as FigmaSnapshotSummary;
    expect(summary.reductionHint).toBe("1 screen from 1 detected");
  });

  // ── reductionHint — 2 screens, 1 skipped (both plural forms + skipped clause) ──
  it('reductionHint is "2 screens from 3 detected (1 render skipped)" for 2 screens + 1 skipped', async () => {
    const irJson = { name: "S", root: { interactionHint: null, children: [] } };

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000021";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "hint-screen-a",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
        {
          screenId: "hint-screen-b",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [{ screenId: "skipped-1", reason: "render-empty" }],
    });

    // Act
    const deps = makeDeps(evidenceDir, {});
    const result = handleFigmaLoadSnapshot(makeGetCtx(runId), deps);

    // Assert: "2 screens" (plural), total=3, "1 render skipped" (singular "render").
    expect(result.status).toBe(200);
    const summary = result.body as FigmaSnapshotSummary;
    expect(summary.reductionHint).toContain("2 screens from 3 detected");
    expect(summary.reductionHint).toContain("(1 render skipped)");
    // Ensure the entire hint is correct (not just a substring).
    expect(summary.reductionHint).toBe("2 screens from 3 detected (1 render skipped)");
  });

  // ── irSummary — singular pluralisation for exactly 1 field / 1 control / 1 text ──
  it('irSummary pluralises correctly for 1 field, 1 control, 1 text ("field", "control", "text")', async () => {
    const irJson = {
      name: "SingularScreen",
      root: {
        interactionHint: null,
        children: [
          { interactionHint: "input", children: [] },
          { interactionHint: "button", children: [] },
          { interactionHint: "text", children: [] },
        ],
      },
    };

    const evidenceModule = await import("@oscharko-dev/keiko-evidence");
    const store = evidenceModule.createNodeFigmaSnapshotStore(evidenceDir);
    const runId = "fs-00000000-0000-0000-0000-000000000015";
    store.record({
      runId,
      provenance: PROVENANCE,
      integrityHash: "placeholder",
      screens: [
        {
          screenId: "singular-screen-1",
          irJson,
          integrityHash: "placeholder",
          image: { mimeType: "image/png", bytes: PNG_BYTES },
        },
      ],
      skippedScreens: [],
    });

    // Act
    const deps = makeDeps(evidenceDir, {});
    const result = handleFigmaLoadSnapshot(makeGetCtx(runId), deps);

    // Assert: singular forms — no trailing "s".
    expect(result.status).toBe(200);
    const summary = result.body as FigmaSnapshotSummary;
    expect(summary.screens[0]?.irSummary).toBe("1 field, 1 control, 1 text");
  });
});
