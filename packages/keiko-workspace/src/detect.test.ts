import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { detectWorkspace, detectWorkspaceAt } from "./detect.js";
import { PathDeniedError, WorkspaceNotFoundError } from "./errors.js";
import {
  nodeWorkspaceFs,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceStat,
} from "./fs.js";

let dir: string;

beforeEach(() => {
  dir = nodeWorkspaceFs.realPath(mkdtempSync(join(tmpdir(), "keiko-detect-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePkg(root: string, body: unknown): void {
  writeFileSync(join(root, "package.json"), JSON.stringify(body), "utf8");
}

function writeRel(root: string, relativePath: string, content = ""): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

interface AdmissionCalls {
  realPath: number;
  exists: number;
  stat: number;
  readDir: number;
  readFile: number;
}

function admissionProbe(realPath: (path: string) => string): {
  readonly fs: WorkspaceFs;
  readonly calls: AdmissionCalls;
} {
  const calls: AdmissionCalls = { realPath: 0, exists: 0, stat: 0, readDir: 0, readFile: 0 };
  return {
    fs: {
      readFileUtf8: (): string => {
        calls.readFile += 1;
        return "";
      },
      stat: (): WorkspaceStat => {
        calls.stat += 1;
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      },
      readDir: (): readonly WorkspaceDirEntry[] => {
        calls.readDir += 1;
        return [];
      },
      realPath: (path): string => {
        calls.realPath += 1;
        return realPath(path);
      },
      exists: (): boolean => {
        calls.exists += 1;
        return false;
      },
    },
    calls,
  };
}

function expectAdmissionOnly(calls: AdmissionCalls, realPath: number): void {
  expect(calls).toEqual({ realPath, exists: 0, stat: 0, readDir: 0, readFile: 0 });
}

const DETECTORS = [
  ["detectWorkspace", detectWorkspace],
  ["detectWorkspaceAt", detectWorkspaceAt],
] as const;

describe("detectWorkspace", () => {
  it("detects the root via package.json and reads name/version", () => {
    writePkg(dir, { name: "demo", version: "1.2.3" });
    const info = detectWorkspace(dir);
    expect(info.root).toBe(dir);
    expect(info.name).toBe("demo");
    expect(info.version).toBe("1.2.3");
  });

  it("detects the framework from devDependencies", () => {
    writePkg(dir, { name: "demo", devDependencies: { vitest: "^4.0.0" } });
    expect(detectWorkspace(dir).testFramework).toBe("vitest");
  });

  it("detects jest and mocha frameworks", () => {
    writePkg(dir, { name: "demo", dependencies: { jest: "^29" } });
    expect(detectWorkspace(dir).testFramework).toBe("jest");
    writePkg(dir, { name: "demo", devDependencies: { mocha: "^10" } });
    expect(detectWorkspace(dir).testFramework).toBe("mocha");
  });

  it("detects only the exact Node native test script", () => {
    writePkg(dir, { name: "demo", scripts: { test: "node --test" } });
    expect(detectWorkspace(dir).testFramework).toBe("node-test");

    for (const test of [
      "node --test --watch",
      "node --test tests/a.test.js",
      "node --eval test",
      "node --test; echo unsafe",
    ]) {
      writePkg(dir, { name: "demo", scripts: { test } });
      expect(detectWorkspace(dir).testFramework).toBe("unknown");
    }
  });

  it("returns unknown framework when none is declared", () => {
    writePkg(dir, { name: "demo" });
    expect(detectWorkspace(dir).testFramework).toBe("unknown");
  });

  it("walks up to a parent root from a nested directory", () => {
    writePkg(dir, { name: "demo" });
    const nested = join(dir, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const info = detectWorkspace(nested);
    expect(info.root).toBe(dir);
    // No alias in play, so both identities name the same path.
    expect(info.selectedRoot).toBe(dir);
  });

  // Reporting only the canonical root loses the name the caller knows the project by. Every
  // authorization comparison against a registered path and every root the UI displays is lexical,
  // so a project reached through a symlinked ancestor — the ordinary case on macOS, where `/var`
  // and `/tmp` resolve under `/private` — was answered as an unregistered directory.
  function aliasedWalkFs(aliasRoot: string, realRoot: string, relativeTarget: string): WorkspaceFs {
    const base = memFs(realRoot, {
      "package.json": JSON.stringify({ name: "aliased-demo" }),
      "src/deep/file.ts": "export {};",
    });
    return {
      ...base,
      realPath: (path): string =>
        path.startsWith(aliasRoot)
          ? join(realRoot, relativeTarget, path.slice(aliasRoot.length))
          : path,
      readFileUtf8SameDescriptor: (
        path,
      ): { rawText: string; sizeBytes: number; stat: WorkspaceStat } => {
        const stat = base.stat(path);
        return { rawText: base.readFileUtf8(path), sizeBytes: stat.size, stat };
      },
    };
  }

  it("keeps the caller's lexical root alongside the canonical one it binds effects to", () => {
    const realRoot = join(dir, "aliased-real");
    const aliasRoot = join(dir, "aliased-link");
    const fs = aliasedWalkFs(aliasRoot, realRoot, ".");

    const info = detectWorkspace(join(aliasRoot, "src", "deep"), fs);

    expect(info.root).toBe(realRoot);
    expect(info.selectedRoot).toBe(aliasRoot);
    expect(info.name).toBe("aliased-demo");
  });

  // The lexical identity is derived by verifying each dirname step against the canonical directory
  // the walk stands on, never by counting how many levels the walk climbed. An intermediate symlink
  // changes a tree's depth, so a level count would name `dir` here — a directory that is not the
  // workspace root at all. Failing to verify must yield the canonical root, never a guess.
  it("drops the lexical identity when the alias chain cannot be verified step by step", () => {
    const realRoot = join(dir, "shifted-real");
    const aliasRoot = join(dir, "shifted-link");
    const fs = aliasedWalkFs(aliasRoot, realRoot, "src");

    const info = detectWorkspace(join(aliasRoot, "deep"), fs);

    expect(info.root).toBe(realRoot);
    expect(info.selectedRoot).toBe(realRoot);
    expect(info.selectedRoot).not.toBe(dir);
  });

  it("walks only on the admitted canonical lineage", () => {
    const realRoot = join(dir, "real-repo");
    const aliasRoot = join(dir, "alias");
    const base = memFs(realRoot, {
      "package.json": JSON.stringify({ name: "canonical-demo" }),
      "src/deep/file.ts": "export {};",
    });
    const metadataPaths: string[] = [];
    const fs: WorkspaceFs = {
      ...base,
      realPath: (path): string =>
        path.startsWith(aliasRoot) ? join(realRoot, path.slice(aliasRoot.length)) : path,
      readFileUtf8SameDescriptor: (path) => {
        const stat = base.stat(path);
        return { rawText: base.readFileUtf8(path), sizeBytes: stat.size, stat };
      },
      exists: (path): boolean => {
        metadataPaths.push(path);
        return base.exists(path);
      },
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        metadataPaths.push(path);
        return base.readDir(path, maxEntries);
      },
      stat: (path): WorkspaceStat => {
        metadataPaths.push(path);
        return base.stat(path);
      },
      readFileUtf8: (path): string => {
        metadataPaths.push(path);
        return base.readFileUtf8(path);
      },
    };

    const info = detectWorkspace(join(aliasRoot, "src", "deep"), fs);

    expect(info.root).toBe(realRoot);
    expect(info.name).toBe("canonical-demo");
    expect(
      metadataPaths.every((path) => path === realRoot || path.startsWith(`${realRoot}${sep}`)),
    ).toBe(true);
  });

  it("finds a marker inside an admitted Codex worktree", () => {
    const project = join(dir, ".codex", "worktrees", "task", "project");
    const nested = join(project, "src", "deep");
    mkdirSync(nested, { recursive: true });
    writePkg(project, { name: "codex-worktree" });

    const info = detectWorkspace(nested);

    expect(info.root).toBe(nodeWorkspaceFs.realPath(project));
    expect(info.name).toBe("codex-worktree");
  });

  it("stops before probing a denied ancestor above an admitted Codex worktree", () => {
    writePkg(dir, { name: "outside-boundary" });
    const worktreesRoot = join(dir, ".codex", "worktrees");
    const codexRoot = join(dir, ".codex");
    const nested = join(worktreesRoot, "task", "project", "src");
    mkdirSync(nested, { recursive: true });
    const existsPaths: string[] = [];
    const readDirPaths: string[] = [];
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      exists: (path): boolean => {
        existsPaths.push(path);
        return nodeWorkspaceFs.exists(path);
      },
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        readDirPaths.push(path);
        return nodeWorkspaceFs.readDir(path, maxEntries);
      },
    };

    expect(() => detectWorkspace(nested, fs)).toThrow(WorkspaceNotFoundError);
    expect(readDirPaths).not.toEqual(expect.arrayContaining([worktreesRoot, codexRoot]));
    expect(existsPaths.some((path) => [worktreesRoot, codexRoot].includes(dirname(path)))).toBe(
      false,
    );
    expect(existsPaths).not.toContain(join(dir, "package.json"));
  });

  it("detects a .git directory as a root even without package.json", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    expect(detectWorkspace(dir).root).toBe(dir);
    expect(detectWorkspace(dir).name).toBeUndefined();
  });

  it("detects a .git file as a worktree root marker", () => {
    writeFileSync(join(dir, ".git"), "gitdir: /safe/metadata\n", "utf8");

    expect(detectWorkspace(dir).root).toBe(dir);
  });

  it("does not accept a manifest-named directory as a root marker", () => {
    const root = join(dir, ".codex", "worktrees", "task", "project");
    mkdirSync(join(root, "package.json"), { recursive: true });

    expect(() => detectWorkspace(root)).toThrow(WorkspaceNotFoundError);
  });

  it("rejects an incomplete dynamic-marker enumeration deterministically", () => {
    const root = join(dir, "dynamic-marker-overflow");
    const base = memFs(root, {});
    const overflow: readonly WorkspaceDirEntry[] = [
      { name: "Service.csproj", isDirectory: false, isFile: true, isSymbolicLink: false },
      ...Array.from({ length: 4_096 }, (_, index) => ({
        name: `entry-${String(index)}`,
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
      })),
    ];
    const fs: WorkspaceFs = {
      ...base,
      readDir: (_path, maxEntries): readonly WorkspaceDirEntry[] =>
        maxEntries === undefined ? overflow : overflow.slice(0, maxEntries),
    };

    expect(() => detectWorkspace(root, fs)).toThrow(WorkspaceNotFoundError);
  });

  it("rejects a root retargeted during dynamic-marker enumeration", () => {
    const selected = join(dir, "selected");
    const safeRoot = join(dir, "safe");
    const deniedRoot = join(dir, ".aws");
    const base = memFs(safeRoot, {});
    let retargeted = false;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (path): string => {
        if (path === selected) return safeRoot;
        if (path === safeRoot) return retargeted ? deniedRoot : safeRoot;
        return path;
      },
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        if (path !== safeRoot) return base.readDir(path, maxEntries);
        retargeted = true;
        return [
          { name: "Service.csproj", isDirectory: false, isFile: true, isSymbolicLink: false },
        ];
      },
    };

    expect(() => detectWorkspace(selected, fs)).toThrow(PathDeniedError);
    expect(retargeted).toBe(true);
  });

  it("revalidates a dynamic marker selected from a stale directory snapshot", () => {
    const root = join(dir, "stale-dynamic-marker");
    const base = memFs(root, {});
    const fs: WorkspaceFs = {
      ...base,
      readDir: (): readonly WorkspaceDirEntry[] => [
        { name: "Service.csproj", isDirectory: false, isFile: true, isSymbolicLink: false },
      ],
    };

    expect(() => detectWorkspace(root, fs)).toThrow(WorkspaceNotFoundError);
  });

  it("detects source and test dirs that exist", () => {
    writePkg(dir, { name: "demo" });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    const info = detectWorkspace(dir);
    expect(info.sourceDirs).toContain("src");
    expect(info.testDirs).toContain("tests");
  });

  it("reports typescript when tsconfig.json is present", () => {
    writePkg(dir, { name: "demo" });
    writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8");
    expect(detectWorkspace(dir).languages).toContain("typescript");
  });

  it("detects a pure Maven Java workspace without falling back to JavaScript", () => {
    writeRel(dir, "pom.xml", "<project />\n");
    writeRel(dir, "src/main/java/com/acme/App.java", "class App {}\n");
    const info = detectWorkspace(join(dir, "src/main/java/com/acme"));

    expect(info.root).toBe(dir);
    expect(info.languages).toContain("java");
    expect(info.languages).not.toContain("javascript");
    expect(info.languages).not.toContain("typescript");
  });

  it("reports java without inventing javascript for a pure Maven workspace", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "pom.xml"), "<project />", "utf8");
    const info = detectWorkspace(dir);
    expect(info.languages).toContain("java");
    expect(info.languages).not.toContain("javascript");
  });

  it("detects a pure Maven root without .git or package.json", () => {
    writeFileSync(join(dir, "pom.xml"), "<project />", "utf8");
    const nested = join(dir, "src", "main", "java", "com", "acme");
    mkdirSync(nested, { recursive: true });

    const info = detectWorkspace(nested);

    expect(info.root).toBe(dir);
    expect(info.languages).toContain("java");
    expect(info.languages).not.toContain("javascript");
    expect(info.languages).not.toContain("typescript");
  });

  it("detects a Gradle Java workspace from Java source extensions", () => {
    writeRel(dir, "build.gradle", "plugins { id 'java' }\n");
    writeRel(dir, "src/main/java/com/acme/App.java", "class App {}\n");
    const info = detectWorkspace(dir);

    expect(info.languages).toContain("java");
    expect(info.languages).not.toContain("javascript");
  });

  it.each([
    ["Kotlin", "build.gradle.kts", "src/main/kotlin/App.kt", "kotlin"],
    ["Python", "pyproject.toml", "src/app.py", "python"],
    ["Go", "go.mod", "cmd/api/main.go", "go"],
    ["Rust", "Cargo.toml", "src/lib.rs", "rust"],
    ["C#", "Service.csproj", "Program.cs", "csharp"],
  ] as const)(
    "detects %s from registered manifests and source extensions",
    (_label, manifest, source, language) => {
      writeRel(dir, manifest, "");
      writeRel(dir, source, "");

      expect(detectWorkspace(dir).languages).toContain(language);
    },
  );
  it("detects source languages that are legal in the workspace contract", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "openapi.yaml"), "openapi: 3.1.0\n", "utf8");
    writeFileSync(join(dir, "schema.sql"), "create table demo(id integer);\n", "utf8");
    writeFileSync(join(dir, "src", "native.cpp"), "int main() { return 0; }\n", "utf8");
    writeFileSync(join(dir, "src", "build.gradle"), "plugins { id 'groovy' }\n", "utf8");
    writeFileSync(join(dir, "src", "Program.fs"), "module Program\n", "utf8");
    writeFileSync(join(dir, "src", "script.csx"), "Console.WriteLine(1);\n", "utf8");
    const info = detectWorkspace(dir);
    expect(info.languages).toEqual(
      expect.arrayContaining(["openapi", "sql", "cpp", "groovy", "fsharp", "csharp"]),
    );
  });

  it("reads .gitignore lines", () => {
    writePkg(dir, { name: "demo" });
    writeFileSync(join(dir, ".gitignore"), "dist/\n*.log\n", "utf8");
    expect(detectWorkspace(dir).ignoreLines).toContain("dist/");
  });

  it("treats symlinked package.json and .gitignore metadata escaping the workspace as absent", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-detect-outside-"));
    try {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "outside" }), "utf8");
      writeFileSync(join(outside, ".gitignore"), "dist/\n", "utf8");
      symlinkSync(join(outside, "package.json"), join(dir, "package.json"));
      symlinkSync(join(outside, ".gitignore"), join(dir, ".gitignore"));
      const info = detectWorkspace(dir);
      expect(info.root).toBe(dir);
      expect(info.name).toBeUndefined();
      expect(info.version).toBeUndefined();
      expect(info.ignoreLines).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not classify escaped child symlinks as source dirs or language markers", () => {
    const outside = mkdtempSync(join(tmpdir(), "keiko-detect-child-outside-"));
    try {
      mkdirSync(join(dir, ".git"));
      mkdirSync(join(outside, "src"));
      writeFileSync(join(outside, "tsconfig.json"), "{}", "utf8");
      symlinkSync(join(outside, "src"), join(dir, "src"));
      symlinkSync(join(outside, "tsconfig.json"), join(dir, "tsconfig.json"));

      const info = detectWorkspace(dir);

      expect(info.sourceDirs).not.toContain("src");
      expect(info.languages).not.toContain("typescript");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("treats metadata symlinks to denied in-workspace files as absent", () => {
    writeFileSync(join(dir, ".env"), JSON.stringify({ name: "secret-name" }), "utf8");
    mkdirSync(join(dir, ".git"), { recursive: true });
    symlinkSync(join(dir, ".env"), join(dir, "package.json"));
    const info = detectWorkspace(dir);
    expect(info.root).toBe(dir);
    expect(info.name).toBeUndefined();
    expect(info.version).toBeUndefined();
  });

  it("tolerates a malformed package.json without throwing", () => {
    writeFileSync(join(dir, "package.json"), "{ not valid json", "utf8");
    const info = detectWorkspace(dir);
    expect(info.root).toBe(dir);
    expect(info.name).toBeUndefined();
  });

  it("treats unreadable metadata files as absent", () => {
    const root = "/ws";
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => {
        throw new Error("EACCES");
      },
      readFileUtf8SameDescriptor: (): never => {
        throw new Error("EACCES");
      },
      stat: (absolutePath): WorkspaceStat => ({
        size: 0,
        isFile: absolutePath === join(root, "package.json"),
        isDirectory: absolutePath === root,
        isSymbolicLink: false,
      }),
      readDir: (): readonly never[] => [],
      realPath: (p: string): string => p,
      exists: (absolutePath: string): boolean =>
        absolutePath === root ||
        absolutePath === join(root, "package.json") ||
        absolutePath === join(root, ".gitignore"),
    };
    const info = detectWorkspaceAt(root, fs);
    expect(info.root).toBe(root);
    expect(info.name).toBeUndefined();
    expect(info.version).toBeUndefined();
    expect(info.ignoreLines).toEqual([]);
  });

  it("throws WorkspaceNotFoundError when no marker exists above startDir", () => {
    // Inject a fake fs that reports no markers anywhere, so the walk reaches the volume root
    // without finding `.git`/`package.json`. Environment-independent.
    const emptyFs: WorkspaceFs = {
      readFileUtf8: (): string => "",
      stat: (): never => {
        throw new Error("not used");
      },
      readDir: (): readonly never[] => [],
      realPath: (p: string): string => p,
      exists: (): boolean => false,
    };
    expect(() => detectWorkspace("/some/deep/path", emptyFs)).toThrow(WorkspaceNotFoundError);
  });

  it.each(DETECTORS)("%s rejects an unavailable selected root before metadata IO", (_name, run) => {
    const probe = admissionProbe((): never => {
      throw new Error("EACCES");
    });

    expect(() => run(join(dir, "missing"), probe.fs)).toThrow(WorkspaceNotFoundError);
    expectAdmissionOnly(probe.calls, 1);
  });

  it.each(DETECTORS)("%s rejects a directly denied root before metadata IO", (_name, run) => {
    const root = join(dir, ".aws");
    const probe = admissionProbe((path) => path);

    expect(() => run(root, probe.fs)).toThrow(PathDeniedError);
    expectAdmissionOnly(probe.calls, 0);
  });

  it.each(DETECTORS)("%s rejects a root relocated into a denied path before IO", (_name, run) => {
    const selected = join(dir, "docs");
    const denied = join(dir, ".aws");
    const probe = admissionProbe(() => denied);

    expect(() => run(selected, probe.fs)).toThrow(PathDeniedError);
    expectAdmissionOnly(probe.calls, 1);
  });

  it.each(DETECTORS)("%s propagates a root identity denial during inspection", (_name, run) => {
    const selected = join(dir, "selected");
    const safe = join(dir, "safe");
    const denied = join(dir, ".aws");
    let identityReads = 0;
    const probe = admissionProbe(() => {
      identityReads += 1;
      return identityReads === 1 ? safe : denied;
    });

    expect(() => run(selected, probe.fs)).toThrow(PathDeniedError);
    expectAdmissionOnly(probe.calls, 2);
  });
});

