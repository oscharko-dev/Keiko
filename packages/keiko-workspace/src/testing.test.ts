// Locks the sanctioned `./testing` entrypoint (GEN-DUP-NEAR-010): downstream packages import
// `memFs` from `@oscharko-dev/keiko-workspace/testing`, so this proves the subpath re-exports a
// working in-memory `WorkspaceFs` fake rather than requiring deep `src/_memfs.js` imports.

import { describe, expect, it } from "vitest";

import { memFs } from "./testing.js";

const ROOT = "/ws";

describe("keiko-workspace/testing", () => {
  it("re-exports memFs as a working in-memory WorkspaceFs", () => {
    const fs = memFs(ROOT, { "src/a.ts": "alpha" });
    expect(fs.readFileUtf8(`${ROOT}/src/a.ts`)).toBe("alpha");
    expect(fs.exists(`${ROOT}/src/a.ts`)).toBe(true);
    expect(fs.exists(`${ROOT}/src/missing.ts`)).toBe(false);
    expect(fs.stat(`${ROOT}/src/a.ts`).isFile).toBe(true);
    expect(fs.readDir(ROOT).map((entry) => entry.name)).toContain("src");
  });
});
