"use client";

import {
  useCallback,
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
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useTranslate } from "@/lib/i18n";
import styles from "./KeikoSelect.module.css";

type EscapeFocusLocation = "trigger" | "search" | "option";

type KeikoSelectOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly badge?: string;
};

type KeikoSelectSection = {
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
  /** Called after a deliberate pointer or keyboard opening is accepted. */
  readonly onOpen?: (() => void) | undefined;
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
  /** Minimum width for a detached menu when its compact trigger is narrower than the options. */
  readonly menuPopoverMinWidth?: number;
  readonly menuPopoverMaxHeight?: number;
  readonly menuPlacement?: "auto" | "up";
  readonly searchPlaceholder?: string;
  /** The line a search shows when nothing matches, in the caller's own copy. */
  readonly searchEmptyLabel?: string;
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
const SELECT_OPEN_EVENT = "keiko:select-open";

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
  for (const offset of options.keys()) {
    const index = (start + (offset + 1) * direction + options.length) % options.length;
    if (options[index]?.disabled !== true) return index;
  }
  return -1;
}

function resolveTypeaheadStartIndex(activeIndex: number, selectedIndex: number): number {
  return activeIndex >= 0 ? activeIndex : Math.max(selectedIndex, 0);
}

// S3358 — the index to open the menu on, in priority order: an explicit still-enabled
// preferred index, then the still-enabled current selection, then the first enabled option.
function resolveOpenMenuIndex(
  options: readonly FlatOption[],
  preferredIndex: number | undefined,
  selectedIndex: number,
): number {
  if (preferredIndex !== undefined && options[preferredIndex]?.disabled !== true) {
    return preferredIndex;
  }
  if (selectedIndex >= 0 && options[selectedIndex]?.disabled !== true) {
    return selectedIndex;
  }
  return firstEnabledIndex(options);
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

function searchRank(label: string, query: string): number {
  const candidate = label.toLocaleLowerCase();
  if (candidate === query) return 0;
  return candidate.startsWith(query) ? 1 : 2;
}

const MENU_VIEWPORT_PADDING = 16;

interface MenuSizing {
  readonly menuMinWidth: number | undefined;
  readonly menuPopoverMinWidth: number | undefined;
  readonly menuPopoverMaxHeight: number | undefined;
  /** The height the menu's header and search field take above its options. */
  readonly chromeReserve: number;
}

// A compact trigger narrower than the options gets a readable menu, never wider than the viewport.
function menuWidth(rect: DOMRect, sizing: MenuSizing): number {
  const compactReadableWidth =
    sizing.menuMinWidth !== undefined && rect.width < Math.min(sizing.menuMinWidth, 96)
      ? sizing.menuMinWidth
      : rect.width;
  return Math.min(
    Math.max(compactReadableWidth, sizing.menuPopoverMinWidth ?? 0),
    window.innerWidth - MENU_VIEWPORT_PADDING * 2,
  );
}

function menuOpensUp(rect: DOMRect, placement: "auto" | "up"): boolean {
  const spaceBelow = window.innerHeight - rect.bottom - MENU_VIEWPORT_PADDING;
  const spaceAbove = rect.top - MENU_VIEWPORT_PADDING;
  const minUsableHeight = Math.max(96, rect.height * 2);
  return placement === "up" || (spaceBelow < minUsableHeight && spaceAbove > spaceBelow);
}

function menuMaxHeight(rect: DOMRect, openUp: boolean, sizing: MenuSizing): number {
  const availableHeight = openUp
    ? rect.top - MENU_VIEWPORT_PADDING
    : window.innerHeight - rect.bottom - MENU_VIEWPORT_PADDING;
  return Math.max(
    rect.height,
    Math.min(
      Math.max(rect.height, availableHeight - sizing.chromeReserve),
      sizing.menuPopoverMaxHeight ?? 380,
    ),
  );
}

// The options a search shows, exact and leading matches first.
function searchSections(
  sections: readonly KeikoSelectSection[],
  rawQuery: string,
): readonly KeikoSelectSection[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (query === "") return sections;
  return sections.map((section) => ({
    ...section,
    options: section.options
      .filter((option) => option.label.toLocaleLowerCase().includes(query))
      .sort((a, b) => searchRank(a.label, query) - searchRank(b.label, query)),
  }));
}

// A new query activates its first enabled match, or none when nothing matches (PR #3625 review:
// index 0 could name a disabled option or no option at all).
function firstEnabledSearchMatch(sections: readonly KeikoSelectSection[], query: string): number {
  return searchSections(sections, query)
    .flatMap((section) => section.options)
    .findIndex((option) => option.disabled !== true);
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
  selected,
  setOptionRef,
}: {
  readonly active: boolean;
  readonly index: number;
  readonly onCommit: (option: FlatOption) => void;
  readonly onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  readonly option: FlatOption;
  readonly selected: boolean;
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
      aria-selected={selected}
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
  selectedIndex,
  setOptionRef,
}: {
  readonly activeIndex: number;
  readonly flatOptions: readonly FlatOption[];
  readonly menuId: string;
  readonly onCommit: (option: FlatOption) => void;
  readonly onOptionKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
  readonly section: KeikoSelectSection;
  readonly sectionIndex: number;
  readonly selectedIndex: number;
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
            selected={index === selectedIndex}
            setOptionRef={setOptionRef}
          />
        );
      })}
    </div>
  );
}

