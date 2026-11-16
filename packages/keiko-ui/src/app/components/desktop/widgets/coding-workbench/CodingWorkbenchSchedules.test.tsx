import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchSchedule } from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { controlCodingSchedule, fetchCodingSchedules } from "@/lib/coding-schedules-api";
import { CodingWorkbenchSchedules } from "./CodingWorkbenchSchedules";

vi.mock("@/lib/coding-schedules-api", () => ({
  controlCodingSchedule: vi.fn(),
  fetchCodingSchedules: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const DUE = "2026-11-07T09:30:00.000Z";

function schedule(overrides: Partial<CodingWorkbenchSchedule> = {}): CodingWorkbenchSchedule {
  return { id: "sch_one", status: "active", cadence: "in", runCount: 0, ...overrides };
}

function listed(schedules: readonly CodingWorkbenchSchedule[]): void {
  vi.mocked(fetchCodingSchedules).mockResolvedValue({ taskId: "task-7", schedules });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(controlCodingSchedule).mockResolvedValue({ status: "paused" });
});

describe("CodingWorkbenchSchedules", () => {
  it("renders nothing for an empty list", async () => {
    listed([]);
    const { container } = render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await waitFor(() => {
      expect(fetchCodingSchedules).toHaveBeenCalledTimes(1);
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("does not fetch without a task id", () => {
    const { container } = render(<CodingWorkbenchSchedules taskId={undefined} runActive={false} />);
    expect(fetchCodingSchedules).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("reads the shown task's schedules", async () => {
    listed([schedule()]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await screen.findByRole("region", { name: "Scheduled continuations" });
    expect(vi.mocked(fetchCodingSchedules).mock.calls[0]?.[0]).toBe("task-7");
  });

  it("shows name or unnamed label with the next time, and paused and done states", async () => {
    listed([
      schedule({ id: "sch_a", name: "Nightly check", dueAt: DUE }),
      schedule({ id: "sch_b", dueAt: DUE }),
      schedule({ id: "sch_c", name: "Held", status: "paused" }),
      schedule({ id: "sch_d", name: "Finished", status: "done" }),
    ]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    const items = await screen.findAllByRole("listitem");
    const time = new Date(DUE).toLocaleString();
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent(`Nightly check · next ${time}`);
    expect(items[1]).toHaveTextContent(`Scheduled continuation · next ${time}`);
    expect(items[2]).toHaveTextContent("Held · paused");
    expect(items[3]).toHaveTextContent("Finished · done");
  });

  it("falls back to the cadence text and shows each wait reason", async () => {
    listed([
      schedule({ id: "sch_a", cadenceText: "30 minutes", wait: "run-active" }),
      schedule({ id: "sch_b", name: "B", wait: "workspace-inactive" }),
      schedule({ id: "sch_c", name: "C", wait: "retrying" }),
    ]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("30 minutes · due, waits for the current run");
    expect(items[1]).toHaveTextContent("B · due, waits for this task's workspace");
    expect(items[2]).toHaveTextContent("C · due, tries again shortly");
  });

  it("offers Pause on an active row, Resume on a paused row, and Delete on both", async () => {
    listed([
      schedule({ id: "sch_a", name: "Active one" }),
      schedule({ id: "sch_b", name: "Paused one", status: "paused" }),
    ]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    const [active, paused] = await screen.findAllByRole("listitem");
    const names = (item: HTMLElement | undefined): string[] =>
      Array.from(item?.querySelectorAll("button") ?? []).map((b) => b.textContent ?? "");
    expect(names(active)).toEqual(["Pause", "Delete"]);
    expect(names(paused)).toEqual(["Resume", "Delete"]);
  });

  it.each([
    ["Pause", "Active one", "sch_a", "pause"],
    ["Resume", "Paused one", "sch_b", "resume"],
    ["Delete", "Active one", "sch_a", "delete"],
  ] as const)("%s calls the control API and then refreshes", async (label, name, id, action) => {
    listed([
      schedule({ id: "sch_a", name: "Active one" }),
      schedule({ id: "sch_b", name: "Paused one", status: "paused" }),
    ]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    const items = await screen.findAllByRole("listitem");
    const row = items.find((item) => (item.textContent ?? "").startsWith(name));
    if (row === undefined) throw new Error("row not found");
    fireEvent.click(within(row).getByRole("button", { name: label }));
    await waitFor(() => {
      expect(fetchCodingSchedules).toHaveBeenCalledTimes(2);
    });
    expect(controlCodingSchedule).toHaveBeenCalledWith("task-7", id, action);
  });

  it("disables every action while the run is active", async () => {
    listed([schedule({ name: "One" })]);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive />);
    await screen.findByRole("region", { name: "Scheduled continuations" });
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(controlCodingSchedule).not.toHaveBeenCalled();
  });

  it("disables the actions while a change is in flight", async () => {
    listed([schedule({ name: "One" })]);
    let finish: () => void = () => undefined;
    vi.mocked(controlCodingSchedule).mockReturnValue(
      new Promise((resolve) => {
        finish = (): void => {
          resolve({ status: "paused" });
        };
      }),
    );
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    });
    finish();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });
  });

  it("reads again when the run settles", async () => {
    listed([schedule({ name: "One" })]);
    const { rerender } = render(<CodingWorkbenchSchedules taskId="task-7" runActive />);
    await screen.findByRole("region", { name: "Scheduled continuations" });
    rerender(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await waitFor(() => {
      expect(fetchCodingSchedules).toHaveBeenCalledTimes(2);
    });
  });

  it("shows the error and reports a body-free diagnostic when a change fails", async () => {
    listed([schedule({ id: "sch_secret", name: "Secret name" })]);
    const failure = new ApiError("INTERNAL", "Secret prompt text", 500);
    failure.correlationId = "corr-123";
    vi.mocked(controlCodingSchedule).mockRejectedValue(failure);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The schedules could not be read or changed. Try again.",
    );
    const [message, context] = vi.mocked(reportClientDiagnostic).mock.calls[0] ?? [];
    expect(message).toContain("delete failed");
    expect(context).toEqual({ correlationId: "corr-123" });
    for (const secret of ["Secret name", "Secret prompt", "sch_secret", "task-7"])
      expect(message).not.toContain(secret);
  });

  it("shows the error when the list cannot be read", async () => {
    vi.mocked(fetchCodingSchedules).mockRejectedValue(new Error("down"));
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await waitFor(() => {
      expect(reportClientDiagnostic).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(reportClientDiagnostic).mock.calls[0]?.[0]).toContain("list failed");
  });

  it("has no axe violations", async () => {
    listed([
      schedule({ id: "sch_a", name: "Active one", dueAt: DUE }),
      schedule({ id: "sch_b", name: "Paused one", status: "paused" }),
    ]);
    const { container } = render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);
    await screen.findByRole("region", { name: "Scheduled continuations" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
