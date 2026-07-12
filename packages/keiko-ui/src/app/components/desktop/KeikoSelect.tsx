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
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslate } from "@/lib/i18n";

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
  readonly placement: "top-left" | "top-right";
};

const OVERFLOW_TOOLTIP_DELAY_MS = 1500;
const OVERFLOW_TOOLTIP_EDGE_OFFSET_PX = 8;
const OVERFLOW_TOOLTIP_VERTICAL_OFFSET_PX = 6;

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

function resolveTypeaheadStartIndex(activeIndex: number, selectedIndex: number): number {
  return activeIndex >= 0 ? activeIndex : Math.max(selectedIndex, 0);
}

function triggerOpenDirectionClass(openUp: boolean): string {
  return openUp ? "ksel-trigger-open-up" : "ksel-trigger-open-down";
}

function findTypeaheadIndex(options: readonly FlatOption[], start: number, query: string): number {
  for (let i = 1; i <= options.length; i += 1) {
    const idx = (start + i) % options.length;
    const option = options[idx];
    if (
      option !== undefined &&
      option.disabled !== true &&
      option.label.toLowerCase().startsWith(query)
    ) {
      return idx;
    }
  }
  return -1;
}

function buildTriggerClasses(params: {
  readonly disabled: boolean;
  readonly mono: boolean;
  readonly open: boolean;
  readonly openUp: boolean;
  readonly position: MenuPosition | null;
  readonly triggerClassName: string | undefined;
}): string {
  return [
    "ksel-trigger",
    params.mono ? "mono" : "",
    params.triggerClassName ?? "",
    params.open ? "ksel-trigger-open" : "",
    params.open && params.position?.attached === true
      ? triggerOpenDirectionClass(params.openUp)
      : "",
    params.disabled ? "ksel-trigger-disabled" : "",
  ]
    .filter((token) => token.length > 0)
    .join(" ");
}

function OverflowOptionButton({
  active,
  index,
  onCommit,
  onOptionKeyDown,
  option,
  setOptionRef,
}: {
  readonly active: boolean;
  readonly index: number;
  readonly onCommit: (option: FlatOption) => void;
  readonly onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  readonly option: FlatOption;
  readonly setOptionRef: (index: number, element: HTMLButtonElement | null) => void;
}): ReactNode {
  const optionRef = useRef<HTMLButtonElement | null>(null);
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
      const labelNode = labelRef.current;
      const optionNode = optionRef.current;
      if (
        labelNode === null ||
        optionNode === null ||
        labelNode.scrollWidth <= labelNode.clientWidth
      ) {
        return;
      }
      const rect = optionNode.getBoundingClientRect();
      const preferredWidth = Math.min(520, window.innerWidth - 32);
      const hasRoomRight =
        rect.right + OVERFLOW_TOOLTIP_EDGE_OFFSET_PX + preferredWidth <= window.innerWidth - 16;
      const placement = hasRoomRight ? "top-left" : "top-right";
      setTooltipPosition({
        left:
          placement === "top-left"
            ? rect.right + OVERFLOW_TOOLTIP_EDGE_OFFSET_PX
            : rect.left - OVERFLOW_TOOLTIP_EDGE_OFFSET_PX,
        placement,
        top: rect.top - OVERFLOW_TOOLTIP_VERTICAL_OFFSET_PX,
      });
    }, OVERFLOW_TOOLTIP_DELAY_MS);
  };

  useEffect(() => clearTooltip, []);

  return (
    <button
      ref={(element) => {
        optionRef.current = element;
        setOptionRef(index, element);
      }}
      aria-selected={active}
      className={`ksel-option${active ? " ksel-option-active" : ""}`}
      data-disabled={option.disabled === true ? "true" : undefined}
      disabled={option.disabled}
      onBlur={clearTooltip}
      onClick={() => onCommit(option)}
      onFocus={scheduleTooltip}
      onKeyDown={(event) => onOptionKeyDown(event, index)}
      onPointerEnter={scheduleTooltip}
      onPointerLeave={clearTooltip}
      role="option"
      type="button"
    >
      <span className="ksel-option-copy">
        <span className="ksel-option-label" ref={labelRef}>
          {option.label}
        </span>
        {option.description !== undefined ? (
          <span className="ksel-option-desc">{option.description}</span>
        ) : null}
      </span>
      {option.badge !== undefined ? (
        <span className="ksel-option-badge">{option.badge}</span>
      ) : null}
      {tooltipPosition !== null
        ? createPortal(
            <div
              className="ksel-overflow-tooltip"
              data-placement={tooltipPosition.placement}
              role="tooltip"
              style={{
                left: `${tooltipPosition.left.toString()}px`,
                top: `${tooltipPosition.top.toString()}px`,
              }}
            >
              {option.label}
            </div>,
            document.body,
          )
        : null}
    </button>
  );
}

