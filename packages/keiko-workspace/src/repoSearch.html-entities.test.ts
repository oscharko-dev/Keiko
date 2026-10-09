import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "./detect.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import { createWorkspaceIndex } from "./workspaceIndex.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(path: string, content: string): SearchScope {
  const root = mkdtempSync(join(tmpdir(), "keiko-html-entities-"));
  roots.push(root);
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "ordinary-manual",
    relativePaths: [],
  };
}

function query(text: string): RetrievalQuery {
  return { kind: "exact-symbol", text, maxResults: 16, caseSensitive: false, emittedAtMs: 0 };
}

const encoded = [
  "<html>",
  "<nav>Home | Installation | Operating limits | Restart</nav>",
  "<h1>&#220;berhitzungsschutz</h1>",
  "<p>&#220;berhitzungsschutz specifies 61.2 degrees Celsius.</p>",
  "</html>",
].join("\n");

describe("HTML character-reference search with raw source evidence", () => {
  it.each([
    ["&Uuml;berhitzungsschutz", "Überhitzungsschutz"],
    ["&uuml;berhitzung", "überhitzung"],
    ["M&auml;ngel&nbsp;Beseitigung", "Mängel"],
    ["caf&eacute;&nbsp;maintenance", "café"],
  ])("finds standard named HTML references %s as human term %s", async (encodedTerm, term) => {
    const raw = `<html>\n<p>${encodedTerm} specifies 61.2 C.</p>\n</html>`;
    const selected = fixture("manual.html", raw);
    const workspaceIndex = createWorkspaceIndex();
    for (const maxFilesScanned of [null, 16]) {
      const result = await searchText(
        selected,
        query(term),
        {
          ...DEFAULT_SEARCH_LIMITS,
          maxFilesScanned,
        },
        { workspaceIndex },
      );
      expect(result.atoms).toHaveLength(1);
      expect(result.atoms[0]?.lineRange).toEqual({ startLine: 2, endLine: 2 });
      expect(result.coverage.incomplete).toBe(false);
    }
    expect(
      (
        await readExcerpt(selected, {
          scopePath: "manual.html",
          startLine: 2,
          endLine: 2,
          maxBytes: 512,
        })
      ).content,
    ).toBe(raw.split("\n")[1]);
  });

  it.each(["html", "htm", "xhtml"])(
    "finds decimal entities in ordinary %s documents without changing source lines",
    async (extension) => {
      const path = `generated/handbücher/manual.${extension}`;
      const selected = fixture(path, encoded);
      const observed: { scopePath: string; lineCount: number }[] = [];
      const result = await searchText(selected, query("Überhitzungsschutz"), undefined, {
        onEligibleTextFile: (file): void => {
          observed.push(file);
        },
      });
      expect(result.atoms).toHaveLength(2);
      expect(result.atoms.map((atom) => atom.lineRange)).toEqual([
        { startLine: 3, endLine: 3 },
        { startLine: 4, endLine: 4 },
      ]);
      expect(result.coverage.incomplete).toBe(false);
      expect(observed).toEqual([expect.objectContaining({ scopePath: path, lineCount: 5 })]);
      const excerpt = await readExcerpt(selected, {
        scopePath: path,
        startLine: 4,
        endLine: 4,
        maxBytes: 512,
      });
      expect(excerpt.content).toBe(
        "<p>&#220;berhitzungsschutz specifies 61.2 degrees Celsius.</p>",
      );
    },
  );

  it("finds hex and supplementary Unicode entities through the trusted literal matcher", async () => {
    const selected = fixture("manual.html", "<p>&#x1F6E0; Reparatur caf&#xE9;</p>\n");
    const result = await searchText(
      selected,
      { ...query("🛠 Reparatur café"), kind: "natural-language" },
      undefined,
      { queryInterpretation: { kind: "literal", terms: ["🛠 Reparatur café"] } },
    );
    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0]?.lineRange).toEqual({ startLine: 1, endLine: 1 });
  });

  it("keeps entity-encoded line breaks inside their original physical source line", async () => {
    const selected = fixture(
      "manual.html",
      "<html>\r\n<p>Protection&#10;&#220;berhitzungsschutz&#13;61.2 C</p>\r\n</html>\r\n",
    );
    const result = await searchText(selected, query("Überhitzungsschutz"));
    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0]?.lineRange).toEqual({ startLine: 2, endLine: 2 });
    expect(
      (
        await readExcerpt(selected, {
          scopePath: "manual.html",
          startLine: 2,
          endLine: 2,
          maxBytes: 512,
        })
      ).content,
    ).toBe("<p>Protection&#10;&#220;berhitzungsschutz&#13;61.2 C</p>\r");
  });

  it("does not accept old raw hashed cache negatives as proof of an absent decoded HTML term", async () => {
    const selected = fixture("manual.html", encoded);
    const workspaceIndex = createWorkspaceIndex();
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 16 };
    await searchText(selected, query("Home"), limits, { workspaceIndex });
    const found = await searchText(selected, query("Überhitzungsschutz"), limits, {
      workspaceIndex,
    });
    expect(found.atoms).toHaveLength(2);
    expect(found.coverage.incomplete).toBe(false);
  });

  it.each([
    ["manual.html", "<p>&amp;#220;berhitzungsschutz</p>"],
    ["manual.html", "<p>&amp;Uuml;berhitzungsschutz</p>"],
    ["manual.html", "<p>&#xD800;berhitzungsschutz &#999999999;</p>"],
    ["manual.ts", "export const source = '&#220;berhitzungsschutz';"],
    ["manual.txt", "&#220;berhitzungsschutz"],
  ])("does not invent a decoded human term in %s: %s", async (path, text) => {
    const selected = fixture(path, text);
    const result = await searchText(selected, query("Überhitzungsschutz"));
    expect(result.atoms).toEqual([]);
    expect(result.coverage.incomplete).toBe(false);
  });

  it.each(["manual.html", "manual.ts", "manual.txt"])(
    "preserves exact raw entity searches in %s",
    async (path) => {
      const selected = fixture(path, "literal &amp; reference\n");
      const result = await searchText(selected, query("&amp;"), undefined, {
        queryInterpretation: { kind: "literal", terms: ["&amp;"] },
      });
      expect(result.atoms).toHaveLength(1);
    },
  );

  it("retains plain Unicode HTML as an unchanged healthy control", async () => {
    const selected = fixture("manual.html", "<p>Überhitzungsschutz specifies 61.2 C.</p>\n");
    const result = await searchText(selected, query("Überhitzungsschutz"));
    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0]?.lineRange).toEqual({ startLine: 1, endLine: 1 });
  });
});
