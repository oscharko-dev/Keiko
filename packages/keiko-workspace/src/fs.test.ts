import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { nodeWorkspaceFs } from "./fs.js";

const roots: string[] = [];

function workspaceFixture(): { readonly root: string; readonly file: string } {
  const root = mkdtempSync(join(tmpdir(), "keiko-workspace-fs-"));
  roots.push(root);
  const nested = join(root, "nested");
  nodeWorkspaceFs.makeDir?.(nested);
  const file = join(nested, "fixture.txt");
  nodeWorkspaceFs.writeFileUtf8?.(file, "alpha🙂omega");
  return { root, file };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("nodeWorkspaceFs", () => {
  it("implements the synchronous contained filesystem surface", () => {
    const { root, file } = workspaceFixture();

    expect(nodeWorkspaceFs.readFileUtf8(file)).toBe("alpha🙂omega");
    expect(nodeWorkspaceFs.stat(file)).toMatchObject({ isFile: true, isDirectory: false });
    expect(nodeWorkspaceFs.readDir(root)).toContainEqual(
      expect.objectContaining({ name: "nested", isDirectory: true }),
    );
    expect(nodeWorkspaceFs.realPath(file)).toBe(realpathSync(file));
    expect(nodeWorkspaceFs.exists(file)).toBe(true);
    expect(nodeWorkspaceFs.exists(join(root, "missing"))).toBe(false);
  });

  it("caps byte, prefix, and range reads without over-reading", async () => {
    const { file } = workspaceFixture();

    await expect(nodeWorkspaceFs.readFileBytes?.(file, 0)).resolves.toEqual(new Uint8Array());
    await expect(nodeWorkspaceFs.readFileBytes?.(file, 5)).resolves.toEqual(
      new TextEncoder().encode("alpha"),
    );
    expect(nodeWorkspaceFs.readFileUtf8Prefix?.(file, 0)).toBe("");
    expect(nodeWorkspaceFs.readFileUtf8Prefix?.(file, 5)).toBe("alpha");
    await expect(nodeWorkspaceFs.readFileRange?.(file, 5, 0)).resolves.toEqual(new Uint8Array());
    await expect(nodeWorkspaceFs.readFileRange?.(file, 5, 4)).resolves.toEqual(
      new TextEncoder().encode("🙂"),
    );
  });

  it("reuses one bounded reader and closes it idempotently", async () => {
    const { file } = workspaceFixture();
    const reader = await nodeWorkspaceFs.openFileReader?.(file);

    expect(reader).toBeDefined();
    await expect(reader?.readRange(0, 0)).resolves.toEqual(new Uint8Array());
    await expect(reader?.readRange(5, 4)).resolves.toEqual(new TextEncoder().encode("🙂"));
    await reader?.close();
    await expect(reader?.close()).resolves.toBeUndefined();
  });
});
