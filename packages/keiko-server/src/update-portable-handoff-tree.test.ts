import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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

function expectDigestChild(path: string, expected: "accepted" | "refused"): void {
  const module = new URL("../dist/update-portable-handoff-tree.js", import.meta.url);
  const script = [
    "const api = await import(process.argv[1]);",
    "try {",
    "  const operation = api.portableHandoffOperationFrom({ deadline: Date.now() + 500 });",
    "  await api.digestPortableHandoffFile(process.argv[2], operation);",
    '  process.stdout.write("accepted");',
    "} catch (error) {",
    "  if (!(error instanceof api.PortableHandoffBuilderError)) throw error;",
    '  process.stdout.write("refused");',
    "}",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, module.href, path],
    {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe(expected);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable handoff file digest", () => {
  it.skipIf(process.platform === "win32")(
    "refuses a FIFO without blocking bounded preparation",
    async () => {
      const path = await fixturePath();
      await writeFile(path, "artifact");
      expectDigestChild(path, "accepted");
      await rm(path);
      execFileSync("/usr/bin/mkfifo", [path], { timeout: 5_000 });
      expectDigestChild(path, "refused");
    },
  );

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
