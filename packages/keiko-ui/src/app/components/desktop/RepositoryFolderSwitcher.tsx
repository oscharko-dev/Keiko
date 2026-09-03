"use client";

// One shared folder/repository selector for the whole desktop workspace. Managed task-workspace
// lifecycle remains on its dedicated surface; this header control owns only the base folder.
//
// KEIKO-0559: renamed from TaskWorkspaceSwitcher, which this header comment already contradicted
// (it is a folder/repository picker, not a Task Workspace lifecycle control — no pause/resume/
// handoff, no ws_<hash> id, no /task-workspace/* route). "Workspace" names at least four distinct
// things in this codebase; know which one you are in before reading further:
//   1. This file (RepositoryFolderSwitcher) — the shared base-folder/repository picker for the
//      whole desktop shell.
//   2. context/ActiveWorkspaceContext.tsx — the managed Task Workspace lifecycle binding (the
//      active WorkspaceBinding, instance inventory, pause/resume/handoff). The one real touch
//      point between the two is clearTaskOverride below, which clears an active Task Workspace
//      override when the user picks a different repo folder here.
//   3. Workspace.tsx (+ hooks/useWorkspace) — the desktop pan/zoom canvas component windows are
//      arranged on.
//   4. WorkspaceProfileRef / "editor workspace profiles" (keiko-contracts editor-m11-settings,
//      EditorProfilesPanel.tsx) — named bundles of editor settings (font size, tab size,
//      keybinding overrides), unrelated to folders, Task Workspace lifecycle, or the canvas.

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  type SyntheticEvent,
} from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { newClientCorrelationId } from "@/lib/http";
import { pickWithNativeDialog } from "@/lib/native-file-dialog";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { presentChatSessionError, useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { useActiveWorkspace, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import {
  useOptionalChatSessionActions,
  useOptionalChatSessionCatalog,
  type ChatSessionActions,
} from "./context/ChatSessionContext";
import { useNativeFileDialogCapability } from "./hooks/useNativeFileDialogCapability";
import { Icons } from "./Icons";
import styles from "./TaskWorkspaceSwitcher.module.css";

const ChevronIcon = Icons.chevron;
const FolderIcon = Icons.folder;
const WORKSPACE_SELECTION_DIAGNOSTIC = "Workspace folder selection failed.";

function redactedFailureCategory(cause: unknown): string {
  if (cause instanceof DOMException) return "DOMException";
  if (cause instanceof TypeError) return "TypeError";
  if (cause instanceof Error) return "Error";
  return "Unknown";
}

function reportSelectionFailure(cause: unknown, t: I18nTranslate): string {
  const correlationId = newClientCorrelationId();
  window.reportError(
    new Error(
      `${WORKSPACE_SELECTION_DIAGNOSTIC} Cause category: ${redactedFailureCategory(cause)}. Correlation ID: ${correlationId}`,
    ),
  );
  return `${t("workspaceContext.selectionFailed")} ${t("workspaceContext.supportId", { correlationId })}`;
}

function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
  return path.slice(0, end);
}

function pathBasename(path: string): string {
  const parts = trimTrailingSeparators(path).split(/[/\\]/u);
  return parts.at(-1) ?? path;
}

function projectName(project: ProjectWithAvailability | undefined, t: I18nTranslate): string {
  if (project === undefined) return t("workspaceContext.trigger.choose");
  return project.name || pathBasename(project.path);
}

function useCloseOnEscape(
  open: boolean,
  close: () => void,
  triggerRef: RefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return (): void => {
      document.removeEventListener("keydown", onKey);
    };
  }, [close, open, triggerRef]);
}

function useCloseOnOutsideClick(
  open: boolean,
  close: () => void,
  rootRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && rootRef.current !== null && !rootRef.current.contains(target)) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return (): void => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [close, open, rootRef]);
}

function useFocusPickerOnOpen(
  open: boolean,
  nativeSupported: boolean,
  pickerRef: RefObject<HTMLButtonElement | null>,
  pathRef: RefObject<HTMLInputElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (nativeSupported) pickerRef.current?.focus();
      else pathRef.current?.focus();
    });
    return (): void => cancelAnimationFrame(frame);
  }, [nativeSupported, open, pathRef, pickerRef]);
}

