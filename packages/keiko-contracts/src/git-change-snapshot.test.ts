import { describe, expect, it } from "vitest";
import {
  GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS,
  GIT_CHANGE_SNAPSHOT_ENTRY_KINDS,
  GIT_CHANGE_SNAPSHOT_FAILURE_REASONS,
  GIT_CHANGE_SNAPSHOT_LIMIT_CEILINGS,
  GIT_CHANGE_SNAPSHOT_MAX_TTL_MS,
  GIT_CHANGE_SNAPSHOT_OMISSION_REASONS,
  GIT_CHANGE_SNAPSHOT_OUTCOMES,
  GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
  GIT_CHANGE_SNAPSHOT_UNAVAILABLE_REASONS,
  deriveGitChangeSnapshotOutcome,
  gitChangeSnapshotDigestFields,
  gitChangeSnapshotEntryIdentityFields,
  isGitChangeSnapshot,
  isGitChangeSnapshotReference,
  resolveGitChangeSnapshotLimits,
  summarizeGitChangeSnapshotCompleteness,
  validateGitChangeSnapshotResult,
  type GitChangeSnapshot,
  type GitChangeSnapshotEntry,
  type GitChangeSnapshotHunk,
  type GitChangeSnapshotLimits,
} from "./git-change-snapshot.js";
import { isVerifiedCommitResult, type VerifiedCommitResult } from "./verified-commit.js";

// Deterministic, content-free stand-ins with the exact shape the validator demands. The validator
// never recomputes a digest (the contracts leaf has no crypto), so any 64-hex value is a digest.
function hexFrom(seed: string, length: number): string {
  const hex = Buffer.from(seed, "utf8").toString("hex");
  return hex.repeat(Math.ceil(length / hex.length)).slice(0, length);
}
function hex64(seed: string): string {
  return hexFrom(seed, 64);
}
function sha(seed: string): string {
  return hexFrom(seed, 40);
}
const ZERO_ID = "0".repeat(40);
const CAPTURED_AT = "2026-09-04T10:00:00.000Z";
const EXPIRES_AT = "2026-09-04T10:15:00.000Z";

function hunk(seed: string, additions = 1, deletions = 1): GitChangeSnapshotHunk {
  return {
    hunkDigest: hex64(seed),
    oldStart: 1,
    oldCount: 2,
    newStart: 1,
    newCount: 2,
    additions,
    deletions,
  };
}

type Overrides = Readonly<Record<string, unknown>>;

function textual(
  kind: "add" | "modify" | "delete",
  seed: string,
  overrides: Overrides = {},
): GitChangeSnapshotEntry {
  return {
    kind,
    evidenceId: hex64(`e${seed}`),
    pathDigest: hex64(`p${seed}`),
    oldMode: kind === "add" ? "000000" : "100644",
    newMode: kind === "delete" ? "000000" : "100644",
    oldObjectId: kind === "add" ? ZERO_ID : sha(`a${seed}`),
    newObjectId: kind === "delete" ? ZERO_ID : sha(`b${seed}`),
    additions: 1,
    deletions: 1,
    hunks: [hunk(`h${seed}`)],
    omittedHunks: 0,
    truncated: false,
    ...overrides,
  };
}

function paired(
  kind: "rename" | "copy",
  seed: string,
  overrides: Overrides = {},
): GitChangeSnapshotEntry {
  return {
    ...textual("modify", seed),
    kind,
    oldPathDigest: hex64(`o${seed}`),
    similarity: 90,
    ...overrides,
  };
}

function contentless(
  kind: "mode-change" | "binary" | "submodule",
  seed: string,
  overrides: Overrides = {},
): GitChangeSnapshotEntry {
  return {
    ...textual("modify", seed),
    kind,
    additions: 0,
    deletions: 0,
    hunks: [],
    ...(kind === "mode-change" ? { newMode: "100755" } : { change: "modify", omission: kind }),
    ...(kind === "submodule" ? { oldMode: "160000", newMode: "160000" } : {}),
    ...overrides,
  } as GitChangeSnapshotEntry;
}

