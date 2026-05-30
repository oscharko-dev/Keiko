// ADR-0013 D4 — resolveUiDbPath precedence: explicit → KEIKO_UI_DATA_DIR/keiko-ui.db → ~/.keiko/keiko-ui.db.

import { describe, expect, it } from "vitest";
import { resolveUiDbPath } from "../../../src/ui/store/index.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("resolveUiDbPath", () => {
  it("prefers an explicit path when supplied", () => {
    expect(resolveUiDbPath("/tmp/x.db", { KEIKO_UI_DATA_DIR: "/ignored" })).toBe("/tmp/x.db");
  });

  it("uses KEIKO_UI_DATA_DIR + keiko-ui.db when no explicit value", () => {
    expect(resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: "/data" })).toBe(
      join("/data", "keiko-ui.db"),
    );
  });

  it("falls back to ~/.keiko/keiko-ui.db when neither is set", () => {
    expect(resolveUiDbPath(undefined, {})).toBe(join(homedir(), ".keiko", "keiko-ui.db"));
  });

  it("treats an empty explicit string as not set", () => {
    expect(resolveUiDbPath("", { KEIKO_UI_DATA_DIR: "/data" })).toBe(join("/data", "keiko-ui.db"));
  });

  it("treats an empty env value as not set", () => {
    expect(resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: "" })).toBe(
      join(homedir(), ".keiko", "keiko-ui.db"),
    );
  });
});