/** An opt-in menu search: its field, current query and the line shown when nothing matches. */
interface KeikoSelectMenuSearch {
  readonly placeholder: string;
  readonly query: string;
  readonly emptyLabel: string | undefined;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

function KeikoSelectSearchField({
  search,
}: {
  readonly search: KeikoSelectMenuSearch | undefined;
}): ReactNode {
  if (search === undefined) return null;
  return (
    <div className={styles.cmpMenuSearch}>
      <input
        ref={search.inputRef}
        type="search"
        aria-label={search.placeholder}
        placeholder={search.placeholder}
        value={search.query}
        onChange={(event): void => {
          search.onChange(event.currentTarget.value);
        }}
        onKeyDown={search.onKeyDown}
      />
    </div>
  );
}

function KeikoSelectNoMatches({
  search,
  visible,
}: {
  readonly search: KeikoSelectMenuSearch | undefined;
  readonly visible: boolean;
}): ReactNode {
  if (!visible || search?.emptyLabel === undefined) return null;
  return <p className={styles.cmpMenuEmpty}>{search.emptyLabel}</p>;
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
  selectedIndex,
  sections,
  search,
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
  readonly selectedIndex: number;
  readonly sections: readonly KeikoSelectSection[];
  readonly search: KeikoSelectMenuSearch | undefined;
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
      <KeikoSelectSearchField search={search} />
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
            selectedIndex={selectedIndex}
            setOptionRef={setOptionRef}
          />
        ))}
        <KeikoSelectNoMatches search={search} visible={flatOptions.length === 0} />
      </div>
    </div>,
    document.body,
  );
}

