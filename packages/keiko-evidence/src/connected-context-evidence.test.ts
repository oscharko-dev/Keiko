import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  createInMemoryEvidenceStore,
  type EvidenceManifest,
  loadEvidence,
  persistConnectedContextEvidence,
} from "./index.js";

const NOW = 1_700_000_000_000;
const SK_FAKE = ["sk", "-fakeEvidenceSecret1234567890abcdef"].join("");
const GHP_FAKE = ["ghp", "_fakeEvidenceToken12345678901234567890"].join("");
const PEM_FAKE = ["-----", "BEGIN PRIVATE KEY-----fakebody-----END PRIVATE KEY-----"].join("");

function pack(): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `pack-${SK_FAKE}`,
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: `scope-${SK_FAKE}`,
      workspaceRoot: `/repo/${SK_FAKE}`,
      kind: "files",
      relativePaths: [`src/${SK_FAKE}.ts`],
      conversationId: "chat-1",
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text: `explain ${GHP_FAKE}`,
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
    budget: {
      searchCallsMax: 4,
      filesReadMax: 8,
      excerptBytesMax: 1024,
      modelInputTokensMax: 2048,
      modelOutputTokensMax: 512,
      elapsedMsMax: 30_000,
      rerankCallsMax: 1,
    },
    usage: {
      searchCalls: 1,
      filesRead: 1,
      excerptBytes: PEM_FAKE.length,
      modelInputTokens: 20,
      modelOutputTokens: 5,
      elapsedMs: 12,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: `src/${SK_FAKE}.ts`,
        role: "read-only",
        selectionReason: "ranked lexical match",
        excerpts: [
          {
            atom: {
              schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
              stableId: `atom-${SK_FAKE}`,
              scopePath: `src/${SK_FAKE}.ts`,
              lineRange: { startLine: 1, endLine: 3 },
              score: 0.9,
              provenance: {
                kind: "lexical-search",
                tool: "repo.searchText",
                queryFingerprint: `fp-${GHP_FAKE}`,
              },
              redactionState: "redacted",
              emittedAtMs: NOW,
              ledgerRef: undefined,
            },
            content: PEM_FAKE,
            contentBytes: PEM_FAKE.length,
          },
        ],
      },
    ],
    omitted: [{ scopePath: `src/omit-${SK_FAKE}.ts`, reason: "low-relevance", omittedAtMs: NOW }],
    uncertainty: [
      {
        kind: "low-confidence",
        claim: `uncertain ${GHP_FAKE}`,
        impactedAtomIds: [`atom-${SK_FAKE}`],
        emittedAtMs: NOW,
      },
    ],
    emittedAtMs: NOW,
    ledgerRef: undefined,
  };
}

function requireManifest(manifest: EvidenceManifest | undefined): EvidenceManifest {
  if (manifest === undefined) {
    throw new Error("expected evidence manifest");
  }
  return manifest;
}

