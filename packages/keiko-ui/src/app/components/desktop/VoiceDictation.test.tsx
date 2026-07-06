// Issue #495 — presentational dictation controls. Verifies the mic button's dynamic state labels and
// the transcript preview's review / status / error surfaces, plus keyboard/focus handoff, the
// discoverable local-only privacy disclosure, and zero axe violations across states.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import {
  VoiceDictationButton,
  VoiceDictationPreview,
  VoiceDictationPreviewFromController,
} from "./VoiceDictation";
import type { DictationController } from "./hooks/useDictation";

describe("VoiceDictationButton", () => {
  it("renders a labelled start affordance when idle and starts on click", async () => {
    const onStart = vi.fn();
    render(<VoiceDictationButton phase="idle" onStart={onStart} onStop={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Dictate a message" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("aria-describedby");
    await userEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("flips to a stop affordance while recording and stops on click", async () => {
    const onStop = vi.fn();
    render(<VoiceDictationButton phase="recording" onStart={vi.fn()} onStop={onStop} />);
    const button = screen.getByRole("button", { name: "Stop dictation" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("data-recording", "true");
    await userEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("is busy and inert while requesting, finalizing, or transcribing", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <VoiceDictationButton phase="requesting" onStart={onStart} onStop={onStop} />,
    );
    let button = screen.getByRole("button", { name: "Starting microphone…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);

    rerender(<VoiceDictationButton phase="finalizing" onStart={onStart} onStop={onStop} />);
    button = screen.getByRole("button", { name: "Finishing dictation…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-recording", "true");
    fireEvent.click(button);

    rerender(<VoiceDictationButton phase="transcribing" onStart={onStart} onStop={onStop} />);
    button = screen.getByRole("button", { name: "Transcribing your dictation…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);

    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("is operable by keyboard (Space/Enter parity with mouse)", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <VoiceDictationButton phase="idle" onStart={onStart} onStop={onStop} />,
    );
    screen.getByRole("button", { name: "Dictate a message" }).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onStart).toHaveBeenCalledTimes(2);

    rerender(<VoiceDictationButton phase="recording" onStart={onStart} onStop={onStop} />);
    screen.getByRole("button", { name: "Stop dictation" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations in the transient requesting, finalizing, and transcribing button states", async () => {
    const req = render(
      <VoiceDictationButton phase="requesting" onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(await axe(req.container)).toHaveNoViolations();
    req.unmount();
    const fin = render(
      <VoiceDictationButton phase="finalizing" onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(await axe(fin.container)).toHaveNoViolations();
    fin.unmount();
    const tr = render(
      <VoiceDictationButton phase="transcribing" onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(await axe(tr.container)).toHaveNoViolations();
  });

  it("exposes the local-only privacy disclosure (AC — clear local-only messaging)", () => {
    render(<VoiceDictationButton phase="idle" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(
      screen.getByText(
        "Audio is sent only to your configured speech-to-text endpoint and is not stored.",
      ),
    ).toBeInTheDocument();
  });

  it("has no axe violations in idle and recording states", async () => {
    const idle = render(<VoiceDictationButton phase="idle" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(await axe(idle.container)).toHaveNoViolations();
    const rec = render(
      <VoiceDictationButton phase="recording" onStart={vi.fn()} onStop={vi.fn()} />,
    );
    expect(await axe(rec.container)).toHaveNoViolations();
  });
});

function renderPreview(overrides: Partial<Parameters<typeof VoiceDictationPreview>[0]> = {}): {
  onTranscriptChange: ReturnType<typeof vi.fn>;
  onInsert: ReturnType<typeof vi.fn>;
  onDiscard: ReturnType<typeof vi.fn>;
  onRetry: ReturnType<typeof vi.fn>;
} {
  const handlers = {
    onTranscriptChange: vi.fn(),
    onInsert: vi.fn(),
    onDiscard: vi.fn(),
    onRetry: vi.fn(),
  };
  render(
    <VoiceDictationPreview
      phase="preview"
      transcript="dictated text"
      error={undefined}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("VoiceDictationPreview", () => {
  it("renders nothing while idle", () => {
    const { container } = render(
      <VoiceDictationPreview
        phase="idle"
        transcript=""
        error={undefined}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces live recording feedback before transcription", () => {
    // Before the capture pipeline is verified live, the surface shows "Preparing mic" and does not yet
    // invite the user to speak — and the level meter reads flat so no bar suggests capture is happening.
    const { rerender } = render(
      <VoiceDictationPreview
        phase="recording"
        transcript=""
        audioLevel={0.7}
        heardSpeech={false}
        micReady={false}
        error={undefined}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Preparing mic…");
    expect(document.querySelectorAll(".cmp-voice-level-bar[data-active='true']").length).toBe(0);

    // Once ready, it invites speech and the level meter reflects the live signal.
    rerender(
      <VoiceDictationPreview
        phase="recording"
        transcript=""
        audioLevel={0.7}
        heardSpeech={false}
        micReady
        error={undefined}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Listening…");
    expect(
      document.querySelectorAll(".cmp-voice-level-bar[data-active='true']").length,
    ).toBeGreaterThan(0);

    rerender(
      <VoiceDictationPreview
        phase="recording"
        transcript=""
        audioLevel={0.7}
        heardSpeech
        micReady
        error={undefined}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Capturing speech…");
  });

  it("announces the post-roll finalizing state before transcription", () => {
    render(
      <VoiceDictationPreview
        phase="finalizing"
        transcript=""
        error={undefined}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Finishing dictation…");
  });

  it("announces the transcribing state politely", () => {
    render(
      <VoiceDictationPreview
        phase="transcribing"
        transcript=""
        error={undefined}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Transcribing your dictation…");
  });

  it("has no axe violations in the transcribing state", async () => {
    const { container } = render(
      <VoiceDictationPreview
        phase="transcribing"
        transcript=""
        error={undefined}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an editable transcript with insert / re-record / discard actions and focuses the field", () => {
    const handlers = renderPreview();
    const field = screen.getByRole("textbox", { name: "Review your dictation" });
    expect(field).toHaveValue("dictated text");
    expect(field).toHaveFocus(); // WCAG 2.4.3 focus handoff
    fireEvent.change(field, { target: { value: "edited text" } });
    expect(handlers.onTranscriptChange).toHaveBeenCalledWith("edited text");

    fireEvent.click(screen.getByRole("button", { name: "Insert transcript into the message" }));
    expect(handlers.onInsert).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Re-record the dictation" }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard the dictation" }));
    expect(handlers.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("disables insert when the transcript is empty", () => {
    renderPreview({ transcript: "   " });
    expect(
      screen.getByRole("button", { name: "Insert transcript into the message" }),
    ).toBeDisabled();
  });

  it("carries the local-only privacy note in the preview", () => {
    renderPreview();
    expect(
      screen.getByText(
        "Audio is sent only to your configured speech-to-text endpoint and is not stored.",
      ),
    ).toBeInTheDocument();
  });

  it("renders an alert with retry/dismiss on error and focuses retry", () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    render(
      <VoiceDictationPreview
        phase="error"
        transcript=""
        error={{ reason: "permission-denied", message: "denied" }}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={onDiscard}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Microphone access was denied/u);
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["permission-denied", /Microphone access was denied/u],
    ["no-microphone", /No microphone was found/u],
    ["unsupported", /does not support microphone dictation/u],
    ["unavailable", /not available right now/u],
    ["transcribe-failed", /could not be completed/u],
    ["capture-failed", /could not be completed/u],
  ] as const)("renders a scoped headline for the %s error reason", (reason, pattern) => {
    render(
      <VoiceDictationPreview
        phase="error"
        transcript=""
        error={{ reason, message: "detail" }}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(pattern);
  });

  it("has no axe violations in preview and error states", async () => {
    const preview = render(
      <VoiceDictationPreview
        phase="preview"
        transcript="hello"
        error={undefined}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(await axe(preview.container)).toHaveNoViolations();
    preview.unmount();
    const err = render(
      <VoiceDictationPreview
        phase="error"
        transcript=""
        error={{ reason: "transcribe-failed", message: "x" }}
        onTranscriptChange={vi.fn()}
        onInsert={vi.fn()}
        onDiscard={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(await axe(err.container)).toHaveNoViolations();
  });
});

describe("VoiceDictationPreviewFromController", () => {
  function makeController(overrides: Partial<DictationController> = {}): DictationController {
    return {
      phase: "preview",
      mode: "batch",
      transcript: "bound text",
      liveTranscript: "",
      finalizationNote: undefined,
      error: undefined,
      audioLevel: 0,
      heardSpeech: false,
      micReady: false,
      busy: false,
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
      discard: vi.fn(),
      insert: vi.fn(),
      setTranscript: vi.fn(),
      ...overrides,
    };
  }

  it("wires the preview actions to the controller and returns focus after discard", () => {
    const controller = makeController();
    const onAfterDiscard = vi.fn();
    render(
      <VoiceDictationPreviewFromController
        controller={controller}
        onAfterDiscard={onAfterDiscard}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Insert transcript into the message" }));
    expect(controller.insert).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Discard the dictation" }));
    expect(controller.discard).toHaveBeenCalledTimes(1);
    expect(onAfterDiscard).toHaveBeenCalledTimes(1);
  });
});
