import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-shared-primitives";
import { deleteHistoryChats } from "./chatHistoryDeletion";
const ports = vi.hoisted(() => ({ remove: vi.fn(), report: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/api", () => ({ deleteChat: ports.remove }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: ports.report }));
vi.mock("../../hooks/useChatSession", () => ({ notifyChatDeleted: ports.notify }));
afterEach(() => {
  ports.remove.mockReset();
  ports.report.mockClear();
  ports.notify.mockClear();
});
it.each([
  [new ApiError("CONFLICT", "private canary", 409), "conflict"],
  [new ApiError("INTERNAL", "private canary", 503), "unavailable"],
  [new TypeError("private canary"), "unavailable"],
])("classifies failed deletion with body-free evidence: %s", async (error, errorKind) => {
  ports.remove.mockRejectedValue(error);
  const result = await deleteHistoryChats([
    { id: "private-id", projectPath: "/private/canary" } as Parameters<
      typeof deleteHistoryChats
    >[0][number],
  ]);
  expect(result.failedIds).toEqual(["private-id"]);
  expect(ports.notify).not.toHaveBeenCalled();
  expect(ports.report).toHaveBeenCalledWith(
    expect.stringContaining("request failed"),
    expect.objectContaining({
      errorKind,
      errorEvidence: expect.objectContaining({ errorClass: error.name }),
    }),
  );
  expect(JSON.stringify(ports.report.mock.calls)).not.toMatch(
    /private canary|private-id|private\/canary/u,
  );
});
