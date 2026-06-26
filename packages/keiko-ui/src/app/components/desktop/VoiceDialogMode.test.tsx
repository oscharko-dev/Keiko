// Issue #1559 — mutation-robust coverage for the four presentational VoiceDialogMode surfaces.
// Tests verify role=switch, aria-checked, profile options/active label, live-region roles, per-state
// headlines, controls presence, keyboard operability, compact flag, and the "unavailable => nothing"
// guarantee (AC3).

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  VOICE_PROFILE_LABEL_ID,
  VoiceDialogControls,
  VoiceDialogModeSwitch,
  VoiceDialogSessionStatus,
  VoiceProfileSelect,
  personaLabel,
} from "./VoiceDialogMode";
import type { VoiceDialogState } from "./hooks/voice-dialog-state";

const ALL_STATES: readonly VoiceDialogState[] = [
  "idle",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "muted",
  "interrupted",
  "error",
];

// ─── personaLabel ────────────────────────────────────────────────────────────────

describe("personaLabel", () => {
  it("returns distinct, non-empty English labels for each canonical persona", () => {
    const labels = (["male", "female", "neutral"] as const).map(personaLabel);
    expect(new Set(labels).size).toBe(3);
    labels.forEach((l) => expect(l.length).toBeGreaterThan(0));
  });
});

// ─── VoiceDialogModeSwitch ────────────────────────────────────────────────────────

