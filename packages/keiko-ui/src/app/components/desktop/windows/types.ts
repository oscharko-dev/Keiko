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
