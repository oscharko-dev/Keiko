import { describe, expect, it } from "vitest";
import type { ChatConnectedScope } from "@/lib/types";
import { pinnedFilesScope } from "./workspaceActions";

const folder: ChatConnectedScope = {
  kind: "directory",
  root: "/repo",
  relativePaths: ["src"],
  connectedAtMs: 1,
};
const file: ChatConnectedScope = { ...folder, kind: "files", relativePaths: ["src/a.ts"] };

describe("chat-owned folder pin", () => {
  it("keeps the unique canonical folder on later previews", () => {
    expect(pinnedFilesScope(file, [folder], true)).toBe(folder);
  });
  it("waits while the keep-folder acknowledgement is pending or ambiguous", () => {
    expect(pinnedFilesScope(file, [file], true)).toBeNull();
    expect(pinnedFilesScope(file, undefined, true)).toBeNull();
    expect(pinnedFilesScope(file, [folder, { ...folder }], true)).toBeNull();
  });
  it("preserves explicit navigation and releases on another root", () => {
    expect(pinnedFilesScope(file, [folder], false)).toBe(file);
    expect(pinnedFilesScope(folder, [file], true)).toBe(folder);
    const other = { ...file, root: "/other" };
    expect(pinnedFilesScope(other, [folder], true)).toBe(other);
  });
});
