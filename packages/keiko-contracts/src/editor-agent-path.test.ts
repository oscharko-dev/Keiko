import { describe, expect, it } from "vitest";

import { isContainedAgentPath } from "./editor-agent-path.js";

describe("editor agent path containment", () => {
  it.each(["\\etc\\passwd", "\\\\server\\share\\x", "a\\b", "\\\\?\\C:\\Windows"])(
    "rejects every backslash-bearing path: %s",
    (path) => {
      expect(isContainedAgentPath(path)).toBe(false);
    },
  );

  it.each(["src/a.ts", "a/b/c.txt"])("accepts a contained POSIX path: %s", (path) => {
    expect(isContainedAgentPath(path)).toBe(true);
  });
});
