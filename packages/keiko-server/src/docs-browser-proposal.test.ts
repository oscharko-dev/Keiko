// Epic #1852 — POST /api/docs-browser/propose + /approve integration and resolver tests. The routes
// run live through createUiServer so the CSRF/state-change gate and JSON handling exercise the real
// path; the resolver unit tests inject a pod lister to prove already-indexed duplicate detection.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DocumentationIndexingApproval,
  DocumentationIndexingProposal,
  KnowledgeCapsuleId,
  KnowledgePodSummary,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";
import {
  computeManualRootFingerprint,
  resolveManualApproval,
  resolveManualProposal,
} from "./docs-browser-proposal.js";

function stubDeps(): UiHandlerDeps {
  return {
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
  };
}

function podWithFingerprint(
  fingerprint: string,
  overrides: Partial<KnowledgePodSummary> = {},
): KnowledgePodSummary {
  return {
    schemaVersion: "1",
    id: "capsule-existing" as KnowledgePodSummary["id"],
    kind: "pod",
    displayName: "Existing manual",
    tags: [],
    readiness: "ready",
    counts: { capsuleCount: 1, sourceCount: 1, documentCount: 3, chunkCount: 9, vectorCount: 9 },
    sourceKinds: ["folder"],
    retrieval: {
      lexicalIndex: true,
      vectorIndex: true,
      hybridGrounding: true,
      crossSpaceScoreMixing: false,
    },
    privacy: {
      localFirst: true,
      modelOpen: true,
      rawContentExposed: false,
      privatePathsExposed: false,
      evidenceMode: "counts-hashes-and-status",
      storageLocation: "local-runtime-state",
    },
    governance: {
      locationKind: "local",
      sealingPosture: "not-declared",
      policyPosture: "not-declared",
      managedServiceDependency: false,
    },
    modelUsePolicy: {
      source: "explicit",
      mode: "standard",
      operations: {
        externalEmbeddings: "allow",
        localEmbeddings: "allow",
        externalReranking: "allow",
        localReranking: "allow",
        answerSynthesis: "allow",
        rawContentRelease: "deny",
        evidencePersistence: "allow",
      },
    },
    compatibility: {
      backingKind: "knowledge-capsule",
      capsuleIds: ["capsule-existing" as KnowledgeCapsuleId],
      sourceIds: ["source-1" as KnowledgeSourceId],
      localKnowledgeSchemaVersion: "1",
      migrationRequired: false,
      persistedStateRenamed: false,
    },
    updatedAt: 1,
    degradationReasons: [],
    manualSourceFingerprint: fingerprint,
    ...overrides,
  };
}

interface Fixture {
  readonly port: number;
  readonly close: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const staticRoot = await mkdtemp(join(tmpdir(), "keiko-docs-propose-"));
  const deps = stubDeps();
  // Bind once to claim a free port, then re-create the server configured for that exact port so the
  // Host-header authority check (FORBIDDEN_HOST) passes — the server validates Host against its
  // configured port, not the ephemeral one from binding port 0.
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

let active: Fixture[] = [];
beforeEach(() => {
  active = [];
});
afterEach(async () => {
  for (const fx of active) await fx.close();
  active = [];
});

async function fixture(): Promise<Fixture> {
  const fx = await makeFixture();
  active.push(fx);
  return fx;
}

const CSRF_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json",
  "X-Keiko-CSRF": "1",
};

