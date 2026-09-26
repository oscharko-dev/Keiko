// The workspace members the dependency bootstrap checks (ADR-0043 D17): every folder npm would
// install a member from, found as npm finds it, over real folders and the production workspace port.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { workspaceMemberRoots, type WorkspaceMemberLimits } from "./workspaceMembers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A canonical workspace root holding `folders`, each relative to it.
function workspace(...folders: readonly string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-members-")));
  roots.push(root);
  for (const folder of folders) mkdirSync(join(root, folder), { recursive: true });
  return root;
}

// The members relative to the root, as a set: the resolver promises no order.
function members(
  root: string,
  patterns: readonly string[],
  limits?: WorkspaceMemberLimits,
): ReadonlySet<string> | undefined {
  const found = workspaceMemberRoots(root, patterns, nodeWorkspaceFs, limits);
  return found === undefined ? undefined : new Set(found.map((member) => relative(root, member)));
}

describe("workspaceMemberRoots", () => {
  it("resolves a wildcard to each folder, never a dot-folder, node_modules or a file", () => {
    const root = workspace("packages/a", "packages/b", "packages/.hidden", "packages/node_modules");
    writeFileSync(join(root, "packages", "notes.txt"), "");
    expect(members(root, ["packages/*"])).toEqual(new Set(["packages/a", "packages/b"]));
  });

  it("matches a dot-folder when the pattern spells out the dot", () => {
    const root = workspace("config/.tools", "config/plain");
    expect(members(root, ["config/.*"])).toEqual(new Set(["config/.tools"]));
  });

  it("resolves literal folders and a wildcard inside a name", () => {
    // my-app-web holds each pattern's inner parts, but neither its prefix nor its suffix.
    const root = workspace(
      "tools/cli",
      "packages/app-web",
      "packages/web-app",
      "packages/my-app-web",
      "packages/lib",
    );
    expect(members(root, ["./tools/cli", "packages/app-*", "packages/*-a*p"])).toEqual(
      new Set(["tools/cli", "packages/app-web", "packages/web-app"]),
    );
  });

  it.each([
    ["ab*ba", "aba", "abba"],
    ["a*bc*c", "abc", "abcc"],
  ])(
    "never lets the parts of the wildcard %j overlap: %j is no match, %j is",
    (pattern, overlap, match) => {
      const root = workspace(`packages/${overlap}`, `packages/${match}`);
      expect(members(root, [`packages/${pattern}`])).toEqual(new Set([`packages/${match}`]));
    },
  );

  it("resolves ** to the folder itself and every folder below it, skipping node_modules and dot-folders", () => {
    const root = workspace("apps/web/src", "apps/node_modules/x", "apps/.cache/y");
    expect(members(root, ["apps/**"])).toEqual(new Set(["apps", "apps/web", "apps/web/src"]));
  });

  it("resolves ** followed by the rest of the pattern", () => {
    const root = workspace("apps/one/pkg", "apps/two/nested/pkg", "apps/three");
    expect(members(root, ["apps/**/pkg"])).toEqual(
      new Set(["apps/one/pkg", "apps/two/nested/pkg"]),
    );
  });

  it("keeps the members a negated pattern names, because a negation only ever removes", () => {
    const root = workspace("packages/a", "packages/legacy");
    expect(members(root, ["packages/*", "!packages/legacy"])).toEqual(
      new Set(["packages/a", "packages/legacy"]),
    );
  });

  it("finds nothing where a pattern names no folder, and nothing inside node_modules", () => {
    const root = workspace("node_modules/x");
    expect(members(root, ["packages/*", "tools/cli", "node_modules/*"])).toEqual(new Set());
  });

  it.each(["packages/{a,b}", "packages/?", "packages/[ab]", "packages/@(a|b)"])(
    "does not resolve glob syntax beyond * and **: %j",
    (pattern) => {
      const root = workspace("packages/a", "packages/b");
      expect(members(root, [pattern])).toBeUndefined();
    },
  );

  it("follows a symbolic link that stays inside the workspace", () => {
    const root = workspace("vendor/real", "packages");
    symlinkSync(join(root, "vendor", "real"), join(root, "packages", "linked"), "dir");
    expect(members(root, ["packages/*"])).toEqual(new Set(["vendor/real"]));
  });

  it("does not resolve a folder a symbolic link places outside the workspace", () => {
    const outside = workspace("elsewhere");
    const root = workspace("packages", "apps");
    symlinkSync(join(outside, "elsewhere"), join(root, "packages", "escape"), "dir");
    symlinkSync(join(outside, "elsewhere"), join(root, "apps", "escape"), "dir");
    expect(members(root, ["packages/*"])).toBeUndefined();
    expect(members(root, ["packages/escape"])).toBeUndefined();
    expect(members(root, ["apps/**"])).toBeUndefined();
  });

  it("does not resolve a search past its bounds", () => {
    const root = workspace("packages/a", "packages/b", "packages/c");
    expect(members(root, ["packages/*"], { maxFolders: 4, maxEntries: 10 })).toBeUndefined();
    expect(members(root, ["packages/*"], { maxFolders: 10, maxEntries: 2 })).toBeUndefined();
    expect(members(root, ["packages/*"], { maxFolders: 5, maxEntries: 3 })).toEqual(
      new Set(["packages/a", "packages/b", "packages/c"]),
    );
  });
});
