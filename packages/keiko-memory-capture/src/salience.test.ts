import { describe, expect, it } from "vitest";

import type {
  MemoryId,
  MemoryProposalId,
  ProjectId,
  UserId,
} from "@oscharko-dev/keiko-contracts/memory";

import {
  extractSalientMemories,
  normalizeForDedup,
  parseSalienceItems,
  SALIENCE_SYSTEM_PROMPT,
} from "./salience.js";
import type { CaptureContext, CaptureOutcome, SalienceDeps, SalienceInput } from "./types.js";

const FIXED_NOW = 1_700_000_000_000;

function baseContext(overrides: Partial<CaptureContext> = {}): CaptureContext {
  return {
    userId: "u-1" as UserId,
    nowMs: 0,
    newMemoryId: (): MemoryId => "ignored" as MemoryId,
    newProposalId: (): MemoryProposalId => "ignored" as MemoryProposalId,
    ...overrides,
  };
}

function deps(model: string | (() => Promise<string>)): SalienceDeps {
  let memCounter = 0;
  let proCounter = 0;
  return {
    callModel:
      typeof model === "string"
        ? (): Promise<string> => Promise.resolve(model)
        : (): Promise<string> => model(),
    now: (): number => FIXED_NOW,
    newMemoryId: (): MemoryId => `m-${String(++memCounter)}` as MemoryId,
    newProposalId: (): MemoryProposalId => `p-${String(++proCounter)}` as MemoryProposalId,
  };
}

function input(overrides: Partial<SalienceInput> = {}): SalienceInput {
  return {
    userText:
      "I'm building a fintech app called Atlas in Rust with PostgreSQL, my team is in Berlin",
    existingBodies: [],
    context: baseContext({ projectId: "proj-atlas" as ProjectId }),
    ...overrides,
  };
}

function candidatesOnly(outcomes: readonly CaptureOutcome[]): readonly CaptureOutcome[] {
  return outcomes.filter((outcome) => outcome.kind === "candidate");
}

const ATLAS_FACTS = JSON.stringify([
  {
    body: "The user is building a fintech app called Atlas.",
    type: "fact",
    confidence: 0.7,
    scope: "project",
    source: "user",
    tags: ["atlas", "fintech"],
  },
  {
    body: "Atlas is written in Rust.",
    type: "fact",
    confidence: 0.8,
    scope: "project",
    source: "user",
    tags: ["rust"],
  },
  {
    body: "Atlas uses PostgreSQL.",
    type: "fact",
    confidence: 0.8,
    scope: "project",
    source: "user",
    tags: ["postgresql"],
  },
  {
    body: "The user's team is in Berlin.",
    type: "fact",
    confidence: 0.6,
    scope: "user",
    source: "user",
    tags: ["team", "berlin"],
  },
]);

describe("SALIENCE_SYSTEM_PROMPT", () => {
  it("instructs JSON-array-only output and excludes assistant claims", () => {
    expect(SALIENCE_SYSTEM_PROMPT).toContain("JSON array");
    expect(SALIENCE_SYSTEM_PROMPT).toContain("assistant");
    expect(SALIENCE_SYSTEM_PROMPT).toContain('"source": "user"');
  });

  it("instructs the model to preserve the user's source language", () => {
    expect(SALIENCE_SYSTEM_PROMPT).toContain("same language");
    expect(SALIENCE_SYSTEM_PROMPT).toContain("Der Nutzer heißt Paul.");
  });
});

