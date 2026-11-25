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
}

/**
 * The quiet per-answer copy affordance (uiux-fix F042, C208), shared by Chat and the Coding
 * Workbench. It copies with the clipboard fallback for non-secure contexts, swaps its icon state for
 * visible feedback, and announces the outcome in a status region (WCAG 4.1.3), since a changed
 * accessible name alone is not re-announced.
 */
export function AnswerCopyButton({ text, labels, onOutcome }: AnswerCopyButtonProps): ReactNode {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(text).then(
      () => {
        onOutcome?.();
        setCopyState("copied");
        setStatus(labels.copiedStatus);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setCopyState("idle");
          setStatus("");
        }, COPIED_FEEDBACK_MS);
      },
      (error: unknown) => {
        onOutcome?.(error);
        setCopyState("failed");
        setStatus(labels.failedStatus);
      },
    );
  }, [labels.copiedStatus, labels.failedStatus, onOutcome, text]);

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
