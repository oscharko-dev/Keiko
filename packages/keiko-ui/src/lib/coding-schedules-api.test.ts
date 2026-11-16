import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlCodingSchedule, fetchCodingSchedules } from "./coding-schedules-api";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { bffFetchJson } from "./http";

vi.mock("./coding-app-session-client", () => ({ codingAppSessionPairingSettled: vi.fn() }));
vi.mock("./http", () => ({ bffFetchJson: vi.fn() }));

const ROOT = "/api/coding-workbench/runtime/schedules";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(codingAppSessionPairingSettled).mockResolvedValue(true);
});

function lastInit(): RequestInit {
  const call = vi.mocked(bffFetchJson).mock.calls.at(-1);
  if (call === undefined) throw new Error("bffFetchJson was not called");
  return call[1] as RequestInit;
}

describe("fetchCodingSchedules", () => {
  it("waits for pairing, then reads the task's schedules with a GET", async () => {
    let finish: (ready: boolean) => void = () => {
      throw new Error("pairing not started");
    };
    vi.mocked(codingAppSessionPairingSettled).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const body = { taskId: "task-1", schedules: [] };
    vi.mocked(bffFetchJson).mockResolvedValue(body);
    const result = fetchCodingSchedules("task-1");
    await Promise.resolve();
    expect(bffFetchJson).not.toHaveBeenCalled();
    finish(true);
    await expect(result).resolves.toBe(body);
    expect(vi.mocked(bffFetchJson).mock.calls[0]?.[0]).toBe(`${ROOT}?taskId=task-1`);
    expect(lastInit().method).toBeUndefined();
    expect(lastInit().signal).toBeInstanceOf(AbortSignal);
  });

  it("encodes the task id", async () => {
    vi.mocked(bffFetchJson).mockResolvedValue({ taskId: "x", schedules: [] });
    await fetchCodingSchedules("a b&c=d/é");
    expect(vi.mocked(bffFetchJson).mock.calls[0]?.[0]).toBe(
      `${ROOT}?taskId=${encodeURIComponent("a b&c=d/é")}`,
    );
  });

  it("uses the caller's abort signal when given", async () => {
    vi.mocked(bffFetchJson).mockResolvedValue({ taskId: "x", schedules: [] });
    const controller = new AbortController();
    await fetchCodingSchedules("task-1", controller.signal);
    expect(lastInit().signal).toBe(controller.signal);
  });

  it("propagates a failure", async () => {
    const failure = new Error("boom");
    vi.mocked(bffFetchJson).mockRejectedValue(failure);
    await expect(fetchCodingSchedules("task-1")).rejects.toBe(failure);
  });
});

describe("controlCodingSchedule", () => {
  it.each(["pause", "resume", "delete"] as const)(
    "posts %s with the task id body",
    async (action) => {
      vi.mocked(bffFetchJson).mockResolvedValue({ status: "paused" });
      await expect(controlCodingSchedule("task-1", "sch_abc", action)).resolves.toEqual({
        status: "paused",
      });
      expect(codingAppSessionPairingSettled).toHaveBeenCalledTimes(1);
      expect(vi.mocked(bffFetchJson).mock.calls[0]?.[0]).toBe(`${ROOT}/sch_abc/${action}`);
      expect(lastInit().method).toBe("POST");
      expect(JSON.parse(lastInit().body as string)).toEqual({ taskId: "task-1" });
      expect(lastInit().signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("encodes the schedule id in the path", async () => {
    vi.mocked(bffFetchJson).mockResolvedValue({ status: "deleted" });
    await controlCodingSchedule("task-1", "sch/../x", "delete");
    expect(vi.mocked(bffFetchJson).mock.calls[0]?.[0]).toBe(
      `${ROOT}/${encodeURIComponent("sch/../x")}/delete`,
    );
  });

  it("propagates a failure", async () => {
    const failure = new Error("boom");
    vi.mocked(bffFetchJson).mockRejectedValue(failure);
    await expect(controlCodingSchedule("task-1", "sch_a", "pause")).rejects.toBe(failure);
  });
});
