import { describe, expect, it } from "vitest";

import { EDITOR_AGENT_TARGET_PATH_MAX_BYTES, isContainedAgentPath } from "./editor-agent-path.js";

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

  it.each(["", "src/\u0000secret.ts", "../secret.ts", "src/../secret.ts"])(
    "rejects an empty, hostile, or traversing path: %#",
    (path) => {
      expect(isContainedAgentPath(path)).toBe(false);
    },
  );

  it("accepts the UTF-8 byte limit and rejects one byte beyond it", () => {
    expect(isContainedAgentPath("x".repeat(EDITOR_AGENT_TARGET_PATH_MAX_BYTES))).toBe(true);
    expect(isContainedAgentPath("x".repeat(EDITOR_AGENT_TARGET_PATH_MAX_BYTES + 1))).toBe(false);
  });
});
