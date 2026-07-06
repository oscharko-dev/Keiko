// Issue #497 — presentational realtime-voice controls. Verifies the button's dynamic state labels,
// the status/error surfaces, keyboard/focus handoff, the discoverable local-only privacy disclosure,
// and zero axe violations across phases.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import {
  VoiceRealtimeButton,
  VoiceRealtimeStatus,
  VoiceRealtimeStatusFromController,
} from "./VoiceRealtime";
import type { RealtimeVoiceController } from "./hooks/useRealtimeVoice";

const IDLE_TURN_SNAPSHOT: RealtimeVoiceController["turnSnapshot"] = {
  profile: "full-realtime",
  active: true,
  state: "idle",
  floorHolder: "none",
  turnIndex: 0,
  interruptions: 0,
  backchannels: 0,
  pendingCommit: false,
  recovering: false,
  lastEndOfTurnAtMs: undefined,
  lastInterruptAtMs: undefined,
};

describe("VoiceRealtimeButton", () => {
  it("renders a labelled start affordance when idle and starts on click", async () => {
    const onStart = vi.fn();
    render(<VoiceRealtimeButton phase="idle" onStart={onStart} onStop={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Start realtime voice" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("aria-describedby");
    await userEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("flips to a stop affordance while connected and stops on click", async () => {
    const onStop = vi.fn();
    render(<VoiceRealtimeButton phase="connected" onStart={vi.fn()} onStop={onStop} />);
    const button = screen.getByRole("button", { name: "Stop realtime voice" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("is busy and inert (aria-disabled) while requesting or negotiating", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <VoiceRealtimeButton phase="requesting" onStart={onStart} onStop={onStop} />,
    );
    let button = screen.getByRole("button", { name: "Starting microphone…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);

    rerender(<VoiceRealtimeButton phase="negotiating" onStart={onStart} onStop={onStop} />);
    button = screen.getByRole("button", { name: "Connecting realtime voice…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);

    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("is operable by keyboard (Space/Enter parity with mouse) when idle", async () => {
    const onStart = vi.fn();
    render(<VoiceRealtimeButton phase="idle" onStart={onStart} onStop={vi.fn()} />);
    screen.getByRole("button", { name: "Start realtime voice" }).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("exposes the local-only privacy disclosure", () => {
    render(<VoiceRealtimeButton phase="idle" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(
      screen.getByText(
        "Your audio is streamed directly to your configured realtime provider and is not stored.",
      ),
    ).toBeInTheDocument();
  });

  it("has no axe violations in idle and connected states", async () => {
    const idle = render(<VoiceRealtimeButton phase="idle" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(await axe(idle.container)).toHaveNoViolations();
    idle.unmount();
    const connected = render(
      <VoiceRealtimeButton phase="connected" onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(await axe(connected.container)).toHaveNoViolations();
  });

  it("has no axe violations in the requesting and negotiating transient states", async () => {
    const req = render(
      <VoiceRealtimeButton phase="requesting" onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(await axe(req.container)).toHaveNoViolations();
    req.unmount();
    const neg = render(
      <VoiceRealtimeButton phase="negotiating" onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(await axe(neg.container)).toHaveNoViolations();
  });
});

describe("VoiceRealtimeStatus", () => {
  it("renders nothing when idle or requesting", () => {
    const { container } = render(
      <VoiceRealtimeStatus phase="idle" error={undefined} onRetry={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the negotiating state politely (role=status)", () => {
    render(
      <VoiceRealtimeStatus
        phase="negotiating"
        error={undefined}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Connecting realtime voice…");
  });

  it("announces the connected state politely (role=status)", () => {
    render(
      <VoiceRealtimeStatus
        phase="connected"
        error={undefined}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Realtime voice connected.");
  });

  it("shows redaction-safe memory activity when realtime memory context is present", () => {
    render(
      <VoiceRealtimeStatus
        phase="connected"
        error={undefined}
        memoryContextText={"Included memory context:\n- Use pnpm"}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const memory = screen.getByLabelText("MemoriaViva voice memory");
    expect(memory).toHaveTextContent("MemoriaViva context active.");
    expect(memory).not.toHaveTextContent("Use pnpm");
  });

  it("shows the recalled memory count when supplied", () => {
    render(
      <VoiceRealtimeStatus
        phase="connected"
        error={undefined}
        memoryContextText={"Included memory context:\n- Use pnpm\n- Use vitest"}
        memoryContextCount={2}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("MemoriaViva voice memory")).toHaveTextContent(
      "2 recalled memories active.",
    );
    expect(screen.queryByText("Use pnpm")).toBeNull();
  });

  it("surfaces pending memory candidates with approve and reject actions", async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const onReject = vi.fn().mockResolvedValue(undefined);
    render(
      <VoiceRealtimeStatus
        phase="connected"
        error={undefined}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        memoryActions={[
          {
            kind: "candidate",
            proposalId: "proposal-1",
            body: "The user's preferred test runner is Vitest.",
            scopeLabel: "Project memory",
            requiresApproval: false,
          },
        ]}
        onAcceptMemoryCandidate={onAccept}
        onRejectMemoryCandidate={onReject}
      />,
    );

    expect(screen.getByLabelText("MemoriaViva voice memory")).toHaveTextContent(
      "The user's preferred test runner is Vitest.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onAccept).toHaveBeenCalledWith("proposal-1");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-busy", "false"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith("proposal-1");
  });

  it("renders an alert with retry/dismiss on error and focuses retry", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(
      <VoiceRealtimeStatus
        phase="error"
        error={{ reason: "permission-denied", message: "denied" }}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Microphone access was denied/u);
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["permission-denied", /Microphone access was denied/u],
    ["no-microphone", /No microphone was found/u],
    ["unsupported", /does not support realtime voice/u],
    ["unavailable", /not available right now/u],
    ["negotiation-failed", /connection could not be established/u],
    ["connection-failed", /connection was lost/u],
  ] as const)("renders a scoped headline for the %s error reason", (reason, pattern) => {
    render(
      <VoiceRealtimeStatus
        phase="error"
        error={{ reason, message: "detail" }}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(pattern);
  });

  it("has no axe violations in negotiating, connected, and error states", async () => {
    const neg = render(
      <VoiceRealtimeStatus
        phase="negotiating"
        error={undefined}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(await axe(neg.container)).toHaveNoViolations();
    neg.unmount();

    const conn = render(
      <VoiceRealtimeStatus
        phase="connected"
        error={undefined}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(await axe(conn.container)).toHaveNoViolations();
    conn.unmount();

    const err = render(
      <VoiceRealtimeStatus
        phase="error"
        error={{ reason: "connection-failed", message: "x" }}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(await axe(err.container)).toHaveNoViolations();
  });
});

describe("VoiceRealtimeStatusFromController", () => {
  function makeController(
    overrides: Partial<RealtimeVoiceController> = {},
  ): RealtimeVoiceController {
    return {
      phase: "connected",
      busy: true,
      turnSnapshot: IDLE_TURN_SNAPSHOT,
      listening: false,
      speaking: false,
      canInterrupt: false,
      muted: false,
      retrieving: false,
      error: undefined,
      start: vi.fn(),
      stop: vi.fn(),
      retry: vi.fn(),
      interrupt: vi.fn(),
      toggleMute: vi.fn(),
      ...overrides,
    };
  }

  it("wires status to the controller and calls stop + onAfterDismiss on dismiss", () => {
    const controller = makeController({
      phase: "error",
      error: { reason: "connection-failed", message: "x" },
    });
    const onAfterDismiss = vi.fn();
    render(
      <VoiceRealtimeStatusFromController controller={controller} onAfterDismiss={onAfterDismiss} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(onAfterDismiss).toHaveBeenCalledTimes(1);
  });

  it("wires retry to the controller", () => {
    const controller = makeController({
      phase: "error",
      error: { reason: "unavailable", message: "x" },
    });
    render(<VoiceRealtimeStatusFromController controller={controller} onAfterDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(controller.retry).toHaveBeenCalledTimes(1);
  });
});
