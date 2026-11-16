import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { resolveKeikoBinary } from "./install-layout.js";

it("resolves a copied Windows Path without ambient or shadow fallback (#4408)", () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-cli-alias-"));
  try {
    const binary = join(root, "keiko.cmd");
    writeFileSync(binary, "fixture");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(resolveKeikoBinary(root, { Path: root }, [])).toEqual({
      source: "path",
      binPath: binary,
    });
    expect(resolveKeikoBinary(root, { PATH: undefined, Path: root }, [])).toBeUndefined();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(resolveKeikoBinary(root, { Path: root }, [])).toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
