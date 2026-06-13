// Epic #532 — pure scope-list + Files↔Chat binding helpers used by the relationship-edge wiring.
// Epic #189 Slice 3 M1 — plural connector-scope helpers + Connector↔Chat binding.
// Epic #710 #718 — linkedConnectorCapsuleIds reader.

import { describe, expect, it } from "vitest";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import {
  MAX_SCOPES,
  appendConnectorScope,
  appendScope,
  connectorChatBind,
  filesChatBindScope,
  effectiveLocalKnowledgeScopes,
  effectiveScopes,
  filesChatBindRoot,
  filesVisibleScope,
  makeConnectActions,
  makeMutations,
  removeConnectorScope,
  removeScope,
  resolvedFilesRoot,
} from "./workspaceActions";
import type { AppWindow, Connection, ConnectingState, View } from "../windows/types";
import type { ChatConnectedScope, ChatLocalKnowledgeScope } from "@/lib/types";
import { DEFAULT_GROUNDING_LIMITS } from "@/lib/types";
import { WIN_TYPES } from "../windows/WindowsRegistry";

function win(type: AppWindow["type"], cfg: AppWindow["cfg"] = {}, id = `${type}-1`): AppWindow {
  return { id, type, x: 0, y: 0, w: 10, h: 10, z: 1, cfg, max: false };
}

function scope(root: string, connectedAtMs = 1): ChatConnectedScope {
  return { kind: "workspace-root", relativePaths: [], root, connectedAtMs };
}

describe("effectiveScopes", () => {
  it("prefers the connectedScopes list over the singular field", () => {
    const list = [scope("/a"), scope("/b")];
    expect(effectiveScopes({ connectedScopes: list, connectedScope: list[0] })).toBe(list);
  });

  it("falls back to a 1-element list from the singular field", () => {
    const single = scope("/a");
    expect(effectiveScopes({ connectedScope: single })).toEqual([single]);
  });

  it("is empty when neither field is set", () => {
    expect(effectiveScopes({})).toEqual([]);
  });
});

describe("appendScope", () => {
  it("appends a new absolute root", () => {
    const next = appendScope([scope("/a")], "/b", 5);
    expect(next).not.toBeNull();
    expect(next?.map((s) => s.root)).toEqual(["/a", "/b"]);
    expect(next?.[1]).toMatchObject({
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 5,
    });
  });

  it("de-dupes a root already present (returns the same list reference)", () => {
    const current = [scope("/a")];
    expect(appendScope(current, "/a", 9)).toBe(current);
  });

  it("returns null for a non-absolute root", () => {
    expect(appendScope([], "relative/dir", 1)).toBeNull();
    expect(appendScope([], "", 1)).toBeNull();
  });

  // Release 0.2.0 — the 17th source must be PREVENTED, not swapped in: at the cap the list
  // is returned unchanged (same reference) so callers can surface the limit to the user.
  // (Pre-0.2.0 behaviour silently evicted the oldest source, leaving a dangling edge.)
  it("returns the list unchanged at the MAX_SCOPES cap (no silent eviction)", () => {
    const full = Array.from({ length: MAX_SCOPES }, (_unused, i) => scope(`/d${String(i)}`));
    const next = appendScope(full, "/new", 1);
    expect(next).toBe(full);
    expect(full.some((s) => s.root === "/d0")).toBe(true);
  });

  it("still de-dupes an already-connected root while at the cap", () => {
    const full = Array.from({ length: MAX_SCOPES }, (_unused, i) => scope(`/d${String(i)}`));
    expect(appendScope(full, "/d3/", 1)).toBe(full);
  });

  // Audit finding (a): trailing-slash dedup — "/x" and "/x/" must be treated as the same root.
  it("de-dupes a root that differs from the stored root only by a trailing slash", () => {
    const current = [scope("/x")];
    expect(appendScope(current, "/x/", 9)).toBe(current);
    const current2 = [scope("/x/")];
    expect(appendScope(current2, "/x", 9)).toBe(current2);
  });
});

describe("removeScope", () => {
  it("removes the matching root and keeps the rest", () => {
    expect(removeScope([scope("/a"), scope("/b")], "/a").map((s) => s.root)).toEqual(["/b"]);
  });

  it("returns an empty list when the last source is removed", () => {
    expect(removeScope([scope("/a")], "/a")).toEqual([]);
  });

  it("is a no-op when the root is not present", () => {
    expect(removeScope([scope("/a")], "/x").map((s) => s.root)).toEqual(["/a"]);
  });

  // Release 0.2.0 — disconnect must match the bound root even when the unbind-time spelling
  // differs by a trailing separator (the bind path normalises; remove must mirror it).
  it("removes a root that differs only by a trailing slash", () => {
    expect(removeScope([scope("/a"), scope("/b")], "/a/").map((s) => s.root)).toEqual(["/b"]);
    expect(removeScope([scope("/a/")], "/a")).toEqual([]);
  });
});

describe("resolvedFilesRoot", () => {
  it("returns the resolvedRoot cfg when absolute", () => {
    expect(resolvedFilesRoot(win("files", { resolvedRoot: "/Users/me/docs" }))).toBe(
      "/Users/me/docs",
    );
  });

  it("falls back to the configured root", () => {
    expect(resolvedFilesRoot(win("files", { root: "/srv/data" }))).toBe("/srv/data");
  });

  it("returns null for a non-files window", () => {
    expect(resolvedFilesRoot(win("chat"))).toBeNull();
  });

  it("returns null when only a non-absolute fallback would apply", () => {
    expect(resolvedFilesRoot(win("files", { root: "src" }))).toBeNull();
    expect(resolvedFilesRoot(win("files", {}))).toBeNull();
  });
});

