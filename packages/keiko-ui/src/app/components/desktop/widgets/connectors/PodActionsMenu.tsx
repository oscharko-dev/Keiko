"use client";
// The secondary actions of one Jira Pod behind a single "…" button (owner decision 2026-11-02):
// the card keeps one visible primary action and a status chip instead of a row of buttons.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "./connectors.module.css";

export interface PodMenuItem {
  readonly key: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []);
}

function nextIndex(key: string, current: number, count: number): number | undefined {
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

function useOutsideClose(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) !== true) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return (): void => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, root, close]);
}

function useMenuKeys(
  menu: RefObject<HTMLDivElement | null>,
  trigger: RefObject<HTMLButtonElement | null>,
  close: () => void,
): (event: KeyboardEvent<HTMLDivElement>) => void {
  return (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close();
      trigger.current?.focus();
      return;
    }
    const buttons = menuItems(menu.current);
    const active = document.activeElement;
    const current = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
    const target = nextIndex(event.key, current, buttons.length);
    if (target === undefined) return;
    event.preventDefault();
    buttons[target]?.focus();
  };
}

function MenuList({
  id,
  label,
  items,
  menu,
  onKeyDown,
  close,
  trigger,
}: {
  readonly id: string;
  readonly label: string;
  readonly items: readonly PodMenuItem[];
  readonly menu: RefObject<HTMLDivElement | null>;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly close: () => void;
  readonly trigger: RefObject<HTMLButtonElement | null>;
}): ReactNode {
  return (
    <div
      ref={menu}
      id={id}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className={styles.cmpPodMenuList}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={styles.cmpPodMenuItem}
          data-danger={item.danger === true ? "true" : undefined}
          onClick={() => {
            close();
            trigger.current?.focus();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function PodActionsMenu({
  label,
  items,
  disabled,
}: {
  readonly label: string;
  readonly items: readonly PodMenuItem[];
  readonly disabled: boolean;
}): ReactNode {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const close = useRef((): void => setOpen(false)).current;
  useOutsideClose(open, root, close);
  useEffect(() => {
    if (open) menuItems(menu.current)[0]?.focus();
  }, [open]);
  const onKeyDown = useMenuKeys(menu, trigger, close);
  return (
    <div ref={root} className={styles.cmpPodMenu}>
      <button
        ref={trigger}
        type="button"
        className={`lk-btn lk-btn-ghost ${styles.cmpPodMenuTrigger}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <MenuList
          id={id}
          label={label}
          items={items}
          menu={menu}
          onKeyDown={onKeyDown}
          close={close}
          trigger={trigger}
        />
      ) : null}
    </div>
  );
}
