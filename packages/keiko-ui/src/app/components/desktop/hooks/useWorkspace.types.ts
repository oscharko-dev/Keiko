import type { PointerEvent as ReactPointerEvent } from "react";
import type { SnapZone } from "../windows/connectionUtils";
import type { WindowType } from "../windows/WindowsRegistry";
import type { AppWindow, Connection, ConnectingState, SnapPrev, View } from "../windows/types";

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

export interface WorkspaceApi {
  readonly add: (type: WindowType, cfg?: AppWindow["cfg"]) => string | null;
  readonly toggleTool: (type: WindowType) => void;
  readonly focus: (id: string) => void;
  readonly close: (id: string) => void;
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
  readonly removeConn: (connId: string) => void;
  readonly connect: (a: string, b: string) => void;
  readonly linkedFilesRoot: (id: string) => string | null;
  readonly linkedFilesContext: (id: string) => FilesWindowContext | null;
  readonly linkedAllFilesRoots: (id: string) => readonly string[];
  readonly linkedConnectorCapsuleIds: (id: string) => readonly string[];
  readonly currentFilesContext: () => FilesWindowContext | null;
  readonly zoomTo: (z: number) => void;
  readonly resetView: () => void;
  readonly panBy: (dx: number, dy: number) => void;
  readonly rect: () => DOMRect | null;
}

export interface UseWorkspaceResult {
  readonly wins: AppWindow[] | null;
  readonly snapPrev: SnapPrev | null;
  readonly palOpen: boolean;
  readonly setPalOpen: (open: boolean) => void;
  readonly conns: Connection[];
  readonly connecting: ConnectingState | null;
  readonly view: View;
  readonly api: WorkspaceApi;
}
