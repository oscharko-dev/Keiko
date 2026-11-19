// #4434 / #4435: per-entry availability and benign directory churn during a recursive search.
// Real temporary folders keep these proofs meaningful on Windows, macOS and Linux; the port is
// fault-injected only at the one call that models a locked, protected or vanishing entry.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWorkspaceAt } from "./detect.js";
import { visitWorkspaceFiles } from "./discovery.js";
import { workspaceEntryAvailabilityFailure } from "./entryAvailability.js";
import { PathDeniedError } from "./errors.js";
import {
  nodeWorkspaceFs,
  WorkspaceDescriptorReadError,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceStat,
} from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import { createStructuralExecutionControl } from "./structuralExecution.js";
import { discoverWorkspacePaths } from "./workspacePathDiscovery.js";

let root: string;

function scope(): SearchScope {
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "entry-availability",
    relativePaths: [],
  };
}

function query(): Parameters<typeof searchText>[1] {
  return {
    kind: "exact-symbol",
    text: "EntryAvailabilityProbe",
    caseSensitive: true,
    maxResults: 100,
    emittedAtMs: 0,
  };
}

function errno(code: string): Error {
  return Object.assign(new Error("PRIVATE_FIXTURE_DETAIL"), { code });
}

function isEntry(path: string, name: string): boolean {
  return path.replaceAll("\\", "/").endsWith(`/docs/${name}`);
}

function isDocsDirectory(path: string): boolean {
  return path.replaceAll("\\", "/").endsWith("/docs");
}

// One entry fails at the no-follow metadata read and at canonicalization, as a locked or
// protected Windows file can.
function failingEntryFs(failures: Readonly<Record<string, string>>): WorkspaceFs {
  const codeFor = (path: string): string | undefined =>
    Object.entries(failures).find(([name]) => isEntry(path, name))?.[1];
  return {
    ...nodeWorkspaceFs,
    stat: (path): WorkspaceStat => {
      const code = codeFor(path);
      if (code !== undefined) throw errno(code);
      return nodeWorkspaceFs.stat(path);
    },
    realPath: (path): string => {
      const code = codeFor(path);
      if (code !== undefined) throw errno(code);
      return nodeWorkspaceFs.realPath(path);
    },
  };
}

