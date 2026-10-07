import { act, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import {
  CodingWorkbenchRunAnnouncement,
  CodingWorkbenchRunStatus,
} from "./CodingWorkbenchRunStatus";

const STARTED = "2026-10-06T10:00:00.000Z";
const NOW = "2026-10-06T10:02:14.000Z";
const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;

function snapshot(
  state: CodingWorkbenchRuntimeStateName,
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state,
    revision: 4,
    updatedAt: NOW,
    runId: "run-1",
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function status(
  sequence: number,
  state: CodingWorkbenchRuntimeStateName,
  occurredAt: string,
): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `run-1:${String(sequence)}`,
    sequence,
    occurredAt,
    kind: "status",
    runId: "run-1",
    state,
    revision: sequence + 1,
  };
}

function runState(
  run: CodingWorkbenchRuntimeSnapshot,
  events: readonly CodingWorkbenchRuntimeSseEvent[],
): CodingWorkbenchRuntimeState {
  return {
    ...createInitialCodingWorkbenchRuntimeState(),
    source: {
      status: "ready",
      value: {
        runtimePreference: "managed-gateway",
        modelSource: "keiko-model-gateway",
        runtimeSource: "keiko-sidecar",
        available: true,
        verification: "verified",
      },
      error: null,
    },
    workspace: {
      status: "ready",
      value: {
        workspaceId: "workspace-1",
        taskId: "task-1",
        taskBranch: "issue/3873",
        health: "healthy",
        switching: false,
      },
      error: null,
    },
    runtime: {
      status: "ready",
      value: {
        schemaVersion: "1",
        requestedMode: "supervised-coding",
        deploymentCeiling: "autonomous-delivery",
        effectiveMode: "supervised-coding",
        runtimeAvailable: true,
        runtimeEvidenceClass: "functional-not-platform-qualified",
      },
      error: null,
    } as CodingWorkbenchRuntimeState["runtime"],
    run: { status: "ready", value: run, error: null },
    events,
  };
}

const RUNNING = runState(snapshot("running"), [
  status(0, "starting", STARTED),
  status(1, "running", STARTED),
]);

