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
      props.onClose();
    },
    [results, focusActivatedTarget, props.onClose],
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
    <div id="command-palette-results" className="cmdk-list" role="listbox">
      {state.results.length === 0 && <div className="cmdk-empty">{t("commandPalette.empty")}</div>}
      {state.results.map((command, index) => (
        <button
          key={command.id}
          id={`command-palette-option-${String(index)}`}
          type="button"
          role="option"
          aria-selected={index === state.selected}
          className="cmdk-row"
          data-sel={index === state.selected}
          tabIndex={-1}
          onPointerEnter={() => state.setSelected(index)}
          onClick={() => state.activate(index)}
        >
          <span className="cmdk-label">{command.label}</span>
          <span className="spacer" />
          {command.shortcut !== undefined ? <span className="kbd">{command.shortcut}</span> : null}
          <span className="cmdk-group mono">{command.group}</span>
        </button>
      ))}
    </div>
  );
}

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  useWindowStageEvidence("command palette");
  const t = useOptionalWidgetTranslate();
  const state = useCommandPalette(props);
  const count = state.results.length;
  return (
    <div className="cmdk-overlay" onPointerDown={props.onClose}>
      <dialog
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
          {count === 0
            ? t("commandPalette.empty")
            : t(count === 1 ? "commandPalette.result.singular" : "commandPalette.result.plural", {
                count,
              })}
        </output>
        <CommandList state={state} />
      </dialog>
    </div>
  );
}
