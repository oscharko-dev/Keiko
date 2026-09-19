import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODING_HISTORY_CHANGED,
  fetchCodingHistory,
  fetchCodingTask,
  updateCodingTask,
} from "./coding-history-api";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";

vi.mock("./coding-app-session-client", () => ({ codingAppSessionPairingSettled: vi.fn() }));
vi.mock("./client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const changed = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(codingAppSessionPairingSettled).mockResolvedValue(true);
  window.addEventListener(CODING_HISTORY_CHANGED, changed);
});
afterEach(() => {
  window.removeEventListener(CODING_HISTORY_CHANGED, changed);
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paired history client", () => {
  it("waits for pairing before listing, and bounds read duration", async () => {
    let finish: (ready: boolean) => void = () => {
      throw new Error("pairing not started");
    };
    vi.mocked(codingAppSessionPairingSettled).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fetchMock.mockResolvedValue(response({ tasks: [{ id: "task-one" }] }));
    const result = fetchCodingHistory();
    expect(fetchMock).not.toHaveBeenCalled();
    finish(true);
    await expect(result).resolves.toEqual([{ id: "task-one" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-workbench/history",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it("encodes a task id as a single path segment when reading or renaming", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ task: { id: "task/one" }, messages: [], truncated: false }),
    );
    await expect(fetchCodingTask("task/one")).resolves.toMatchObject({ task: { id: "task/one" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/coding-workbench/history/task%2Fone");
    fetchMock.mockResolvedValueOnce(response({ task: { id: "task/one", title: "Updated" } }));
    await expect(updateCodingTask("task/one", { title: "Updated" })).resolves.toMatchObject({
      title: "Updated",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/coding-workbench/history/task%2Fone",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
        headers: expect.objectContaining({
          "X-Keiko-CSRF": "1",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(changed).toHaveBeenCalledOnce();
  });

  it("propagates failed mutations without announcing a successful history change", async () => {
    fetchMock.mockResolvedValue(
      response({ error: { code: "ACTIVE_RUN_CONFLICT", message: "Run active" } }, 409),
    );
    await expect(updateCodingTask("task-one", { status: "completed" })).rejects.toMatchObject({
      code: "ACTIVE_RUN_CONFLICT",
      status: 409,
    });
    expect(changed).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
