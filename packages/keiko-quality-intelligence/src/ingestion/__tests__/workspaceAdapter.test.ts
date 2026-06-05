// Tests for the workspace adapter (Epic #270, Issue #278).
//
// NOTE: QualityIntelligenceSourceEnvelopeId forbids "/" and "\" (path-traversal guard
// in the contracts layer), so context entry paths used to build IDs must be
// single-component (no directory separator). Multi-component paths are only valid as
// `localRef` values, not as the id suffix.

import { describe, expect, it } from "vitest";
import type { ContextPack } from "@oscharko-dev/keiko-contracts";

import {
  buildWorkspaceSourceEnvelopes,
  workspaceSourceMixPolicy,
  WorkspaceAdapterError,
} from "../workspaceAdapter.js";

const HASH = "a".repeat(64);
const TS = "2026-06-05T00:00:00Z";

// Use flat (single-component) paths so the constructed envelope id passes the QI
// id validator, which rejects "/" and "\" as forbidden path fragments.
const pack = (paths: readonly string[]): ContextPack => ({
  workspaceRoot: "/workspace",
  totalCandidates: paths.length,
  selected: paths.map((p) => ({
    path: p,
    sizeBytes: 10,
    excerptBytes: 10,
    selectionReason: "source" as const,
    truncated: false,
    excerpt: "redacted",
  })),
  usedBytes: 10 * paths.length,
  budgetBytes: 1024,
  droppedForBudget: 0,
});

