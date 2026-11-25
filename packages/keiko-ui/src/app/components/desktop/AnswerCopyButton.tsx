"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { copyTextToClipboard } from "@/lib/clipboard";
import { Icons } from "./Icons";

const CopyIcon = Icons.copy;
const COPIED_FEEDBACK_MS = 1_500;

/** What the button says, in the surface's own language. */
export interface AnswerCopyButtonLabels {
  /** The idle button's accessible name and tooltip. */
  readonly copy: string;
  /** The button's accessible name and tooltip while the copy is confirmed. */
  readonly copied: string;
  /** The announced status after a copy. */
  readonly copiedStatus: string;
  /** The announced status when the clipboard refused the copy. */
  readonly failedStatus: string;
}

export interface AnswerCopyButtonProps {
  /** The exact text placed on the clipboard: an answer's Markdown source, never rendered HTML. */
  readonly text: string;
  readonly labels: AnswerCopyButtonLabels;
  /** Called once per attempt: without an error when copied, with the error when refused. */
  readonly onOutcome?: (error?: unknown) => void;
  /**
   * The text is a cut or failed-to-read prefix of the answer. A prefix is never offered for copy
   * without saying so and the button has no wording for that, so it renders nothing.
   */
  readonly partial?: boolean;
}

/**
 * The quiet per-answer copy affordance (uiux-fix F042, C208), shared by Chat and the Coding
 * Workbench. It copies with the clipboard fallback for non-secure contexts, swaps its icon state for
 * visible feedback, and announces the outcome in a status region (WCAG 4.1.3), since a changed
 * accessible name alone is not re-announced.
 */
type CopyState = "idle" | "copied" | "failed";

// Shows an outcome and returns to idle after the feedback time, for "copied" and "failed" alike.
function useCopyFeedback(): {
  readonly copyState: CopyState;
  readonly status: string;
  readonly flash: (state: CopyState, status: string) => void;
} {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => (): void => {
      clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback((state: CopyState, message: string): void => {
    setCopyState(state);
    setStatus(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopyState("idle");
      setStatus("");
    }, COPIED_FEEDBACK_MS);
  }, []);
  return { copyState, status, flash };
}

export function AnswerCopyButton({
  text,
  labels,
  onOutcome,
  partial = false,
}: AnswerCopyButtonProps): ReactNode {
  const { copyState, status, flash } = useCopyFeedback();
  const handleCopy = useCallback(() => {
    void copyTextToClipboard(text).then(
      () => {
        onOutcome?.();
        flash("copied", labels.copiedStatus);
      },
      (error: unknown) => {
        onOutcome?.(error);
        flash("failed", labels.failedStatus);
      },
    );
  }, [flash, labels.copiedStatus, labels.failedStatus, onOutcome, text]);

  if (partial) return null;
  const copied = copyState === "copied";
  const label = copied ? labels.copied : labels.copy;
  return (
    <div className="chat-msg-copy-wrap">
      <button
        type="button"
        className="chat-msg-copy"
        aria-label={label}
        title={label}
        data-copied={copied ? "true" : "false"}
        data-failed={copyState === "failed" ? "true" : "false"}
        onClick={handleCopy}
      >
        <CopyIcon size={20} aria-hidden="true" />
      </button>
      <output className="chat-msg-copy-status">{status}</output>
    </div>
  );
}