describe("VoiceDialogModeSwitch", () => {
  it("renders a button with role=switch (AC4 / WCAG 1.3.1)", () => {
    const { rerender } = render(
      <VoiceDialogModeSwitch active={false} onToggle={() => undefined} />,
    );
    const btn = screen.getByRole("switch", { name: "Voice dialogue mode" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-checked", "false");

    rerender(<VoiceDialogModeSwitch active={true} onToggle={() => undefined} />);
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("calls onToggle when clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<VoiceDialogModeSwitch active={false} onToggle={onToggle} />);
    await user.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("calls onToggle when activated with keyboard (Enter / Space)", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<VoiceDialogModeSwitch active={false} onToggle={onToggle} />);
    screen.getByRole("switch").focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ }");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("disabled button is inert and does not call onToggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<VoiceDialogModeSwitch active={false} onToggle={onToggle} disabled />);
    const btn = screen.getByRole("switch");
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("adds cmp-mode-compact class when compact=true", () => {
    render(<VoiceDialogModeSwitch active={false} onToggle={() => undefined} compact />);
    expect(screen.getByRole("switch")).toHaveClass("cmp-mode-compact");
  });

  it("sets data-active attribute reflecting the active prop", () => {
    const { rerender } = render(
      <VoiceDialogModeSwitch active={false} onToggle={() => undefined} />,
    );
    expect(screen.getByRole("switch")).toHaveAttribute("data-active", "false");
    rerender(<VoiceDialogModeSwitch active={true} onToggle={() => undefined} />);
    expect(screen.getByRole("switch")).toHaveAttribute("data-active", "true");
  });

  it("forwards a ref to the underlying button", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<VoiceDialogModeSwitch active={false} onToggle={() => undefined} buttonRef={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});

// ─── VoiceProfileSelect ───────────────────────────────────────────────────────────

describe("VoiceProfileSelect", () => {
  it("renders nothing when the personas list is empty (AC3 — no stray combobox)", () => {
    const { container } = render(
      <VoiceProfileSelect personas={[]} selected="male" onSelect={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("exposes all three personas as selectable options", async () => {
    const user = userEvent.setup();
    render(
      <VoiceProfileSelect
        personas={["male", "female", "neutral"]}
        selected="male"
        onSelect={() => undefined}
      />,
    );
    // Stub getBoundingClientRect so jsdom returns a non-zero rect and KeikoSelect renders the menu.
    const combobox = screen.getByRole("combobox");
    vi.spyOn(combobox, "getBoundingClientRect").mockReturnValue({
      bottom: 142,
      height: 42,
      left: 64,
      right: 304,
      top: 100,
      width: 240,
      x: 64,
      y: 100,
      toJSON: () => ({}),
    });
    await user.click(combobox);
    // All persona options should be in the menu after opening.
    expect(screen.getByRole("option", { name: "Male voice" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Female voice" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Neutral voice" })).toBeInTheDocument();
  });

  it("shows the active voice label via sr-only span linked to VOICE_PROFILE_LABEL_ID", () => {
    render(
      <VoiceProfileSelect
        personas={["male", "female", "neutral"]}
        selected="female"
        onSelect={() => undefined}
      />,
    );
    const label = document.getElementById(VOICE_PROFILE_LABEL_ID);
    expect(label).not.toBeNull();
    expect(label?.textContent).toMatch(/Female voice/u);
  });

  it("calls onSelect with the chosen persona", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <VoiceProfileSelect
        personas={["male", "female", "neutral"]}
        selected="male"
        onSelect={onSelect}
      />,
    );
    const combobox = screen.getByRole("combobox");
    vi.spyOn(combobox, "getBoundingClientRect").mockReturnValue({
      bottom: 142,
      height: 42,
      left: 64,
      right: 304,
      top: 100,
      width: 240,
      x: 64,
      y: 100,
      toJSON: () => ({}),
    });
    await user.click(combobox);
    const neutralOption = screen.getByRole("option", { name: "Neutral voice" });
    await user.click(neutralOption);
    expect(onSelect).toHaveBeenCalledWith("neutral");
  });
});

// ─── VoiceDialogSessionStatus ───────────────────────────────────────────────────

describe("VoiceDialogSessionStatus", () => {
  it("has role=status and aria-live=polite for every non-error state", () => {
    const nonErrorStates = ALL_STATES.filter((s) => s !== "error");
    for (const state of nonErrorStates) {
      const { unmount } = render(<VoiceDialogSessionStatus state={state} />);
      const region = screen.getByRole("status");
      expect(region).toHaveAttribute("aria-live", "polite");
      unmount();
    }
  });

  it("uses role=alert (no aria-live attr) for the error state so SR announces immediately (AC4)", () => {
    render(<VoiceDialogSessionStatus state="error" />);
    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveAttribute("aria-live");
  });

  it("shows a distinct, non-empty headline for every state", () => {
    const seen = new Set<string>();
    for (const state of ALL_STATES) {
      const { unmount, container } = render(<VoiceDialogSessionStatus state={state} />);
      // The headline is the visible paragraph text, excluding sr-only spans.
      const p = container.querySelector("p");
      expect(p).not.toBeNull();
      const text = p?.textContent?.trim();
      expect(text?.length).toBeGreaterThan(0);
      seen.add(text ?? "");
      unmount();
    }
    expect(seen.size).toBe(ALL_STATES.length);
  });

  it("renders a live-status dot only for the 'live' states (listening, speaking, muted)", () => {
    const liveStates: readonly VoiceDialogState[] = ["listening", "speaking", "muted"];
    for (const state of ALL_STATES) {
      const { container, unmount } = render(<VoiceDialogSessionStatus state={state} />);
      const dot = container.querySelector(".cmp-voice-dot");
      if (liveStates.includes(state)) {
        expect(dot, `expected dot for state ${state}`).not.toBeNull();
      } else {
        expect(dot, `expected no dot for state ${state}`).toBeNull();
      }
      unmount();
    }
  });

  it("sets data-dialog-state attribute to the current state", () => {
    for (const state of ALL_STATES) {
      const { container, unmount } = render(<VoiceDialogSessionStatus state={state} />);
      expect(container.firstElementChild).toHaveAttribute("data-dialog-state", state);
      unmount();
    }
  });
});

// ─── VoiceDialogControls ───────────────────────────────────────────────────────────

describe("VoiceDialogControls", () => {
  function renderControls(overrides: Partial<Parameters<typeof VoiceDialogControls>[0]> = {}) {
    const defaults: Parameters<typeof VoiceDialogControls>[0] = {
      state: "listening",
      muted: false,
      onToggleMute: vi.fn(),
      onStop: vi.fn(),
      onLeave: vi.fn(),
      personas: ["male", "female", "neutral"],
      selectedPersona: "male",
      onSelectPersona: vi.fn(),
    };
    return render(<VoiceDialogControls {...defaults} {...overrides} />);
  }

  it("renders the Stop and Leave buttons and the mute control", () => {
    renderControls();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave voice dialogue" })).toBeInTheDocument();
    // Mute button comes from VoicePlaybackMuteButton — accessible name starts with Mute/Unmute.
    expect(screen.getByRole("button", { name: /mute/iu })).toBeInTheDocument();
  });

  it("Stop button is keyboard operable", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    renderControls({ onStop });
    const stopBtn = screen.getByRole("button", { name: "Stop" });
    stopBtn.focus();
    await user.keyboard("{Enter}");
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("Leave button is keyboard operable", async () => {
    const user = userEvent.setup();
    const onLeave = vi.fn();
    renderControls({ onLeave });
    const leaveBtn = screen.getByRole("button", { name: "Leave voice dialogue" });
    leaveBtn.focus();
    await user.keyboard("{ }");
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("mute button calls onToggleMute and reflects muted state", async () => {
    const user = userEvent.setup();
    const onToggleMute = vi.fn();
    const { rerender } = renderControls({ muted: false, onToggleMute });
    const muteBtn = screen.getByRole("button", { name: "Mute assistant voice" });
    await user.click(muteBtn);
    expect(onToggleMute).toHaveBeenCalledOnce();

    rerender(
      <VoiceDialogControls
        state="muted"
        muted={true}
        onToggleMute={onToggleMute}
        onStop={vi.fn()}
        onLeave={vi.fn()}
        personas={["male", "female", "neutral"]}
        selectedPersona="male"
        onSelectPersona={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Unmute assistant voice" })).toBeInTheDocument();
  });

  it("focuses the Leave button when state transitions to error (focus handoff WCAG 2.4.3)", async () => {
    const { rerender } = renderControls({ state: "listening" });
    const leaveBtn = screen.getByRole("button", { name: "Leave voice dialogue" });
    // Before error, Leave is not focused.
    expect(document.activeElement).not.toBe(leaveBtn);

    rerender(
      <VoiceDialogControls
        state="error"
        muted={false}
        onToggleMute={vi.fn()}
        onStop={vi.fn()}
        onLeave={vi.fn()}
        personas={["male", "female", "neutral"]}
        selectedPersona="male"
        onSelectPersona={vi.fn()}
      />,
    );
    // After error, focus should move to Leave.
    expect(document.activeElement).toBe(leaveBtn);
  });

  it("onSelectPersona is forwarded to VoiceProfileSelect inside the controls cluster", async () => {
    const user = userEvent.setup();
    const onSelectPersona = vi.fn();
    renderControls({ onSelectPersona });
    const combobox = screen.getByRole("combobox");
    vi.spyOn(combobox, "getBoundingClientRect").mockReturnValue({
      bottom: 142,
      height: 42,
      left: 64,
      right: 304,
      top: 100,
      width: 240,
      x: 64,
      y: 100,
      toJSON: () => ({}),
    });
    await user.click(combobox);
    const femaleOption = screen.getByRole("option", { name: "Female voice" });
    await user.click(femaleOption);
    expect(onSelectPersona).toHaveBeenCalledWith("female");
  });

  it("compact=true propagates into the cluster's children", () => {
    renderControls({ compact: true });
    // VoiceProfileSelect's wrapper gets cmp-model-compact. Test the DOM attribute.
    // We cannot test KeikoSelect internals deeply, but we can assert the outer wrapper class appears.
    const wrapper = document.querySelector(".cmp-model-compact");
    expect(wrapper).not.toBeNull();
  });
});
