import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import {
  changesetPayloadBytes,
  materializeReplacementChangeset,
  type CodingToolReplacementChangeset,
  type CodingToolReplacementEdit,
  type ReplacementMaterialization,
} from "./codingToolReplacementEdits.js";
import type {
  SecureWorkspaceTextReadPort,
  SecureWorkspaceTextReadResult,
} from "./secureWorkspaceTextRead.js";

// #3873: replacement edits are materialized into the unified diff the governed editor path applies.
// Every materialized patch below is applied by the real keiko-tools patch engine, so the expected
// file text is asserted on the bytes the editor would write, not on a restated diff.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

/** Applies a materialized patch with the real patch engine and returns the resulting files. */
function applied(
  files: Readonly<Record<string, string>>,
  result: ReplacementMaterialization,
): Readonly<Record<string, string>> {
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
  });
  return Object.fromEntries(
    result.changeset.files.map(({ file }) => [file, readFileSync(join(root, file), "utf8")]),
  );
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

    expect(ambiguous).toMatchObject({ status: "refused", reasonCode: "INVALID_EDITS" });
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
    ],
    [
      "a replacement for a file that does not exist",
      {},
      [{ file: "missing.ts", oldString: "x", newString: "y" }],
      "INVALID_EDITS",
    ],
    [
      "identical old and new text",
      { "a.ts": "x\n" },
      [{ file: "a.ts", oldString: "x", newString: "x" }],
      "INVALID_EDITS",
    ],
  ] as const)("refuses %s", async (_name, files, edits, reasonCode) => {
    const declared = Object.keys(files).length === 0 ? { "missing.ts": undefined } : files;
    expect(await materialize(files, edits, declared)).toMatchObject({
      status: "refused",
      reasonCode,
    });
  });

  it("refuses an edit whose file is not bound to a read digest", async () => {
    expect(
      await materialize({ "a.ts": "x\n" }, [{ file: "a.ts", oldString: "x", newString: "y" }], {}),
    ).toMatchObject({ status: "refused", reasonCode: "PRECONDITION_REQUIRED" });
  });

  it("refuses an edit bound to a stale digest", async () => {
    const result = await materializeReplacementChangeset(
      reader({ "a.ts": "changed\n" }),
      changeset({ "a.ts": "original\n" }, [{ file: "a.ts", oldString: "changed", newString: "x" }]),
      undefined,
    );

    expect(result).toMatchObject({ status: "refused", reasonCode: "CONTENT_HASH_MISMATCH" });
  });

  it("refuses edits that leave the file unchanged", async () => {
    expect(
      await materialize({ "a.ts": "ab\n" }, [
        { file: "a.ts", oldString: "a", newString: "b" },
        { file: "a.ts", oldString: "bb", newString: "ab" },
      ]),
    ).toMatchObject({ status: "refused", reasonCode: "INVALID_EDITS" });
  });

  it("reports a governed read failure other than a missing file", async () => {
    const denied: SecureWorkspaceTextReadPort = {
      readText: (): Promise<SecureWorkspaceTextReadResult> =>
        Promise.resolve({ ok: false, reason: "denied" }),
    };

    const result = await materializeReplacementChangeset(
      denied,
      changeset({ ".env": "" }, [{ file: ".env", oldString: "", newString: "SECRET=1\n" }]),
      undefined,
    );

    expect(result).toEqual({ status: "read-failed" });
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
});
