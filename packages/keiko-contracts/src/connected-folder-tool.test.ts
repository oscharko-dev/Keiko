import { describe, expect, it } from "vitest";
import {
  CONNECTED_FOLDER_TOOL_LIMITS,
  captureConnectedFolderToolRequest,
  isConnectedFolderToolRequest,
} from "./connected-folder-tool.js";
import { WORKSPACE_PATH_DISCOVERY_LIMITS } from "./workspace.js";

describe("connected folder tool request", () => {
  it.each([
    ["the first page of the root", { view: "list", directory: "", after: "" }],
    ["a later page", { view: "list", directory: "docs", after: "docs/m.md" }],
    [
      "a keyword search",
      { view: "search", mode: "keywords", query: "Budget Q2", directory: "", maxResults: 1 },
    ],
    [
      "a literal search at the limits",
      {
        view: "search",
        mode: "literal",
        query: "x".repeat(CONNECTED_FOLDER_TOOL_LIMITS.queryChars),
        directory: "a/b",
        maxResults: CONNECTED_FOLDER_TOOL_LIMITS.searchHits,
      },
    ],
    [
      "a read at the limits",
      {
        view: "read",
        path: "a/b.md",
        startLine: 1,
        maxLines: CONNECTED_FOLDER_TOOL_LIMITS.readLines,
      },
    ],
  ])("accepts %s and captures a frozen copy", (_name, request) => {
    const captured = captureConnectedFolderToolRequest(request);
    expect(captured).toEqual(request);
    expect(captured).not.toBe(request);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("keeps the captured request when the caller changes its own object afterwards", () => {
    const request = { view: "read", path: "a.md", startLine: 1, maxLines: 5 };
    const captured = captureConnectedFolderToolRequest(request);
    request.path = "../outside";
    expect(captured).toMatchObject({ path: "a.md" });
  });

  it.each([
    ["a symbol key", { view: "list", directory: "", after: "", [Symbol("x")]: 1 }],
    [
      "a class instance",
      new (class {
        view = "list";
        directory = "";
        after = "";
      })(),
    ],
    ["a list with a result count", { view: "list", directory: "", after: "", maxResults: 5 }],
    ["an invalid cursor", { view: "list", directory: "", after: "../x" }],
    ["a numeric string line", { view: "read", path: "a.md", startLine: "1", maxLines: 5 }],
    ["a negative line", { view: "read", path: "a.md", startLine: -1, maxLines: 5 }],
    [
      "an infinite line count",
      { view: "read", path: "a.md", startLine: 1, maxLines: Number.POSITIVE_INFINITY },
    ],
    ["an empty path", { view: "read", path: "", startLine: 1, maxLines: 5 }],
    [
      "a query that is not text",
      { view: "search", mode: "keywords", query: ["a"], directory: "", maxResults: 5 },
    ],
    [
      "zero results",
      { view: "search", mode: "keywords", query: "a", directory: "", maxResults: 0 },
    ],
  ])("rejects %s", (_name, request) => {
    expect(isConnectedFolderToolRequest(request)).toBe(false);
    expect(captureConnectedFolderToolRequest(request)).toBeUndefined();
  });

  it("lists no more entries than path discovery can return", () => {
    expect(CONNECTED_FOLDER_TOOL_LIMITS.listEntries).toBe(
      WORKSPACE_PATH_DISCOVERY_LIMITS.maxResults,
    );
  });
});
