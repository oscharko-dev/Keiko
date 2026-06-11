import type { WindowType } from "./WindowsRegistry";

export interface AppWindow {
  readonly id: string;
  readonly type: WindowType;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly cfg: Record<string, string | number | boolean | undefined>;
  readonly max: boolean;
  readonly prev?: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
  readonly zoom?: number;
}

export interface Connection {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  // Release 0.2.0 — bind-time snapshot of what a Files↔Chat / Connector↔Chat edge bound.
  // Unbind paths must use these instead of re-deriving from the window's CURRENT cfg: the
  // user may have navigated the Files window elsewhere or re-selected another capsule since,
  // and the re-derived value would unbind the wrong source. Absent on non-binding edges and
  // on edges persisted before 0.2.0 (callers fall back to cfg-derivation).
  readonly boundRoot?: string;
  readonly boundConnectorKind?: "capsule" | "capsule-set";
  readonly boundConnectorId?: string;
}

export interface View {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

export interface SnapPrev {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type ConnState = "valid" | "invalid" | "source" | null;

export interface ConnectingState {
  readonly from: string;
  readonly x: number;
  readonly y: number;
}
