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

function tempPath(connecting: ConnectingState, wins: readonly AppWindow[]): string | null {
  const a = wins.find((w) => w.id === connecting.from);
  if (a === undefined) return null;
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const dx = connecting.x - ca.x;
  const dy = connecting.y - ca.y;
  const start = Math.abs(dx) >= Math.abs(dy)
    ? { x: dx >= 0 ? a.x + a.w : a.x, y: ca.y }
    : { x: ca.x, y: dy >= 0 ? a.y + a.h : a.y };
  return `M${String(start.x)},${String(start.y)} L${String(connecting.x)},${String(connecting.y)}`;
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
      <svg className="conn-svg" width="100%" height="100%">
        <defs>
          <marker
            id="conn-arrow"
            markerWidth="9"
            markerHeight="9"
            refX="6"
            refY="4.5"
            orient="auto"
          >
            <path
              d="M1,1 L7,4.5 L1,8"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        </defs>
        {items.map((it) => (
          <path
            key={it.c.id}
            className="conn-path"
            markerEnd="url(#conn-arrow)"
            d={it.d}
          />
        ))}
        {temp !== null ? <path className="conn-path conn-temp" d={temp} /> : null}
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
