// source-routing-validation.test.ts — pure validators for #263 source-routing controls.
// The validators reject inputs that would silently broaden retrieval beyond a capsule's
// declared sources. Every rejection must be observable as a SourceRoutingValidationError
// with a stable, machine-readable code so the future UI (#197/#198) can surface it.

import type {
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import {
  validateAlwaysQuery,
  validateGlobPatterns,
  validateRoutingInstructionsScope,
  validateSourceRoutingForCapsule,
  SourceRoutingValidationError,
  type SourceRoutingValidationCode,
} from "./source-routing-validation.js";

function source(id: string, overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: id as KnowledgeSourceId,
    displayName: `Source ${id}`,
    tags: [],
    scope: { kind: "folder", rootPath: "/srv/docs", recursive: true },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function capsule(overrides: Partial<KnowledgeCapsule> = {}): KnowledgeCapsule {
  return {
    id: "cap-x" as KnowledgeCapsuleId,
    displayName: "X",
    tags: [],
    sourceIds: [],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "require-citations",
    embeddingModelIdentity: {
      provider: "openai",
      modelId: "text-embedding-3-small",
      vectorDimensions: 1536,
      vectorMetric: "cosine",
    },
    lifecycleState: "ready",
    storageReference: "x/cap",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function expectRejection(fn: () => void, code: SourceRoutingValidationCode): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof SourceRoutingValidationError)) {
      throw new Error(`expected SourceRoutingValidationError, got ${String(error)}`, {
        cause: error,
      });
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected SourceRoutingValidationError(${code}) but no error was thrown`);
}

describe("validateAlwaysQuery", () => {
  it("accepts alwaysQuery=true on a ready capsule with at least one source", () => {
    const cap = capsule({
      alwaysQuery: true,
      lifecycleState: "ready",
      sourceIds: ["s-1" as KnowledgeSourceId],
    });
    expect(() => {
      validateAlwaysQuery(cap, [source("s-1")]);
    }).not.toThrow();
  });

  it("accepts a capsule with alwaysQuery omitted regardless of sources/state", () => {
    expect(() => {
      validateAlwaysQuery(capsule(), []);
    }).not.toThrow();
    expect(() => {
      validateAlwaysQuery(capsule({ alwaysQuery: false }), []);
    }).not.toThrow();
  });

  it("rejects alwaysQuery=true on an empty capsule (would query empty pool)", () => {
    expectRejection(() => {
      validateAlwaysQuery(capsule({ alwaysQuery: true, sourceIds: [] }), []);
    }, "always-query-without-sources");
  });

  it("rejects alwaysQuery=true while capsule is still indexing or in error", () => {
    expectRejection(() => {
      validateAlwaysQuery(
        capsule({
          alwaysQuery: true,
          lifecycleState: "indexing",
          sourceIds: ["s-1" as KnowledgeSourceId],
        }),
        [source("s-1")],
      );
    }, "always-query-capsule-not-ready");
    expectRejection(() => {
      validateAlwaysQuery(
        capsule({
          alwaysQuery: true,
          lifecycleState: "error",
          sourceIds: ["s-1" as KnowledgeSourceId],
        }),
        [source("s-1")],
      );
    }, "always-query-capsule-not-ready");
  });

  it("rejects when capsule.sourceIds disagrees with the source list (defence-in-depth)", () => {
    expectRejection(() => {
      validateAlwaysQuery(
        capsule({ alwaysQuery: true, sourceIds: ["s-1" as KnowledgeSourceId] }),
        [],
      );
    }, "always-query-source-list-mismatch");
  });
});

describe("validateRoutingInstructionsScope", () => {
  it("accepts instructions with no @tokens at all", () => {
    expect(() => {
      validateRoutingInstructionsScope("prefer the most recent files", [source("s-1")]);
    }).not.toThrow();
  });

  it("accepts @tokens that all resolve to a known source id", () => {
    expect(() => {
      validateRoutingInstructionsScope("prefer @s-1 over @s-2", [source("s-1"), source("s-2")]);
    }).not.toThrow();
  });

  it("rejects @tokens that do not match any source id in the capsule", () => {
    expectRejection(() => {
      validateRoutingInstructionsScope("use @ghost when available", [source("s-1")]);
    }, "unknown-source-token");
  });

  it("accepts undefined instructions as a no-op (validator is permissive on absence)", () => {
    // The validator is permissive on undefined — caller decides whether instructions are
    // mandatory. We assert the permissive default here so the no-op case is documented.
    expect(() => {
      validateRoutingInstructionsScope(undefined, [source("s-1")]);
    }).not.toThrow();
  });

  it("rejects an empty-string instructions field (caller should omit, not blank)", () => {
    expectRejection(() => {
      validateRoutingInstructionsScope("", [source("s-1")]);
    }, "instructions-empty");
    expectRejection(() => {
      validateRoutingInstructionsScope("   \n\t  ", [source("s-1")]);
    }, "instructions-empty");
  });
});

describe("validateGlobPatterns", () => {
  it("accepts a scope with no globs", () => {
    expect(() => {
      validateGlobPatterns({ kind: "folder", rootPath: "/srv/docs", recursive: true });
    }).not.toThrow();
  });

  it("accepts non-overlapping include and exclude globs", () => {
    expect(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["**/*.md"],
        excludeGlobs: ["**/draft/**"],
      });
    }).not.toThrow();
  });

  it("rejects an empty includeGlobs array (caller must omit instead of supply [])", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: [],
      });
    }, "include-globs-empty-array");
  });

  it("rejects an empty excludeGlobs array (same rationale)", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        excludeGlobs: [],
      });
    }, "exclude-globs-empty-array");
  });

  it("rejects duplicate patterns inside includeGlobs", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["**/*.md", "**/*.md"],
      });
    }, "duplicate-glob");
  });

  it("rejects patterns containing `..` (would escape the source root)", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["../escape/**"],
      });
    }, "glob-path-escape");
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        excludeGlobs: ["sub/../../other"],
      });
    }, "glob-path-escape");
  });

  it("rejects an exclude pattern that is byte-identical to its include counterpart (cancels)", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["**/*.md"],
        excludeGlobs: ["**/*.md"],
      });
    }, "exclude-cancels-include");
  });

  it("rejects a leading-slash absolute pattern (caller must keep paths source-root-relative)", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["/etc/passwd"],
      });
    }, "absolute-glob");
  });

  it("rejects Windows drive-absolute patterns (C:\\** and C:/** both caught)", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["C:\\**"],
      });
    }, "absolute-glob");
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["D:/**"],
      });
    }, "absolute-glob");
  });

  it("rejects UNC paths (\\\\server\\share\\** caught)", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["\\\\server\\share\\**"],
      });
    }, "absolute-glob");
  });

  it("rejects backslash-separated .. traversal (Windows path escape)", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["sub\\..\\other"],
      });
    }, "glob-path-escape");
  });

  it("applies the same rules to the 'repository' scope variant", () => {
    expectRejection(() => {
      validateGlobPatterns({
        kind: "repository",
        repositoryRoot: "/repo",
        includeGlobs: [],
      });
    }, "include-globs-empty-array");
  });

  it("is a no-op for the 'files' scope variant (it has no globs)", () => {
    expect(() => {
      validateGlobPatterns({ kind: "files", rootPath: "/srv", files: ["a.md"] });
    }).not.toThrow();
  });
});

describe("validateSourceRoutingForCapsule", () => {
  it("composes all individual validators and reports the first failure", () => {
    expectRejection(() => {
      validateSourceRoutingForCapsule(
        capsule({
          alwaysQuery: true,
          sourceIds: [],
          sourceRoutingInstructions: "use @ghost",
        }),
        [],
      );
    }, "always-query-without-sources");
  });

  it("passes when every validator passes", () => {
    const s1 = source("s-1", {
      scope: {
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["**/*.md"],
      },
    });
    expect(() => {
      validateSourceRoutingForCapsule(
        capsule({
          sourceIds: [s1.id],
          alwaysQuery: true,
          sourceRoutingInstructions: "prefer @s-1",
        }),
        [s1],
      );
    }).not.toThrow();
  });

  it("validates globs of every source in the capsule", () => {
    const broken = source("s-2", {
      scope: {
        kind: "folder",
        rootPath: "/srv/docs",
        recursive: true,
        includeGlobs: ["../escape/**"],
      },
    });
    expectRejection(() => {
      validateSourceRoutingForCapsule(capsule({ sourceIds: [broken.id] }), [broken]);
    }, "glob-path-escape");
  });
});
