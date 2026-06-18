import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveCspHeaderProvider } from "./load-csp.js";

describe("createLiveCspHeaderProvider", () => {
  it("refreshes the CSP header when the hash file changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keiko-live-csp-"));
    const hashesFile = join(dir, "csp-hashes.json");
    const provider = createLiveCspHeaderProvider(hashesFile);
    try {
      expect(await provider()).toContain("script-src 'self'");
      expect(await provider()).not.toContain("'sha256-first'");

      await writeFile(hashesFile, JSON.stringify(["'sha256-first'"]), "utf8");
      expect(await provider()).toContain("script-src 'self' 'sha256-first'");

      await writeFile(hashesFile, JSON.stringify(["'sha256-second-longer'"]), "utf8");
      const refreshed = await provider();
      expect(refreshed).toContain("'sha256-second-longer'");
      expect(refreshed).not.toContain("'sha256-first'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
