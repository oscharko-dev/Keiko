"use client";

import type { ReactNode } from "react";
import { Icons } from "../Icons";
import { connPath, relLabel } from "./connectionUtils";
import type { AppWindow, Connection, ConnectingState } from "./types";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";

interface ConnectionsLayerProps {
  readonly wins: readonly AppWindow[];
  readonly conns: readonly Connection[];
  readonly connecting: ConnectingState | null;
  readonly api: WorkspaceApi;
}

interface ResolvedConn {
  readonly c: Connection;
  readonly d: string;
  readonly mid: { readonly x: number; readonly y: number };
  readonly label: string;
}

function resolveConnections(
  wins: readonly AppWindow[],
  conns: readonly Connection[],
): ResolvedConn[] {
  const byId = new Map<string, AppWindow>(wins.map((w) => [w.id, w]));
  const out: ResolvedConn[] = [];
  for (const c of conns) {
    const a = byId.get(c.a);
    const b = byId.get(c.b);
    if (a === undefined || b === undefined) continue;
    const p = connPath(a, b);
    out.push({ c, d: p.d, mid: p.mid, label: relLabel(a, b) });
  }
  return out;
}

interface TempPath {
  readonly d: string;
  readonly ex: number;
  readonly ey: number;
}

function tempPath(connecting: ConnectingState, wins: readonly AppWindow[]): TempPath | null {
  const a = wins.find((w) => w.id === connecting.from);
  if (a === undefined) return null;
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const dx = connecting.x - ca.x;
  const dy = connecting.y - ca.y;
  const horiz = Math.abs(dx) >= Math.abs(dy);
  const s = horiz
    ? { x: dx >= 0 ? a.x + a.w : a.x, y: ca.y }
    : { x: ca.x, y: dy >= 0 ? a.y + a.h : a.y };
  const k = Math.max(40, Math.abs(horiz ? dx : dy) / 2);
  const c1 = horiz
    ? { x: s.x + (dx >= 0 ? k : -k), y: s.y }
    : { x: s.x, y: s.y + (dy >= 0 ? k : -k) };
  const ex = connecting.x;
  const ey = connecting.y;
  return {
    d: `M${String(s.x)},${String(s.y)} C${String(c1.x)},${String(c1.y)} ${String(ex)},${String(ey)} ${String(ex)},${String(ey)}`,
    ex,
    ey,
  };
}

export function ConnectionsLayer({
  wins,
  conns,
  connecting,
  api,
}: ConnectionsLayerProps): ReactNode {
  const items = resolveConnections(wins, conns);
  const temp = connecting !== null ? tempPath(connecting, wins) : null;
  return (
    <div className="conn-layer">
      {/* viewBox + matching .conn-svg CSS gives a real ±10000 viewport with
          1:1 world↔pixel mapping. No <marker>: links are symmetric, not flows. */}
      <svg
        className="conn-svg"
        viewBox="-10000 -10000 20000 20000"
        preserveAspectRatio="xMidYMid meet"
      >
        {items.map((it) => (
          <path key={it.c.id} className="conn-path" d={it.d} />
        ))}
        {temp !== null ? <path className="conn-path conn-temp" d={temp.d} /> : null}
        {temp !== null ? (
          <circle className="conn-dot" cx={temp.ex} cy={temp.ey} r="5" />
        ) : null}
      </svg>
      {items.map((it) => (
        <button
          key={it.c.id}
          type="button"
          className="conn-badge"
          style={{ left: it.mid.x, top: it.mid.y }}
          onClick={() => api.removeConn(it.c.id)}
          title="Remove connection"
          aria-label={`Remove connection: ${it.label}`}
        >
          <Icons.git size={11} /> <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
