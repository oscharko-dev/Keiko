// Epic #270 Slice 1 — Quality Intelligence ↔ Files relationship binding.
// canConnect must allow a `quality` (QI hub) window to bind to a `files` window (in either
// direction) so the connected folder feeds "Generate test cases", and must keep rejecting
// unrelated pairings.

import { describe, expect, it } from "vitest";
import {
  canConnect,
  connPath,
  defaultLayout,
  hasConnectablePeer,
  relLabel,
  snapMap,
  subText,
  type WinSnapshot,
} from "./connectionUtils";

function snap(type: WinSnapshot["type"], cfg: Record<string, unknown> = {}): WinSnapshot {
  return { id: `${type}-1`, type, x: 0, y: 0, w: 10, h: 10, cfg };
}

describe("canConnect — quality ↔ files (#270)", () => {
  it("allows quality to connect to files in both orders", () => {
    expect(canConnect("quality", "files")).toBe(true);
    expect(canConnect("files", "quality")).toBe(true);
  });

  it("still rejects unrelated pairings for quality", () => {
    expect(canConnect("quality", "terminal")).toBe(false);
    expect(canConnect("quality", "browser")).toBe(false);
    expect(canConnect("quality", "quality")).toBe(false);
    expect(canConnect("quality", "chat")).toBe(false);
  });

  it("does not regress the existing chat ↔ files / connector bindings", () => {
    expect(canConnect("chat", "files")).toBe(true);
    expect(canConnect("chat", "connector")).toBe(true);
  });

  it("allows editor completion context to bind to files and connectors", () => {
    expect(canConnect("editor", "files")).toBe(true);
    expect(canConnect("files", "editor")).toBe(true);
    expect(canConnect("editor", "connector")).toBe(true);
    expect(canConnect("connector", "editor")).toBe(true);
  });

  it("allows Prompt Enhancer grounding context to bind to files", () => {
    expect(canConnect("promptEnhancer", "files")).toBe(true);
    expect(canConnect("files", "promptEnhancer")).toBe(true);
    expect(canConnect("promptEnhancer", "connector")).toBe(false);
    expect(canConnect("promptEnhancer", "quality")).toBe(false);
  });
});

// Epic #710, Issue #718 — a QI hub can bind to a Connector window so the connector's selected
// capsule / capsule-set becomes the Generate source.
describe("canConnect — quality ↔ connector (#710 #718)", () => {
  it("allows quality to connect to a connector in both orders", () => {
    expect(canConnect("quality", "connector")).toBe(true);
    expect(canConnect("connector", "quality")).toBe(true);
  });

  it("keeps the existing connector ↔ chat binding", () => {
    expect(canConnect("connector", "chat")).toBe(true);
    expect(canConnect("chat", "connector")).toBe(true);
  });

  it("does not make connectors universally connectable", () => {
    expect(canConnect("connector", "files")).toBe(false);
    expect(canConnect("connector", "terminal")).toBe(false);
  });
});

describe("relLabel — files ↔ quality (#270)", () => {
  // uiux-fix F008 C074 — the label shows the folder BASENAME (a full absolute path grew the
  // destructive remove badge to hundreds of pixels) and never invents the "src" sentinel.
  it("labels a files↔quality edge with the connected folder's basename", () => {
    const label = relLabel(snap("files", { root: "/work/spec" }), snap("quality"));
    expect(label).toBe("uses spec/");
  });

  it("prefers the resolved root persisted by the Files widget", () => {
    const label = relLabel(snap("files", { resolvedRoot: "/a/b/fachkonzepte" }), snap("chat"));
    expect(label).toBe("uses fachkonzepte/");
  });

  it("is honest when no folder is configured instead of fabricating 'src'", () => {
    expect(relLabel(snap("files"), snap("chat"))).toBe("no folder selected");
    expect(relLabel(snap("files", { root: "" }), snap("quality"))).toBe("no folder selected");
    expect(relLabel(snap("files", { root: "/repo", activeFilePath: "src/app.ts" }), snap("editor"))).toBe(
      "uses app.ts",
    );
    expect(
      relLabel(snap("files", { resolvedRoot: "/Users/oscharko-dev/Projects/Keiko" }), snap("promptEnhancer")),
    ).toBe("uses Keiko/");
  });
});

describe("relLabel — quality ↔ connector (#710 #718)", () => {
  it("labels a quality↔connector edge as a knowledge binding", () => {
    expect(relLabel(snap("quality"), snap("connector"))).toBe("uses knowledge");
    expect(relLabel(snap("connector"), snap("quality"))).toBe("uses knowledge");
  });
});

