import { describe, expect, it } from "vitest";
import {
  compareFocusPaths,
  FocusDescriptorCollector,
  focusDocumentPaths,
  NAMED_DIRECTORY_FOCUS_MAX_DIRECTORIES,
  NAMED_DIRECTORY_FOCUS_MAX_DOCUMENTS,
  NAMED_DIRECTORY_FOCUS_MAX_OBSERVED_FILES,
  namedDirectoryTerms,
  namedScopeDirectories,
  retainFocusFiles,
} from "./grounded-named-directory-focus.js";

const INVENTORY = [
  "commands.ts",
  "commands/add-dir/index.ts",
  "commands/add-dir/add-dir.ts",
  "commands/branch/index.ts",
  "components/PromptInput/PromptInputQueuedCommands.tsx",
  "components/PromptInput/index.ts",
  "components/Widget/Widget.tsx",
  "utils/commands/parse.ts",
  "docs/manual.pdf",
];

function terms(text: string): readonly string[] {
  return namedDirectoryTerms(text).map((term) => term.segments.join("/"));
}

describe("namedDirectoryTerms", () => {
  it("reads cued folder names in German and English prose", () => {
    expect(terms("Was machen die Befehle im commands-Ordner?")).toEqual(["commands"]);
    expect(terms("Erkläre den Inhalt des commands-Ordners.")).toEqual(["commands"]);
    // Proximity yields candidates; only folders of the admitted inventory survive matching.
    expect(terms("Was liegt im Ordner commands?")).toContain("commands");
    expect(terms("What do the files in the commands folder do?")).toContain("commands");
    expect(terms("What do the files in the commands folder do?")).not.toContain("the");
    expect(terms("Was liegt im Ordner commands?")).not.toContain("im");
  });

  it("reads path spellings without a cue and normalizes separators", () => {
    expect(terms("Explain components/PromptInput")).toEqual(["components/promptinput"]);
    expect(terms("Explain .\\components\\PromptInput\\")).toEqual(["components/promptinput"]);
  });

  it("ignores ordinary prose, bare names and parent segments", () => {
    expect(terms("Was machen die Befehle?")).toEqual([]);
    expect(terms("Explain the commands")).toEqual([]);
    expect(terms("Read ../secrets folder").filter((term) => term.includes("secrets"))).toEqual([]);
    expect(terms("")).toEqual([]);
  });

  it("keeps a folder whose own name ends in -dir", () => {
    expect(terms("Was macht der add-dir Ordner?")).toEqual(["add-dir"]);
    expect(
      namedScopeDirectories("Was macht der add-dir Ordner?", INVENTORY, []).directories,
    ).toEqual(["commands/add-dir"]);
  });
});

describe("namedScopeDirectories", () => {
  it("finds a named folder at any depth of the admitted inventory", () => {
    expect(namedScopeDirectories("im commands-Ordner", INVENTORY, [])).toEqual({
      directories: ["commands", "utils/commands"],
      ambiguousTermCount: 0,
    });
    expect(
      namedScopeDirectories("the components/PromptInput folder", INVENTORY, []).directories,
    ).toEqual(["components/PromptInput"]);
    expect(namedScopeDirectories("der PromptInput-Ordner", INVENTORY, []).directories).toEqual([
      "components/PromptInput",
    ]);
  });

  it("matches only folders strictly below the selected directory scope", () => {
    const scoped = INVENTORY.map((path) => `src/${path}`);
    expect(namedScopeDirectories("the src folder", scoped, ["src"]).directories).toEqual([]);
    expect(namedScopeDirectories("the commands folder", scoped, ["src"]).directories).toEqual([
      "src/commands",
      "src/utils/commands",
    ]);
  });

  it("reports no match for folders the inventory does not hold", () => {
    expect(namedScopeDirectories("the missing folder", INVENTORY, [])).toEqual({
      directories: [],
      ambiguousTermCount: 0,
    });
  });

  it("bounds ambiguous names and drops nested duplicates", () => {
    const many = Array.from(
      { length: NAMED_DIRECTORY_FOCUS_MAX_DIRECTORIES + 3 },
      (_, index) => `pkg${String(index)}/lib/file.ts`,
    );
    const match = namedScopeDirectories("the lib folder", many, []);
    expect(match.directories).toHaveLength(NAMED_DIRECTORY_FOCUS_MAX_DIRECTORIES);
    expect(match.ambiguousTermCount).toBe(1);
    expect(
      namedScopeDirectories("the aa folder and the aa/bb folder", ["aa/bb/c.ts"], []).directories,
    ).toEqual(["aa"]);
  });
});

