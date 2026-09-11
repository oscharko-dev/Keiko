import { mkdtempSync, rmSync, writeFileSync, type Dir, type Dirent, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPortableTreeKht1 } from "./portable-tree-attestation.js";

const rebind = vi.hoisted(() => ({
  openedRoot: "",
  reboundRoot: "",
  readAttempted: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    opendir: async (path: PathLike): Promise<Dir> => {
      const handle = await original.opendir(path);
      if (typeof path !== "string" || path !== rebind.openedRoot || rebind.reboundRoot.length > 0) {
        return handle;
      }
      rebind.reboundRoot = `${path}.opened`;
      await original.rename(path, rebind.reboundRoot);
      await original.mkdir(path);
      await original.writeFile(join(path, "outside.txt"), "must not be traversed");
      const readOriginal = handle.read.bind(handle);
      const read = (): Promise<Dirent | null> =>
        new Promise((resolve, reject) => {
          readOriginal((error, entry) => {
            if (error === null) resolve(entry);
            else reject(error);
          });
        });
      Object.defineProperty(handle, "read", {
        value: async (): Promise<Dirent | null> => {
          rebind.readAttempted = true;
          return await read();
        },
      });
      return handle;
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  rebind.openedRoot = "";
  rebind.reboundRoot = "";
  rebind.readAttempted = false;
});

describe("portable KHT1 opened-directory identity", () => {
  it("rejects a rebound path before the first directory read", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-kht1-open-directory-"));
    roots.push(root, `${root}.opened`);
    writeFileSync(join(root, "inside.txt"), "trusted");
    rebind.openedRoot = root;

    await expect(
      hashPortableTreeKht1(root, {
        deadline: Date.now() + 5_000,
        now: Date.now,
        yieldControl: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/directory changed before traversal/u);

    expect(rebind.reboundRoot).toBe(`${root}.opened`);
    expect(rebind.readAttempted).toBe(false);
  });
});
