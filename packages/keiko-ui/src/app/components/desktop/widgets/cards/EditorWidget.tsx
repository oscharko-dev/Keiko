"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  activeEditorPane,
  createEditorDirtyCloseIntent,
  editorLayoutOpenFiles,
  editorLayoutPaneIds,
  editorLayoutReducer,
  selectWorkspaceFileTarget,
  serializeEditorLayoutStateV2,
  type EditorDirtyCloseIntent,
  type EditorLayoutNode,
  type EditorLayoutSplitNode,
  type EditorLayoutStateV2,
  type EditorPaneStateV2,
  type EditorSplitDirection,
  type EditorSplitDropZone,
  type WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import type { EditorDocumentSymbol } from "@oscharko-dev/keiko-editor";

import { Icons } from "../../Icons";
import { acquireGrabbingBodyStyle } from "../../interactionGuards";
import { useDialogTabTrap } from "../../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../../hooks/useModalInteractionLock";
import {
  dirtyFilesUnderPath,
  reconcileEditorDirtyByPane,
  type EditorDirtyByPane,
} from "./editorDirtyState";
import { deleteEditorHotExitSnapshot } from "./editorHotExitStore";
import editorWidgetStyles from "./EditorWidget.module.css";
import type { EditorExternalSaveRequest, EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import type { EditorAgentPaneSnapshot } from "../../../../../lib/types";
import { FilesWidget, type FilesMutationEvent } from "./FilesWidget";
import { EditorOutlinePanel } from "./EditorOutlinePanel";
import { EditorEmptyState } from "./EditorEmptyState";
import { useRegisterEditorPaletteHost } from "../../EditorPaletteHostRegistryContext";
import {
  useEditorQuickAccessTrigger,
  type EditorQuickAccessTrigger,
} from "../../EditorQuickAccessTriggerContext";
import {
  sameEditorOutlineSnapshot,
  type EditorOutlineRevealRequest,
  type EditorOutlineSnapshot,
} from "./editorOutlineModel";
import { type EditorPaletteHost } from "./editorCommands";
import {
  EDITOR_SIDEBAR_MIN_WIDTH,
  EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH,
  editorSidebarBounds,
  editorSidebarTrackWidth,
  editorSidebarWidthFromPointer,
  editorWorkspaceLogicalWidth,
} from "../../editorSidebarSizing";
import {
  useEditorVerificationRun,
  type EditorVerificationRunControls,
} from "./useEditorVerificationRun";
import { useEditorSettings } from "./useEditorSettings";
import {
  WorkspaceTrustBanner,
  WorkspaceTrustDecisionDialog,
  type WorkspaceTrustDecision,
} from "../../workspace-trust/WorkspaceTrustSurfaces";
import trustStyles from "../../workspace-trust/WorkspaceTrust.module.css";
import {
  bindingFromKeyboardEvent,
  resolveEffectiveKeyboardShortcuts,
  type EffectiveKeyboardShortcutRegistry,
} from "../../keyboardShortcutsRegistry";
import {
  completeEditorAgentReconciliation,
  enqueueEditorAgentReconciliation,
  pruneEditorAgentReconciliation,
  type EditorAgentReconciliationEntry,
  type EditorAgentReconciliationQueues,
} from "./editorAgentReconciliationQueue";
import { FileIcon } from "../shared/projectTree";
import {
  allDirtyFiles,
  clampNumber,
  createInitialLayout,
  dirtyFilesForPane,
  draggedTabFromEvent,
  EDITOR_TAB_DRAG_MIME,
  MAX_EDITOR_PANES,
  normalizeEditorFile,
  normalizeEditorLayoutStructure,
  normalizeEditorOpenFiles,
  openFilesPatchValue,
  paneIdFromPoint,
  rovingTabTargetFile,
  sameStringList,
  tabInsertionTargetFromPoint,
  type DraggedTab,
  type PointerTabDrag,
  type TabInsertTarget,
} from "./editorPaneGeometry";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const SplitIcon = Icons.split;
const PanelDownIcon = Icons.panelDown;
const CloseIcon = Icons.close;
const SidebarIcon = Icons.sidebar;

function splitResizerClassName(direction: EditorSplitDirection): string {
  const directionClass =
    direction === "row" ? editorWidgetStyles.paneResizerRow : editorWidgetStyles.paneResizerColumn;
  return `ed-pane-resizer ${editorWidgetStyles.paneResizer} ${directionClass}`;
}

const EditorRuntimeWidget = dynamic<EditorRuntimeWidgetProps>(
  () => import("./EditorRuntimeWidget"),
  {
    ssr: false,
    loading: () => <div className="ed-host-loading" aria-hidden="true" />,
  },
);

export interface EditorWidgetWorkspacePatch {
  readonly root?: string | undefined;
  readonly file?: string | undefined;
  readonly openFiles?: readonly string[] | undefined;
  readonly layoutJson?: string | undefined;
}

export interface EditorWidgetProps extends EditorRuntimeWidgetProps {
  readonly layoutJson?: string | undefined;
  readonly onWorkspaceChange?: ((patch: EditorWidgetWorkspacePatch) => void) | undefined;
  readonly onOpenProblems?: ((projectPath: string) => void) | undefined;
  readonly onOpenWorkspaceTrust?: (() => void) | undefined;
  readonly workspaceTrustUiAvailable?: boolean | undefined;
}

interface PendingDirtyClose {
  readonly intent: EditorDirtyCloseIntent;
  readonly apply: () => void;
  // Run instead of `apply` when the user cancels. Only the pre-flight reasons need it: a cancelled
  // `path-mutation` has to tell the Files tree that its filesystem mutation is vetoed, where a
  // cancelled tab close simply changes nothing.
  readonly onCancel?: (() => void) | undefined;
  readonly dirtyFiles: readonly string[];
  readonly saving: boolean;
  readonly error?: string | undefined;
}

interface WorkspaceRegistrationNoticeState {
  readonly root: string;
  readonly message: string;
}

// Reasons whose file list spans every pane rather than one pane's tabs. A root change and a window
// close act on the whole editor; a path mutation acts on the filesystem, so a second pane holding the
// same dirty file — or any dirty file under a renamed directory — must be prompted for too (S7776:
// membership test, not `.includes()` on a constant array).
const CROSS_PANE_DIRTY_CLOSE_REASONS: ReadonlySet<EditorDirtyCloseIntent["reason"]> = new Set([
  "root-change",
  "window-close",
  "path-mutation",
]);

interface PointerTabDragPosition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

interface EditorExternalLayoutInputs {
  readonly root: string;
  readonly file: string;
  readonly openFiles: readonly string[];
  readonly layoutJson: string | undefined;
}

const TAB_POINTER_DRAG_THRESHOLD_PX = 6;
const MIN_SPLIT_RATIO = 15;
const MAX_SPLIT_RATIO = 85;
const CLOSED_TAB_HISTORY_LIMIT = 20;

function editorExternalLayoutInputs(
  root: string | undefined,
  file: string | undefined,
  openFiles: readonly string[] | undefined,
  layoutJson: string | undefined,
): EditorExternalLayoutInputs {
  const normalizedRoot = root?.trim() ?? "";
  const normalizedFile = normalizeEditorFile(normalizedRoot, file);
  return {
    root: normalizedRoot,
    file: normalizedFile,
    openFiles: normalizeEditorOpenFiles(normalizedRoot, normalizedFile, openFiles),
    layoutJson,
  };
}

function sameEditorExternalLayoutInputs(
  left: EditorExternalLayoutInputs,
  right: EditorExternalLayoutInputs,
): boolean {
  return (
    left.root === right.root &&
    left.file === right.file &&
    left.layoutJson === right.layoutJson &&
    sameStringList(left.openFiles, right.openFiles)
  );
}

function editorShortcutCommandId(
  registry: EffectiveKeyboardShortcutRegistry,
  event: globalThis.KeyboardEvent,
): string | null {
  const binding = bindingFromKeyboardEvent(event);
  if (binding === null) return null;
  const match = registry.commands.find(
    (entry) =>
      entry.binding === binding &&
      entry.command.dispatchOwner === "keiko" &&
      entry.command.contexts.includes("editor"),
  );
  return match?.command.id ?? null;
}

function dispatchEditorShortcut(
  commandId: string,
  host: EditorPaletteHost,
  trigger: EditorQuickAccessTrigger | null,
): boolean {
  if (commandId === "quick-access.files") return dispatchQuickAccess(trigger, "files");
  if (commandId === "quick-access.commands") return dispatchQuickAccess(trigger, "commands");
  if (commandId === "view.splitRight") host.splitActive("row");
  else if (commandId === "view.splitDown") host.splitActive("column");
  else if (commandId === "view.closeSplit") host.closeActiveSplit();
  else if (commandId === "tab.next") host.nextTab();
  else if (commandId === "tab.prev") host.prevTab();
  else if (commandId === "tab.close") host.closeActiveTab();
  else if (commandId === "tab.reopenClosed") host.reopenClosed();
  else if (commandId === "files.saveAll") host.saveAll();
  else return false;
  return true;
}

function dispatchQuickAccess(
  trigger: EditorQuickAccessTrigger | null,
  mode: "files" | "commands",
): boolean {
  if (trigger === null) return false;
  if (mode === "files") trigger.openFiles();
  else trigger.openCommands();
  return true;
}

function DirtyCloseDialog(props: {
  readonly pending: PendingDirtyClose;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const titleId = "editor-dirty-close-title";
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // GEN-UI-FOCUS-006: capture the opener before moving focus into the dialog, and restore it on
    // close/unmount so keyboard focus returns to where the user was (never lost to <body>).
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (opener !== null && typeof opener.focus === "function" && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);
  useDialogTabTrap(dialogRef);
  useModalInteractionLock({ restoreFocus: false });
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && !props.pending.saving) props.onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [props]);
  const dialog = (
    <div className="ed-dialog-backdrop">
      <dialog
        open
        className="ed-dirty-dialog"
        ref={dialogRef}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ position: "relative", inset: "auto", margin: 0, color: "inherit" }}
      >
        <h2 id={titleId}>Unsaved editor changes</h2>
        <p>Choose how to handle these files before continuing.</p>
        <ul>
          {props.pending.dirtyFiles.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
        {props.pending.error !== undefined ? <p role="alert">{props.pending.error}</p> : null}
        <div className="ed-dialog-actions">
          <button
            type="button"
            className="ed-save"
            onClick={props.onSave}
            disabled={props.pending.saving}
          >
            {props.pending.saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            className="ed-reload"
            onClick={props.onDiscard}
            disabled={props.pending.saving}
          >
            Discard
          </button>
          <button
            type="button"
            className="ed-icon-action"
            onClick={props.onCancel}
            disabled={props.pending.saving}
          >
            Cancel
          </button>
        </div>
      </dialog>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

// The split controls rendered into each pane's toolbar. A pure function of the pane plus the stable
// split/close callbacks, so it can be built inside the memoized per-pane binding without depending on
// the live layout (the >1-pane condition is passed in as `showClose`).
function renderPaneActions(
  pane: EditorPaneStateV2,
  showClose: boolean,
  splitPane: (paneId: string, direction: EditorSplitDirection) => void,
  closePane: (paneId: string) => void,
): ReactNode {
  return (
    <span className="ed-pane-actions" aria-label="Editor split controls">
      <button
        type="button"
        className="ed-icon-action"
        aria-label={`Split ${pane.activeFile || "editor"} right`}
        onClick={() => splitPane(pane.id, "row")}
      >
        <SplitIcon size={14} />
      </button>
      <button
        type="button"
        className="ed-icon-action"
        aria-label={`Split ${pane.activeFile || "editor"} down`}
        onClick={() => splitPane(pane.id, "column")}
      >
        <PanelDownIcon size={14} />
      </button>
      {showClose ? (
        <button
          type="button"
          className="ed-icon-action"
          aria-label={`Close split ${pane.activeFile || "editor"}`}
          onClick={() => closePane(pane.id)}
        >
          <CloseIcon size={14} />
        </button>
      ) : null}
    </span>
  );
}

// Plain ArrowLeft/ArrowRight/Home/End (no Alt) roam the roving tab-stop within the pane's visible
// tab order and activate the target (automatic activation, WCAG 2.1.1 + APG tablist). Split out of
// handleTabKeyDown (GEN-MAINT-COMPLEXITY-002) so the alt/non-alt key paths are independently
// readable; takes its callbacks as explicit params rather than closing over component state.
function handleRovingTabKey(
  paneId: string,
  path: string,
  order: readonly string[],
  event: KeyboardEvent<HTMLButtonElement>,
  selectOpenFile: (paneId: string, file: string) => void,
  focusTabButton: (paneId: string, file: string) => void,
): void {
  if (order.length === 0) return;
  const key = event.key;
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
  const targetFile = rovingTabTargetFile(order, path, key);
  event.preventDefault();
  if (targetFile === undefined || targetFile === path) {
    focusTabButton(paneId, path);
    return;
  }
  selectOpenFile(paneId, targetFile);
  focusTabButton(paneId, targetFile);
}

// Alt+Arrow tab-key handling: Alt+Shift+Arrow moves the tab to the adjacent pane, plain Alt+Arrow
// reorders it within the pane. Split out of handleTabKeyDown (GEN-MAINT-COMPLEXITY-002) alongside
// handleRovingTabKey; takes the layout snapshot and commitLayout as explicit params.
function handleAltArrowTabKey(
  paneId: string,
  path: string,
  pane: EditorPaneStateV2,
  event: KeyboardEvent<HTMLButtonElement>,
  layout: EditorLayoutStateV2,
  commitLayout: (nextLayout: EditorLayoutStateV2) => void,
): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const paneIds = editorLayoutPaneIds(layout);
  if (event.shiftKey) {
    const paneIndex = paneIds.indexOf(paneId);
    const targetPaneId =
      event.key === "ArrowLeft" ? paneIds[paneIndex - 1] : paneIds[paneIndex + 1];
    if (targetPaneId !== undefined) {
      commitLayout(
        editorLayoutReducer(layout, {
          type: "move-tab",
          fromPaneId: paneId,
          toPaneId: targetPaneId,
          file: path,
        }),
      );
    }
    return;
  }
  const index = pane.tabOrder.indexOf(path);
  const nextIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
  commitLayout(
    editorLayoutReducer(layout, {
      type: "reorder-tab",
      paneId,
      file: path,
      targetIndex: nextIndex,
    }),
  );
}

// The stable per-pane prop bundle the memoized editor host receives, built once per pane set.
interface PaneBinding {
  readonly onSelectOpenFile: (file: string) => void;
  readonly onCloseOpenFile: (path: string) => Promise<boolean> | boolean | void;
  readonly onDirtyChange: (path: string, dirty: boolean) => void;
  readonly onMoveTab: (fromPaneId: string, file: string, toPaneId: string) => void;
  readonly onSplitPane: (paneId: string, direction: "row" | "column") => void;
  readonly onAgentChangesetCommitted: (entries: readonly EditorAgentReconciliationEntry[]) => void;
  readonly toolbarExtras: ReactNode;
  readonly renderTabHandle: NonNullable<EditorRuntimeWidgetProps["renderTabHandle"]>;
}

function nonEmptyRoot(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

/**
 * #2696 — deterministic post-trust readiness signal for browser regression harnesses. Reports
 * `"true"` only once the workspace-trust status for the bound root has resolved (or definitively
 * failed to resolve) AND the initial-prompt decision has been committed, so an observer can read
 * the prompt's presence in that same commit instead of racing it with a timeout. Derived outside
 * the component so the widget's cognitive complexity is unaffected.
 */
function resolveTrustSettledAttribute(
  verification: EditorVerificationRunControls,
  promptedTrustRoot: string | null,
  workspaceRoot: string,
): "true" | "false" {
  if (!verification.catalogSettled) return "false";
  const initialPromptPending =
    verification.catalog?.workspaceTrust.trust === "restricted" &&
    promptedTrustRoot !== workspaceRoot;
  return initialPromptPending ? "false" : "true";
}

function WorkspaceRegistrationNotice({
  notice,
  workspaceRoot,
}: {
  readonly notice: WorkspaceRegistrationNoticeState | null;
  readonly workspaceRoot: string;
}): ReactNode {
  if (notice?.root !== workspaceRoot) return null;
  return (
    <output
      className={`${trustStyles.cmpBanner} ${trustStyles.cmpEditorBanner}`}
      data-testid="editor-workspace-registration-notice"
    >
      <span className={trustStyles.cmpBannerCopy}>{notice.message}</span>
    </output>
  );
}

/**
 * Whether this binding still owes the human the one-per-binding "opening on an untrusted root"
 * question, and whether answering it means raising the prompt.
 *
 * The latch is consumed on the FIRST resolved trust state whatever it says. Consuming it only for
 * `restricted` left it unspent when the editor opened on a trusted root, so a later explicit
 * revocation re-raised the first-open prompt and asked the human to grant back what they had just
 * revoked. Lives outside the component, like `resolveTrustSettledAttribute` above, so the widget's
 * cognitive complexity is unaffected.
 */
/**
 * What the editor trust banner should report, if anything.
 *
 * `catalog === null` alone is not a failed read: it is also the state before the first read returns
 * and right after a root switch resets it. Treating it as "load" made the banner assert "Workspace
 * Trust could not be read safely" on every editor open — including for a fully trusted root, where
 * it then vanished — inverting the #2625 requirement that a read FAILURE be distinguishable from
 * every other state. `catalogSettled` turns true only once the read resolved or definitively failed.
 *
 * Outside the component, like its neighbours, so the widget's cognitive complexity is unaffected.
 */
function trustBannerIssue(
  trustMutationIssue: "load" | "update" | undefined,
  verification: EditorVerificationRunControls,
): "load" | "update" | undefined {
  if (trustMutationIssue !== undefined) return trustMutationIssue;
  return verification.catalog === null && verification.catalogSettled ? "load" : undefined;
}

function initialTrustLatchDecision(
  status: WorkspaceTrustStatus | undefined,
  promptedTrustRoot: string | null,
  workspaceRoot: string,
): "skip" | "latch" | "latch-and-prompt" {
  if (workspaceRoot.length === 0 || status === undefined) return "skip";
  if (promptedTrustRoot === workspaceRoot) return "skip";
  return status.trust === "restricted" ? "latch-and-prompt" : "latch";
}

// Issue #2747 — a line reveal is addressed to the file cfg named alongside it, and every pane below
// is handed its OWN file. The outline reveal already carries that guard in the runtime widget
// (`outlineRevealRequest?.file === file`); the line reveal did not, so a split view moved the cursor
// and stole focus in every pane, each at that line number in whatever file it happened to show.
// Withheld rather than translated: a line range means nothing in a file it was not measured against.
export function paneLineRevealProps(
  addressedFile: string | undefined,
  paneFile: string,
): Pick<EditorRuntimeWidgetProps, "revealLineEnd" | "revealLineStart" | "revealRequestId"> {
  // A pane with no file open is not an addressee, and neither is an empty addressee — matching two
  // empty strings would hand the request to whichever pane happens to be showing nothing.
  if (addressedFile !== undefined && addressedFile.length > 0 && addressedFile === paneFile) {
    return {};
  }
  return { revealLineStart: undefined, revealLineEnd: undefined, revealRequestId: undefined };
}

interface RevealAddresseeDecision {
  readonly key: string;
  readonly file: string | undefined;
}

/**
 * Issue #2747 / #2748 review — the addressee of a line reveal is normally the `file` prop. A
 * session-driven render has none: a multi-root root that already holds a session is handed only
 * `layoutJson`, so falling back to the active pane's file is what keeps a reveal that arrives
 * alongside a freshly (re)built layout — the layout was just shaped to show that file — from being
 * dropped outright.
 *
 * Issue #2768 — that fallback also fired for a LATER, unrelated reveal against a root that was
 * already sitting open: `root`/`layoutJson` stay unchanged, the active pane is whatever the user
 * last focused, and the request was silently answered there instead of the pane it actually
 * addressed. The fallback is trustworthy only on the render that (re)establishes the layout from
 * `root`/`layoutJson` — exactly the #2748 case. A later reveal id against an otherwise-unchanged,
 * already-settled layout is withheld instead of guessed, the same withhold-don't-translate rule
 * `paneLineRevealProps` already applies once the addressee is known. The decision is pinned to the
 * reveal's own identity so an unrelated re-render (e.g. the layout-sync effect below settling into
 * state right after mount) cannot re-evaluate the same request against a pane the user has since
 * switched away from.
 */
function useAddressedRevealFile(
  workspaceRoot: string,
  file: string | undefined,
  activeFile: string,
  layoutJson: string | undefined,
  revealLineStart: number | undefined,
  revealLineEnd: number | undefined,
  revealRequestId: string | undefined,
): string | undefined {
  const seededRef = useRef(false);
  const layoutOriginRef = useRef<{
    readonly root: string;
    readonly layoutJson: string | undefined;
  }>({ root: workspaceRoot, layoutJson });
  const layoutJustEstablished =
    !seededRef.current ||
    layoutOriginRef.current.root !== workspaceRoot ||
    layoutOriginRef.current.layoutJson !== layoutJson;
  seededRef.current = true;
  layoutOriginRef.current = { root: workspaceRoot, layoutJson };

  const decisionRef = useRef<RevealAddresseeDecision | null>(null);
  const direct = normalizeEditorFile(workspaceRoot, file);
  if (direct.length > 0) return direct;
  if (revealLineStart === undefined) return activeFile || undefined;
  const key = `${revealRequestId ?? ""}:${String(revealLineStart)}:${String(revealLineEnd ?? "")}`;
  const cached = decisionRef.current;
  if (cached !== null && cached.key === key) return cached.file;
  const resolved = layoutJustEstablished ? activeFile || undefined : undefined;
  decisionRef.current = { key, file: resolved };
  return resolved;
}

export function EditorWidget({
  root,
  file,
  openFiles: configuredOpenFiles,
  layoutJson,
  onWorkspaceChange,
  onOpenProblems,
  onOpenWorkspaceTrust,
  workspaceTrustUiAvailable = true,
  onOpenDebugPanel,
  sessionActive = true,
  windowId,
  ...props
}: EditorWidgetProps): ReactNode {
  const initialRoot = root?.trim() ?? "";
  const initialConfiguredFile = normalizeEditorFile(initialRoot, file);
  const initialOpenFiles = normalizeEditorOpenFiles(
    initialRoot,
    initialConfiguredFile,
    configuredOpenFiles,
  );
  const initialLayout = createInitialLayout({
    root: initialRoot,
    file: initialConfiguredFile,
    openFiles: initialOpenFiles,
    layoutJson,
  });
  const [workspaceRoot, setWorkspaceRoot] = useState(initialRoot);
  const [workspaceRegistrationNotice, setWorkspaceRegistrationNotice] =
    useState<WorkspaceRegistrationNoticeState | null>(null);
  const editorSettings = useEditorSettings(nonEmptyRoot(workspaceRoot));
  const editorShortcutRegistry = useMemo(
    () => resolveEffectiveKeyboardShortcuts(editorSettings.applied.keybindingOverrides),
    [editorSettings.applied.keybindingOverrides],
  );
  const editorShortcutRegistryRef = useRef(editorShortcutRegistry);
  editorShortcutRegistryRef.current = editorShortcutRegistry;
  const [layout, setLayout] = useState<EditorLayoutStateV2>(initialLayout);
  const [outlineByPane, setOutlineByPane] = useState<
    Readonly<Record<string, EditorOutlineSnapshot>>
  >({});
  const [outlineRevealByPane, setOutlineRevealByPane] = useState<
    Readonly<Record<string, EditorOutlineRevealRequest>>
  >({});
  const outlineRevealSeqRef = useRef(0);
  // The live layout, read by the pane callbacks so their identity stays stable across layout
  // mutations (Wave 2 perf, the #1580 pattern). Without this every callback closes over `layout` and
  // gets a new identity on each `setLayout`, which churns the per-pane props and defeats the
  // `React.memo` on each pane's editor host — so a tab-select or split-resize in one pane re-renders
  // every pane. Updated on each render (after both `commitLayout` and the prop-sync effect commit).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [dirtyByPane, setDirtyByPane] = useState<EditorDirtyByPane>({});
  const [pendingClose, setPendingClose] = useState<PendingDirtyClose | null>(null);
  // Read by `cancelPendingClose` so dismissing the dialog does not need `pendingClose` in its
  // dependency list (the file's `layoutRef` pattern): the cancel handler must be able to run the
  // pending intent's `onCancel` without taking a new identity on every dirty-state change.
  const pendingCloseRef = useRef<PendingDirtyClose | null>(pendingClose);
  pendingCloseRef.current = pendingClose;
  // The dialog stamps the root it was opened for so a root switch that races
  // the user's Confirm click cannot silently mutate trust on the new root
  // (M11 CWE-863; the confirm handler closes over a `verification` bound to
  // the live root).
  const [trustDecision, setTrustDecision] = useState<{
    readonly action: WorkspaceTrustDecision;
    readonly initialPrompt: boolean;
    readonly root: string;
  } | null>(null);
  const [trustMutationIssue, setTrustMutationIssue] = useState<"update">();
  const [trustMutationPending, setTrustMutationPending] = useState(false);
  // The root whose initial trust prompt has already been raised. This is state rather than a ref
  // because the `data-trust-settled` readiness attribute below is derived from it (#2696): the
  // attribute has to flip in exactly the commit that mounts the initial prompt, so the value must
  // participate in rendering.
  const [promptedTrustRoot, setPromptedTrustRoot] = useState<string | null>(null);
  const [heldTab, setHeldTab] = useState<DraggedTab | null>(null);
  // GEN-PERF-EDITOR-003 — the tab-drag "held" visual is read from a ref inside the memoized
  // per-pane renderTabHandle closure, so that closure stays referentially stable (it no
  // longer closes over `heldTab` state) and React.memo(EditorRuntimeWidget) keeps bailing
  // non-dragged panes out. The affected pane still re-renders because its `heldTabFile`
  // scalar prop changes; other panes see an unchanged `undefined` and are skipped.
  const heldTabRef = useRef<DraggedTab | null>(null);
  heldTabRef.current = heldTab;
  const [draggedTab, setDraggedTab] = useState<DraggedTab | null>(null);
  const [tabDragPosition, setTabDragPosition] = useState<PointerTabDragPosition | null>(null);
  const [tabDropTargetPaneId, setTabDropTargetPaneId] = useState<string | null>(null);
  const [tabInsertTargetState, setTabInsertTargetState] = useState<TabInsertTarget | null>(null);
  const [saveRequest, setSaveRequest] = useState<EditorExternalSaveRequest | null>(null);
  const [fileHistoryRequest, setFileHistoryRequest] = useState<{
    readonly paneId: string;
    readonly nonce: number;
  } | null>(null);
  const fileHistoryRequestSeqRef = useRef(0);
  const [agentReconciliationQueues, setAgentReconciliationQueues] =
    useState<EditorAgentReconciliationQueues>({});
  const saveSeqRef = useRef(0);
  const agentReconciliationSeqRef = useRef(0);
  const saveResolversRef = useRef(new Map<number, (ok: boolean) => void>());
  const lastPropRootRef = useRef(root?.trim() ?? "");
  const lastExternalLayoutInputsRef = useRef<EditorExternalLayoutInputs | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const pointerTabDragRef = useRef<PointerTabDrag | null>(null);
  const tabInsertTargetRef = useRef<TabInsertTarget | null>(null);
  const suppressNextTabClickRef = useRef<DraggedTab | null>(null);
  // Closed-tab MRU backs the reopen command.
  const closedTabsRef = useRef<{ readonly paneId: string; readonly file: string }[]>([]);

  const setTabInsertTarget = useCallback((target: TabInsertTarget | null): void => {
    tabInsertTargetRef.current = target;
    setTabInsertTargetState(target);
  }, []);

  const buildPatch = useCallback(
    (nextRoot: string, nextLayout: EditorLayoutStateV2): EditorWidgetWorkspacePatch => {
      const nextActivePane = activeEditorPane(nextLayout);
      return {
        root: nextRoot,
        file: nextActivePane.activeFile.length > 0 ? nextActivePane.activeFile : undefined,
        openFiles: openFilesPatchValue(editorLayoutOpenFiles(nextLayout)),
        layoutJson: serializeEditorLayoutStateV2(nextLayout),
      };
    },
    [],
  );

  const commitLayout = useCallback(
    (nextLayout: EditorLayoutStateV2, nextRoot = workspaceRoot): void => {
      const normalized = normalizeEditorLayoutStructure(nextRoot, nextLayout);
      setLayout(normalized);
      // Re-home the per-pane dirty index onto the committed layout so a dirty tab
      // keeps its marker and unsaved-changes prompt as it moves between panes and
      // no orphaned flag survives on a collapsed pane (Issue #1375 AC3).
      setDirtyByPane((current) => reconcileEditorDirtyByPane(current, normalized));
      if (nextRoot.length > 0) onWorkspaceChange?.(buildPatch(nextRoot, normalized));
    },
    [buildPatch, onWorkspaceChange, workspaceRoot],
  );

  useEffect(() => {
    const nextInputs = editorExternalLayoutInputs(root, file, configuredOpenFiles, layoutJson);
    const previousInputs = lastExternalLayoutInputsRef.current;
    if (previousInputs !== null && sameEditorExternalLayoutInputs(previousInputs, nextInputs)) {
      return;
    }
    lastExternalLayoutInputsRef.current = nextInputs;
    const { root: nextRoot, file: nextConfiguredFile, openFiles: nextOpenFiles } = nextInputs;
    const nextLayout = createInitialLayout({
      root: nextRoot,
      file: nextConfiguredFile,
      openFiles: nextOpenFiles,
      layoutJson,
    });
    const nextActivePane = activeEditorPane(nextLayout);
    const nextAllOpenFiles = editorLayoutOpenFiles(nextLayout);
    const rootChanged = lastPropRootRef.current !== nextRoot;
    lastPropRootRef.current = nextRoot;
    setWorkspaceRoot(nextRoot);
    setLayout(nextLayout);
    if (rootChanged) {
      setDirtyByPane({});
      setOutlineByPane({});
      setOutlineRevealByPane({});
      setAgentReconciliationQueues({});
      // A trust dialog opened for the previous root must not survive the
      // switch: `verification` is re-derived from the live root each render,
      // so confirming the stale dialog after a switch would grant/revoke on
      // the new root. Fail closed by dismissing everything trust-scoped.
      setTrustDecision(null);
      setTrustMutationIssue(undefined);
      setPromptedTrustRoot(null);
    }
    if (nextRoot.length === 0 || onWorkspaceChange === undefined) return;
    const normalizedFileChanged = (file?.trim() ?? "") !== nextActivePane.activeFile;
    const openFilesChanged = !sameStringList(configuredOpenFiles, nextAllOpenFiles);
    const layoutChanged = layoutJson !== serializeEditorLayoutStateV2(nextLayout);
    if (normalizedFileChanged || openFilesChanged || layoutChanged) {
      onWorkspaceChange(buildPatch(nextRoot, nextLayout));
    }
  }, [buildPatch, configuredOpenFiles, file, layoutJson, onWorkspaceChange, root]);

  const dirtyFileList = useMemo(() => allDirtyFiles(dirtyByPane), [dirtyByPane]);
  const currentPane = activeEditorPane(layout);
  const activeFile = currentPane.activeFile;
  const addressedRevealFile = useAddressedRevealFile(
    workspaceRoot,
    file,
    activeFile,
    layoutJson,
    props.revealLineStart,
    props.revealLineEnd,
    props.revealRequestId,
  );

  useEffect(() => {
    if (dirtyFileList.length === 0) return;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Chrome 79, Firefox 72, and Safari 13.1 require this in addition to preventDefault(); these
      // are still explicit product browser floors.
      event.returnValue = ""; // NOSONAR typescript:S1874 -- required compatibility assignment.
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirtyFileList.length]);

  const markDirty = useCallback((paneId: string, path: string, dirty: boolean): void => {
    setDirtyByPane((current) => {
      const paneDirty = current[paneId] ?? {};
      if (dirty) {
        if (paneDirty[path] === true) return current;
        return { ...current, [paneId]: { ...paneDirty, [path]: true } };
      }
      if (paneDirty[path] !== true) return current;
      const { [path]: _removed, ...remaining } = paneDirty;
      return { ...current, [paneId]: remaining };
    });
  }, []);

  const requestExternalSave = useCallback(
    (paneId: string, path: string): Promise<boolean> => {
      saveSeqRef.current += 1;
      const id = saveSeqRef.current;
      commitLayout(
        editorLayoutReducer(layoutRef.current, { type: "select-file", paneId, file: path }),
      );
      setSaveRequest({ id, paneId, file: path });
      return new Promise<boolean>((resolve) => {
        saveResolversRef.current.set(id, resolve);
      });
    },
    [commitLayout],
  );

  const onExternalSaveComplete = useCallback(
    (requestId: number, paneId: string, path: string, ok: boolean): void => {
      const resolve = saveResolversRef.current.get(requestId);
      saveResolversRef.current.delete(requestId);
      // Functional update (instead of reading `saveRequest` in deps) keeps this callback's identity
      // stable across save lifecycle changes, so a save in one pane does not re-render the others.
      setSaveRequest((current) => (current?.id === requestId ? null : current));
      if (ok) markDirty(paneId, path, false);
      resolve?.(ok);
    },
    [markDirty],
  );

  const queueAgentReconciliation = useCallback(
    (sourcePaneId: string, entries: readonly EditorAgentReconciliationEntry[]): void => {
      agentReconciliationSeqRef.current += 1;
      const request = {
        requestId: agentReconciliationSeqRef.current,
        entries: entries.map((entry) => ({ file: entry.file, kind: entry.kind })),
      };
      setAgentReconciliationQueues((current) =>
        enqueueEditorAgentReconciliation(
          current,
          Object.values(layoutRef.current.panes),
          sourcePaneId,
          request,
        ),
      );
    },
    [],
  );

  const completeAgentReconciliation = useCallback((requestId: number, paneId: string): void => {
    setAgentReconciliationQueues((current) =>
      completeEditorAgentReconciliation(current, paneId, requestId),
    );
  }, []);

  useEffect(() => {
    const paneIds = new Set(Object.keys(layout.panes));
    setAgentReconciliationQueues((current) => pruneEditorAgentReconciliation(current, paneIds));
  }, [layout.panes]);

  const requestDirtyClose = useCallback(
    (input: {
      readonly paneId: string;
      readonly files: readonly string[];
      readonly reason: EditorDirtyCloseIntent["reason"];
      readonly apply: () => void;
      readonly onCancel?: (() => void) | undefined;
    }): boolean => {
      const dirtySet = new Set(allDirtyFiles(dirtyByPane));
      const dirtyFiles = CROSS_PANE_DIRTY_CLOSE_REASONS.has(input.reason)
        ? input.files.filter((entry) => dirtySet.has(entry))
        : dirtyFilesForPane(dirtyByPane, input.paneId, input.files);
      if (dirtyFiles.length === 0) {
        input.apply();
        return true;
      }
      // A second intent replaces the dialog, so the one being displaced never gets an answer. Report
      // that as a cancel: a displaced pre-flight `path-mutation` ask would otherwise leave the Files
      // tree awaiting a promise that can no longer settle, with its busy flag latched.
      pendingCloseRef.current?.onCancel?.();
      setPendingClose({
        intent: createEditorDirtyCloseIntent({
          paneId: input.paneId,
          files: dirtyFiles,
          reason: input.reason,
        }),
        apply: input.apply,
        onCancel: input.onCancel,
        dirtyFiles,
        saving: false,
      });
      return false;
    },
    [dirtyByPane],
  );

  const savePendingClose = useCallback((): void => {
    if (pendingClose === null || pendingClose.saving) return;
    setPendingClose({ ...pendingClose, saving: true, error: undefined });
    void (async () => {
      for (const path of pendingClose.dirtyFiles) {
        const paneId =
          Object.entries(dirtyByPane).find(([, files]) => files[path] === true)?.[0] ??
          pendingClose.intent.paneId;
        const ok = await requestExternalSave(paneId, path);
        if (!ok) {
          setPendingClose({
            ...pendingClose,
            saving: false,
            error: "Save failed. The close action was not applied.",
          });
          return;
        }
      }
      pendingClose.apply();
      setPendingClose(null);
    })();
  }, [dirtyByPane, pendingClose, requestExternalSave]);

  const discardPendingClose = useCallback((): void => {
    if (pendingClose === null || pendingClose.saving) return;
    for (const path of pendingClose.dirtyFiles) {
      for (const [paneId, files] of Object.entries(dirtyByPane)) {
        if (files[path] === true) markDirty(paneId, path, false);
      }
      // AC5: an explicit Discard must delete the hot-exit snapshot for the file, otherwise the
      // discarded edits resurface as a recovery offer the next time the file is opened. The runtime
      // widget's own clean-delete effect cannot be relied on here: applying the close unmounts that
      // widget in the same React commit as the dirty flag is cleared, so the effect never runs.
      // Deletion is scoped to the still-current workspace root (apply() may switch roots afterward).
      void deleteEditorHotExitSnapshot(workspaceRoot, path);
    }
    pendingClose.apply();
    setPendingClose(null);
  }, [dirtyByPane, markDirty, pendingClose, workspaceRoot]);

  const cancelPendingClose = useCallback((): void => {
    const pending = pendingCloseRef.current;
    if (pending === null || pending.saving) return;
    // A cancelled pre-flight intent must report the veto: the Files tree is awaiting this answer and
    // would otherwise hang with its busy flag latched.
    pending.onCancel?.();
    setPendingClose(null);
  }, []);

  const openRoot = useCallback(
    (nextRoot: string): void => {
      const normalizedRoot = nextRoot.trim();
      if (normalizedRoot.length === 0) return;
      const apply = (): void => {
        const nextLayout = editorLayoutReducer(layoutRef.current, {
          type: "replace-root",
          root: normalizedRoot,
          sidebarWidth: layoutRef.current.sidebarWidth,
        });
        setWorkspaceRoot(normalizedRoot);
        setDirtyByPane({});
        commitLayout(nextLayout, normalizedRoot);
      };
      const firstPaneId =
        editorLayoutPaneIds(layoutRef.current)[0] ?? layoutRef.current.activePaneId;
      requestDirtyClose({
        paneId: firstPaneId,
        files: dirtyFileList,
        reason: "root-change",
        apply,
      });
    },
    [commitLayout, dirtyFileList, requestDirtyClose],
  );

  const openFile = useCallback(
    (nextRoot: string, nextFile: string): void => {
      // Resolve to a {root, file} pair: a root-relative or absolute-inside-root candidate keeps
      // `nextRoot`; a single absolute file outside it selects its containing directory as the root
      // (AC3). An unresolvable candidate is dropped so the editor stays on its current usable state.
      const target = selectWorkspaceFileTarget(nextRoot, nextFile);
      if (target === null || target.file.length === 0) return;
      const paneId = activeEditorPane(layoutRef.current).id;
      const nextLayout = editorLayoutReducer(layoutRef.current, {
        type: "open-file",
        paneId,
        file: target.file,
      });
      setWorkspaceRoot(target.root);
      commitLayout(nextLayout, target.root);
    },
    [commitLayout],
  );

  const selectOpenFile = useCallback(
    (paneId: string, nextFile: string): void => {
      if (workspaceRoot.length === 0 || nextFile.length === 0) return;
      commitLayout(
        editorLayoutReducer(layoutRef.current, { type: "select-file", paneId, file: nextFile }),
      );
    },
    [commitLayout, workspaceRoot],
  );

  const activatePane = useCallback(
    (paneId: string): void => {
      const current = layoutRef.current;
      if (current.activePaneId === paneId || current.panes[paneId] === undefined) return;
      commitLayout(editorLayoutReducer(current, { type: "set-active-pane", paneId }));
    },
    [commitLayout],
  );

  // Drop a mutated path's crash-recovery snapshot — but never while that path still holds unsaved
  // changes. The snapshot is then the last copy of a buffer whose file has just been renamed away or
  // deleted, so deleting it would turn a recoverable state into permanent loss. In the guarded flow
  // nothing is dirty by this point (the pre-flight prompt saved or discarded first, and an explicit
  // Discard deletes the snapshot itself), so this only ever preserves a snapshot for a mutation that
  // reached the tree with unsaved work anyway — a host without the pre-flight guard, or a mutation
  // reported from outside it.
  const dropHotExitSnapshotForMutatedPath = useCallback(
    (path: string): void => {
      if (dirtyFilesUnderPath(dirtyByPane, path).length > 0) return;
      void deleteEditorHotExitSnapshot(workspaceRoot, path);
    },
    [dirtyByPane, workspaceRoot],
  );

  // The Files tree asks before it renames, moves, or deletes a path. Renaming or deleting the path of
  // an open buffer with unsaved changes cannot re-home that buffer — the tab reloads the new path from
  // disk — so this is a close of unsaved work and must route through the one dirty-close policy every
  // other close path uses (ADR-0065 D1). `true` lets the mutation proceed (nothing unsaved is at
  // stake, or the user saved/discarded); `false` vetoes it while the buffer is still unsaved. A
  // directory operation carries every dirty file beneath it, and the check spans panes, so a second
  // pane holding the same dirty file still prompts.
  const confirmFilesEntryMutation = useCallback(
    (path: string): Promise<boolean> => {
      const dirtyTargets = dirtyFilesUnderPath(dirtyByPane, path);
      if (dirtyTargets.length === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        requestDirtyClose({
          paneId: activeEditorPane(layoutRef.current).id,
          files: dirtyTargets,
          reason: "path-mutation",
          apply: () => {
            resolve(true);
          },
          onCancel: () => {
            resolve(false);
          },
        });
      });
    },
    [dirtyByPane, requestDirtyClose],
  );

  // A file mutation from the sidebar tree: re-home (rename) or close (delete) any open tabs so they do
  // not go stale and 404. A create needs no layout change — the new file is opened directly by the
  // FilesWidget. The renamed tab reloads from disk (a clean buffer), so the stale dirty marker is
  // pruned by `reconcileEditorDirtyByPane` inside `commitLayout`.
  const handleFilesMutated = useCallback(
    (event: FilesMutationEvent): void => {
      const { op, mutation } = event;
      if (
        op === "rename" &&
        mutation.previousPath !== undefined &&
        mutation.previousPath !== mutation.path
      ) {
        commitLayout(
          editorLayoutReducer(layoutRef.current, {
            type: "rename-file",
            from: mutation.previousPath,
            to: mutation.path,
          }),
        );
        dropHotExitSnapshotForMutatedPath(mutation.previousPath);
      } else if (op === "delete") {
        commitLayout(
          editorLayoutReducer(layoutRef.current, { type: "remove-file", file: mutation.path }),
        );
        dropHotExitSnapshotForMutatedPath(mutation.path);
      }
    },
    [commitLayout, dropHotExitSnapshotForMutatedPath],
  );

  // Bounded MRU of closed (paneId, file) for the "Reopen Closed Editor" command. Deduped by file so a
  // repeatedly closed file does not flood the stack; capped so it never grows unbounded.
  const pushClosedTab = useCallback((paneId: string, file: string): void => {
    if (file.length === 0) return;
    const next = closedTabsRef.current.filter((entry) => entry.file !== file);
    next.push({ paneId, file });
    closedTabsRef.current = next.slice(-CLOSED_TAB_HISTORY_LIMIT);
  }, []);

  const closeOpenFile = useCallback(
    async (paneId: string, path: string): Promise<boolean> =>
      requestDirtyClose({
        paneId,
        files: [path],
        reason: "tab-close",
        apply: () => {
          markDirty(paneId, path, false);
          pushClosedTab(paneId, path);
          commitLayout(
            editorLayoutReducer(layoutRef.current, { type: "close-tab", paneId, file: path }),
          );
        },
      }),
    [commitLayout, markDirty, pushClosedTab, requestDirtyClose],
  );

  const splitPane = useCallback(
    (paneId: string, direction: EditorSplitDirection): void => {
      const current = layoutRef.current;
      const pane = current.panes[paneId];
      if (pane === undefined || pane.activeFile.length === 0) return;
      const next = editorLayoutReducer(current, {
        type: "split-pane",
        paneId,
        direction,
        file: pane.activeFile,
      });
      if (next === current) return;
      commitLayout(next);
    },
    [commitLayout],
  );

  const closePane = useCallback(
    (paneId: string): void => {
      const pane = layoutRef.current.panes[paneId];
      if (pane === undefined) return;
      requestDirtyClose({
        paneId,
        files: pane.openFiles,
        reason: "pane-close",
        apply: () => {
          for (const file of pane.openFiles) pushClosedTab(paneId, file);
          setDirtyByPane((current) => {
            const { [paneId]: _removed, ...remaining } = current;
            return remaining;
          });
          commitLayout(editorLayoutReducer(layoutRef.current, { type: "close-pane", paneId }));
        },
      });
    },
    [commitLayout, pushClosedTab, requestDirtyClose],
  );

  const toggleSidebar = useCallback((): void => {
    commitLayout(
      editorLayoutReducer(layoutRef.current, {
        type: "set-sidebar",
        collapsed: !layoutRef.current.sidebarCollapsed,
      }),
    );
  }, [commitLayout]);

  const toggleOutlinePanel = useCallback((): void => {
    commitLayout(
      editorLayoutReducer(layoutRef.current, {
        type: "set-outline-panel",
        visible: !layoutRef.current.outlinePanelVisible,
      }),
    );
  }, [commitLayout]);

  const handleOutlineStateChange = useCallback(
    (paneId: string, snapshot: EditorOutlineSnapshot): void => {
      setOutlineByPane((current) => {
        if (sameEditorOutlineSnapshot(current[paneId], snapshot)) return current;
        return { ...current, [paneId]: snapshot };
      });
    },
    [],
  );

  const revealOutlineSymbol = useCallback((symbol: EditorDocumentSymbol): void => {
    const pane = activeEditorPane(layoutRef.current);
    if (pane.activeFile.length === 0) return;
    outlineRevealSeqRef.current += 1;
    setOutlineRevealByPane((current) => ({
      ...current,
      [pane.id]: {
        id: `outline:${pane.id}:${String(outlineRevealSeqRef.current)}`,
        file: pane.activeFile,
        range: symbol.range,
      },
    }));
  }, []);

  // Live-resize gesture state. During a pointer/mouse drag the split ratio or sidebar width is written
  // straight to the CSS variable on the DOM, and the final value is committed to layout state only on
  // release — so a drag is a pure style update with no per-frame React render or layout persistence
  // (the #1580 transform-during-gesture + persistence-debounce wins). Keyboard resize still commits
  // each discrete step immediately.
  const splitGestureRef = useRef<{ readonly splitId: string; readonly ratio: number } | null>(null);
  const sidebarGestureRef = useRef<number | null>(null);

  const previewSidebarWidth = useCallback((clientX: number): void => {
    const node = workspaceRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    const width = editorSidebarWidthFromPointer({
      clientX,
      rectLeft: rect.left,
      rectWidth: rect.width,
      logicalWorkspaceWidth: editorWorkspaceLogicalWidth(node, rect),
    });
    node.style.setProperty("--ed-sidebar-width", `${String(width)}px`);
    sidebarGestureRef.current = width;
  }, []);

  const commitSidebarGesture = useCallback((): void => {
    const width = sidebarGestureRef.current;
    sidebarGestureRef.current = null;
    if (width === null) return;
    commitLayout(
      editorLayoutReducer(layoutRef.current, { type: "set-sidebar", width, collapsed: false }),
    );
  }, [commitLayout]);

  const isTabDragActive = useCallback(
    (): boolean => pointerTabDragRef.current !== null || draggedTab !== null,
    [draggedTab],
  );

  const resizeSidebar = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      if (event.buttons !== 1) return;
      if (isTabDragActive()) return;
      previewSidebarWidth(event.clientX);
    },
    [isTabDragActive, previewSidebarWidth],
  );

  const resizeSidebarBy = useCallback(
    (delta: number): void => {
      const node = workspaceRef.current;
      const bounds =
        node === null
          ? {
              min: EDITOR_SIDEBAR_MIN_WIDTH,
              max: EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH,
            }
          : editorSidebarBounds(editorWorkspaceLogicalWidth(node));
      commitLayout(
        editorLayoutReducer(layoutRef.current, {
          type: "set-sidebar",
          width: clampNumber(layoutRef.current.sidebarWidth + delta, bounds.min, bounds.max),
          collapsed: false,
        }),
      );
    },
    [commitLayout],
  );

  const previewSplitRatio = useCallback(
    (split: EditorLayoutSplitNode, parent: HTMLElement, clientX: number, clientY: number): void => {
      const rect = parent.getBoundingClientRect();
      const raw =
        split.direction === "row"
          ? ((clientX - rect.left) / rect.width) * 100
          : ((clientY - rect.top) / rect.height) * 100;
      const ratio = clampNumber(raw, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);
      parent.style.setProperty("--ed-split-ratio", `${String(ratio)}%`);
      splitGestureRef.current = { splitId: split.id, ratio };
    },
    [],
  );

  const commitSplitGesture = useCallback((): void => {
    const gesture = splitGestureRef.current;
    splitGestureRef.current = null;
    if (gesture === null) return;
    commitLayout(
      editorLayoutReducer(layoutRef.current, {
        type: "resize-split",
        splitId: gesture.splitId,
        ratio: gesture.ratio,
      }),
    );
  }, [commitLayout]);

  const resizeSplitBy = useCallback(
    (split: EditorLayoutSplitNode, delta: number): void => {
      commitLayout(
        editorLayoutReducer(layoutRef.current, {
          type: "resize-split",
          splitId: split.id,
          ratio: clampNumber(split.ratio + delta, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO),
        }),
      );
    },
    [commitLayout],
  );

  const beginSidebarMouseResize = useCallback(
    (event: MouseEvent<HTMLElement>): void => {
      if (isTabDragActive()) return;
      event.preventDefault();
      const move = (moveEvent: globalThis.MouseEvent): void =>
        previewSidebarWidth(moveEvent.clientX);
      const up = (): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        commitSidebarGesture();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up, { once: true });
    },
    [commitSidebarGesture, isTabDragActive, previewSidebarWidth],
  );

  const beginSplitMouseResize = useCallback(
    (split: EditorLayoutSplitNode, event: MouseEvent<HTMLElement>): void => {
      if (isTabDragActive()) return;
      event.preventDefault();
      const parent = event.currentTarget.parentElement;
      if (parent === null) return;
      const move = (moveEvent: globalThis.MouseEvent): void =>
        previewSplitRatio(split, parent, moveEvent.clientX, moveEvent.clientY);
      const up = (): void => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        commitSplitGesture();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up, { once: true });
    },
    [commitSplitGesture, isTabDragActive, previewSplitRatio],
  );

  const handleSidebarResizerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      const step = event.shiftKey ? 32 : 12;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        resizeSidebarBy(-step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        resizeSidebarBy(step);
      }
    },
    [resizeSidebarBy],
  );

  const handleSplitResizerKeyDown = useCallback(
    (split: EditorLayoutSplitNode, event: KeyboardEvent<HTMLElement>): void => {
      const step = event.shiftKey ? 10 : 2;
      const decrementKey = split.direction === "row" ? "ArrowLeft" : "ArrowUp";
      const incrementKey = split.direction === "row" ? "ArrowRight" : "ArrowDown";
      if (event.key === decrementKey) {
        event.preventDefault();
        resizeSplitBy(split, -step);
      } else if (event.key === incrementKey) {
        event.preventDefault();
        resizeSplitBy(split, step);
      }
    },
    [resizeSplitBy],
  );

  const capturePointer = useCallback((event: PointerEvent<HTMLElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const releasePointer = useCallback((event: PointerEvent<HTMLElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // Move DOM focus to the roving tab button for (paneId, file) so document.activeElement follows the
  // active tab after keyboard navigation (WCAG APG tablist: focus and selection stay together for
  // automatic activation). The button still carries tabIndex=-1 at this instant — selectOpenFile
  // re-renders it to tabIndex=0 on the next commit — but a programmatic .focus() works regardless.
  const focusTabButton = useCallback((paneId: string, file: string): void => {
    const escapeAttr = (value: string): string =>
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(value)
        : value.replace(/["\\]/g, String.raw`\$&`);
    const selector = `[role="tab"][data-pane-id="${escapeAttr(paneId)}"][data-tab-file="${escapeAttr(file)}"]`;
    const focus = (): boolean => {
      const button = document.querySelector<HTMLElement>(selector);
      button?.focus();
      return button !== null;
    };
    // Focus synchronously for the common case (target tab already rendered). If the target was in the
    // overflow menu and is not yet a visible tab, selectOpenFile's re-render scrolls it into view — so
    // retry once after paint so keyboard focus still lands on it.
    if (!focus() && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        focus();
      });
    }
  }, []);

  const handleTabKeyDown = useCallback(
    (paneId: string, path: string, event: KeyboardEvent<HTMLButtonElement>): void => {
      const pane = layoutRef.current.panes[paneId];
      if (pane === undefined) return;
      // Alt-less navigation roams the roving tab-stop; Alt+Arrow reorders/moves the tab across
      // panes (handleRovingTabKey / handleAltArrowTabKey, GEN-MAINT-COMPLEXITY-002).
      if (!event.altKey) {
        handleRovingTabKey(paneId, path, pane.tabOrder, event, selectOpenFile, focusTabButton);
        return;
      }
      handleAltArrowTabKey(paneId, path, pane, event, layoutRef.current, commitLayout);
    },
    [commitLayout, focusTabButton, selectOpenFile],
  );

  const beginTabPointerDrag = useCallback(
    (
      paneId: string,
      path: string,
      event: PointerEvent<HTMLButtonElement>,
      onDragModeStart?: (() => void) | undefined,
    ): void => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      let releaseBodyStyle: (() => void) | null = null;
      const clearDragFeedback = (): void => {
        releaseBodyStyle?.();
        releaseBodyStyle = null;
        setHeldTab(null);
        setDraggedTab(null);
        setTabDragPosition(null);
        setTabDropTargetPaneId(null);
        setTabInsertTarget(null);
      };
      const tabRect = event.currentTarget.getBoundingClientRect();
      pointerTabDragRef.current = {
        paneId,
        file: path,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - tabRect.left,
        offsetY: event.clientY - tabRect.top,
        width: tabRect.width,
        dragging: false,
      };
      setHeldTab({ paneId, file: path });
      // GEN-PERF-EDITOR-003 — raw pointermove fires at up to 120-240Hz; resolving the
      // insertion target does a tab-node querySelectorAll plus one getBoundingClientRect
      // per open tab plus an elementFromPoint (each a forced layout), and then three
      // state commits. Buffer the latest pointer and run that work at most once per
      // animation frame (last-event-wins), the same pattern as WindowFrame's drag and
      // workspaceActions' connect gesture. The drag ACTIVATION (threshold crossing)
      // stays synchronous so grab feedback is not delayed by a frame.
      let lastMoveX = 0;
      let lastMoveY = 0;
      let moveFrame: number | null = null;
      const applyMove = (): void => {
        moveFrame = null;
        const drag = pointerTabDragRef.current;
        if (!drag?.dragging) return;
        const insertTarget = tabInsertionTargetFromPoint(
          drag,
          lastMoveX,
          lastMoveY,
          layoutRef.current,
        );
        const targetPaneId = paneIdFromPoint(lastMoveX, lastMoveY);
        setTabDragPosition({
          x: lastMoveX - drag.offsetX,
          y: lastMoveY - drag.offsetY,
          width: drag.width,
        });
        setTabInsertTarget(insertTarget);
        setTabDropTargetPaneId(
          insertTarget === null && targetPaneId !== null && targetPaneId !== drag.paneId
            ? targetPaneId
            : null,
        );
      };
      const move = (moveEvent: globalThis.PointerEvent): void => {
        const drag = pointerTabDragRef.current;
        if (drag === null) return;
        const distance = Math.hypot(
          moveEvent.clientX - drag.startX,
          moveEvent.clientY - drag.startY,
        );
        if (!drag.dragging && distance < TAB_POINTER_DRAG_THRESHOLD_PX) return;
        if (!drag.dragging) {
          drag.dragging = true;
          suppressNextTabClickRef.current = { paneId: drag.paneId, file: drag.file };
          releaseBodyStyle = acquireGrabbingBodyStyle();
          onDragModeStart?.();
          setDraggedTab({ paneId: drag.paneId, file: drag.file });
        }
        lastMoveX = moveEvent.clientX;
        lastMoveY = moveEvent.clientY;
        moveFrame ??= requestAnimationFrame(applyMove);
        moveEvent.preventDefault();
      };
      const cleanup = (): void => {
        if (moveFrame !== null) {
          cancelAnimationFrame(moveFrame);
          moveFrame = null;
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      const cancel = (): void => {
        cleanup();
        pointerTabDragRef.current = null;
        suppressNextTabClickRef.current = null;
        clearDragFeedback();
      };
      const up = (upEvent: globalThis.PointerEvent): void => {
        cleanup();
        const drag = pointerTabDragRef.current;
        const insertTarget =
          drag === null
            ? null
            : (tabInsertionTargetFromPoint(
                drag,
                upEvent.clientX,
                upEvent.clientY,
                layoutRef.current,
              ) ?? tabInsertTargetRef.current);
        pointerTabDragRef.current = null;
        clearDragFeedback();
        if (!drag?.dragging) return;
        upEvent.preventDefault();
        window.setTimeout(() => {
          suppressNextTabClickRef.current = null;
        }, 0);
        if (insertTarget !== null) {
          commitLayout(
            editorLayoutReducer(
              layoutRef.current,
              insertTarget.paneId === drag.paneId
                ? {
                    type: "reorder-tab",
                    paneId: drag.paneId,
                    file: drag.file,
                    targetIndex: insertTarget.targetIndex,
                  }
                : {
                    type: "move-tab",
                    fromPaneId: drag.paneId,
                    toPaneId: insertTarget.paneId,
                    file: drag.file,
                    targetIndex: insertTarget.targetIndex,
                  },
            ),
          );
          return;
        }
        const targetPaneId = paneIdFromPoint(upEvent.clientX, upEvent.clientY);
        if (targetPaneId === null || targetPaneId === drag.paneId) return;
        commitLayout(
          editorLayoutReducer(layoutRef.current, {
            type: "move-tab",
            fromPaneId: drag.paneId,
            toPaneId: targetPaneId,
            file: drag.file,
          }),
        );
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", cancel, { once: true });
    },
    [commitLayout, setTabInsertTarget],
  );

  const suppressTabClickAfterPointerDrag = useCallback(
    (paneId: string, path: string, event: MouseEvent<HTMLButtonElement>): void => {
      const suppressedTab = suppressNextTabClickRef.current;
      if (suppressedTab?.paneId !== paneId || suppressedTab.file !== path) {
        return;
      }
      suppressNextTabClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const dropTab = useCallback(
    (paneId: string, zone: EditorSplitDropZone, event: DragEvent<HTMLElement>): void => {
      event.preventDefault();
      const dragged = draggedTab ?? draggedTabFromEvent(event);
      if (dragged === null) return;
      const paneCount = editorLayoutPaneIds(layoutRef.current).length;
      const effectiveZone =
        zone !== "center" && paneCount >= MAX_EDITOR_PANES && dragged.paneId !== paneId
          ? "center"
          : zone;
      if (effectiveZone !== "center" && paneCount >= MAX_EDITOR_PANES) {
        setDraggedTab(null);
        return;
      }
      commitLayout(
        editorLayoutReducer(layoutRef.current, {
          type: "drop-tab",
          intent: {
            fromPaneId: dragged.paneId,
            toPaneId: paneId,
            file: dragged.file,
            zone: effectiveZone,
          },
        }),
      );
      setDraggedTab(null);
    },
    [commitLayout, draggedTab],
  );

  // Stable cross-pane tab move (used by the per-pane binding so it does not churn on every render).
  const moveTabAction = useCallback(
    (fromPaneId: string, toPaneId: string, file: string): void => {
      commitLayout(
        editorLayoutReducer(layoutRef.current, { type: "move-tab", fromPaneId, toPaneId, file }),
      );
    },
    [commitLayout],
  );

  // ── Command/keybinding/palette actions (Wave 2 items 2.3/2.4/2.5) ──────────────────────────────
  // All read the live layout from `layoutRef`, so they act on the active pane regardless of where
  // focus is, and route through the existing close/select/split/save callbacks.
  const closeActiveTab = useCallback((): void => {
    const pane = activeEditorPane(layoutRef.current);
    if (pane.activeFile.length > 0) void closeOpenFile(pane.id, pane.activeFile);
  }, [closeOpenFile]);

  const cycleActiveTab = useCallback(
    (delta: number): void => {
      const pane = activeEditorPane(layoutRef.current);
      const order = pane.tabOrder;
      if (order.length < 2) return;
      const index = order.indexOf(pane.activeFile);
      const next = order[(index + delta + order.length) % order.length];
      if (next !== undefined) selectOpenFile(pane.id, next);
    },
    [selectOpenFile],
  );

  const reopenClosedTab = useCallback((): void => {
    const last = closedTabsRef.current.pop();
    if (last !== undefined) openFile(workspaceRoot, last.file);
  }, [openFile, workspaceRoot]);

  const saveAllDirty = useCallback((): void => {
    for (const [paneId, files] of Object.entries(dirtyByPane)) {
      for (const file of Object.keys(files)) void requestExternalSave(paneId, file);
    }
  }, [dirtyByPane, requestExternalSave]);

  const splitActivePane = useCallback(
    (direction: EditorSplitDirection): void =>
      splitPane(activeEditorPane(layoutRef.current).id, direction),
    [splitPane],
  );

  const closeActivePane = useCallback(
    (): void => closePane(activeEditorPane(layoutRef.current).id),
    [closePane],
  );

  const nextTab = useCallback((): void => cycleActiveTab(1), [cycleActiveTab]);
  const prevTab = useCallback((): void => cycleActiveTab(-1), [cycleActiveTab]);

  const openActiveFileHistory = useCallback((): void => {
    const pane = activeEditorPane(layoutRef.current);
    if (pane.activeFile.length === 0) return;
    fileHistoryRequestSeqRef.current += 1;
    setFileHistoryRequest({ paneId: pane.id, nonce: fileHistoryRequestSeqRef.current });
  }, []);

  // Issue #2212 (ADR-0126) — run-affordance state + actions through the governed verification route.
  const verification = useEditorVerificationRun({
    root: workspaceRoot,
    activeFile: activeFile.length > 0 ? activeFile : null,
  });

  // The initial prompt answers one question — "this binding is opening on an untrusted root" — and
  // it is answered once per binding. The latch used to be taken only when the FIRST resolved state
  // was `restricted`, so opening on a trusted root left it unconsumed: a later explicit revocation
  // by the human moved trust to `restricted` and re-raised the first-open prompt, asking them to
  // grant what they had just deliberately revoked, and labelling it `initialPrompt`. Consuming the
  // latch on the first resolved state whatever it says keeps the prompt for a genuine untrusted
  // open and keeps a revoke a revoke.
  useEffect(() => {
    const decision = initialTrustLatchDecision(
      verification.catalog?.workspaceTrust,
      promptedTrustRoot,
      workspaceRoot,
    );
    if (decision === "skip") return;
    setPromptedTrustRoot(workspaceRoot);
    if (decision === "latch-and-prompt" && workspaceTrustUiAvailable) {
      setTrustDecision({ action: "grant", initialPrompt: true, root: workspaceRoot });
    }
  }, [
    promptedTrustRoot,
    verification.catalog?.workspaceTrust,
    workspaceRoot,
    workspaceTrustUiAvailable,
  ]);

  useEffect(() => {
    if (workspaceTrustUiAvailable) return;
    setTrustDecision(null);
    setTrustMutationIssue(undefined);
  }, [workspaceTrustUiAvailable]);

  const confirmTrustDecision = useCallback(async (): Promise<boolean> => {
    if (trustDecision === null || trustMutationPending) return false;
    // Root-drift guard: if a root switch raced this confirm handler, the
    // dialog was opened for a different root than `verification` now targets.
    // Refuse and fail closed rather than mutate trust on the wrong root.
    if (trustDecision.root !== workspaceRoot) {
      setTrustDecision(null);
      setTrustMutationIssue(undefined);
      return false;
    }
    setTrustMutationPending(true);
    try {
      const confirmed = await (trustDecision.action === "grant"
        ? verification.trustWorkspaceScripts()
        : verification.revokeWorkspaceScriptTrust());
      if (confirmed) {
        setTrustDecision(null);
        setTrustMutationIssue(undefined);
      } else {
        setTrustMutationIssue("update");
      }
      return confirmed;
    } finally {
      setTrustMutationPending(false);
    }
  }, [trustDecision, trustMutationPending, verification, workspaceRoot]);

  // Content-free host snapshot consumed by the palette + keybinding layer. Memoized so the command
  // palette does not receive a new object on unrelated editor chrome renders.
  const commandHost: EditorPaletteHost = useMemo(
    () => ({
      root: workspaceRoot,
      activePaneId: layout.activePaneId,
      paneCount: editorLayoutPaneIds(layout).length,
      activeFile: activeFile.length > 0 ? activeFile : null,
      closedTabCount: closedTabsRef.current.length,
      dirtyCount: dirtyFileList.length,
      verificationRunning: verification.verificationRunning,
      verifiableTarget: verification.verifiableTarget,
      verificationCatalog: verification.catalog,
      workspaceTrustUiAvailable,
      splitActive: splitActivePane,
      closeActiveSplit: closeActivePane,
      closeActiveTab,
      nextTab,
      prevTab,
      reopenClosed: reopenClosedTab,
      saveAll: saveAllDirty,
      runFileTests: verification.runFileTests,
      runWorkspaceVerification: verification.runWorkspaceVerification,
      cancelVerification: verification.cancelVerification,
      trustWorkspaceScripts: () =>
        setTrustDecision({ action: "grant", initialPrompt: false, root: workspaceRoot }),
      revokeWorkspaceScriptTrust: () =>
        setTrustDecision({ action: "revoke", initialPrompt: false, root: workspaceRoot }),
      openProblems: () => onOpenProblems?.(workspaceRoot),
      openFileHistory: openActiveFileHistory,
      openDebugPanel: () => onOpenDebugPanel?.(),
    }),
    [
      activeFile,
      closeActivePane,
      closeActiveTab,
      dirtyFileList.length,
      layout,
      nextTab,
      onOpenProblems,
      onOpenDebugPanel,
      openActiveFileHistory,
      prevTab,
      reopenClosedTab,
      saveAllDirty,
      splitActivePane,
      verification.cancelVerification,
      verification.catalog,
      verification.runFileTests,
      verification.runWorkspaceVerification,
      verification.verifiableTarget,
      verification.verificationRunning,
      workspaceRoot,
      workspaceTrustUiAvailable,
    ],
  );
  const commandHostRef = useRef(commandHost);
  commandHostRef.current = commandHost;
  useRegisterEditorPaletteHost(windowId, commandHost);
  const quickAccessTrigger = useEditorQuickAccessTrigger();
  const quickAccessTriggerRef = useRef(quickAccessTrigger);
  quickAccessTriggerRef.current = quickAccessTrigger;

  // Container-level capturing keydown for editor-chrome chords (mirrors the on-mount save backstop,
  // but scoped to the whole editor so it also fires from the sidebar/tab strip). Only browser-safe
  // chords are bound — Cmd/Ctrl+W and Cmd/Ctrl+Shift+T are reserved and intentionally omitted.
  useEffect(() => {
    const node = workspaceRef.current;
    if (node === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const commandId = editorShortcutCommandId(editorShortcutRegistryRef.current, event);
      if (commandId === null) return;
      const dispatched = dispatchEditorShortcut(
        commandId,
        commandHostRef.current,
        quickAccessTriggerRef.current,
      );
      if (dispatched) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    node.addEventListener("keydown", onKeyDown, true);
    return () => node.removeEventListener("keydown", onKeyDown, true);
  }, [workspaceRoot]);

  // Agent-pane snapshots, memoized by the pane SET. A split resize only changes a tree node's ratio,
  // leaving `layout.panes` untouched, so this stays referentially stable across a resize and does not
  // churn the per-pane editor-host props.
  const layoutPaneSnapshots = useMemo<readonly EditorAgentPaneSnapshot[]>(
    () =>
      Object.values(layout.panes).map((entry) => ({
        paneId: entry.id,
        activeFile: entry.activeFile.length > 0 ? entry.activeFile : null,
        openFiles: entry.openFiles,
      })),
    [layout.panes],
  );

  const paneCount = editorLayoutPaneIds(layout).length;

  // Per-pane bound callbacks + split-control chrome + tab-drag handle, memoized by the pane set (and
  // the now-stable underlying callbacks). A layout mutation that does not touch a given pane keeps its
  // binding referentially identical, so the `React.memo`-wrapped editor host bails out of the
  // re-render — the #1580 fan-out fix applied to editor panes.
  const paneBindings = useMemo(() => {
    const map = new Map<string, PaneBinding>();
    for (const pane of Object.values(layout.panes)) {
      const paneId = pane.id;
      map.set(paneId, {
        onSelectOpenFile: (file: string) => selectOpenFile(paneId, file),
        onCloseOpenFile: (path: string) => closeOpenFile(paneId, path),
        onDirtyChange: (path: string, dirty: boolean) => markDirty(paneId, path, dirty),
        onMoveTab: (fromPaneId: string, file: string, toPaneId: string) =>
          moveTabAction(fromPaneId, toPaneId, file),
        onSplitPane: (targetPaneId: string, direction: "row" | "column") =>
          splitPane(targetPaneId, direction),
        onAgentChangesetCommitted: (entries) => queueAgentReconciliation(paneId, entries),
        toolbarExtras: renderPaneActions(pane, paneCount > 1, splitPane, closePane),
        // GEN-PERF-EDITOR-003 — the full drag-capable tab handle lives HERE (in the
        // pane-memoized closure) instead of as a per-render inline closure in renderPane,
        // so its identity is stable and does not defeat React.memo(EditorRuntimeWidget).
        // The "held" flag is read from heldTabRef at call time (not closed over as state).
        renderTabHandle: (path, active, tabDirty, context) => ({
          draggable: false,
          onDragStart: (event: DragEvent<HTMLButtonElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", path);
            event.dataTransfer.setData(
              EDITOR_TAB_DRAG_MIME,
              JSON.stringify({ paneId, file: path }),
            );
            context?.onDragModeStart?.();
            setDraggedTab({ paneId, file: path });
          },
          onDragEnd: () => setDraggedTab(null),
          onPointerDown: (event: PointerEvent<HTMLButtonElement>) =>
            beginTabPointerDrag(paneId, path, event, context?.onDragModeStart),
          onClickCapture: (event: MouseEvent<HTMLButtonElement>) =>
            suppressTabClickAfterPointerDrag(paneId, path, event),
          onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
            handleTabKeyDown(paneId, path, event),
          "data-active": active ? "true" : "false",
          "data-dirty": tabDirty ? "true" : "false",
          "data-pane-id": paneId,
          "data-tab-file": path,
          "data-tab-draggable": "true",
          "data-tab-held":
            heldTabRef.current?.paneId === paneId && heldTabRef.current.file === path
              ? "true"
              : "false",
          "data-merge-conflicts": String(context?.mergeConflicts ?? 0),
        }),
      });
    }
    return map;
  }, [
    layout.panes,
    paneCount,
    selectOpenFile,
    closeOpenFile,
    markDirty,
    moveTabAction,
    splitPane,
    queueAgentReconciliation,
    closePane,
    handleTabKeyDown,
    beginTabPointerDrag,
    suppressTabClickAfterPointerDrag,
  ]);

  if (workspaceRoot.length === 0) {
    // Unbound editor (opened without a project root, e.g. toggled from the left rail): offer the
    // native OS folder picker so the user can choose a project and start working (ADR-0118).
    return (
      <EditorEmptyState onOpenRoot={openRoot} onWorkspaceNotice={setWorkspaceRegistrationNotice} />
    );
  }

  const renderPane = (pane: EditorPaneStateV2): ReactNode => {
    const binding = paneBindings.get(pane.id);
    if (binding === undefined) return null;
    const runtimeProps: EditorRuntimeWidgetProps = {
      ...props,
      ...paneLineRevealProps(addressedRevealFile, pane.activeFile),
      sessionActive,
      root: workspaceRoot,
      ...(pane.activeFile.length > 0 ? { file: pane.activeFile } : {}),
      openFiles: pane.openFiles,
      dirtyFiles: dirtyFileList,
      windowId: `${windowId ?? "editor"}-${pane.id}`,
      paneId: pane.id,
      layoutPanes: layoutPaneSnapshots,
      activePaneId: layout.activePaneId,
      onSelectOpenFile: binding.onSelectOpenFile,
      onSplitPane: binding.onSplitPane,
      onMoveTab: binding.onMoveTab,
      onCloseOpenFile: binding.onCloseOpenFile,
      onDirtyChange: binding.onDirtyChange,
      toolbarExtras: binding.toolbarExtras,
      externalSaveRequest:
        saveRequest !== null && saveRequest.paneId === pane.id ? saveRequest : undefined,
      onExternalSaveComplete,
      agentReconciliationRequest: agentReconciliationQueues[pane.id]?.[0],
      onAgentChangesetCommitted: binding.onAgentChangesetCommitted,
      onAgentReconciliationComplete: completeAgentReconciliation,
      tabInsertTarget:
        tabInsertTargetState?.paneId === pane.id
          ? { file: tabInsertTargetState.file, edge: tabInsertTargetState.edge }
          : undefined,
      renderTabHandle: binding.renderTabHandle,
      onOpenDebugPanel,
      onOutlineStateChange: handleOutlineStateChange,
      outlineRevealRequest: outlineRevealByPane[pane.id],
      fileHistoryRequestNonce:
        fileHistoryRequest?.paneId === pane.id ? fileHistoryRequest.nonce : undefined,
      // GEN-PERF-EDITOR-003 — a per-pane scalar that changes only for the pane whose tab is
      // held, so a hold-state change re-renders just that pane (its stable renderTabHandle
      // re-reads the held flag) while other panes stay memo-bailed.
      heldTabFile: heldTab?.paneId === pane.id ? heldTab.file : undefined,
    };
    return (
      <section
        className="ed-pane"
        data-active={pane.id === layout.activePaneId ? "true" : "false"}
        data-dragging={draggedTab === null ? "false" : "true"}
        data-tab-drop-target={tabDropTargetPaneId === pane.id ? "true" : "false"}
        data-pane-id={pane.id}
        key={pane.id}
        onPointerDownCapture={() => activatePane(pane.id)}
        onFocusCapture={() => activatePane(pane.id)}
      >
        <div className="ed-pane-drop-zones" aria-hidden="true">
          {(["left", "right", "top", "bottom", "center"] as const).map((zone) => (
            <button
              type="button"
              className={`ed-pane-drop-zone ${zone}`}
              key={zone}
              tabIndex={-1}
              aria-label={`Drop tab ${zone}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropTab(pane.id, zone, event)}
            />
          ))}
        </div>
        <EditorRuntimeWidget {...runtimeProps} />
      </section>
    );
  };

  const renderNode = (node: EditorLayoutNode): ReactNode => {
    if (node.type === "pane") {
      const pane = layout.panes[node.paneId];
      return pane === undefined ? null : renderPane(pane);
    }
    return (
      <div
        className={`ed-panes ${node.direction}`}
        data-split-id={node.id}
        style={{ "--ed-split-ratio": `${String(node.ratio)}%` } as CSSProperties}
      >
        {renderNode(node.first)}
        {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA window-splitter pattern: focusable role=separator exposes keyboard resizing through aria-valuenow. */}
        <hr
          tabIndex={0}
          className={splitResizerClassName(node.direction)}
          aria-label="Resize editor split"
          aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
          aria-valuemin={MIN_SPLIT_RATIO}
          aria-valuemax={MAX_SPLIT_RATIO}
          aria-valuenow={Math.round(node.ratio)}
          onPointerDown={(event) => {
            if (isTabDragActive()) return;
            capturePointer(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return;
            if (isTabDragActive()) return;
            const parent = event.currentTarget.parentElement;
            if (parent !== null) {
              previewSplitRatio(node, parent, event.clientX, event.clientY);
            }
          }}
          onPointerUp={(event) => {
            releasePointer(event);
            commitSplitGesture();
          }}
          onPointerCancel={(event) => {
            releasePointer(event);
            commitSplitGesture();
          }}
          onMouseDown={(event) => beginSplitMouseResize(node, event)}
          onKeyDown={(event) => handleSplitResizerKeyDown(node, event)}
        />
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        {renderNode(node.second)}
      </div>
    );
  };

  const singlePane = paneCount === 1;
  const activeOutlineSnapshot =
    outlineByPane[currentPane.id] ??
    ({
      ...(activeFile.length > 0 ? { filePath: activeFile } : {}),
      symbols: [],
      cursor: null,
      enabled: activeFile.length > 0,
      loading: false,
    } satisfies EditorOutlineSnapshot);

  const trustSettled = resolveTrustSettledAttribute(verification, promptedTrustRoot, workspaceRoot);

  return (
    <div
      className={`editor-workspace${layout.sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      data-tab-dragging={draggedTab === null ? "false" : "true"}
      data-pane-count={paneCount}
      data-trust-settled={trustSettled}
      ref={workspaceRef}
      style={
        { "--ed-sidebar-width": editorSidebarTrackWidth(layout.sidebarWidth) } as CSSProperties
      }
    >
      {layout.sidebarCollapsed ? (
        <button
          type="button"
          className="ed-sidebar-restore ui-tip"
          aria-label="Show project tree"
          data-tip="Show project tree"
          onClick={toggleSidebar}
        >
          <SidebarIcon size={15} />
        </button>
      ) : (
        <>
          <aside className="ed-sidebar" aria-label="Editor files">
            <div className="ed-sidebar-chrome">
              <button
                type="button"
                className="ed-icon-action ui-tip"
                aria-label="Hide project tree"
                data-tip="Hide project tree"
                onClick={toggleSidebar}
              >
                <SidebarIcon size={14} />
              </button>
            </div>
            <EditorOutlinePanel
              snapshot={activeOutlineSnapshot}
              visible={layout.outlinePanelVisible}
              onToggleVisible={toggleOutlinePanel}
              onReveal={revealOutlineSymbol}
            />
            <FilesWidget
              root={workspaceRoot}
              activeFilePath={activeFile.length > 0 ? activeFile : undefined}
              openFilesDirectly
              onRootChange={openRoot}
              onOpenFile={openFile}
              onFilesMutated={handleFilesMutated}
              onBeforeEntryMutation={confirmFilesEntryMutation}
            />
          </aside>
          {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA window-splitter pattern: focusable role=separator exposes keyboard resizing through aria-valuenow. */}
          <hr
            tabIndex={0}
            className="ed-sidebar-resizer"
            aria-label="Resize project tree"
            aria-orientation="vertical"
            aria-valuemin={EDITOR_SIDEBAR_MIN_WIDTH}
            aria-valuemax={EDITOR_SIDEBAR_PERSISTED_MAX_WIDTH}
            aria-valuenow={Math.round(layout.sidebarWidth)}
            onPointerDown={(event) => {
              if (isTabDragActive()) return;
              capturePointer(event);
            }}
            onPointerMove={resizeSidebar}
            onPointerUp={(event) => {
              releasePointer(event);
              commitSidebarGesture();
            }}
            onPointerCancel={(event) => {
              releasePointer(event);
              commitSidebarGesture();
            }}
            onMouseDown={beginSidebarMouseResize}
            onKeyDown={handleSidebarResizerKeyDown}
          />
          {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        </>
      )}
      <div className={`ed-main ${trustStyles.cmpEditorMain}`}>
        <WorkspaceRegistrationNotice
          notice={workspaceRegistrationNotice}
          workspaceRoot={workspaceRoot}
        />
        {workspaceTrustUiAvailable ? (
          <WorkspaceTrustBanner
            status={verification.catalog?.workspaceTrust}
            // `catalog === null` alone is not a failed read: it is also the state before the first
            // read returns, and the state right after a root switch resets it. Treating it as "load"
            // made the banner assert "Workspace Trust could not be read safely" on every editor
            // open — including for a fully trusted root, where it then vanished — which is the
            // opposite of the #2625 requirement that a read FAILURE be distinguishable from every
            // other state. `catalogSettled` is the fact that separates them: it turns true only once
            // the read has resolved or definitively failed.
            issue={trustBannerIssue(trustMutationIssue, verification)}
            surface="editor"
            onManage={onOpenWorkspaceTrust}
            editor
          />
        ) : null}
        <div
          className={`ed-panes ed-panes-root ${trustStyles.cmpEditorPanes}${
            singlePane ? " single" : ""
          }`}
        >
          {renderNode(layout.tree)}
        </div>
      </div>
      {draggedTab !== null && tabDragPosition !== null && typeof document !== "undefined"
        ? createPortal(
            <div
              className="ed-tab-drag-ghost mono"
              style={
                {
                  "--ed-tab-drag-x": `${String(tabDragPosition.x)}px`,
                  "--ed-tab-drag-y": `${String(tabDragPosition.y)}px`,
                  "--ed-tab-drag-width": `${String(tabDragPosition.width)}px`,
                } as CSSProperties
              }
              aria-hidden="true"
            >
              <FileIcon name={draggedTab.file} />
              <span className="ed-tab-drag-ghost-label">{draggedTab.file}</span>
              <span className="ed-tab-drag-ghost-close">×</span>
            </div>,
            document.body,
          )
        : null}
      {pendingClose !== null ? (
        <DirtyCloseDialog
          pending={pendingClose}
          onSave={savePendingClose}
          onDiscard={discardPendingClose}
          onCancel={cancelPendingClose}
        />
      ) : null}
      {workspaceTrustUiAvailable && trustDecision !== null && pendingClose === null ? (
        <WorkspaceTrustDecisionDialog
          action={trustDecision.action}
          initialPrompt={trustDecision.initialPrompt}
          mutating={trustMutationPending}
          onCancel={() => setTrustDecision(null)}
          onConfirm={confirmTrustDecision}
        />
      ) : null}
    </div>
  );
}
