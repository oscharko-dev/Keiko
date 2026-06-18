"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type KeikoSelectOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly badge?: string;
};

export type KeikoSelectSection = {
  readonly label?: string;
  readonly options: readonly KeikoSelectOption[];
};

type FlatOption = KeikoSelectOption & {
  readonly key: string;
  readonly sectionLabel?: string | undefined;
};

export interface KeikoSelectProps {
  readonly value: string;
  readonly sections: readonly KeikoSelectSection[];
  readonly onValueChange: (next: string) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly ariaDescribedBy?: string | undefined;
  readonly ariaLabelledBy?: string | undefined;
  readonly triggerClassName?: string | undefined;
  readonly menuClassName?: string | undefined;
  readonly menuTitle?: string | undefined;
  readonly menuCountLabel?: string | undefined;
  readonly showMenuHeader?: boolean;
  readonly leadingVisual?: ReactNode;
  readonly mono?: boolean;
  readonly showChevron?: boolean;
  readonly menuMinWidth?: number;
  readonly attached?: boolean;
  readonly triggerStyle?: CSSProperties | undefined;
  readonly autoFocus?: boolean;
}

type MenuPosition = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly optionHeight: number;
  readonly maxHeight: number;
  readonly openUp: boolean;
  readonly attached: boolean;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly letterSpacing: string;
  readonly lineHeight: string;
};

type OverflowTooltipPosition = {
  readonly left: number;
  readonly top: number;
};

const OVERFLOW_TOOLTIP_DELAY_MS = 2000;

function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  );
}

function firstEnabledIndex(options: readonly FlatOption[]): number {
  return options.findIndex((option) => option.disabled !== true);
}

