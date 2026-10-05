import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
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

  afterEach(() => resetClientDiagnosticWriter());

  it("records a deterministic reads-context relationship for valid chat-folder pairs", async () => {
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

    recordReadsContextRelationship("chat-1", "/repo", "files-bind-123");
    await waitFor(() => expect(createRelationship).toHaveBeenCalledOnce());

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
    recordReadsContextRelationship("chat-1", "/repo", "files-bind-123");
    await waitFor(() => expect(createRelationship).toHaveBeenCalledOnce());
    expect(vi.mocked(createRelationship).mock.calls[0]?.[1]).toBe(key);
  });

  it("skips incomplete pairs and records non-blocking relationship failures", async () => {
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    vi.mocked(createRelationship).mockRejectedValue(
      new RelationshipApiError("policy_denied", "denied", 403),
    );

    recordReadsContextRelationship("", "/repo", "files-bind-123");
    recordReadsContextRelationship("chat-1", "", "files-bind-123");
    recordReadsContextRelationship("chat-1", "/repo", "files-bind-123");
    await waitFor(() => expect(createRelationship).toHaveBeenCalledOnce());

    expect(createRelationship).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(writer).toHaveBeenCalledOnce());
    expect(writer).toHaveBeenCalledWith(
      "Files relationship recording failed.",
      expect.objectContaining({
        correlationId: "files-bind-123",
        errorKind: "authority-denied",
      }),
    );
    expect(JSON.stringify(writer.mock.calls)).not.toMatch(/\/repo|chat-1|policy_denied/);
  });
});
