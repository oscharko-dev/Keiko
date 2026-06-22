import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordReadsContextRelationship } from "./connector-relationship";
import { createRelationship, RelationshipApiError } from "./api";

vi.mock("./api", async () => {
  class RelationshipApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    RelationshipApiError,
    createRelationship: vi.fn(),
  };
});

describe("recordReadsContextRelationship", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a deterministic reads-context relationship for valid chat-folder pairs", () => {
    vi.mocked(createRelationship).mockResolvedValue({
      relationship: {
        id: "rel-1",
        schemaVersion: "relationships.v1",
        workspaceId: "workspace-1",
        type: "reads-context",
        source: { kind: "chat", id: "chat-1" },
        target: { kind: "workspace-path", id: "/repo" },
        lifecycle: "active",
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z",
        etag: 1,
      },
      etag: "1",
    });

    recordReadsContextRelationship("chat-1", "/repo");

    expect(createRelationship).toHaveBeenCalledWith(
      {
        type: "reads-context",
        source: { kind: "chat", id: "chat-1" },
        target: { kind: "workspace-path", id: "/repo" },
      },
      expect.stringMatching(/^rc-[a-z0-9]+-[a-z0-9]+$/u),
    );

    const key = vi.mocked(createRelationship).mock.calls[0]?.[1];
    vi.mocked(createRelationship).mockClear();
    recordReadsContextRelationship("chat-1", "/repo");
    expect(vi.mocked(createRelationship).mock.calls[0]?.[1]).toBe(key);
  });

  it("skips incomplete pairs and swallows best-effort failures", async () => {
    vi.mocked(createRelationship).mockRejectedValue(
      new RelationshipApiError("policy_denied", "denied", 403),
    );

    recordReadsContextRelationship("", "/repo");
    recordReadsContextRelationship("chat-1", "");
    recordReadsContextRelationship("chat-1", "/repo");

    expect(createRelationship).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });
});
