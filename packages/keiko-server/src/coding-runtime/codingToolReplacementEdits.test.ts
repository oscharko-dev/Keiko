import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch, validatePatch } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import {
  changesetPayloadBytes,
  EMPTY_CONTENT_SHA256,
  materializeReplacementChangeset,
  REPLACEMENT_REFUSALS,
  type CodingToolReplacementChangeset,
  type CodingToolReplacementEdit,
  type ReplacementMaterialization,
} from "./codingToolReplacementEdits.js";
import { createMaterializedPatchRegistry } from "./materializedPatchRegistry.js";
import {
  secureWorkspaceTextDigest,
  type SecureWorkspaceTextReadPort,
  type SecureWorkspaceTextReadResult,
} from "./secureWorkspaceTextRead.js";
import { SECURE_WORKSPACE_TEXT_READ_MAX_BYTES } from "./secureWorkspaceTextReadProtocol.js";

// #3873: replacement edits are materialized into the unified diff the governed editor path applies.
// Materialized patches are applied by the real keiko-tools patch engine, except the read-ceiling
// case, which isolates materialization from that engine's independent source-file budget. Every
// expectedContentHash is produced by the digest function the governed read reports, never by a
// local copy of its formula (#3873 review).

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = secureWorkspaceTextDigest;

function reader(files: Readonly<Record<string, string>>): SecureWorkspaceTextReadPort {
  return {
    readText: ({ relativePath }): Promise<SecureWorkspaceTextReadResult> =>
      Promise.resolve(
        Object.hasOwn(files, relativePath)
          ? { ok: true, text: files[relativePath] ?? "" }
          : { ok: false, reason: "not-found" },
      ),
  };
}

function changeset(
  files: Readonly<Record<string, string | undefined>>,
  edits: readonly CodingToolReplacementEdit[],
): CodingToolReplacementChangeset {
  return {
    edits,
    files: Object.entries(files).map(([file, text]) => ({
      file,
      expectedContentHash: sha256(text ?? ""),
    })),
  };
}

