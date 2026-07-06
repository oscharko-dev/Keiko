"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GroundedAnswer as GroundedAnswerWire } from "@/lib/types";
import { Icons } from "../Icons";
import { connPath, relLabel } from "./connectionUtils";
import type { AppWindow, Connection, ConnectingState } from "./types";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";
import { useOptionalChatSessionActivity } from "../context/ChatSessionContext";

interface ConnectionsLayerProps {
  readonly wins: readonly AppWindow[];
  readonly conns: readonly Connection[];
  readonly connecting: ConnectingState | null;
  readonly api: WorkspaceApi;
}

type FlowIntensity = "light" | "heavy";

export interface ResolvedConn {
  readonly c: Connection;
  readonly d: string;
  readonly mid: { readonly x: number; readonly y: number };
  readonly label: string;
  // True when this is a chat↔data-source edge (a grounding/data channel), so it can light up while
  // the connected chat is exchanging data with the source. Pure links (e.g. keiko↔agents) do not.
  readonly dataChannel: boolean;
}

function connectionMetadataLabel(item: ResolvedConn): string {
  const parts = [`Connection: ${item.label}`];
  if (item.c.boundRoot !== undefined) {
    parts.push(`Root: ${item.c.boundRoot}`);
  }
  if (item.c.boundScopeKind !== undefined) {
    parts.push(`Scope: ${item.c.boundScopeKind}`);
  }
  if (item.c.boundRelativePath !== undefined && item.c.boundRelativePath.length > 0) {
    parts.push(`Path: ${item.c.boundRelativePath}`);
  }
  if (item.c.boundConnectorKind !== undefined && item.c.boundConnectorId !== undefined) {
    parts.push(`Knowledge: ${item.c.boundConnectorKind} ${item.c.boundConnectorId}`);
  }
  return parts.join("\n");
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

// Exported for tests (the cached variant below must stay result-equivalent).
export function resolveConnections(
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

interface ResolvedConnCacheEntry {
  readonly a: AppWindow;
  readonly b: AppWindow;
  readonly conn: Connection;
  readonly resolved: ResolvedConn;
}

// GEN-PERF-WORKSPACE-006 — an edge's geometry/label depend ONLY on its two endpoint
// windows, yet resolveConnections rebuilt every ResolvedConn (path string, label,
// mid) whenever the `wins` array identity changed — i.e. on every drag/resize rAF
// frame, for ALL connections, even ones untouched by the gesture. This cached
// variant re-resolves an edge only when its Connection or one of its endpoint
// windows actually changed identity (#1580's makeUpdate keeps unchanged windows
// reference-equal), and — critically — preserves the ResolvedConn object identity
// for untouched edges so the memoized ConnectionEdge/ConnectionBadge components
// below skip re-rendering them entirely. Exported for tests.
export function resolveConnectionsCached(
  cache: Map<string, ResolvedConnCacheEntry>,
  wins: readonly AppWindow[],
  conns: readonly Connection[],
): ResolvedConn[] {
  const byId = new Map<string, AppWindow>(wins.map((w) => [w.id, w]));
  const out: ResolvedConn[] = [];
  const seen = new Set<string>();
  for (const c of conns) {
    const a = byId.get(c.a);
    const b = byId.get(c.b);
    if (a === undefined || b === undefined) continue;
    seen.add(c.id);
    const prev = cache.get(c.id);
    if (prev !== undefined && prev.conn === c && prev.a === a && prev.b === b) {
      out.push(prev.resolved);
      continue;
    }
    const p = connPath(a, b);
    const resolved: ResolvedConn = {
      c,
      d: p.d,
      mid: p.mid,
      label: relLabel(a, b),
      dataChannel: isDataChannel(a, b),
    };
    cache.set(c.id, { a, b, conn: c, resolved });
    out.push(resolved);
  }
  // Sweep entries for removed/orphaned connections so the cache cannot grow past
  // the live connection set.
  if (cache.size > seen.size) {
    for (const key of Array.from(cache.keys())) {
      if (!seen.has(key)) cache.delete(key);
    }
  }
  return out;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function windowRect(win: AppWindow): Rect {
  return { left: win.x, top: win.y, right: win.x + win.w, bottom: win.y + win.h };
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function estimatedBadgeRect(item: ResolvedConn, active: boolean): Rect {
  const label = item.label;
  const textWidth = Math.min(240, Math.max(40, label.length * 7.2));
  const chromeWidth = 44 + (active ? 18 : 0);
  const width = textWidth + chromeWidth;
  const height = 26;
  return {
    left: item.mid.x - width / 2,
    right: item.mid.x + width / 2,
    top: item.mid.y - height / 2,
    bottom: item.mid.y + height / 2,
  };
}

export function shouldRenderConnectionBadge(
  item: ResolvedConn,
  wins: readonly AppWindow[],
  active = false,
): boolean {
  const badge = estimatedBadgeRect(item, active);
  return !wins.some((win) => win.minimized !== true && rectsIntersect(badge, windowRect(win)));
}

function shouldRenderConnectionBadgeAgainstRects(
  item: ResolvedConn,
  windowRects: readonly Rect[],
  active: boolean,
): boolean {
  const badge = estimatedBadgeRect(item, active);
  return !windowRects.some((rect) => rectsIntersect(badge, rect));
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
  // GEN-UI-A11Y-015 — monotonic counter bumped ONLY when the arm auto-expires (the silent timeout
  // revert). A user-initiated disarm (confirm/blur) does not bump it, so we announce the cancellation
  // exactly for the case a sighted user would have seen the "Remove?" badge quietly revert.
  readonly autoCancelledNonce: number;
} {
  const [armedId, setArmedId] = useState<string | null>(null);
  const [autoCancelledNonce, setAutoCancelledNonce] = useState(0);
  useEffect(() => {
    if (armedId === null) return;
    const timer = setTimeout(() => {
      setArmedId(null);
      setAutoCancelledNonce((n) => n + 1);
    }, REMOVE_ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armedId]);
  // Stable identities (GEN-PERF-WORKSPACE-006): these flow into the memoized
  // ConnectionBadge props, so fresh closures per render would defeat that memo.
  const arm = useCallback((id: string) => setArmedId(id), []);
  const disarm = useCallback(() => setArmedId(null), []);
  return { armedId, arm, disarm, autoCancelledNonce };
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

interface ConnectionEdgeProps {
  readonly item: ResolvedConn;
  readonly active: boolean;
  readonly intensity: FlowIntensity;
  readonly reducedMotion: boolean;
}

// GEN-PERF-WORKSPACE-006 — memoized per-edge SVG. `item` keeps its identity while
// both endpoint windows are untouched (resolveConnectionsCached), so dragging one
// window re-renders only the edges attached to it instead of every edge per frame.
const ConnectionEdge = memo(function ConnectionEdge({
  item,
  active,
  intensity,
  reducedMotion,
}: ConnectionEdgeProps): ReactNode {
  const pathId = `conn-path-${item.c.id}`;
  return (
    <g>
      <path
        id={pathId}
        className="conn-path"
        d={item.d}
        data-active={active ? "true" : undefined}
        data-intensity={active ? intensity : undefined}
        data-reduced-motion={active && reducedMotion ? "true" : undefined}
      />
      {active && !reducedMotion ? <FlowParticles pathId={pathId} intensity={intensity} /> : null}
    </g>
  );
});

interface ConnectionBadgeProps {
  readonly item: ResolvedConn;
  readonly active: boolean;
  readonly intensity: FlowIntensity;
  readonly armed: boolean;
  readonly onArm: (id: string) => void;
  readonly onDisarm: () => void;
  readonly onConfirmRemove: (id: string) => void;
}

// GEN-PERF-WORKSPACE-006 — memoized badge; same identity contract as ConnectionEdge
// (the arm/disarm/remove callbacks are referentially stable in the parent).
const ConnectionBadge = memo(function ConnectionBadge({
  item,
  active,
  intensity,
  armed,
  onArm,
  onDisarm,
  onConfirmRemove,
}: ConnectionBadgeProps): ReactNode {
  const metadataLabel = connectionMetadataLabel(item);
  return (
    <button
      type="button"
      className="conn-badge"
      data-active={active ? "true" : undefined}
      data-intensity={active ? intensity : undefined}
      data-armed={armed ? "true" : undefined}
      style={{ left: item.mid.x, top: item.mid.y }}
      onClick={() => {
        // Audit C301 — two-stage removal: first click arms, second confirms.
        if (armed) onConfirmRemove(item.c.id);
        else onArm(item.c.id);
      }}
      onBlur={() => {
        if (armed) onDisarm();
      }}
      title={
        armed
          ? `Click again to remove: ${item.label}\n\n${metadataLabel}`
          : `${metadataLabel}\n\nClick once to arm removal.`
      }
      aria-label={
        armed
          ? `Confirm removal of connection: ${item.label}. Activate again to remove.`
          : active
            ? `${item.label} — ${intensity} data exchange in progress. Activate to remove connection.`
            : `Remove connection: ${item.label}`
      }
    >
      <Icons.git size={11} /> <span>{armed ? "Remove?" : item.label}</span>
      {active && !armed ? (
        <span className="conn-flow-tag" aria-hidden="true">
          {intensity === "heavy" ? "⇶" : "→"}
        </span>
      ) : null}
    </button>
  );
});

function ConnectionsLayerImpl({ wins, conns, connecting, api }: ConnectionsLayerProps): ReactNode {
  const activity = useOptionalChatSessionActivity();
  const reducedMotion = usePrefersReducedMotion();
  const { armedId, arm, disarm, autoCancelledNonce } = useArmedRemove();
  // GEN-UI-A11Y-015 — one shared polite live region for the badge layer. It announces the silent
  // auto-disarm ("Removal cancelled …") that a screen-reader user would otherwise miss entirely,
  // since the badge quietly reverts from "Remove?" back to its label with no other signal. Driven
  // only by the auto-expiry nonce, never by a user-initiated confirm/blur disarm.
  const [removalAnnouncement, setRemovalAnnouncement] = useState("");
  const prevAutoCancelledNonce = useRef(autoCancelledNonce);
  useEffect(() => {
    if (autoCancelledNonce === prevAutoCancelledNonce.current) return;
    prevAutoCancelledNonce.current = autoCancelledNonce;
    setRemovalAnnouncement("Removal cancelled — the connection was not removed.");
  }, [autoCancelledNonce]);
  // A data exchange is live whenever the chat session has a request in flight. We only light up
  // chat↔data-source edges (dataChannel), so an ungrounded reply over a chat with no source edge
  // animates nothing. Heavy/light intensity is remembered from the last settled answer (see useChannelFlow).
  const { flowing, intensity } = useChannelFlow(
    activity?.sending === true,
    activity?.latestGrounded,
  );

  // Issue #1580 — edge geometry depends only on window rects + the connection set,
  // never on the pan/zoom view (the SVG lives inside the CSS-transformed .ws-scene),
  // so recompute only when those actually change. Combined with the memo wrapper
  // below this keeps the connections layer idle during pan/zoom.
  // GEN-PERF-WORKSPACE-006 — the cached resolve additionally preserves ResolvedConn
  // identity for edges whose endpoints did not change, so a drag frame re-resolves
  // and re-renders ONLY the dragged window's edges.
  const resolveCacheRef = useRef<Map<string, ResolvedConnCacheEntry>>(new Map());
  const items = useMemo(
    () => resolveConnectionsCached(resolveCacheRef.current, wins, conns),
    [wins, conns],
  );
  const onConfirmRemove = useCallback(
    (id: string): void => {
      disarm();
      api.removeConn(id);
    },
    [disarm, api],
  );
  const visibleBadgeIds = useMemo(() => {
    const windowRects = wins.filter((win) => win.minimized !== true).map(windowRect);
    const ids = new Set<string>();
    for (const item of items) {
      if (shouldRenderConnectionBadgeAgainstRects(item, windowRects, flowing && item.dataChannel)) {
        ids.add(item.c.id);
      }
    }
    return ids;
  }, [flowing, items, wins]);
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
          {items.map((it) => (
            <ConnectionEdge
              key={it.c.id}
              item={it}
              active={flowing && it.dataChannel}
              intensity={intensity}
              reducedMotion={reducedMotion}
            />
          ))}
          {temp !== null ? <path className="conn-path conn-temp" d={temp.d} /> : null}
          {temp !== null ? <circle className="conn-dot" cx={temp.ex} cy={temp.ey} r="5" /> : null}
        </svg>
      </div>
      {/* Audit C123 (workspace--visual) — the remove badge is the ONLY affordance to detach a
          connection, but .conn-layer sits at z-index 0 below every window: a badge whose edge
          midpoint lands under a window was invisible AND unclickable. Badges therefore live in
          their own layer above the windows; the lines stay below (unchanged look). */}
      <div className="conn-badge-layer">
        {/* GEN-UI-A11Y-015 — one shared status region for the whole badge layer. Announces the silent
            auto-disarm so a screen-reader user learns the connection was NOT removed. */}
        <div className="visually-hidden" role="status" aria-live="polite">
          {removalAnnouncement}
        </div>
        {items.map((it) => {
          if (!visibleBadgeIds.has(it.c.id)) return null;
          return (
            <ConnectionBadge
              key={it.c.id}
              item={it}
              active={flowing && it.dataChannel}
              intensity={intensity}
              armed={armedId === it.c.id}
              onArm={arm}
              onDisarm={disarm}
              onConfirmRemove={onConfirmRemove}
            />
          );
        })}
      </div>
    </>
  );
}

// Issue #1580 — memoized so the connections layer is skipped on pan/zoom frames
// (its props — visibleWins, conns, connecting, the now-stable api — are all
// referentially stable unless windows/edges actually change). A window drag
// changes `wins` and correctly re-renders it so edges track the moved window.
export const ConnectionsLayer = memo(ConnectionsLayerImpl);
