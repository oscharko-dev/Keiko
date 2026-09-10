import { createHash } from "node:crypto";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  digestPortableHandoffFile,
  portableHandoffOperationFrom,
  type PortableHandoffOperation,
} from "./update-portable-handoff-tree.js";

const tempRoots: string[] = [];

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keiko-portable-handoff-tree-"));
  tempRoots.push(root);
  return join(root, "artifact.bin");
}

function operation(): PortableHandoffOperation {
  return portableHandoffOperationFrom({ deadline: Date.now() + 5_000 });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable handoff file digest", () => {
  it("preserves the default limit while enforcing a caller's tighter opened-file limit", async () => {
    const path = await fixturePath();
    const content = Buffer.alloc(64 * 1024 + 1, 0x5a);
    await writeFile(path, content);

    await expect(digestPortableHandoffFile(path, operation())).resolves.toEqual(
      createHash("sha256").update(content).digest(),
    );
    await expect(digestPortableHandoffFile(path, operation(), 64 * 1024)).rejects.toThrow(
      "portable handoff artifact is unsafe",
    );
  });

  it("rejects a sparse oversized control file before reading it", async () => {
    const path = await fixturePath();
    await writeFile(path, "{}\n");
    await truncate(path, 64 * 1024 + 1);

    await expect(digestPortableHandoffFile(path, operation(), 64 * 1024)).rejects.toThrow(
      "portable handoff artifact is unsafe",
    );
  });

  it.each([0, -1, Number.NaN, 256 * 1024 * 1024 + 1])(
    "rejects the invalid caller byte limit %s",
    async (maximumBytes) => {
      const path = await fixturePath();
      await writeFile(path, "artifact");

      await expect(digestPortableHandoffFile(path, operation(), maximumBytes)).rejects.toThrow(
        "portable handoff artifact byte limit is invalid",
      );
    },
  );
});