describe("connectionUtils — general workspace contracts", () => {
  it("detects connectable peers including reverse-only peers and rejects unknowns", () => {
    expect(hasConnectablePeer("quality")).toBe(true);
    expect(hasConnectablePeer("figma")).toBe(true);
    expect(hasConnectablePeer("figmaView")).toBe(true);
    expect(hasConnectablePeer("chatHistory")).toBe(false);
    expect(hasConnectablePeer(undefined)).toBe(false);
    expect(canConnect(undefined, "chat")).toBe(false);
    expect(canConnect("chat", undefined)).toBe(false);
    expect(canConnect("quality", "figmaView")).toBe(true);
    expect(canConnect("figmaView", "quality")).toBe(true);
  });

  it("labels common non-file relationship predicates with readable verbs", () => {
    expect(relLabel(snap("quality"), snap("figma"))).toBe("uses snapshot");
    expect(relLabel(snap("quality"), snap("figmaView"))).toBe("uses view");
    expect(relLabel(snap("chat"), snap("keiko"))).toBe("governed by");
    expect(relLabel(snap("agents"), snap("agents"))).toBe("delegates");
    expect(relLabel(snap("agents"), snap("terminal"))).toBe("runs in");
    expect(relLabel(snap("plugins"), snap("chat"))).toBe("uses tools");
    expect(relLabel(snap("review"), snap("agents"))).toBe("reviews");
    expect(relLabel(snap("browser"), snap("chat"))).toBe("browses");
    expect(relLabel(snap("editor"), snap("chat"))).toBe("connected");
  });

  it("labels files edges with the most specific active scope", () => {
    expect(
      relLabel(snap("files", { root: "/repo", activeDirectoryPath: "/repo/docs" }), snap("chat")),
    ).toBe("uses docs/");
    expect(
      relLabel(snap("files", { root: "/repo", activeFilePath: "/repo/src/app.ts" }), snap("chat")),
    ).toBe("uses app.ts");
  });

  it("builds horizontal and vertical bezier paths with stable midpoints", () => {
    expect(
      connPath(
        { ...snap("chat"), x: 0, y: 0, w: 100, h: 80 },
        { ...snap("files"), x: 300, y: 20, w: 100, h: 80 },
      ),
    ).toEqual({
      d: "M100,40 C200,40 200,60 300,60",
      mid: { x: 200, y: 50 },
    });
    expect(
      connPath(
        { ...snap("chat"), x: 100, y: 300, w: 100, h: 80 },
        { ...snap("files"), x: 120, y: 0, w: 100, h: 80 },
      ),
    ).toEqual({
      d: "M150,300 C150,190 170,190 170,80",
      mid: { x: 160, y: 190 },
    });
  });

  it("derives snap rectangles and the default desktop layout from viewport geometry", () => {
    expect(snapMap({ x: 10, y: 20, w: 800, h: 600 })).toMatchObject({
      left: { x: 10, y: 20, w: 400, h: 600 },
      right: { x: 410, y: 20, w: 400, h: 600 },
      maxi: { x: 10, y: 20, w: 800, h: 600 },
      br: { x: 410, y: 320, w: 400, h: 300 },
    });

    const layout = defaultLayout(1200, 800);
    expect(layout.map((win) => win.type)).toEqual(["chat", "files", "terminal"]);
    expect(layout[0]).toMatchObject({ id: "chat-0", x: 14, y: 14, z: 3, max: false, zoom: 1 });
    expect(layout[1]?.x).toBe((layout[0]?.x ?? 0) + (layout[0]?.w ?? 0) + 14);
    expect(layout[1]?.h).toBe(Math.round((800 - 14 * 2 - 14) * 0.52));
    expect(layout[2]?.y).toBe((layout[1]?.y ?? 0) + (layout[1]?.h ?? 0) + 14);
  });

  it("derives compact subtext only from meaningful config values", () => {
    expect(subText("files", { root: "/repo" })).toBe("/repo");
    expect(subText("browser", { url: "https://example.test" })).toBe("https://example.test");
    expect(subText("editor", { file: "src/app.ts" })).toBe("src/app.ts");
    expect(subText("editor", { root: "/repo", file: "src/app.ts" })).toBe("src/app.ts — /repo");
    expect(subText("terminal", { cwd: "/repo" })).toBe("/repo");
    expect(subText("review", { base: "main", head: "release/0.2.0" })).toBe("main → release/0.2.0");
    expect(subText("review", { base: "main" })).toBeNull();
    expect(subText("agents", { role: "reviewer" })).toBe("reviewer");
    expect(subText("chat", { title: "Release QA" })).toBe("Release QA");
    expect(subText("chat", { title: "New chat" })).toBeNull();
    expect(subText("connector", { provider: "github" })).toBeNull();
    expect(subText("figma", { snapshotRunId: "fs-hidden" })).toBeNull();
    expect(subText("figma", { selectedScreenName: "Checkout" })).toBe("Checkout");
    expect(subText("figmaView", { selectedScreenName: "Checkout" })).toBe("Checkout");
    expect(subText("figmaJson", { snapshotRunId: "fs-hidden", screenId: "12:34" })).toBe("12:34");
    expect(subText("files", undefined)).toBeNull();
  });
});
