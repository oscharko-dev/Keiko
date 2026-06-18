import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as editor from "./index.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface EditorManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

function readManifest(): EditorManifest {
  return JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as EditorManifest;
}

describe("@oscharko-dev/keiko-editor public API", () => {
  it("re-exports the package identity and language helpers", () => {
    expect(editor.KEIKO_EDITOR_PACKAGE).toBe("@oscharko-dev/keiko-editor");
    expect(typeof editor.isSupportedEditorLanguage).toBe("function");
    expect([...editor.SUPPORTED_EDITOR_LANGUAGES]).toEqual([
      "typescript",
      "javascript",
      "plaintext",
    ]);
  });

  it("exposes only the intentionally minimal v1 runtime surface", () => {
    expect(Object.keys(editor).sort()).toEqual([
      "KEIKO_EDITOR_PACKAGE",
      "SUPPORTED_EDITOR_LANGUAGES",
      "isSupportedEditorLanguage",
    ]);
  });
});

describe("@oscharko-dev/keiko-editor dependency boundary (Issue #1191 acceptance criteria)", () => {
  it("does not depend on @oscharko-dev/keiko-ui in any dependency field", () => {
    const manifest = readManifest();
    for (const field of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
    ]) {
      expect(Object.keys(field ?? {})).not.toContain("@oscharko-dev/keiko-ui");
    }
  });

  it("treats React as a peer dependency, never a bundled runtime dependency", () => {
    const manifest = readManifest();
    expect(manifest.peerDependencies?.react).toBeDefined();
    expect(manifest.dependencies?.react).toBeUndefined();
    expect(manifest.devDependencies?.react).toBeUndefined();
  });

  it("limits workspace dependencies to keiko-contracts (browser-tier allowlist, ADR-0042)", () => {
    const manifest = readManifest();
    const workspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@oscharko-dev/keiko-"),
    );
    expect(workspaceDeps).toEqual(["@oscharko-dev/keiko-contracts"]);
  });
});