function nextEnabledIndex(
  options: readonly FlatOption[],
  start: number,
  direction: -1 | 1,
): number {
  if (options.length === 0) return -1;
  let index = start;
  for (let i = 0; i < options.length; i += 1) {
    index = (index + direction + options.length) % options.length;
    if (options[index]?.disabled !== true) return index;
  }
  return -1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function DelayedOverflowLabel({ label }: { readonly label: string }): ReactNode {
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<OverflowTooltipPosition | null>(null);

  const clearTooltip = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTooltipPosition(null);
  };

  const scheduleTooltip = (): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const node = labelRef.current;
      if (node === null || node.scrollWidth <= node.clientWidth) return;
      const rect = node.getBoundingClientRect();
      const preferredWidth = Math.min(520, window.innerWidth - 32);
      const rightAlignedLeft = rect.right - preferredWidth;
      setTooltipPosition({
        left: clamp(rightAlignedLeft, 16, Math.max(16, window.innerWidth - preferredWidth - 16)),
        top: Math.max(16, rect.top - 10),
      });
    }, OVERFLOW_TOOLTIP_DELAY_MS);
  };

  useEffect(() => clearTooltip, []);

  return (
    <>
      <span
        className="ksel-option-label"
        ref={labelRef}
        onBlur={clearTooltip}
        onFocus={scheduleTooltip}
        onPointerEnter={scheduleTooltip}
        onPointerLeave={clearTooltip}
      >
        {label}
      </span>
      {tooltipPosition !== null
        ? createPortal(
            <div
              className="ksel-overflow-tooltip"
              role="tooltip"
              style={{
                left: `${tooltipPosition.left.toString()}px`,
                top: `${tooltipPosition.top.toString()}px`,
              }}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default function KeikoSelect({
  value,
  sections,
  onValueChange,
  disabled = false,
  placeholder = "Select an option",
  ariaLabel,
  ariaDescribedBy,
  ariaLabelledBy,
  triggerClassName,
  menuClassName,
  menuTitle,
  menuCountLabel,
  showMenuHeader = true,
  leadingVisual,
  mono = false,
  showChevron = true,
  menuMinWidth,
  attached = true,
  triggerStyle,
  autoFocus = false,
}: KeikoSelectProps): ReactNode {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [openUp, setOpenUp] = useState(false);

  const flatOptions = useMemo<readonly FlatOption[]>(
    () =>
      sections.flatMap((section, sectionIndex) =>
        section.options.map((option, optionIndex) => ({
          ...option,
          key: `${section.label ?? "section"}-${sectionIndex.toString()}-${option.value}-${optionIndex.toString()}`,
          sectionLabel: section.label,
        })),
      ),
    [sections],
  );

  const selectedIndex = flatOptions.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex === -1 ? null : flatOptions[selectedIndex]!;
  const visibleLabel = selectedOption?.label ?? placeholder;
  const visibleDescription = selectedOption?.description ?? null;

  const closeMenu = (): void => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const openMenu = (preferredIndex?: number): void => {
    if (disabled || flatOptions.length === 0) return;
    const fallbackIndex =
      preferredIndex !== undefined && flatOptions[preferredIndex]?.disabled !== true
        ? preferredIndex
        : selectedIndex >= 0 && flatOptions[selectedIndex]?.disabled !== true
          ? selectedIndex
          : firstEnabledIndex(flatOptions);
    setOpen(true);
    setActiveIndex(fallbackIndex);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        (triggerRef.current !== null &&
          target instanceof Node &&
          triggerRef.current.contains(target)) ||
        (menuRef.current !== null && target instanceof Node && menuRef.current.contains(target))
      ) {
        return;
      }
      closeMenu();
    };
    const onWindowBlur = (): void => closeMenu();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || triggerRef.current === null) return;
    const updatePosition = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const viewportPadding = 16;
      const compactReadableWidth =
        menuMinWidth !== undefined && rect.width < Math.min(menuMinWidth, 96)
          ? menuMinWidth
          : rect.width;
      const width = Math.min(compactReadableWidth, window.innerWidth - viewportPadding * 2);
      const menuAttached = attached && Math.abs(width - rect.width) < 1;
      const menuGap = menuAttached ? -1 : 6;
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
      const spaceAbove = rect.top - viewportPadding;
      const minUsableHeight = Math.max(96, rect.height * 2);
      const openUp = spaceBelow < minUsableHeight && spaceAbove > spaceBelow;
      setOpenUp(openUp);
      const availableHeight = openUp ? spaceAbove : spaceBelow;
      const menuChromeReserve = (showMenuHeader ? 50 : 0) + 2;
      const maxHeight = Math.max(
        rect.height,
        Math.min(Math.max(rect.height, availableHeight - menuChromeReserve), 380),
      );
      const totalMenuHeight = maxHeight + menuChromeReserve;
      const computed = window.getComputedStyle(triggerRef.current!);
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - width - viewportPadding,
      );
      setPosition({
        left,
        width,
        top: openUp
          ? Math.max(viewportPadding, rect.top - totalMenuHeight - menuGap)
          : Math.min(rect.bottom + menuGap, window.innerHeight - viewportPadding - totalMenuHeight),
        optionHeight: Math.max(32, rect.height),
        maxHeight,
        openUp,
        attached: menuAttached,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        letterSpacing: computed.letterSpacing,
        lineHeight: computed.lineHeight,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, attached, menuMinWidth, showMenuHeader]);

  useLayoutEffect(() => {
    if (
      !open ||
      position === null ||
      !position.openUp ||
      triggerRef.current === null ||
      menuRef.current === null
    ) {
      return;
    }
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();
    if (menuRect.height <= 0) return;
    const viewportPadding = 16;
    const menuGap = position.attached ? -1 : 6;
    const nextTop = Math.max(viewportPadding, triggerRect.top - menuRect.height - menuGap);
    if (Math.abs(nextTop - position.top) < 0.5) return;
    setPosition((current) => (current === null ? current : { ...current, top: nextTop }));
  }, [open, position]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.focus();
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function commit(next: FlatOption): void {
    if (next.disabled) return;
    onValueChange(next.value);
    closeMenu();
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(flatOptions));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(flatOptions));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) closeMenu();
      else openMenu();
    }
  }

  function onOptionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(flatOptions, index, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(flatOptions, index, -1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(flatOptions));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(flatOptions, 0, -1));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = flatOptions[index];
      if (option !== undefined) commit(option);
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenu();
        triggerRef.current?.focus();
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (isTextEntryTarget(event.target)) return;
        const query = event.key.toLowerCase();
        const start = activeIndex >= 0 ? activeIndex : selectedIndex >= 0 ? selectedIndex : 0;
        for (let i = 1; i <= flatOptions.length; i += 1) {
          const idx = (start + i) % flatOptions.length;
          const option = flatOptions[idx];
          if (
            option !== undefined &&
            option.disabled !== true &&
            option.label.toLowerCase().startsWith(query)
          ) {
            setActiveIndex(idx);
            break;
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, activeIndex, flatOptions, selectedIndex]);

  const triggerClasses = [
    "ksel-trigger",
    mono ? "mono" : "",
    triggerClassName ?? "",
    open ? "ksel-trigger-open" : "",
    open && position?.attached === true
      ? openUp
        ? "ksel-trigger-open-up"
        : "ksel-trigger-open-down"
      : "",
    disabled ? "ksel-trigger-disabled" : "",
  ]
    .filter((token) => token.length > 0)
    .join(" ");

  const popup =
    open && position !== null
      ? createPortal(
          <div
            ref={menuRef}
            className={[
              "ksel-menu",
              position.attached ? "ksel-menu-attached" : "",
              position.openUp ? "ksel-menu-open-up" : "ksel-menu-open-down",
              menuClassName ?? "",
            ]
              .filter((token) => token.length > 0)
              .join(" ")}
            style={{
              left: `${position.left.toString()}px`,
              top: `${position.top.toString()}px`,
              width: `${position.width.toString()}px`,
              ["--ksel-option-height" as string]: `${position.optionHeight.toString()}px`,
              fontFamily: position.fontFamily,
              fontSize: position.fontSize,
              fontWeight: position.fontWeight,
              letterSpacing: position.letterSpacing,
              lineHeight: position.lineHeight,
            }}
          >
            {showMenuHeader ? (
              <div className="ksel-menu-head">
                <div className="ksel-menu-title">{menuTitle ?? ariaLabel ?? placeholder}</div>
                <div className="ksel-menu-note">
                  {menuCountLabel ?? `${flatOptions.length.toString()} options`}
                </div>
              </div>
            ) : null}
            <div
              className="ksel-menu-scroll"
              role="listbox"
              id={menuId}
              style={{ maxHeight: `${position.maxHeight.toString()}px` }}
            >
              {sections.map((section, sectionIndex) => (
                <div
                  className="ksel-section"
                  key={`${section.label ?? "section"}-${sectionIndex.toString()}`}
                >
                  {section.label !== undefined ? (
                    <div className="ksel-section-label">{section.label}</div>
                  ) : null}
                  {section.options.map((option) => {
                    const index = flatOptions.findIndex(
                      (entry) =>
                        entry.value === option.value && entry.sectionLabel === section.label,
                    );
                    const active = index === selectedIndex;
                    return (
                      <button
                        key={`${section.label ?? "section"}-${option.value}`}
                        ref={(element) => {
                          if (index >= 0) optionRefs.current[index] = element;
                        }}
                        aria-selected={active}
                        className={`ksel-option${active ? " ksel-option-active" : ""}`}
                        data-disabled={option.disabled === true ? "true" : undefined}
                        disabled={option.disabled}
                        onClick={() => commit(flatOptions[index]!)}
                        onKeyDown={(event) => onOptionKeyDown(event, index)}
                        role="option"
                        type="button"
                      >
                        <span className="ksel-option-copy">
                          <DelayedOverflowLabel label={option.label} />
                          {option.description !== undefined ? (
                            <span className="ksel-option-desc">{option.description}</span>
                          ) : null}
                        </span>
                        {option.badge !== undefined ? (
                          <span className="ksel-option-badge">{option.badge}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        aria-controls={menuId}
        aria-describedby={ariaDescribedBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        autoFocus={autoFocus}
        className={triggerClasses}
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={onTriggerKeyDown}
        role="combobox"
        style={triggerStyle}
        type="button"
      >
        {leadingVisual !== undefined ? (
          <span className="ksel-trigger-leading">{leadingVisual}</span>
        ) : null}
        <span className="ksel-trigger-copy">
          <span className="ksel-trigger-label">{visibleLabel}</span>
          {visibleDescription !== null ? (
            <span className="ksel-trigger-desc">{visibleDescription}</span>
          ) : null}
        </span>
        {showChevron ? (
          <span
            aria-hidden="true"
            className={`ksel-trigger-caret${open ? " ksel-trigger-caret-open" : ""}`}
          >
            <svg fill="none" height="12" viewBox="0 0 12 12" width="12">
              <path
                d="M2.25 4.5 6 8.25 9.75 4.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            </svg>
          </span>
        ) : null}
      </button>
      {popup}
    </>
  );
}
