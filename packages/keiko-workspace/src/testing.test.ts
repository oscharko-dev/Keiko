// Locks the sanctioned `./testing` entrypoint (GEN-DUP-NEAR-010): downstream packages import
// `memFs` from `@oscharko-dev/keiko-workspace/testing`, so this proves the subpath re-exports a
// working in-memory `WorkspaceFs` fake rather than requiring deep `src/_memfs.js` imports.

import { describe, expect, it } from "vitest";

import { memFs } from "./testing.js";

const ROOT = "/ws";

function required<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe("keiko-workspace/testing", () => {
  it("re-exports memFs as a working in-memory WorkspaceFs", () => {
    const fs = memFs(ROOT, { "src/a.ts": "alpha" });
    expect(fs.readFileUtf8(`${ROOT}/src/a.ts`)).toBe("alpha");
    expect(fs.exists(`${ROOT}/src/a.ts`)).toBe(true);
    expect(fs.exists(`${ROOT}/src/missing.ts`)).toBe(false);
    expect(fs.stat(`${ROOT}/src/a.ts`).isFile).toBe(true);
    expect(fs.readDir(ROOT).map((entry) => entry.name)).toContain("src");
  });

  it("normalizes long slash runs without changing in-memory lookup semantics", () => {
    const slashRun = "/".repeat(50_000);
    const fs = memFs(ROOT, { [`${slashRun}src/a.ts${slashRun}`]: "alpha" });

    expect(fs.exists(`${ROOT}/src/a.ts`)).toBe(true);
    expect(fs.readFileUtf8(`${ROOT}/src/a.ts`)).toBe("alpha");
  });

  it("normalizes Windows separators and slash boundaries without regex backtracking", () => {
    const fs = memFs(ROOT, { "\\src\\nested\\a.ts\\": "alpha" });

    expect(fs.exists(`${ROOT}/src/nested/a.ts`)).toBe(true);
    expect(fs.readDir(`${ROOT}/src`).map((entry) => entry.name)).toEqual(["nested"]);
  });

  it("supports bounded byte, UTF-8 prefix, and range reads", async () => {
    const fs = memFs(ROOT, { "src/emoji.txt": "alpha🙂omega" });
    const file = `${ROOT}/src/emoji.txt`;
    const missing = `${ROOT}/src/missing.txt`;
    const readFileBytes = required(fs.readFileBytes);
    const readFileUtf8Prefix = required(fs.readFileUtf8Prefix);
    const readFileRange = required(fs.readFileRange);

    await expect(readFileBytes(file, 5)).resolves.toEqual(new TextEncoder().encode("alpha"));
    await expect(readFileBytes(missing, 5)).rejects.toThrow(`ENOENT: ${missing}`);
    expect(readFileUtf8Prefix(file, 7)).toBe("alpha");
    expect(() => readFileUtf8Prefix(missing, 5)).toThrow(`ENOENT: ${missing}`);
    await expect(readFileRange(file, 5, 4)).resolves.toEqual(new TextEncoder().encode("🙂"));
    await expect(readFileRange(missing, 0, 4)).rejects.toThrow(`ENOENT: ${missing}`);
  });

  it("fails closed after an in-memory reader is closed", async () => {
    const fs = memFs(ROOT, { "src/emoji.txt": "alpha🙂omega" });
    const file = `${ROOT}/src/emoji.txt`;
    const missing = `${ROOT}/src/missing.txt`;
    const openFileReader = required(fs.openFileReader);

    const reader = await openFileReader(file);
    expect(reader).toBeDefined();
    await expect(reader.readRange(0, 5)).resolves.toEqual(new TextEncoder().encode("alpha"));
    await reader.close();
    await expect(reader.readRange(0, 1)).rejects.toThrow(`EBADF: ${file}`);
    await expect(openFileReader(missing)).rejects.toThrow(`ENOENT: ${missing}`);
  });
});