function everyKind(): readonly GitChangeSnapshotEntry[] {
  return [
    textual("add", "1"),
    textual("modify", "2"),
    textual("delete", "3"),
    paired("rename", "4"),
    paired("copy", "5"),
    contentless("mode-change", "6"),
    contentless("binary", "7"),
    contentless("submodule", "8"),
  ];
}

function snapshot(
  entries: readonly GitChangeSnapshotEntry[] = everyKind(),
  overrides: Overrides = {},
  limits: GitChangeSnapshotLimits = GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS,
  totalFiles = entries.length,
): Record<string, unknown> {
  const completeness = summarizeGitChangeSnapshotCompleteness({ entries, totalFiles, bytes: 512 });
  return {
    schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    repositoryId: "repo_0123456789abcdef",
    baseRef: "main",
    baseSha: sha("1"),
    headRef: "feat/snapshot",
    headSha: sha("2"),
    mergeBaseSha: sha("3"),
    capturedAt: CAPTURED_AT,
    expiresAt: EXPIRES_AT,
    outcome: deriveGitChangeSnapshotOutcome(completeness),
    limits,
    completeness,
    entries,
    localDivergence: { stagedCount: 0, unstagedCount: 1, untrackedCount: 2, conflictedCount: 0 },
    snapshotDigest: hex64("d"),
    ...overrides,
  };
}

function reasonsOf(input: unknown): readonly string[] {
  const validation = validateGitChangeSnapshotResult(input);
  return validation.ok ? [] : validation.reasons;
}

function expectRejected(input: unknown, fragment: string): void {
  const reasons = reasonsOf(input);
  expect(
    reasons.some((reason) => reason.includes(fragment)),
    reasons.join("\n"),
  ).toBe(true);
}

