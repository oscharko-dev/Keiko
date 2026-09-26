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

describe("walkSource — repository gitignore option", () => {
  const repositoryScope: KnowledgeSourceScope = {
    kind: "repository",
    repositoryRoot: ROOT,
  };

  it("reuses ordered workspace ignore semantics without weakening the deny list", () => {
    const fs = memoryFs(ROOT, [
      {
        relativePath: ".gitignore",
        content: ["ignored/*.ts", "!ignored/keep.ts", "!.env", "vendor/"].join("\n"),
      },
      { relativePath: "ignored/drop.ts", content: "drop" },
      { relativePath: "ignored/keep.ts", content: "keep" },
      { relativePath: "vendor/bundle.js", content: "vendor" },
      { relativePath: ".env", content: "SECRET=1" },
      { relativePath: "src/index.ts", content: "export {};" },
    ]);
    const files: string[] = [];
    for (const result of walkSource(fs, repositoryScope, {
      ...DEFAULT_DISCOVERY_OPTIONS,
      respectGitIgnore: true,
    })) {
      if (result.kind === "file") files.push(result.file.relativePath);
    }
    expect(files).toContain("ignored/keep.ts");
    expect(files).toContain("src/index.ts");
    expect(files).not.toContain("ignored/drop.ts");
    expect(files).not.toContain("vendor/bundle.js");
    expect(files).not.toContain(".env");
  });

  it("fails closed when the selected gitignore escapes the repository root", () => {
    const fs = memoryFs(ROOT, [
      {
        relativePath: ".gitignore",
        content: "ignored/",
        realPathOverride: "/outside/.gitignore",
      },
      { relativePath: "src/index.ts", content: "export {};" },
    ]);
    const out = [
      ...walkSource(fs, repositoryScope, {
        ...DEFAULT_DISCOVERY_OPTIONS,
        respectGitIgnore: true,
      }),
    ];
    expect(out).toEqual([
      {
        kind: "error",
        error: { code: "READ_FAILED", message: "repository ignore file failed containment" },
      },
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
        const isRoot = p === winRoot;
        const isNotes = p === "C:\\Users\\workspace\\docs\\notes";
        const isReport = p === "C:\\Users\\workspace\\docs\\notes\\report.md";
        if (isRoot || isNotes || isReport) {
          return {
            size: fileContent.byteLength,
            isFile: isReport,
            isDirectory: !isReport,
            isSymbolicLink: false,
            fileIdentity: `windows:${p}`,
          };
        }
        throw new Error(`ENOENT: ${p}`);
      },
      readDir: (p) => {
        if (p === winRoot) {
          return [{ name: "notes", isDirectory: true, isFile: false, isSymbolicLink: false }];
        }
        if (p === `${winRoot}/notes` || p === "C:\\Users\\workspace\\docs\\notes") {
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
  it("yields files when the selected scope root resolves through a realpath symlink", () => {
    const baseFs = memoryFs(ROOT, [{ relativePath: "docs/report.md", content: "ok" }]);
    const realRoot = `/private${ROOT}`;
    const toRequestedPath = (absolutePath: string): string =>
      absolutePath === realRoot
        ? ROOT
        : absolutePath.startsWith(`${realRoot}/`)
          ? `${ROOT}/${absolutePath.slice(realRoot.length + 1)}`
          : absolutePath;
    const fs: ReturnType<typeof memoryFs> = {
      ...baseFs,
      realPath: (absolutePath: string): string => {
        if (absolutePath === ROOT) return realRoot;
        if (absolutePath.startsWith(`${ROOT}/`)) {
          return `${realRoot}/${absolutePath.slice(ROOT.length + 1)}`;
        }
        return baseFs.realPath(absolutePath);
      },
      stat: (absolutePath: string) => baseFs.stat(toRequestedPath(absolutePath)),
      readDir: (absolutePath: string) => baseFs.readDir(toRequestedPath(absolutePath)),
      readFileBytes: (absolutePath: string, maxBytes: number, hardLinkPolicy, expected) =>
        baseFs.readFileBytes?.(toRequestedPath(absolutePath), maxBytes, hardLinkPolicy, expected) ??
        Promise.reject(new Error("readFileBytes unavailable")),
    };

    const files = collect(folderScope(ROOT), fs);

    expect(files).toStrictEqual(["docs/report.md"]);
  });

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

  it("denies the walk when the scope root itself was retargeted to a denied locus before this admission (#3347)", () => {
    // Verified exploit: a lexical source initially admitted as safe (e.g. a symlinked scope
    // root) is retargeted -- via the underlying symlink -- to a denied directory such as
    // ~/.ssh before walkSource ever runs. A plain fs.realPath(root) only follows the symlink;
    // it never asks whether the RESOLVED root is itself a denied locus, so the retargeted
    // directory would otherwise be trusted as the new walk root and its contents yielded.
    // The root must go through the same deny-root admission rule every other effectful
    // consumer of a workspace root uses (resolveExistingAllowedWorkspaceRealRoot), not a bare
    // realPath call.
    const deniedRoot = "/home/test/.ssh";
    const baseFs = memoryFs(deniedRoot, [
      { relativePath: "notes.txt", content: "id_rsa contents" },
    ]);
    const fs: ReturnType<typeof memoryFs> = {
      ...baseFs,
      // The scope's lexical root -- and every path lexically beneath it, exactly like a real
      // symlinked directory -- resolves through a symlink that was swapped, between admission
      // and this walk, to point at the denied directory. Every descendant's realpath call must
      // translate the same way a real symlinked mount would, not just the exact root path.
      realPath: (absolutePath: string): string => {
        if (absolutePath === ROOT) return deniedRoot;
        if (absolutePath.startsWith(`${ROOT}/`)) {
          return `${deniedRoot}/${absolutePath.slice(ROOT.length + 1)}`;
        }
        return baseFs.realPath(absolutePath);
      },
    };

    const out = [...walkSource(fs, folderScope(ROOT))];

    expect(out.some((yld) => yld.kind === "file")).toBe(false);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("error");
    if (out[0]?.kind === "error") {
      expect(out[0].error.code).toBe("PATH_ESCAPE");
    }
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

  it("yields hard-linked aliases after realpath containment", () => {
    const fs = memoryFs(ROOT, [
      {
        relativePath: "docs/allowed.txt",
        content: "secret",
        hardLinkCount: 2,
      },
    ]);
    const out = [...walkSource(fs, folderScope(ROOT))];

    expect(out).toHaveLength(1);
    expect(out[0]).toStrictEqual({
      kind: "file",
      file: { relativePath: "docs/allowed.txt", sizeBytes: 6 },
    });
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

  it("treats an explicitly selected missing file as an authoritative deletion", () => {
    const fs = simpleFs();
    const scope: KnowledgeSourceScope = {
      kind: "files",
      rootPath: ROOT,
      files: ["README.md", "deleted.md"],
    };

    expect([...walkSource(fs, scope)]).toStrictEqual([
      {
        kind: "file",
        file: { relativePath: "README.md", sizeBytes: 5 },
      },
    ]);
  });

  it("reports a failed explicit-file presence check instead of inferring deletion", () => {
    const base = simpleFs();
    const fs: typeof base = {
      ...base,
      exists: (absolutePath: string): boolean => {
        if (absolutePath.endsWith("/README.md")) throw new Error("transient");
        return base.exists(absolutePath);
      },
    };
    const scope: KnowledgeSourceScope = {
      kind: "files",
      rootPath: ROOT,
      files: ["README.md"],
    };

    expect([...walkSource(fs, scope)]).toStrictEqual([
      {
        kind: "error",
        error: {
          code: "READ_FAILED",
          message: "explicit entry presence check failed",
          relativePath: "README.md",
        },
      },
    ]);
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

  it("rejects unsafe explicit file references with the contract storage-reference gate", () => {
    const fs = simpleFs();
    const out = [
      ...walkSource(fs, {
        kind: "files",
        rootPath: ROOT,
        files: ["/etc/passwd"],
      }),
    ];

    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("error");
    if (out[0]?.kind === "error") {
      expect(out[0].error.code).toBe("INVALID_SCOPE");
      expect(out[0].error.message).toContain("storage-reference gate");
    }
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

    expect(files).toStrictEqual([".vscode/settings.json", "dist/bundle.js"]);
  });
});

describe("walkSource — bounds", () => {
  it("stops at maxFiles and explicitly marks the enumeration incomplete", () => {
    const fs = simpleFs();
    const out = [...walkSource(fs, folderScope(ROOT), { maxDepth: 12, maxFiles: 2 })];
    expect(out.filter((result) => result.kind === "file")).toHaveLength(2);
    expect(out.filter((result) => result.kind === "error")).toContainEqual({
      kind: "error",
      error: { code: "LIMIT_REACHED", message: "file discovery limit reached" },
    });
  });

  it("respects maxDepth and explicitly marks skipped descendants incomplete", () => {
    const fs = simpleFs();
    const results = [...walkSource(fs, folderScope(ROOT), { maxDepth: 0, maxFiles: 100 })];
    const out = results.flatMap((result) =>
      result.kind === "file" ? [result.file.relativePath] : [],
    );
    // maxDepth=0 forbids descent into src/ or vendor/. The walker enters root (depth=0)
    // and yields top-level files (still depth=0 because we test BEFORE incrementing).
    expect([...out].sort()).toStrictEqual(["README.md", "image.png"].sort());
    expect(results.filter((result) => result.kind === "error")).toContainEqual({
      kind: "error",
      error: { code: "LIMIT_REACHED", message: "directory depth limit reached" },
    });
  });
});

describe("walkSource — transient filesystem failures", () => {
  it("reports a realpath failure instead of silently dropping an entry", () => {
    const base = simpleFs();
    const fs: typeof base = {
      ...base,
      realPath: (absolutePath: string): string => {
        if (absolutePath.endsWith("/README.md")) throw new Error("transient");
        return base.realPath(absolutePath);
      },
    };

    expect([...walkSource(fs, folderScope(ROOT))]).toContainEqual({
      kind: "error",
      error: {
        code: "READ_FAILED",
        message: "entry realpath failed",
        relativePath: "README.md",
      },
    });
  });

  it("reports a stat failure instead of silently dropping an entry", () => {
    const base = simpleFs();
    const fs: typeof base = {
      ...base,
      stat: (absolutePath: string) => {
        if (absolutePath.endsWith("/README.md")) throw new Error("transient");
        return base.stat(absolutePath);
      },
    };

    expect([...walkSource(fs, folderScope(ROOT))]).toContainEqual({
      kind: "error",
      error: {
        code: "STAT_FAILED",
        message: "entry stat failed",
        relativePath: "README.md",
      },
    });
  });

  it("reports a readdir failure instead of treating the directory as empty", () => {
    const base = simpleFs();
    const fs: typeof base = {
      ...base,
      readDir: (absolutePath: string) => {
        if (absolutePath.endsWith("/src")) throw new Error("transient");
        return base.readDir(absolutePath);
      },
    };

    expect([...walkSource(fs, folderScope(ROOT))]).toContainEqual({
      kind: "error",
      error: { code: "READ_FAILED", message: "directory read failed" },
    });
  });

  it("rejects entries when the enumerated directory changes canonical identity", () => {
    const base = memoryFs(ROOT, [{ relativePath: "src/safe.ts", content: "safe" }]);
    let swapped = false;
    const fs: typeof base = {
      ...base,
      realPath: (absolutePath: string): string =>
        swapped && absolutePath === `${ROOT}/src`
          ? "/outside/private"
          : base.realPath(absolutePath),
      readDir: (absolutePath: string) => {
        if (absolutePath === `${ROOT}/src`) {
          swapped = true;
          return [
            {
              name: "private.ts",
              isDirectory: false,
              isFile: true,
              isSymbolicLink: false,
            },
          ];
        }
        return base.readDir(absolutePath);
      },
    };

    const out = [...walkSource(fs, folderScope(ROOT))];

    expect(swapped).toBe(true);
    expect(out).toContainEqual({
      kind: "error",
      error: { code: "READ_FAILED", message: "directory read failed" },
    });
    expect(out).not.toContainEqual({
      kind: "file",
      file: { relativePath: "src/private.ts", sizeBytes: 4 },
    });
    expect(out).not.toContainEqual({
      kind: "error",
      error: {
        code: "STAT_FAILED",
        message: "entry stat failed",
        relativePath: "src/private.ts",
      },
    });
  });
});

describe("walkSource — bounded directory enumeration (#3347)", () => {
  it("passes a finite maxEntries to readDir instead of materializing the whole directory", () => {
    // Owner P1 on this PR: `safeReadDir` called `ctx.fs.readDir(path)` with no cap, so one
    // adversarially large directory was fully allocated (and sorted) before `maxFiles`, abort or
    // the elapsed budget could stop the walk. The reported repro observed `maxEntries === undefined`;
    // this pins the ARGUMENT itself, not just the resulting file count, so removing the cap fails
    // here even when the yielded files happen to stay the same.
    const base = simpleFs();
    const observedCaps: (number | undefined)[] = [];
    const fs = {
      ...base,
      readDir: (absolutePath: string, maxEntries?: number): ReturnType<typeof base.readDir> => {
        observedCaps.push(maxEntries);
        return base.readDir(absolutePath, maxEntries);
      },
    };

    const walked = [...walkSource(fs, folderScope(ROOT))];

    expect(walked.length).toBeGreaterThan(0);
    expect(observedCaps.length).toBeGreaterThan(0);
    for (const cap of observedCaps) {
      expect(cap).toBeTypeOf("number");
      expect(Number.isFinite(cap)).toBe(true);
    }
  });

  it("reports LIMIT_REACHED instead of yielding an arbitrary subset when a directory overflows", () => {
    // A directory whose entry count exceeds the per-directory memory bound must stop the walk
    // rather than silently discovering whatever filesystem order happened to return first. The
    // fake caps at the requested `maxEntries`, so returning a full page proves the overflow.
    const base = simpleFs();
    const fs = {
      ...base,
      readDir: (absolutePath: string, maxEntries?: number): ReturnType<typeof base.readDir> => {
        const entry = {
          name: "filler.md",
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
        };
        return maxEntries === undefined
          ? base.readDir(absolutePath)
          : Array(maxEntries).fill(entry);
      },
    };

    const out = [...walkSource(fs, folderScope(ROOT))];

    expect(out).toContainEqual({
      kind: "error",
      error: { code: "LIMIT_REACHED", message: "directory entry limit reached" },
    });
  });
});