function workspace(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

/**
 * Applies a materialized patch with the real patch engine and returns the resulting files; a file
 * the patch deleted is reported as `undefined`. A patch is applied the way the editor route applies
 * the diff of a registered materialization when `lineBreakMarkers` is `"verbatim"`.
 */
function applied(
  files: Readonly<Record<string, string>>,
  result: ReplacementMaterialization,
  lineBreakMarkers: "reject" | "verbatim" = "reject",
): Readonly<Record<string, string | undefined>> {
  if (result.status !== "materialized") throw new Error(`expected a patch, got ${result.status}`);
  const root = mkdtempSync(join(tmpdir(), "keiko-replacement-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  applyPatch(workspace(root), result.changeset.patch, {
    applyEnabled: true,
    signal: new AbortController().signal,
    lineBreakMarkers,
  });
  return Object.fromEntries(
    result.changeset.files.map(({ file }) => [
      file,
      existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : undefined,
    ]),
  );
}

// What the editor route does with a rendered diff (agentRoutes.ts): the edit port registers its exact
// text, and the route validates with verbatim line-break markers only for a registered text.
function engineMode(patch: string, registered: boolean): "reject" | "verbatim" {
  const registry = createMaterializedPatchRegistry();
  if (registered) registry.register(patch);
  return registry.lookup(patch).registered ? "verbatim" : "reject";
}

function engineVerdict(
  files: Readonly<Record<string, string>>,
  patch: string,
  registered: boolean,
): ReturnType<typeof validatePatch> {
  const root = mkdtempSync(join(tmpdir(), "keiko-verdict-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return validatePatch(workspace(root), patch, { lineBreakMarkers: engineMode(patch, registered) });
}

function patchOf(result: ReplacementMaterialization): string {
  if (result.status !== "materialized") throw new Error(`expected a patch, got ${result.status}`);
  return result.changeset.patch;
}

function refusalMessage(result: ReplacementMaterialization): string {
  return result.status === "refused" ? result.message : "";
}

async function materialize(
  files: Readonly<Record<string, string>>,
  edits: readonly CodingToolReplacementEdit[],
  declared: Readonly<Record<string, string | undefined>> = files,
): Promise<ReplacementMaterialization> {
  return materializeReplacementChangeset(reader(files), changeset(declared, edits), undefined);
}

const LEDGER = [
  'import type { Cents } from "./money.ts";',
  "",
  "export function total(values: readonly Cents[]): Cents {",
  "  return values.reduce((sum, value) => sum + value, 0);",
  "}",
  "",
].join("\n");

describe("materializeReplacementChangeset", () => {
  it("turns one exact replacement into a patch the editor applies byte for byte", async () => {
    const files = { "src/total.ts": LEDGER };

    const result = await materialize(files, [
      {
        file: "src/total.ts",
        oldString: "sum + value, 0",
        newString: "sum + value, 0 as Cents",
      },
    ]);

    expect(result).toMatchObject({
      status: "materialized",
      changeset: {
        files: [{ file: "src/total.ts", expectedContentHash: sha256(LEDGER) }],
        selectedFiles: ["src/total.ts"],
      },
    });
    expect(applied(files, result)["src/total.ts"]).toBe(
      LEDGER.replace("sum + value, 0", "sum + value, 0 as Cents"),
    );
  });

  it("applies several replacements to one file in order and edits several files", async () => {
    const files = { "a.ts": "one\ntwo\nthree\n", "b.ts": 'const name = "x";\n' };

    const result = await materialize(files, [
      { file: "a.ts", oldString: "one", newString: "1" },
      { file: "b.ts", oldString: '"x"', newString: '"y"' },
      { file: "a.ts", oldString: "1\ntwo", newString: "1\n2" },
    ]);

    expect(applied(files, result)).toEqual({
      "a.ts": "1\n2\nthree\n",
      "b.ts": 'const name = "y";\n',
    });
  });

  it("replaces every occurrence only when replaceAll is set", async () => {
    const files = { "a.ts": "x = 1;\nx = 2;\n" };

    const ambiguous = await materialize(files, [{ file: "a.ts", oldString: "x", newString: "y" }]);
    const all = await materialize(files, [
      { file: "a.ts", oldString: "x", newString: "y", replaceAll: true },
    ]);

    expect(ambiguous).toMatchObject({
      status: "refused",
      reasonCode: "INVALID_EDITS",
      refusal: "old-string-ambiguous",
    });
    expect(ambiguous.status === "refused" ? ambiguous.message : "").toContain("matches 2 places");
    expect(applied(files, all)["a.ts"]).toBe("y = 1;\ny = 2;\n");
  });

  it("refuses text the file does not contain, naming the file", async () => {
    const result = await materialize({ "a.ts": "const a = 1;\n" }, [
      { file: "a.ts", oldString: "const a = 2;", newString: "const a = 3;" },
    ]);

    expect(result).toEqual({
      status: "refused",
      reasonCode: "INVALID_EDITS",
      refusal: "old-string-not-found",
      message: "oldString was not found in a.ts; copy the exact current text from a fresh read.",
    });
  });

  it("matches a plain-newline replacement in a CRLF file and keeps its line endings", async () => {
    const files = { "a.ts": "first\r\nsecond\r\nthird\r\n" };

    const result = await materialize(files, [
      { file: "a.ts", oldString: "first\nsecond", newString: "first\nmiddle\nsecond" },
    ]);

    expect(applied(files, result)["a.ts"]).toBe("first\r\nmiddle\r\nsecond\r\nthird\r\n");
  });

  // #3873 review: the CRLF fallback was all-or-nothing, so a region spanning a "\r\n" line and a
  // "\n" line could never match, and the model resent the same edit until its budget was gone.
  // Matching is line-ending-insensitive now; each replaced line keeps the ending it had.
  it("matches across a CRLF/LF boundary in a file with mixed endings and keeps each ending", async () => {
    const files = { "a.ts": "one\r\ntwo\nthree\r\nfour\n" };

    const result = await materialize(files, [
      { file: "a.ts", oldString: "one\ntwo\nthree", newString: "1\n2\n3" },
    ]);

    expect(applied(files, result)["a.ts"]).toBe("1\r\n2\n3\r\nfour\n");
  });

  it("matches an oldString that kept its carriage returns and one that dropped them alike", async () => {
    const files = { "a.ts": "alpha\r\nbeta\r\n" };

    const kept = await materialize(files, [
      { file: "a.ts", oldString: "alpha\r\nbeta", newString: "ALPHA\r\nBETA" },
    ]);
    const dropped = await materialize(files, [
      { file: "a.ts", oldString: "alpha\nbeta", newString: "ALPHA\nBETA" },
    ]);

    expect(applied(files, kept)["a.ts"]).toBe("ALPHA\r\nBETA\r\n");
    expect(applied(files, dropped)["a.ts"]).toBe("ALPHA\r\nBETA\r\n");
  });

  it("gives a line break the replacement adds the file's majority ending", async () => {
    const crlfMajority = { "a.ts": "one\r\ntwo\r\nthree\n" };
    const lfMajority = { "b.ts": "one\ntwo\nthree\r\n" };

    const added = await materialize(crlfMajority, [
      { file: "a.ts", oldString: "three", newString: "three\nfour" },
    ]);
    const addedLf = await materialize(lfMajority, [
      { file: "b.ts", oldString: "one", newString: "zero\none" },
    ]);

    expect(applied(crlfMajority, added)["a.ts"]).toBe("one\r\ntwo\r\nthree\r\nfour\n");
    expect(applied(lfMajority, addedLf)["b.ts"]).toBe("zero\none\ntwo\nthree\r\n");
  });

  // #3873 review: `replaceAll` built the whole result before any size check; one short edit
  // against a 64 KB file could hold the event loop for seconds and the heap for a gigabyte. The
  // result is projected from the match count and refused before it is built: with 20,000 matches
  // of a 65,536-character replacement, building it would throw "Invalid string length".
  it("refuses a replaceAll whose projected result exceeds the read ceiling without building it", async () => {
    const files = { "a.ts": "\n".repeat(20_000) };

    const result = await materialize(files, [
      { file: "a.ts", oldString: "\n", newString: "x".repeat(65_536), replaceAll: true },
    ]);

    expect(result).toEqual({
      status: "refused",
      reasonCode: "LIMIT_EXCEEDED",
      refusal: "result-too-large",
      message: `The edits make a.ts larger than ${String(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES)} bytes, which no governed read could return; split the edits or narrow replaceAll.`,
    });
  });

  it("refuses an edit that grows a file past the read ceiling, in bytes", async () => {
    const prefix = "x\n".repeat((SECURE_WORKSPACE_TEXT_READ_MAX_BYTES - 1_000) / 2);
    const files = { "a.ts": `${prefix}end\n` };

    const grown = await materialize(files, [
      { file: "a.ts", oldString: "end", newString: "y".repeat(1_001) },
    ]);
    // The same replacement fits in code units but exceeds the physical UTF-8 byte ceiling.
    const wide = await materialize(files, [
      { file: "a.ts", oldString: "end", newString: "é".repeat(501) },
    ]);
    const fitting = await materialize(files, [
      { file: "a.ts", oldString: "end", newString: "y".repeat(992) },
    ]);

    expect(grown).toMatchObject({ status: "refused", refusal: "result-too-large" });
    expect(wide).toMatchObject({ status: "refused", refusal: "result-too-large" });
    expect(fitting.status).toBe("materialized");
    if (fitting.status !== "materialized") throw new Error("expected bounded patch");
    expect(Buffer.byteLength(fitting.changeset.patch, "utf8")).toBeLessThan(
      EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
    );
  });

  it("keeps a missing final line break", async () => {
    const files = { "a.ts": "alpha\nbeta" };

    const result = await materialize(files, [
      { file: "a.ts", oldString: "beta", newString: "gamma" },
    ]);

    expect(applied(files, result)["a.ts"]).toBe("alpha\ngamma");
  });

  it("creates a new file from an empty oldString bound to the empty-content digest", async () => {
    const result = await materializeReplacementChangeset(
      reader({}),
      changeset({ "src/new.ts": undefined }, [
        { file: "src/new.ts", oldString: "", newString: "export const created = true;\n" },
      ]),
      undefined,
    );

    expect(result.status === "materialized" ? result.changeset.patch : "").toMatch(
      /^--- \/dev\/null\n\+\+\+ b\/src\/new\.ts\n@@ -0,0 \+1,1 @@\n/u,
    );
    expect(applied({}, result)["src/new.ts"]).toBe("export const created = true;\n");
  });

  it.each([
    [
      "an empty oldString for a file with content",
      { "a.ts": "x\n" },
      [{ file: "a.ts", oldString: "", newString: "y\n" }],
      "INVALID_EDITS",
      "create-over-content",
    ],
    [
      "a replacement for a file that does not exist",
      {},
      [{ file: "missing.ts", oldString: "x", newString: "y" }],
      "INVALID_EDITS",
      "file-missing",
    ],
    [
      "identical old and new text",
      { "a.ts": "x\n" },
      [{ file: "a.ts", oldString: "x", newString: "x" }],
      "INVALID_EDITS",
      "identical-strings",
    ],
  ] as const)("refuses %s", async (_name, files, edits, reasonCode, refusal) => {
    const declared = Object.keys(files).length === 0 ? { "missing.ts": undefined } : files;
    expect(await materialize(files, edits, declared)).toMatchObject({
      status: "refused",
      reasonCode,
      refusal,
    });
  });

  it("refuses an edit whose file is not bound to a read digest", async () => {
    expect(
      await materialize({ "a.ts": "x\n" }, [{ file: "a.ts", oldString: "x", newString: "y" }], {}),
    ).toMatchObject({
      status: "refused",
      reasonCode: "PRECONDITION_REQUIRED",
      refusal: "digest-unbound",
    });
  });

  it("refuses an edit bound to a stale digest", async () => {
    const result = await materializeReplacementChangeset(
      reader({ "a.ts": "changed\n" }),
      changeset({ "a.ts": "original\n" }, [{ file: "a.ts", oldString: "changed", newString: "x" }]),
      undefined,
    );

    expect(result).toMatchObject({
      status: "refused",
      reasonCode: "CONTENT_HASH_MISMATCH",
      refusal: "stale-digest",
    });
  });

  it("refuses edits that leave the file unchanged", async () => {
    expect(
      await materialize({ "a.ts": "ab\n" }, [
        { file: "a.ts", oldString: "a", newString: "b" },
        { file: "a.ts", oldString: "bb", newString: "ab" },
      ]),
    ).toMatchObject({ status: "refused", reasonCode: "INVALID_EDITS", refusal: "no-change" });
  });

  it("reports a governed read failure other than a missing file with its closed reason", async () => {
    const denied: SecureWorkspaceTextReadPort = {
      readText: (): Promise<SecureWorkspaceTextReadResult> =>
        Promise.resolve({ ok: false, reason: "denied" }),
    };

    const result = await materializeReplacementChangeset(
      denied,
      changeset({ ".env": "" }, [{ file: ".env", oldString: "", newString: "SECRET=1\n" }]),
      undefined,
    );

    expect(result).toEqual({ status: "read-failed", reason: "denied", file: ".env" });
  });

  it("drops declared files without edits and keeps a selection of edited ones", async () => {
    const files = { "a.ts": "a\n", "b.ts": "b\n" };
    const result = await materializeReplacementChangeset(
      reader(files),
      {
        ...changeset(files, [{ file: "a.ts", oldString: "a", newString: "A" }]),
        selectedFiles: ["a.ts", "b.ts"],
      },
      undefined,
    );

    expect(result).toMatchObject({
      status: "materialized",
      changeset: { files: [{ file: "a.ts" }], selectedFiles: ["a.ts"] },
    });
  });
});

// #3873 follow-up: the model cannot write a `/dev/null` diff, so `deletions` and `renames` are
// materialized here into the full pre-image deletion and the deletion-plus-creation the patch engine
// already applies. Every patch below is applied by the real engine, so the asserted outcome is the
// tree the editor would leave behind, never a restated diff.
describe("materializeReplacementChangeset deletions and renames", () => {
  const OLD = "export const old = 1;\nexport const older = 2;\n";

  function operations(
    files: Readonly<Record<string, string | undefined>>,
    members: Partial<CodingToolReplacementChangeset>,
  ): CodingToolReplacementChangeset {
    return { ...changeset(files, []), ...members };
  }

  it("deletes one file as its full pre-image bound to its read digest", async () => {
    const files = { "src/old.ts": OLD, "src/keep.ts": "keep\n" };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(files, { deletions: ["src/old.ts"] }),
      undefined,
    );

    expect(result).toMatchObject({
      status: "materialized",
      changeset: {
        files: [{ file: "src/old.ts", expectedContentHash: sha256(OLD) }],
        selectedFiles: ["src/old.ts"],
      },
    });
    expect(patchOf(result)).toBe(
      "--- a/src/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-export const old = 1;\n-export const older = 2;\n",
    );
    expect(applied(files, result)).toEqual({ "src/old.ts": undefined });
  });

  it("renames one file as a deletion of from and a creation of to with identical content", async () => {
    const files = { "src/total.ts": LEDGER };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(
        { ...files, "src/ledger.ts": undefined },
        { renames: [{ from: "src/total.ts", to: "src/ledger.ts" }] },
      ),
      undefined,
    );

    expect(result).toMatchObject({
      status: "materialized",
      changeset: {
        files: [
          { file: "src/total.ts", expectedContentHash: sha256(LEDGER) },
          { file: "src/ledger.ts", expectedContentHash: EMPTY_CONTENT_SHA256 },
        ],
        selectedFiles: ["src/total.ts", "src/ledger.ts"],
      },
    });
    expect(patchOf(result)).toMatch(
      /^--- a\/src\/total\.ts\n\+\+\+ \/dev\/null\n@@ -1,5 \+0,0 @@\n(?:-.*\n){5}--- \/dev\/null\n\+\+\+ b\/src\/ledger\.ts\n@@ -0,0 \+1,5 @@\n/u,
    );
    expect(applied(files, result)).toEqual({ "src/total.ts": undefined, "src/ledger.ts": LEDGER });
  });

  it("applies renames before edits, so an edit addresses the moved file by its new path", async () => {
    const files = { "src/total.ts": LEDGER };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(
        { ...files, "src/ledger.ts": undefined },
        {
          renames: [{ from: "src/total.ts", to: "src/ledger.ts" }],
          edits: [
            {
              file: "src/ledger.ts",
              oldString: "sum + value, 0",
              newString: "sum + value, 0 as Cents",
            },
          ],
        },
      ),
      undefined,
    );

    expect(applied(files, result)).toEqual({
      "src/total.ts": undefined,
      "src/ledger.ts": LEDGER.replace("sum + value, 0", "sum + value, 0 as Cents"),
    });
  });

  it("orders the patch as renames, then edits, then deletions", async () => {
    const files = { "a.ts": "a\n", "c.ts": "c\n", "d.ts": "d\n" };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(
        { ...files, "b.ts": undefined },
        {
          deletions: ["d.ts"],
          edits: [{ file: "c.ts", oldString: "c", newString: "C" }],
          renames: [{ from: "a.ts", to: "b.ts" }],
        },
      ),
      undefined,
    );

    const headers = patchOf(result)
      .split("\n")
      .filter((line) => line.startsWith("--- ") || line.startsWith("+++ "));
    expect(headers).toEqual([
      "--- a/a.ts",
      "+++ /dev/null",
      "--- /dev/null",
      "+++ b/b.ts",
      "--- a/c.ts",
      "+++ b/c.ts",
      "--- a/d.ts",
      "+++ /dev/null",
    ]);
    expect(applied(files, result)).toEqual({
      "a.ts": undefined,
      "b.ts": "a\n",
      "c.ts": "C\n",
      "d.ts": undefined,
    });
  });

  it("keeps a missing final line break through a rename and deletes a file that lacks one", async () => {
    const files = { "a.ts": "alpha\nbeta", "d.ts": "delta" };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(
        { ...files, "b.ts": undefined },
        { renames: [{ from: "a.ts", to: "b.ts" }], deletions: ["d.ts"] },
      ),
      undefined,
    );

    expect(applied(files, result)).toEqual({
      "a.ts": undefined,
      "b.ts": "alpha\nbeta",
      "d.ts": undefined,
    });
  });

  it("deletes and moves empty files through hunk-free sections the engine accepts", async () => {
    const files = { "empty.ts": "", "void.ts": "" };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(
        { ...files, "moved.ts": undefined },
        { renames: [{ from: "empty.ts", to: "moved.ts" }], deletions: ["void.ts"] },
      ),
      undefined,
    );

    expect(patchOf(result)).toBe(
      "--- a/empty.ts\n+++ /dev/null\n--- /dev/null\n+++ b/moved.ts\n--- a/void.ts\n+++ /dev/null\n",
    );
    expect(applied(files, result)).toEqual({
      "empty.ts": undefined,
      "moved.ts": "",
      "void.ts": undefined,
    });
  });

  it.each([
    [
      "an edit addressed to a path renamed away in the same call",
      {
        renames: [{ from: "a.ts", to: "b.ts" }],
        edits: [{ file: "a.ts", oldString: "a", newString: "A" }],
      },
      "path-conflict",
      "a.ts no longer exists after the renames in this call; address its edits to b.ts.",
    ],
    [
      "a deletion of a path renamed away in the same call",
      { renames: [{ from: "a.ts", to: "b.ts" }], deletions: ["a.ts"] },
      "path-conflict",
      "a.ts no longer exists after the renames in this call.",
    ],
    [
      "a rename whose target is also deleted",
      { renames: [{ from: "a.ts", to: "b.ts" }], deletions: ["b.ts"] },
      "path-conflict",
      "b.ts is named more than once in this call.",
    ],
    [
      "two renames with the same target",
      {
        renames: [
          { from: "a.ts", to: "b.ts" },
          { from: "c.ts", to: "b.ts" },
        ],
      },
      "path-conflict",
      "b.ts is named more than once in this call.",
    ],
    [
      "a rename chained through another rename's target",
      {
        renames: [
          { from: "a.ts", to: "b.ts" },
          { from: "b.ts", to: "c.ts" },
        ],
      },
      "path-conflict",
      "b.ts is named more than once in this call.",
    ],
    [
      "a rename to the same path",
      { renames: [{ from: "a.ts", to: "a.ts" }] },
      "path-conflict",
      "a.ts is renamed to itself.",
    ],
    [
      "a duplicate deletion",
      { deletions: ["d.ts", "d.ts"] },
      "path-conflict",
      "d.ts is named more than once in this call.",
    ],
    [
      "a deletion of a file that is also edited",
      { deletions: ["c.ts"], edits: [{ file: "c.ts", oldString: "c", newString: "C" }] },
      "path-conflict",
      "c.ts is both edited and deleted in this call; drop one of them.",
    ],
    [
      "a changeset that changes nothing",
      { edits: [], deletions: [], renames: [] },
      "no-change",
      "The changeset changes nothing; add an edit, a rename or a deletion.",
    ],
  ] as const)("refuses %s before reading any file", async (_name, members, refusal, message) => {
    const files = { "a.ts": "a\n", "c.ts": "c\n", "d.ts": "d\n" };
    let reads = 0;
    const counting = reader(files);
    const read = {
      readText: (
        request: Parameters<typeof counting.readText>[0],
      ): Promise<SecureWorkspaceTextReadResult> => {
        reads += 1;
        return counting.readText(request);
      },
    };

    const result = await materializeReplacementChangeset(
      read,
      operations({ ...files, "b.ts": undefined }, members),
      undefined,
    );

    expect(result).toEqual({ status: "refused", reasonCode: "INVALID_EDITS", refusal, message });
    expect(reads).toBe(0);
  });

  it("refuses a rename target that already exists", async () => {
    const files = { "a.ts": "a\n", "b.ts": "" };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(files, { renames: [{ from: "a.ts", to: "b.ts" }] }),
      undefined,
    );

    expect(result).toEqual({
      status: "refused",
      reasonCode: "INVALID_EDITS",
      refusal: "target-exists",
      message: "b.ts already exists; a rename target must be a new path.",
    });
  });

  it("refuses a deletion of a file that does not exist", async () => {
    const result = await materializeReplacementChangeset(
      reader({}),
      operations({ "gone.ts": undefined }, { deletions: ["gone.ts"] }),
      undefined,
    );

    expect(result).toEqual({
      status: "refused",
      reasonCode: "INVALID_EDITS",
      refusal: "file-missing",
      message: "gone.ts does not exist.",
    });
  });

  it.each([
    ["a deleted file", { deletions: ["a.ts"] }, "a.ts"],
    ["a rename source", { renames: [{ from: "a.ts", to: "b.ts" }] }, "a.ts"],
  ] as const)(
    "requires %s to be listed in files with its read digest",
    async (_name, members, file) => {
      const result = await materializeReplacementChangeset(
        reader({ "a.ts": "a\n" }),
        operations({ "b.ts": undefined }, members),
        undefined,
      );

      expect(result).toEqual({
        status: "refused",
        reasonCode: "PRECONDITION_REQUIRED",
        refusal: "digest-unbound",
        message: `List ${file} in files with the digest from its latest keiko_workspace_read.`,
      });
    },
  );

  it("requires a rename target to be listed in files with the empty-content digest", async () => {
    const files = { "a.ts": "a\n" };
    const missing = await materializeReplacementChangeset(
      reader(files),
      operations(files, { renames: [{ from: "a.ts", to: "b.ts" }] }),
      undefined,
    );
    const wrongDigest = await materializeReplacementChangeset(
      reader(files),
      operations({ ...files, "b.ts": "not empty\n" }, { renames: [{ from: "a.ts", to: "b.ts" }] }),
      undefined,
    );

    expect(missing).toMatchObject({
      status: "refused",
      reasonCode: "PRECONDITION_REQUIRED",
      refusal: "digest-unbound",
    });
    expect(wrongDigest).toMatchObject({
      status: "refused",
      reasonCode: "CONTENT_HASH_MISMATCH",
      refusal: "stale-digest",
    });
    for (const result of [missing, wrongDigest]) {
      expect(refusalMessage(result)).toBe(
        `List b.ts in files with the empty-content SHA-256 ${EMPTY_CONTENT_SHA256}; a rename target is a new file.`,
      );
    }
  });

  it("refuses a stale digest on a deleted file and on a rename source", async () => {
    const stale = sha256("original\n");
    const read = reader({ "a.ts": "changed\n", "d.ts": "changed\n" });

    const deletion = await materializeReplacementChangeset(
      read,
      { edits: [], deletions: ["d.ts"], files: [{ file: "d.ts", expectedContentHash: stale }] },
      undefined,
    );
    const rename = await materializeReplacementChangeset(
      read,
      {
        edits: [],
        renames: [{ from: "a.ts", to: "b.ts" }],
        files: [
          { file: "a.ts", expectedContentHash: stale },
          { file: "b.ts", expectedContentHash: EMPTY_CONTENT_SHA256 },
        ],
      },
      undefined,
    );

    expect(deletion).toMatchObject({ status: "refused", reasonCode: "CONTENT_HASH_MISMATCH" });
    expect(rename).toMatchObject({ status: "refused", reasonCode: "CONTENT_HASH_MISMATCH" });
  });

  it.each([
    ["a rename target", { renames: [{ from: "a.ts", to: "b.ts" }] }, ["a.ts"], "b.ts"],
    ["a rename source", { renames: [{ from: "a.ts", to: "b.ts" }] }, ["b.ts"], "a.ts"],
    ["a deleted file", { deletions: ["d.ts"] }, ["a.ts"], "d.ts"],
    [
      "an edited file",
      { edits: [{ file: "c.ts", oldString: "c", newString: "C" }] },
      ["a.ts"],
      "c.ts",
    ],
  ] as const)(
    "refuses %s missing from a supplied selectedFiles instead of applying a partial call",
    async (_name, members, selectedFiles, missing) => {
      const files = { "a.ts": "a\n", "c.ts": "c\n", "d.ts": "d\n" };

      const result = await materializeReplacementChangeset(
        reader(files),
        operations({ ...files, "b.ts": undefined }, { ...members, selectedFiles }),
        undefined,
      );

      expect(result).toEqual({
        status: "refused",
        reasonCode: "INVALID_EDITS",
        refusal: "selection-gap",
        message: `List ${missing} in selectedFiles.`,
      });
    },
  );

  it("reports a governed read failure for a rename target other than a missing file", async () => {
    const denied: SecureWorkspaceTextReadPort = {
      readText: ({ relativePath }): Promise<SecureWorkspaceTextReadResult> =>
        Promise.resolve(
          relativePath === "a.ts" ? { ok: true, text: "a\n" } : { ok: false, reason: "busy" },
        ),
    };

    const result = await materializeReplacementChangeset(
      denied,
      operations({ "a.ts": "a\n", "b.ts": undefined }, { renames: [{ from: "a.ts", to: "b.ts" }] }),
      undefined,
    );

    expect(result).toEqual({ status: "read-failed", reason: "busy", file: "b.ts" });
  });

  // A rename carries the whole file twice and cannot be split: one that alone exceeds the
  // 65,536-byte changeset cap (ADR-0125 D3) is refused with that reason and an action the model can
  // take, never "split it into smaller calls" (#3873 review).
  it("refuses a rename whose whole-file rendering alone exceeds the patch byte cap", async () => {
    const large = `${"x".repeat(1_023)}\n`.repeat(40);
    const files = { "large.ts": large };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(
        { ...files, "moved.ts": undefined },
        { renames: [{ from: "large.ts", to: "moved.ts" }] },
      ),
      undefined,
    );

    expect(result).toMatchObject({
      status: "refused",
      reasonCode: "LIMIT_EXCEEDED",
      refusal: "whole-file-too-large",
    });
    expect(result).toHaveProperty(
      "message",
      expect.stringContaining("large.ts cannot be moved with keiko_changeset_edit"),
    );
    expect(result).not.toHaveProperty("message", expect.stringContaining("split"));
  });

  // The editor route's changed-line limit (DEFAULT_PATCH_LIMITS) binds the rendered diff: a rename
  // of a 1,001-line file removes and adds every line, 2,002 in all, and is refused here, before the
  // run's budget is charged, instead of later by the route with advice the model cannot follow.
  it("refuses moving a file over 1,000 lines before the editor route would", async () => {
    const files = { "long.ts": "line\n".repeat(1_001) };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(
        { ...files, "moved.ts": undefined },
        { renames: [{ from: "long.ts", to: "moved.ts" }] },
      ),
      undefined,
    );

    expect(result).toMatchObject({ status: "refused", refusal: "whole-file-too-large" });
    expect(result).toHaveProperty("message", expect.stringContaining("2002 changed lines"));
  });

  // keiko-tools refuses any diff text with a literal backslash-n followed by +, - or a space (its
  // guard against a model collapsing a diff's lines into one, pinned there). The materializer renders
  // its diff itself, from the bytes of a governed read, so such text is file text here: a deletion
  // renders the whole file, and a file that spells one in a string is deleted like any other. The
  // editor route lifts that one heuristic for the registered diff (PR #3876 review).
  it("materializes the deletion of a file whose text spells a backslash-n before a space", async () => {
    const text = 'const s = "a\\n b";\n';
    const files = { "s.ts": text };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(files, { deletions: ["s.ts"] }),
      undefined,
    );

    expect(result).toMatchObject({ status: "materialized" });
    expect(patchOf(result)).toContain(`-${text}`);
    expect(engineVerdict(files, patchOf(result), true).ok).toBe(true);
    expect(applied(files, result, engineMode(patchOf(result), true))).toEqual({
      "s.ts": undefined,
    });
  });

  it("materializes the move of such a file with its text intact", async () => {
    const text = 'export const header = "Name  Amount\\n----  ------\\n";\n';
    const files = { "table.ts": text };

    const result = await materializeReplacementChangeset(
      reader(files),
      operations(
        { ...files, "moved.ts": undefined },
        { renames: [{ from: "table.ts", to: "moved.ts" }] },
      ),
      undefined,
    );

    expect(result).toMatchObject({ status: "materialized" });
    expect(applied(files, result, engineMode(patchOf(result), true))).toEqual({
      "table.ts": undefined,
      "moved.ts": text,
    });
  });

  // An edit beside such text, and an edit that writes such text, were refused up to six times in a
  // row by the pre-check this replaces, and the run ended `edit-retries-exhausted` (PR #3876 review).
  it("materializes an edit beside literal backslash-n text and one that writes it", async () => {
    const source = [
      'export const header = "Name  Amount\\n----  ------\\n";',
      "export const rows = 2;",
      "export const total = 40;",
      "",
    ].join("\n");
    const files = { "src/table.ts": source };
    const note = 'export const note = "first\\n- second\\n+ third";';

    const result = await materialize(files, [
      {
        file: "src/table.ts",
        oldString: "export const total = 40;",
        newString: `export const total = 42;\n${note}`,
      },
    ]);

    expect(result).toMatchObject({ status: "materialized" });
    expect(patchOf(result)).toContain(String.raw`Amount\n----`);
    expect(patchOf(result)).toContain(`+${note}`);
    expect(engineVerdict(files, patchOf(result), true).ok).toBe(true);
    expect(applied(files, result, engineMode(patchOf(result), true))).toEqual({
      "src/table.ts": source.replace("total = 40;", `total = 42;\n${note}`),
    });
  });

  // The engine's guard is unchanged: the same rendered text, without the registration only the edit
  // port that rendered it can give, is still refused as malformed. The pin that rejects a model's
  // collapsed diff stays in keiko-tools; this one proves the rendered diff meets it unregistered.
  it("keeps the engine's refusal for the same text when the diff is not registered", async () => {
    const source =
      'export const header = "Name  Amount\\n----  ------\\n";\nexport const total = 40;\n';
    const files = { "src/table.ts": source };

    const result = await materialize(files, [
      { file: "src/table.ts", oldString: "total = 40;", newString: "total = 42;" },
    ]);

    const unregistered = engineVerdict(files, patchOf(result), false);
    expect(unregistered.ok).toBe(false);
    expect(unregistered.reasons.map((reason) => reason.code)).toContain("malformed");
    expect(unregistered.reasons.map((reason) => reason.message).join(" ")).toContain(
      "escaped newline",
    );
    expect(() => applied(files, result)).toThrow();
    expect(engineVerdict(files, patchOf(result), true).ok).toBe(true);
  });

  it("no longer lists a backslash-n before +, - or a space as a refusal class", () => {
    expect(REPLACEMENT_REFUSALS).not.toContain("escaped-line-break");
  });

  it("still advises splitting an edit-only changeset over the patch byte cap", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 3 }, (_, index) => [`f${String(index)}.ts`, `${"x".repeat(30_000)}\n`]),
    );
    const edits = Object.keys(files).map((file) => ({
      file,
      oldString: "x".repeat(30_000),
      newString: "y".repeat(30_000),
      replaceAll: false,
    }));

    const result = await materializeReplacementChangeset(
      reader(files),
      changeset(files, edits),
      undefined,
    );

    expect(result).toEqual({
      status: "refused",
      reasonCode: "LIMIT_EXCEEDED",
      refusal: "patch-too-large",
      message: `The materialized changeset exceeds ${String(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES)} bytes; split it into smaller calls.`,
    });
  });

  it("refuses edits that change more lines than the editor route allows, advising a split", async () => {
    const files = { "a.ts": "x\n".repeat(1_100) };

    const result = await materializeReplacementChangeset(
      reader(files),
      changeset(files, [
        {
          file: "a.ts",
          oldString: "x\n".repeat(1_100),
          newString: "y\n".repeat(1_100),
          replaceAll: false,
        },
      ]),
      undefined,
    );

    expect(result).toMatchObject({ status: "refused", refusal: "changed-lines-exceeded" });
    expect(result).toHaveProperty("message", expect.stringContaining("split the edits"));
  });
});

