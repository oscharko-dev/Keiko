import { describe, expect, it } from "vitest";
import { connectedFolderResultNamesMore } from "./connected-folder-chat-catalog.js";

describe("a connected-folder result that carries less than exists", () => {
  it("is a truncated page when an entry could not be listed, even without a continuation", () => {
    expect(
      connectedFolderResultNamesMore({ items: [], coverage: { coverageIncomplete: true } }),
    ).toBe(true);
  });

  it("is a truncated page when it names a continuation or more matches", () => {
    expect(connectedFolderResultNamesMore({ nextAfter: "docs/a.md", coverage: {} })).toBe(true);
    expect(connectedFolderResultNamesMore({ nextStartLine: 41, coverage: {} })).toBe(true);
    expect(connectedFolderResultNamesMore({ coverage: { truncated: true } })).toBe(true);
  });

  it("is a complete page when it names nothing more and every entry was listed", () => {
    expect(
      connectedFolderResultNamesMore({ items: [], coverage: { coverageIncomplete: false } }),
    ).toBe(false);
    expect(connectedFolderResultNamesMore({ coverage: { truncated: false } })).toBe(false);
    expect(connectedFolderResultNamesMore({ items: [] })).toBe(false);
  });
});
