import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchSchedule } from "@oscharko-dev/keiko-contracts";
import { fetchCodingSchedules } from "@/lib/coding-schedules-api";
import {
  CodingWorkbenchSchedules,
  SCHEDULE_REREAD_GRACE_MS,
  SCHEDULE_REREAD_MAX_ATTEMPTS,
} from "./CodingWorkbenchSchedules";

vi.mock("@/lib/coding-schedules-api", () => ({
  controlCodingSchedule: vi.fn(),
  fetchCodingSchedules: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const NOW = Date.parse("2026-11-28T09:00:00.000Z");

function active(dueInMs: number, runCount: number): CodingWorkbenchSchedule {
  return {
    id: "aut_wake",
    status: "active",
    cadence: "in",
    name: "Check back",
    runCount,
    dueAt: new Date(NOW + dueInMs).toISOString(),
  };
}

function lists(...answers: readonly (readonly CodingWorkbenchSchedule[])[]): void {
  const queue = [...answers];
  vi.mocked(fetchCodingSchedules).mockImplementation(() =>
    // A fresh array per read, as every parsed response is.
    Promise.resolve({
      taskId: "task-7",
      schedules: [...(queue.length > 1 ? queue.shift()! : queue[0]!)],
    }),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// U-57: a wake the server fires while no run of this window is shown never changes `runActive`, so
// the list used to keep the pre-wake state until a manual refresh.
describe("the schedule list after a scheduled wake fires (U-57)", () => {
  it("reads the list again once the next wake is due, without a run in view", async () => {
    lists([active(5_000, 0)], [active(3_600_000, 1)]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await flush();
    expect(fetchCodingSchedules).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listitem")).toHaveTextContent("Check back · next");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000 + SCHEDULE_REREAD_GRACE_MS);
    });
    expect(fetchCodingSchedules).toHaveBeenCalledTimes(2);
  });

  it("does not read again before the wake is due", async () => {
    lists([active(600_000, 0)]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(fetchCodingSchedules).toHaveBeenCalledTimes(1);
  });

  it("keeps reading while the wake stays overdue, up to a bound", async () => {
    lists([active(-1_000, 0)]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await flush();
    // One act per step: React applies a read's answer, and so arms the next wait, when an act ends.
    for (let step = 0; step < SCHEDULE_REREAD_MAX_ATTEMPTS + 5; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SCHEDULE_REREAD_GRACE_MS);
      });
    }
    expect(fetchCodingSchedules).toHaveBeenCalledTimes(1 + SCHEDULE_REREAD_MAX_ATTEMPTS);
  });

  it("reads again when the window is shown again", async () => {
    lists([active(600_000, 0)], [active(600_000, 1)]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(fetchCodingSchedules).toHaveBeenCalledTimes(2);
  });
});