describe("CodingWorkbenchRunStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // #3873 live review: the run status region read "Running. Revision 4. Model source ready.
  // Subscription authentication not selected. Workspace ready. Runtime available as an unverified
  // evaluation runtime. …". The run's own state, its elapsed time and revision lead; the readiness
  // facts sit in a collapsed disclosure that assistive technology can still open.
  it("leads with the run state, elapsed time, revision and phase before readiness", async () => {
    const { container } = render(
      <CodingWorkbenchRunStatus state={RUNNING} researchGrant={null} phase="model" />,
    );

    const announcement = screen.getByTestId("coding-runtime-announcement");
    expect(announcement).toHaveTextContent(/^Running\. Revision 4\.$/u);
    expect(announcement).toHaveAttribute("role", "status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("timer")).toHaveTextContent("Elapsed 2 min 14 s");
    expect(screen.getByTestId("coding-runtime-phase")).toHaveTextContent("Waiting for the model");

    const readiness = screen.getByTestId("coding-runtime-readiness");
    expect(readiness).toHaveTextContent("Model source ready.");
    expect(readiness).toHaveTextContent("Subscription authentication not selected.");
    expect(readiness).toHaveTextContent("Runtime available as an unverified evaluation runtime");
    const disclosure = readiness.closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText("Readiness details").tagName).toBe("SUMMARY");
    expect(
      announcement.compareDocumentPosition(readiness) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    vi.useRealTimers();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  // #3873 review: an outage rides on for minutes, and "Waiting for the model" read the same as a
  // slow generation. The phase names a model gateway that is unavailable and being retried.
  it("names a model gateway that is unavailable and being retried as the run's phase", async () => {
    const { container } = render(
      <CodingWorkbenchRunStatus state={RUNNING} researchGrant={null} phase="gateway" />,
    );

    expect(screen.getByTestId("coding-runtime-phase")).toHaveTextContent(
      "Model gateway unavailable, retrying",
    );
    expect(screen.getByTestId("coding-runtime-announcement")).toHaveTextContent(
      /^Running\. Revision 4\.$/u,
    );

    vi.useRealTimers();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("ticks once a second while the run lives and stops at settlement", () => {
    const { rerender } = render(
      <CodingWorkbenchRunStatus state={RUNNING} researchGrant={null} phase="model" />,
    );
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("Elapsed 2 min 14 s");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("Elapsed 2 min 15 s");

    const settledAt = "2026-10-06T10:12:05.000Z";
    rerender(
      <CodingWorkbenchRunStatus
        state={runState(snapshot("failed", { revision: 9, updatedAt: settledAt }), [
          status(0, "starting", STARTED),
          status(8, "failed", settledAt),
        ])}
        researchGrant={null}
        phase={null}
      />,
    );
    expect(screen.getByRole("timer")).toHaveTextContent("Took 12 min 5 s");
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("Took 12 min 5 s");
    expect(screen.queryByTestId("coding-runtime-phase")).toBeNull();
  });

  it("keeps a seen start after the bounded event window drops it", () => {
    const { rerender } = render(
      <CodingWorkbenchRunStatus state={RUNNING} researchGrant={null} phase={null} />,
    );
    rerender(
      <CodingWorkbenchRunStatus
        state={runState(snapshot("running"), [status(612, "running", NOW)])}
        researchGrant={null}
        phase={null}
      />,
    );
    expect(screen.getByRole("timer")).toHaveTextContent("Elapsed 2 min 14 s");
  });

  it("announces the same run status without a laid-out line where setup is centred", () => {
    render(<CodingWorkbenchRunAnnouncement state={RUNNING} researchGrant={null} />);

    const announcement = screen.getByRole("status");
    expect(announcement).toHaveAttribute("data-testid", "coding-runtime-announcement");
    expect(announcement).toHaveClass("sr-only");
    expect(announcement).toHaveTextContent(/^Running\. Revision 4\.$/u);
    expect(screen.queryByTestId("coding-runtime-readiness")).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
  });

  // #3873 review: the readiness facts moved into the collapsed details, which left an unavailable
  // runtime announced to no one. The fact that says the Workbench cannot start is appended to the
  // polite, atomic status sentence — visible text of a live region — while the details keep the
  // complete list and the healthy facts stay out of the sentence.
  it("appends an unavailable runtime to the run status and keeps the details complete", async () => {
    const unavailable: CodingWorkbenchRuntimeState = {
      ...RUNNING,
      runtime: {
        status: "ready",
        value: {
          schemaVersion: "1",
          requestedMode: "supervised-coding",
          deploymentCeiling: "autonomous-delivery",
          effectiveMode: "supervised-coding",
          runtimeAvailable: false,
          runtimeUnavailableReason: "runtime-unqualified",
        },
        error: null,
      } as CodingWorkbenchRuntimeState["runtime"],
    };
    const { container } = render(
      <CodingWorkbenchRunStatus state={unavailable} researchGrant={null} phase="model" />,
    );

    const announcement = screen.getByTestId("coding-runtime-announcement");
    expect(announcement).toHaveAttribute("role", "status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(announcement).toBeVisible();
    expect(announcement).toHaveTextContent(/^Running\. Revision 4\. Runtime unavailable\.$/u);
    expect(announcement).not.toHaveTextContent(/Model source ready|Workspace ready/u);

    const readiness = screen.getByTestId("coding-runtime-readiness");
    expect(readiness).toHaveTextContent("Runtime unavailable.");
    expect(readiness).toHaveTextContent("Model source ready.");
    expect(readiness.closest("details")).not.toHaveAttribute("open");

    vi.useRealTimers();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("announces an unavailable runtime where setup is centred, in the same polite, atomic status", () => {
    const unavailable: CodingWorkbenchRuntimeState = {
      ...RUNNING,
      pairing: "unpaired",
      run: { status: "ready", value: snapshot("idle", { runId: undefined }), error: null },
    };
    render(<CodingWorkbenchRunAnnouncement state={unavailable} researchGrant={null} />);

    const announcement = screen.getByRole("status");
    expect(announcement).toHaveClass("sr-only");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(announcement).toHaveTextContent(
      "Workbench is not paired. Open Keiko from the launcher.",
    );
    expect(screen.queryByTestId("coding-runtime-readiness")).toBeNull();
  });

  it("shows no elapsed time when the run's start is not known", () => {
    render(
      <CodingWorkbenchRunStatus
        state={runState(snapshot("failed"), [])}
        researchGrant={null}
        phase={null}
      />,
    );
    expect(screen.getByTestId("coding-runtime-announcement")).toHaveTextContent(
      "Failed. Revision 4.",
    );
    expect(screen.queryByRole("timer")).toBeNull();
  });
});
