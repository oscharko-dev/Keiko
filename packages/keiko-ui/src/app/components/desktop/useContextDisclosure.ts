"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { viewportOverlayPosition } from "./viewport-overlay";

interface ContextDisclosure {
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly panel: RefObject<HTMLElement | null>;
  readonly open: boolean;
  readonly toggle: () => void;
  readonly position: CSSProperties;
}

function useOverlayPosition(
  open: boolean,
  trigger: ContextDisclosure["trigger"],
  panel: ContextDisclosure["panel"],
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    let previous = "";
    const update = (): void => {
      if (trigger.current !== null && panel.current !== null) {
        const measured = viewportOverlayPosition({
          anchor: trigger.current.getBoundingClientRect(),
          width: 320,
          height: panel.current.scrollHeight + 2,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          gap: 8,
          preferUp: true,
        });
        const key = JSON.stringify(measured);
        if (key !== previous) {
          previous = key;
          setPosition({
            left: measured.left,
            top: measured.top,
            width: measured.width,
            maxHeight: measured.maxHeight,
          });
        }
      }
      frame = requestAnimationFrame(update);
    };
    update();
    return (): void => cancelAnimationFrame(frame);
  }, [open, trigger, panel]);
  return position;
}

function insideDisclosure(
  target: EventTarget | null,
  trigger: ContextDisclosure["trigger"],
  panel: ContextDisclosure["panel"],
): boolean {
  return (
    target instanceof Node &&
    (trigger.current?.contains(target) === true || panel.current?.contains(target) === true)
  );
}

function routePanelTab(
  event: KeyboardEvent,
  trigger: ContextDisclosure["trigger"],
  panel: ContextDisclosure["panel"],
): boolean {
  const element = panel.current;
  if (element === null) return true;
  const actions = Array.from(element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  const first = actions[0];
  if (event.target === trigger.current && !event.shiftKey && first !== undefined) {
    event.preventDefault();
    first.focus();
    return false;
  }
  return routeActionTab(event, trigger, actions, element);
}

function routeActionTab(
  event: KeyboardEvent,
  trigger: ContextDisclosure["trigger"],
  actions: HTMLButtonElement[],
  panel: HTMLElement,
): boolean {
  if (event.target === actions[0] && event.shiftKey) {
    event.preventDefault();
    trigger.current?.focus();
    return false;
  }
  if (event.target === actions.at(-1) && !event.shiftKey) {
    trigger.current?.focus();
    return true;
  }
  return !(event.target instanceof Node && panel.contains(event.target));
}

export function useContextDisclosure(): ContextDisclosure {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const position = useOverlayPosition(open, trigger, panel);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Tab") {
        if (routePanelTab(event, trigger, panel)) setOpen(false);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        trigger.current?.focus();
        setOpen(false);
      }
    };
    const dismissOutside = (event: Event): void => {
      if (!insideDisclosure(event.target, trigger, panel)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    return (): void => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);
  return { trigger, panel, open, position, toggle: (): void => setOpen((current) => !current) };
}
