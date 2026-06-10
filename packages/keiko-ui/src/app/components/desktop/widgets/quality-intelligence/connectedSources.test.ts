// Unit tests for the pure N+1 connected-source assembly (Epic #729, Issue #731).
//
// Mutation-robust: each branch of the additive assembly (file-supersedes-own-folder, dedupe, global
// cap, per-kind ordering, none-connected) has a dedicated case that would fail if the rule regressed.
// No React render — the logic is pure so it is unit-testable directly (closes the untested-builders
// gap from the #729 review).

import { describe, expect, it } from "vitest";
import { buildConnectedRunSources, resolveConnectedFilePath } from "./connectedSources";
import { MAX_SCOPES } from "../../hooks/workspaceActions";

describe("buildConnectedRunSources — N+1 additive assembly (#729)", () => {
  it("aggregates a file + folder + capsule into THREE attributable sources (headline AC)", () => {
    const sources = buildConnectedRunSources({
      connectedFilePath: "/work/spec/funds-transfer.md",
      connectedRoots: ["/work/login-folder"],
      connectedCapsuleIds: ["cap-statement"],
    });
    expect(sources).toEqual([
      { kind: "file", label: "funds-transfer.md", path: "/work/spec/funds-transfer.md" },
      { kind: "workspace", label: "login-folder", path: "/work/login-folder" },
      { kind: "capsule", label: "cap-statement", capsuleId: "cap-statement" },
    ]);
  });

  it("orders sources file → folders → capsules → capsule-sets → figma snapshots", () => {
    const sources = buildConnectedRunSources({
      connectedFilePath: "/abs/a.md",
      connectedRoots: ["/f1", "/f2"],
      connectedCapsuleIds: ["c1"],
      connectedCapsuleSetIds: ["s1"],
      connectedFigmaSnapshotRunIds: ["fig-run-1"],
    });
    expect(sources.map((s) => s.kind)).toEqual([
      "file",
      "workspace",
      "workspace",
      "capsule",
      "capsule-set",
      "figma-snapshot",
    ]);
  });

  it("aggregates connected figma snapshots alongside other sources, deduped (Epic #750 N+1 parity)", () => {
    const sources = buildConnectedRunSources({
      connectedRoots: ["/f1"],
      connectedFigmaSnapshotRunIds: ["fig-1", "fig-1", "fig-2"],
    });
    expect(sources).toEqual([
      { kind: "workspace", label: "f1", path: "/f1" },
      { kind: "figma-snapshot", label: "fig-1", snapshotRunId: "fig-1" },
      { kind: "figma-snapshot", label: "fig-2", snapshotRunId: "fig-2" },
    ]);
  });

  it("a focused file SUPERSEDES its own Files-window folder root (no double-ingest), keeps other folders", () => {
    // connectedRoot is the focused file's own window root; it must be dropped from the folder set so
    // the same content is not ingested as a file AND as its parent folder, while /other/folder stays.
    const sources = buildConnectedRunSources({
      connectedRoot: "/work/spec",
      connectedFilePath: "/work/spec/funds-transfer.md",
      connectedRoots: ["/work/spec", "/other/folder"],
    });
    expect(sources).toEqual([
      { kind: "file", label: "funds-transfer.md", path: "/work/spec/funds-transfer.md" },
      { kind: "workspace", label: "folder", path: "/other/folder" },
    ]);
  });

  it("a lone focused file with only its own folder connected is a one-element file request (#709 unchanged)", () => {
    const sources = buildConnectedRunSources({
      connectedRoot: "/work/spec",
      connectedFilePath: "/work/spec/funds-transfer.md",
      connectedRoots: ["/work/spec"],
    });
    expect(sources).toEqual([
      { kind: "file", label: "funds-transfer.md", path: "/work/spec/funds-transfer.md" },
    ]);
  });

  it("dedupes duplicate folder roots and duplicate capsule ids", () => {
    const sources = buildConnectedRunSources({
      connectedRoots: ["/dup", "/dup", "/unique"],
      connectedCapsuleIds: ["cap", "cap"],
    });
    expect(sources.filter((s) => s.kind === "workspace").map((s) => s.path)).toEqual([
      "/dup",
      "/unique",
    ]);
    expect(sources.filter((s) => s.kind === "capsule")).toHaveLength(1);
  });

  it("dedupes folder roots that differ only in a trailing separator (N+1 path-variant robustness)", () => {
    // Two Files windows whose roots are typed inconsistently ("/work/spec" vs "/work/spec/") name the
    // SAME folder; without canonicalisation the server would ingest it twice (token waste + duplicate
    // citations). The combined list must collapse them to one workspace source.
    const sources = buildConnectedRunSources({
      connectedRoots: ["/work/spec", "/work/spec/", "/other"],
    });
    expect(sources.filter((s) => s.kind === "workspace").map((s) => s.path)).toEqual([
      "/work/spec",
      "/other",
    ]);
  });

  it("a focused file supersedes its own folder even when the folder root carries a trailing slash", () => {
    // The focused file's own window root arrives canonicalised ("/work/spec") while the same window's
    // entry in connectedRoots carries a trailing slash ("/work/spec/"). The file must still supersede
    // its own folder so the document is never ingested as a file AND as its parent folder.
    const sources = buildConnectedRunSources({
      connectedRoot: "/work/spec",
      connectedFilePath: "/work/spec/funds-transfer.md",
      connectedRoots: ["/work/spec/", "/other/folder"],
    });
    expect(sources).toEqual([
      { kind: "file", label: "funds-transfer.md", path: "/work/spec/funds-transfer.md" },
      { kind: "workspace", label: "folder", path: "/other/folder" },
    ]);
  });

  it("caps the COMBINED list at MAX_SCOPES across all kinds (single global cap, file-first)", () => {
    const folders = Array.from({ length: 20 }, (_, i) => `/folder-${i.toString()}`);
    const capsules = Array.from({ length: 20 }, (_, i) => `cap-${i.toString()}`);
    const sources = buildConnectedRunSources({
      connectedFilePath: "/abs/lead.md",
      connectedRoots: folders,
      connectedCapsuleIds: capsules,
    });
    expect(sources).toHaveLength(MAX_SCOPES);
    // The file is first, so it survives the cap; the cap is global (not per category).
    expect(sources[0]).toMatchObject({ kind: "file", path: "/abs/lead.md" });
    expect(sources.filter((s) => s.kind === "capsule")).toHaveLength(0);
  });

  it("returns an empty list when nothing is connected (manual-input fallback case)", () => {
    expect(buildConnectedRunSources({})).toEqual([]);
    expect(buildConnectedRunSources({ connectedRoots: [], connectedCapsuleIds: [] })).toEqual([]);
  });

  it("falls back to the single connectedRoot when connectedRoots is undefined (back-compat)", () => {
    const sources = buildConnectedRunSources({ connectedRoot: "/single" });
    expect(sources).toEqual([{ kind: "workspace", label: "single", path: "/single" }]);
  });
});

describe("resolveConnectedFilePath", () => {
  it("returns an absolute activeFilePath unchanged", () => {
    expect(resolveConnectedFilePath("/root", "/abs/file.md")).toBe("/abs/file.md");
  });

  it("joins a relative activeFilePath onto the connected root", () => {
    expect(resolveConnectedFilePath("/root/dir/", "sub/spec.md")).toBe("/root/dir/sub/spec.md");
  });

  it("returns null for a relative file with no root (never emits a server-rejected relative source)", () => {
    expect(resolveConnectedFilePath(null, "spec.md")).toBeNull();
  });

  it("returns null when there is no focused file", () => {
    expect(resolveConnectedFilePath("/root", null)).toBeNull();
    expect(resolveConnectedFilePath("/root", "   ")).toBeNull();
  });
});
