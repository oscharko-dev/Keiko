import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { extractInlineScriptHashes, buildCspHeader } from "./csp.js";
import { createLiveCspHeaderProvider, loadCspHeader } from "./load-csp.js";

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

describe("loadCspHeader", () => {
  it("falls back to exported HTML script hashes when stored hashes are stale", async () => {
    const distRoot = await mkdtemp(join(tmpdir(), "keiko-csp-fallback-"));
    const staticRoot = join(distRoot, "static");
    const hashesFile = join(distRoot, "csp-hashes.json");

    try {
      await mkdir(staticRoot, { recursive: true });
      const inlineScript = "window.__keiko_boot__()";
      const html = `<html><body><script>${inlineScript}</script></body></html>`;
      await writeFile(join(staticRoot, "index.html"), html, "utf8");
      const staleHash = "'sha256-outdated'";
      await writeFile(hashesFile, JSON.stringify([staleHash]), "utf8");

      const header = await loadCspHeader(hashesFile);
      const expected = extractInlineScriptHashes([html])[0];
      expect(expected).toBeDefined();
      expect(buildCspHeader([expected ?? ""]).includes(expected ?? "")).toBe(true);
      expect(header).toContain(expected ?? "");
      expect(header).not.toContain(staleHash);
    } finally {
      await rm(distRoot, { recursive: true, force: true });
    }
  });

  it("uses stored hashes when they already match exported HTML hashes", async () => {
    const distRoot = await mkdtemp(join(tmpdir(), "keiko-csp-stable-"));
    const staticRoot = join(distRoot, "static");
    const hashesFile = join(distRoot, "csp-hashes.json");

    try {
      await mkdir(staticRoot, { recursive: true });
      const inlineScript = "window.__keiko_boot__.ready = true;";
      const html = `<html><body><script>${inlineScript}</script></body></html>`;
      const hashes = extractInlineScriptHashes([html]);
      await writeFile(join(staticRoot, "index.html"), html, "utf8");
      await writeFile(hashesFile, JSON.stringify(hashes), "utf8");

      const header = await loadCspHeader(hashesFile);
      const expected = hashes;
      for (const hash of expected) {
        expect(header).toContain(hash);
      }
      expect(header).toContain("script-src 'self'");
    } finally {
      await rm(distRoot, { recursive: true, force: true });
    }
  });
});
