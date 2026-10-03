"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Icons } from "../../Icons";
import styles from "./EditorRuntimeWidget.module.css";

const DotsIcon = Icons.dots;

export interface EditorDocumentAction {
  readonly label: string;
  readonly run: () => void;
}

interface Props {
  readonly label: string;
  readonly actions: readonly EditorDocumentAction[];
}

function useDisclosureDismissal(
  details: RefObject<HTMLDetailsElement | null>,
  trigger: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const dismissOutside = (event: PointerEvent): void => {
      const menu = details.current;
      if (!(event.target instanceof Node) || !menu?.open || menu.contains(event.target)) return;
      const focusWasInside = menu.contains(document.activeElement);
      menu.removeAttribute("open");
      if (focusWasInside) trigger.current?.focus();
    };
    const dismissEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !details.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      details.current.removeAttribute("open");
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return (): void => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [details, trigger]);
}

/** Native disclosure keeps secondary document actions reachable with ordinary Tab navigation. */
export function EditorDocumentActions({ label, actions }: Props): ReactNode {
  const details = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  useDisclosureDismissal(details, trigger);
  const close = (): void => {
    details.current?.removeAttribute("open");
    trigger.current?.focus();
  };
  return (
    <details ref={details} className={`ed-tab-summary-menu ${styles.documentActions}`}>
      <summary ref={trigger} aria-label={label} title={label}>
        <DotsIcon size={20} />
      </summary>
      <div className={`ed-tab-summary-panel ${styles.documentActionPanel}`}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => {
              close();
              action.run();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </details>
  );
}