describe("filesChatBindRoot", () => {
  it("returns the files root for a Files↔Chat pair in either order", () => {
    const f = win("files", { resolvedRoot: "/data/x" });
    const c = win("chat");
    expect(filesChatBindRoot(f, c)).toBe("/data/x");
    expect(filesChatBindRoot(c, f)).toBe("/data/x");
  });

  it("returns null for any non Files↔Chat pairing", () => {
    expect(
      filesChatBindRoot(win("files", { resolvedRoot: "/x" }), win("files", {}, "files-2")),
    ).toBeNull();
    expect(filesChatBindRoot(win("chat"), win("terminal"))).toBeNull();
    expect(filesChatBindRoot(win("terminal"), win("agents"))).toBeNull();
  });

  it("returns null when the files window has no resolvable absolute root", () => {
    expect(filesChatBindRoot(win("files", { root: "src" }), win("chat"))).toBeNull();
  });
});

describe("filesVisibleScope", () => {
  it("binds the repository root when the Files card is at the root view", () => {
    expect(filesVisibleScope(win("files", { resolvedRoot: "/repo" }), 10)).toEqual({
      kind: "workspace-root",
      relativePaths: [],
      root: "/repo",
      connectedAtMs: 10,
    });
  });

  it("binds the opened directory when the Files card is inside a folder", () => {
    expect(
      filesVisibleScope(
        win("files", { resolvedRoot: "/repo", activeDirectoryPath: "packages" }),
        11,
      ),
    ).toEqual({
      kind: "directory",
      relativePaths: ["packages"],
      root: "/repo",
      connectedAtMs: 11,
    });
  });

  it("binds the previewed file before the containing directory", () => {
    expect(
      filesVisibleScope(
        win("files", {
          resolvedRoot: "/repo",
          activeDirectoryPath: "packages",
          activeFilePath: "packages/keiko-ui/package.json",
        }),
        12,
      ),
    ).toEqual({
      kind: "files",
      relativePaths: ["packages/keiko-ui/package.json"],
      root: "/repo",
      connectedAtMs: 12,
    });
  });
});

describe("filesChatBindScope", () => {
  it("returns the Files visible scope for a Files↔Chat pair in either order", () => {
    const files = win("files", { resolvedRoot: "/repo", activeDirectoryPath: "packages" });
    const chat = win("chat");
    expect(filesChatBindScope(files, chat, 13)).toMatchObject({
      kind: "directory",
      relativePaths: ["packages"],
      root: "/repo",
      connectedAtMs: 13,
    });
    expect(filesChatBindScope(chat, files, 14)).toMatchObject({
      kind: "directory",
      relativePaths: ["packages"],
      root: "/repo",
      connectedAtMs: 14,
    });
  });

  it("returns null for non Files↔Chat pairings", () => {
    expect(
      filesChatBindScope(win("files", { resolvedRoot: "/repo" }), win("quality"), 1),
    ).toBeNull();
  });
});

// ─── Epic #189 Slice 3 M1 — LK scope helpers ─────────────────────────────────

function lkCapsule(id: string, ms = 1): ChatLocalKnowledgeScope {
  return {
    kind: "capsule",
    capsuleId: id as ChatLocalKnowledgeScope extends { kind: "capsule"; capsuleId: infer I }
      ? I
      : never,
    connectedAtMs: ms,
  };
}

function lkSet(id: string, ms = 1): ChatLocalKnowledgeScope {
  return {
    kind: "capsule-set",
    capsuleSetId: id as ChatLocalKnowledgeScope extends {
      kind: "capsule-set";
      capsuleSetId: infer I;
    }
      ? I
      : never,
    connectedAtMs: ms,
  };
}

describe("effectiveLocalKnowledgeScopes", () => {
  it("prefers the plural list over the singular field", () => {
    const list = [lkCapsule("c1"), lkSet("s1")];
    expect(effectiveLocalKnowledgeScopes({ localKnowledgeScopes: list })).toBe(list);
  });

  it("falls back to a 1-element list from the singular field", () => {
    const single = lkCapsule("c1");
    expect(effectiveLocalKnowledgeScopes({ localKnowledgeScope: single })).toEqual([single]);
  });

  it("is empty when neither field is set", () => {
    expect(effectiveLocalKnowledgeScopes({})).toEqual([]);
  });
});

describe("appendConnectorScope", () => {
  it("appends a capsule scope to an empty list", () => {
    const scope = lkCapsule("c1");
    const next = appendConnectorScope([], scope, 16);
    expect(next).toEqual([scope]);
  });

  it("de-dupes a capsule already present (returns the same list reference)", () => {
    const scope = lkCapsule("c1");
    const current = [scope];
    expect(appendConnectorScope(current, lkCapsule("c1"), 16)).toBe(current);
  });

  it("appends a capsule-set scope distinct from an existing capsule with same id string", () => {
    const capsule = lkCapsule("x1");
    const capsuleSet = lkSet("x1");
    const next = appendConnectorScope([capsule], capsuleSet, 16);
    expect(next).toHaveLength(2);
  });

  // Release 0.2.0 — the over-limit connector must be PREVENTED, not swapped in: at the cap
  // the list is returned unchanged (same reference) so callers can surface the limit.
  it("returns the list unchanged at the cap (no silent eviction)", () => {
    const full = Array.from({ length: 4 }, (_, i) => lkCapsule(`c${String(i)}`));
    const next = appendConnectorScope(full, lkCapsule("cNew"), 4);
    expect(next).toBe(full);
    expect(full.some((s) => s.kind === "capsule" && s.capsuleId === "c0")).toBe(true);
  });

  it("still de-dupes an already-connected capsule while at the cap", () => {
    const full = Array.from({ length: 4 }, (_, i) => lkCapsule(`c${String(i)}`));
    expect(appendConnectorScope(full, lkCapsule("c2"), 4)).toBe(full);
  });
});

describe("removeConnectorScope", () => {
  it("removes the matching capsule by key", () => {
    const list = [lkCapsule("c1"), lkSet("s1")];
    const result = removeConnectorScope(list, "capsule:c1");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(lkSet("s1"));
  });

  it("removes the matching capsule-set by key", () => {
    const list = [lkCapsule("c1"), lkSet("s1")];
    const result = removeConnectorScope(list, "set:s1");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(lkCapsule("c1"));
  });

  it("returns an empty list when the last scope is removed", () => {
    expect(removeConnectorScope([lkCapsule("c1")], "capsule:c1")).toEqual([]);
  });

  it("is a no-op when the key is not present", () => {
    const list = [lkCapsule("c1")];
    expect(removeConnectorScope(list, "capsule:c99")).toEqual(list);
  });
});