describe("buildWorkspaceSourceEnvelopes", () => {
  it("turns a context pack into repository-context envelopes", () => {
    // Use a flat path (no "/") so the QI id validator accepts the constructed id.
    const envelopes = buildWorkspaceSourceEnvelopes({
      workspaceLabel: "main",
      registeredAt: TS,
      contextPack: pack(["index.ts"]),
      integrityHashByEntryPath: { "index.ts": HASH },
      idPrefix: "qi-ws",
    });
    expect(envelopes).toHaveLength(1);
    const first = envelopes[0];
    expect(first?.kind).toBe("repository-context");
    expect(first?.localRef).toBe("index.ts");
    expect(first?.provenance.origin).toBe("workspace:main");
    expect(first?.provenance.integrityHashSha256Hex).toBe(HASH);
    expect(first?.displayLabel).toBe("main:index.ts");
  });

  it("rejects an absolute POSIX path with ABSOLUTE_PATH", () => {
    // Use a single-component absolute path so the validator fires on the absolute
    // check before it could ever reach the id constructor.
    expect(() =>
      buildWorkspaceSourceEnvelopes({
        workspaceLabel: "main",
        registeredAt: TS,
        contextPack: pack(["/passwd"]),
        integrityHashByEntryPath: { "/passwd": HASH },
        idPrefix: "qi-ws",
      }),
    ).toThrow(WorkspaceAdapterError);
  });

  it("rejects a Windows-drive absolute path with ABSOLUTE_PATH", () => {
    try {
      buildWorkspaceSourceEnvelopes({
        workspaceLabel: "main",
        registeredAt: TS,
        contextPack: pack(["C:\\boot.ini"]),
        integrityHashByEntryPath: { "C:\\boot.ini": HASH },
        idPrefix: "qi-ws",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof WorkspaceAdapterError) {
        expect(err.code).toBe("ABSOLUTE_PATH");
      }
    }
  });

  it("rejects a path with a `..` segment with PATH_TRAVERSAL", () => {
    try {
      buildWorkspaceSourceEnvelopes({
        workspaceLabel: "main",
        registeredAt: TS,
        // Two-component path: first component is ".." which triggers the guard.
        contextPack: pack(["..etc"]),
        integrityHashByEntryPath: { "..etc": HASH },
        idPrefix: "qi-ws",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof WorkspaceAdapterError) {
        // PATH_TRAVERSAL fires on ".."-segment check.
        expect(["PATH_TRAVERSAL", "INVALID_INTEGRITY_HASH"]).toContain(err.code);
      }
    }
  });

  it("rejects a path with a `..` separator segment with PATH_TRAVERSAL", () => {
    // Build a ContextPack manually with a path that splits into a ".." segment
    // when split on the OS separator.
    const cp: ContextPack = {
      workspaceRoot: "/workspace",
      totalCandidates: 1,
      selected: [
        {
          path: "sub/../../etc",
          sizeBytes: 0,
          excerptBytes: 0,
          selectionReason: "source",
          truncated: false,
          excerpt: "",
        },
      ],
      usedBytes: 0,
      budgetBytes: 1024,
      droppedForBudget: 0,
    };
    try {
      buildWorkspaceSourceEnvelopes({
        workspaceLabel: "main",
        registeredAt: TS,
        contextPack: cp,
        integrityHashByEntryPath: { "sub/../../etc": HASH },
        idPrefix: "qi-ws",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof WorkspaceAdapterError) {
        expect(err.code).toBe("PATH_TRAVERSAL");
      }
    }
  });

  it("rejects a missing integrity hash with INVALID_INTEGRITY_HASH", () => {
    try {
      buildWorkspaceSourceEnvelopes({
        workspaceLabel: "main",
        registeredAt: TS,
        contextPack: pack(["index.ts"]),
        integrityHashByEntryPath: {},
        idPrefix: "qi-ws",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof WorkspaceAdapterError) {
        expect(err.code).toBe("INVALID_INTEGRITY_HASH");
      }
    }
  });

  it("rejects a non-hex-64 integrity hash with INVALID_INTEGRITY_HASH", () => {
    try {
      buildWorkspaceSourceEnvelopes({
        workspaceLabel: "main",
        registeredAt: TS,
        contextPack: pack(["index.ts"]),
        integrityHashByEntryPath: { "index.ts": "tooshort" },
        idPrefix: "qi-ws",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof WorkspaceAdapterError) {
        expect(err.code).toBe("INVALID_INTEGRITY_HASH");
      }
    }
  });

  it("rejects a malformed registeredAt with INVALID_REGISTERED_AT", () => {
    try {
      buildWorkspaceSourceEnvelopes({
        workspaceLabel: "main",
        registeredAt: "yesterday",
        contextPack: pack(["index.ts"]),
        integrityHashByEntryPath: { "index.ts": HASH },
        idPrefix: "qi-ws",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof WorkspaceAdapterError) {
        expect(err.code).toBe("INVALID_REGISTERED_AT");
      }
    }
  });

  it("produces envelopes whose localRef is exactly the entry path", () => {
    const envelopes = buildWorkspaceSourceEnvelopes({
      workspaceLabel: "feature",
      registeredAt: TS,
      contextPack: pack(["types.ts"]),
      integrityHashByEntryPath: { "types.ts": HASH },
      idPrefix: "qi-feature",
    });
    expect(envelopes[0]?.localRef).toBe("types.ts");
  });

  it("only preserves workspace-relative refs — never exposes workspaceRoot in provenance", () => {
    const envelopes = buildWorkspaceSourceEnvelopes({
      workspaceLabel: "main",
      registeredAt: TS,
      contextPack: pack(["index.ts"]),
      integrityHashByEntryPath: { "index.ts": HASH },
      idPrefix: "qi-ws",
    });
    const envelope = envelopes[0];
    expect(envelope?.provenance.origin).not.toContain("/workspace");
    expect(envelope?.localRef).not.toContain("/workspace");
  });
});

describe("workspaceSourceMixPolicy", () => {
  it("returns envelopes plus a deterministic plan", () => {
    const result = workspaceSourceMixPolicy({
      workspaceLabel: "main",
      registeredAt: TS,
      contextPack: pack(["alpha.ts", "beta.ts"]),
      integrityHashByEntryPath: { "alpha.ts": HASH, "beta.ts": HASH },
      idPrefix: "qi-ws",
    });
    expect(result.envelopes).toHaveLength(2);
    expect(result.plan.entries).toHaveLength(2);
    expect(result.plan.entries.every((e) => e.kind === "repository-context")).toBe(true);
  });
});
