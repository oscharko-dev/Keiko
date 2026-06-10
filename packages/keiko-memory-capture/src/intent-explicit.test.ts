import { describe, expect, it } from "vitest";

import type {
  MemoryId,
  MemoryProposalId,
  ProjectId,
  UserId,
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
});
