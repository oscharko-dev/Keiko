import type { WindowType } from "./WindowsRegistry";

export interface WinSnapshot {
  readonly id: string;
  readonly type: WindowType;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cfg?: Record<string, unknown>;
}

export const CONNECTABLE: Readonly<Record<string, readonly string[]>> = {
  agents: ["files", "terminal", "plugins", "review", "browser", "agents", "keiko"],
  chat: ["files", "browser", "plugins", "keiko"],
  files: ["agents", "chat"],
  terminal: ["agents"],
  plugins: ["agents", "chat"],
  review: ["agents"],
  browser: ["agents", "chat"],
  keiko: ["agents", "chat"],
};

export function canConnect(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === b) return false;
  return (CONNECTABLE[a] ?? []).includes(b) || (CONNECTABLE[b] ?? []).includes(a);
}

function configRoot(cfg: Record<string, unknown> | undefined): string {
  if (cfg === undefined) return "src";
  const value = cfg["root"];
  return typeof value === "string" && value.length > 0 ? value : "src";
}

export function relLabel(a: WinSnapshot, b: WinSnapshot): string {
  const filesSide: WinSnapshot | null =
    a.type === "files" ? a : b.type === "files" ? b : null;
  const other = filesSide === null ? null : filesSide === a ? b : a;
  if (filesSide !== null && other !== null && (other.type === "chat" || other.type === "agents")) {
    return `uses ${configRoot(filesSide.cfg)}/`;
  }
  const pair: readonly [string, string] = [a.type, b.type];
  if (pair.includes("keiko")) return "governed by";
  if (pair[0] === "agents" && pair[1] === "agents") return "delegates";
  if (pair.includes("terminal")) return "runs in";
  if (pair.includes("plugins")) return "tools";
  if (pair.includes("review")) return "reviews";
  if (pair.includes("browser")) return "browses";
  return "linked";
}

export interface BezierPath {
  readonly d: string;
  readonly mid: { readonly x: number; readonly y: number };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

export function connPath(a: WinSnapshot, b: WinSnapshot): BezierPath {
  const ca: Point = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb: Point = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  let s: Point;
  let e: Point;
  let c1: Point;
  let c2: Point;
  if (Math.abs(dx) >= Math.abs(dy)) {
    s = dx >= 0 ? { x: a.x + a.w, y: ca.y } : { x: a.x, y: ca.y };
    e = dx >= 0 ? { x: b.x, y: cb.y } : { x: b.x + b.w, y: cb.y };
    const k = Math.max(40, Math.abs(e.x - s.x) / 2);
    const sign = dx >= 0 ? 1 : -1;
    c1 = { x: s.x + sign * k, y: s.y };
    c2 = { x: e.x - sign * k, y: e.y };
  } else {
    s = dy >= 0 ? { x: ca.x, y: a.y + a.h } : { x: ca.x, y: a.y };
    e = dy >= 0 ? { x: cb.x, y: b.y } : { x: cb.x, y: b.y + b.h };
    const k = Math.max(40, Math.abs(e.y - s.y) / 2);
    const sign = dy >= 0 ? 1 : -1;
    c1 = { x: s.x, y: s.y + sign * k };
    c2 = { x: e.x, y: e.y - sign * k };
  }
  const mid: Point = {
    x: (s.x + 3 * c1.x + 3 * c2.x + e.x) / 8,
    y: (s.y + 3 * c1.y + 3 * c2.y + e.y) / 8,
  };
  return {
    d: `M${String(s.x)},${String(s.y)} C${String(c1.x)},${String(c1.y)} ${String(c2.x)},${String(c2.y)} ${String(e.x)},${String(e.y)}`,
    mid,
  };
}

export interface SnapRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type SnapZone = "left" | "right" | "maxi" | "tl" | "tr" | "bl" | "br";

export function snapMap(vp: SnapRect): Readonly<Record<SnapZone, SnapRect>> {
  return {
    left: { x: vp.x, y: vp.y, w: vp.w / 2, h: vp.h },
    right: { x: vp.x + vp.w / 2, y: vp.y, w: vp.w / 2, h: vp.h },
    maxi: { x: vp.x, y: vp.y, w: vp.w, h: vp.h },
    tl: { x: vp.x, y: vp.y, w: vp.w / 2, h: vp.h / 2 },
    tr: { x: vp.x + vp.w / 2, y: vp.y, w: vp.w / 2, h: vp.h / 2 },
    bl: { x: vp.x, y: vp.y + vp.h / 2, w: vp.w / 2, h: vp.h / 2 },
    br: { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2, w: vp.w / 2, h: vp.h / 2 },
  };
}

export interface DefaultLayoutWindow {
  readonly id: string;
  readonly type: WindowType;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly cfg: Record<string, unknown>;
  readonly max: false;
  readonly zoom: 1;
}

// Welle 4: design's three-window default — chat (left ~54%), files (top-right),
// terminal (bottom-right). Mirrors project/windows.jsx 134-143.
export function defaultLayout(W: number, H: number): DefaultLayoutWindow[] {
  const p = 14;
  const g = 14;
  const leftW = Math.round((W - p * 2 - g) * 0.54);
  const rightW = W - p * 2 - g - leftW;
  const filesH = Math.round((H - p * 2 - g) * 0.52);
  return [
    {
      id: "chat-0",
      type: "chat",
      x: p,
      y: p,
      w: leftW,
      h: H - p * 2,
      z: 3,
      cfg: {},
      max: false,
      zoom: 1,
    },
    {
      id: "files-0",
      type: "files",
      x: p + leftW + g,
      y: p,
      w: rightW,
      h: filesH,
      z: 2,
      cfg: {},
      max: false,
      zoom: 1,
    },
    {
      id: "term-0",
      type: "terminal",
      x: p + leftW + g,
      y: p + filesH + g,
      w: rightW,
      h: H - p * 2 - filesH - g,
      z: 1,
      cfg: {},
      max: false,
      zoom: 1,
    },
  ];
}

export function subText(
  type: WindowType,
  cfg: Record<string, unknown> | undefined,
): string | null {
  if (cfg === undefined) return null;
  const cfgString = (key: string): string | null => {
    const v = cfg[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  switch (type) {
    case "files":
      return cfgString("root");
    case "browser":
      return cfgString("url");
    case "editor":
      return cfgString("file");
    case "terminal":
      return cfgString("cwd");
    case "review": {
      const base = cfgString("base");
      const head = cfgString("head");
      return base !== null && head !== null ? `${base} → ${head}` : null;
    }
    case "agents":
      return cfgString("role");
    case "chat": {
      const title = cfgString("title");
      return title !== null && title !== "New chat" ? title : null;
    }
    default:
      return null;
  }
}
