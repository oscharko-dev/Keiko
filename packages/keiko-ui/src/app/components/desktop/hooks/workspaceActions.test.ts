// Epic #532 — pure scope-list + Files↔Chat binding helpers used by the relationship-edge wiring.

import { describe, expect, it } from "vitest";
import {
  MAX_SCOPES,
  appendScope,
  effectiveScopes,
  filesChatBindRoot,
  removeScope,
  resolvedFilesRoot,
} from "./workspaceActions";
import type { AppWindow } from "../windows/types";
import type { ChatConnectedScope } from "@/lib/types";

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