interface FolderSelection {
  readonly busy: boolean;
  readonly error: string | null;
  readonly manualPath: string;
  readonly setManualPath: (path: string) => void;
  readonly browse: () => void;
  readonly submitManualPath: (event: SyntheticEvent<HTMLFormElement>) => void;
}

// The one real touch point between folder selection and Task Workspace lifecycle (see the header
// comment's meaning #2): picking a different base folder here must not leave a Task Workspace
// override bound to the folder the user is leaving, so an active override is cleared explicitly
// before the new folder is applied. Resolves true when nothing had to be cleared or the clear
// settled, false when the server refused it: the context then carries the redacted reason, and the
// new folder must NOT be applied on top of an override that is still bound (audit finding,
// 2026-09-03 — the context's mutations never reject, so an `await` alone observed nothing).
async function clearTaskOverride(api: ActiveWorkspaceApi): Promise<boolean> {
  if (api.activeInstance === null) return true;
  return api.clearActive();
}

function useFolderSelection(input: {
  readonly workspaceApi: ActiveWorkspaceApi;
  readonly chatActions: ChatSessionActions | null;
  readonly nativeSupported: boolean;
  readonly close: () => void;
  readonly t: I18nTranslate;
}): FolderSelection {
  const { workspaceApi, chatActions, nativeSupported, close, t } = input;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");

  const selectPath = useCallback(
    (path: string): Promise<void> =>
      applyFolderSelection({
        path,
        workspaceApi,
        chatActions,
        close,
        t,
        setBusy,
        setError,
        setManualPath,
      }),
    [chatActions, close, t, workspaceApi],
  );

  const browse = useCallback((): void => {
    if (!nativeSupported || busy) return;
    setBusy(true);
    setError(null);
    void runNativeFolderPick({ selectPath, setBusy, setError, t });
  }, [busy, nativeSupported, selectPath, t]);

  return {
    busy,
    error,
    manualPath,
    setManualPath,
    browse,
    submitManualPath: (event): void => {
      event.preventDefault();
      void selectPath(manualPath);
    },
  };
}

// Extracted from useFolderSelection's selectPath callback (max-lines-per-function, KEIKO-0559
// rename pass): applies a picked/typed path as the new base folder, clearing any active Task
// Workspace override first. Same logic as before the extraction — only moved, not changed.
async function applyFolderSelection(input: {
  readonly path: string;
  readonly workspaceApi: ActiveWorkspaceApi;
  readonly chatActions: ChatSessionActions | null;
  readonly close: () => void;
  readonly t: I18nTranslate;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: string | null) => void;
  readonly setManualPath: (path: string) => void;
}): Promise<void> {
  const { path, workspaceApi, chatActions, close, t, setBusy, setError, setManualPath } = input;
  const selectedPath = path.trim();
  if (selectedPath.length === 0) return;
  if (chatActions === null) {
    setError(t("workspaceContext.selectionFailed"));
    return;
  }
  setBusy(true);
  setError(null);
  try {
    if (!(await clearTaskOverride(workspaceApi))) {
      setError(t("workspaceContext.overrideClearFailed"));
      return;
    }
    const selected = await chatActions.addProject(selectedPath);
    if (selected === undefined) {
      setError(t("workspaceContext.selectionFailed"));
      return;
    }
    setManualPath("");
    close();
  } catch (cause) {
    setError(reportSelectionFailure(cause, t));
  } finally {
    setBusy(false);
  }
}

// Extracted from useFolderSelection's browse callback (max-lines-per-function, KEIKO-0559 rename
// pass): runs the native directory picker and updates busy/error state from its outcome. Same
// promise-chain shape as before the extraction — only moved, not changed.
function runNativeFolderPick(input: {
  readonly selectPath: (path: string) => Promise<void>;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: string | null) => void;
  readonly t: I18nTranslate;
}): Promise<void> {
  const { selectPath, setBusy, setError, t } = input;
  return pickWithNativeDialog({
    mode: "open-directory",
    title: t("workspaceContext.chooseDialogTitle"),
  })
    .then(async (outcome): Promise<void> => {
      if (outcome.kind === "picked") {
        setBusy(false);
        await selectPath(outcome.paths[0] ?? "");
        return;
      }
      if (outcome.kind === "busy") setError(t("workspaceContext.dialogBusy"));
      else if (outcome.kind === "unsupported") {
        setError(t("workspaceContext.dialogUnsupported"));
      } else if (outcome.kind === "error") setError(outcome.message);
    })
    .finally(() => {
      setBusy(false);
    });
}

