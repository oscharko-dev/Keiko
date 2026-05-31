"use client";

import { createContext } from "react";
import type { AppWindow } from "../windows/types";

export interface WsContextValue {
  readonly wins: readonly AppWindow[];
  readonly active: AppWindow | null;
  readonly winCount: number;
}

export const WsContext = createContext<WsContextValue>({
  wins: [],
  active: null,
  winCount: 0,
});
