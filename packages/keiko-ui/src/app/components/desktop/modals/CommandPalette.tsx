"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { useTranslate } from "@/lib/i18n";
import { restoreModalFocusAfterUnlock } from "./modalFocusRestore";
import type { EditorPaletteHost } from "../widgets/cards/editorCommands";
import type { Command, PaletteCommand, CommandShortcutLabels } from "../workspaceCommands";
import { buildPaletteCommands } from "../paletteCommands";
import { NATIVE_BLOCK_STYLE } from "../native-element-styles";
import { useWindowStageEvidence } from "../hooks/useWindowStageEvidence";

interface CommandPaletteProps {
  readonly commands: readonly PaletteCommand[];
  readonly opener?: HTMLElement | null;
  readonly onClose: () => void;
}

// Keep editor command construction outside the initial desktop bundle.
export function DesktopCommandPalette({
  appCommands,
  editorHost,
  shortcutLabels,
  ...props
}: Omit<CommandPaletteProps, "commands"> & {
  readonly appCommands: readonly Command[];
  readonly editorHost: EditorPaletteHost | null;
  readonly shortcutLabels: CommandShortcutLabels;
}): ReactNode {
  const t = useTranslate();
  const commands = useMemo(
    () => buildPaletteCommands(appCommands, editorHost, t, shortcutLabels),
    [appCommands, editorHost, shortcutLabels, t],
  );
  return <CommandPalette {...props} commands={commands} />;
}

function commandMatches(command: PaletteCommand, query: string): boolean {
  const needle = query.toLowerCase();
  return `${command.label} ${command.group} ${command.id}`.toLowerCase().includes(needle);
}

// Restores focus to whatever had it before the palette opened, once the palette closes.
function useCommandFocusRestore(
  inputRef: RefObject<HTMLInputElement | null>,
  opener: HTMLElement | null,
): () => void {
  const openerRef = useRef(opener);
  const restoreOpenerRef = useRef(true);
  const focusActivatedTarget = useCallback((): void => {
    restoreOpenerRef.current = false;
  }, []);
  useEffect(() => {
    const opener = openerRef.current;
    inputRef.current?.focus();
    return (): void => {
      restoreModalFocusAfterUnlock(restoreOpenerRef.current ? opener : null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return focusActivatedTarget;
}

function commandKeyDownHandler(
  itemCount: number,
  selected: number,
  setSelected: Dispatch<SetStateAction<number>>,
  activate: (index: number) => void,
  onClose: () => void,
  inputRef: RefObject<HTMLInputElement | null>,
): (event: ReactKeyboardEvent<HTMLInputElement>) => void {
  return (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (itemCount > 0) setSelected((current) => (current + 1) % itemCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (itemCount > 0) setSelected((current) => (current - 1 + itemCount) % itemCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
      inputRef.current?.focus();
    }
  };
}

interface CommandPaletteState {
  readonly query: string;
  readonly setQuery: Dispatch<SetStateAction<string>>;
  readonly selected: number;
  readonly setSelected: Dispatch<SetStateAction<number>>;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly results: readonly PaletteCommand[];
  readonly activate: (index: number) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

function useCommandPalette(props: CommandPaletteProps): CommandPaletteState {
  const { onClose } = props;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusActivatedTarget = useCommandFocusRestore(inputRef, props.opener ?? null);
  const needle = query.replace(/^>/u, "").trim();
  const results = useMemo(
    () =>
      needle.length === 0
        ? props.commands
        : props.commands.filter((command) => commandMatches(command, needle)),
    [needle, props.commands],
  );
  useEffect(() => setSelected(0), [results]);
  const activate = useCallback(
    (index: number): void => {
      const command = results[index];
      if (command === undefined) return;
      command.run();
      focusActivatedTarget();
      onClose();
    },
    [results, focusActivatedTarget, onClose],
  );
  return {
    query,
    setQuery,
    selected,
    setSelected,
    inputRef,
    results,
    activate,
    onKeyDown: commandKeyDownHandler(
      results.length,
      selected,
      setSelected,
      activate,
      props.onClose,
      inputRef,
    ),
  };
}

function CommandQuery({ state }: { readonly state: CommandPaletteState }): ReactNode {
  const t = useOptionalWidgetTranslate();
  return (
    <div className="cmdk-input">
      <input
        ref={state.inputRef}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="command-palette-results"
        aria-expanded="true"
        aria-activedescendant={
          state.results.length > 0 ? `command-palette-option-${String(state.selected)}` : undefined
        }
        aria-label={t("commandPalette.query")}
        placeholder={t("commandPalette.placeholder")}
        spellCheck={false}
        autoComplete="off"
        value={state.query}
        onChange={(event) => state.setQuery(event.target.value)}
        onKeyDown={state.onKeyDown}
      />
      <span className="kbd">esc</span>
    </div>
  );
}

function CommandList({ state }: { readonly state: CommandPaletteState }): ReactNode {
  const t = useOptionalWidgetTranslate();
  return (
    <select
      id="command-palette-results"
      className="cmdk-list"
      aria-label={t("commandPalette.title")}
      size={Math.max(2, Math.min(8, state.results.length))}
      value={String(state.selected)}
      tabIndex={-1}
      style={{ width: "100%", background: "var(--bg)", color: "var(--fg)", border: 0 }}
      onChange={(event): void => state.setSelected(Number(event.target.value))}
      onClick={(event): void => {
        const target = event.target;
        const value =
          target instanceof HTMLOptionElement ? target.value : event.currentTarget.value;
        state.activate(Number(value));
      }}
    >
      {state.results.length === 0 && <option disabled>{t("commandPalette.empty")}</option>}
      {state.results.map((command, index) => (
        <option
          key={command.id}
          id={`command-palette-option-${String(index)}`}
          value={String(index)}
          aria-selected={index === state.selected}
          className="cmdk-row"
          data-sel={index === state.selected}
          onPointerEnter={() => state.setSelected(index)}
        >
          {[command.label, command.shortcut, command.group].filter(Boolean).join(" · ")}
        </option>
      ))}
    </select>
  );
}

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { onClose } = props;
  useWindowStageEvidence("command palette");
  const t = useOptionalWidgetTranslate();
  const state = useCommandPalette(props);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && dialogRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", dismiss);
    return (): void => document.removeEventListener("keydown", dismiss);
  }, [onClose]);
  const count = state.results.length;
  const resultKey = count === 1 ? "commandPalette.result.singular" : "commandPalette.result.plural";
  const resultSummary = count === 0 ? t("commandPalette.empty") : t(resultKey, { count });
  return (
    <div className="cmdk-overlay" onPointerDown={props.onClose}>
      <dialog
        ref={dialogRef}
        open
        className="cmdk"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        aria-describedby="command-palette-desc"
        tabIndex={-1}
        style={{ margin: 0, padding: 0 }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="command-palette-title" className="sr-only">
          {t("commandPalette.title")}
        </h2>
        <p id="command-palette-desc" className="sr-only">
          {t("commandPalette.description")}
        </p>
        <CommandQuery state={state} />
        <output className="sr-only" style={NATIVE_BLOCK_STYLE}>
          {resultSummary}
        </output>
        <CommandList state={state} />
      </dialog>
    </div>
  );
}
