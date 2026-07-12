"use client";

import { useEffect, type RefObject } from "react";

// aria-modal="true" requires focus to stay inside a dialog while it is open. Shared by every
// confirm/alert dialog in the desktop shell so the containment logic (and its edge cases) lives
// in exactly one place instead of being re-implemented per dialog.
export function useDialogTabTrap(dialogRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href]",
      );
      if (focusable === undefined) return;
      if (focusable.length === 0) {
        // Every control is disabled (e.g. mid-save) — nothing to move focus to, but Tab must still
        // not escape the modal, so swallow it in place.
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      // Initial focus lands on the dialog container itself, not on a button, so a Shift+Tab
      // pressed before ever pressing Tab must wrap the same as if focus were already on the first
      // element — otherwise it escapes to whatever was focusable before the dialog opened.
      const onContainer = active === dialogRef.current;
      if (event.shiftKey && (active === first || onContainer)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dialogRef]);
}
