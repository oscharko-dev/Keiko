import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({ notify: vi.fn(), diagnostic: vi.fn() }));
vi.mock("./coding-app-session-client", () => ({
  requestCodingAppSessionReinspection: ports.notify,
}));
vi.mock("./client-diagnostics", () => ({ reportClientDiagnostic: ports.diagnostic }));

let now = 0;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ["NOT_FOUND", "/api/chats/deleted-chat"],
  ["NOT_FOUND", "/api/local-knowledge/capsules/deleted-pod"],
  ["NOT_FOUND", "/api/desktop/chat/stream"],
  ["NOT_FOUND", "/api/coding-workbench/runtime/runs/run-id/stop"],
  ["CODING_RUNTIME_RUN_NOT_FOUND", "/api/chats/deleted-chat"],
])(
  "keeps an ordinary 404 refusal final without refreshing every subscriber (%s, %s)",
  async (code, path) => {
    const { reinspectSessionAfterMutationRefusal } = await import("./bff-session-reinspection");
    await reinspectSessionAfterMutationRefusal({ status: 404, code }, "DELETE", path);
    expect(ports.notify).not.toHaveBeenCalled();
    expect(ports.diagnostic).not.toHaveBeenCalled();
  },
);

it.each([
  ["NOT_FOUND", "/api/skills/skill-id"],
  ["NOT_FOUND", "/api/skills/jira-templates/validate"],
  ["NOT_FOUND", "/api/chats/chat-id/draft"],
  ["NOT_FOUND", "/api/chats/chat-id/skill"],
  ["NOT_FOUND", "/api/coding-workbench/drafts/draft-id"],
  ["NOT_FOUND", "/api/runs/run-id/cancel"],
  ["CODING_RUNTIME_RUN_NOT_FOUND", "/api/coding-workbench/runtime/runs/run-id/questions/answer"],
])("reinspects a session-concealing mutation without replaying it (%s, %s)", async (code, path) => {
  const { reinspectSessionAfterMutationRefusal } = await import("./bff-session-reinspection");
  await reinspectSessionAfterMutationRefusal(
    { status: 404, code, correlationId: "refused-mutation" },
    "POST",
    path,
  );
  expect(ports.notify).toHaveBeenCalledOnce();
  expect(ports.diagnostic).toHaveBeenCalledExactlyOnceWith(
    "App session reinspection requested after a refused mutation.",
    { correlationId: "refused-mutation", errorKind: "unavailable" },
  );
});

it("joins a concurrent denial burst and allows at most one notification every five seconds", async () => {
  const { reinspectSessionAfterMutationRefusal } = await import("./bff-session-reinspection");
  const refusal = { status: 401, code: "UNAUTHORIZED", correlationId: "first-refusal" };
  await Promise.all(
    Array.from({ length: 5 }, () => reinspectSessionAfterMutationRefusal(refusal, "PUT")),
  );
  expect(ports.notify).toHaveBeenCalledOnce();
  expect(ports.diagnostic).toHaveBeenCalledOnce();
  now = 4_999;
  await reinspectSessionAfterMutationRefusal(refusal, "PUT");
  expect(ports.notify).toHaveBeenCalledOnce();
  now = 5_000;
  await reinspectSessionAfterMutationRefusal(refusal, "PUT");
  expect(ports.notify).toHaveBeenCalledTimes(2);
  expect(ports.diagnostic).toHaveBeenCalledTimes(2);
});

it.each(["GET", "HEAD"])("never reinpects a follow-up %s refusal", async (method) => {
  const { reinspectSessionAfterMutationRefusal } = await import("./bff-session-reinspection");
  await reinspectSessionAfterMutationRefusal({ status: 401, code: "UNAUTHORIZED" }, method);
  expect(ports.notify).not.toHaveBeenCalled();
});