describe("connectorChatBind", () => {
  it("returns a capsule scope for a Connector↔Chat pair (capsule selected)", () => {
    const connector = win("connector", { selectedKind: "capsule", selectedId: "cap-abc" });
    const chat = win("chat");
    const result = connectorChatBind(connector, chat);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("capsule");
    if (result?.kind === "capsule") expect(result.capsuleId).toBe("cap-abc");
  });

  it("returns a capsule-set scope for a Connector↔Chat pair (capsule-set selected)", () => {
    const connector = win("connector", { selectedKind: "capsule-set", selectedId: "set-xyz" });
    const chat = win("chat");
    const result = connectorChatBind(connector, chat);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("capsule-set");
    if (result?.kind === "capsule-set") expect(result.capsuleSetId).toBe("set-xyz");
  });

  it("works in either order (chat first or connector first)", () => {
    const connector = win("connector", { selectedKind: "capsule", selectedId: "cap-abc" });
    const chat = win("chat");
    expect(connectorChatBind(chat, connector)).not.toBeNull();
  });

  it("returns null when no connector window is involved", () => {
    expect(connectorChatBind(win("files", { resolvedRoot: "/x" }), win("chat"))).toBeNull();
    expect(connectorChatBind(win("chat"), win("terminal"))).toBeNull();
  });

  it("returns null when the connector has no selectedId", () => {
    const connector = win("connector", { selectedKind: "capsule", selectedId: "" });
    expect(connectorChatBind(connector, win("chat"))).toBeNull();
  });

  it("returns null when the connector cfg is missing selectedKind", () => {
    const connector = win("connector", { selectedId: "cap-abc" });
    expect(connectorChatBind(connector, win("chat"))).toBeNull();
  });
});

// ─── Epic #710 #718 — linkedConnectorCapsuleIds ──────────────────────────────

function ref<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

interface ConnectHarnessOverrides {
  readonly connecting?: ConnectingState | null;
  readonly setConns?: Dispatch<SetStateAction<Connection[]>>;
  readonly onScopeBind?: (
    chatWindowId: string,
    scope: ChatConnectedScope,
  ) => boolean | Promise<boolean>;
  readonly onScopeUnbind?: (chatWindowId: string, scope: ChatConnectedScope) => void;
  readonly onConnectorBind?: (
    chatWindowId: string,
    scope: ChatLocalKnowledgeScope,
  ) => boolean | Promise<boolean>;
  readonly onConnectorUnbind?: (chatWindowId: string, scope: ChatLocalKnowledgeScope) => void;
}

function makeConnectHarness(
  wins: AppWindow[],
  conns: Connection[],
  overrides: ConnectHarnessOverrides = {},
): ReturnType<typeof makeConnectActions> {
  const winsRef = ref(wins);
  const connsRef = ref(conns);
  return makeConnectActions({
    wsRef: { current: null } as RefObject<HTMLElement | null>,
    viewRef: ref<View>({ zoom: 1, x: 0, y: 0 }),
    winsRef,
    connsRef,
    connectingRef: ref<ConnectingState | null>(overrides.connecting ?? null),
    connectCleanupRef: ref<(() => void) | null>(null),
    focus: () => undefined,
    setConns: overrides.setConns ?? ((() => undefined) as Dispatch<SetStateAction<Connection[]>>),
    setConnecting: (() => undefined) as Dispatch<SetStateAction<ConnectingState | null>>,
    onScopeBind: overrides.onScopeBind,
    onScopeUnbind: overrides.onScopeUnbind,
    onConnectorBind: overrides.onConnectorBind,
    onConnectorUnbind: overrides.onConnectorUnbind,
  });
}

function conn(a: string, b: string): Connection {
  return { id: `${a}~${b}`, a, b };
}

describe("linkedConnectorCapsuleIds (Epic #710 #718)", () => {
  it("returns empty when the quality window has no connections", () => {
    const { linkedConnectorCapsuleIds } = makeConnectHarness([win("quality", {}, "quality")], []);
    expect(linkedConnectorCapsuleIds("quality")).toEqual([]);
  });

  it("returns the capsuleId from a connected Connector window (capsule kind)", () => {
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-abc" }, "conn-1"),
      ],
      [conn("quality", "conn-1")],
    );
    expect(linkedConnectorCapsuleIds("quality")).toEqual(["cap-abc"]);
  });

  it("works when the quality window is on the b-side of the connection", () => {
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-xyz" }, "conn-1"),
      ],
      [conn("conn-1", "quality")],
    );
    expect(linkedConnectorCapsuleIds("quality")).toEqual(["cap-xyz"]);
  });

  it("returns multiple capsule ids for multiple connected Connector windows", () => {
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-1" }, "conn-1"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-2" }, "conn-2"),
      ],
      [conn("quality", "conn-1"), conn("quality", "conn-2")],
    );
    const ids = linkedConnectorCapsuleIds("quality");
    expect(ids).toHaveLength(2);
    expect(ids).toContain("cap-1");
    expect(ids).toContain("cap-2");
  });

  it("excludes capsule-set kind connectors (those flow through linkedConnectorCapsuleSetIds)", () => {
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule-set", selectedId: "set-1" }, "conn-1"),
      ],
      [conn("quality", "conn-1")],
    );
    expect(linkedConnectorCapsuleIds("quality")).toEqual([]);
  });

  it("excludes a connector with an empty selectedId", () => {
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "" }, "conn-1"),
      ],
      [conn("quality", "conn-1")],
    );
    expect(linkedConnectorCapsuleIds("quality")).toEqual([]);
  });

  it("excludes a connector with a whitespace-only selectedId (parity with the server's trim guard)", () => {
    // A blank id would reach the server and be rejected with a QI_BAD_REQUEST 400; the reader treats
    // it as "no selection" and skips it so Generate never sends an unusable capsule source.
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "   " }, "conn-1"),
      ],
      [conn("quality", "conn-1")],
    );
    expect(linkedConnectorCapsuleIds("quality")).toEqual([]);
  });

  it("deduplicates the same capsuleId from two connectors", () => {
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-dup" }, "conn-1"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-dup" }, "conn-2"),
      ],
      [conn("quality", "conn-1"), conn("quality", "conn-2")],
    );
    expect(linkedConnectorCapsuleIds("quality")).toEqual(["cap-dup"]);
  });

  it("ignores connections to non-connector windows", () => {
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [win("quality", {}, "quality"), win("files", { resolvedRoot: "/data" }, "files-1")],
      [conn("quality", "files-1")],
    );
    expect(linkedConnectorCapsuleIds("quality")).toEqual([]);
  });

  it("caps the capsule list at MAX_SCOPES when more than 16 capsule connectors are bound", () => {
    // The reader caps at MAX_SCOPES so the QI Generate request never exceeds the server's source
    // limit (mirrors the linkedAllFilesRoots cap). Without this test an off-by-one regression in the
    // `ids.length >= MAX_SCOPES` break would silently let 17+ capsule sources through.
    const connectors = Array.from({ length: 20 }, (_unused, i) =>
      win(
        "connector",
        { selectedKind: "capsule", selectedId: `cap-${String(i)}` },
        `conn-${String(i)}`,
      ),
    );
    const conns = connectors.map((w) => conn("quality", w.id));
    const { linkedConnectorCapsuleIds } = makeConnectHarness(
      [win("quality", {}, "quality"), ...connectors],
      conns,
    );
    expect(linkedConnectorCapsuleIds("quality")).toHaveLength(MAX_SCOPES);
  });
});

