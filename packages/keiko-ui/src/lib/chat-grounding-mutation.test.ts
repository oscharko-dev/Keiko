import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchChats } from "./api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { replaceGroundingScopeList } from "./chat-grounding-mutation";
import type { Chat } from "./types";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchChats: vi.fn(),
}));
vi.mock("./client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const chat: Chat = {
  id: "chat-source",
  projectPath: "/project",
  title: "test",
  selectedModel: "model",
  branchLabel: undefined,
  status: undefined,
  connectedScope: undefined,
  localKnowledgeScope: undefined,
  createdAt: 1,
  updatedAt: 2,
  groundingScopeIdentity: "gsi-v1:" + "a".repeat(64),
};

function conflict(): ApiError {
  const error = new ApiError("GROUNDING_SCOPE_CHANGED", "The sources changed.", 409);
  error.correlationId = "scope-attempt";
  return error;
}

afterEach(() => vi.clearAllMocks());

describe("grounding source mutation conflicts", () => {
  it("refreshes only the canonical chat and never repeats the stale list replacement", async () => {
    const refusal = conflict();
    const persist = vi.fn().mockRejectedValue(refusal);
    const canonical = { ...chat, groundingScopeIdentity: "gsi-v1:" + "b".repeat(64) };
    vi.mocked(fetchChats).mockResolvedValue({ chats: [canonical] });
    const onChanged = vi.fn();
    await expect(replaceGroundingScopeList(chat, null, persist, onChanged)).rejects.toBe(refusal);
    expect(persist).toHaveBeenCalledExactlyOnceWith(chat.id, null, chat.groundingScopeIdentity);
    expect(fetchChats).toHaveBeenCalledExactlyOnceWith(chat.projectPath, "scope-attempt", chat.id);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(canonical);
  });

  it.each([
    { ...chat, id: "another-chat" },
    { ...chat, projectPath: "/other-project" },
  ])("does not adopt a response outside the requested chat ownership", async (foreign) => {
    vi.mocked(fetchChats).mockResolvedValue({ chats: [foreign] });
    const onChanged = vi.fn();
    await expect(
      replaceGroundingScopeList(chat, [], vi.fn().mockRejectedValue(conflict()), onChanged),
    ).rejects.toMatchObject({ code: "GROUNDING_SCOPE_CHANGED" });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps the original refusal and correlated body-free evidence when refreshing fails", async () => {
    const refusal = conflict();
    vi.mocked(fetchChats).mockRejectedValue(new TypeError("private-folder-canary"));
    await expect(
      replaceGroundingScopeList(chat, null, vi.fn().mockRejectedValue(refusal), vi.fn()),
    ).rejects.toBe(refusal);
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      "Grounding scope conflict refresh failed.",
      expect.objectContaining({
        correlationId: "scope-attempt",
        errorKind: "unavailable",
        errorEvidence: expect.objectContaining({ errorClass: "TypeError" }),
      }),
    );
    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain(
      "private-folder-canary",
    );
  });

  it.each([
    new ApiError("GROUNDING_SCOPE_CHANGED", "bad status", 400),
    new ApiError("BAD_REQUEST", "different failure", 409),
  ])("does not refresh an unrelated refusal", async (refusal) => {
    await expect(
      replaceGroundingScopeList(chat, null, vi.fn().mockRejectedValue(refusal), vi.fn()),
    ).rejects.toBe(refusal);
    expect(fetchChats).not.toHaveBeenCalled();
  });
});
