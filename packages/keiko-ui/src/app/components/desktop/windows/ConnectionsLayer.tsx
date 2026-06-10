"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { GroundedAnswer as GroundedAnswerWire } from "@/lib/types";
import { Icons } from "../Icons";
import { connPath, relLabel } from "./connectionUtils";
import type { AppWindow, Connection, ConnectingState } from "./types";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";
import { useOptionalChatSessionContext } from "../context/ChatSessionContext";

interface ConnectionsLayerProps {
  readonly wins: readonly AppWindow[];
  readonly conns: readonly Connection[];
  readonly connecting: ConnectingState | null;
  readonly api: WorkspaceApi;
}

type FlowIntensity = "light" | "heavy";

interface ResolvedConn {
  readonly c: Connection;
  readonly d: string;
  readonly mid: { readonly x: number; readonly y: number };
  readonly label: string;
  // True when this is a chat↔data-source edge (a grounding/data channel), so it can light up while
  // the connected chat is exchanging data with the source. Pure links (e.g. keiko↔agents) do not.
  readonly dataChannel: boolean;
}

// Window kinds a chat reads data FROM. A live exchange on a chat↔source edge is what the data-flow
// visualization animates (Epic #532 — connections are relationships; activity rides the edge).
const DATA_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "files",
  "connector",
  "browser",
  "plugins",
  "agents",
  "quality",
]);

function isDataChannel(a: AppWindow, b: AppWindow): boolean {
  const types = [a.type, b.type];
  const chatSide = types.includes("chat");
  const sourceSide =
    a.type === "chat" ? DATA_SOURCE_TYPES.has(b.type) : DATA_SOURCE_TYPES.has(a.type);
  return chatSide && sourceSide;
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
    out.push({ c, d: p.d, mid: p.mid, label: relLabel(a, b), dataChannel: isDataChannel(a, b) });
  }
  return out;
}

// Heavy vs light data exchange, derived from the last grounded answer. The clearest proxy for "how
// much data actually flowed" is the count of files/sources the model pulled into context, NOT raw
// excerpt bytes: lexical folder retrieval reads only the matched lines of each file, so a 10-file
// answer can still report a few KB of excerpt while filesRead (1 vs 10) cleanly separates light from
// heavy. A single very large file also counts as heavy via the excerpt-byte fallback. Connector
// (local-knowledge) and the connector side of a hybrid answer use referencesUsed instead of files.
// Thresholds are deliberately low — a handful of real files/sources reads as "heavy" to the eye.
// (The pre-first-answer "light" default lives in useChannelFlow, not here.)
const HEAVY_FILES_READ = 4;
const HEAVY_REFERENCES = 4;
const HEAVY_EXCERPT_BYTES = 8_192;

function isHeavyFolder(filesRead: number, excerptBytes: number): boolean {
  return filesRead >= HEAVY_FILES_READ || excerptBytes >= HEAVY_EXCERPT_BYTES;
}

function groundingIntensity(latest: GroundedAnswerWire): FlowIntensity {
  switch (latest.groundingKind) {
    case "connected-context":
      return isHeavyFolder(
        latest.contextPack.usage.filesRead,
        latest.contextPack.usage.excerptBytes,
      )
        ? "heavy"
        : "light";
    case "hybrid":
      return isHeavyFolder(
        latest.contextPack.folder.usage.filesRead,
        latest.contextPack.folder.usage.excerptBytes,
      ) || latest.contextPack.knowledge.referencesUsed >= HEAVY_REFERENCES
        ? "heavy"
        : "light";
    case "local-knowledge":
      return latest.contextPack.referencesUsed >= HEAVY_REFERENCES ? "heavy" : "light";
    default:
      return "light";
  }
}

// The grounded-send flow clears `session.latestGrounded` at the START of every send (so a stale
// citation block doesn't flash) and only repopulates it once the answer returns — by which point
// the request is no longer in flight. So `latestGrounded` is undefined for the entire `sending`
// window and cannot, alone, tell the edge whether the in-flight exchange is heavy or light. We
// therefore REMEMBER the intensity of the most recent settled answer and keep the edge active for a
// short afterglow after each answer lands: the first exchange reveals its true heaviness the moment
// it completes, and every subsequent in-flight send animates at the channel's established intensity.
const FLOW_AFTERGLOW_MS = 2_500;

function useChannelFlow(
  sending: boolean,
  latest: GroundedAnswerWire | undefined,
): { readonly flowing: boolean; readonly intensity: FlowIntensity } {
  const [intensity, setIntensity] = useState<FlowIntensity>("light");
  const [afterglow, setAfterglow] = useState(false);
  useEffect(() => {
    if (latest === undefined) return; // cleared at send-start — keep the last known intensity
    setIntensity(groundingIntensity(latest));
    setAfterglow(true);
    const timer = setTimeout(() => setAfterglow(false), FLOW_AFTERGLOW_MS);
    return () => clearTimeout(timer);
  }, [latest]);
  return { flowing: sending || afterglow, intensity };
}

// Audit C301 — the badge is the only element describing the relationship, yet a single click on
// it deleted the connection (plus the server-side unbind PATCH) with no confirmation or undo.
// Removal is now two-stage: the first click arms the badge (label flips to "Remove?", danger
// styling), a second click within the window confirms; the arm auto-expires so a hesitant or
// accidental first click never leaves a live destructive trigger behind.
const REMOVE_ARM_TIMEOUT_MS = 3_000;