describe("linkedConnectorCapsuleSetIds (Epic #710 #718)", () => {
  it("returns the capsuleSetId from a connected Connector window (capsule-set kind)", () => {
    const { linkedConnectorCapsuleSetIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule-set", selectedId: "set-abc" }, "conn-1"),
      ],
      [conn("quality", "conn-1")],
    );
    expect(linkedConnectorCapsuleSetIds("quality")).toEqual(["set-abc"]);
  });

  it("excludes capsule kind connectors (those flow through linkedConnectorCapsuleIds)", () => {
    const { linkedConnectorCapsuleSetIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-1" }, "conn-1"),
      ],
      [conn("quality", "conn-1")],
    );
    expect(linkedConnectorCapsuleSetIds("quality")).toEqual([]);
  });

  it("deduplicates and returns multiple capsule-set ids", () => {
    const { linkedConnectorCapsuleSetIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule-set", selectedId: "set-1" }, "conn-1"),
        win("connector", { selectedKind: "capsule-set", selectedId: "set-1" }, "conn-2"),
        win("connector", { selectedKind: "capsule-set", selectedId: "set-2" }, "conn-3"),
      ],
      [conn("quality", "conn-1"), conn("quality", "conn-2"), conn("quality", "conn-3")],
    );
    expect(linkedConnectorCapsuleSetIds("quality")).toEqual(["set-1", "set-2"]);
  });

  it("works when the quality window is on the b-side of the connection", () => {
    const { linkedConnectorCapsuleSetIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule-set", selectedId: "set-xyz" }, "conn-1"),
      ],
      [conn("conn-1", "quality")],
    );
    expect(linkedConnectorCapsuleSetIds("quality")).toEqual(["set-xyz"]);
  });

  it("excludes a connector with an empty selectedId", () => {
    const { linkedConnectorCapsuleSetIds } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule-set", selectedId: "" }, "conn-1"),
      ],
      [conn("quality", "conn-1")],
    );
    expect(linkedConnectorCapsuleSetIds("quality")).toEqual([]);
  });

  it("ignores connections to non-connector windows", () => {
    const { linkedConnectorCapsuleSetIds } = makeConnectHarness(
      [win("quality", {}, "quality"), win("files", { resolvedRoot: "/data" }, "files-1")],
      [conn("quality", "files-1")],
    );
    expect(linkedConnectorCapsuleSetIds("quality")).toEqual([]);
  });

  it("caps the capsule-set list at MAX_SCOPES when more than 16 capsule-set connectors are bound", () => {
    const connectors = Array.from({ length: 20 }, (_unused, i) =>
      win(
        "connector",
        { selectedKind: "capsule-set", selectedId: `set-${String(i)}` },
        `conn-${String(i)}`,
      ),
    );
    const conns = connectors.map((w) => conn("quality", w.id));
    const { linkedConnectorCapsuleSetIds } = makeConnectHarness(
      [win("quality", {}, "quality"), ...connectors],
      conns,
    );
    expect(linkedConnectorCapsuleSetIds("quality")).toHaveLength(MAX_SCOPES);
  });
});

describe("makeMutations.add — QI run-card dedup (#270)", () => {
  function harness(): {
    add: ReturnType<typeof makeMutations>["add"];
    cards: () => readonly AppWindow[];
  } {
    let wins: AppWindow[] | null = [];
    const setWins: Dispatch<SetStateAction<AppWindow[] | null>> = (fn) => {
      wins = typeof fn === "function" ? fn(wins) : fn;
    };
    const zc = { current: 0 };
    const worldVP = (): { x: number; y: number; w: number; h: number } => ({
      x: 0,
      y: 0,
      w: 1000,
      h: 800,
    });
    const { add } = makeMutations({ setWins, zc, worldVP });
    return { add, cards: () => (wins ?? []).filter((w) => w.type === "qiRun") };
  }

  it("focuses the existing card when the same runId is opened again (no duplicate)", () => {
    const h = harness();
    const id1 = h.add("qiRun", { runId: "qi-run-1" });
    const id2 = h.add("qiRun", { runId: "qi-run-1" });
    expect(id2).toBe(id1);
    expect(h.cards()).toHaveLength(1);
  });

  it("opens a separate card for a different runId", () => {
    const h = harness();
    h.add("qiRun", { runId: "qi-run-1" });
    h.add("qiRun", { runId: "qi-run-2" });
    expect(h.cards()).toHaveLength(2);
  });
});

