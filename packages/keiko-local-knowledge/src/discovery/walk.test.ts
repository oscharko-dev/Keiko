import { describe, expect, it } from "vitest";

import type { KnowledgeSourceScope } from "@oscharko-dev/keiko-contracts";

import { folderScope, memoryFs } from "./test-support.js";
import { walkSource } from "./walk.js";
import { DEFAULT_DISCOVERY_OPTIONS } from "./types.js";

const ROOT = "/srv/docs";

function collect(scope: KnowledgeSourceScope, fs = simpleFs()): readonly string[] {
  const out: string[] = [];
  for (const yld of walkSource(fs, scope)) {
    if (yld.kind === "file") {
      out.push(yld.file.relativePath);
    }
  }
  return out;
}

function simpleFs(): ReturnType<typeof memoryFs> {
  return memoryFs(ROOT, [
    { relativePath: "README.md", content: "hello" },
    { relativePath: "src/index.ts", content: "export {};" },
    { relativePath: "src/sub/deep.ts", content: "// deep" },
    { relativePath: ".git/config", content: "[core]" },
    { relativePath: ".vscode/settings.json", content: "{}" },
    { relativePath: ".next/server/app.js", content: "// next" },
    { relativePath: "node_modules/pkg/index.js", content: "module.exports = {};" },
    { relativePath: "dist/bundle.js", content: "// bundle" },
    { relativePath: "vendor/lib.js", content: "// vendor" },
    { relativePath: "image.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  ]);
}

describe("walkSource — folder scope", () => {
  it("yields every file when no globs are set and recursive=true", () => {
    const files = collect(folderScope(ROOT));
    expect([...files].sort()).toStrictEqual(
      ["README.md", "image.png", "src/index.ts", "src/sub/deep.ts", "vendor/lib.js"].sort(),
    );
  });

  it("skips hidden and generated directories by default", () => {
    const files = collect(folderScope(ROOT));
    expect(files).not.toContain(".git/config");
    expect(files).not.toContain(".vscode/settings.json");
    expect(files).not.toContain(".next/server/app.js");
    expect(files).not.toContain("node_modules/pkg/index.js");
    expect(files).not.toContain("dist/bundle.js");
  });

  it("respects recursive=false (top-level only)", () => {
    const files = collect(folderScope(ROOT, { recursive: false }));
    expect([...files].sort()).toStrictEqual(["README.md", "image.png"].sort());
  });

  it("filters to includeGlobs", () => {
    const files = collect(folderScope(ROOT, { includeGlobs: ["**/*.ts"] }));
    expect([...files].sort()).toStrictEqual(["src/index.ts", "src/sub/deep.ts"].sort());
  });

  it("subtracts excludeGlobs (exclude wins on overlap)", () => {
    const files = collect(
      folderScope(ROOT, {
        includeGlobs: ["**/*"],
        excludeGlobs: ["vendor/**", "*.png"],
      }),
    );
    expect([...files].sort()).toStrictEqual(
      ["README.md", "src/index.ts", "src/sub/deep.ts"].sort(),
    );
  });

  it("yields a stable lexical order at each directory level", () => {
    const files = collect(folderScope(ROOT, { includeGlobs: ["**/*"] }));
    // README.md sorts before src/, src/ before vendor/, image.png between README.md and src/
    expect(files).toStrictEqual([
      "README.md",
      "image.png",
      "src/index.ts",
      "src/sub/deep.ts",
      "vendor/lib.js",
    ]);
  });
});

describe("walkSource — Windows separator normalisation", () => {
  it("passes containment when WorkspaceFs.realPath returns Windows-style backslash paths", () => {
    // Simulate a Windows WorkspaceFs: root and realPath returns use backslash separators.
    const winRoot = "C:\\Users\\workspace\\docs";
    const fileContent = new TextEncoder().encode("content");
    const winFs: import("@oscharko-dev/keiko-workspace").WorkspaceFs = {
      readFileUtf8: () => "content",
      stat: (p) => {
        if (p === winRoot || p === "C:\\Users\\workspace\\docs\\notes\\report.md") {
          return {
            size: fileContent.byteLength,
            isFile: p !== winRoot,
            isDirectory: p === winRoot,
            isSymbolicLink: false,
          };
        }
        throw new Error(`ENOENT: ${p}`);
      },
      readDir: (p) => {
        if (p === winRoot) {
          return [{ name: "notes", isDirectory: true, isFile: false, isSymbolicLink: false }];
        }
        if (p === `${winRoot}/notes`) {
          return [{ name: "report.md", isDirectory: false, isFile: true, isSymbolicLink: false }];
        }
        return [];
      },
      // realPath returns Windows-style backslash path — this is what the fix must handle.
      realPath: (p) => p.replace(/\//g, "\\"),
      exists: (p) => p === winRoot || p === "C:\\Users\\workspace\\docs\\notes\\report.md",
      readFileBytes: (_p, _max) => Promise.resolve(fileContent),
    };
    const files: string[] = [];
    const errors: string[] = [];
    for (const yld of walkSource(winFs, {
      kind: "folder",
      rootPath: winRoot,
      recursive: true,
    })) {
      if (yld.kind === "file") files.push(yld.file.relativePath);
      if (yld.kind === "error" && yld.error.code === "PATH_ESCAPE")
        errors.push(yld.error.relativePath ?? "");
    }
    // The file must not be rejected as PATH_ESCAPE; containment must pass after normalisation.
    expect(errors).toStrictEqual([]);
    expect(files).toHaveLength(1);
  });
});

describe("walkSource — path containment", () => {
  it("emits a PATH_ESCAPE error when a file's realPath escapes the scope root", () => {
    const fs = memoryFs(ROOT, [
      { relativePath: "README.md", content: "ok" },
      {
        relativePath: "shady.txt",
        content: "trick",
        realPathOverride: "/etc/passwd",
      },
    ]);
    const errors: string[] = [];
    const files: string[] = [];
    for (const yld of walkSource(fs, folderScope(ROOT))) {
      if (yld.kind === "error" && yld.error.code === "PATH_ESCAPE") {
        errors.push(yld.error.relativePath ?? "");
      }
      if (yld.kind === "file") files.push(yld.file.relativePath);
    }
    expect(errors).toStrictEqual(["shady.txt"]);
    expect(files).toStrictEqual(["README.md"]);
  });

  it("does not yield files whose realPath resolves to a denied workspace path", () => {
    const fs = memoryFs(ROOT, [
      {
        relativePath: "docs/link.txt",
        content: "secret",
        realPathOverride: `${ROOT}/.env`,
      },
      { relativePath: ".env", content: "SECRET=1" },
    ]);

    const files = collect(folderScope(ROOT), fs);

    expect(files).toStrictEqual([]);
  });

  it("yields in-scope symlinks after their realPath passes the boundary checks", () => {
    const fs = memoryFs(ROOT, [
      {
        relativePath: "docs/link.txt",
        content: "ignored",
        realPathOverride: `${ROOT}/docs/target.txt`,
        isSymbolicLink: true,
      },
      { relativePath: "docs/target.txt", content: "target" },
    ]);
    const scope: KnowledgeSourceScope = {
      kind: "files",
      rootPath: ROOT,
      files: ["docs/link.txt"],
    };

    const files = collect(scope, fs);

    expect(files).toStrictEqual(["docs/link.txt"]);
  });

  it("emits a READ_FAILED error for hard-linked aliases", () => {
    const fs = memoryFs(ROOT, [
      {
        relativePath: "docs/allowed.txt",
        content: "secret",
        hardLinkCount: 2,
      },
    ]);
    const out = [...walkSource(fs, folderScope(ROOT))];

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("error");
    if (out[0]?.kind === "error") {
      expect(out[0].error).toMatchObject({
        code: "READ_FAILED",
        relativePath: "docs/allowed.txt",
      });
    }
  });

  it("emits INVALID_SCOPE when the scope root is unsafe", () => {
    const fs = memoryFs(ROOT, [{ relativePath: "README.md", content: "x" }]);
    const out = [
      ...walkSource(fs, {
        kind: "folder",
        rootPath: "../escape",
        recursive: true,
      }),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("error");
    if (out[0]?.kind === "error") {
      expect(out[0].error.code).toBe("INVALID_SCOPE");
    }
  });
});

describe("walkSource — cancellation", () => {
  it("yields a CANCELLED error and stops when the AbortSignal fires before iteration", () => {
    const fs = simpleFs();
    const ctrl = new AbortController();
    ctrl.abort();
    const out = [
      ...walkSource(fs, folderScope(ROOT), {
        ...DEFAULT_DISCOVERY_OPTIONS,
        signal: ctrl.signal,
      }),
    ];
    expect(out).toHaveLength(1);
    if (out[0]?.kind === "error") {
      expect(out[0].error.code).toBe("CANCELLED");
    }
  });
});

describe("walkSource — files scope", () => {
  it("only yields the explicit file list", () => {
    const fs = simpleFs();
    const scope: KnowledgeSourceScope = {
      kind: "files",
      rootPath: ROOT,
      files: ["README.md", "src/index.ts"],
    };
    const files = collect(scope, fs);
    expect(files).toStrictEqual(["README.md", "src/index.ts"]);
  });

  it("allows explicit hidden files that are not security-denied", () => {
    const fs = simpleFs();
    const scope: KnowledgeSourceScope = {
      kind: "files",
      rootPath: ROOT,
      files: [".vscode/settings.json"],
    };
    const files = collect(scope, fs);
    expect(files).toStrictEqual([".vscode/settings.json"]);
  });

  it("applies the always-on deny list to discovered descendants", () => {
    const fs = memoryFs(ROOT, [
      { relativePath: "README.md", content: "ok" },
      { relativePath: ".env", content: "SECRET=1" },
      { relativePath: ".npmrc", content: "//registry.example/:_authToken=secret" },
      { relativePath: "id_rsa", content: "private key" },
      { relativePath: "secrets/cert.pem", content: "pem" },
      { relativePath: "secrets/token.key", content: "key" },
      { relativePath: "src/service-account-prod.json", content: "{}" },
      { relativePath: ".env.example", content: "SECRET=" },
    ]);

    const files = collect(folderScope(ROOT), fs);

    expect(files).toContain("README.md");
    expect(files).toContain(".env.example");
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".npmrc");
    expect(files).not.toContain("id_rsa");
    expect(files).not.toContain("secrets/cert.pem");
    expect(files).not.toContain("secrets/token.key");
    expect(files).not.toContain("src/service-account-prod.json");
  });

  it("does not let explicit file scopes bypass the security deny list", () => {
    const fs = memoryFs(ROOT, [
      { relativePath: ".vscode/settings.json", content: "{}" },
      { relativePath: ".git/config", content: "[core]" },
      { relativePath: "dist/bundle.js", content: "// bundle" },
      { relativePath: ".env", content: "SECRET=1" },
    ]);
    const scope: KnowledgeSourceScope = {
      kind: "files",
      rootPath: ROOT,
      files: [".vscode/settings.json", ".git/config", "dist/bundle.js", ".env"],
    };

    const files = collect(scope, fs);

    expect(files).toStrictEqual([".vscode/settings.json"]);
  });
});

describe("walkSource — bounds", () => {
  it("stops at maxFiles", () => {
    const fs = simpleFs();
    const out: string[] = [];
    for (const yld of walkSource(fs, folderScope(ROOT), { maxDepth: 12, maxFiles: 2 })) {
      if (yld.kind === "file") out.push(yld.file.relativePath);
    }
    expect(out).toHaveLength(2);
  });

  it("respects maxDepth (root=0, immediate children=1)", () => {
    const fs = simpleFs();
    const out: string[] = [];
    for (const yld of walkSource(fs, folderScope(ROOT), { maxDepth: 0, maxFiles: 100 })) {
      if (yld.kind === "file") out.push(yld.file.relativePath);
    }
    // maxDepth=0 forbids descent into src/ or vendor/. The walker enters root (depth=0)
    // and yields top-level files (still depth=0 because we test BEFORE incrementing).
    expect([...out].sort()).toStrictEqual(["README.md", "image.png"].sort());
  });
});
