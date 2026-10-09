import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWorkspaceAt } from "./detect.js";
import { readExcerpt, searchText, type SearchScope } from "./repoSearch.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-markup-codecs-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "markup-codecs",
    relativePaths: [],
  };
}

describe("actual markup declaration search and physical excerpts", () => {
  it.each([
    { path: "manual.xhtml", prefix: '<?xml version="1.0" encoding="windows-1252"?>' },
    {
      path: "manual.html",
      prefix: "<script>const sample = '<meta charset=\"utf-8\">';</script>",
    },
    { path: "manual.htm", prefix: "<div title='<meta charset=\"utf-8\">'>Example</div>" },
    {
      path: "manual.html",
      prefix: "<script>const sample = '<meta charset=\"unknown-codec\">';</script>",
    },
    { path: "manual.html", prefix: '<!-- <meta charset="unknown-codec"> -->' },
    { path: "manual.html", prefix: '<meta charset="windows-1252">' },
  ])("searches and reads the actual declaration (%#)", async ({ path, prefix }) => {
    const line = "<p>CodecServiceProbe Ölwechsel 937 hours</p>";
    const declaration = prefix.startsWith("<?xml") ? "<html>" : '<meta charset="windows-1252">';
    const text = `${prefix}\r\n${declaration}\r\n${line}\r\n`;
    writeFileSync(join(root, path), Buffer.from(text, "latin1"));
    const selected = scope();
    const result = await searchText(selected, {
      kind: "exact-symbol",
      text: "CodecServiceProbe",
      maxResults: 8,
      caseSensitive: true,
      emittedAtMs: 0,
    });
    expect(result.coverage).toMatchObject({ incomplete: false, filesScanned: 1, filesSkipped: 0 });
    expect(result.atoms).toContainEqual(
      expect.objectContaining({ scopePath: path, lineRange: { startLine: 3, endLine: 3 } }),
    );
    const excerpt = await readExcerpt(selected, {
      scopePath: path,
      startLine: 3,
      endLine: 3,
      maxBytes: 512,
    });
    expect(excerpt.content).toBe(`${line}\r`);
  });
});
