import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { expect, it } from "vitest";

// Provisioning and the MSVC bootstrap load this source before npm install/build. A bundled or
// Vitest-transformed import cannot prove that the actual Node entry point still works.
it("loads the trusted Windows directory owner before dependencies or package builds exist", () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-system-directory-source-"));
  try {
    const target = join(root, "windows-system-directory.ts");
    copyFileSync(
      fileURLToPath(
        new URL("../../packages/keiko-security/src/windows-system-directory.ts", import.meta.url),
      ),
      target,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { resolveWindowsSystemDirectory } from ${JSON.stringify(pathToFileURL(target).href)};
import assert from 'node:assert/strict';
assert.equal(resolveWindowsSystemDirectory({ SYSTEMROOT: 'D:\\\\Windows' }, () => true), 'D:\\\\Windows');
assert.throws(() => resolveWindowsSystemDirectory({ SYSTEMROOT: '\\\\\\\\server\\\\Windows' }, () => true));`,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