describe("validateGitChangeSnapshotResult — captured snapshots", () => {
  it("accepts a snapshot carrying every entry kind and derives it complete", () => {
    const validation = validateGitChangeSnapshotResult(snapshot());
    expect(validation).toMatchObject({ ok: true });
    if (!validation.ok) return;
    expect(validation.value.outcome).toBe("complete");
    expect(isGitChangeSnapshot(validation.value)).toBe(true);
    expect((validation.value as GitChangeSnapshot).entries.map((entry) => entry.kind)).toEqual([
      ...GIT_CHANGE_SNAPSHOT_ENTRY_KINDS,
    ]);
  });

  it("returns the input by reference, never a copy", () => {
    const input = snapshot();
    const validation = validateGitChangeSnapshotResult(input);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.value).toBe(input);
  });

  it("freezes the outcome vocabulary: `stale` is not an outcome", () => {
    expect([...GIT_CHANGE_SNAPSHOT_OUTCOMES]).toEqual([
      "complete",
      "partial",
      "unavailable",
      "failed",
    ]);
    expect(reasonsOf(snapshot(everyKind(), { outcome: "stale" }))).toEqual([
      "outcome must be a snapshot outcome",
    ]);
  });

  it("never labels a truncated snapshot complete", () => {
    const cut = textual("modify", "9", { truncated: true, omission: "byte-cap" });
    const partial = snapshot([cut]);
    expect(partial.outcome).toBe("partial");
    expect(validateGitChangeSnapshotResult(partial)).toMatchObject({ ok: true });
    expectRejected({ ...partial, outcome: "complete" }, "outcome must be partial");
  });

  it("derives partial for dropped hunks, dropped files and the generated policy, not for binaries", () => {
    const dropped = textual("modify", "a", { omittedHunks: 3, omission: "byte-cap" });
    expect(snapshot([dropped]).outcome).toBe("partial");
    expect(snapshot([textual("add", "b")], {}, GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS, 2).outcome).toBe(
      "partial",
    );
    const generated = textual("add", "c", { truncated: true, omission: "generated" });
    expect(snapshot([generated]).outcome).toBe("partial");
    expect(snapshot([contentless("binary", "d"), contentless("submodule", "e")]).outcome).toBe(
      "complete",
    );
  });

  it("rejects a completeness record that disagrees with its entries", () => {
    const base = snapshot();
    const completeness = base.completeness as Record<string, unknown>;
    expectRejected(
      { ...base, completeness: { ...completeness, hunks: 0 } },
      "completeness.hunks must equal the roll-up",
    );
    expectRejected(
      { ...base, completeness: { ...completeness, totalFiles: 3 } },
      "completeness.totalFiles must be at least entries.length",
    );
    expectRejected(
      { ...base, completeness: { ...completeness, omissions: [] } },
      "completeness.omissions must roll up",
    );
    expectRejected(
      { ...base, completeness: { ...completeness, totalFiles: 9, omittedFiles: 0 } },
      "completeness.omittedFiles must equal the roll-up",
    );
  });

  it("rejects the same revisions on both sides and a merge base equal to the head", () => {
    expectRejected(snapshot(everyKind(), { headSha: sha("1") }), "baseSha and headSha must differ");
    expectRejected(snapshot(everyKind(), { mergeBaseSha: sha("2") }), "mergeBaseSha must differ");
  });

  it("holds the expiry window at both ends", () => {
    const atMax = new Date(Date.parse(CAPTURED_AT) + GIT_CHANGE_SNAPSHOT_MAX_TTL_MS).toISOString();
    expect(
      validateGitChangeSnapshotResult(snapshot(everyKind(), { expiresAt: atMax })),
    ).toMatchObject({
      ok: true,
    });
    const pastMax = new Date(Date.parse(atMax) + 1).toISOString();
    expectRejected(
      snapshot(everyKind(), { expiresAt: pastMax }),
      "expiresAt must follow capturedAt",
    );
    expectRejected(
      snapshot(everyKind(), { expiresAt: CAPTURED_AT }),
      "expiresAt must follow capturedAt",
    );
  });

  it("accepts an optional remote digest and rejects a malformed one", () => {
    expect(
      validateGitChangeSnapshotResult(snapshot(everyKind(), { remoteDigest: hex64("f") })),
    ).toMatchObject({ ok: true });
    expectRejected(snapshot(everyKind(), { remoteDigest: "sha256:abc" }), "remoteDigest");
  });
});

