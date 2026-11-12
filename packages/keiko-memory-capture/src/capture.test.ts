import { describe, expect, it } from "vitest";

import type { MemoryId, MemoryProposalId, UserId } from "@oscharko-dev/keiko-contracts/memory";

import { extractCandidatesFromUserText } from "./capture.js";
import type { CaptureContext } from "./types.js";

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  let memCounter = 0;
  let proCounter = 0;
  return {
    userId: "u-1" as UserId,
    nowMs: 1_700_000_000_000,
    newMemoryId: (): MemoryId => `m-${String(++memCounter)}` as MemoryId,
    newProposalId: (): MemoryProposalId => `p-${String(++proCounter)}` as MemoryProposalId,
    ...overrides,
  };
}

describe("extractCandidatesFromUserText", () => {
  it("returns empty-content rejection on blank input", () => {
    expect(extractCandidatesFromUserText("   ", ctx())).toEqual([
      { kind: "rejected", reason: "empty-content" },
    ]);
  });

  it("returns exceeds-length-limit on oversize input", () => {
    const huge = "remember that " + "x".repeat(5000);
    expect(extractCandidatesFromUserText(huge, ctx())).toEqual([
      { kind: "rejected", reason: "exceeds-length-limit", statement: "remember" },
    ]);
  });

  it("returns restricted-sensitivity when policy default is restricted", () => {
    expect(
      extractCandidatesFromUserText("remember dark mode", ctx(), {
        defaultSensitivity: "restricted",
      }),
    ).toEqual([{ kind: "rejected", reason: "restricted-sensitivity", statement: "remember" }]);
  });

  it("emits a remember candidate for a 'remember that' phrase", () => {
    const result = extractCandidatesFromUserText("remember that I prefer dark mode", ctx());
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("candidate");
  });

  it("emits a forget operation for 'forget about X' with resolver match", () => {
    const result = extractCandidatesFromUserText("forget about dark mode", ctx(), {
      resolver: () => ["m-9" as MemoryId],
    });
    expect(result[0]?.kind).toBe("forget");
    if (result[0]?.kind !== "forget") return;
    expect(result[0].operation.reason).toBe("explicit-user-request");
    expect(result[0].operation.reason).not.toContain("dark mode");
  });

  it("emits an update operation for 'update memory about ...'", () => {
    const result = extractCandidatesFromUserText("update memory about runner to be vitest", ctx(), {
      resolver: () => ["m-3" as MemoryId],
    });
    expect(result[0]?.kind).toBe("update");
  });

  it("emits a correction candidate for 'actually, ...'", () => {
    const result = extractCandidatesFromUserText("actually, the runner is vitest", ctx());
    expect(result[0]?.kind).toBe("candidate");
    if (result[0]?.kind !== "candidate") return;
    expect(result[0].proposal.type).toBe("correction");
  });

  it("emits a user-scoped identity candidate for a natural German self-introduction", () => {
    const result = extractCandidatesFromUserText("Hallo Keiko, ich bin Paul.", ctx());
    expect(result[0]?.kind).toBe("candidate");
    if (result[0]?.kind !== "candidate") return;
    expect(result[0].proposal.type).toBe("semantic-fact");
    expect(result[0].proposal.body).toBe("The user's name is Paul.");
    expect(result[0].proposal.scope).toEqual({ kind: "user", userId: "u-1" });
    expect(result[0].proposal.provenance.sourceKind).toBe("system-default");
    expect(result[0].proposal.provenance.captureRationale).toBe(
      "Automatically inferred from conversation (identity statement)",
    );
  });

  it("captures strong name phrases even without title casing", () => {
    const result = extractCandidatesFromUserText("my name is paul", ctx());
    expect(result[0]?.kind).toBe("candidate");
    if (result[0]?.kind !== "candidate") return;
    expect(result[0].proposal.body).toBe("The user's name is paul.");
  });

  it("returns [] when no intent matches", () => {
    expect(extractCandidatesFromUserText("what is the weather", ctx())).toEqual([]);
  });

  it("does not over-capture non-identity 'I am ...' statements", () => {
    expect(extractCandidatesFromUserText("I am working on the build", ctx())).toEqual([]);
  });

  it("rejects with credential-shape for credential bodies", () => {
    const shape = "AKIA" + "ABCDEFGHIJKLMNOP";
    const result = extractCandidatesFromUserText(`remember that ${shape}`, ctx());
    expect(result[0]).toEqual({
      kind: "rejected",
      reason: "credential-shape",
      statement: "remember",
    });
  });

  it("rejects provider base URLs before creating a candidate", () => {
    const result = extractCandidatesFromUserText(
      "remember that our provider base URL is https://llm.internal.example.com/v1",
      ctx(),
    );
    expect(result[0]).toEqual({
      kind: "rejected",
      reason: "provider-base-url",
      statement: "remember",
    });
  });

  it("rejects a configured category before creating an explicit candidate", () => {
    const result = extractCandidatesFromUserText("remember that my medical record changed", ctx(), {
      deniedCategoryMatchers: [{ category: "health-data", matchers: [/\bmedical record\b/iu] }],
    });
    expect(result[0]).toEqual({
      kind: "rejected",
      reason: "denied-category",
      statement: "remember",
    });
  });

  it("priority: forget wins over remember when both could match", () => {
    // Construct a string that would match both — 'remember about forget' vs 'forget about remember'.
    // The grammar is constructed so the forget regex fires first per the EXTRACTORS order.
    const result = extractCandidatesFromUserText("forget about old runner setting", ctx(), {
      resolver: () => ["m-1" as MemoryId],
    });
    expect(result[0]?.kind).toBe("forget");
  });
});

describe("extractCandidatesFromUserText attributes a rejection to its statement (#4211)", () => {
  it("names the statement that was refused", () => {
    expect(extractCandidatesFromUserText("Merke dir: Passwort: hunter2", ctx())).toEqual([
      { kind: "rejected", reason: "credential-shape", statement: "remember" },
    ]);
  });

  it("names a clear statement refused before any extractor ran", () => {
    const text = `Merke dir: ${"x".repeat(5000)}`;
    expect(extractCandidatesFromUserText(text, ctx())).toEqual([
      { kind: "rejected", reason: "exceeds-length-limit", statement: "remember" },
    ]);
  });

  it("names no statement for an ordinary long message", () => {
    const text = `Bitte fasse das zusammen: ${"x".repeat(5000)}`;
    expect(extractCandidatesFromUserText(text, ctx())).toEqual([
      { kind: "rejected", reason: "exceeds-length-limit" },
    ]);
  });
});
