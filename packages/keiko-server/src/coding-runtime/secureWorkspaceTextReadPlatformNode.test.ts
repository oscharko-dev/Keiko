import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodePortableSecureWorkspaceReadInspection } from "./secureWorkspaceTextReadPlatformNode.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(contents = "signed helper"): {
  readonly executable: string;
  readonly resourceRoot: string;
} {
  const resourceRoot = mkdtempSync(join(tmpdir(), "keiko-secure-read-platform-"));
  roots.push(resourceRoot);
  const runtimeRoot = join(resourceRoot, "runtime", "native");
  const executable = join(runtimeRoot, "keiko-secure-workspace-read");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(executable, contents);
  return { executable, resourceRoot };
}

describe("node portable secure workspace-read inspection", () => {
  it("inspects every resource path component without following links", async () => {
    const { executable, resourceRoot } = fixture();
    const inspection = createNodePortableSecureWorkspaceReadInspection();

    await expect(inspection.inspectPath(resourceRoot, executable)).resolves.toEqual([
      { symbolicLink: false, reparsePoint: false, safeType: true },
      { symbolicLink: false, reparsePoint: false, safeType: true },
      { symbolicLink: false, reparsePoint: false, safeType: true },
      { symbolicLink: false, reparsePoint: false, safeType: true },
    ]);

    const linkedExecutable = join(resourceRoot, "linked-helper");
    symlinkSync(executable, linkedExecutable);
    await expect(inspection.inspectPath(resourceRoot, linkedExecutable)).resolves.toEqual([
      { symbolicLink: false, reparsePoint: false, safeType: true },
      { symbolicLink: true, reparsePoint: false, safeType: false },
    ]);
  });

  it("rejects the resource root and paths outside the immutable resource tree", async () => {
    const { executable, resourceRoot } = fixture();
    const inspection = createNodePortableSecureWorkspaceReadInspection();

    await expect(inspection.inspectPath(resourceRoot, resourceRoot)).rejects.toThrow(
      "secure-workspace-read-path-invalid",
    );
    await expect(
      inspection.inspectPath(resourceRoot, join(resourceRoot, "..", "outside")),
    ).rejects.toThrow("secure-workspace-read-path-invalid");
    await expect(
      inspection.inspectPath(join(resourceRoot, "runtime"), executable),
    ).resolves.toHaveLength(3);
  });

  it("opens the verified bytes and preserves exact file identity metadata", async () => {
    const { executable } = fixture();
    const inspection = createNodePortableSecureWorkspaceReadInspection();
    const result = await inspection.openReadSameIdentity(executable, 1024);

    expect(Buffer.from(result.bytes).toString("utf8")).toBe("signed helper");
    expect(result.before).toEqual(result.after);
    expect(result.before).toMatchObject({
      size: 13,
      regularFile: true,
      linkCount: 1,
    });
    expect(result.before.identity).toMatch(/^\d+:\d+$/);
  });

  it.each([
    ["", 1024],
    ["oversized", 4],
  ] as const)("rejects invalid helper size for %j", async (contents, maximumBytes) => {
    const { executable } = fixture(contents);
    await expect(
      createNodePortableSecureWorkspaceReadInspection().openReadSameIdentity(
        executable,
        maximumBytes,
      ),
    ).rejects.toThrow("secure-workspace-read-size-invalid");
  });

  it("executes the fixed platform signature verifiers without an ambient shell", async () => {
    const inspection = createNodePortableSecureWorkspaceReadInspection();

    await expect(inspection.verifySignature("/usr/bin/true", "darwin-arm64")).resolves.toEqual(
      expect.any(Boolean),
    );
    await expect(inspection.verifySignature("/missing/helper.exe", "win32-x64")).resolves.toBe(
      false,
    );
    vi.stubEnv("SystemRoot", String.raw`C:\Windows`);
    await expect(inspection.verifySignature("/missing/helper.exe", "win32-x64")).resolves.toBe(
      false,
    );
  });

  it("accepts a Windows helper only when it matches the fixed launcher's signer", async () => {
    const { executable, resourceRoot } = fixture();
    writeFileSync(join(resourceRoot, "Keiko.exe"), "signed launcher");
    const identities = ["A".repeat(40), "A".repeat(40), "A".repeat(40), "B".repeat(40)];
    let index = 0;
    const inspection = createNodePortableSecureWorkspaceReadInspection({
      resourceRoot,
      windowsRunCommand: () => ({
        status: 0,
        stderr: "",
        stdout: identities[index++] ?? "",
      }),
    });

    await expect(inspection.verifySignature(executable, "win32-x64")).resolves.toBe(true);
    await expect(inspection.verifySignature(executable, "win32-x64")).resolves.toBe(false);
  });
});