describe("makeMutations.maximize", () => {
  function harness(
    initial: AppWindow[],
    vp = { x: 0, y: 0, w: 1000, h: 800 },
  ): {
    maximize: ReturnType<typeof makeMutations>["maximize"];
    windows: () => readonly AppWindow[];
  } {
    let wins: AppWindow[] | null = initial;
    const setWins: Dispatch<SetStateAction<AppWindow[] | null>> = (fn) => {
      wins = typeof fn === "function" ? fn(wins) : fn;
    };
    const { maximize } = makeMutations({
      setWins,
      zc: { current: 10 },
      worldVP: () => vp,
    });
    return { maximize, windows: () => wins ?? [] };
  }

  it("restores a maximized window to its previous frame", () => {
    const h = harness([
      {
        ...win("files", {}, "files-1"),
        x: 20,
        y: 30,
        w: 300,
        h: 340,
      },
    ]);

    h.maximize("files-1");
    expect(h.windows()[0]).toMatchObject({
      max: true,
      prev: { x: 20, y: 30, w: 300, h: 340 },
      x: 0,
      y: 0,
      w: 1000,
      h: 800,
    });

    h.maximize("files-1");
    expect(h.windows()[0]).toMatchObject({
      max: false,
      x: 20,
      y: 30,
      w: 300,
      h: 340,
    });
    expect(h.windows()[0]?.prev).toBeUndefined();
  });

  it("recovers a maximized window without prev to the type default frame", () => {
    const type = "files";
    const h = harness([
      {
        ...win(type, {}, "files-1"),
        x: 0,
        y: 0,
        w: 1000,
        h: 800,
        max: true,
      },
    ]);

    h.maximize("files-1");

    expect(h.windows()[0]).toMatchObject({
      max: false,
      w: WIN_TYPES[type].w,
      h: WIN_TYPES[type].h,
    });
    expect(h.windows()[0]?.x).toBeGreaterThan(0);
    expect(h.windows()[0]?.y).toBeGreaterThan(0);
    expect(h.windows()[0]?.prev).toBeUndefined();
  });
});

describe("makeMutations.minimize/restore", () => {
  function harness(initial: AppWindow[]): {
    minimize: ReturnType<typeof makeMutations>["minimize"];
    restore: ReturnType<typeof makeMutations>["restore"];
    windows: () => readonly AppWindow[];
  } {
    let wins: AppWindow[] | null = initial;
    const setWins: Dispatch<SetStateAction<AppWindow[] | null>> = (fn) => {
      wins = typeof fn === "function" ? fn(wins) : fn;
    };
    const { minimize, restore } = makeMutations({
      setWins,
      zc: { current: 10 },
      worldVP: () => ({ x: 0, y: 0, w: 1000, h: 800 }),
    });
    return { minimize, restore, windows: () => wins ?? [] };
  }

  it("marks a window minimized without removing it", () => {
    const h = harness([win("files", {}, "files-1")]);

    h.minimize("files-1");

    expect(h.windows()).toHaveLength(1);
    expect(h.windows()[0]).toMatchObject({ id: "files-1", minimized: true });
  });

  it("restores a minimized window and raises it", () => {
    const h = harness([{ ...win("files", {}, "files-1"), minimized: true, z: 3 }]);

    h.restore("files-1");

    expect(h.windows()[0]).toMatchObject({ id: "files-1", minimized: false, z: 11 });
  });
});

describe("makeMutations.toggleTool — Local Knowledge singleton", () => {
  it("opens one Local Knowledge tool window and closes it on the next toggle", () => {
    let wins: AppWindow[] | null = [];
    const setWins: Dispatch<SetStateAction<AppWindow[] | null>> = (fn) => {
      wins = typeof fn === "function" ? fn(wins) : fn;
    };
    const { toggleTool } = makeMutations({
      setWins,
      zc: { current: 0 },
      worldVP: () => ({ x: 0, y: 0, w: 1000, h: 800 }),
    });

    toggleTool("localKnowledge");
    expect(wins?.filter((w) => w.type === "localKnowledge")).toHaveLength(1);

    toggleTool("localKnowledge");
    expect(wins?.filter((w) => w.type === "localKnowledge")).toHaveLength(0);
  });
});

// ─── Epic #729 #731 — linkedAllFilesRoots (N+1 multiple folders reader) ──────────

describe("linkedAllFilesRoots (Epic #729 #731)", () => {
  it("returns empty when the quality window has no connections", () => {
    const { linkedAllFilesRoots } = makeConnectHarness([win("quality", {}, "quality")], []);
    expect(linkedAllFilesRoots("quality")).toEqual([]);
  });

  it("returns BOTH roots for two connected Files windows (not just the first)", () => {
    const { linkedAllFilesRoots } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("files", { resolvedRoot: "/work/a" }, "files-1"),
        win("files", { resolvedRoot: "/work/b" }, "files-2"),
      ],
      [conn("quality", "files-1"), conn("quality", "files-2")],
    );
    expect(linkedAllFilesRoots("quality")).toEqual(["/work/a", "/work/b"]);
  });

  it("works when the quality window is on the b-side of the connection", () => {
    const { linkedAllFilesRoots } = makeConnectHarness(
      [win("quality", {}, "quality"), win("files", { resolvedRoot: "/work/c" }, "files-1")],
      [conn("files-1", "quality")],
    );
    expect(linkedAllFilesRoots("quality")).toEqual(["/work/c"]);
  });

  it("deduplicates the same root connected from two Files windows", () => {
    const { linkedAllFilesRoots } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("files", { resolvedRoot: "/work/dup" }, "files-1"),
        win("files", { resolvedRoot: "/work/dup" }, "files-2"),
      ],
      [conn("quality", "files-1"), conn("quality", "files-2")],
    );
    expect(linkedAllFilesRoots("quality")).toEqual(["/work/dup"]);
  });

  it("excludes a Files window with only the 'src' sentinel (no real root to bind)", () => {
    const { linkedAllFilesRoots } = makeConnectHarness(
      [win("quality", {}, "quality"), win("files", {}, "files-1")],
      [conn("quality", "files-1")],
    );
    expect(linkedAllFilesRoots("quality")).toEqual([]);
  });

  it("excludes non-Files connected windows", () => {
    const { linkedAllFilesRoots } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-1" }, "conn-1"),
      ],
      [conn("quality", "conn-1")],
    );
    expect(linkedAllFilesRoots("quality")).toEqual([]);
  });

  it("caps the list at MAX_SCOPES when more than 16 Files windows are connected", () => {
    const filesWins = Array.from({ length: 20 }, (_unused, i) =>
      win("files", { resolvedRoot: `/work/f${String(i)}` }, `files-${String(i)}`),
    );
    const conns = filesWins.map((w) => conn("quality", w.id));
    const { linkedAllFilesRoots } = makeConnectHarness(
      [win("quality", {}, "quality"), ...filesWins],
      conns,
    );
    expect(linkedAllFilesRoots("quality")).toHaveLength(MAX_SCOPES);
  });
});