function Trigger(props: {
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly panelId: string;
  readonly statusId: string;
  readonly open: boolean;
  readonly busy: boolean;
  readonly name: string;
  readonly selected: boolean;
  readonly toggle: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <button
      ref={props.triggerRef}
      type="button"
      className={styles["cmp-t"]}
      aria-expanded={props.open}
      aria-controls={props.panelId}
      aria-describedby={props.statusId}
      aria-haspopup="dialog"
      aria-label={props.t("workspaceContext.trigger.aria", { name: props.name })}
      aria-busy={props.busy}
      data-bound={props.selected ? "true" : "false"}
      onClick={props.toggle}
    >
      <FolderIcon className={styles["cmp-ti"] ?? ""} size={16} aria-hidden="true" />
      <span className={styles["cmp-tn"]}>{props.name}</span>
      <ChevronIcon className={styles["cmp-tc"] ?? ""} size={13} aria-hidden="true" />
    </button>
  );
}

function CurrentFolder(props: {
  readonly project: ProjectWithAvailability | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  const name = projectName(props.project, props.t);
  return (
    <div className={styles["cmp-c"]} data-empty={props.project === undefined ? "true" : "false"}>
      <span className={styles["cmp-ci"]} aria-hidden="true">
        <FolderIcon size={18} />
      </span>
      <span className={styles["cmp-cc"]}>
        <strong>{name}</strong>
        {props.project === undefined ? null : (
          <span className={styles["cmp-pt"]} title={props.project.path}>
            {props.project.path}
          </span>
        )}
      </span>
    </div>
  );
}

function ManualPathForm(props: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly selection: FolderSelection;
  readonly t: I18nTranslate;
}): ReactNode {
  const pathId = useId();
  return (
    <form className={styles["cmp-mf"]} onSubmit={props.selection.submitManualPath}>
      <label htmlFor={pathId}>{props.t("workspaceContext.manual.label")}</label>
      <div className={styles["cmp-mc"]}>
        <input
          ref={props.inputRef}
          id={pathId}
          value={props.selection.manualPath}
          placeholder={props.t("workspaceContext.manual.placeholder")}
          disabled={props.selection.busy}
          onChange={(event) => {
            props.selection.setManualPath(event.target.value);
          }}
        />
        <button
          type="submit"
          className={styles["cmp-sb"]}
          disabled={props.selection.busy || props.selection.manualPath.trim().length === 0}
        >
          {props.selection.busy
            ? props.t("workspaceContext.selecting")
            : props.t("workspaceContext.open")}
        </button>
      </div>
    </form>
  );
}

function FolderPanel(props: {
  readonly panelId: string;
  readonly titleId: string;
  readonly project: ProjectWithAvailability | undefined;
  readonly nativeSupported: boolean;
  readonly pickerRef: RefObject<HTMLButtonElement | null>;
  readonly pathRef: RefObject<HTMLInputElement | null>;
  readonly selection: FolderSelection;
  readonly workspaceError: string | null;
  readonly t: I18nTranslate;
}): ReactNode {
  const error = props.selection.error ?? props.workspaceError;
  return (
    <dialog
      open
      id={props.panelId}
      className={styles["cmp-p"]}
      aria-modal="false"
      aria-labelledby={props.titleId}
    >
      <h2 id={props.titleId}>{props.t("workspaceContext.folder.title")}</h2>
      <CurrentFolder project={props.project} t={props.t} />
      {props.nativeSupported ? (
        <button
          ref={props.pickerRef}
          type="button"
          className={styles["cmp-pb"]}
          disabled={props.selection.busy}
          onClick={props.selection.browse}
        >
          <FolderIcon size={16} />
          {props.selection.busy
            ? props.t("workspaceContext.selecting")
            : props.t("workspaceContext.choose")}
        </button>
      ) : (
        <ManualPathForm inputRef={props.pathRef} selection={props.selection} t={props.t} />
      )}
      {error === null ? null : (
        <p role="alert" className={styles["cmp-e"]}>
          {error}
        </p>
      )}
    </dialog>
  );
}

