import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchSchedule,
  CodingWorkbenchScheduleAction,
} from "@oscharko-dev/keiko-contracts";
import { bffFetchJson } from "@/lib/http";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { CODING_SCHEDULES_ROOT as ROOT } from "@/lib/coding-schedules-api";
import { CodingWorkbenchSchedules } from "./CodingWorkbenchSchedules";

// #4546 (acceptance of the native automation clause): the Workbench lists an automation the way
// a schedule route response shapes a native run's `automation` row and drives its pause, resume
// and delete. Only the transport is replaced by a stub (`serve`) that is NOT the server's routes;
// the API module under the component is the real one and its exported route root is used here, so
// this proves the component and API module agree with each other, not the server's registration.
vi.mock("@/lib/coding-app-session-client", () => ({
  codingAppSessionPairingSettled: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@/lib/http", () => ({ bffFetchJson: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const DUE = "2026-11-26T09:30:00.000Z";

/** A prompt automation as the schedule route returns it: the runtime's id, a `at` trigger. */
const AUTOMATION: CodingWorkbenchSchedule = {
  id: "aut_01KB3F9ZQ7",
  name: "Check the build again",
  status: "active",
  cadence: "at",
  cadenceText: "in 1 hour",
  dueAt: DUE,
  runCount: 0,
};

interface Server {
  schedules: CodingWorkbenchSchedule[];
  /** The control action the stub answers with a failure, when set. */
  failAction?: CodingWorkbenchScheduleAction | undefined;
  readonly requests: { readonly path: string; readonly method: string; readonly body: unknown }[];
}

/** The server's two schedule routes over one task, answering as they do. */
function serve(server: Server): void {
  vi.mocked(bffFetchJson).mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    server.requests.push({
      path,
      method,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (method === "GET") return Promise.resolve({ taskId: "task-7", schedules: server.schedules });
    const [id, action] = path.slice(ROOT.length + 1).split("/") as [
      string,
      CodingWorkbenchScheduleAction,
    ];
    if (action === server.failAction) return Promise.reject(new Error("control failed"));
    if (action === "delete") {
      server.schedules = server.schedules.filter((schedule) => schedule.id !== id);
      return Promise.resolve({ status: "deleted" });
    }
    const status = action === "pause" ? "paused" : "active";
    server.schedules = server.schedules.map((schedule) =>
      schedule.id === id ? { ...schedule, status } : schedule,
    );
    return Promise.resolve({ status });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("CodingWorkbenchSchedules against the server's schedule routes", () => {
  it("lists a native automation, pauses, resumes and deletes it through the routes", async () => {
    const server: Server = { schedules: [AUTOMATION], requests: [] };
    serve(server);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);

    const row = (await screen.findAllByRole("listitem"))[0];
    if (row === undefined) throw new Error("the automation is not listed");
    expect(row).toHaveTextContent(`Check the build again · next ${new Date(DUE).toLocaleString()}`);
    expect(server.requests[0]).toEqual({
      path: `${ROOT}?taskId=task-7`,
      method: "GET",
      body: undefined,
    });

    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(screen.getByRole("listitem")).toHaveTextContent("Check the build again · paused");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(screen.queryByRole("listitem")).toBeNull();
    });

    expect(
      server.requests.filter(({ method }) => method === "POST").map(({ path }) => path),
    ).toEqual([
      `${ROOT}/aut_01KB3F9ZQ7/pause`,
      `${ROOT}/aut_01KB3F9ZQ7/resume`,
      `${ROOT}/aut_01KB3F9ZQ7/delete`,
    ]);
    for (const { body } of server.requests.filter(({ method }) => method === "POST"))
      expect(body).toEqual({ taskId: "task-7" });
  });

  // The component reads the list again after every control attempt; that read must not clear the
  // alert of a failed control, so the person sees it, and the next successful control clears it.
  it("reports a failed control action, keeps its alert past the list read, and keeps the row", async () => {
    const server: Server = { schedules: [AUTOMATION], requests: [], failAction: "pause" };
    serve(server);
    render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(reportClientDiagnostic).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(reportClientDiagnostic).mock.calls[0]?.[0]).toContain("pause failed");
    expect(await screen.findByRole("button", { name: "Pause" })).toBeEnabled();
    await waitFor(() => {
      expect(server.requests.filter((request) => request.method === "GET")).toHaveLength(2);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("Check the build again");

    server.failAction = "delete";
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(reportClientDiagnostic).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(reportClientDiagnostic).mock.calls[1]?.[0]).toContain("delete failed");
    expect(screen.getByRole("listitem")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    server.failAction = undefined;
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("renders nothing for a task without schedules", async () => {
    const server: Server = { schedules: [], requests: [] };
    serve(server);
    const { container } = render(<CodingWorkbenchSchedules taskId="task-7" runActive={false} />);

    await waitFor(() => {
      expect(server.requests).toHaveLength(1);
    });
    expect(container).toBeEmptyDOMElement();
  });
});
