"use client";

import { useMemo, useRef } from "react";
import type { AppWindow, Connection } from "../windows/types";

const EMPTY_CFGS: readonly object[] = [];

// Issue #1580 — a monotonic revision that changes ONLY when the cross-window link
// context can change: the connection set, the set/order/types of windows, or any
// window's cfg object identity. Geometry/z/min/max/content-zoom changes (which fire
// on every drag and pan/zoom rAF frame) deliberately do NOT bump it. This is what
// lets memoized WindowFrames stay un-rendered during gestures while a folder switch
// in a connected Files window or a newly drawn edge still propagates to every
// dependent window's linked* context. Comparison is by reference only (no
// stringify), so it stays cheap even for windows whose cfg holds large data URLs.
// Shared by Workspace (WindowFrame memo contract) and AppShell (scope-rebind scan,
// GEN-PERF-WORKSPACE-007); it lives outside Workspace.tsx so tests that mock the
// Workspace component keep the real hook.
export function useLinkRevision(
  wins: readonly AppWindow[] | null,
  conns: readonly Connection[],
): number {
  const revRef = useRef(0);
  const prevRef = useRef<{
    readonly conns: readonly Connection[];
    readonly keys: string;
    readonly cfgs: readonly object[];
  } | null>(null);
  const { keys, cfgs } = useMemo(
    () =>
      wins === null
        ? { keys: "", cfgs: EMPTY_CFGS }
        : {
            keys: wins.map((w) => `${w.id}:${w.type}`).join("|"),
            cfgs: wins.map((w) => w.cfg),
          },
    [wins],
  );
  const prev = prevRef.current;
  const changed =
    prev === null ||
    prev.conns !== conns ||
    prev.keys !== keys ||
    prev.cfgs.length !== cfgs.length ||
    cfgs.some((cfg, i) => cfg !== prev.cfgs[i]);
  if (changed) {
    revRef.current += 1;
    prevRef.current = { conns, keys, cfgs };
  }
  return revRef.current;
}
