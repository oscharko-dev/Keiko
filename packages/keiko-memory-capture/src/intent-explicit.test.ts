import { describe, expect, it, vi } from "vitest";

import type {
  MemoryId,
  MemoryProposalId,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";

import {
  tryExtractCorrection,
  tryExtractForget,
  tryExtractRemember,
  tryExtractUpdate,
} from "./intent-explicit.js";
import type { CaptureContext } from "./types.js";

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  let memoryCounter = 0;
  let proposalCounter = 0;
  return {
    userId: "u-1" as UserId,
    nowMs: 1_700_000_000_000,
    newMemoryId: (): MemoryId => `m-${String(++memoryCounter)}` as MemoryId,
    newProposalId: (): MemoryProposalId => `p-${String(++proposalCounter)}` as MemoryProposalId,
    ...overrides,
  };
}

describe("tryExtractRemember", () => {
  it('extracts "remember that X" as a preference proposal at user scope', () => {
    const outcome = tryExtractRemember("remember that I prefer dark mode", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.type).toBe("preference");
    expect(outcome.proposal.body).toBe("I prefer dark mode");
    expect(outcome.proposal.scope).toEqual({ kind: "user", userId: "u-1" });
    expect(outcome.proposal.provenance.sourceKind).toBe("explicit-user-instruction");
    expect(outcome.requiresApproval).toBe(false);
  });

  it("scope-infers project when projectId is on context", () => {
    const outcome = tryExtractRemember(
      "remember that the test runner is vitest",
      ctx({ projectId: "p-1" as ProjectId }),
    );
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.scope).toEqual({ kind: "project", projectId: "p-1" });
  });

  it('extracts "remember about this project: X" with project scope', () => {
    const outcome = tryExtractRemember(
      "remember about this project: use pnpm not npm",
      ctx({ projectId: "p-1" as ProjectId }),
    );
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("use pnpm not npm");
    expect(outcome.proposal.scope).toEqual({ kind: "project", projectId: "p-1" });
  });

  // Regression pin (audit KEIKO-0336): the "about this workspace|project" hint used a
  // non-capturing group so tryExtractRemember never inspected which noun matched — scope was
  // decided by implicit context precedence (project > workspace > ...) and a user asking for
  // workspace scope inside a project silently got a project-scoped memory instead. Both nouns
  // must now flow through scopeOrReject's scopeKind override so the stated intent wins.
  it('extracts "remember about this workspace: X" with workspace scope even when projectId is set', () => {
    const outcome = tryExtractRemember(
      "remember about this workspace: use pnpm not npm",
      ctx({ projectId: "p-1" as ProjectId, workspaceId: "w-1" as WorkspaceId }),
    );
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("use pnpm not npm");
    expect(outcome.proposal.scope).toEqual({ kind: "workspace", workspaceId: "w-1" });
  });

  it('"remember about this workspace: X" fails closed when workspaceId is absent from context', () => {
    const outcome = tryExtractRemember(
      "remember about this workspace: use pnpm not npm",
      ctx({ projectId: "p-1" as ProjectId }),
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "scope-not-resolvable" });
  });

  it("flips requiresApproval=true when body classifies as confidential", () => {
    const outcome = tryExtractRemember("remember that internal: deploy at midnight", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.provenance.sensitivity).toBe("confidential");
    expect(outcome.requiresApproval).toBe(true);
  });

  it("rejects with credential-shape when body contains a credential", () => {
    const shape = "sk" + "-" + "abcdef0123456789abcdef0123";
    const outcome = tryExtractRemember(`remember that my key is ${shape}`, ctx());
    expect(outcome).toEqual({ kind: "rejected", reason: "credential-shape" });
  });

  it("rejects provider base URLs in remember bodies", () => {
    const outcome = tryExtractRemember(
      "remember that our provider base URL is https://llm.internal.example.com/v1",
      ctx(),
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "provider-base-url" });
  });

  it("returns null for unrelated text", () => {
    expect(tryExtractRemember("what is the weather", ctx())).toBeNull();
  });

  it("regex requires the imperative 'remember' (mutation witness)", () => {
    // If the regex were widened to accept any text, this benign sentence would extract a body.
    expect(tryExtractRemember("I would like dark mode", ctx())).toBeNull();
  });

  it("rejects with scope-not-resolvable when scopeKind=workspace but no workspaceId", () => {
    const outcome = tryExtractRemember("remember that X", ctx(), { scopeKind: "workspace" });
    expect(outcome).toEqual({ kind: "rejected", reason: "scope-not-resolvable" });
  });

  it("extracts German explicit remember intents without translating the body", () => {
    const outcome = tryExtractRemember("Merk dir bitte, dass ich Dark Mode bevorzuge", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("ich Dark Mode bevorzuge");
    expect(outcome.proposal.provenance.sourceKind).toBe("explicit-user-instruction");
  });

  it("extracts German speichern/notieren remember variants", () => {
    const saved = tryExtractRemember("Speichere bitte, dass das Projekt Vitest nutzt", ctx());
    const noted = tryExtractRemember("Notiere dass Deployments dienstags stattfinden", ctx());
    expect(saved?.kind).toBe("candidate");
    expect(noted?.kind).toBe("candidate");
    if (saved?.kind === "candidate") {
      expect(saved.proposal.body).toBe("das Projekt Vitest nutzt");
    }
    if (noted?.kind === "candidate") {
      expect(noted.proposal.body).toBe("Deployments dienstags stattfinden");
    }
  });
});

