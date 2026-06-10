import { describe, expect, it } from "vitest";

import type {
  MemoryId,
  MemoryProposalId,
  ProjectId,
  UserId,
} from "@oscharko-dev/keiko-contracts/memory";

import { extractSalientMemories, parseSalienceItems, SALIENCE_SYSTEM_PROMPT } from "./salience.js";
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
    tags: ["atlas", "fintech"],
  },
  {
    body: "Atlas is written in Rust.",
    type: "fact",
    confidence: 0.8,
    scope: "project",
    tags: ["rust"],
  },
  {
    body: "Atlas uses PostgreSQL.",
    type: "fact",
    confidence: 0.8,
    scope: "project",
    tags: ["postgresql"],
  },
  {
    body: "The user's team is in Berlin.",
    type: "fact",
    confidence: 0.6,
    scope: "user",
    tags: ["team", "berlin"],
  },
]);

describe("SALIENCE_SYSTEM_PROMPT", () => {
  it("instructs JSON-array-only output and excludes assistant claims", () => {
    expect(SALIENCE_SYSTEM_PROMPT).toContain("JSON array");
    expect(SALIENCE_SYSTEM_PROMPT).toContain("assistant");
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
      expect(candidate.proposal.provenance.confidence).toBeGreaterThanOrEqual(0.4);
      expect(candidate.proposal.provenance.confidence).toBeLessThanOrEqual(0.9);
      expect(candidate.proposal.provenance.sourceKind).toBe("system-default");
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

  it("clamps confidence into [0.4, 0.9]", async () => {
    const model = JSON.stringify([
      {
        body: "The user prefers tabs over spaces.",
        type: "preference",
        confidence: 0.02,
        scope: "user",
        tags: [],
      },
      {
        body: "The user always deploys on Fridays.",
        type: "lesson",
        confidence: 1.5,
        scope: "user",
        tags: [],
      },
    ]);
    const result = await extractSalientMemories(input(), deps(model));
    const confidences = candidatesOnly(result).map((c) =>
      c.kind === "candidate" ? c.proposal.provenance.confidence : -1,
    );
    expect(confidences).toEqual([0.4, 0.9]);
  });

  it("drops candidate bodies that look like secrets", async () => {
    const apiKey = ["sk-", "abcdefghijklmnopqrstuvwxyz12345"].join("");
    const model = JSON.stringify([
      {
        body: `The user's api_key=${apiKey}.`,
        type: "fact",
        confidence: 0.8,
        scope: "user",
        tags: [],
      },
      {
        body: "The user works at a startup.",
        type: "fact",
        confidence: 0.7,
        scope: "user",
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

  it("returns [] on malformed (non-JSON prose) model output without throwing", async () => {
    const result = await extractSalientMemories(
      input(),
      deps("Sure! Here are some thoughts, but no JSON."),
    );
    expect(result).toEqual([]);
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

  it("dedups near-identical candidates within one batch", async () => {
    const model = JSON.stringify([
      {
        body: "The user is building a fintech app called Atlas.",
        type: "fact",
        confidence: 0.7,
        scope: "user",
        tags: [],
      },
      {
        body: "The user is building a fintech app called Atlas!",
        type: "fact",
        confidence: 0.7,
        scope: "user",
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

  it("drops items whose scope cannot resolve (project hint, no projectId)", async () => {
    const model = JSON.stringify([
      { body: "Atlas uses PostgreSQL.", type: "fact", confidence: 0.8, scope: "project", tags: [] },
    ]);
    const result = await extractSalientMemories(input({ context: baseContext() }), deps(model));
    expect(result).toEqual([]);
  });
});

describe("parseSalienceItems", () => {
  it("locates the first balanced array embedded in prose", () => {
    const raw =
      'Here you go: [{"body":"x","type":"fact","confidence":0.5,"scope":"user","tags":[]}] done.';
    expect(parseSalienceItems(raw)).toHaveLength(1);
  });

  it("ignores brackets inside string values", () => {
    const raw =
      '[{"body":"uses arr[0] syntax","type":"fact","confidence":0.5,"scope":"user","tags":[]}]';
    expect(parseSalienceItems(raw)).toHaveLength(1);
  });

  it("filters out elements with the wrong shape", () => {
    const raw =
      '[{"body":"ok","type":"fact","confidence":0.5,"scope":"user","tags":[]},{"body":123}]';
    expect(parseSalienceItems(raw)).toHaveLength(1);
  });
});