describe("detectWorkspaceAt", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it("uses the given folder as the root even without a .git/package.json marker", () => {
    const dir = nodeWorkspaceFs.realPath(mkdtempSync(join(tmpdir(), "kw-at-")));
    dirs.push(dir);
    writeFileSync(join(dir, "notes.txt"), "hello world\n", "utf8");
    const info = detectWorkspaceAt(dir);
    expect(info.root).toBe(dir);
    expect(info.name).toBeUndefined();
  });

  it("does not walk up to a parent marker (the connected folder is the root)", () => {
    const parent = nodeWorkspaceFs.realPath(mkdtempSync(join(tmpdir(), "kw-at-parent-")));
    dirs.push(parent);
    writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "parent" }), "utf8");
    const child = join(parent, "child");
    mkdirSync(child);
    expect(detectWorkspaceAt(child).root).toBe(child);
  });

  it("returns and inspects the admitted canonical selected root", () => {
    const selected = join(dir, "selected-alias");
    const realRoot = join(dir, "selected-real");
    const base = memFs(realRoot, {
      "package.json": JSON.stringify({ name: "canonical-selection" }),
    });
    const fs: WorkspaceFs = {
      ...base,
      realPath: (path): string => (path === selected ? realRoot : path),
      readFileUtf8SameDescriptor: (path) => {
        const stat = base.stat(path);
        return { rawText: base.readFileUtf8(path), sizeBytes: stat.size, stat };
      },
    };

    const info = detectWorkspaceAt(selected, fs);

    expect(info.root).toBe(realRoot);
    // There is no walk here, so the caller's own argument IS the selected identity — admission has
    // already proven it resolves to the canonical root the inspection below binds to.
    expect(info.selectedRoot).toBe(selected);
    expect(info.name).toBe("canonical-selection");
  });

  it("does not inspect a canonical root replaced by another allowed directory", () => {
    const selected = join(dir, "selected-root");
    const admitted = join(dir, "admitted-root");
    const replacement = join(dir, "replacement-root");
    const probe = admissionProbe((path) => {
      if (path === selected) return admitted;
      return path.startsWith(admitted) ? join(replacement, path.slice(admitted.length)) : path;
    });

    expect(() => detectWorkspaceAt(selected, probe.fs)).toThrow(PathDeniedError);
    expect(probe.calls.exists).toBe(0);
    expect(probe.calls.stat).toBe(0);
    expect(probe.calls.readDir).toBe(0);
    expect(probe.calls.readFile).toBe(0);
  });

  it("prefers the descriptor-validated metadata read lane", () => {
    const root = join(dir, "descriptor-metadata");
    const raw = JSON.stringify({ name: "descriptor-metadata" });
    const base = memFs(root, { "package.json": raw });
    let descriptorReads = 0;
    let rawReads = 0;
    const fs: WorkspaceFs = {
      ...base,
      readFileUtf8: (path): string => {
        rawReads += 1;
        return base.readFileUtf8(path);
      },
      readFileUtf8SameDescriptor: (path, maxBytes, hardLinkPolicy) => {
        descriptorReads += 1;
        expect(maxBytes).toBe(1_048_576);
        expect(hardLinkPolicy).toBe("reject");
        const stat = base.stat(path);
        return { rawText: base.readFileUtf8(path), sizeBytes: stat.size, stat };
      },
    };

    expect(detectWorkspaceAt(root, fs).name).toBe("descriptor-metadata");
    expect({ descriptorReads, rawReads }).toEqual({ descriptorReads: 1, rawReads: 0 });
  });

  it("uses a finite entry cap for every language-discovery directory read", () => {
    const root = join(dir, "bounded-language-discovery");
    const base = memFs(root, {
      "src/app.ts": "export {};",
      "src/nested/value.ts": "export const value = 1;",
    });
    const requestedCaps: (number | undefined)[] = [];
    let returnedEntries = 0;
    const fs: WorkspaceFs = {
      ...base,
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        requestedCaps.push(maxEntries);
        const entries = base.readDir(path, maxEntries);
        returnedEntries += entries.length;
        return entries;
      },
    };

    const info = detectWorkspaceAt(root, fs);

    expect(info.languages).toContain("typescript");
    expect(requestedCaps.length).toBeGreaterThan(0);
    expect(requestedCaps.every((cap) => cap !== undefined && cap > 0)).toBe(true);
    expect(
      Math.max(...requestedCaps.filter((cap): cap is number => cap !== undefined)),
    ).toBeLessThanOrEqual(4_001);
    expect(returnedEntries).toBeLessThanOrEqual(4_000);
  });

  it("supports marker-only language detection without a repository walk", () => {
    const root = join(dir, "marker-only-language-detection");
    const base = memFs(root, {
      "package.json": JSON.stringify({ name: "marker-only" }),
      "src/app.ts": "export {};",
    });
    let readDirCalls = 0;
    const fs: WorkspaceFs = {
      ...base,
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        readDirCalls += 1;
        return base.readDir(path, maxEntries);
      },
    };

    const info = detectWorkspaceAt(root, fs, { scanSourceFilesForLanguages: false });

    expect(info.languages).toEqual(["javascript"]);
    expect(readDirCalls).toBe(0);
  });
});
