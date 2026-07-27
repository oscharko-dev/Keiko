import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isTrustedProvisionedUsearchFile } from "../provision-usearch.mjs";

const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-provision-usearch-"));
  roots.push(root);
  const path = join(root, "usearch.node");
  writeFileSync(path, "verified runtime", { mode: 0o644 });
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { path, root, sha256 };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("provisioned USearch runtime trust", () => {
  it("accepts a regular digest-bound file in an owner-controlled directory", () => {
    const runtime = fixture();
    expect(isTrustedProvisionedUsearchFile(runtime.path, runtime.sha256)).toBe(true);
  });

  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    "rejects group/world-writable runtime files and directories on POSIX",
    () => {
      const writableFile = fixture();
      chmodSync(writableFile.path, 0o666);
      expect(isTrustedProvisionedUsearchFile(writableFile.path, writableFile.sha256)).toBe(false);

      const writableDirectory = fixture();
      chmodSync(writableDirectory.root, 0o777);
      expect(
        isTrustedProvisionedUsearchFile(writableDirectory.path, writableDirectory.sha256),
      ).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlink even when its target has the approved digest",
    () => {
      const runtime = fixture();
      const linked = join(runtime.root, "linked.node");
      symlinkSync(runtime.path, linked);
      expect(isTrustedProvisionedUsearchFile(linked, runtime.sha256)).toBe(false);
    },
  );

  it.skipIf(process.getuid === undefined || process.getuid() === 0)(
    "rejects a file outside the supplied POSIX ownership boundary",
    () => {
      const runtime = fixture();
      const actualUid = process.getuid?.() ?? 1;
      const untrustedUid = actualUid === 1 ? 2 : 1;
      expect(
        isTrustedProvisionedUsearchFile(runtime.path, runtime.sha256, {
          currentUid: untrustedUid,
        }),
      ).toBe(false);
    },
  );
});
