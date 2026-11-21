// #4434 / #4435: the Knowledge Pod walk under benign directory churn and per-entry availability
// failures. Office lock files and sync clients move a directory's mtime/ctime constantly; that is
// membership churn, not an identity change, and must not fail ingestion.
import { describe, expect, it } from "vitest";
import type { WorkspaceDirEntry, WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { WorkspaceDescriptorReadError } from "@oscharko-dev/keiko-workspace/internal/fs";

import { folderScope, memoryFs } from "./test-support.js";
import { DEFAULT_DISCOVERY_OPTIONS, type WalkChurnKind } from "./types.js";
import { walkSource, type WalkYield } from "./walk.js";

const ROOT = "/srv/docs";

function fixture(): WorkspaceFs {
  return memoryFs(ROOT, [
    { relativePath: "a.md", content: "alpha" },
    { relativePath: "nested/b.md", content: "beta" },
    { relativePath: "~$c.docx", content: "lock" },
  ]);
}

function errno(code: string): Error {
  return Object.assign(new Error("PRIVATE_FIXTURE_DETAIL"), { code });
}

// Directory stats carry a membership timestamp that moves on every read, like a folder in which
// Office keeps creating and deleting owner files.
function churningDirectories(base: WorkspaceFs): WorkspaceFs {
  let tick = 0;
  return {
    ...base,
    stat: (path): WorkspaceStat => {
      const stat = base.stat(path);
      if (!stat.isDirectory) return stat;
      tick += 1;
      return { ...stat, mtimeMs: tick, ctimeMs: tick };
    },
  };
}

function walk(fs: WorkspaceFs, churn: WalkChurnKind[] = []): readonly WalkYield[] {
  return [
    ...walkSource(fs, folderScope(ROOT), {
      ...DEFAULT_DISCOVERY_OPTIONS,
      onWalkChurn: (kind) => churn.push(kind),
    }),
  ];
}

function files(out: readonly WalkYield[]): readonly string[] {
  return out.flatMap((entry) => (entry.kind === "file" ? [entry.file.relativePath] : [])).sort();
}

function errors(out: readonly WalkYield[]): readonly unknown[] {
  return out.flatMap((entry) => (entry.kind === "error" ? [entry.error] : []));
}

describe("walkSource — benign directory churn (#4435)", () => {
  it("does not fail ingestion when the root's membership metadata moves during the walk", () => {
    const out = walk(churningDirectories(fixture()));
    expect(errors(out)).toEqual([]);
    expect(files(out)).toEqual(["a.md", "nested/b.md", "~$c.docx"]);
  });

  it("re-reads a directory once when its membership moved during enumeration", () => {
    const base = churningDirectories(fixture());
    let reads = 0;
    const fs: WorkspaceFs = {
      ...base,
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        if (path === `${ROOT}/nested`) {
          reads += 1;
          if (reads === 1) throw new WorkspaceDescriptorReadError("changed");
        }
        return base.readDir(path, maxEntries);
      },
    };
    const churn: WalkChurnKind[] = [];
    const out = walk(fs, churn);
    expect(reads).toBe(2);
    expect(errors(out)).toEqual([]);
    expect(files(out)).toEqual(["a.md", "nested/b.md", "~$c.docx"]);
    expect(churn).toEqual(["directory-retried"]);
  });

  it("keeps a directory whose membership keeps moving through the retry READ_FAILED", () => {
    const base = churningDirectories(fixture());
    const fs: WorkspaceFs = {
      ...base,
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        if (path === `${ROOT}/nested`) throw new WorkspaceDescriptorReadError("changed");
        return base.readDir(path, maxEntries);
      },
    };
    const out = walk(fs);
    expect(errors(out)).toEqual([{ code: "READ_FAILED", message: "directory read failed" }]);
    expect(files(out)).toEqual(["a.md", "~$c.docx"]);
  });

  it("does not retry a directory whose metadata did not move", () => {
    const base = fixture();
    let reads = 0;
    const fs: WorkspaceFs = {
      ...base,
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        if (path === `${ROOT}/nested`) {
          reads += 1;
          throw errno("EACCES");
        }
        return base.readDir(path, maxEntries);
      },
    };
    const out = walk(fs);
    expect(reads).toBe(1);
    expect(errors(out)).toEqual([{ code: "READ_FAILED", message: "directory read failed" }]);
  });

  it("still fails closed when the root is replaced during the walk", () => {
    const base = churningDirectories(fixture());
    let replaced = false;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (path) => (replaced && path === ROOT ? "/srv/other" : base.realPath(path)),
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        const entries = base.readDir(path, maxEntries);
        if (path === ROOT) replaced = true;
        return entries;
      },
    };
    const out = walk(fs);
    expect(files(out)).toEqual([]);
    expect(errors(out)).toContainEqual({ code: "READ_FAILED", message: "directory read failed" });
  });

  it("still fails closed when the root's identity changes in place", () => {
    const base = fixture();
    let replaced = false;
    const fs: WorkspaceFs = {
      ...base,
      stat: (path): WorkspaceStat => {
        const stat = base.stat(path);
        return replaced && path === ROOT ? { ...stat, fileIdentity: "memory:replacement" } : stat;
      },
      readDir: (path, maxEntries): readonly WorkspaceDirEntry[] => {
        const entries = base.readDir(path, maxEntries);
        if (path === ROOT) replaced = true;
        return entries;
      },
    };
    const out = walk(fs);
    expect(files(out)).toEqual([]);
    expect(errors(out).length).toBeGreaterThan(0);
  });
});

describe("walkSource — per-entry availability (#4434)", () => {
  function failingEntry(name: string, code: string): WorkspaceFs {
    const base = fixture();
    return {
      ...base,
      realPath: (path): string => {
        if (path === `${ROOT}/${name}`) throw errno(code);
        return base.realPath(path);
      },
    };
  }

  it("skips and counts an entry that vanished before inspection", () => {
    const churn: WalkChurnKind[] = [];
    const out = walk(failingEntry("~$c.docx", "ENOENT"), churn);
    expect(errors(out)).toEqual([]);
    expect(files(out)).toEqual(["a.md", "nested/b.md"]);
    expect(churn).toEqual(["vanished-entry"]);
  });

  it.each(["EBUSY", "EACCES", "EPERM"])(
    "reports a %s entry as locked or not permitted and keeps walking",
    (code) => {
      const out = walk(failingEntry("a.md", code));
      expect(errors(out)).toEqual([
        { code: "READ_FAILED", message: "entry is locked or not permitted", relativePath: "a.md" },
      ]);
      expect(files(out)).toEqual(["nested/b.md", "~$c.docx"]);
      expect(JSON.stringify(out)).not.toContain("PRIVATE_FIXTURE_DETAIL");
    },
  );

  it("keeps an unclassified realpath failure a READ_FAILED entry", () => {
    const out = walk(failingEntry("a.md", "EMFILE"));
    expect(errors(out)).toEqual([
      { code: "READ_FAILED", message: "entry realpath failed", relativePath: "a.md" },
    ]);
  });
});
