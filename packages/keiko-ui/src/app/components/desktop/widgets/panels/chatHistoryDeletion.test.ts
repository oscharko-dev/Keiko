import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-shared-primitives";
import type { Chat } from "@/lib/types";
import { deleteHistoryChats, moveHistoryChatsToDeleted } from "./chatHistoryDeletion";
const ports = vi.hoisted(() => ({
  remove: vi.fn(),
  update: vi.fn(),
  report: vi.fn(),
  notify: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ deleteChat: ports.remove, updateChat: ports.update }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: ports.report }));
vi.mock("../../hooks/useChatSession", () => ({
  notifyChatDeleted: ports.notify,
  notifyChatUpsert: ports.upsert,
}));
afterEach(() => {
  ports.remove.mockReset();
  ports.report.mockClear();
  ports.notify.mockClear();
  ports.update.mockReset();
  ports.upsert.mockClear();
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

function chats(count: number): Chat[] {
  return Array.from(
    { length: count },
    (_, index) => ({ id: `chat-${String(index)}`, projectPath: "/p", title: "t" }) as Chat,
  );
}

function stageReports(): { phase: string; deletion: unknown }[] {
  return ports.report.mock.calls.flatMap(([, meta]) => {
    const report = (meta as { stageReport?: { phase: string; deletion: unknown } }).stageReport;
    return report === undefined ? [] : [report];
  });
}

describe("moveHistoryChatsToDeleted (#4335)", () => {
  it("keeps at most four PATCH requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    ports.update.mockImplementation(async (id: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { chat: { id, status: "closed" } };
    });
    const result = await moveHistoryChatsToDeleted(chats(10));
    expect(result.moved).toHaveLength(10);
    expect(peak).toBe(4);
  });

  it("tells open windows through the existing upsert mutation, only for chats that moved", async () => {
    ports.update.mockImplementation((id: string) =>
      id === "chat-1"
        ? Promise.reject(new TypeError("private canary"))
        : Promise.resolve({ chat: { id, status: "closed" } }),
    );
    const result = await moveHistoryChatsToDeleted(chats(3));
    expect(result.failedIds).toEqual(["chat-1"]);
    expect(ports.upsert.mock.calls.map(([chat]) => (chat as Chat).id)).toEqual([
      "chat-0",
      "chat-2",
    ]);
    expect(ports.notify).not.toHaveBeenCalled();
  });

  it("records correlated, body-free start and settlement counts for the move", async () => {
    ports.update.mockImplementation((id: string) =>
      id === "chat-1"
        ? Promise.reject(new TypeError("private canary"))
        : Promise.resolve({ chat: { id, status: "closed" } }),
    );
    await moveHistoryChatsToDeleted(chats(3));
    const reports = stageReports();
    expect(reports.map((report) => report.phase)).toEqual(["started", "settled"]);
    expect(reports[0]?.deletion).toEqual({
      action: "move",
      requestedCount: 3,
      deletedCount: 0,
      failedCount: 0,
    });
    expect(reports[1]?.deletion).toEqual({
      action: "move",
      requestedCount: 3,
      deletedCount: 2,
      failedCount: 1,
    });
    expect(JSON.stringify(ports.report.mock.calls)).not.toMatch(/private canary|chat-1/u);
  });

  it("labels the permanent purge as a purge", async () => {
    ports.remove.mockResolvedValue(undefined);
    await deleteHistoryChats(chats(1));
    expect(stageReports().map((report) => (report.deletion as { action: string }).action)).toEqual([
      "purge",
      "purge",
    ]);
  });

  it("limits the purge to four requests in flight as well", async () => {
    let inFlight = 0;
    let peak = 0;
    ports.remove.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    await deleteHistoryChats(chats(9));
    expect(peak).toBe(4);
    expect(ports.notify).toHaveBeenCalledTimes(9);
  });
});