// ─── Epic #709 #714 — linkedFilesContext (single-file binding window selection) ──

describe("linkedFilesContext (Epic #709 #714)", () => {
  it("returns null when the hub has no connected Files windows", () => {
    const { linkedFilesContext } = makeConnectHarness([win("quality", {}, "quality")], []);
    expect(linkedFilesContext("quality")).toBeNull();
  });

  it("reaches a Files window connected AFTER a connector edge — the connector must not hide it", () => {
    // A connector edge preceding the files edge previously made linkedFilesContext return null on the
    // first (non-files) connection and stop, dropping the focused file + folder root entirely.
    const { linkedFilesContext, linkedFilesRoot } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-1" }, "conn-1"),
        win("files", { resolvedRoot: "/work/spec", activeFilePath: "fk.md" }, "files-1"),
      ],
      [conn("quality", "conn-1"), conn("quality", "files-1")],
    );
    const ctx = linkedFilesContext("quality");
    expect(ctx?.root).toBe("/work/spec");
    expect(ctx?.activeFilePath).toBe("fk.md");
    expect(linkedFilesRoot("quality")).toBe("/work/spec");
  });

  it("returns the FOCUSED Files window's context even when another was connected first", () => {
    // files-1 (connected first) has no focused file; files-2 (higher z) does. The focused file must
    // win so it becomes the single-file run source, not be silently dropped to a folder binding.
    const { linkedFilesContext } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        { ...win("files", { resolvedRoot: "/work/a" }, "files-1"), z: 1 },
        {
          ...win("files", { resolvedRoot: "/work/b", activeFilePath: "spec.md" }, "files-2"),
          z: 2,
        },
      ],
      [conn("quality", "files-1"), conn("quality", "files-2")],
    );
    const ctx = linkedFilesContext("quality");
    expect(ctx?.root).toBe("/work/b");
    expect(ctx?.activeFilePath).toBe("spec.md");
  });

  it("prefers the highest-z (most recently focused) connected Files window that has a focused file", () => {
    const { linkedFilesContext } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        { ...win("files", { resolvedRoot: "/work/a", activeFilePath: "a.md" }, "files-1"), z: 9 },
        { ...win("files", { resolvedRoot: "/work/b", activeFilePath: "b.md" }, "files-2"), z: 3 },
      ],
      [conn("quality", "files-1"), conn("quality", "files-2")],
    );
    expect(linkedFilesContext("quality")?.activeFilePath).toBe("a.md");
  });

  it("falls back to the highest-z Files window when none has a focused file (folder binding)", () => {
    const { linkedFilesContext } = makeConnectHarness(
      [
        win("quality", {}, "quality"),
        { ...win("files", { resolvedRoot: "/work/a" }, "files-1"), z: 2 },
        { ...win("files", { resolvedRoot: "/work/b" }, "files-2"), z: 7 },
      ],
      [conn("quality", "files-1"), conn("quality", "files-2")],
    );
    const ctx = linkedFilesContext("quality");
    expect(ctx?.root).toBe("/work/b");
    expect(ctx?.activeFilePath).toBeUndefined();
  });

  // Audit finding (b): a Files window with no configured root must not fabricate "src" as root.
  it("returns null when the connected Files window has no real root (no 'src' sentinel)", () => {
    const { linkedFilesContext, linkedFilesRoot } = makeConnectHarness(
      [win("quality", {}, "quality"), win("files", {}, "files-1")],
      [conn("quality", "files-1")],
    );
    expect(linkedFilesContext("quality")).toBeNull();
    expect(linkedFilesRoot("quality")).toBeNull();
  });
});

// Audit finding (c): QI Generate path — quality window linked to a rootless Files window must not
// produce a "src" workspace source (which would cause a server-side 400 or stale-CWD ingest).
describe("linkedFilesRoot for quality window with rootless Files (audit finding c)", () => {
  it("returns null so buildConnectedRunSources receives no workspace source", () => {
    const { linkedFilesRoot } = makeConnectHarness(
      [win("quality", {}, "quality"), win("files", {}, "files-1")],
      [conn("quality", "files-1")],
    );
    // A null linkedRoot means connectedRoot=null in buildConnectedRunSources, so rawRoots=[] and
    // no workspace source is added — the QI Generate request stays clean.
    expect(linkedFilesRoot("quality")).toBeNull();
  });
});

