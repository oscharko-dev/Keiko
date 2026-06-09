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
  effectiveLocalKnowledgeScopes,
  effectiveScopes,
  filesChatBindRoot,
  makeConnectActions,
  makeMutations,
  removeConnectorScope,
  removeScope,
  resolvedFilesRoot,
} from "./workspaceActions";
import type { AppWindow, Connection, ConnectingState, View } from "../windows/types";
import type { ChatConnectedScope, ChatLocalKnowledgeScope } from "@/lib/types";

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

  it("caps the list at MAX_SCOPES, dropping the oldest", () => {
    const full = Array.from({ length: MAX_SCOPES }, (_unused, i) => scope(`/d${String(i)}`));
    const next = appendScope(full, "/new", 1);
    expect(next).toHaveLength(MAX_SCOPES);
    expect(next?.some((s) => s.root === "/new")).toBe(true);
    expect(next?.some((s) => s.root === "/d0")).toBe(false);
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

  it("caps the list at max, dropping the oldest", () => {
    const full = Array.from({ length: 4 }, (_, i) => lkCapsule(`c${String(i)}`));
    const next = appendConnectorScope(full, lkCapsule("cNew"), 4);
    expect(next).toHaveLength(4);
    expect(next.some((s) => s.kind === "capsule" && s.capsuleId === "cNew")).toBe(true);
    expect(next.some((s) => s.kind === "capsule" && s.capsuleId === "c0")).toBe(false);
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

function makeConnectHarness(
  wins: AppWindow[],
  conns: Connection[],
): ReturnType<typeof makeConnectActions> {
  const winsRef = ref(wins);
  const connsRef = ref(conns);
  return makeConnectActions({
    wsRef: { current: null } as RefObject<HTMLElement | null>,
    viewRef: ref<View>({ zoom: 1, x: 0, y: 0 }),
    winsRef,
    connsRef,
    connectingRef: ref<ConnectingState | null>(null),
    connectCleanupRef: ref<(() => void) | null>(null),
    focus: () => undefined,
    setConns: (() => undefined) as Dispatch<SetStateAction<Connection[]>>,
    setConnecting: (() => undefined) as Dispatch<SetStateAction<ConnectingState | null>>,
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

  it("excludes capsule-set kind connectors (only capsule kind is a QI inline source)", () => {
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