describe("validateGitChangeSnapshotResult — bounds", () => {
  it("accepts limits at the ceiling and rejects one past it or at zero", () => {
    const ceiling = GIT_CHANGE_SNAPSHOT_LIMIT_CEILINGS;
    expect(validateGitChangeSnapshotResult(snapshot(everyKind(), {}, ceiling))).toMatchObject({
      ok: true,
    });
    for (const key of Object.keys(ceiling) as (keyof GitChangeSnapshotLimits)[]) {
      expectRejected(
        snapshot(everyKind(), {}, { ...ceiling, [key]: ceiling[key] + 1 }),
        `limits.${key}`,
      );
      expectRejected(snapshot(everyKind(), {}, { ...ceiling, [key]: 0 }), `limits.${key}`);
    }
    expectRejected(
      snapshot(everyKind(), {}, { ...ceiling, maxPatchBytes: ceiling.maxTotalBytes + 1 }),
      "limits.maxPatchBytes",
    );
    expectRejected(
      snapshot(
        everyKind(),
        {},
        { ...GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS, maxPatchBytes: 4096, maxTotalBytes: 2048 },
      ),
      "must not exceed limits.maxTotalBytes",
    );
  });

  it("bounds entries by maxFiles, hunks by maxHunksPerFile and bytes by maxTotalBytes", () => {
    const limits = { ...GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS, maxFiles: 2, maxHunksPerFile: 1 };
    const two = [textual("add", "1"), textual("add", "2")];
    expect(validateGitChangeSnapshotResult(snapshot(two, {}, limits))).toMatchObject({ ok: true });
    expectRejected(
      snapshot([...two, textual("add", "3")], {}, limits),
      "entries exceeds limits.maxFiles",
    );
    const twoHunks = textual("modify", "4", {
      hunks: [hunk("x"), hunk("y")],
      additions: 2,
      deletions: 2,
    });
    expectRejected(snapshot([twoHunks], {}, limits), "hunks exceeds limits.maxHunksPerFile");
    const base = snapshot(two, {}, limits);
    const completeness = base.completeness as Record<string, unknown>;
    expectRejected(
      { ...base, completeness: { ...completeness, bytes: limits.maxTotalBytes + 1 } },
      "completeness.bytes must not exceed",
    );
  });

  it("holds similarity to an integer percentage", () => {
    expect(
      validateGitChangeSnapshotResult(snapshot([paired("rename", "1", { similarity: 100 })])),
    ).toMatchObject({ ok: true });
    expectRejected(snapshot([paired("rename", "1", { similarity: 101 })]), "similarity");
    expectRejected(snapshot([paired("rename", "1", { similarity: 99.5 })]), "similarity");
    expectRejected(snapshot([paired("copy", "1", { similarity: -1 })]), "similarity");
  });
});

describe("validateGitChangeSnapshotResult — union members", () => {
  it("requires rename and copy pairing and refuses it on plain entries", () => {
    expectRejected(
      snapshot([paired("rename", "1", { oldPathDigest: undefined })]),
      "oldPathDigest",
    );
    expectRejected(snapshot([paired("copy", "1", { similarity: undefined })]), "similarity");
    expectRejected(
      snapshot([paired("rename", "1", { oldPathDigest: hex64("p1") })]),
      "oldPathDigest must differ from pathDigest",
    );
    expectRejected(
      snapshot([textual("add", "2", { oldPathDigest: hex64("z"), similarity: 50 })]),
      "is not allowed",
    );
  });

  it("requires binary and submodule entries to be content-free and self-describing", () => {
    expectRejected(snapshot([contentless("binary", "1", { hunks: [hunk("h")] })]), "no hunks");
    expectRejected(snapshot([contentless("binary", "1", { additions: 1 })]), "no hunks");
    expectRejected(
      snapshot([contentless("submodule", "1", { omission: "binary" })]),
      "omission must be submodule",
    );
    expectRejected(
      snapshot([contentless("binary", "1", { omission: undefined })]),
      "omission must be binary",
    );
    expectRejected(
      snapshot([contentless("submodule", "1", { change: "typechange" })]),
      "change must be",
    );
    const movedBinary = contentless("binary", "2", {
      change: "rename",
      oldPathDigest: hex64("q"),
      similarity: 100,
    });
    expect(validateGitChangeSnapshotResult(snapshot([movedBinary]))).toMatchObject({ ok: true });
    expectRejected(snapshot([contentless("binary", "2", { change: "rename" })]), "oldPathDigest");
    expectRejected(
      snapshot([contentless("submodule", "3", { oldPathDigest: hex64("q"), similarity: 1 })]),
      "must not carry oldPathDigest",
    );
  });

  it("keeps a mode change free of statistics, hunks and omissions", () => {
    expectRejected(
      snapshot([contentless("mode-change", "1", { omission: "byte-cap" })]),
      "mode change",
    );
    expectRejected(snapshot([contentless("mode-change", "1", { truncated: true })]), "no hunks");
    expectRejected(
      snapshot([contentless("mode-change", "1", { change: "modify" })]),
      "change is not allowed",
    );
  });

  it("ties a textual omission to its trace", () => {
    expectRejected(
      snapshot([textual("modify", "1", { truncated: true })]),
      "requires an omission reason",
    );
    expectRejected(
      snapshot([textual("modify", "1", { omittedHunks: 2 })]),
      "requires an omission reason",
    );
    expectRejected(snapshot([textual("modify", "1", { omission: "byte-cap" })]), "left no trace");
    expectRejected(
      snapshot([textual("modify", "1", { omission: "generated" })]),
      "must be truncated",
    );
    expectRejected(
      snapshot([textual("modify", "1", { omission: "binary", truncated: true })]),
      "not valid for a textual",
    );
    expectRejected(
      snapshot([textual("modify", "1", { omission: "file-cap", truncated: true })]),
      "not valid for a textual",
    );
  });

  it("requires unique evidence ids", () => {
    const duplicate = textual("modify", "2", { evidenceId: hex64("e1") });
    expectRejected(snapshot([textual("add", "1"), duplicate]), "unique evidenceIds");
  });
});