describe("tryExtractForget", () => {
  it("rejects with ambiguous-forget when resolver returns >1 match", () => {
    const outcome = tryExtractForget("forget about the test runner", ctx(), {
      resolver: () => ["m-1" as MemoryId, "m-2" as MemoryId],
    });
    expect(outcome).toEqual({ kind: "rejected", reason: "ambiguous-forget" });
  });

  it("emits forget operation with userAcknowledgedDestructive=true on single match", () => {
    const outcome = tryExtractForget("forget about dark mode preference", ctx(), {
      resolver: () => ["m-7" as MemoryId],
    });
    expect(outcome?.kind).toBe("forget");
    if (outcome?.kind !== "forget") return;
    expect(outcome.operation.memoryId).toBe("m-7");
    expect(outcome.operation.reason).toBe("explicit-user-request");
    expect(outcome.operation.reason).not.toContain("dark mode");
    expect(outcome.operation.userAcknowledgedDestructive).toBe(true);
    expect(outcome.requiresConfirmation).toBe(true);
  });

  it("returns null when resolver finds no match", () => {
    const outcome = tryExtractForget("forget about nothing", ctx(), { resolver: () => [] });
    expect(outcome).toBeNull();
  });

  it("returns null when no resolver supplied (cannot identify a target)", () => {
    expect(tryExtractForget("forget about X", ctx())).toBeNull();
  });

  it("returns null for non-forget text (mutation witness on regex)", () => {
    expect(tryExtractForget("remember about X", ctx(), { resolver: () => [] })).toBeNull();
  });

  it("extracts German forget intents", () => {
    const outcome = tryExtractForget("Vergiss bitte die Dark-Mode-Präferenz", ctx(), {
      resolver: (target) => (target.includes("Dark-Mode") ? ["m-9" as MemoryId] : []),
    });
    expect(outcome?.kind).toBe("forget");
    if (outcome?.kind !== "forget") return;
    expect(outcome.operation.memoryId).toBe("m-9");
    expect(outcome.operation.reason).toBe("explicit-user-request");
    expect(outcome.requiresConfirmation).toBe(true);
  });

  // Regression: see the matching note on tryExtractRemember above. For forget specifically the
  // consequence is worse than a merely-inert candidate: a fuzzy/substring resolver invoked with
  // the swallowed keyword text ("about", "bitte") as the target can plausibly match some
  // unrelated real memory and produce a live `forget` operation with requiresConfirmation:true.
  // The resolver spy proves the fix rejects before ever calling the resolver, not just that it
  // happens to return null.
  it("never calls the resolver with swallowed keyword text when no real target follows", () => {
    const resolver = vi.fn((target: string) => (target.length > 0 ? ["m-wrong" as MemoryId] : []));
    expect(tryExtractForget("forget about   ", ctx(), { resolver })).toBeNull();
    expect(tryExtractForget("vergiss bitte   ", ctx(), { resolver })).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("tryExtractUpdate", () => {
  it("emits update operation with bodyPatch on single resolver match", () => {
    const outcome = tryExtractUpdate("update memory about test runner to be vitest", ctx(), {
      resolver: () => ["m-3" as MemoryId],
    });
    expect(outcome?.kind).toBe("update");
    if (outcome?.kind !== "update") return;
    expect(outcome.operation.memoryId).toBe("m-3");
    expect(outcome.operation.bodyPatch).toBe("vitest");
  });

  it("rejects with ambiguous-update on multi-match", () => {
    const outcome = tryExtractUpdate("update memory about runner with vitest", ctx(), {
      resolver: () => ["m-1" as MemoryId, "m-2" as MemoryId],
    });
    expect(outcome).toEqual({ kind: "rejected", reason: "ambiguous-update" });
  });

  it("rejects on credential-shape in the new value", () => {
    const shape = "AKIA" + "ABCDEFGHIJKLMNOP";
    const outcome = tryExtractUpdate(`update memory about my key to be ${shape}`, ctx(), {
      resolver: () => ["m-1" as MemoryId],
    });
    expect(outcome).toEqual({ kind: "rejected", reason: "credential-shape" });
  });

  it("returns null when no resolver supplied", () => {
    expect(tryExtractUpdate("update memory about X with Y", ctx())).toBeNull();
  });

  it("returns null for non-update text", () => {
    expect(tryExtractUpdate("remember that X", ctx(), { resolver: () => [] })).toBeNull();
  });

  it("extracts German update intents", () => {
    const outcome = tryExtractUpdate(
      "Aktualisiere die Erinnerung zum Test Runner auf vitest",
      ctx(),
      { resolver: () => ["m-4" as MemoryId] },
    );
    expect(outcome?.kind).toBe("update");
    if (outcome?.kind !== "update") return;
    expect(outcome.operation.memoryId).toBe("m-4");
    expect(outcome.operation.bodyPatch).toBe("vitest");
  });
});

describe("tryExtractCorrection", () => {
  it("extracts an 'actually, X' correction", () => {
    const outcome = tryExtractCorrection("actually, it's vitest not jest", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.type).toBe("correction");
    expect(outcome.proposal.body).toBe("it's vitest not jest");
    expect(outcome.proposal.provenance.sourceKind).toBe("accepted-correction");
  });

  it("extracts a 'correction: X' label", () => {
    const outcome = tryExtractCorrection("correction: the file is at src/index.ts", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("the file is at src/index.ts");
  });

  it("extracts a 'that's wrong, X is Y' shape into 'X is Y'", () => {
    const outcome = tryExtractCorrection("that's wrong, the runner is vitest", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("the runner is vitest");
  });

  it("returns null for non-correction text", () => {
    expect(tryExtractCorrection("remember dark mode", ctx())).toBeNull();
  });

  it("rejects credential-shape inside correction body", () => {
    const shape = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(tryExtractCorrection(`actually, ${shape}`, ctx())).toEqual({
      kind: "rejected",
      reason: "credential-shape",
    });
  });

  it("rejects raw log excerpts inside correction bodies", () => {
    expect(
      tryExtractCorrection(
        "actually, ERROR 2026-06-08T06:00:00Z worker failed at module X with stack trace line 1 at foo() line 2 at bar()",
        ctx(),
      ),
    ).toEqual({
      kind: "rejected",
      reason: "raw-log-content",
    });
  });

  it("extracts German correction labels and wrong-shapes", () => {
    const labeled = tryExtractCorrection("Korrektur: der Runner ist vitest", ctx());
    expect(labeled?.kind).toBe("candidate");
    if (labeled?.kind === "candidate") {
      expect(labeled.proposal.body).toBe("der Runner ist vitest");
    }

    const wrong = tryExtractCorrection("Das stimmt nicht, der Runner ist vitest", ctx());
    expect(wrong?.kind).toBe("candidate");
    if (wrong?.kind === "candidate") {
      expect(wrong.proposal.body).toBe("der Runner ist vitest");
    }
  });

  // Regression for a Gitar review finding on this exact PR: splitting THATS_WRONG_BODY_RE's
  // combined EN/DE verb alternation into two separately-tried regexes must still pick whichever
  // verb appears LEFTMOST overall (matching the original single regex's lazy-subject-group
  // behavior), not always prefer the EN pattern regardless of position. This body has an earlier
  // German verb ("ist") and a later, unrelated English word ("is") inside the value — the correct
  // split point is at "ist", not "is".
  it("picks the leftmost verb across EN/DE when both appear in a wrong-shape body", () => {
    const outcome = tryExtractCorrection(
      "that's wrong, the region ist berlin not paris and everything is fine",
      ctx(),
    );
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind === "candidate") {
      expect(outcome.proposal.body).toBe("the region ist berlin not paris and everything is fine");
    }
  });
});

// ─── Regex performance (SonarCloud S8786 regression) ─────────────────────────
// All extractor regexes end (or, for update/correction, also begin) a capture group with an
// unbounded quantifier immediately followed by another unbounded quantifier over an overlapping
// character class (`.+?` then `\s*$`, or `.+?` then `\s+`). That overlap forces the engine to
// re-scan the remaining input at every position the lazy group could stop at, which is
// quadratic on an adversarial "single token, huge whitespace run" input. A 20_000-character
// adversarial body would have taken the old `(.+?)\s*$`-style patterns on the order of seconds
// (verified empirically before the fix: ~35ms at 8k chars and growing ~4x per doubling, i.e.
// O(n^2)); the fixed patterns resolve the same input in low single-digit milliseconds because
// `\S`/`\s` are disjoint character classes with no ambiguous split to backtrack over.
const PERFORMANCE_BUDGET_MS = 300;

describe("regex performance (SonarCloud S8786 regression)", () => {
  it("tryExtractRemember resolves a large single-token whitespace-run body quickly", () => {
    const adversarialBody = `x${" ".repeat(20_000)}y`;
    const start = Date.now();
    const outcome = tryExtractRemember(`remember that ${adversarialBody}`, ctx());
    expect(Date.now() - start).toBeLessThan(PERFORMANCE_BUDGET_MS);
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe(adversarialBody);
  });

  it("tryExtractForget resolves a large single-token whitespace-run target quickly", () => {
    const adversarialTarget = `x${" ".repeat(20_000)}y`;
    const start = Date.now();
    const outcome = tryExtractForget(`forget about ${adversarialTarget}`, ctx(), {
      resolver: () => ["m-1" as MemoryId],
    });
    expect(Date.now() - start).toBeLessThan(PERFORMANCE_BUDGET_MS);
    expect(outcome?.kind).toBe("forget");
  });

  it("tryExtractUpdate rejects a large whitespace-run target with no separator quickly", () => {
    // No "to be"/"with"/"auf"/"mit"/"zu"/":" ever appears, so the old pattern had to fully
    // explore the adjacent \s+ vs .+? split at every position in the whitespace run before
    // concluding there is no match.
    const adversarialTarget = `a${" ".repeat(20_000)}`;
    const start = Date.now();
    const outcome = tryExtractUpdate(`update memory about ${adversarialTarget}`, ctx(), {
      resolver: () => ["m-1" as MemoryId],
    });
    expect(Date.now() - start).toBeLessThan(PERFORMANCE_BUDGET_MS);
    expect(outcome).toBeNull();
  });

  it("tryExtractCorrection rejects a large whitespace-run 'that's wrong' body with no verb quickly", () => {
    // No "is"/"are"/"should be"/"ist"/"sind"/"sollte sein" ever appears.
    const adversarialSubject = `a${" ".repeat(20_000)}`;
    const start = Date.now();
    const outcome = tryExtractCorrection(`that's wrong, ${adversarialSubject}`, ctx());
    expect(Date.now() - start).toBeLessThan(PERFORMANCE_BUDGET_MS);
    expect(outcome).toBeNull();
  });

  // Behaviour-equivalence note: the old `(.+?)\s*$`-shaped patterns had an accidental quirk where
  // a body consisting of *only* whitespace (e.g. "remember  ") would backtrack into capturing a
  // single space character as the body, because `.` and `\s` overlap. The fixed `\S`-anchored
  // patterns require at least one non-whitespace character, so a whitespace-only body correctly
  // falls through to "not this intent" (null) instead of producing a degenerate single-space
  // memory candidate. This is intentional: it was never a designed input, and the file's own
  // contract (see the top-of-file comment) is that ambiguous matches return null.
  it("treats a whitespace-only body as no match rather than capturing a stray space", () => {
    expect(tryExtractRemember("remember  ", ctx())).toBeNull();
  });

  // Regression: a second-pass fix bounded the trailing capture as `(\S(?:.*\S)?)` chained
  // directly onto the prefix alternation. Because the inner keyword clauses ("that", "bitte",
  // "dass", "about this project:", …) are themselves optional, the engine could backtrack one of
  // them out of the prefix whenever doing so was the only way to still satisfy the mandatory
  // `\s+` separator before the capture — and then the keyword's own text got captured as the
  // body/target. This is strictly worse than the single-space quirk documented above: instead of
  // a body that (almost) never resolves to anything, it produces a real word that a fuzzy/
  // substring resolver can plausibly match to an unrelated memory. Each case here reproduces the
  // exact adversarial shape (keyword clause followed by nothing but trailing whitespace) and must
  // return null / no match, not the swallowed keyword.
  it("treats prefix keyword text followed only by whitespace as no body, not as the body itself", () => {
    expect(tryExtractRemember("remember that   ", ctx())).toBeNull();
    expect(tryExtractRemember("merke dir bitte, dass \t", ctx())).toBeNull();
    expect(
      tryExtractRemember(
        "remember about this project:    ",
        ctx({ projectId: "p-1" as ProjectId }),
      ),
    ).toBeNull();
  });
});
