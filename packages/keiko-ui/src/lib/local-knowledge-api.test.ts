import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  resolveKnowledgePodModelUsePolicy,
  sealedLocalPodModelUsePolicy,
  standardPodModelUsePolicy,
} from "@oscharko-dev/keiko-contracts";
import type {
  CapsuleSetId,
  KnowledgeCapsuleId,
  KnowledgePodSummary,
  KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";
import {
  capsulesForKnowledgePodUi,
  capsuleSetsForKnowledgePodUi,
  cancelIndexing,
  connectCapsuleSource,
  createCapsule,
  createCapsuleSet,
  deleteCapsule,
  disconnectCapsule,
  fetchCapsuleDetail,
  fetchCapsules,
  fetchCapsuleSets,
  rebuildCapsuleIndex,
  rebindCapsuleSourceRoot,
  reembedCapsuleForCurrentModel,
  refreshCapsuleChangedFiles,
  renameCapsule,
  repairCapsuleFailedFiles,
  startIndexing,
  updateCapsuleContextualRetrieval,
  updateCapsuleModelUsePolicy,
} from "./local-knowledge-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function podSummary(
  id: KnowledgeCapsuleId | CapsuleSetId,
  kind: KnowledgePodSummary["kind"],
  displayName: string,
  overrides: Partial<
    Pick<
      KnowledgePodSummary,
      | "readiness"
      | "retrieval"
      | "governance"
      | "modelUsePolicy"
      | "counts"
      | "setReadiness"
      | "sourceKinds"
    >
  > = {},
): KnowledgePodSummary {
  const modelUsePolicy =
    overrides.modelUsePolicy ?? resolveKnowledgePodModelUsePolicy(standardPodModelUsePolicy());
  return {
    schemaVersion: "1",
    id,
    kind,
    displayName,
    tags: [],
    readiness: overrides.readiness ?? "ready",
    counts: overrides.counts ?? {
      capsuleCount: 1,
      sourceCount: 0,
      documentCount: 0,
      chunkCount: 0,
      vectorCount: 0,
    },
    sourceKinds: overrides.sourceKinds ?? [],
    ...(overrides.setReadiness !== undefined ? { setReadiness: overrides.setReadiness } : {}),
    retrieval: {
      lexicalIndex: false,
      vectorIndex: false,
      hybridGrounding: true,
      crossSpaceScoreMixing: false,
      ...overrides.retrieval,
    },
    privacy: {
      localFirst: true,
      modelOpen: true,
      rawContentExposed: false,
      privatePathsExposed: false,
      evidenceMode: "counts-hashes-and-status",
      storageLocation: "local-runtime-state",
    },
    governance: overrides.governance ?? {
      locationKind: "local",
      sealingPosture: "local-store-policy",
      policyPosture: "none",
      managedServiceDependency: false,
    },
    modelUsePolicy,
    compatibility: {
      backingKind: kind === "pod" ? "knowledge-capsule" : "capsule-set",
      capsuleIds: kind === "pod" ? [id as KnowledgeCapsuleId] : [],
      sourceIds: [],
      localKnowledgeSchemaVersion: LOCAL_KNOWLEDGE_SCHEMA_VERSION,
      migrationRequired: false,
      persistedStateRenamed: false,
    },
    updatedAt: 1,
    degradationReasons: [],
  };
}