describe("validateGitChangeSnapshotResult — hostile inputs", () => {
  it("rejects non-objects, class instances and prototype-carried fields", () => {
    expect(reasonsOf(null)).toEqual(["snapshot must be an object"]);
    expect(reasonsOf([])).toEqual(["snapshot must be an object"]);
    expect(reasonsOf("complete")).toEqual(["snapshot must be an object"]);
    class Forged {
      public readonly outcome = "complete";
    }
    expect(reasonsOf(new Forged())).toEqual(["snapshot must be a plain object"]);
    const inherited = Object.create({ outcome: "complete" }) as Record<string, unknown>;
    expect(reasonsOf(inherited)).toEqual(["snapshot must be a plain object"]);
    const prototypeOutcome = Object.create(null) as Record<string, unknown>;
    expect(reasonsOf(prototypeOutcome)).toEqual(["outcome must be a snapshot outcome"]);
  });

  it("closes the key set on own names, non-enumerable names and symbols", () => {
    expectRejected(
      snapshot(everyKind(), { path: "/Users/x/repo" }),
      "snapshot.path is not allowed",
    );
    const hidden = snapshot();
    Object.defineProperty(hidden, "rawDiff", { value: "+secret", enumerable: false });
    expectRejected(hidden, "snapshot.rawDiff is not allowed");
    const symbolled = snapshot();
    Object.defineProperty(symbolled, Symbol("leak"), { value: 1, enumerable: true });
    expectRejected(symbolled, "symbol-keyed");
    expectRejected(
      snapshot([textual("add", "1", { path: "src/app.ts" })]),
      "entries[0].path is not allowed",
    );
    expectRejected(
      snapshot([textual("add", "1", { hunks: [{ ...hunk("h"), text: "+x" }] })]),
      "hunks[0].text is not allowed",
    );
  });

  it("refuses refs that could read as options, traversals or refspecs", () => {
    for (const ref of [
      "--upload-pack=/bin/sh",
      "main..dev",
      "a/../b",
      "refs/heads/x\0y",
      "",
      " main",
    ]) {
      expectRejected(snapshot(everyKind(), { headRef: ref }), "headRef must be a safe git ref");
    }
  });

  it("refuses malformed identities: shas, modes, digests, counts", () => {
    expectRejected(snapshot(everyKind(), { baseSha: "A".repeat(40) }), "baseSha");
    expectRejected(snapshot(everyKind(), { mergeBaseSha: "HEAD" }), "mergeBaseSha");
    expectRejected(snapshot([textual("add", "1", { newMode: "12345" })]), "newMode");
    expectRejected(snapshot([textual("add", "1", { oldObjectId: "0".repeat(39) })]), "oldObjectId");
    expectRejected(snapshot([textual("add", "1", { pathDigest: "src/app.ts" })]), "pathDigest");
    expectRejected(snapshot([textual("add", "1", { additions: -1 })]), "additions");
    expectRejected(
      snapshot([textual("add", "1", { hunks: [{ ...hunk("h"), oldStart: 1.5 }] })]),
      "oldStart",
    );
    expectRejected(snapshot(everyKind(), { repositoryId: "repo with spaces" }), "repositoryId");
    expectRejected(snapshot(everyKind(), { capturedAt: "2026-09-04T10:00:00" }), "capturedAt");
    expectRejected(snapshot(everyKind(), { schemaVersion: "1" }), "schemaVersion invalid");
    expectRejected(
      snapshot(everyKind(), { snapshotDigest: hex64("d").slice(1) }),
      "snapshotDigest",
    );
    expectRejected(
      snapshot(everyKind(), {
        localDivergence: { stagedCount: 0, unstagedCount: 0, untrackedCount: 0 },
      }),
      "localDivergence.conflictedCount",
    );
  });

  it("reports every violation, not only the first", () => {
    const reasons = reasonsOf(
      snapshot(everyKind(), { baseSha: "x", headRef: "-bad", entries: "none" }),
    );
    expect(reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("validateGitChangeSnapshotResult — unavailable and failed", () => {
  function unavailable(reason: string, overrides: Overrides = {}): Record<string, unknown> {
    return {
      schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
      repositoryId: "repo_0123456789abcdef",
      baseRef: "main",
      headRef: "feat/x",
      capturedAt: CAPTURED_AT,
      outcome: "unavailable",
      reason,
      ...overrides,
    };
  }

  it("accepts each unavailable reason in its consistent shape", () => {
    const shapes: readonly Record<string, unknown>[] = [
      unavailable("invalid-ref", { headRef: undefined }),
      unavailable("missing-ref", { baseSha: sha("1") }),
      unavailable("unsupported-object-format"),
      unavailable("revision-mismatch", {
        baseSha: sha("1"),
        headSha: sha("2"),
        mergeBaseSha: sha("1"),
      }),
      unavailable("head-mismatch", {
        baseSha: sha("1"),
        headSha: sha("2"),
        mergeBaseSha: sha("1"),
      }),
      unavailable("identical-revisions", { baseSha: sha("1"), headSha: sha("1") }),
      unavailable("no-merge-base", { baseSha: sha("1"), headSha: sha("2") }),
      unavailable("head-behind-base", {
        baseSha: sha("1"),
        headSha: sha("2"),
        mergeBaseSha: sha("2"),
      }),
    ];
    for (const shape of shapes) {
      expect(validateGitChangeSnapshotResult(shape), JSON.stringify(shape)).toMatchObject({
        ok: true,
      });
    }
    expect([...GIT_CHANGE_SNAPSHOT_UNAVAILABLE_REASONS]).toHaveLength(shapes.length);
  });

  it("rejects an unavailable reason whose revisions contradict it", () => {
    expectRejected(
      unavailable("invalid-ref", { baseSha: sha("1"), headSha: sha("2") }),
      "resolves no revisions",
    );
    expectRejected(
      unavailable("missing-ref", { baseSha: sha("1"), headSha: sha("2") }),
      "leaves a ref unresolved",
    );
    expectRejected(
      unavailable("missing-ref", { headRef: undefined }),
      "missing-ref requires both refs",
    );
    expectRejected(
      unavailable("identical-revisions", { baseSha: sha("1"), headSha: sha("2") }),
      "to equal headSha",
    );
    expectRejected(unavailable("identical-revisions"), "requires baseSha and headSha");
    expectRejected(
      unavailable("no-merge-base", {
        baseSha: sha("1"),
        headSha: sha("2"),
        mergeBaseSha: sha("3"),
      }),
      "mergeBaseSha is not allowed",
    );
    expectRejected(
      unavailable("head-behind-base", {
        baseSha: sha("1"),
        headSha: sha("2"),
        mergeBaseSha: sha("3"),
      }),
      "mergeBaseSha to equal headSha",
    );
    expectRejected(
      unavailable("stale", { baseSha: sha("1"), headSha: sha("2") }),
      "unavailable reason",
    );
    expectRejected(
      unavailable("invalid-ref", { headRef: "--exec=x" }),
      "headRef must be a safe git ref",
    );
    expectRejected(unavailable("invalid-ref", { entries: [] }), "snapshot.entries is not allowed");
  });

  it("accepts every failure reason and rejects a malformed error kind", () => {
    for (const reason of GIT_CHANGE_SNAPSHOT_FAILURE_REASONS) {
      const failed = {
        schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
        repositoryId: "repo_0123456789abcdef",
        baseRef: "main",
        headRef: "feat/x",
        capturedAt: CAPTURED_AT,
        outcome: "failed",
        reason,
        errorKind: "git-error",
      };
      expect(validateGitChangeSnapshotResult(failed)).toMatchObject({ ok: true });
      expectRejected({ ...failed, errorKind: "fatal: /Users/x\n" }, "errorKind");
      expectRejected({ ...failed, errorKind: "" }, "errorKind");
      expectRejected({ ...failed, reason: "exploded" }, "failure reason");
      expectRejected({ ...failed, stderr: "fatal" }, "snapshot.stderr is not allowed");
    }
  });
});

describe("limits, digests and references", () => {
  it("resolves limits: defaults, ceilings, non-conforming overrides and the per-file fold", () => {
    expect(resolveGitChangeSnapshotLimits()).toEqual(GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS);
    expect(resolveGitChangeSnapshotLimits({ maxFiles: 1 }).maxFiles).toBe(1);
    expect(resolveGitChangeSnapshotLimits({ maxFiles: 1e9 }).maxFiles).toBe(
      GIT_CHANGE_SNAPSHOT_LIMIT_CEILINGS.maxFiles,
    );
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", null, undefined]) {
      expect(resolveGitChangeSnapshotLimits({ maxHunksPerFile: bad }).maxHunksPerFile).toBe(
        GIT_CHANGE_SNAPSHOT_DEFAULT_LIMITS.maxHunksPerFile,
      );
    }
    const folded = resolveGitChangeSnapshotLimits({ maxPatchBytes: 8192, maxTotalBytes: 1024 });
    expect(folded).toMatchObject({ maxPatchBytes: 1024, maxTotalBytes: 1024 });
  });

  it("digests only the durable fields, in a fixed projection", () => {
    const captured = snapshot(everyKind(), {
      remoteDigest: hex64("r"),
    }) as unknown as GitChangeSnapshot;
    const fields = gitChangeSnapshotDigestFields(captured);
    expect(Object.keys(fields)).toEqual([
      "schemaVersion",
      "remoteDigest",
      "baseRef",
      "baseSha",
      "headRef",
      "headSha",
      "mergeBaseSha",
      "limits",
      "completeness",
      "entries",
    ]);
    const withoutRemote = snapshot() as unknown as GitChangeSnapshot;
    expect("remoteDigest" in gitChangeSnapshotDigestFields(withoutRemote)).toBe(false);
    // Epic correction 6: canonical remote identity binds clones; a local locator cannot do so.
    expect(fields).not.toHaveProperty("repositoryId");
    expect(
      gitChangeSnapshotDigestFields({ ...captured, repositoryId: "repo_another_clone" }),
    ).toEqual(fields);
    expect(gitChangeSnapshotDigestFields(withoutRemote).repositoryId).toBe(
      withoutRemote.repositoryId,
    );
    expect(gitChangeSnapshotEntryIdentityFields(textual("add", "1"))).toEqual({
      kind: "add",
      pathDigest: hex64("p1"),
      oldPathDigest: null,
      oldMode: "000000",
      newMode: "100644",
      oldObjectId: ZERO_ID,
      newObjectId: sha("b1"),
    });
    expect(gitChangeSnapshotEntryIdentityFields(paired("copy", "2")).oldPathDigest).toBe(
      hex64("o2"),
    );
  });

  it("rolls omissions up per reason in vocabulary order", () => {
    const entries = [
      textual("add", "1", { truncated: true, omission: "generated" }),
      contentless("binary", "2"),
      textual("modify", "3", { omittedHunks: 2, omission: "byte-cap" }),
      textual("modify", "4", { truncated: true, omittedHunks: 1, omission: "byte-cap" }),
    ];
    const completeness = summarizeGitChangeSnapshotCompleteness({
      entries,
      totalFiles: 6,
      bytes: 10,
    });
    expect(completeness).toEqual({
      totalFiles: 6,
      files: 4,
      hunks: 3,
      bytes: 10,
      omittedFiles: 2,
      omittedHunks: 3,
      truncatedFiles: 2,
      kinds: {
        add: 1,
        modify: 2,
        delete: 0,
        rename: 0,
        copy: 0,
        "mode-change": 0,
        binary: 1,
        submodule: 0,
      },
      omissions: [
        { reason: "byte-cap", files: 2, hunks: 3 },
        { reason: "file-cap", files: 2, hunks: 0 },
        { reason: "binary", files: 1, hunks: 0 },
        { reason: "generated", files: 1, hunks: 0 },
      ],
    });
    expect(completeness.omissions.map((omission) => omission.reason)).toEqual(
      GIT_CHANGE_SNAPSHOT_OMISSION_REASONS.filter((reason) => reason !== "submodule"),
    );
  });

  it("recognises only the opaque registry reference shape", () => {
    expect(isGitChangeSnapshotReference(`gcs_${"a1".repeat(16)}`)).toBe(true);
    expect(isGitChangeSnapshotReference(`gcs_${"A1".repeat(16)}`)).toBe(false);
    expect(isGitChangeSnapshotReference(`gcs_${"a1".repeat(15)}`)).toBe(false);
    expect(isGitChangeSnapshotReference("gcs_/Users/x/repo")).toBe(false);
    expect(isGitChangeSnapshotReference(42)).toBe(false);
  });
});

// #3386 AC11 (this file's counterpart to verified-commit.test.ts's symmetric assertion): the
// immutable merge-base-to-head PR snapshot this module owns and #3397's interactive runtime diff
// receipt (VerifiedCommitResult) are two distinct contracts with disjoint closed-key validators.
// The fixture below is typed against the actual production `VerifiedCommitResult` (imported, not
// hand-restated) and proven well-formed by that module's own `isVerifiedCommitResult` guard before
// being handed to this module's validator, so the negative result below cannot be an artifact of
// an already-malformed fixture.
describe("#3386 AC11 — validateGitChangeSnapshotResult rejects a well-formed VerifiedCommitResult", () => {
  const verifiedCommitResult: VerifiedCommitResult = {
    schemaVersion: "1",
    proposalId: "commit-1",
    runId: "run-1",
    envelopeDigest: hex64("envelope"),
    runtimeAuthorityDigest: hex64("authority"),
    workspaceDigest: hex64("workspace"),
    repositoryDigest: hex64("repository"),
    baseSha: sha("base"),
    parentSha: sha("parent"),
    stagedTreeDigest: hex64("staged-tree"),
    verificationEvidenceId: "verification-1",
    messageDigest: hex64("message"),
    status: "succeeded",
    reason: "completed",
    headSha: sha("head"),
    committedTreeDigest: hex64("staged-tree"),
    recordedAt: CAPTURED_AT,
  };

  it("is itself a well-formed VerifiedCommitResult (the fixture's own precondition)", () => {
    expect(isVerifiedCommitResult(verifiedCommitResult)).toBe(true);
  });

  it("rejects a well-formed VerifiedCommitResult as a GitChangeSnapshot", () => {
    expect(validateGitChangeSnapshotResult(verifiedCommitResult)).toMatchObject({ ok: false });
  });
});
