// Issue #1563, Epic #1556 — AC4 accessibility verification for the voice dialogue mode surfaces.
//
// VoiceDialogMode.test.tsx pins each surface's individual a11y attributes; this suite is the
// CONSOLIDATED accessibility audit the issue requires for maintainer review before epic closure. It runs
// the seven WCAG-relevant checks across every dialogue surface and session state, then feeds the results
// into the production evaluation engine (scoreDialogueAccessibility) so the accessibility verdict is part
// of the same GO / NO-GO scorecard the report renders.
//
// Checks: an automated axe pass over the whole composed surface; keyboard operability (native
// button/switch semantics); stable accessible names; focus return to a recovery control on error; a
// live-region status that announces the session state; comprehension that does not depend on motion (the
// animated dot is decorative and the headline text always carries the state); and status that does not
// depend on colour alone (every state has a distinct text headline and a state data attribute).

import { render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { VoicePersona } from "@oscharko-dev/keiko-contracts";
import {
  VoiceDialogControls,
  VoiceDialogModeSwitch,
  VoiceDialogSessionStatus,
  VoiceDialogTurnControls,
  VoiceProfileSelect,
} from "../../VoiceDialogMode";
import {
  voiceDialogStateHeadline,
  voiceDialogStateIsLive,
  type VoiceDialogState,
} from "../voice-dialog-state";
import {
  DIALOGUE_A11Y_CHECKS,
  scoreDialogueAccessibility,
  type DialogueA11yCheck,
  type DialogueAccessibilityObservation,
} from "./index";

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

const PERSONAS: readonly VoicePersona[] = ["male", "female", "neutral"];

function renderControls(state: VoiceDialogState): void {
  render(
    <VoiceDialogControls
      state={state}
      muted={false}
      onToggleMute={vi.fn()}
      onStop={vi.fn()}
      onLeave={vi.fn()}
      personas={PERSONAS}
      selectedPersona="neutral"
      onSelectPersona={vi.fn()}
    />,
  );
}

// A composed dialogue panel mirroring how ChatWindow renders an active session: the switch, the live
// status strip, the session controls cluster, and the per-turn controls together.
function renderPanel(state: VoiceDialogState): HTMLElement {
  const { container } = render(
    <div>
      <VoiceDialogModeSwitch active onToggle={vi.fn()} />
      <VoiceProfileSelect personas={PERSONAS} selected="neutral" onSelect={vi.fn()} />
      <VoiceDialogSessionStatus state={state} />
      <VoiceDialogControls
        state={state}
        muted={false}
        onToggleMute={vi.fn()}
        onStop={vi.fn()}
        onLeave={vi.fn()}
        personas={PERSONAS}
        selectedPersona="neutral"
        onSelectPersona={vi.fn()}
      />
      <VoiceDialogTurnControls
        listening={state === "listening"}
        speaking={state === "speaking"}
        canInterrupt={state === "speaking"}
        onListen={vi.fn()}
        onInterrupt={vi.fn()}
      />
    </div>,
  );
  return container;
}

describe("AC4 — dialogue accessibility checks", () => {
  it("axe-clean: the composed dialogue surface has no accessibility violations in any session state", async () => {
    for (const state of ALL_STATES) {
      const container = renderPanel(state);
      // eslint-disable-next-line no-await-in-loop -- axe must run per rendered state, serially
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    }
  });

  it("keyboard-operable: every interactive control exposes a native button/switch role", () => {
    renderPanel("speaking");
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeEnabled();
    // The cluster buttons (mute/stop/leave/persona) and the turn buttons are all real <button>s.
    for (const name of [
      "Stop voice dialogue",
      "Leave voice dialogue",
      "Start speaking",
      "Interrupt the assistant",
    ]) {
      expect(screen.getByRole("button", { name })).toBeInstanceOf(HTMLButtonElement);
    }
  });

  it("stable-accessible-names: the dialogue switch name is stable across its on/off state", () => {
    const { rerender } = render(<VoiceDialogModeSwitch active={false} onToggle={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
    rerender(<VoiceDialogModeSwitch active onToggle={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Voice dialogue mode" })).toBeInTheDocument();
  });

  it("focus-return-on-error: focus moves to the Leave recovery control when the session errors", () => {
    renderControls("error");
    expect(screen.getByRole("button", { name: "Leave voice dialogue" })).toHaveFocus();
  });

  it("live-region-status: the status strip is a polite live region, and an alert on error", () => {
    const { rerender } = render(<VoiceDialogSessionStatus state="listening" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    rerender(<VoiceDialogSessionStatus state="error" />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("reduced-motion-independent: the live dot is decorative and the headline carries the state in text", () => {
    const { container } = render(<VoiceDialogSessionStatus state="listening" />);
    expect(voiceDialogStateIsLive("listening")).toBe(true);
    const dot = container.querySelector(".cmp-voice-dot");
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute("aria-hidden", "true");
    // Comprehension does not need the animation: the headline text states the session is listening.
    expect(screen.getByText(voiceDialogStateHeadline("listening"))).toBeInTheDocument();
  });

  it("color-independent-status: every session state has a distinct text headline and a state attribute", () => {
    const headlines = ALL_STATES.map(voiceDialogStateHeadline);
    expect(new Set(headlines).size).toBe(ALL_STATES.length);
    for (const state of ALL_STATES) {
      const { container } = render(<VoiceDialogSessionStatus state={state} />);
      expect(container.querySelector(`[data-dialog-state="${state}"]`)).not.toBeNull();
    }
  });

  it("scores the consolidated accessibility audit as a full pass that the evaluation can consume", async () => {
    // Re-run the audit assertions, recording each as a content-free observation for the scorecard.
    const observations: DialogueAccessibilityObservation[] = [];
    const record = (check: DialogueA11yCheck, satisfied: boolean): void => {
      observations.push({ check, satisfied });
    };

    // Each surface renders into its own scope so the audit queries never collide across renders.
    const panel = renderPanel("speaking");
    record("axe-clean", (await axe(panel)).violations.length === 0);
    record(
      "keyboard-operable",
      within(panel).getByRole("switch", { name: "Voice dialogue mode" }) instanceof
        HTMLButtonElement,
    );

    const switchOnly = render(<VoiceDialogModeSwitch active onToggle={vi.fn()} />);
    record(
      "stable-accessible-names",
      within(switchOnly.container).getAllByRole("switch", { name: "Voice dialogue mode" }).length >
        0,
    );

    const errorControls = render(
      <VoiceDialogControls
        state="error"
        muted={false}
        onToggleMute={vi.fn()}
        onStop={vi.fn()}
        onLeave={vi.fn()}
        personas={PERSONAS}
        selectedPersona="neutral"
        onSelectPersona={vi.fn()}
      />,
    );
    record(
      "focus-return-on-error",
      within(errorControls.container).getByRole("button", { name: "Leave voice dialogue" }) ===
        document.activeElement,
    );

    const liveStatus = render(<VoiceDialogSessionStatus state="listening" />);
    record(
      "live-region-status",
      within(liveStatus.container).getByRole("status").getAttribute("aria-live") === "polite",
    );
    record(
      "reduced-motion-independent",
      liveStatus.container.querySelector(".cmp-voice-dot")?.getAttribute("aria-hidden") === "true",
    );
    record(
      "color-independent-status",
      new Set(ALL_STATES.map(voiceDialogStateHeadline)).size === ALL_STATES.length,
    );

    const results = scoreDialogueAccessibility(observations);
    expect(results.map((r) => r.check).sort()).toEqual([...DIALOGUE_A11Y_CHECKS].sort());
    expect(results.every((r) => r.outcome === "pass")).toBe(true);
  });
});