describe("local knowledge BFF boundary helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses redacted Knowledge Pod summary names for UI list labels when available", () => {
    const capsuleId = "cap-private" as KnowledgeCapsuleId;
    const setId = "set-private" as CapsuleSetId;

    expect(
      capsulesForKnowledgePodUi({
        capsules: [
          {
            id: capsuleId,
            displayName: "/Users/alice/private/customer.pdf",
            lifecycleState: "ready",
            sourceCount: 1,
            updatedAt: 1,
          },
        ],
        knowledgePods: [podSummary(capsuleId, "pod", "Knowledge Pod")],
      })[0]?.displayName,
    ).toBe("Knowledge Pod");

    expect(
      capsuleSetsForKnowledgePodUi({
        capsuleSets: [
          {
            id: setId,
            displayName: "https://gateway.example.test?client_secret=value",
            capsuleCount: 1,
            composedAt: 1,
          },
        ],
        knowledgePods: [podSummary(setId, "pod-set", "Knowledge Pod Set")],
      })[0]?.displayName,
    ).toBe("Knowledge Pod Set");
  });

  it("maps Knowledge Pod embedding guidance into optional UI metadata", () => {
    const capsuleId = "cap-legacy" as KnowledgeCapsuleId;
    const capsule = capsulesForKnowledgePodUi({
      capsules: [
        {
          id: capsuleId,
          displayName: "Legacy vectors",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
      knowledgePods: [
        podSummary(capsuleId, "pod", "Legacy vectors", {
          readiness: "degraded",
          retrieval: {
            lexicalIndex: true,
            vectorIndex: true,
            hybridGrounding: true,
            crossSpaceScoreMixing: false,
            embeddingCompatibilityStatus: "unknown",
            embeddingCompatibilityReason: "legacy-unverified-profile",
            reindexRecommended: true,
            queryEmbeddingAllowed: false,
          },
        }),
      ],
    })[0];

    expect(capsule?.knowledgePod).toMatchObject({
      readiness: "degraded",
      embeddingCompatibilityStatus: "unknown",
      embeddingCompatibilityReason: "legacy-unverified-profile",
      reindexRecommended: true,
      queryEmbeddingAllowed: false,
      guidance: {
        label: "Reindex recommended",
        tone: "warning",
      },
    });
  });

  it("maps unavailable and incompatible Knowledge Pod guidance", () => {
    const unavailableId = "cap-unavailable" as KnowledgeCapsuleId;
    const incompatibleId = "cap-incompatible" as KnowledgeCapsuleId;
    const capsules = capsulesForKnowledgePodUi({
      capsules: [
        {
          id: unavailableId,
          displayName: "Unavailable vectors",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
        {
          id: incompatibleId,
          displayName: "Mismatched vectors",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
      knowledgePods: [
        podSummary(unavailableId, "pod", "Unavailable vectors", {
          readiness: "degraded",
          retrieval: {
            lexicalIndex: true,
            vectorIndex: true,
            hybridGrounding: true,
            crossSpaceScoreMixing: false,
            embeddingCompatibilityStatus: "unavailable",
            embeddingCompatibilityReason: "policy-denied",
            reindexRecommended: false,
            queryEmbeddingAllowed: false,
          },
        }),
        podSummary(incompatibleId, "pod", "Mismatched vectors", {
          readiness: "degraded",
          retrieval: {
            lexicalIndex: true,
            vectorIndex: true,
            hybridGrounding: true,
            crossSpaceScoreMixing: false,
            embeddingCompatibilityStatus: "incompatible",
            embeddingCompatibilityReason: "fingerprint-mismatch",
            reindexRecommended: true,
            queryEmbeddingAllowed: false,
          },
        }),
      ],
    });

    expect(capsules[0]?.knowledgePod?.guidance).toMatchObject({
      label: "Embedding unavailable",
      tone: "danger",
    });
    expect(capsules[1]?.knowledgePod?.guidance).toMatchObject({
      label: "Embedding mismatch",
      tone: "danger",
    });
  });

  it("maps sealed Knowledge Pod policy guidance and denied operation metadata", () => {
    const capsuleId = "cap-sealed" as KnowledgeCapsuleId;
    const capsule = capsulesForKnowledgePodUi({
      capsules: [
        {
          id: capsuleId,
          displayName: "Sealed policy",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
      knowledgePods: [
        podSummary(capsuleId, "pod", "Sealed policy", {
          governance: {
            locationKind: "local",
            sealingPosture: "sealed-pod-policy",
            policyPosture: "policy-pack",
            managedServiceDependency: false,
          },
          modelUsePolicy: resolveKnowledgePodModelUsePolicy(sealedLocalPodModelUsePolicy()),
        }),
      ],
    })[0];

    expect(capsule?.knowledgePod).toMatchObject({
      sealed: true,
      deniedModelOperations: [
        "externalEmbeddings",
        "externalReranking",
        "answerSynthesis",
        "rawContentRelease",
      ],
      guidance: {
        label: "Policy denied",
        tone: "danger",
      },
    });
  });

  it("uses Knowledge Pod Set copy for embedding guidance", () => {
    const setId = "set-embedding-guidance" as CapsuleSetId;
    const capsuleSet = capsuleSetsForKnowledgePodUi({
      capsuleSets: [
        {
          id: setId,
          displayName: "Embedding guidance set",
          capsuleCount: 2,
          composedAt: 1,
        },
      ],
      knowledgePods: [
        podSummary(setId, "pod-set", "Embedding guidance set", {
          readiness: "degraded",
          retrieval: {
            lexicalIndex: true,
            vectorIndex: true,
            hybridGrounding: true,
            crossSpaceScoreMixing: false,
            embeddingCompatibilityStatus: "incompatible",
            embeddingCompatibilityReason: "fingerprint-mismatch",
            reindexRecommended: true,
            queryEmbeddingAllowed: false,
          },
        }),
      ],
    })[0];

    expect(capsuleSet?.knowledgePod?.guidance).toMatchObject({
      label: "Embedding mismatch",
      description:
        "Semantic retrieval is disabled for affected set members until they are reindexed locally.",
    });
  });

  it("uses Knowledge Pod Set copy for policy guidance", () => {
    const setId = "set-policy-guidance" as CapsuleSetId;
    const capsuleSet = capsuleSetsForKnowledgePodUi({
      capsuleSets: [
        {
          id: setId,
          displayName: "Policy guidance set",
          capsuleCount: 2,
          composedAt: 1,
        },
      ],
      knowledgePods: [
        podSummary(setId, "pod-set", "Policy guidance set", {
          governance: {
            locationKind: "local",
            sealingPosture: "sealed-pod-policy",
            policyPosture: "policy-pack",
            managedServiceDependency: false,
          },
          modelUsePolicy: resolveKnowledgePodModelUsePolicy(sealedLocalPodModelUsePolicy()),
        }),
      ],
    })[0];

    expect(capsuleSet?.knowledgePod?.guidance).toMatchObject({
      label: "Policy denied",
      description: expect.stringContaining("This Knowledge Pod Set blocks"),
    });
    expect(capsuleSet?.knowledgePod?.guidance?.description).toContain("affected members");
  });

  it("maps Knowledge Pod Set readiness reasons into UI guidance", () => {
    const setId = "set-readiness-guidance" as CapsuleSetId;
    const capsuleSet = capsuleSetsForKnowledgePodUi({
      capsuleSets: [
        {
          id: setId,
          displayName: "Readiness guidance set",
          capsuleCount: 3,
          composedAt: 1,
        },
      ],
      knowledgePods: [
        podSummary(setId, "pod-set", "Readiness guidance set", {
          readiness: "degraded",
          counts: {
            capsuleCount: 3,
            sourceCount: 1,
            documentCount: 1,
            chunkCount: 1,
            vectorCount: 0,
          },
          setReadiness: {
            readyCount: 1,
            draftCount: 0,
            degradedCount: 0,
            unavailableCount: 1,
            deniedCount: 0,
            indexingCount: 1,
            staleCount: 0,
            errorCount: 0,
            missingCount: 1,
            reasonCodes: ["member-indexing", "missing-member", "no-vectors"],
          },
        }),
      ],
    })[0];

    expect(capsuleSet?.knowledgePod?.guidance).toMatchObject({
      label: "Members unavailable",
      tone: "danger",
      description: expect.stringContaining("missing, failed, or unavailable"),
    });
  });

  it("maps future Knowledge Pod Set placeholders into UI guidance", () => {
    const setId = "set-future-guidance" as CapsuleSetId;
    const capsuleSet = capsuleSetsForKnowledgePodUi({
      capsuleSets: [
        {
          id: setId,
          displayName: "Future guidance set",
          capsuleCount: 1,
          composedAt: 1,
        },
      ],
      knowledgePods: [
        podSummary(setId, "pod-set", "Future guidance set", {
          readiness: "unavailable",
          sourceKinds: ["remote"],
          counts: {
            capsuleCount: 1,
            sourceCount: 0,
            documentCount: 0,
            chunkCount: 0,
            vectorCount: 0,
          },
          setReadiness: {
            readyCount: 0,
            draftCount: 0,
            degradedCount: 0,
            unavailableCount: 1,
            deniedCount: 0,
            indexingCount: 0,
            staleCount: 0,
            errorCount: 0,
            missingCount: 0,
            reasonCodes: ["future-remote-member"],
          },
        }),
      ],
    })[0];

    expect(capsuleSet?.knowledgePod?.guidance).toMatchObject({
      label: "Future member placeholder",
      tone: "warning",
      description: expect.stringContaining("not active retrieval sources yet"),
    });
  });

  it("normalizes legacy Knowledge Pod summaries with omitted model-use policy", () => {
    const capsuleId = "cap-legacy-policy" as KnowledgeCapsuleId;
    const legacySummary = podSummary(capsuleId, "pod", "Legacy policy");
    const legacyWire = { ...legacySummary } as Record<string, unknown>;
    delete legacyWire.modelUsePolicy;

    const capsule = capsulesForKnowledgePodUi({
      capsules: [
        {
          id: capsuleId,
          displayName: "Legacy policy",
          lifecycleState: "ready",
          sourceCount: 1,
          updatedAt: 1,
        },
      ],
      knowledgePods: [legacyWire as unknown as KnowledgePodSummary],
    })[0];

    expect(capsule?.knowledgePod).toMatchObject({
      sealed: true,
      deniedModelOperations: [
        "externalEmbeddings",
        "externalReranking",
        "answerSynthesis",
        "rawContentRelease",
      ],
      guidance: {
        label: "Policy denied",
        tone: "danger",
      },
    });
  });

  it("encodes capsule list, composition, metadata, connection, indexing, and repair routes", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true, capsule: { id: "cap 1" } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const capsuleId = "cap 1" as KnowledgeCapsuleId;
    const scope: KnowledgeSourceScope = {
      kind: "files",
      rootPath: "/repo",
      files: ["docs/plan.md", "data/sample.xlsx"],
    };

    await fetchCapsules();
    await fetchCapsuleSets();
    await fetchCapsules({ includeKnowledgePods: true });
    await fetchCapsuleSets({ includeKnowledgePods: true });
    await createCapsule({ displayName: "Release corpus", description: "0.2.0 grounding" });
    await createCapsuleSet({
      displayName: "Mixed grounding set",
      description: "16 source cap regression",
      capsuleIds: ["cap 1", "cap 2"] as unknown as readonly KnowledgeCapsuleId[],
    });
    await renameCapsule(capsuleId, { displayName: "Renamed", description: "curated" });
    await updateCapsuleContextualRetrieval(capsuleId, {
      enabled: true,
      modelId: "context-chat",
      strict: true,
      maxContextChars: 320,
    });
    await updateCapsuleModelUsePolicy(capsuleId, sealedLocalPodModelUsePolicy());
    await startIndexing(capsuleId);
    await cancelIndexing(capsuleId);
    await connectCapsuleSource(capsuleId, scope, "Release files");
    await rebindCapsuleSourceRoot(capsuleId, "source 1", "/new repo");
    await disconnectCapsule(capsuleId);
    await fetchCapsuleDetail(capsuleId);
    await deleteCapsule(capsuleId);
    await refreshCapsuleChangedFiles(capsuleId);
    await repairCapsuleFailedFiles(capsuleId);
    await reembedCapsuleForCurrentModel(capsuleId);
    await rebuildCapsuleIndex(capsuleId);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules?includeKnowledgePods=1",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsule-sets?includeKnowledgePods=1",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsule-sets",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          displayName: "Mixed grounding set",
          description: "16 source cap regression",
          capsuleIds: ["cap 1", "cap 2"],
        }),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ displayName: "Renamed", description: "curated" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          contextualRetrieval: {
            enabled: true,
            modelId: "context-chat",
            strict: true,
            maxContextChars: 320,
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ modelUsePolicy: sealedLocalPodModelUsePolicy() }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201/index",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ confirm: true }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201/index",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ confirm: true }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201/connection",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope, displayName: "Release files" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201/sources/source%201/root",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ rootPath: "/new repo" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          capsuleId: "cap 1",
          deleteIndex: true,
          deleteSources: false,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201/reindex",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ capsuleId: "cap 1", mode: "repair-failed" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201/reindex",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ capsuleId: "cap 1", mode: "full-reembed", force: true }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap%201/reindex",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ capsuleId: "cap 1", mode: "full-rebuild", force: true }),
      }),
    );
  });

  it("returns undefined for 204 mutation receipts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(disconnectCapsule("cap 1" as KnowledgeCapsuleId)).resolves.toBeUndefined();
  });

  it("surfaces server envelopes and uses a safe fallback for unparseable failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: "LK_DENIED_PATH", message: "Path is denied" } }, 400),
        )
        .mockResolvedValueOnce(new Response("raw stack", { status: 500 })),
    );

    await expect(fetchCapsuleDetail("cap denied" as KnowledgeCapsuleId)).rejects.toMatchObject({
      code: "LK_DENIED_PATH",
      message: "Path is denied",
      status: 400,
    });
    await expect(fetchCapsuleDetail("cap broken" as KnowledgeCapsuleId)).rejects.toMatchObject({
      code: "INTERNAL",
      message: "The server returned an unexpected error (HTTP 500). Try again.",
      status: 500,
    });
  });
});
