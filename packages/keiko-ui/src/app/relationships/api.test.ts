// Issue #619 — regression guard: every mutating relationship route must carry
// the X-Keiko-CSRF header, otherwise the BFF returns 403 FORBIDDEN_CSRF.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRelationship,
  deleteRelationship,
  patchRelationship,
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
