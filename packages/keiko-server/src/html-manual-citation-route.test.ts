import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import {
  openKnowledgeStore,
  persistHtmlManualSourceMetadata,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { buildHtmlManualCitationNavigationTarget } from "./html-manual-citation-navigation.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createRunRegistry } from "./runs.js";
import { UI_HOST } from "./server.js";
import { startUiTestServer } from "./ui-test-server/_support.js";

interface Fixture {
  readonly port: number;
  readonly manualCitationTarget?: string;
  readonly mismatchedChunkCitationTarget?: string;
  readonly close: () => Promise<void>;
}

async function makeFixture(overrides?: {
  readonly seedManualCitation?: boolean;
  readonly seedMismatchedChunkCitation?: boolean;
}): Promise<Fixture> {
  const staticRoot = await mkdtemp(join(tmpdir(), "keiko-manual-citation-"));
  await writeFile(join(staticRoot, "index.html"), "<html><body>docs</body></html>", "utf8");
  const uiDbPath = join(staticRoot, "ui.sqlite");
  const manualCitationTarget =
    overrides?.seedManualCitation === true ? await seedManualCitation(staticRoot) : undefined;
  const mismatchedChunkCitationTarget =
    overrides?.seedMismatchedChunkCitation === true
      ? await seedMismatchedChunkCitation(staticRoot)
      : undefined;
  const deps: UiHandlerDeps = {
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
  const started = await startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    handlerDeps: deps,
  });
  const { port, server } = started;
  return {
    port,
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
      capsuleId: "cap-manual-citation-manual",
      sourceId: "src-manual-citation-manual",
      documentId: "doc-manual-citation-manual",
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
      sourceFingerprint: "fp-manual-citation-manual",
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
      capsuleId: "cap-manual-citation-mismatch-target",
      sourceId: "src-manual-citation-mismatch-target",
      documentId: "doc-manual-citation-mismatch-target",
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
      sourceFingerprint: "fp-manual-citation-mismatch-target",
      proposedPodName: "Device Handbook Mismatch Target",
    });
    const foreign = await seedCapsuleWithVectors(store, {
      capsuleId: "cap-manual-citation-mismatch-foreign",
      sourceId: "src-manual-citation-mismatch-foreign",
      documentId: "doc-manual-citation-mismatch-foreign",
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

async function checkCitation(
  fx: Fixture,
  body: unknown,
  headers: Readonly<Record<string, string>> = CSRF_HEADERS,
): Promise<Response> {
  return fetch(`http://${UI_HOST}:${String(fx.port)}/api/local-knowledge/manual-citation/check`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/local-knowledge/manual-citation/check", () => {
  afterEach(resetServerLogger);

  it("verifies an indexed citation and keeps its handle and document out of the result and Activity Log", async () => {
    const fx = await fixture({ seedManualCitation: true });
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const response = await checkCitation(fx, { target: fx.manualCitationTarget });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "verified" });
    const event = sink.events.find((record) => record.op === "knowledge.citation.manual-check");
    if (event === undefined) throw new Error("manual citation check did not log an outcome");
    const line = formatActivityLogProofLine(event);
    expect(expectActivityLogProof("knowledge.citation.manual-check.line", line)).toMatchObject({
      outcome: "verified",
      completeness: "complete",
      loss: "none",
    });
    expect(line).not.toMatch(
      /keiko-html-manual-citation:|manual\.internal|device-handbook|timeouts/u,
    );
  });

  it.each(["keiko-html-manual-citation:not-json", "https://user:example@intranet/handbook"])(
    "rejects targets outside the opaque citation contract",
    async (target) => {
      const fx = await fixture();
      const response = await checkCitation(fx, { target });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "unavailable", reason: "target-unsupported" });
    },
  );

  it("rejects a handle whose chunk belongs to another citation document", async () => {
    const fx = await fixture({ seedMismatchedChunkCitation: true });
    const response = await checkCitation(fx, { target: fx.mismatchedChunkCitationTarget });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "unavailable",
      reason: "citation-lineage-mismatch",
    });
  });

  it("requires a bounded citation reference and same-origin mutation headers", async () => {
    const fx = await fixture();
    expect((await checkCitation(fx, {})).status).toBe(400);
    expect((await checkCitation(fx, { target: "a".repeat(5_000) })).status).toBe(400);
    expect((await checkCitation(fx, { target: "a".repeat(9_000) })).status).toBe(413);
    expect(
      (await checkCitation(fx, { target: "x" }, { "Content-Type": "application/json" })).status,
    ).toBe(403);
  });

  it.each(["navigate", "propose", "approve"])(
    "retires the old documentation browser %s route",
    async (rest) => {
      const fx = await fixture();
      const response = await fetch(
        `http://${UI_HOST}:${String(fx.port)}/api/docs-browser/${rest}`,
        {
          method: "POST",
          headers: CSRF_HEADERS,
          body: JSON.stringify({}),
        },
      );
      expect(response.status).toBe(404);
    },
  );
});
