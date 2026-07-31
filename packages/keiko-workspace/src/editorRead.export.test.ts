// The published export surface of `@oscharko-dev/keiko-workspace/internal/editor-read`.
//
// Every other test in this package imports the editor read lane relatively (`./discovery.js`), which
// exercises the FUNCTION but not the EXPORT MAP: a broken or renamed `exports` entry in package.json
// would leave all of them green while every consumer failed to resolve the module. This file is the
// only one that goes through the published subpath, so it is what turns an export-map break into a
// named failure here rather than a resolution error in a downstream package (Qodo rule 2177369 on
// #2869 — "require tests and documentation when changing public exports").
//
// Why a subpath at all, rather than the package barrel: the barrel's `readWorkspaceFile` returns
// REDACTED bytes, which is the evidence lane every ordinary consumer must get. The raw read exists
// for the editor's search-and-replace coordinates, where redaction would shift every offset and
// corrupt a write. Putting it behind `./internal/editor-read` means a caller has to name the raw
// lane deliberately; it can never be reached by autocompleting the barrel (ADR-0005 read boundary).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readWorkspaceFileForEditing,
  type RawFileContent,
} from "@oscharko-dev/keiko-workspace/internal/editor-read";
import { readWorkspaceFile } from "@oscharko-dev/keiko-workspace";
import { detectWorkspaceAt } from "./detect.js";

const SECRET_LINE = 'const token = "s3cr3t-export-surface-value";';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-workspace-export-surface-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), `${SECRET_LINE}\n`, "utf8");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("@oscharko-dev/keiko-workspace/internal/editor-read", () => {
  it("resolves through the published subpath and returns the raw bytes", () => {
    const workspace = detectWorkspaceAt(dir);

    const raw: RawFileContent = readWorkspaceFileForEditing(workspace, "src/app.ts");

    expect(raw.rawText).toBe(`${SECRET_LINE}\n`);
    expect(raw.rawText).toContain("s3cr3t-export-surface-value");
  });

  it("keeps the two read lanes structurally incompatible across the package boundary", () => {
    const workspace = detectWorkspaceAt(dir);

    const raw = readWorkspaceFileForEditing(workspace, "src/app.ts");
    const redacted = readWorkspaceFile(workspace, "src/app.ts");

    // `rawText` vs `text` is the whole point of the split: a raw read cannot be passed where a
    // redacted `FileContent` is expected, so an evidence-lane caller cannot pick it up by accident.
    expect(raw).not.toHaveProperty("text");
    expect(redacted).not.toHaveProperty("rawText");
    expect(redacted.text).not.toContain("s3cr3t-export-surface-value");
  });

  it("applies the same security chain as the redacted lane — a raw read is not a relaxed read", () => {
    const workspace = detectWorkspaceAt(dir);

    // Traversal outside the workspace must fail on the raw lane exactly as it does on the barrel's.
    expect(() => readWorkspaceFileForEditing(workspace, "../outside.ts")).toThrow();
  });
});
