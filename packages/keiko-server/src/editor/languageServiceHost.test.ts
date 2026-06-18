import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

function host(overlayText = "export const x = 1;\n"): ts.LanguageServiceHost {
  return createContainedLanguageServiceHost({
    fs: nodeWorkspaceFs,
    realRoot: root,
    overlayPath: join(root, "src", "a.ts"),
    overlayText,
    languageId: "typescript",
    cancellation: NO_CANCEL,
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
