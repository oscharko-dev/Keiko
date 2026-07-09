"use client";

/**
 * Quick-Open + Command-Palette overlay for the editor (Wave 2, item 2.3).
 *
 * One controlled overlay with two modes: Quick-Open (fuzzy file open, debounced `fetchFilesSearch`)
 * and the command palette (the host command registry filtered by the shared fuzzy matcher). A leading
 * `>` in the input toggles into command mode (VS Code parity). The host (`EditorWidget`) owns the
 * open/close state and supplies the `EditorPaletteHost`. Styling reuses the existing `.ed-dialog-*`
 * backdrop and `.edm-item` / `.files-root-input` classes plus inline popover tokens, so no `globals.css`
 * change is needed (the #1300 proof gate stays untouched).
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { fetchFilesSearch } from "../../../../../lib/api";
import type { FilesSearchResult } from "../../../../../lib/types";
import { FileIcon } from "../shared/projectTree";
import {
  availablePaletteCommands,
  fuzzyScore,
  type EditorPaletteCommand,
  type EditorPaletteHost,
} from "./editorCommands";

export type EditorPaletteMode = "files" | "commands";

interface EditorCommandPaletteProps {
  readonly mode: EditorPaletteMode;
  readonly root: string;
  readonly host: EditorPaletteHost;
  readonly onOpenFile: (root: string, file: string) => void;
  readonly onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_LIMIT = 30;

function rankCommands(query: string, host: EditorPaletteHost): readonly EditorPaletteCommand[] {
  const available = availablePaletteCommands(host);
  if (query.length === 0) return available;
  return available
    .map((command) => ({ command, score: fuzzyScore(query, command.title) }))
    .filter(
      (entry): entry is { command: EditorPaletteCommand; score: number } => entry.score !== null,
    )
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.command);
}

export function EditorCommandPalette({
  mode,
  root,
  host,
  onOpenFile,
  onClose,
}: EditorCommandPaletteProps): ReactNode {
  const [query, setQuery] = useState(mode === "commands" ? ">" : "");
  const [fileResults, setFileResults] = useState<readonly FilesSearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const effectiveMode: EditorPaletteMode = query.startsWith(">") ? "commands" : "files";
  const commandQuery = query.startsWith(">") ? query.slice(1).trim() : "";

  // GEN-UI-FOCUS-006: capture the element focused when the palette opened so focus can be restored to
  // it on close. Read during the first render (before the mount effect moves focus into the input) so
  // it is the true opener, not the palette input. Restored in the mount effect's cleanup on unmount.
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const opener = returnFocusRef.current;
    return () => {
      if (opener !== null && typeof opener.focus === "function" && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  // Debounced, abortable file search. Empty query shows nothing (not the whole tree).
  useEffect(() => {
    if (effectiveMode !== "files") return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setFileResults([]);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(() => {
      void fetchFilesSearch(root, trimmed, SEARCH_LIMIT, { signal: controller.signal })
        .then((response) => setFileResults(response.results))
        .catch(() => {
          // Aborted or transient failure — keep the prior results; the palette never breaks editing.
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [effectiveMode, query, root]);

  const commandItems = useMemo(
    () => (effectiveMode === "commands" ? rankCommands(commandQuery, host) : []),
    [commandQuery, effectiveMode, host],
  );

  const itemCount = effectiveMode === "files" ? fileResults.length : commandItems.length;

  // Reset the highlight whenever the result set could change.
  useEffect(() => {
    setSelected(0);
  }, [query, effectiveMode, fileResults]);

  const activate = (index: number): void => {
    if (effectiveMode === "files") {
      const result = fileResults[index];
      if (result !== undefined) {
        onOpenFile(result.root, result.path);
        onClose();
      }
      return;
    }
    const command = commandItems[index];
    if (command !== undefined) {
      command.run(host);
      onClose();
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
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
      // GEN-UI-FOCUS-005: aria-modal="true" promises the dialog contains focus, but nothing stopped
      // Tab from moving focus to the editor behind it. Keep focus on the input by cycling to the
      // first/last focusable descendant (the list options are pointer-activated and reachable via
      // Arrow keys + aria-activedescendant, so Tab has no in-dialog target to move to). preventDefault
      // keeps focus inside the dialog rather than escaping to the page behind the modal.
      const dialog = dialogRef.current;
      if (dialog === null) {
        event.preventDefault();
        return;
      }
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length <= 1) {
        // The input is effectively the sole tab stop — keep focus on it.
        event.preventDefault();
        inputRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  const optionId = (index: number): string => `${listId}-opt-${String(index)}`;

  return (
    <div
      className="ed-dialog-backdrop"
      role="presentation"
      style={{ alignItems: "flex-start", paddingTop: "12vh" }}
      onPointerDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={effectiveMode === "files" ? "Go to file" : "Run command"}
        onPointerDown={(event) => event.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--popover-surface)",
          border: "1px solid var(--popover-border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--popover-shadow)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          className="files-root-input mono"
          style={{ margin: 8, width: "auto" }}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={itemCount > 0}
          aria-controls={listId}
          aria-activedescendant={itemCount > 0 ? optionId(selected) : undefined}
          aria-label={
            effectiveMode === "files"
              ? "File name — type to search, prefix with > for commands"
              : "Command name"
          }
          placeholder={
            effectiveMode === "files" ? "Go to file…  (› for commands)" : "Run a command…"
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div
          id={listId}
          role="listbox"
          aria-label={effectiveMode === "files" ? "Files" : "Commands"}
          style={{ overflowY: "auto", padding: "0 6px 6px" }}
        >
          {itemCount === 0 ? (
            <div className="files-note" role="status" style={{ padding: "6px 9px" }}>
              {effectiveMode === "files"
                ? query.trim().length === 0
                  ? "Type to search files."
                  : "No matching files."
                : "No matching commands."}
            </div>
          ) : effectiveMode === "files" ? (
            fileResults.map((result, index) => (
              <button
                key={`${result.root}\0${result.path}`}
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === selected}
                className="edm-item"
                style={index === selected ? { background: "var(--surface-elevated)" } : undefined}
                onPointerEnter={() => setSelected(index)}
                onClick={() => activate(index)}
              >
                <FileIcon name={result.name} />
                <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column" }}>
                  <span
                    style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {result.name}
                  </span>
                  {result.directory.length > 0 ? (
                    <span
                      className="mono"
                      style={{
                        fontSize: "0.78em",
                        color: "var(--text-secondary)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {result.directory}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          ) : (
            commandItems.map((command, index) => (
              <button
                key={command.id}
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === selected}
                className="edm-item"
                style={index === selected ? { background: "var(--surface-elevated)" } : undefined}
                onPointerEnter={() => setSelected(index)}
                onClick={() => activate(index)}
              >
                <span style={{ flex: 1 }}>{command.title}</span>
                {command.keybinding !== undefined ? (
                  <span
                    className="mono"
                    style={{ fontSize: "0.78em", color: "var(--text-secondary)" }}
                  >
                    {command.keybinding}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
