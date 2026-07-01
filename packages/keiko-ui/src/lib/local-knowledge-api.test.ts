import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCapsuleId, KnowledgeSourceScope } from "@oscharko-dev/keiko-contracts";
import {
  cancelIndexing,
  connectCapsuleSource,
  createCapsule,
  createCapsuleSet,
  deleteCapsule,
  disconnectCapsule,
  fetchCapsuleDetail,
  fetchCapsules,
  fetchCapsuleSets,
  reembedCapsuleForCurrentModel,
  refreshCapsuleChangedFiles,
  renameCapsule,
  repairCapsuleFailedFiles,
  startIndexing,
} from "./local-knowledge-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("local knowledge BFF boundary helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    await createCapsule({ displayName: "Release corpus", description: "0.2.0 grounding" });
    await createCapsuleSet({
      displayName: "Mixed grounding set",
      description: "16 source cap regression",
      capsuleIds: ["cap 1", "cap 2"] as unknown as readonly KnowledgeCapsuleId[],
    });
    await renameCapsule(capsuleId, { displayName: "Renamed", description: "curated" });
    await startIndexing(capsuleId);
    await cancelIndexing(capsuleId);
    await connectCapsuleSource(capsuleId, scope, "Release files");
    await disconnectCapsule(capsuleId);
    await fetchCapsuleDetail(capsuleId);
    await deleteCapsule(capsuleId);
    await refreshCapsuleChangedFiles(capsuleId);
    await repairCapsuleFailedFiles(capsuleId);
    await reembedCapsuleForCurrentModel(capsuleId);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules",
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
