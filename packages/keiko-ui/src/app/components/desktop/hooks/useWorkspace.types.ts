import type { PointerEvent as ReactPointerEvent } from "react";
import type { SnapZone } from "../windows/connectionUtils";
import type { WindowType } from "../windows/WindowsRegistry";
import type { AppWindow, Connection, ConnectingState, SnapPrev, View } from "../windows/types";
import type { ChatConnectedScope } from "@/lib/types";
import type {
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceImageSource,
  WorkspaceUiSelectionState,
} from "@oscharko-dev/keiko-contracts";

export interface ViewportWorld {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FilesWindowContext {
  readonly id: string;
  readonly root: string;
  readonly activeFilePath?: string;
}

export interface OpenEditorFileRequest {
  readonly root: string;
  readonly path: string;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
}

export interface ChatBindingTarget {
  readonly conversationId: string | undefined;
  readonly projectPath: string | undefined;
  readonly isCurrent: () => boolean;
}

export interface ChatUnbindTarget {
  readonly conversationId: string;
  readonly projectPath: string | undefined;
}

export type OpenEditorFileResult =
  | { readonly ok: true; readonly windowId: string }
  | { readonly ok: false; readonly message: string };

// Issue #2150 follow-up — copy/cut/paste report counts so the workspace can
// announce the outcome (ADR-0123 D5 requires skipped windows to carry a
// documented reason; a silent no-op is not one). `captured` is the number of
// windows the clipboard took (for cut: also closed); `skipped` is the number of
// selected windows that cannot be duplicated (singleton/keyed/minimized/
// maximized descriptors); `overflow` is the number of duplicable windows that
// only exceeded the clipboard's per-copy cap — a different reason that must not
// be announced as "not duplicable".
export interface WorkspaceClipboardCaptureResult {
  readonly captured: number;
  readonly skipped: number;
  readonly overflow: number;
}

interface WorkspaceClipboardPasteResult {
  readonly pasted: number;
  readonly limitReached: boolean;
}

export interface WorkspaceApi {
  readonly add: (type: WindowType, cfg?: AppWindow["cfg"]) => string | null;
  readonly openEditorFile: (request: OpenEditorFileRequest) => OpenEditorFileResult;
  readonly toggleTool: (type: WindowType) => void;
  readonly focus: (id: string) => void;
  readonly currentWindowStack?: (() => readonly string[]) | undefined;
  readonly currentSelection: () => WorkspaceUiSelectionState;
  readonly replaceSelection: (windowIds: readonly string[]) => void;
  readonly toggleWindowSelection: (windowId: string) => void;
  readonly clearSelection: () => void;
  readonly moveSelectedWindowsBy: (
    dx: number,
    dy: number,
  ) => { readonly dx: number; readonly dy: number };
  readonly copySelectedWindows: () => WorkspaceClipboardCaptureResult;
  readonly cutSelectedWindows: () => WorkspaceClipboardCaptureResult;
  readonly pasteCopiedWindows: () => WorkspaceClipboardPasteResult;
  readonly close: (id: string) => void;
  readonly minimize: (id: string) => void;
  readonly restore: (id: string) => void;
  readonly maximize: (id: string) => void;
  readonly update: (id: string, patch: Partial<AppWindow>) => void;
  readonly setSnap: (zone: SnapZone | null) => void;
  readonly commitSnap: (id: string) => void;
  readonly tileAll: () => void;
  readonly splitFront: () => void;
  readonly cascade: () => void;
  readonly startConnect: (fromId: string, e: ReactPointerEvent<Element>) => void;
  readonly confirmConnect: (toId: string, e: ReactPointerEvent<Element>) => void;
  readonly cancelConnect: () => void;
  readonly removeConn: (connId: string, options?: { readonly unbind?: boolean }) => void;
  readonly updateConnBoundScope: (connId: string, scope: ChatConnectedScope) => void;
  readonly connect: (a: string, b: string) => void;
  readonly linkedFilesRoot: (id: string) => string | null;
  readonly linkedFilesContext: (id: string) => FilesWindowContext | null;
  readonly linkedAllFilesRoots: (id: string) => readonly string[];
  readonly linkedConnectorCapsuleIds: (id: string) => readonly string[];
  readonly linkedConnectorCapsuleSetIds: (id: string) => readonly string[];
  /** Epic #750 #756 — snapshot run ids from connected Figma Snapshot windows. */
  readonly linkedFigmaSnapshotRunIds: (id: string) => readonly string[];
  /** Figma Snapshot sources, optionally scoped to selected screen ids. */
  readonly linkedFigmaSnapshotSources?:
    ((id: string) => readonly QualityIntelligenceFigmaSnapshotSource[]) | undefined;
  /** Image-only sources from connected Figma Image windows. */
  readonly linkedImageSources?:
    ((id: string) => readonly QualityIntelligenceImageSource[]) | undefined;
  readonly currentFilesContext: () => FilesWindowContext | null;
  /**
   * Live snapshot of the pan/zoom view, read through a ref so window children can
   * compute drag/resize geometry at gesture-start WITHOUT taking `view` as a prop
   * (which changes identity every rAF pan/zoom frame and would defeat memoization
   * of WindowFrame). Mirrors the existing `rect()` accessor (issue #1580).
   */
  readonly currentView: () => View;
  readonly zoomTo: (z: number) => void;
  readonly fitView: () => void;
  readonly resetView: () => void;
  readonly panBy: (dx: number, dy: number) => void;
  readonly rect: () => DOMRect | null;
}

export interface UseWorkspaceResult {
  readonly wins: AppWindow[] | null;
  readonly winsById: ReadonlyMap<string, AppWindow>;
  readonly snapPrev: SnapPrev | null;
  readonly palOpen: boolean;
  readonly setPalOpen: (open: boolean) => void;
  readonly conns: Connection[];
  readonly connecting: ConnectingState | null;
  readonly selection: WorkspaceUiSelectionState;
  readonly view: View;
  readonly api: WorkspaceApi;
}