describe("extractSalientMemories", () => {
  it("captures the obvious Atlas/Rust/PostgreSQL/Berlin facts as proposed candidates", async () => {
    const result = await extractSalientMemories(input(), deps(ATLAS_FACTS));
    const candidates = candidatesOnly(result);
    expect(candidates).toHaveLength(4);
    const bodies = candidates.map((c) => (c.kind === "candidate" ? c.proposal.body : ""));
    expect(bodies.join(" | ")).toContain("Atlas");
    expect(bodies.join(" | ")).toContain("Rust");
    expect(bodies.join(" | ")).toContain("PostgreSQL");
    expect(bodies.join(" | ")).toContain("Berlin");
    for (const candidate of candidates) {
      if (candidate.kind !== "candidate") continue;
      expect(candidate.proposal.initialStatus).toBe("proposed");
      expect(candidate.proposal.provenance.confidence).toBeGreaterThanOrEqual(0.2);
      expect(candidate.proposal.provenance.confidence).toBeLessThanOrEqual(0.9);
      expect(candidate.proposal.provenance.sourceKind).toBe("system-default");
    }
  });

  it("preserves German model output for German user facts", async () => {
    const model = JSON.stringify([
      {
        body: "Der Nutzer baut Atlas in Rust mit PostgreSQL.",
        type: "fact",
        confidence: 0.8,
        scope: "project",
        source: "user",
        tags: ["atlas", "rust", "postgresql"],
      },
    ]);
    const result = await extractSalientMemories(
      input({ userText: "Wir bauen Atlas in Rust mit PostgreSQL." }),
      deps(model),
    );
    const candidates = candidatesOnly(result);
    expect(candidates).toHaveLength(1);
    if (candidates[0]?.kind === "candidate") {
      expect(candidates[0].proposal.body).toBe("Der Nutzer baut Atlas in Rust mit PostgreSQL.");
    }
  });

  it("maps scope hints to the correct MemoryScope kinds", async () => {
    const result = await extractSalientMemories(input(), deps(ATLAS_FACTS));
    const candidates = candidatesOnly(result);
    const projectScoped = candidates.filter(
      (c) => c.kind === "candidate" && c.proposal.scope.kind === "project",
    );
    const userScoped = candidates.filter(
      (c) => c.kind === "candidate" && c.proposal.scope.kind === "user",
    );
    expect(projectScoped).toHaveLength(3);
    expect(userScoped).toHaveLength(1);
  });

  it("wires the salience captureRationale onto provenance", async () => {
    const result = await extractSalientMemories(input(), deps(ATLAS_FACTS));
    const first = candidatesOnly(result)[0];
    expect(first?.kind).toBe("candidate");
    if (first?.kind === "candidate") {
      expect(first.proposal.provenance.captureRationale).toBe(
        "Automatically inferred from conversation (salience capture)",
      );
    }
  });

  it("uses deps clock/ids (deps-authoritative over context)", async () => {
    const result = await extractSalientMemories(input(), deps(ATLAS_FACTS));
    const first = candidatesOnly(result)[0];
    if (first?.kind === "candidate") {
      expect(first.proposal.proposedAt).toBe(FIXED_NOW);
      expect(String(first.proposal.proposalId)).toBe("p-1");
    }
  });

  it("clamps confidence into [0.2, 0.9]", async () => {
    const model = JSON.stringify([
      {
        body: "The user prefers tabs over spaces.",
        type: "preference",
        confidence: 0.02,
        scope: "user",
        source: "user",
        tags: [],
      },
      {
        body: "The user always deploys on Fridays.",
        type: "lesson",
        confidence: 1.5,
        scope: "user",
        source: "user",
        tags: [],
      },
    ]);
    const result = await extractSalientMemories(input(), deps(model));
    const confidences = candidatesOnly(result).map((c) =>
      c.kind === "candidate" ? c.proposal.provenance.confidence : -1,
    );
    expect(confidences).toEqual([0.2, 0.9]);
  });

  it("drops candidate bodies that look like secrets", async () => {
    const apiKey = ["sk-", "abcdefghijklmnopqrstuvwxyz12345"].join("");
    const model = JSON.stringify([
      {
        body: `The user's api_key=${apiKey}.`,
        type: "fact",
        confidence: 0.8,
        scope: "user",
        source: "user",
        tags: [],
      },
      {
        body: "The user works at a startup.",
        type: "fact",
        confidence: 0.7,
        scope: "user",
        source: "user",
        tags: [],
      },
    ]);
    const result = await extractSalientMemories(input(), deps(model));
    const candidates = candidatesOnly(result);
    expect(candidates).toHaveLength(1);
    if (candidates[0]?.kind === "candidate") {
      expect(candidates[0].proposal.body).toContain("startup");
    }
  });

  it("drops assistant-sourced model items with a diagnostic", async () => {
    const diagnostics: unknown[] = [];
    const model = JSON.stringify([
      {
        body: "The assistant said Atlas should use DynamoDB.",
        type: "fact",
        confidence: 0.8,
        scope: "project",
        source: "assistant",
        tags: ["Atlas"],
      },
    ]);
    const result = await extractSalientMemories(input(), {
      ...deps(model),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(result).toEqual([]);
    expect(diagnostics).toEqual([
      { kind: "dropped-model-items", reason: "non-user-source", count: 1 },
      { kind: "zero-candidates-after-filter", rawItemCount: 1, acceptedCount: 0 },
    ]);
  });

  it("drops unknown type and scope labels with diagnostics", async () => {
    const diagnostics: unknown[] = [];
    const model = JSON.stringify([
      {
        body: "The user uses pnpm.",
        type: "mood",
        confidence: 0.8,
        scope: "user",
        source: "user",
        tags: [],
      },
      {
        body: "The user works in Atlas.",
        type: "fact",
        confidence: 0.8,
        scope: "organization",
        source: "user",
        tags: [],
      },
    ]);
    const result = await extractSalientMemories(input(), {
      ...deps(model),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(result).toEqual([]);
    expect(diagnostics).toEqual([
      { kind: "dropped-model-items", reason: "unknown-type", count: 1 },
      { kind: "dropped-model-items", reason: "unknown-scope", count: 1 },
      { kind: "zero-candidates-after-filter", rawItemCount: 2, acceptedCount: 0 },
    ]);
  });

  it("normalizes, deduplicates, and bounds salience tags", async () => {
    const model = JSON.stringify([
      {
        body: "The user prefers pnpm.",
        type: "preference",
        confidence: 0.8,
        scope: "user",
        source: "user",
        tags: [
          " PNPM ",
          "pnpm",
          "Build Tools!",
          "very-long-tag-name-that-will-be-truncated-after-the-limit",
          "",
          "Rust",
          "PostgreSQL",
          "Atlas",
          "Fintech",
          "Berlin",
          "Overflow",
        ],
      },
    ]);
    const result = candidatesOnly(await extractSalientMemories(input(), deps(model)));
    expect(result[0]?.kind).toBe("candidate");
    if (result[0]?.kind === "candidate") {
      expect(result[0].proposal.tags).toEqual([
        "pnpm",
        "build-tools",
        "very-long-tag-name-that-will-be",
        "rust",
        "postgresql",
        "atlas",
        "fintech",
        "berlin",
      ]);
    }
  });

  it("returns [] on malformed (non-JSON prose) model output without throwing", async () => {
    const result = await extractSalientMemories(
      input(),
      deps("Sure! Here are some thoughts, but no JSON."),
    );
    expect(result).toEqual([]);
  });

  it("emits a diagnostic for parse failures or empty model output", async () => {
    const diagnostics: unknown[] = [];
    const result = await extractSalientMemories(input(), {
      ...deps("Sure! Here are some thoughts, but no JSON."),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(result).toEqual([]);
    expect(diagnostics).toEqual([{ kind: "parse-or-empty-output", rawItemCount: 0 }]);
  });

  it("returns [] when the model returns a truncated/broken JSON array", async () => {
    const result = await extractSalientMemories(input(), deps('[{ "body": "x", "type": "fact"'));
    expect(result).toEqual([]);
  });

  it("strips markdown code fences before parsing", async () => {
    const fenced = "```json\n" + ATLAS_FACTS + "\n```";
    const result = await extractSalientMemories(input(), deps(fenced));
    expect(candidatesOnly(result)).toHaveLength(4);
  });

  it("dedups a candidate near-identical to an existing body", async () => {
    const result = await extractSalientMemories(
      input({ existingBodies: ["The user is building a fintech app called Atlas."] }),
      deps(ATLAS_FACTS),
    );
    const candidates = candidatesOnly(result);
    expect(candidates).toHaveLength(3);
    for (const candidate of candidates) {
      if (candidate.kind === "candidate") {
        expect(candidate.proposal.body).not.toBe(
          "The user is building a fintech app called Atlas.",
        );
      }
    }
  });

  it("dedups Unicode text without stripping non-ASCII letters", async () => {
    expect(normalizeForDedup("MÜNCHEN, Straße 東京!")).toBe("münchen straße 東京");
    const result = await extractSalientMemories(
      input({ existingBodies: ["Der Nutzer wohnt in München Straße."] }),
      deps(
        JSON.stringify([
          {
            body: "Der Nutzer wohnt in München, Straße!",
            type: "fact",
            confidence: 0.7,
            scope: "user",
            source: "user",
            tags: [],
          },
        ]),
      ),
    );
    expect(result).toEqual([]);
  });

  it("emits a diagnostic when parsed items all drop after filtering", async () => {
    const diagnostics: unknown[] = [];
    const model = JSON.stringify([
      {
        body: "Atlas uses PostgreSQL.",
        type: "fact",
        confidence: 0.8,
        scope: "project",
        source: "user",
        tags: [],
      },
    ]);
    const result = await extractSalientMemories(input({ context: baseContext() }), {
      ...deps(model),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(result).toEqual([]);
    expect(diagnostics).toEqual([
      { kind: "zero-candidates-after-filter", rawItemCount: 1, acceptedCount: 0 },
    ]);
  });

  it("dedups near-identical candidates within one batch", async () => {
    const model = JSON.stringify([
      {
        body: "The user is building a fintech app called Atlas.",
        type: "fact",
        confidence: 0.7,
        scope: "user",
        source: "user",
        tags: [],
      },
      {
        body: "The user is building a fintech app called Atlas!",
        type: "fact",
        confidence: 0.7,
        scope: "user",
        source: "user",
        tags: [],
      },
    ]);
    const result = await extractSalientMemories(input(), deps(model));
    expect(candidatesOnly(result)).toHaveLength(1);
  });

  it("caps accepted candidates at 6", async () => {
    const distinctTopics = [
      "The user writes Rust for backend services.",
      "The user lives in Berlin Germany.",
      "The user prefers vim keybindings everywhere.",
      "The user's company sells climbing equipment.",
      "The user runs marathons on weekends.",
      "The user studied marine biology at university.",
      "The user owns a vintage motorcycle collection.",
      "The user volunteers at an animal shelter monthly.",
      "The user composes electronic music as a hobby.",
      "The user grows heirloom tomatoes in a greenhouse.",
    ];
    const many = JSON.stringify(
      distinctTopics.map((body) => ({
        body,
        type: "fact",
        confidence: 0.7,
        scope: "user",
        source: "user",
        tags: [],
      })),
    );
    const result = await extractSalientMemories(input(), deps(many));
    expect(candidatesOnly(result)).toHaveLength(6);
  });

  it("returns [] for empty user text without calling the model", async () => {
    let called = false;
    const result = await extractSalientMemories(input({ userText: "   " }), {
      ...deps(ATLAS_FACTS),
      callModel: (): Promise<string> => {
        called = true;
        return Promise.resolve(ATLAS_FACTS);
      },
    });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it("accepts a near-duplicate of a secret-rejected candidate (secret body absent from results)", async () => {
    // secretBody triggers the api_key= credential-shape pattern → buildCandidate returns null and
    // the body's bigrams are NEVER added to `seen`.  nearDuplicate is textually similar (Jaccard
    // ≈ 0.91 > DEDUP_THRESHOLD=0.8) but contains no secret shape → should be accepted, not
    // suppressed, because the rejected candidate never seeded the dedup set.
    const secretBody = "The user's api_key=abc123";
    const nearDuplicate = "The user's api key is abc123";
    const model = JSON.stringify([
      {
        body: secretBody,
        type: "fact",
        confidence: 0.7,
        scope: "user",
        source: "user",
        tags: [],
      },
      {
        body: nearDuplicate,
        type: "fact",
        confidence: 0.7,
        scope: "user",
        source: "user",
        tags: [],
      },
    ]);
    const result = await extractSalientMemories(input(), deps(model));
    const candidates = candidatesOnly(result);
    expect(candidates).toHaveLength(1);
    const bodies = candidates.map((c) => (c.kind === "candidate" ? c.proposal.body : ""));
    expect(bodies[0]).toBe(nearDuplicate);
    for (const body of bodies) {
      expect(body).not.toContain("api_key=");
    }
  });

  it("drops items whose scope cannot resolve (project hint, no projectId)", async () => {
    const model = JSON.stringify([
      {
        body: "Atlas uses PostgreSQL.",
        type: "fact",
        confidence: 0.8,
        scope: "project",
        source: "user",
        tags: [],
      },
    ]);
    const result = await extractSalientMemories(input({ context: baseContext() }), deps(model));
    expect(result).toEqual([]);
  });
});

describe("parseSalienceItems", () => {
  it("locates the first balanced array embedded in prose", () => {
    const raw =
      'Here you go: [{"body":"x","type":"fact","confidence":0.5,"scope":"user","source":"user","tags":[]}] done.';
    expect(parseSalienceItems(raw)).toHaveLength(1);
  });

  it("ignores brackets inside string values", () => {
    const raw =
      '[{"body":"uses arr[0] syntax","type":"fact","confidence":0.5,"scope":"user","source":"user","tags":[]}]';
    expect(parseSalienceItems(raw)).toHaveLength(1);
  });

  it("filters out elements with the wrong shape", () => {
    const raw =
      '[{"body":"ok","type":"fact","confidence":0.5,"scope":"user","source":"user","tags":[]},{"body":123}]';
    expect(parseSalienceItems(raw)).toHaveLength(1);
  });
});
