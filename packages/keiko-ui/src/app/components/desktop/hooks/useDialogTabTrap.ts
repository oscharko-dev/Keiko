"use client";

import { useEffect, type RefObject } from "react";

// The standard focusable-element set (WAI-ARIA APG dialog pattern), scoped to enabled controls
// and not-explicitly-unfocusable tabindex values. Buttons/links cover today's dialogs, but the
// hook is a generic containment primitive shared across the desktop shell, so it must not silently
// miscompute first/last for a future dialog that also contains inputs, selects, or a custom
// tabbable element.
//
// Known limitations, both unreachable by any current consumer (flat single-level dialogs, no
// positive tabindex anywhere in the desktop shell): this only checks the element's own
// display/visibility, not a hidden ANCESTOR's; and first/last are computed in DOM order, which
// is not tab order once a positive tabindex is introduced.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isReachable(element: HTMLElement): boolean {
  if (element.hidden) return false;
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
  );
}

// aria-modal="true" requires focus to stay inside a dialog while it is open. Shared by every
// confirm/alert dialog in the desktop shell so the containment logic (and its edge cases) lives
// in exactly one place instead of being re-implemented per dialog.
export function useDialogTabTrap(dialogRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        isReachable,
      );
      const active = document.activeElement;
      // Focus can already sit OUTSIDE an open aria-modal dialog: disabling the focused control —
      // which every confirm dialog here does while its action is in flight — drops focus to <body>.
      // Swallowing Tab in place would then strand the user outside the modal, so re-enter the
      // dialog instead: at the edge the direction points to, or on the container itself when every
      // control is disabled. The container is the fallback, so a trapped dialog needs tabIndex={-1}.
      if (focusable.length === 0 || !dialog.contains(active)) {
        event.preventDefault();
        ((event.shiftKey ? focusable.at(-1) : focusable[0]) ?? dialog).focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      // Initial focus lands on the dialog container itself, not on a button, so a Shift+Tab
      // pressed before ever pressing Tab must wrap the same as if focus were already on the first
      // element — otherwise it escapes to whatever was focusable before the dialog opened.
      const onContainer = active === dialog;
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
