// Issue #501 — presentational assistant speech-output controls. Verifies the persistent mute toggle's
// labels and disclosure, the transient status/alert strip across every phase, the always-present text
// fallback, the failure focus handoff, and zero axe violations.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import type { VoicePlaybackSnapshot } from "./hooks/voice-playback-state";
import {
  VoicePlaybackMuteButton,
  VoicePlaybackStatus,
  VoicePlaybackStatusFromBinding,
} from "./VoicePlayback";

function snapshot(overrides: Partial<VoicePlaybackSnapshot> = {}): VoicePlaybackSnapshot {
  return {
    profile: "speech-output",
    available: true,
    phase: "speaking",
    active: true,
    settled: false,
    speaking: true,
    paused: false,
    muted: false,
    replayAllowed: false,
    spoke: true,
    interruptions: 0,
    replays: 0,
    wireState: "playing",
    failureKind: undefined,
    lastInterruptAtMs: undefined,
    ...overrides,
  };
}

describe("VoicePlaybackMuteButton", () => {
  it("renders a labelled mute affordance and toggles on click", async () => {
    const onToggle = vi.fn();
    render(<VoicePlaybackMuteButton muted={false} onToggle={onToggle} />);
    const button = screen.getByRole("button", { name: "Mute assistant voice" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("aria-describedby");
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("flips to an unmute affordance while muted", () => {
    render(<VoicePlaybackMuteButton muted onToggle={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Unmute assistant voice" });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("discloses the optional, text-always-available nature for assistive tech", () => {
    render(<VoicePlaybackMuteButton muted={false} onToggle={vi.fn()} />);
    expect(screen.getByText(/full response is always available as text/iu)).toBeInTheDocument();
  });

  it("has no axe violations in muted and unmuted states", async () => {
    const unmuted = render(<VoicePlaybackMuteButton muted={false} onToggle={vi.fn()} />);
    expect(await axe(unmuted.container)).toHaveNoViolations();
    unmuted.unmount();
    const muted = render(<VoicePlaybackMuteButton muted onToggle={vi.fn()} />);
    expect(await axe(muted.container)).toHaveNoViolations();
  });
});

describe("VoicePlaybackStatus visibility", () => {
  it("renders nothing without playback capability (AC1)", () => {
    const { container } = render(
      <VoicePlaybackStatus
        snapshot={snapshot({ available: false })}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing between spoken turns (unavailable phase)", () => {
    const { container } = render(
      <VoicePlaybackStatus
        snapshot={snapshot({ phase: "unavailable", active: false, speaking: false })}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("VoicePlaybackStatus controls per phase", () => {
  it("speaking: announces and offers pause + stop", async () => {
    const onPause = vi.fn();
    const onStop = vi.fn();
    render(
      <VoicePlaybackStatus
        snapshot={snapshot({ phase: "speaking" })}
        onPause={onPause}
        onResume={vi.fn()}
        onStop={onStop}
        onReplay={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("The assistant is speaking.");
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onPause).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  });

  it("paused: offers resume + stop", async () => {
    const onResume = vi.fn();
    render(
      <VoicePlaybackStatus
        snapshot={snapshot({ phase: "paused", speaking: false, paused: true, wireState: "paused" })}
        onPause={vi.fn()}
        onResume={onResume}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("preparing: announces preparation with no transport buttons", () => {
    render(
      <VoicePlaybackStatus
        snapshot={snapshot({ phase: "preparing", speaking: false, wireState: "idle" })}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Preparing the spoken response…");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers replay only on a settled turn when replay is permitted", async () => {
    const onReplay = vi.fn();
    const settled = snapshot({
      phase: "complete",
      active: false,
      settled: true,
      speaking: false,
      wireState: "idle",
    });
    const withoutPermission = render(
      <VoicePlaybackStatus
        snapshot={settled}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={onReplay}
      />,
    );
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
    withoutPermission.unmount();

    render(
      <VoicePlaybackStatus
        snapshot={{ ...settled, replayAllowed: true }}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={onReplay}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it("interrupted: announces the barge-in and offers replay only when permitted", () => {
    const base = snapshot({
      phase: "interrupted",
      active: false,
      settled: true,
      speaking: false,
      wireState: "interrupted",
    });
    const withoutReplay = render(
      <VoicePlaybackStatus
        snapshot={base}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Spoken response interrupted.");
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
    withoutReplay.unmount();

    render(
      <VoicePlaybackStatus
        snapshot={{ ...base, replayAllowed: true }}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
  });

  it("canceled: announces the user stop", () => {
    render(
      <VoicePlaybackStatus
        snapshot={snapshot({
          phase: "canceled",
          active: false,
          settled: true,
          speaking: false,
          wireState: "stopped",
        })}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Spoken response stopped.");
  });

  it("failed: announces via an alert that points to the text fallback and hands focus to replay", () => {
    render(
      <VoicePlaybackStatus
        snapshot={snapshot({
          phase: "failed",
          active: false,
          settled: true,
          speaking: false,
          replayAllowed: true,
          failureKind: "provider-error",
          wireState: "stopped",
        })}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/shown as text/iu);
    // Focus handoff (WCAG 2.4.3): the replay recovery control receives focus.
    expect(screen.getByRole("button", { name: "Replay" })).toHaveFocus();
  });

  it("always carries the text-fallback note for assistive tech", () => {
    render(
      <VoicePlaybackStatus
        snapshot={snapshot({ phase: "speaking" })}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onStop={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    expect(screen.getByText(/full response is available as text/iu)).toBeInTheDocument();
  });

  it("has no axe violations across speaking, paused, failed, and complete phases", async () => {
    for (const snap of [
      snapshot({ phase: "speaking" }),
      snapshot({ phase: "paused", speaking: false, paused: true, wireState: "paused" }),
      snapshot({
        phase: "failed",
        active: false,
        settled: true,
        speaking: false,
        replayAllowed: true,
        wireState: "stopped",
      }),
      snapshot({
        phase: "complete",
        active: false,
        settled: true,
        speaking: false,
        replayAllowed: true,
        wireState: "idle",
      }),
    ]) {
      const view = render(
        <VoicePlaybackStatus
          snapshot={snap}
          onPause={vi.fn()}
          onResume={vi.fn()}
          onStop={vi.fn()}
          onReplay={vi.fn()}
        />,
      );
      expect(await axe(view.container)).toHaveNoViolations();
      view.unmount();
    }
  });
});

describe("VoicePlaybackStatusFromBinding", () => {
  it("threads the binding callbacks to the status surface", async () => {
    const binding = {
      snapshot: snapshot({ phase: "speaking" }),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      replay: vi.fn(),
    };
    render(<VoicePlaybackStatusFromBinding binding={binding} />);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(binding.pause).toHaveBeenCalledTimes(1);
  });
});
