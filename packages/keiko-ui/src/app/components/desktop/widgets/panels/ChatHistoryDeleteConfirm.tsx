"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { Chat } from "@/lib/types";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { NATIVE_DIALOG_STYLE } from "../../native-element-styles";

const FOCUSABLE = "button:not([disabled])";

interface ChatHistoryDeleteConfirmProps {
  /** Snapshot taken when the dialog opened: the list may shift while it is shown. */
  readonly targets: readonly Chat[];
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Focus Cancel first, trap Tab, close on Escape or backdrop click, and hand focus back on exit. */
function useConfirmDialogBehaviour(
  dialogRef: RefObject<HTMLDialogElement | null>,
  backdropRef: RefObject<HTMLDivElement | null>,
  cancelRef: RefObject<HTMLButtonElement | null>,
  onCancel: () => void,
): void {
  useEffect((): (() => void) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const dialog = dialogRef.current;
    const backdrop = backdropRef.current;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      const head = items[0];
      const tail = items.at(-1);
      if (head === undefined || tail === undefined) return;
      if (document.activeElement !== (event.shiftKey ? head : tail)) return;
      event.preventDefault();
      (event.shiftKey ? tail : head).focus();
    };
    const onBackdrop = (event: MouseEvent): void => {
      if (event.target === backdrop) onCancel();
    };
    dialog?.addEventListener("keydown", onKey);
    backdrop?.addEventListener("click", onBackdrop);
    return (): void => {
      dialog?.removeEventListener("keydown", onKey);
      backdrop?.removeEventListener("click", onBackdrop);
      opener?.focus();
    };
  }, [backdropRef, cancelRef, dialogRef, onCancel]);
}

/**
 * Explicit confirmation before the irreversible purge of chats (#4335). It names the chat being
 * deleted; see `useConfirmDialogBehaviour` for the keyboard contract.
 */
export function ChatHistoryDeleteConfirm({
  targets,
  onConfirm,
  onCancel,
}: ChatHistoryDeleteConfirmProps): ReactNode {
  const t = useTranslate();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const first = targets[0];
  useConfirmDialogBehaviour(dialogRef, backdropRef, cancelRef, onCancel);

  const body =
    targets.length === 1 && first !== undefined
      ? t("chat.history.confirm.bodyOne", { title: first.title })
      : t("chat.history.confirm.bodyMany", { count: targets.length });

  return (
    <div ref={backdropRef} className="mc-dialog-backdrop">
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-labelledby="chat-history-confirm-title"
        aria-describedby="chat-history-confirm-body"
        tabIndex={-1}
        className="mc-dialog"
        style={NATIVE_DIALOG_STYLE}
      >
        <h2 id="chat-history-confirm-title" className="mc-dialog-title">
          {t("chat.history.confirm.title")}
        </h2>
        <p id="chat-history-confirm-body" className="mc-dialog-body">
          {body}
        </p>
        <div className="mc-dialog-actions">
          <button ref={cancelRef} type="button" className="lk-btn lk-btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="lk-btn lk-btn-danger" onClick={onConfirm}>
            {t("chat.history.confirm.confirm")}
          </button>
        </div>
      </dialog>
    </div>
  );
}
