// Epic #1851 child #1862 — POST /api/docs-browser/navigate integration tests. The route runs live
// through createUiServer so the CSRF/state-change gate and JSON handling exercise the real path. A
// minimal FakeBrowserSessionManager supplies only the non-mutating checkStatus probe the route uses.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrowserToolError,
  type BrowserContentResult,
  type BrowserEventEmitter,
  type BrowserNavigateResult,
  type BrowserScreenshotResult,
  type BrowserSessionManager,
  type BrowserSessionMeta,
  type CdpReachability,
} from "@oscharko-dev/keiko-tools";
import type { DocumentationNavigationResult } from "@oscharko-dev/keiko-contracts";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import {
  openKnowledgeStore,
  persistHtmlManualSourceMetadata,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { buildHtmlManualCitationNavigationTarget } from "./html-manual-citation-navigation.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";

interface FakeOptions {
  readonly reachable?: boolean;
  readonly checkShouldThrow?: BrowserToolError;
}

function notUsed(method: string): never {
  throw new Error(`FakeBrowserSessionManager.${method} is not used by the docs-browser route`);
}

class FakeBrowserSessionManager implements BrowserSessionManager {
  public readonly checkedPorts: number[] = [];
  private readonly opts: FakeOptions;

  public constructor(opts: FakeOptions = {}) {
    this.opts = opts;
  }

  public readonly checkStatus = (port: number): Promise<CdpReachability> => {
    this.checkedPorts.push(port);
    if (this.opts.checkShouldThrow !== undefined) return Promise.reject(this.opts.checkShouldThrow);
    if (this.opts.reachable === false) {
      return Promise.resolve({
        reachable: false,
        userAgent: null,
        browserVersion: null,
        webSocketDebuggerUrl: null,
      });
    }
    return Promise.resolve({
      reachable: true,
      userAgent: "Chrome/130.0",
      browserVersion: "Chrome/130.0",
      webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/xyz`,
    });
  };

  public readonly openSession = (): Promise<BrowserSessionMeta> => notUsed("openSession");
  public readonly closeSession = (): Promise<void> => notUsed("closeSession");
  public readonly navigate = (): Promise<BrowserNavigateResult> => notUsed("navigate");
  public readonly screenshot = (): Promise<BrowserScreenshotResult> => notUsed("screenshot");
  public readonly applyScreenshot = (): Promise<BrowserScreenshotResult> =>
    notUsed("applyScreenshot");
  public readonly content = (): Promise<BrowserContentResult> => notUsed("content");
  public readonly listSessionIds = (): readonly string[] => [];
  public readonly hasSession = (): boolean => false;
  public readonly dispose = (): Promise<void> => Promise.resolve();
  public readonly subscribe =
    (_id: string, _listener: BrowserEventEmitter): (() => void) =>
    (): void =>
      undefined;
  public readonly counterAccessor = (): { readonly navigations: number } => ({ navigations: 0 });
}

interface Fixture {
  readonly port: number;
  readonly fakeBrowser: FakeBrowserSessionManager;
  readonly manualCitationTarget?: string;
  readonly mismatchedChunkCitationTarget?: string;
  readonly close: () => Promise<void>;
}

async function makeFixture(overrides?: {
  readonly omitBrowser?: boolean;
  readonly fakeOpts?: FakeOptions;
  readonly seedManualCitation?: boolean;
  readonly seedMismatchedChunkCitation?: boolean;
}): Promise<Fixture> {
  const staticRoot = await mkdtemp(join(tmpdir(), "keiko-docs-browser-"));
  await writeFile(join(staticRoot, "index.html"), "<html><body>docs</body></html>", "utf8");
  const uiDbPath = join(staticRoot, "ui.sqlite");
  const manualCitationTarget =
    overrides?.seedManualCitation === true ? await seedManualCitation(staticRoot) : undefined;
  const mismatchedChunkCitationTarget =
    overrides?.seedMismatchedChunkCitation === true
      ? await seedMismatchedChunkCitation(staticRoot)
      : undefined;
  const fakeBrowser = new FakeBrowserSessionManager(overrides?.fakeOpts);
  const baseDeps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: process.env,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    uiDbPath,
  };
  const deps: UiHandlerDeps =
    overrides?.omitBrowser === true ? baseDeps : { ...baseDeps, browser: fakeBrowser };
  let server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  return {
    port,
    fakeBrowser,
    ...(manualCitationTarget !== undefined ? { manualCitationTarget } : {}),
    ...(mismatchedChunkCitationTarget !== undefined ? { mismatchedChunkCitationTarget } : {}),
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      deps.store.close();
      await rm(staticRoot, { recursive: true, force: true });
    },
  };
}

async function seedManualCitation(runtimeStateDir: string): Promise<string> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir }),
  });
  try {
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-docs-browser-manual",
      sourceId: "src-docs-browser-manual",
      documentId: "doc-docs-browser-manual",
      safeDisplayName: "device-handbook.html",
      unit: {
        kind: "html-block",
        headingPath: ["Troubleshooting"],
        anchorId: "timeouts",
        characterStart: 0,
        characterEnd: 120,
      },
    });
    persistHtmlManualSourceMetadata(store, seeded.capsuleId, seeded.sourceId, {
      schemaVersion: "1",
      scope: {
        kind: "html-manual-http",
        origin: "https://manual.internal",
        pathPrefix: null,
      },
      limits: {
        maxPages: 20,
        maxDepth: 3,
        maxBytes: 2_000_000,
        maxLinkSample: 50,
        timeoutMs: 30_000,
        followRedirects: false,
      },
      sourceFingerprint: "fp-docs-browser-manual",
      proposedPodName: "Device Handbook",
    });
    const chunkId = seeded.chunkIds[0];
    if (chunkId === undefined) throw new Error("manual citation seed has no chunk");
    return buildHtmlManualCitationNavigationTarget({
      capsuleId: seeded.capsuleId,
      sourceId: seeded.sourceId,
      documentId: seeded.documentId,
      chunkId,
      anchorId: "timeouts",
    });
  } finally {
    store.close();
  }
}

// Epic #1854 post-merge audit — `chunkId` is well-formed and belongs to a real chunk, but that
// chunk resolves under a different capsule/source than the citation's own `documentId`, so it
// cannot belong to that document. Proves the chunk lineage check rejects this with
// `citation-lineage-mismatch` rather than silently ignoring the unverified `chunkId`.
async function seedMismatchedChunkCitation(runtimeStateDir: string): Promise<string> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir }),
  });
  try {
    const target = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-docs-browser-mismatch-target",
      sourceId: "src-docs-browser-mismatch-target",
      documentId: "doc-docs-browser-mismatch-target",
      safeDisplayName: "device-handbook.html",
      unit: {
        kind: "html-block",
        headingPath: ["Troubleshooting"],
        anchorId: "timeouts",
        characterStart: 0,
        characterEnd: 120,
      },
    });
    persistHtmlManualSourceMetadata(store, target.capsuleId, target.sourceId, {
      schemaVersion: "1",
      scope: {
        kind: "html-manual-http",
        origin: "https://manual.internal",
        pathPrefix: null,
      },
      limits: {
        maxPages: 20,
        maxDepth: 3,
        maxBytes: 2_000_000,
        maxLinkSample: 50,
        timeoutMs: 30_000,
        followRedirects: false,
      },
      sourceFingerprint: "fp-docs-browser-mismatch-target",
      proposedPodName: "Device Handbook Mismatch Target",
    });
    const foreign = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-docs-browser-mismatch-foreign",
      sourceId: "src-docs-browser-mismatch-foreign",
      documentId: "doc-docs-browser-mismatch-foreign",
      safeDisplayName: "unrelated-handbook.html",
    });
    const foreignChunkId = foreign.chunkIds[0];
    if (foreignChunkId === undefined) throw new Error("mismatch seed has no foreign chunk");
    return buildHtmlManualCitationNavigationTarget({
      capsuleId: target.capsuleId,
      sourceId: target.sourceId,
      documentId: target.documentId,
      chunkId: foreignChunkId,
      anchorId: "timeouts",
    });
  } finally {
    store.close();
  }
}

let active: Fixture[] = [];
beforeEach(() => {
  active = [];
});
afterEach(async () => {
  for (const fx of active) await fx.close();
  active = [];
});

async function fixture(...args: Parameters<typeof makeFixture>): Promise<Fixture> {
  const fx = await makeFixture(...args);
  active.push(fx);
  return fx;
}

const CSRF_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json",
  "X-Keiko-CSRF": "1",
};

async function navigate(
  fx: Fixture,
  body: unknown,
  headers: Readonly<Record<string, string>> = CSRF_HEADERS,
): Promise<Response> {
  return fetch(`http://${UI_HOST}:${String(fx.port)}/api/docs-browser/navigate`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/docs-browser/navigate — classification", () => {
  it("defers rendering for an intranet manual and redacts path/query", async () => {
    const fx = await fixture();
    const res = await navigate(fx, {
      target: "https://intranet/handbook/secret.html?token=abc123",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.targetClass).toBe("intranet-http");
    expect(body.reason).toBe("rendering-deferred");
    expect(body.originSummary).toBe("https://intranet");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("abc123");
  });

  it("declines an external public target", async () => {
    const fx = await fixture();
    const res = await navigate(fx, { target: "https://example.com/manual" });
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.targetClass).toBe("external-http");
    expect(body.reason).toBe("unsupported-external-target");
  });

  it("rejects an unsupported scheme as a governed limitation", async () => {
    const fx = await fixture();
    const res = await navigate(fx, { target: "ftp://host/file" });
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(res.status).toBe(200);
    expect(body.reason).toBe("unsupported-scheme");
  });

  it("collapses a credentialed target into invalid-target without echoing the credential", async () => {
    const fx = await fixture();
    const res = await navigate(fx, { target: "https://user:hunter2@intranet/manual" });
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.reason).toBe("invalid-target");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("resolves opaque HTML manual citation handles through the governed navigation route", async () => {
    const fx = await fixture({ seedManualCitation: true });
    if (fx.manualCitationTarget === undefined) throw new Error("manual citation target missing");
    const res = await navigate(fx, { target: fx.manualCitationTarget });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.targetClass).toBe("intranet-http");
    expect(body.reason).toBe("rendering-deferred");
    expect(body.originSummary).toBe("https://manual.internal");
    expect(body.pathSummary).toBe("/…");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("doc-docs-browser-manual");
    expect(serialized).not.toContain("timeouts");
    expect(serialized).not.toContain("keiko-html-manual-citation");
  });

  it("fails closed on malformed opaque HTML manual citation handles", async () => {
    const fx = await fixture({ seedManualCitation: true });
    const res = await navigate(fx, { target: "keiko-html-manual-citation:not-json" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.targetClass).toBe("unsupported-scheme");
    expect(body.originSummary).toBe("Unsupported citation target");
    expect(body.reason).toBe("unsupported-scheme");
    expect(JSON.stringify(body)).not.toContain("not-json");
  });

  it("rejects a citation handle whose chunkId does not belong to its documentId", async () => {
    const fx = await fixture({ seedMismatchedChunkCitation: true });
    if (fx.mismatchedChunkCitationTarget === undefined) {
      throw new Error("mismatched chunk citation target missing");
    }
    const res = await navigate(fx, { target: fx.mismatchedChunkCitationTarget });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.targetClass).toBe("unsupported-scheme");
    expect(body.originSummary).toBe("Citation lineage mismatch");
    expect(body.reason).toBe("local-file-scope-unavailable");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("doc-docs-browser-mismatch");
    expect(serialized).not.toContain("keiko-html-manual-citation");
  });
});

describe("POST /api/docs-browser/navigate — loopback preview path", () => {
  it("offers a preview when the loopback backend is reachable", async () => {
    const fx = await fixture();
    const res = await navigate(fx, { target: "http://127.0.0.1:8080/docs", cdpPort: 9222 });
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.reason).toBe("preview-available");
    expect(body.capability.previewAvailable).toBe(true);
    expect(fx.fakeBrowser.checkedPorts).toContain(9222);
  });

  it("maps a backend probe failure to a governed reason", async () => {
    const fx = await fixture({
      fakeOpts: { checkShouldThrow: new BrowserToolError("CHROME_UNREACHABLE", "refused") },
    });
    const res = await navigate(fx, { target: "http://127.0.0.1:8080/docs", cdpPort: 9222 });
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.reason).toBe("browser-backend-unavailable");
    expect(body.capability.previewAvailable).toBe(false);
  });

  it("reports backend-unavailable for loopback when no browser backend is configured", async () => {
    const fx = await fixture({ omitBrowser: true });
    const res = await navigate(fx, { target: "http://127.0.0.1:8080/docs", cdpPort: 9222 });
    const body = (await res.json()) as DocumentationNavigationResult;
    expect(body.reason).toBe("browser-backend-unavailable");
    expect(body.capability.backendAvailable).toBe(false);
  });
});

describe("POST /api/docs-browser/navigate — request validation and CSRF", () => {
  it("rejects a missing target with a 400 envelope", async () => {
    const fx = await fixture();
    const res = await navigate(fx, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects a state-changing request without the CSRF header", async () => {
    const fx = await fixture();
    const res = await navigate(
      fx,
      { target: "https://intranet/manual" },
      { "Content-Type": "text/plain" },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fx.fakeBrowser.checkedPorts).toHaveLength(0);
  });

  it("rejects an oversized body with 413", async () => {
    const fx = await fixture();
    const res = await navigate(fx, { target: `https://intranet/${"a".repeat(9000)}` });
    expect(res.status).toBe(413);
  });
});
