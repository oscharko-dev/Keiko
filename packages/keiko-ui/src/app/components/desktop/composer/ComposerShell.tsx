"use client";

import {
  useEffect,
  type ChangeEventHandler,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";

/**
 * The one composer shell every conversational surface renders: the input stack (optional content
 * above the textarea, the textarea itself, optional content below it) and the footer row. The
 * desktop chat and the Coding Workbench share this markup, the auto-grow behaviour and the
 * Enter-submits rule, so the two cannot drift apart (AGENTS.md §5). Everything a surface does with
 * the draft — mention pickers, attachments, model choice, voice, run controls — lives in the
 * surface and is passed in as slots or handlers.
 */
export interface ComposerShellProps {
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: ChangeEventHandler<HTMLTextAreaElement>;
  readonly onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  readonly onSelect?: ((event: SyntheticEvent<HTMLTextAreaElement>) => void) | undefined;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null> | undefined;
  readonly id?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly ariaControls?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly maxLength?: number | undefined;
  readonly aboveInput?: ReactNode;
  readonly belowInput?: ReactNode;
  readonly footer: ReactNode;
}

/** uiux-fix F009 C089 — grow with the content up to ~8–9 lines, then scroll. */
const COMPOSER_MAX_HEIGHT_PX = 220;

/**
 * Enter submits, Shift+Enter inserts a newline, and Enter during an IME composition (Japanese,
 * Chinese, Korean, …) confirms the composition and must never submit (uiux-fix F041 C206).
 * Returns true when the event was a submit request (already default-prevented).
 */
export function composerEnterSubmits(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.nativeEvent.isComposing) return false;
  if (event.key !== "Enter" || event.shiftKey) return false;
  event.preventDefault();
  return true;
}

export function useComposerAutoGrow(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${String(Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT_PX))}px`;
  }, [textareaRef, value]);
}

export function ComposerShell({
  value,
  placeholder,
  onChange,
  onKeyDown,
  onSelect,
  textareaRef,
  id,
  ariaLabel,
  ariaControls,
  disabled,
  maxLength,
  aboveInput,
  belowInput,
  footer,
}: ComposerShellProps): ReactNode {
  return (
    <>
      <div className="cmp-input-stack">
        {aboveInput}
        <div className="cmp-input-combobox">
          <textarea
            id={id}
            className="cmp-input"
            ref={textareaRef}
            rows={2}
            value={value}
            aria-label={ariaLabel}
            aria-controls={ariaControls}
            placeholder={placeholder}
            disabled={disabled}
            maxLength={maxLength}
            // The composer opts into shell chord dispatch (SHELL_CHORD_BYPASS_ATTRIBUTE in
            // hooks/useKeyboardShortcuts.ts) so Cmd/Ctrl+P, Cmd/Ctrl+Shift+P and Cmd/Ctrl+Shift+F
            // keep working inside the product's primary input while its own text-editing chords
            // (Cmd/Ctrl+Z undoes typing) stay with the field.
            data-shell-chord-bypass=""
            onChange={onChange}
            onSelect={onSelect}
            onKeyDown={onKeyDown}
          />
        </div>
        {belowInput}
      </div>
      <div className="cmp-footer-row">{footer}</div>
    </>
  );
}