function iterate(): NonNullable<WorkspaceFs["iterateDirectory"]> {
  const native = nodeWorkspaceFs.iterateDirectory;
  if (native === undefined) throw new Error("fixture streaming directory port missing");
  return native;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-entry-availability-")));
  mkdirSync(join(root, "docs"));
  for (const name of ["locked.docx.txt", "protected.txt", "readable.txt"])
    writeFileSync(join(root, "docs", name), `EntryAvailabilityProbe ${name}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("entry availability classification", () => {
  it.each([
    ["ENOENT", "vanished"],
    ["ENOTDIR", "vanished"],
    ["ESTALE", "vanished"],
    ["EACCES", "unavailable"],
    ["EPERM", "unavailable"],
    ["EBUSY", "unavailable"],
    ["EIO", "unavailable"],
  ])("classifies %s as %s", (code, expected) => {
    expect(workspaceEntryAvailabilityFailure(errno(code))).toBe(expected);
  });

  it.each(["EMFILE", "ENFILE", "ENOMEM", "ELOOP", undefined])("keeps %s fatal", (code) => {
    const error = code === undefined ? new Error("no code") : errno(code);
    expect(workspaceEntryAvailabilityFailure(error)).toBeUndefined();
  });
});

describe("recursive search past locked and protected entries (#4434)", () => {
  it("completes with the readable files and discloses one locked and one protected entry", async () => {
    const fs = failingEntryFs({ "locked.docx.txt": "EBUSY", "protected.txt": "EACCES" });
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["docs/readable.txt"]);
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      unavailableEntriesByDiscovery: 2,
    });
    expect(result.coverage.vanishedEntriesByDiscovery).toBeUndefined();
    // The skip is not misreported as a symbolic link or a denied path.
    expect(result.coverage.deniedByDiscovery).toBe(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE_DETAIL");
  });

  it("skips, counts and discloses an entry that vanished before inspection", async () => {
    const fs = failingEntryFs({ "locked.docx.txt": "ENOENT" });
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual([
      "docs/protected.txt",
      "docs/readable.txt",
    ]);
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      vanishedEntriesByDiscovery: 1,
    });
    expect(result.coverage.deniedByDiscovery).toBe(0);
  });

  it.each(["EMFILE", "ENFILE"])("still fails the whole search on %s", async (code) => {
    // Canonicalization succeeds; the no-follow metadata read hits descriptor exhaustion.
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      stat: (path): WorkspaceStat => {
        if (isEntry(path, "locked.docx.txt")) throw errno(code);
        return nodeWorkspaceFs.stat(path);
      },
    };
    await expect(searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs })).rejects.toThrow();
  });

  it("counts an entry whose canonical path cannot be resolved instead of calling it a symlink", async () => {
    // A disconnected mount point inside the folder: canonicalization fails with a code that is
    // neither a vanished nor a locked entry. The walk discloses it and keeps its siblings.
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      realPath: (path): string => {
        if (isEntry(path, "locked.docx.txt")) throw errno("ENOTCONN");
        return nodeWorkspaceFs.realPath(path);
      },
    };
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual([
      "docs/protected.txt",
      "docs/readable.txt",
    ]);
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      unavailableEntriesByDiscovery: 1,
    });
    expect(result.coverage.deniedByDiscovery).toBe(0);
  });

  it("still fails closed when the root becomes unavailable while an entry is skipped", async () => {
    let rootGone = false;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      stat: (path) => {
        if (isEntry(path, "locked.docx.txt")) {
          rootGone = true;
          throw errno("EBUSY");
        }
        return nodeWorkspaceFs.stat(path);
      },
      realPath: (path) => {
        if (isEntry(path, "locked.docx.txt")) throw errno("EBUSY");
        if (rootGone && path === root) throw errno("ENOENT");
        return nodeWorkspaceFs.realPath(path);
      },
    };
    const visit = visitWorkspaceFiles(
      scope().workspace,
      [],
      false,
      fs,
      createStructuralExecutionControl(null),
      { onFile: () => Promise.resolve() },
    );
    await expect(visit).rejects.toBeInstanceOf(PathDeniedError);
    expect(rootGone).toBe(true);
  });
});

describe("recursive search under benign directory churn (#4435)", () => {
  it("re-reads a directory whose membership moved once and finds the added lock file", async () => {
    let passes = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        if (!isDocsDirectory(path)) {
          yield* iterate()(path);
          return;
        }
        passes += 1;
        if (passes === 1) {
          // Office creates its owner file while the folder is being enumerated.
          writeFileSync(join(root, "docs", "~$locked.docx.txt"), "EntryAvailabilityProbe owner");
          yield* iterate()(path);
          throw new WorkspaceDescriptorReadError("directory-membership-changed");
        }
        yield* iterate()(path);
      },
    };
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(passes).toBe(2);
    expect(result.atoms.map((atom) => atom.scopePath).sort()).toEqual([
      "docs/locked.docx.txt",
      "docs/protected.txt",
      "docs/readable.txt",
      "docs/~$locked.docx.txt",
    ]);
    // Every entry is visited exactly once even though the directory was read twice.
    expect(new Set(result.atoms.map((atom) => atom.scopePath)).size).toBe(result.atoms.length);
    expect(result.coverage).toMatchObject({ incomplete: false, membershipRetriesByDiscovery: 1 });
  });

  it("keeps churn that persists through the retry an io-error", async () => {
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        yield* iterate()(path);
        if (isDocsDirectory(path))
          throw new WorkspaceDescriptorReadError("directory-membership-changed");
      },
    };
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(result.atoms).toHaveLength(3);
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      membershipRetriesByDiscovery: 1,
      unavailableDirectoriesByDiscovery: 1,
    });
    expect(result.coverage.oversizedDirectoriesByDiscovery).toBeUndefined();
  });

  it("does not retry a directory above the per-directory name ceiling", async () => {
    let passes = 0;
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        if (!isDocsDirectory(path)) {
          yield* iterate()(path);
          return;
        }
        passes += 1;
        // More names than the retry may retain; they no longer exist when inspected.
        for (let index = 0; index <= 10_000; index += 1)
          yield await Promise.resolve({
            name: `listed-${String(index)}.txt`,
            isDirectory: false,
            isFile: true,
            isSymbolicLink: false,
          });
        throw new WorkspaceDescriptorReadError("directory-membership-changed");
      },
    };
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(passes).toBe(1);
    expect(result.coverage.membershipRetriesByDiscovery).toBeUndefined();
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      oversizedDirectoriesByDiscovery: 1,
    });
    // The oversized directory is its own cause, not also an unreadable one (#4431).
    expect(result.coverage.unavailableDirectoriesByDiscovery).toBeUndefined();
  });

  it("still fails closed when the enumerated directory changes identity", async () => {
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        yield* iterate()(path);
        if (path === root) throw new WorkspaceDescriptorReadError("changed");
      },
    };
    await expect(searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs })).rejects.toThrow();
  });
});

describe("recursive search discloses every discovery drop by cause (#4431)", () => {
  const linkEntry = { name: "linked", isDirectory: true, isFile: false, isSymbolicLink: true };

  function fsWithDocsListing(
    listing: (path: string) => AsyncIterable<WorkspaceDirEntry>,
  ): WorkspaceFs {
    return {
      ...nodeWorkspaceFs,
      iterateDirectory: (path) => (isDocsDirectory(path) ? listing(path) : iterate()(path)),
    };
  }

  it("reports no drop counts for a walk that considered every entry", async () => {
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, {
      fs: nodeWorkspaceFs,
    });
    expect(result.coverage.skippedSymbolicLinksByDiscovery).toBeUndefined();
    expect(result.coverage.unavailableDirectoriesByDiscovery).toBeUndefined();
    expect(result.coverage.oversizedDirectoriesByDiscovery).toBeUndefined();
  });

  it("counts an unreadable subdirectory and keeps its readable siblings", async () => {
    mkdirSync(join(root, "vault"));
    writeFileSync(join(root, "vault", "notes.txt"), "EntryAvailabilityProbe vault");
    const fs: WorkspaceFs = {
      ...nodeWorkspaceFs,
      iterateDirectory: async function* (path) {
        if (path.replaceAll("\\", "/").endsWith("/vault")) throw errno("EACCES");
        yield* iterate()(path);
      },
    };
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(result.atoms).toHaveLength(3);
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["io-error"],
      unavailableDirectoriesByDiscovery: 1,
    });
    expect(JSON.stringify(result.coverage)).not.toContain("vault");
  });

  it("counts a skipped link on its own instead of as a denied path", async () => {
    const fs = fsWithDocsListing(async function* (path) {
      yield* iterate()(path);
      yield linkEntry;
    });
    const result = await searchText(scope(), query(), DEFAULT_SEARCH_LIMITS, { fs });
    expect(result.atoms).toHaveLength(3);
    expect(result.coverage).toMatchObject({
      skippedSymbolicLinksByDiscovery: 1,
      deniedByDiscovery: 0,
    });
    // The skipped link still counts as a skipped entry, as it did while it was a denial.
    expect(result.coverage.filesSkipped).toBeGreaterThanOrEqual(1);
  });

  it("reports a skipped link apart from denied entries in the walk stats", async () => {
    const fs = fsWithDocsListing(async function* (path) {
      yield* iterate()(path);
      yield linkEntry;
    });
    const stats = await visitWorkspaceFiles(
      scope().workspace,
      [],
      false,
      fs,
      createStructuralExecutionControl(null),
      { onFile: () => Promise.resolve() },
    );
    expect(stats).toMatchObject({ denied: 0, skippedSymbolicLinks: 1 });
  });

  it("keeps reporting a skipped link as denied to path discovery", async () => {
    const fs = fsWithDocsListing(async function* (path) {
      yield* iterate()(path);
      yield linkEntry;
    });
    const result = await discoverWorkspacePaths(
      scope().workspace,
      { mode: "keywords", directory: "", query: "readable", maxResults: 10 },
      createStructuralExecutionControl(5_000),
      fs,
    );
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["docs/readable.txt"]);
    expect(result.stats).toMatchObject({ denied: 1 });
  });
});