function KeikoSelectMenuSection({
  activeIndex,
  flatOptions,
  menuId,
  onCommit,
  onOptionKeyDown,
  section,
  sectionIndex,
  setOptionRef,
}: {
  readonly activeIndex: number;
  readonly flatOptions: readonly FlatOption[];
  readonly menuId: string;
  readonly onCommit: (option: FlatOption) => void;
  readonly onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  readonly section: KeikoSelectSection;
  readonly sectionIndex: number;
  readonly setOptionRef: (index: number, element: HTMLButtonElement | null) => void;
}): ReactNode {
  // A labelled section is a real listbox group so its options stay
  // owned by the listbox and screen readers announce the group name;
  // an unlabelled wrapper is role="presentation" so its options are
  // treated as direct listbox children (WAI-ARIA listbox pattern).
  const sectionLabelId =
    section.label !== undefined ? `${menuId}-section-${sectionIndex.toString()}` : undefined;
  return (
    <div
      className="ksel-section"
      role={section.label !== undefined ? "group" : "presentation"}
      aria-labelledby={sectionLabelId}
    >
      {section.label !== undefined ? (
        <div className="ksel-section-label" id={sectionLabelId}>
          {section.label}
        </div>
      ) : null}
      {section.options.map((option) => {
        const index = flatOptions.findIndex(
          (entry) => entry.value === option.value && entry.sectionLabel === section.label,
        );
        // aria-selected tracks the roving focus (activeIndex) so
        // assistive tech reports the option keyboard focus is on,
        // not the last committed value.
        const active = index === activeIndex;
        const flatOption = flatOptions[index];
        if (flatOption === undefined) return null;
        return (
          <OverflowOptionButton
            active={active}
            index={index}
            key={`${section.label ?? "section"}-${option.value}`}
            onCommit={onCommit}
            onOptionKeyDown={onOptionKeyDown}
            option={flatOption}
            setOptionRef={setOptionRef}
          />
        );
      })}
    </div>
  );
}

function KeikoSelectMenu({
  activeIndex,
  ariaLabel,
  flatOptions,
  menuClassName,
  menuCountLabel,
  menuId,
  menuLabel,
  menuRef,
  menuTitle,
  onCommit,
  onOptionKeyDown,
  placeholder,
  position,
  sections,
  setOptionRef,
  showMenuHeader,
}: {
  readonly activeIndex: number;
  readonly ariaLabel: string | undefined;
  readonly flatOptions: readonly FlatOption[];
  readonly menuClassName: string | undefined;
  readonly menuCountLabel: string | undefined;
  readonly menuId: string;
  readonly menuLabel: string;
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly menuTitle: string | undefined;
  readonly onCommit: (option: FlatOption) => void;
  readonly onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  readonly placeholder: string | undefined;
  readonly position: MenuPosition;
  readonly sections: readonly KeikoSelectSection[];
  readonly setOptionRef: (index: number, element: HTMLButtonElement | null) => void;
  readonly showMenuHeader: boolean;
}): ReactNode {
  return createPortal(
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
        aria-label={menuLabel}
        style={{ maxHeight: `${position.maxHeight.toString()}px` }}
      >
        {sections.map((section, sectionIndex) => (
          <KeikoSelectMenuSection
            activeIndex={activeIndex}
            flatOptions={flatOptions}
            key={`${section.label ?? "section"}-${sectionIndex.toString()}`}
            menuId={menuId}
            onCommit={onCommit}
            onOptionKeyDown={onOptionKeyDown}
            section={section}
            sectionIndex={sectionIndex}
            setOptionRef={setOptionRef}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

export default function KeikoSelect({
  value,
  sections,
  onValueChange,
  disabled = false,
  placeholder,
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
  const t = useTranslate();
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
  const resolvedPlaceholder = placeholder ?? t("select.placeholder");
  const visibleLabel = selectedOption?.label ?? resolvedPlaceholder;
  const visibleDescription = selectedOption?.description ?? null;
  const menuLabel = menuTitle ?? ariaLabel ?? resolvedPlaceholder;

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
        optionHeight: Math.max(28, Math.min(rect.height, 30)),
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
      // The options portal to document.body, outside any containing dialog. On
      // Tab we must both close the menu AND return focus to the trigger (which
      // lives inside the dialog) and preventDefault, otherwise focus escapes the
      // modal's focus trap into the page behind it (mirrors Escape/commit).
      event.preventDefault();
      closeMenu();
      triggerRef.current?.focus();
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
        const start = resolveTypeaheadStartIndex(activeIndex, selectedIndex);
        const matchIndex = findTypeaheadIndex(flatOptions, start, query);
        if (matchIndex !== -1) setActiveIndex(matchIndex);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, activeIndex, flatOptions, selectedIndex]);

  const triggerClasses = buildTriggerClasses({
    disabled,
    mono,
    open,
    openUp,
    position,
    triggerClassName,
  });

  const popup =
    open && position !== null ? (
      <KeikoSelectMenu
        activeIndex={activeIndex}
        ariaLabel={ariaLabel}
        flatOptions={flatOptions}
        menuClassName={menuClassName}
        menuCountLabel={menuCountLabel}
        menuId={menuId}
        menuLabel={menuLabel}
        menuRef={menuRef}
        menuTitle={menuTitle}
        onCommit={commit}
        onOptionKeyDown={onOptionKeyDown}
        placeholder={placeholder}
        position={position}
        sections={sections}
        setOptionRef={(optionIndex, element) => {
          optionRefs.current[optionIndex] = element;
        }}
        showMenuHeader={showMenuHeader}
      />
    ) : null;

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
        /* eslint-disable-next-line jsx-a11y/no-autofocus -- callers opt in for modal initial-focus handoff. */
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
