import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_RECURSIVE_TEXT_FILE_BYTES } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
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
  it("stops producing observation metadata after its bounded consumer has completed", async () => {
    const root = rootFixture();
    for (let index = 0; index < 40; index += 1)
      writeFileSync(join(root, `file-${String(index)}.txt`), "observer\n");
    const observe = vi.fn(() => false);
    const result = await searchText(scope(root), query, DEFAULT_SEARCH_LIMITS, {
      onEligibleTextFile: observe,
    });
    expect(result.coverage.filesScanned).toBe(40);
    expect(result.coverage.incomplete).toBe(false);
    expect(result.atoms).toHaveLength(40);
    expect(observe).toHaveBeenCalledTimes(1);
  });
  it("observes whole admitted decoded text without bypassing binary, sensitive or size exclusions", async () => {
    const root = rootFixture();
    writeFileSync(join(root, "manual.html"), "<p>observer</p>\n<p>actual value</p>\n");
    writeFileSync(join(root, "ordinary.unfamiliar"), "other content\n");
    writeFileSync(
      join(root, "legacy.txt"),
      Buffer.concat([Buffer.from([255, 254]), Buffer.from("observer\nvalue\n", "utf16le")]),
    );
    writeFileSync(join(root, "at-cap.txt"), "a".repeat(MAX_RECURSIVE_TEXT_FILE_BYTES));
    writeFileSync(join(root, "above-cap.txt"), "a".repeat(MAX_RECURSIVE_TEXT_FILE_BYTES + 1));
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
    expect(files.find((file) => file.scopePath === "at-cap.txt")?.contentBytes).toBe(
      MAX_RECURSIVE_TEXT_FILE_BYTES,
    );
    expect(files.find((file) => file.scopePath === "manual.html")?.lineCount).toBe(2);
    expect(files.find((file) => file.scopePath === "legacy.txt")?.lineCount).toBe(2);
    for (const file of files)
      expect(Object.keys(file).sort()).toEqual(["contentBytes", "lineCount", "scopePath"]);
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

it("omits empty context descriptors and keeps physical CRLF and final-line counts", async () => {
  const root = rootFixture();
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(root, "blank.txt"), " \t\r\n");
  writeFileSync(join(root, "crlf.txt"), "observer first\r\nsecond\r\n");
  writeFileSync(join(root, "final.txt"), "observer first\nsecond");
  const observed: { scopePath: string; lineCount: number }[] = [];
  const result = await searchText(scope(root), query, DEFAULT_SEARCH_LIMITS, {
    onEligibleTextFile: (file): void => {
      observed.push(file);
    },
  });
  expect(result.coverage.filesScanned).toBe(4);
  expect(
    observed
      .map(({ scopePath, lineCount }) => ({ scopePath, lineCount }))
      .sort((a, b) => (a.scopePath < b.scopePath ? -1 : 1)),
  ).toEqual([
    { scopePath: "crlf.txt", lineCount: 2 },
    { scopePath: "final.txt", lineCount: 2 },
  ]);
});