interface SwitcherState {
  readonly open: boolean;
  readonly setOpen: Dispatch<SetStateAction<boolean>>;
  readonly panelId: string;
  readonly titleId: string;
  readonly statusId: string;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly pickerRef: RefObject<HTMLButtonElement | null>;
  readonly pathRef: RefObject<HTMLInputElement | null>;
  readonly selection: FolderSelection;
}

// Extracted from SwitcherContent (max-lines-per-function, KEIKO-0559 rename pass): the panel's
// open/close state, ids, refs, and the close-on-escape/close-on-outside-click/focus-on-open
// behavior wiring, plus the folder-selection state itself. Same logic as before the extraction —
// only moved into its own controller hook, not changed.
function useSwitcherState(props: {
  readonly api: ActiveWorkspaceApi;
  readonly chatActions: ChatSessionActions | null;
  readonly nativeSupported: boolean;
  readonly t: I18nTranslate;
}): SwitcherState {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const titleId = useId();
  const statusId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const close = useCallback((): void => setOpen(false), []);
  useCloseOnEscape(open, close, triggerRef);
  useCloseOnOutsideClick(open, close, rootRef);
  useFocusPickerOnOpen(open, props.nativeSupported, pickerRef, pathRef);
  const selection = useFolderSelection({
    workspaceApi: props.api,
    chatActions: props.chatActions,
    nativeSupported: props.nativeSupported,
    close,
    t: props.t,
  });
  return {
    open,
    setOpen,
    panelId,
    titleId,
    statusId,
    rootRef,
    triggerRef,
    pickerRef,
    pathRef,
    selection,
  };
}

function SwitcherContent(props: {
  readonly api: ActiveWorkspaceApi;
  readonly project: ProjectWithAvailability | undefined;
  readonly chatActions: ChatSessionActions | null;
  readonly nativeSupported: boolean;
  readonly sessionError: string | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  const state = useSwitcherState(props);
  const name = projectName(props.project, props.t);
  const workspaceError = props.api.error ?? props.sessionError ?? null;

  return (
    <div ref={state.rootRef} className={styles["cmp-r"]}>
      <Trigger
        triggerRef={state.triggerRef}
        panelId={state.panelId}
        statusId={state.statusId}
        open={state.open}
        busy={props.api.switching || state.selection.busy}
        name={name}
        selected={props.project !== undefined}
        toggle={() => state.setOpen((value) => !value)}
        t={props.t}
      />
      <span id={state.statusId} role="status" aria-live="polite" className={styles["cmp-sr"]}>
        {props.project === undefined
          ? props.t("workspaceContext.status.none")
          : props.t("workspaceContext.status.project", { name })}
      </span>
      {state.open ? (
        <FolderPanel
          panelId={state.panelId}
          titleId={state.titleId}
          project={props.project}
          nativeSupported={props.nativeSupported}
          pickerRef={state.pickerRef}
          pathRef={state.pathRef}
          selection={state.selection}
          workspaceError={workspaceError}
          t={props.t}
        />
      ) : null}
    </div>
  );
}

function RepositoryFolderSwitcherImpl(): ReactNode {
  const t = useTranslate();
  const optionalT = useOptionalWidgetTranslate();
  const api = useActiveWorkspace();
  const catalog = useOptionalChatSessionCatalog();
  const chatActions = useOptionalChatSessionActions();
  const nativeSupported = useNativeFileDialogCapability();
  return (
    <SwitcherContent
      api={api}
      project={catalog?.activeProject}
      chatActions={chatActions}
      nativeSupported={nativeSupported}
      sessionError={presentChatSessionError(catalog?.error, optionalT)}
      t={t}
    />
  );
}

export const RepositoryFolderSwitcher = memo(RepositoryFolderSwitcherImpl);
