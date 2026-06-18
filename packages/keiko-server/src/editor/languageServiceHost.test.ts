import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageServiceLimits,
} from "@oscharko-dev/keiko-contracts";
import ts from "typescript";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createContainedLanguageServiceHost } from "./languageServiceHost.js";

let root: string;
let outside: string;

const NO_CANCEL: ts.HostCancellationToken = { isCancellationRequested: (): boolean => false };

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-host-")));
  root = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.ts"), "export const secret = 'do-not-read';\n", "utf8");
  writeFileSync(join(root, "src", "inside.ts"), "export const inside = 1;\n", "utf8");
});

afterEach(() => {
  rmSync(dirname(root), { recursive: true, force: true });
});

function host(
  overlayText = "export const x = 1;\n",
  limits: LanguageServiceLimits = DEFAULT_LANGUAGE_SERVICE_LIMITS,
): ts.LanguageServiceHost {
  return createContainedLanguageServiceHost({
    fs: nodeWorkspaceFs,
    realRoot: root,
    overlayPath: join(root, "src", "a.ts"),
    overlayText,
    languageId: "typescript",
    cancellation: NO_CANCEL,
    limits,
  });
}

describe("contained language-service host", () => {
  it("serves the in-memory overlay even when the file is absent on disk", () => {
    const h = host("export const fromOverlay = 2;\n");
    expect(h.readFile(join(root, "src", "a.ts"))).toBe("export const fromOverlay = 2;\n");
    expect(h.fileExists(join(root, "src", "a.ts"))).toBe(true);
  });

  it("reads files inside the workspace root", () => {
    expect(host().readFile(join(root, "src", "inside.ts"))).toContain("inside");
  });

  it("refuses to read a file outside the workspace root", () => {
    const h = host();
    expect(h.readFile(join(outside, "secret.ts"))).toBeUndefined();
    expect(h.fileExists(join(outside, "secret.ts"))).toBe(false);
    expect(h.getScriptSnapshot(join(outside, "secret.ts"))).toBeUndefined();
  });

  it("refuses a path that escapes the root via a symlink", () => {
    const link = join(root, "src", "escape.ts");
    symlinkSync(join(outside, "secret.ts"), link);
    const h = host();
    expect(h.readFile(link)).toBeUndefined();
    expect(h.getScriptSnapshot(link)).toBeUndefined();
  });

  it("refuses a denied real target reached through an allowed-looking symlink", () => {
    const secret = join(root, ".env");
    const link = join(root, "src", "config.ts");
    writeFileSync(secret, "export const secret = 'do-not-read';\n", "utf8");
    symlinkSync(secret, link);
    const h = host();
    expect(h.readFile(link)).toBeUndefined();
    expect(h.fileExists(link)).toBe(false);
    expect(h.getScriptSnapshot(link)).toBeUndefined();
  });

  it("enforces per-operation workspace read file and byte limits", () => {
    for (let index = 0; index < 80; index += 1) {
      const suffix = String(index);
      writeFileSync(
        join(root, "src", `file-${suffix}.ts`),
        `export const value${suffix} = 1;\n`,
        "utf8",
      );
    }
    const fileLimited = host("export const x = 1;\n", {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      maxWorkspaceReadFiles: 32,
    });
    const reads = Array.from({ length: 80 }, (_unused, index) =>
      fileLimited.readFile(join(root, "src", `file-${String(index)}.ts`)),
    );
    const successfulReads = reads.filter((value): value is string => value !== undefined);
    expect(successfulReads.length).toBeGreaterThan(0);
    expect(successfulReads.length).toBeLessThan(reads.length);

    const byteLimited = host("export const x = 1;\n", {
      ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
      maxWorkspaceReadFileBytes: 4,
      maxWorkspaceReadBytes: 4,
    });
    expect(byteLimited.readFile(join(root, "src", "inside.ts"))).toBeUndefined();
  });

  it("still serves the TypeScript compiler's own default library files", () => {
    const libPath = ts.getDefaultLibFilePath(host().getCompilationSettings());
    expect(host().fileExists(libPath)).toBe(true);
    expect(host().readFile(libPath)?.length ?? 0).toBeGreaterThan(0);
  });

  it("only realpaths contained or lib paths; an out-of-root path is returned unchanged", () => {
    const h = host();
    // A contained, existing file resolves to its real path inside the root.
    expect(h.realpath?.(join(root, "src", "inside.ts"))).toBe(join(root, "src", "inside.ts"));
    // An out-of-root path is NOT realpathed (no existence oracle); it is echoed back.
    expect(h.realpath?.(join(outside, "secret.ts"))).toBe(join(outside, "secret.ts"));
  });
});