// Release 0.2.0 — the bind callback may VETO the edge (source limit reached): no edge is drawn,
// so the workspace never shows a connection that does not ground anything. Accepted binds snapshot
// WHAT they bound onto the Connection so unbind paths survive later cfg changes.
describe("confirmConnect — bind veto + bind-time snapshot (Release 0.2.0)", () => {
  const evt = {
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as Parameters<ReturnType<typeof makeConnectActions>["confirmConnect"]>[1];

  function collectingSetConns(store: {
    conns: Connection[];
  }): Dispatch<SetStateAction<Connection[]>> {
    return (action) => {
      store.conns = typeof action === "function" ? action(store.conns) : action;
    };
  }

  async function flushAsyncBind(): Promise<void> {
    await Promise.resolve();
  }

  it("does not draw the edge when onScopeBind vetoes the bind", async () => {
    const store = { conns: [] as Connection[] };
    const harness = makeConnectHarness(
      [win("files", { resolvedRoot: "/data/docs" }, "files-1"), win("chat", {}, "chat-1")],
      [],
      {
        connecting: { from: "files-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onScopeBind: () => false,
      },
    );
    harness.confirmConnect("chat-1", evt);
    await flushAsyncBind();
    expect(store.conns).toHaveLength(0);
  });

  it("draws a quality↔connector edge WITHOUT firing the chat onConnectorBind callback (#710 #718)", async () => {
    // The QI hub reads a connected connector's capsule per-render (linkedConnectorCapsuleIds); it must
    // NOT go through the chat localKnowledgeScopes bind path. connectorChatBind requires one side to be
    // a chat window, so for a quality↔connector pair it returns null, chatWindowId stays null, and
    // onConnectorBind is never invoked — yet the relationship edge is still drawn so the reader sees it.
    const store = { conns: [] as Connection[] };
    let connectorBindCalls = 0;
    const harness = makeConnectHarness(
      [
        win("quality", {}, "quality-1"),
        win("connector", { selectedKind: "capsule", selectedId: "cap-abc" }, "conn-1"),
      ],
      [],
      {
        connecting: { from: "quality-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onConnectorBind: () => {
          connectorBindCalls += 1;
          return true;
        },
      },
    );
    harness.confirmConnect("conn-1", evt);
    await flushAsyncBind();
    expect(connectorBindCalls).toBe(0);
    expect(store.conns).toHaveLength(1);
    // The edge carries no chat-bind snapshot fields — it is a plain relationship edge the QI hub reads.
    expect(store.conns[0]?.boundConnectorId).toBeUndefined();
    expect(store.conns[0]?.boundChatWindowId).toBeUndefined();
  });

  it("draws the edge with a boundRoot snapshot when onScopeBind accepts", async () => {
    const store = { conns: [] as Connection[] };
    const harness = makeConnectHarness(
      [win("files", { resolvedRoot: "/data/docs" }, "files-1"), win("chat", {}, "chat-1")],
      [],
      {
        connecting: { from: "files-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onScopeBind: () => true,
      },
    );
    harness.confirmConnect("chat-1", evt);
    await flushAsyncBind();
    expect(store.conns).toHaveLength(1);
    expect(store.conns[0]?.boundRoot).toBe("/data/docs");
    expect(store.conns[0]?.boundScopeKind).toBe("workspace-root");
    expect(store.conns[0]?.boundRelativePath).toBeUndefined();
  });

  it("draws the edge with the visible directory scope when a Files card is inside a folder", async () => {
    const store = { conns: [] as Connection[] };
    const bound: ChatConnectedScope[] = [];
    const harness = makeConnectHarness(
      [
        win("files", { resolvedRoot: "/data/docs", activeDirectoryPath: "src" }, "files-1"),
        win("chat", {}, "chat-1"),
      ],
      [],
      {
        connecting: { from: "files-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onScopeBind: (_chatWindowId, scope) => {
          bound.push(scope);
          return true;
        },
      },
    );
    harness.confirmConnect("chat-1", evt);
    await flushAsyncBind();
    expect(bound[0]).toMatchObject({
      kind: "directory",
      relativePaths: ["src"],
      root: "/data/docs",
    });
    expect(store.conns[0]).toMatchObject({
      boundRoot: "/data/docs",
      boundScopeKind: "directory",
      boundRelativePath: "src",
    });
  });

  it("draws the edge with the previewed file scope when a file is open", async () => {
    const store = { conns: [] as Connection[] };
    const harness = makeConnectHarness(
      [
        win(
          "files",
          { resolvedRoot: "/data/docs", activeDirectoryPath: "src", activeFilePath: "src/a.ts" },
          "files-1",
        ),
        win("chat", {}, "chat-1"),
      ],
      [],
      {
        connecting: { from: "files-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onScopeBind: () => true,
      },
    );
    harness.confirmConnect("chat-1", evt);
    await flushAsyncBind();
    expect(store.conns[0]).toMatchObject({
      boundRoot: "/data/docs",
      boundScopeKind: "files",
      boundRelativePath: "src/a.ts",
    });
  });

  it("does not draw the edge when onScopeBind resolves false after persistence failure", async () => {
    const store = { conns: [] as Connection[] };
    const harness = makeConnectHarness(
      [win("files", { resolvedRoot: "/data/docs" }, "files-1"), win("chat", {}, "chat-1")],
      [],
      {
        connecting: { from: "files-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onScopeBind: async () => false,
      },
    );
    harness.confirmConnect("chat-1", evt);
    await flushAsyncBind();
    expect(store.conns).toHaveLength(0);
  });

  it("draws the edge after onScopeBind resolves true", async () => {
    const store = { conns: [] as Connection[] };
    const harness = makeConnectHarness(
      [win("files", { resolvedRoot: "/data/docs" }, "files-1"), win("chat", {}, "chat-1")],
      [],
      {
        connecting: { from: "files-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onScopeBind: async () => true,
      },
    );
    harness.confirmConnect("chat-1", evt);
    expect(store.conns).toHaveLength(0);
    await flushAsyncBind();
    expect(store.conns).toHaveLength(1);
    expect(store.conns[0]?.boundRoot).toBe("/data/docs");
  });

  it("does not draw the edge when onConnectorBind vetoes the bind", async () => {
    const store = { conns: [] as Connection[] };
    const harness = makeConnectHarness(
      [
        win("connector", { selectedKind: "capsule", selectedId: "cap-a" }, "conn-1"),
        win("chat", {}, "chat-1"),
      ],
      [],
      {
        connecting: { from: "conn-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onConnectorBind: () => false,
      },
    );
    harness.confirmConnect("chat-1", evt);
    await flushAsyncBind();
    expect(store.conns).toHaveLength(0);
  });

  it("draws the edge with a connector snapshot when onConnectorBind accepts", async () => {
    const store = { conns: [] as Connection[] };
    const harness = makeConnectHarness(
      [
        win("connector", { selectedKind: "capsule", selectedId: "cap-a" }, "conn-1"),
        win("chat", {}, "chat-1"),
      ],
      [],
      {
        connecting: { from: "conn-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
        onConnectorBind: () => true,
      },
    );
    harness.confirmConnect("chat-1", evt);
    await flushAsyncBind();
    expect(store.conns).toHaveLength(1);
    expect(store.conns[0]?.boundConnectorKind).toBe("capsule");
    expect(store.conns[0]?.boundConnectorId).toBe("cap-a");
  });

  it("still draws non-binding edges when no callbacks are wired", async () => {
    const store = { conns: [] as Connection[] };
    const harness = makeConnectHarness(
      [win("files", { resolvedRoot: "/data/docs" }, "files-1"), win("quality", {}, "quality")],
      [],
      {
        connecting: { from: "files-1", x: 0, y: 0 },
        setConns: collectingSetConns(store),
      },
    );
    harness.confirmConnect("quality", evt);
    await flushAsyncBind();
    expect(store.conns).toHaveLength(1);
  });
});

// Release 0.2.0 — unbind must remove the source the edge BOUND, not whatever the window's cfg
// points at NOW (the user may have navigated the Files window / re-selected another capsule).
describe("removeConn — unbinds the bind-time snapshot, not the current cfg", () => {
  it("unbinds the bound capsule even after the connector window selected another capsule", () => {
    const unbound: ChatLocalKnowledgeScope[] = [];
    const connector = win(
      "connector",
      // The window cfg has MOVED ON to cap-b since the bind.
      { selectedKind: "capsule", selectedId: "cap-b" },
      "conn-1",
    );
    const chat = win("chat", {}, "chat-1");
    const edge: Connection = {
      id: "conn-1~chat-1",
      a: "conn-1",
      b: "chat-1",
      boundConnectorKind: "capsule",
      boundConnectorId: "cap-a",
    };
    const harness = makeConnectHarness([connector, chat], [edge], {
      onConnectorUnbind: (_chatWindowId, scope) => {
        unbound.push(scope);
      },
    });
    harness.removeConn("conn-1~chat-1");
    expect(unbound).toHaveLength(1);
    expect(unbound[0]).toMatchObject({ kind: "capsule", capsuleId: "cap-a" });
  });

  it("unbinds the bound root even after the Files window navigated elsewhere", () => {
    const unbound: ChatConnectedScope[] = [];
    const files = win("files", { resolvedRoot: "/data/other" }, "files-1");
    const chat = win("chat", {}, "chat-1");
    const edge: Connection = {
      id: "files-1~chat-1",
      a: "files-1",
      b: "chat-1",
      boundRoot: "/data/docs",
    };
    const harness = makeConnectHarness([files, chat], [edge], {
      onScopeUnbind: (_chatWindowId, scope) => {
        unbound.push(scope);
      },
    });
    harness.removeConn("files-1~chat-1");
    expect(unbound[0]).toMatchObject({
      kind: "workspace-root",
      relativePaths: [],
      root: "/data/docs",
    });
  });

  it("unbinds the bound directory even after the Files window navigated elsewhere", () => {
    const unbound: ChatConnectedScope[] = [];
    const files = win("files", { resolvedRoot: "/data/other" }, "files-1");
    const chat = win("chat", {}, "chat-1");
    const edge: Connection = {
      id: "files-1~chat-1",
      a: "files-1",
      b: "chat-1",
      boundRoot: "/data/docs",
      boundScopeKind: "directory",
      boundRelativePath: "src",
    };
    const harness = makeConnectHarness([files, chat], [edge], {
      onScopeUnbind: (_chatWindowId, scope) => {
        unbound.push(scope);
      },
    });
    harness.removeConn("files-1~chat-1");
    expect(unbound[0]).toMatchObject({
      kind: "directory",
      relativePaths: ["src"],
      root: "/data/docs",
    });
  });

  it("falls back to cfg-derivation for pre-snapshot edges", () => {
    const unbound: ChatConnectedScope[] = [];
    const files = win("files", { resolvedRoot: "/data/docs", activeFilePath: "a.ts" }, "files-1");
    const chat = win("chat", {}, "chat-1");
    const harness = makeConnectHarness([files, chat], [conn("files-1", "chat-1")], {
      onScopeUnbind: (_chatWindowId, scope) => {
        unbound.push(scope);
      },
    });
    harness.removeConn("files-1~chat-1");
    expect(unbound[0]).toMatchObject({
      kind: "files",
      relativePaths: ["a.ts"],
      root: "/data/docs",
    });
  });
});

// ─── AC2 Chat-parity drift guard (Issue #731 / Epic #729) ────────────────────
//
// MAX_SCOPES (the QI hub's connected-source cap, workspaceActions.ts) and
// DEFAULT_GROUNDING_LIMITS.maxConnectedSources (Chat's grounding cap from
// @oscharko-dev/keiko-contracts) must stay in sync. A change to one without
// updating the other silently breaks the parity contract: Chat users would see
// a different source limit than QI users.
//
// Server-side precedent: runIngestion.test.ts pins the same invariant against
// DEFAULT_GROUNDING_LIMITS.maxConnectedSources (Issue #730 / #731 audit).
// This test extends that guard to the UI layer.
describe("MAX_SCOPES — AC2 Chat-parity drift guard (Issue #731 / Epic #729)", () => {
  it("matches DEFAULT_GROUNDING_LIMITS.maxConnectedSources so the QI hub cap stays in sync with Chat", () => {
    // If Chat's grounding default changes, this test will fail and force an intentional
    // decision about whether MAX_SCOPES should change too. The alternative — silently
    // leaving the values misaligned — would mean QI accepts a different number of sources
    // than Chat, violating the N+1 parity AC.
    expect(MAX_SCOPES).toBe(DEFAULT_GROUNDING_LIMITS.maxConnectedSources);
  });
});