function requireConnectedContext(
  manifest: EvidenceManifest,
): NonNullable<EvidenceManifest["connectedContext"]> {
  const audit = manifest.connectedContext;
  if (audit === undefined) {
    throw new Error("expected connectedContext audit section");
  }
  return audit;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertMetadata(manifest: EvidenceManifest): void {
  const audit = requireConnectedContext(manifest);
  expect(manifest.run.taskType).toBe("connected-context");
  expect(audit.modelRequest.excerptContentPersisted).toBe(false);
  expect(audit.toolsUsed).toEqual(["model-gateway", "repo.searchText"]);
  expect(audit.summary).toMatchObject({
    fileCount: 1,
    citationCount: 1,
    omittedCount: 1,
    uncertaintyCount: 1,
    elapsedMs: 42,
  });
  expect(audit.files[0]?.excerpts[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
}

function assertNoSensitiveText(manifest: EvidenceManifest): void {
  const serialised = JSON.stringify(manifest);
  expect(serialised).not.toContain(SK_FAKE);
  expect(serialised).not.toContain(GHP_FAKE);
  expect(serialised).not.toContain("PRIVATE KEY");
  expect(serialised).not.toContain("explain ");
  expect(serialised).not.toContain("fakebody");
}

describe("connected-context evidence", () => {
  it("persists a parseable metadata-only manifest without query or excerpt text", () => {
    const store = createInMemoryEvidenceStore();
    const result = persistConnectedContextEvidence(
      {
        runId: "grounded-run-1",
        modelId: "example-chat-model",
        workspaceRoot: `/repo/${SK_FAKE}`,
        chatId: "chat-1",
        plan: {
          planId: `plan-${SK_FAKE}`,
          state: "ready",
          createdAtMs: NOW - 1,
          anchors: [
            { term: `src/${SK_FAKE}.ts`, kind: "path" },
            { term: `My${GHP_FAKE}Class`, kind: "identifier" },
          ],
          rings: [{ kind: "lexical" }, { kind: "structural" }],
        },
        pack: pack(),
        citationCount: 1,
        elapsedMs: 42,
        startedAt: NOW,
        finishedAt: NOW + 42,
      },
      { store, env: {}, additionalSecrets: [SK_FAKE, GHP_FAKE, PEM_FAKE] },
    );

    expect(result.report.taskType).toBe("connected-context");
    const manifest = requireManifest(loadEvidence(store, "grounded-run-1"));
    assertMetadata(manifest);
    assertNoSensitiveText(manifest);
    const audit = requireConnectedContext(manifest);
    expect(manifest.run.fingerprint).toBe(sha256Hex("pack-[REDACTED]"));
    expect(manifest.context?.workspaceRoot).toBe(
      `connected-context-root-${sha256Hex("/repo/[REDACTED]").slice(0, 16)}`,
    );
    expect(JSON.stringify(manifest)).not.toContain("/repo/");
    expect(audit.scope.scopeIdHash).toBe(sha256Hex("scope-[REDACTED]"));
    expect(audit.query.queryTextHash).toBe(sha256Hex("explain [REDACTED]"));
    expect(audit.plan).toMatchObject({
      planIdHash: sha256Hex("plan-[REDACTED]"),
      state: "ready",
      createdAtMs: NOW - 1,
      anchorCount: 2,
      anchorKinds: { path: 1, identifier: 1 },
      ringKinds: ["lexical", "structural"],
    });
    expect(audit.plan?.anchorTermHashes).toEqual(
      [sha256Hex("My[REDACTED]Class"), sha256Hex("src/[REDACTED].ts")].sort(),
    );
    expect(audit.files[0]?.excerpts[0]?.contentSha256).toBe(sha256Hex("[REDACTED]"));
    expect(audit.files[0]?.excerpts[0]?.contentSha256).not.toBe(sha256Hex(PEM_FAKE));
  });

  it("applies evidence retention after writing connected-context manifests", () => {
    const store = createInMemoryEvidenceStore();
    const baseInput = {
      modelId: "example-chat-model",
      workspaceRoot: "/repo",
      chatId: "chat-1",
      pack: pack(),
      citationCount: 1,
      elapsedMs: 42,
    } as const;

    persistConnectedContextEvidence(
      {
        ...baseInput,
        runId: "grounded-run-1",
        startedAt: NOW,
        finishedAt: NOW + 1,
      },
      { store, env: {}, retention: { maxRuns: 1 } },
    );
    persistConnectedContextEvidence(
      {
        ...baseInput,
        runId: "grounded-run-2",
        startedAt: NOW + 10,
        finishedAt: NOW + 11,
      },
      { store, env: {}, retention: { maxRuns: 1 } },
    );

    expect(store.list()).toEqual(["grounded-run-2"]);
    expect(loadEvidence(store, "grounded-run-1")).toBeUndefined();
    expect(loadEvidence(store, "grounded-run-2")).toBeDefined();
  });
});