export default function KeikoSelect({
  value,
  sections,
  onValueChange,
  onOpen,
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
  menuPopoverMinWidth,
  menuPopoverMaxHeight,
  menuPlacement = "auto",
  searchPlaceholder,
  searchEmptyLabel,
  attached = true,
  triggerStyle,
  autoFocus = false,
}: KeikoSelectProps): ReactNode {
  const t = useTranslate();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [openUp, setOpenUp] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const visibleSections = useMemo<readonly KeikoSelectSection[]>(
    () => searchSections(sections, searchQuery),
    [searchQuery, sections],
  );

  const flatOptions = useMemo<readonly FlatOption[]>(
    () =>
      visibleSections.flatMap((section, sectionIndex) =>
        section.options.map((option, optionIndex) => ({
          ...option,
          key: `${section.label ?? "section"}-${sectionIndex.toString()}-${option.value}-${optionIndex.toString()}`,
          sectionLabel: section.label,
        })),
      ),
    [visibleSections],
  );

  const selectedIndex = flatOptions.findIndex((option) => option.value === value);
  const selectedOption = sections
    .flatMap((section) => section.options)
    .find((option) => option.value === value);
  const resolvedPlaceholder = placeholder ?? t("select.placeholder");
  const visibleLabel = selectedOption?.label ?? resolvedPlaceholder;
  const visibleDescription = selectedOption?.description ?? null;
  const menuLabel = menuTitle ?? ariaLabel ?? resolvedPlaceholder;

  // Stable, so it doubles as the listener that closes this menu when another select opens.
  const closeMenu = useCallback((): void => {
    setOpen(false);
    setActiveIndex(-1);
    setSearchQuery("");
  }, []);

  const openMenu = (preferredIndex?: number): void => {
    if (disabled || flatOptions.length === 0) return;
    const fallbackIndex = resolveOpenMenuIndex(flatOptions, preferredIndex, selectedIndex);
    window.dispatchEvent(new Event(SELECT_OPEN_EVENT));
    setOpen(true);
    setActiveIndex(fallbackIndex);
    setSearchQuery("");
    onOpen?.();
  };

  useEffect(() => {
    window.addEventListener(SELECT_OPEN_EVENT, closeMenu);
    return (): void => {
      window.removeEventListener(SELECT_OPEN_EVENT, closeMenu);
    };
  }, [closeMenu]);

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
  }, [closeMenu, open]);

  useLayoutEffect(() => {
    if (!open || triggerRef.current === null) return;
    const sizing: MenuSizing = {
      menuMinWidth,
      menuPopoverMinWidth,
      menuPopoverMaxHeight,
      chromeReserve: (showMenuHeader ? 50 : 0) + (searchPlaceholder === undefined ? 0 : 46) + 2,
    };
    const updatePosition = (): void => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      const viewportPadding = MENU_VIEWPORT_PADDING;
      const width = menuWidth(rect, sizing);
      const menuAttached = attached && Math.abs(width - rect.width) < 1;
      const menuGap = menuAttached ? -1 : 6;
      const openUp = menuOpensUp(rect, menuPlacement);
      setOpenUp(openUp);
      const maxHeight = menuMaxHeight(rect, openUp, sizing);
      const totalMenuHeight = maxHeight + sizing.chromeReserve;
      const computed = window.getComputedStyle(trigger);
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
  }, [
    open,
    attached,
    menuMinWidth,
    menuPopoverMinWidth,
    menuPopoverMaxHeight,
    menuPlacement,
    searchPlaceholder,
    showMenuHeader,
  ]);

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
    if (!open) return;
    if (searchPlaceholder !== undefined) searchRef.current?.focus();
  }, [open, searchPlaceholder]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex < 0) return;
    if (searchPlaceholder !== undefined && document.activeElement === searchRef.current) return;
    optionRefs.current[activeIndex]?.focus();
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, searchPlaceholder]);

  function commit(next: FlatOption): void {
    if (next.disabled) return;
    onValueChange(next.value);
    closeMenu();
    triggerRef.current?.focus();
  }

  // An open menu owns Escape wherever focus sits in it — the trigger, the search box or an option:
  // it closes the menu, and the key must not also clear the workspace's window selection or dismiss
  // an enclosing dialog (the workspace's Escape shortcut stops propagation once it acts). Which
  // surface stays open is a changed product runtime behaviour with no other trace, so every call
  // here — always a genuinely open menu, since each caller is only reachable while `open` is true —
  // reports body-free evidence of the dismissal (PR #3625 review).
  function consumeEscape(focus: EscapeFocusLocation, event: ReactKeyboardEvent<HTMLElement>): void {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    triggerRef.current?.focus();
    reportClientDiagnostic(`[keiko] select menu dismissed by Escape (focus=${focus})`, {
      kind: "other",
      selectDismissal: { reason: "escape", focus },
    });
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;
    if (event.key === "Escape" && open) {
      consumeEscape("trigger", event);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
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
      consumeEscape("option", event);
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

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      consumeEscape("search", event);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      optionRefs.current[firstEnabledIndex(flatOptions)]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = flatOptions[firstEnabledIndex(flatOptions)];
      if (first !== undefined) commit(first);
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
  }, [open, activeIndex, closeMenu, flatOptions, selectedIndex]);

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
        selectedIndex={selectedIndex}
        sections={visibleSections}
        search={
          searchPlaceholder === undefined
            ? undefined
            : {
                placeholder: searchPlaceholder,
                query: searchQuery,
                emptyLabel: searchEmptyLabel,
                inputRef: searchRef,
                onChange: (next): void => {
                  setSearchQuery(next);
                  setActiveIndex(firstEnabledSearchMatch(sections, next));
                },
                onKeyDown: onSearchKeyDown,
              }
        }
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
