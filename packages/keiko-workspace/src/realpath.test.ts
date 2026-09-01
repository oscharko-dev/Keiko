import { describe, expect, it } from "vitest";

import { realRootIsDeniedViaSymlink } from "./realpath.js";

describe("realRootIsDeniedViaSymlink", () => {
  it("rejects a different denied segment introduced under an already-denied lexical root", () => {
    expect(realRootIsDeniedViaSymlink("/work/.aws/project", "/work/node_modules/project")).toBe(
      true,
    );
  });

  it("rejects relocation between separate loci with the same denied segment", () => {
    expect(
      realRootIsDeniedViaSymlink("/work/other/.codex", "/work/.codex/worktrees/project/docs"),
    ).toBe(true);
    expect(
      realRootIsDeniedViaSymlink(
        "/other/.codex/worktrees/project",
        "/safe/.codex/worktrees/project",
      ),
    ).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "allows an unchanged denied ancestor across a known macOS platform alias",
    () => {
      expect(
        realRootIsDeniedViaSymlink(
          "/private/var/tmp/.codex/worktrees/project",
          "/var/tmp/.codex/worktrees/project",
        ),
      ).toBe(false);
    },
  );

  it("rejects an arbitrary private-prefix relocation", () => {
    expect(
      realRootIsDeniedViaSymlink(
        "/private/Users/dev/.codex/worktrees/project",
        "/Users/dev/.codex/worktrees/project",
      ),
    ).toBe(true);
  });
});