function post(
  fx: Fixture,
  route: "propose" | "approve",
  body: unknown,
  headers: Readonly<Record<string, string>> = CSRF_HEADERS,
): Promise<Response> {
  return fetch(`http://${UI_HOST}:${String(fx.port)}/api/docs-browser/${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/docs-browser/propose", () => {
  it("proposes an approvable manual with a bounded, redacted scope preview", async () => {
    const fx = await fixture();
    const res = await post(fx, "propose", {
      target: "https://intranet/handbook/secret/index.html?token=abc123",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentationIndexingProposal;
    expect(body.state).toBe("likely-manual");
    expect(body.approvalRequired).toBe(true);
    expect(body.approved).toBe(false);
    expect(body.scopePreview?.limits.followRedirects).toBe(false);
    expect(body.scopePreview?.estimatedPageCount).toBeNull();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("abc123");
  });

  it("declines a public external target with no scope preview", async () => {
    const fx = await fixture();
    const res = await post(fx, "propose", { target: "https://example.com/docs/index.html" });
    const body = (await res.json()) as DocumentationIndexingProposal;
    expect(body.state).toBe("unsupported");
    expect(body.scopePreview).toBeNull();
  });

  it("degrades an action page and does not offer approval", async () => {
    const fx = await fixture();
    const res = await post(fx, "propose", { target: "https://intranet/docs/login" });
    const body = (await res.json()) as DocumentationIndexingProposal;
    expect(body.state).toBe("degraded");
    expect(body.scopePreview).toBeNull();
  });

  it("rejects a missing target, a missing CSRF header, and an oversized body", async () => {
    const fx = await fixture();
    expect((await post(fx, "propose", {})).status).toBe(400);
    expect(
      (await post(fx, "propose", { target: "https://intranet/" }, { "Content-Type": "text/plain" }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await post(fx, "propose", { target: `https://intranet/${"a".repeat(9000)}` })).status,
    ).toBe(413);
  });
});

describe("POST /api/docs-browser/approve", () => {
  it("returns a redaction-safe consent handoff for an approvable manual", async () => {
    const fx = await fixture();
    const res = await post(fx, "approve", { target: "https://intranet/handbook/index.html" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DocumentationIndexingApproval;
    expect(body.approved).toBe(true);
    expect(body.sourceKind).toBe("html-manual-http");
    expect(body.sourceFingerprint.length).toBeGreaterThan(0);
    expect(body.limits.followRedirects).toBe(false);
  });

  it("refuses to approve a non-manual target", async () => {
    const fx = await fixture();
    const res = await post(fx, "approve", { target: "https://example.com/docs" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROPOSAL_NOT_APPROVABLE");
  });
});

describe("computeManualRootFingerprint", () => {
  it("is deterministic and shared across targets under the same manual root", () => {
    const a = computeManualRootFingerprint("https://intranet/docs/index.html");
    const b = computeManualRootFingerprint("https://intranet/docs/other.html");
    const c = computeManualRootFingerprint("https://intranet/docs/");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("differs across roots and is null for non-manual targets", () => {
    expect(computeManualRootFingerprint("https://intranet/docs/index.html")).not.toBe(
      computeManualRootFingerprint("https://intranet/guide/index.html"),
    );
    expect(computeManualRootFingerprint("ftp://host/file")).toBeNull();
  });

  it("never contains a raw path segment", () => {
    const fingerprint = computeManualRootFingerprint("https://intranet/private-secret/index.html");
    expect(fingerprint).not.toBeNull();
    expect(fingerprint).not.toContain("private-secret");
  });
});

describe("already-indexed duplicate detection", () => {
  const target = "https://intranet/handbook/index.html";

  it("overrides the proposal to already-indexed when a pod covers the same root", () => {
    const fingerprint = computeManualRootFingerprint(target);
    expect(fingerprint).not.toBeNull();
    const proposal = resolveManualProposal(target, stubDeps(), () => [
      podWithFingerprint(fingerprint ?? ""),
    ]);
    expect(proposal.state).toBe("already-indexed");
    expect(proposal.alreadyIndexedPodId).toBe("capsule-existing");
    expect(proposal.scopePreview).toBeNull();
  });

  it("does not override when the pod is not ready or the fingerprint differs", () => {
    const fingerprint = computeManualRootFingerprint(target) ?? "";
    const notReady = resolveManualProposal(target, stubDeps(), () => [
      podWithFingerprint(fingerprint, { readiness: "stale" }),
    ]);
    const otherRoot = resolveManualProposal(target, stubDeps(), () => [
      podWithFingerprint("different-fingerprint"),
    ]);
    expect(notReady.state).toBe("likely-manual");
    expect(otherRoot.state).toBe("likely-manual");
  });

  it("refuses approval when the manual is already indexed", () => {
    const fingerprint = computeManualRootFingerprint(target) ?? "";
    const decision = resolveManualApproval(target, stubDeps(), () => [
      podWithFingerprint(fingerprint),
    ]);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("ALREADY_INDEXED");
  });

  it("approves when no pod covers the root", () => {
    const decision = resolveManualApproval(target, stubDeps(), () => []);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.approval.approved).toBe(true);
  });
});