// #3873 review: the tool contract says `oldString` is copied byte for byte, so the exact text wins
// over the line-ending-insensitive fallback, and an edit never moves the ending of a line it leaves
// unchanged. Every result is applied by the real patch engine.
describe("materializeReplacementChangeset byte-exact matching", () => {
  it("matches an oldString that ends on the carriage return of a CRLF pair", async () => {
    const files = { "a.ts": "x = 1;\r\ny = 2;\r\n" };

    const result = await materializeReplacementChangeset(
      reader(files),
      changeset(files, [
        { file: "a.ts", oldString: "x = 1;\r", newString: "x = 2;\r", replaceAll: false },
      ]),
      undefined,
    );

    expect(applied(files, result)).toEqual({ "a.ts": "x = 2;\r\ny = 2;\r\n" });
  });

  it("keeps a byte-exact unique oldString unique in a file with mixed endings", async () => {
    const files = { "a.ts": "a\r\nb\na\nb\n" };

    const result = await materializeReplacementChangeset(
      reader(files),
      changeset(files, [
        { file: "a.ts", oldString: "a\r\nb", newString: "A\r\nB", replaceAll: false },
      ]),
      undefined,
    );

    expect(applied(files, result)).toEqual({ "a.ts": "A\r\nB\na\nb\n" });
  });

  // #3873 review: an oldString without a carriage return is what a model reads from either copy, so
  // an LF copy elsewhere in the file must not hide a CRLF copy from replaceAll or from ambiguity.
  it("counts the CRLF copies of an oldString without carriage returns", async () => {
    const files = { "a.ts": "foo\nbar\nmid\r\nfoo\r\nbar\r\nend\r\n" };

    const all = await materializeReplacementChangeset(
      reader(files),
      changeset(files, [
        { file: "a.ts", oldString: "foo\nbar", newString: "baz", replaceAll: true },
      ]),
      undefined,
    );
    const single = await materializeReplacementChangeset(
      reader(files),
      changeset(files, [
        { file: "a.ts", oldString: "foo\nbar", newString: "baz", replaceAll: false },
      ]),
      undefined,
    );

    expect(applied(files, all)).toEqual({ "a.ts": "baz\nmid\r\nbaz\r\nend\r\n" });
    expect(single).toMatchObject({
      status: "refused",
      reasonCode: "INVALID_EDITS",
      refusal: "old-string-ambiguous",
      message: "oldString matches 2 places in a.ts; add surrounding lines or set replaceAll.",
    });
  });

  it("keeps the ending of every line an insertion leaves unchanged", async () => {
    const files = { "a.ts": "one\r\ntwo\nthree\r\n" };

    const result = await materializeReplacementChangeset(
      reader(files),
      changeset(files, [
        {
          file: "a.ts",
          oldString: "one\ntwo\nthree",
          newString: "one\ninserted\ntwo\nthree",
          replaceAll: false,
        },
      ]),
      undefined,
    );

    // `two` keeps its own LF; the inserted line takes the file's majority ending (CRLF).
    expect(applied(files, result)).toEqual({ "a.ts": "one\r\ninserted\r\ntwo\nthree\r\n" });
  });

  // An existing EMPTY file is filled with an empty oldString: the engine anchors the pure insertion
  // at the file's start instead of refusing it as unanchored (#3873 review).
  it("fills an existing empty file", async () => {
    const files = { "__init__.py": "" };

    const result = await materializeReplacementChangeset(
      reader(files),
      changeset(files, [
        { file: "__init__.py", oldString: "", newString: "export {};\n", replaceAll: false },
      ]),
      undefined,
    );

    expect(applied(files, result)).toEqual({ "__init__.py": "export {};\n" });
  });
});

describe("changesetPayloadBytes", () => {
  it("counts a patch and the replacement text of both edit forms", () => {
    expect(changesetPayloadBytes({ patch: "--- a/x\n", files: [] })).toBe(8);
    expect(
      changesetPayloadBytes({
        edits: [{ file: "x", oldString: "äb", newString: "c" }],
        files: [],
      }),
    ).toBe(4);
  });

  it("counts the paths a deletion or rename carries", () => {
    expect(
      changesetPayloadBytes({
        edits: [],
        deletions: ["ab"],
        renames: [{ from: "cde", to: "f" }],
        files: [],
      }),
    ).toBe(6);
  });
});