const IDENTITY = { scopeId: "scope", queryFingerprint: "fingerprint", emittedAtMs: 1 };

describe("retainFocusFiles", () => {
  it("retains entry files first and stays within the byte capacity", () => {
    const descriptors = [
      { scopePath: "commands/z/z.ts", contentBytes: 400, lineCount: 10 },
      { scopePath: "commands/z/index.ts", contentBytes: 400, lineCount: 10 },
      { scopePath: "commands/README.md", contentBytes: 400, lineCount: 10 },
    ];
    const all = retainFocusFiles(descriptors, 1_000_000, IDENTITY);
    expect(all.atoms.map((atom) => atom.scopePath)).toEqual([
      "commands/README.md",
      "commands/z/index.ts",
      "commands/z/z.ts",
    ]);
    expect(all.droppedFileCount).toBe(0);
    const capacity = all.chargedBytes - 1;
    const bounded = retainFocusFiles(descriptors, capacity, IDENTITY);
    expect(bounded.atoms.map((atom) => atom.scopePath)).toEqual([
      "commands/README.md",
      "commands/z/index.ts",
    ]);
    expect(bounded.droppedFileCount).toBe(1);
    expect(bounded.chargedBytes).toBeLessThanOrEqual(capacity);
    expect(bounded.atoms[0]).toMatchObject({
      lineRange: { startLine: 1, endLine: 10 },
      provenance: { kind: "file-listing", tool: "repo.findFiles" },
    });
  });

  it("keeps a smaller later file when a larger earlier one does not fit", () => {
    const retained = retainFocusFiles(
      [
        { scopePath: "a/index.ts", contentBytes: 10_000, lineCount: 1 },
        { scopePath: "a/small.ts", contentBytes: 10, lineCount: 1 },
      ],
      2_000,
      IDENTITY,
    );
    expect(retained.atoms.map((atom) => atom.scopePath)).toEqual(["a/small.ts"]);
    expect(retained.droppedFileCount).toBe(1);
  });

  it("retains nothing for an empty subtree", () => {
    expect(retainFocusFiles([], 1_000, IDENTITY)).toMatchObject({
      atoms: [],
      chargedBytes: 0,
      droppedFileCount: 0,
    });
  });
});

describe("FocusDescriptorCollector", () => {
  it("collects only files below the focused folders", () => {
    const collector = new FocusDescriptorCollector(["commands"]);
    expect(collector.observe({ scopePath: "commands.ts", contentBytes: 1, lineCount: 1 })).toBe(
      true,
    );
    expect(collector.observe({ scopePath: "commands/a.ts", contentBytes: 1, lineCount: 1 })).toBe(
      true,
    );
    expect(collector.descriptors().map((file) => file.scopePath)).toEqual(["commands/a.ts"]);
  });

  it("stops observing at its count bound", () => {
    const collector = new FocusDescriptorCollector(["d"]);
    let accepted = true;
    for (
      let index = 0;
      index < NAMED_DIRECTORY_FOCUS_MAX_OBSERVED_FILES + 5 && accepted;
      index += 1
    )
      accepted = collector.observe({
        scopePath: `d/${String(index)}.ts`,
        contentBytes: 1,
        lineCount: 1,
      });
    expect(accepted).toBe(false);
    expect(collector.observedCount()).toBe(NAMED_DIRECTORY_FOCUS_MAX_OBSERVED_FILES);
    expect(collector.observe({ scopePath: "d/late.ts", contentBytes: 1, lineCount: 1 })).toBe(
      false,
    );
  });
});

describe("focusDocumentPaths", () => {
  it("bounds extractable documents below the focused folders", () => {
    const paths = Array.from(
      { length: NAMED_DIRECTORY_FOCUS_MAX_DOCUMENTS + 2 },
      (_, index) => `docs/deep/${String(index)}.pdf`,
    );
    const selected = focusDocumentPaths(
      [...paths, "other/x.pdf", "docs/readme.ts"],
      ["docs"],
      (path) => path.endsWith(".pdf"),
    );
    expect(selected).toHaveLength(NAMED_DIRECTORY_FOCUS_MAX_DOCUMENTS);
    expect(selected.every((path) => path.startsWith("docs/"))).toBe(true);
  });

  it("orders entry files before deeper ordinary files", () => {
    expect(["a/b/c.ts", "a/index.ts", "a/README.md", "a/x.ts"].sort(compareFocusPaths)).toEqual([
      "a/README.md",
      "a/index.ts",
      "a/x.ts",
      "a/b/c.ts",
    ]);
  });
});
