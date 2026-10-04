import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SEARCH_LIMITS, detectWorkspaceAt, searchText } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-observed-text-"));
  roots.push(root);
  return root;
}

function scope(root: string): Parameters<typeof searchText>[0] {
  return { workspace: detectWorkspaceAt(root), scopeId: "observed-folder", relativePaths: [] };
}

const query = {
  kind: "natural-language",
  text: "observer",
  caseSensitive: false,
  maxResults: 64,
  emittedAtMs: 1,
} as const;

describe("successful text read observation", () => {
  it("observes whole admitted decoded text without bypassing binary, sensitive or size exclusions", async () => {
    const root = rootFixture();
    writeFileSync(join(root, "manual.html"), "<p>observer</p>\n<p>actual value</p>\n");
    writeFileSync(join(root, "ordinary.unfamiliar"), "other content\n");
    writeFileSync(
      join(root, "legacy.txt"),
      Buffer.concat([Buffer.from([255, 254]), Buffer.from("observer\nvalue\n", "utf16le")]),
    );
    writeFileSync(join(root, "at-cap.txt"), "a".repeat(2_097_152));
    writeFileSync(join(root, "above-cap.txt"), "a".repeat(2_097_153));
    writeFileSync(join(root, "binary.bin"), Buffer.from("observer\0payload"));
    writeFileSync(join(root, "image.svg"), "<svg>observer</svg>");
    writeFileSync(join(root, ".env"), "observer=private");
    const files: { scopePath: string; contentBytes: number; lineCount: number }[] = [];
    await searchText(scope(root), query, DEFAULT_SEARCH_LIMITS, {
      onEligibleTextFile: (file): void => {
        files.push(file);
      },
    });
    expect(files.map((file) => file.scopePath).sort()).toEqual([
      "at-cap.txt",
      "legacy.txt",
      "manual.html",
      "ordinary.unfamiliar",
    ]);
    expect(files.find((file) => file.scopePath === "at-cap.txt")?.contentBytes).toBe(2_097_152);
    expect(files.find((file) => file.scopePath === "manual.html")?.lineCount).toBe(2);
    expect(files.find((file) => file.scopePath === "legacy.txt")?.lineCount).toBe(2);
    expect(JSON.stringify(files)).not.toContain("actual value");
  });

  it("does not observe any file when the request is already cancelled", async () => {
    const root = rootFixture();
    writeFileSync(join(root, "manual.txt"), "observer");
    const controller = new AbortController();
    controller.abort();
    const files: string[] = [];
    const result = await searchText(scope(root), query, DEFAULT_SEARCH_LIMITS, {
      signal: controller.signal,
      onEligibleTextFile: (file): void => {
        files.push(file.scopePath);
      },
    });
    expect(files).toEqual([]);
    expect(result.coverage.reasons).toContain("aborted");
  });
});