function useArmedRemove(): {
  readonly armedId: string | null;
  readonly arm: (id: string) => void;
  readonly disarm: () => void;
} {
  const [armedId, setArmedId] = useState<string | null>(null);
  useEffect(() => {
    if (armedId === null) return;
    const timer = setTimeout(() => setArmedId(null), REMOVE_ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armedId]);
  return {
    armedId,
    arm: (id: string) => setArmedId(id),
    disarm: () => setArmedId(null),
  };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (matches: boolean): void => setReduced(matches);
    update(mq.matches);
    const handler = (e: MediaQueryListEvent): void => update(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
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

// The moving particles for an active data channel. Each rides the edge path via <animateMotion>.
// Heavy exchanges send a denser, faster swarm; light exchanges a single slower particle. Rendered
// only when motion is allowed — reduced-motion users get the static "active" stroke instead.
function FlowParticles({
  pathId,
  intensity,
}: {
  pathId: string;
  intensity: FlowIntensity;
}): ReactNode {
  const count = intensity === "heavy" ? 3 : 1;
  const dur = intensity === "heavy" ? 1.1 : 2.2;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <circle
          key={i}
          className="conn-particle"
          r={intensity === "heavy" ? 3 : 2.4}
          aria-hidden="true"
        >
          <animateMotion
            dur={`${String(dur)}s`}
            repeatCount="indefinite"
            begin={`${String((dur / count) * i)}s`}
            rotate="auto"
            keyPoints="0;1"
            keyTimes="0;1"
            calcMode="linear"
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      ))}
    </>
  );
}

export function ConnectionsLayer({
  wins,
  conns,
  connecting,
  api,
}: ConnectionsLayerProps): ReactNode {
  const session = useOptionalChatSessionContext();
  const reducedMotion = usePrefersReducedMotion();
  const { armedId, arm, disarm } = useArmedRemove();
  // A data exchange is live whenever the chat session has a request in flight. We only light up
  // chat↔data-source edges (dataChannel), so an ungrounded reply over a chat with no source edge
  // animates nothing. Heavy/light intensity is remembered from the last settled answer (see useChannelFlow).
  const { flowing, intensity } = useChannelFlow(session?.sending === true, session?.latestGrounded);

  const items = resolveConnections(wins, conns);
  const temp = connecting !== null ? tempPath(connecting, wins) : null;
  return (
    <>
      <div className="conn-layer">
        {/* viewBox + matching .conn-svg CSS gives a real ±10000 viewport with
          1:1 world↔pixel mapping. No <marker>: links are symmetric, not flows. */}
        <svg
          className="conn-svg"
          viewBox="-10000 -10000 20000 20000"
          preserveAspectRatio="xMidYMid meet"
        >
          {items.map((it) => {
            const active = flowing && it.dataChannel;
            const pathId = `conn-path-${it.c.id}`;
            return (
              <g key={it.c.id}>
                <path
                  id={pathId}
                  className="conn-path"
                  d={it.d}
                  data-active={active ? "true" : undefined}
                  data-intensity={active ? intensity : undefined}
                  data-reduced-motion={active && reducedMotion ? "true" : undefined}
                />
                {active && !reducedMotion ? (
                  <FlowParticles pathId={pathId} intensity={intensity} />
                ) : null}
              </g>
            );
          })}
          {temp !== null ? <path className="conn-path conn-temp" d={temp.d} /> : null}
          {temp !== null ? <circle className="conn-dot" cx={temp.ex} cy={temp.ey} r="5" /> : null}
        </svg>
      </div>
      {/* Audit C123 (workspace--visual) — the remove badge is the ONLY affordance to detach a
          connection, but .conn-layer sits at z-index 0 below every window: a badge whose edge
          midpoint lands under a window was invisible AND unclickable. Badges therefore live in
          their own layer above the windows; the lines stay below (unchanged look). */}
      <div className="conn-badge-layer">
        {items.map((it) => {
          const active = flowing && it.dataChannel;
          const armed = armedId === it.c.id;
          return (
            <button
              key={it.c.id}
              type="button"
              className="conn-badge"
              data-active={active ? "true" : undefined}
              data-intensity={active ? intensity : undefined}
              data-armed={armed ? "true" : undefined}
              style={{ left: it.mid.x, top: it.mid.y }}
              onClick={() => {
                // Audit C301 — two-stage removal: first click arms, second confirms.
                if (armed) {
                  disarm();
                  api.removeConn(it.c.id);
                } else {
                  arm(it.c.id);
                }
              }}
              onBlur={() => {
                if (armed) disarm();
              }}
              title={
                armed ? `Click again to remove: ${it.label}` : `Remove connection: ${it.label}`
              }
              aria-label={
                armed
                  ? `Confirm removal of connection: ${it.label}. Activate again to remove.`
                  : active
                    ? `${it.label} — ${intensity} data exchange in progress. Activate to remove connection.`
                    : `Remove connection: ${it.label}`
              }
            >
              <Icons.git size={11} /> <span>{armed ? "Remove?" : it.label}</span>
              {active && !armed ? (
                <span className="conn-flow-tag" aria-hidden="true">
                  {intensity === "heavy" ? "⇶" : "→"}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
