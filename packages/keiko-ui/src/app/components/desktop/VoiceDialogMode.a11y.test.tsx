// GEN-UI-TEST-GAP-005 (test-plan #6) — jest-axe smoke coverage for the spoken-dialogue control
// surfaces. jsdom does not compute colour contrast or focus rings; these cases verify the STRUCTURAL
// WCAG 2.2 AA contract (roles, names, aria-* wiring, no orphaned describedby) for every meaningful
// state of the four surfaces the voice UX composes. Rendered in isolation so a single surface's
// violation is attributable.

import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { VoiceDialogModeSwitch, VoiceDialogTurnControls } from "./VoiceDialogMode";
import { VoicePlaybackMuteButton } from "./VoicePlayback";
import { VoiceRealtimeStatus } from "./VoiceRealtime";

describe("Voice dialogue controls a11y (jest-axe)", () => {
  describe("VoiceDialogModeSwitch", () => {
    it("has no violations when inactive", async () => {
      const { container } = render(<VoiceDialogModeSwitch active={false} onToggle={vi.fn()} />);
      expect(await axe(container)).toHaveNoViolations();
    });

    it("has no violations when active", async () => {
      const { container } = render(<VoiceDialogModeSwitch active onToggle={vi.fn()} />);
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe("VoiceDialogTurnControls", () => {
    it("has no violations while listening (Interrupt available)", async () => {
      const { container } = render(
        <VoiceDialogTurnControls
          listening
          speaking={false}
          canInterrupt
          onListen={vi.fn()}
          onInterrupt={vi.fn()}
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
    });

    it("has no violations while idle (Interrupt aria-disabled + described)", async () => {
      const { container } = render(
        <VoiceDialogTurnControls
          listening={false}
          speaking={false}
          canInterrupt={false}
          onListen={vi.fn()}
          onInterrupt={vi.fn()}
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe("VoicePlaybackMuteButton", () => {
    it("has no violations when unmuted", async () => {
      const { container } = render(<VoicePlaybackMuteButton muted={false} onToggle={vi.fn()} />);
      expect(await axe(container)).toHaveNoViolations();
    });

    it("has no violations when muted", async () => {
      const { container } = render(<VoicePlaybackMuteButton muted onToggle={vi.fn()} />);
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe("VoiceRealtimeStatus", () => {
    it("has no violations in the error state", async () => {
      const { container } = render(
        <VoiceRealtimeStatus
          phase="error"
          error={{ reason: "connection-failed", message: "The voice connection dropped." }}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
    });

    it("has no violations in the connected state", async () => {
      const { container } = render(
        <VoiceRealtimeStatus
          phase="connected"
          error={undefined}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
