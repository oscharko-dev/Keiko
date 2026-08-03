import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { linkSyncMock } = vi.hoisted(() => ({
  linkSyncMock: vi.fn((): never => {
    throw Object.assign(new Error("hard links unavailable"), { code: "EPERM" });
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, linkSync: linkSyncMock };
});

import { createUpdateLocalStateManager } from "./update-local-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  linkSyncMock.mockClear();
});

describe("remediation lease publication without hard links", () => {
  it("uses an exclusive copy while preserving lease exclusion and release", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-update-no-hardlink-"));
    roots.push(stateDir);
    const first = createUpdateLocalStateManager({ stateDir });
    const second = createUpdateLocalStateManager({ stateDir });

    const release = first.acquireRemediationLease("repair-memory");
    expect(release).toEqual(expect.any(Function));
    expect(second.acquireRemediationLease("repair-memory")).toBeUndefined();
    release?.();
    expect(second.acquireRemediationLease("repair-memory")).toEqual(expect.any(Function));
    expect(linkSyncMock).toHaveBeenCalled();
  });
});
