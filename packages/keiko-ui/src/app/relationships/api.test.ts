// Issue #619 — regression guard: every mutating relationship route must carry
// the X-Keiko-CSRF header, otherwise the BFF returns 403 FORBIDDEN_CSRF.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRelationship,
  deleteRelationship,
  getDependencies,
  getExplain,
  getHealth,
  getImpact,
  getRelationship,
  listRelationships,
  patchRelationship,
  RelationshipApiError,
  validateRelationshipProposal,
} from "./api";

const PROPOSAL = {
  type: "depends-on" as const,
  source: { kind: "workflow-run" as const, id: "src-1" },
  target: { kind: "workspace-path" as const, id: "tgt-1" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("relationships API — CSRF header", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validateRelationshipProposal sends X-Keiko-CSRF: 1", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ decision: { allowed: true, reasons: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await validateRelationshipProposal(PROPOSAL);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/relationships/validate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });

  it("createRelationship sends X-Keiko-CSRF: 1 and Idempotency-Key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ relationship: { id: "r-1", etag: 1 }, etag: "1" }));
    vi.stubGlobal("fetch", fetchMock);

    await createRelationship(PROPOSAL, "idem-key-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/relationships",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Keiko-CSRF": "1",
          "Idempotency-Key": "idem-key-1",
        }),
      }),
    );
  });

  it("patchRelationship sends X-Keiko-CSRF: 1, Idempotency-Key, and If-Match", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ relationship: { id: "r-1", etag: 2 }, etag: "2" }));
    vi.stubGlobal("fetch", fetchMock);

    await patchRelationship("r-1", { transition: { to: "archived" } }, '"etag-abc"', "idem-key-2");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/relationships/r-1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "X-Keiko-CSRF": "1",
          "Idempotency-Key": "idem-key-2",
          "If-Match": '"etag-abc"',
        }),
      }),
    );
  });

  it("deleteRelationship sends X-Keiko-CSRF: 1, Idempotency-Key, and If-Match", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ relationship: { id: "r-1", etag: 2 } }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteRelationship("r-1", '"etag-def"', "idem-key-3");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/relationships/r-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "X-Keiko-CSRF": "1",
          "Idempotency-Key": "idem-key-3",
          "If-Match": '"etag-def"',
        }),
      }),
    );
  });
});

describe("relationships API — graph route contracts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes relationship list, detail, dependency, impact, explain, and health routes", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          relationship: { id: "rel 1", etag: 7 },
          entries: [],
          truncated: false,
          nextCursor: null,
          report: {
            rootRelationshipId: "rel 1",
            depthReached: 1,
            truncated: false,
            relationships: [],
            endpoints: [],
          },
          decision: { allowed: true, reasons: [] },
          lifecycle: [],
          checkedAt: 1,
          totals: { active: 0 },
          findings: {
            orphanedEndpoints: [],
            orphanedEndpointsTruncated: false,
            staleRelationships: [],
            staleRelationshipsTruncated: false,
            blockedRelationships: [],
            blockedRelationshipsTruncated: false,
            failedRelationships: [],
            failedRelationshipsTruncated: false,
            invalidReferences: [],
            invalidReferencesTruncated: false,
            cycleParticipants: [],
            cycleScanTruncated: false,
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listRelationships({
      lifecycle: "active",
      type: "depends-on",
      sourceKind: "workflow-run",
      targetKind: "workspace-path",
      sourceId: "src 1",
      targetId: "target/1",
      limit: 50,
      cursor: "cursor 1",
    });
    await getRelationship("rel 1");
    await getDependencies("rel 1", {
      direction: "both",
      maxDepth: 3,
      maxNodes: 40,
      maxRelationships: 20,
    });
    await getImpact("workflow-run", "run 1", {
      direction: "outgoing",
      maxDepth: 2,
      maxNodes: 10,
      maxRelationships: 5,
    });
    await getExplain("rel 1");
    await getHealth();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/relationships?lifecycle=active&type=depends-on&sourceKind=workflow-run&targetKind=workspace-path&sourceId=src+1&targetId=target%2F1&limit=50&cursor=cursor+1",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/relationships/rel%201");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/relationships/rel%201/dependencies?direction=both&maxDepth=3&maxNodes=40&maxRelationships=20",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/relationships/impact?endpointKind=workflow-run&endpointId=run+1&direction=outgoing&maxDepth=2&maxNodes=10&maxRelationships=5",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/relationships/rel%201/explain");
    expect(fetchMock).toHaveBeenCalledWith("/api/relationships/health");
  });

  it("preserves relationship denial envelopes and rejects invalid JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: { code: "relationship/invalid-transition", message: "Cannot archive draft" },
              reasons: [
                { code: "denied/lifecycle-illegal-transition", message: "Draft is not active" },
              ],
            },
            409,
          ),
        )
        .mockResolvedValueOnce(new Response("not-json", { status: 200 })),
    );

    await expect(getRelationship("rel denied")).rejects.toMatchObject({
      code: "relationship/invalid-transition",
      message: "Cannot archive draft",
      status: 409,
      reasons: [{ code: "denied/lifecycle-illegal-transition", message: "Draft is not active" }],
    } satisfies Partial<RelationshipApiError>);
    await expect(getHealth()).rejects.toMatchObject({
      code: "relationship/parse-error",
      message: "Response is not valid JSON.",
      status: 200,
    } satisfies Partial<RelationshipApiError>);
  });
});
