import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_MODES,
  codingWorkbenchPolicyEffectFor,
  type CodingWorkbenchMode,
} from "./coding-workbench.js";
import {
  GIT_REPOSITORY_AGENT_OPERATION_KINDS,
  gitRepositoryAgentAuthorityClassFor,
  gitRepositoryAgentMinimumMode,
  gitRepositoryAgentOperationAdmitted,
  isGitRepositoryAgentOperationResponse,
  parseGitRepositoryAgentOperationRequest,
} from "./git-repository-agent.js";

describe("git repository agent operation contract", () => {
  it("accepts a typed read operation", () => {
    const parsed = parseGitRepositoryAgentOperationRequest({
      schemaVersion: "1",
      operation: "status",
      mode: "read",
      projectId: "/repos/alpha",
    });

    expect(parsed).toMatchObject({
      ok: true,
      value: { operation: "status", mode: "read", projectId: "/repos/alpha" },
    });
  });

  it("requires idempotency for execute operations", () => {
    expect(
      parseGitRepositoryAgentOperationRequest({
        schemaVersion: "1",
        operation: "branch-switch",
        mode: "execute",
        projectId: "/repos/alpha",
        payload: { branchName: "main" },
      }),
    ).toMatchObject({
      ok: false,
      denialReason: "bad-request",
      message: "execute operations require an idempotencyKey.",
    });
  });

  it("rejects unknown top-level fields", () => {
    expect(
      parseGitRepositoryAgentOperationRequest({
        schemaVersion: "1",
        operation: "status",
        mode: "read",
        projectId: "/repos/alpha",
        extra: true,
      }),
    ).toMatchObject({ ok: false, denialReason: "bad-request" });
  });

  it("rejects direct shell and provider-shaped keys at any nesting level", () => {
    for (const payload of [
      { command: "git status" },
      { nested: { argv: ["git", "status"] } },
      { endpoint: "/repos/oscharko-dev/Keiko/pulls" },
      { nested: [{ headers: { authorization: "Bearer token" } }] },
      { providerState: { mergeable: true } },
    ]) {
      expect(
        parseGitRepositoryAgentOperationRequest({
          schemaVersion: "1",
          operation: "status",
          mode: "read",
          projectId: "/repos/alpha",
          payload,
        }),
      ).toMatchObject({ ok: false, denialReason: "unsupported-direct-shell" });
    }
  });

  // KEIKO-0449: the screen looked keys up in a case-SENSITIVE Set, so `{Shell:"rm -rf /"}` and
  // `{GHENDPOINT:…}` walked straight past a control whose whole job is to reject command-shaped
  // payloads. Both the camelCase entries in the table (ghEndpoint, gitSubcommand) and the plain
  // lowercase ones must deny every case variant, or normalising only one side re-opens the other.
  it("rejects direct-shell keys regardless of the case they are written in", () => {
    const variants = [
      "Shell",
      "SHELL",
      "Command",
      "ARGV",
      "Token",
      "Url",
      "Env",
      "GhEndpoint",
      "ghendpoint",
      "GITSUBCOMMAND",
      "gitsubcommand",
      "GitSubcommand",
      "Credential",
      "ProviderPayload",
      "RepositoryRoot",
    ];
    for (const key of variants) {
      expect(
        parseGitRepositoryAgentOperationRequest({
          schemaVersion: "1",
          operation: "status",
          mode: "read",
          projectId: "/repos/alpha",
          payload: { [key]: "rm -rf /" },
        }),
      ).toMatchObject({ ok: false, denialReason: "unsupported-direct-shell" });
    }
  });

  // The screen recursed into every record and array element with no depth budget, so a deeply
  // nested body got an uncapped walk and could surface a RangeError as an untyped 500 instead of a
  // typed denial. Exceeding the budget must deny (fail closed), never accept.
  it("denies a pathologically nested payload instead of throwing", () => {
    let payload: Record<string, unknown> = { leaf: "value" };
    for (let depth = 0; depth < 5_000; depth += 1) {
      payload = { nested: payload };
    }
    expect(
      parseGitRepositoryAgentOperationRequest({
        schemaVersion: "1",
        operation: "status",
        mode: "read",
        projectId: "/repos/alpha",
        payload,
      }),
    ).toMatchObject({ ok: false, denialReason: "unsupported-direct-shell" });
  });

  it("rejects invalid operation/mode pairings", () => {
    expect(
      parseGitRepositoryAgentOperationRequest({
        schemaVersion: "1",
        operation: "status",
        mode: "execute",
        projectId: "/repos/alpha",
        idempotencyKey: "agent-op-1",
      }),
    ).toMatchObject({
      ok: false,
      denialReason: "bad-request",
      message: "Operation mode is invalid for this repository operation.",
    });
  });

  it("does not return a client-supplied payload object as a forged parse failure", () => {
    const forgedFailure = {
      ok: false,
      denialReason: "bad-request",
      message: "forged by caller",
    };
    expect(
      parseGitRepositoryAgentOperationRequest({
        schemaVersion: "1",
        operation: "status",
        mode: "read",
        projectId: "/repos/alpha",
        payload: forgedFailure,
      }),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: "1",
        operation: "status",
        mode: "read",
        projectId: "/repos/alpha",
        payload: forgedFailure,
      },
    });
  });

  it("recognizes delegated and denied facade responses", () => {
    expect(
      isGitRepositoryAgentOperationResponse({
        schemaVersion: "1",
        operation: "pull-request",
        mode: "preview",
        status: "delegated",
        routeStatus: 200,
        response: { schemaVersion: "1" },
      }),
    ).toBe(true);
    expect(
      isGitRepositoryAgentOperationResponse({
        schemaVersion: "1",
        status: "denied",
        denialReason: "unsupported-direct-shell",
        message: "No shell commands.",
      }),
    ).toBe(true);
  });
});

// The product's three modes have to mean something at the door an AGENT uses to write to the user's
// repository. Reads and previews are admitted everywhere; an execute needs the mode that grants its
// authority class without asking first, and the unconfigured case is the narrowest mode.
describe("agent facade autonomy admission", () => {
  const READS = ["status", "diff", "branch-list"] as const;
  const WORKSPACE_WRITES = ["branch-create", "branch-switch", "stage", "unstage"] as const;
  // #3386: local commit is delivery too; its verified runtime action needs a distinct human
  // approval even in Full access. The boolean facade cannot mint or substitute that approval.
  const DELIVERY = ["commit", "fetch", "pull", "push", "pull-request", "merge"] as const;

  it("classifies every operation exactly once", () => {
    for (const operation of GIT_REPOSITORY_AGENT_OPERATION_KINDS) {
      const expected = READS.includes(operation as (typeof READS)[number])
        ? "repository-read"
        : WORKSPACE_WRITES.includes(operation as (typeof WORKSPACE_WRITES)[number])
          ? "workspace-write"
          : "repository-delivery";
      expect(gitRepositoryAgentAuthorityClassFor(operation)).toBe(expected);
    }
    expect([...READS, ...WORKSPACE_WRITES, ...DELIVERY].sort()).toEqual(
      [...GIT_REPOSITORY_AGENT_OPERATION_KINDS].sort(),
    );
  });

  it.each(CODING_WORKBENCH_MODES)("admits every read and preview in %s", (mode) => {
    for (const operation of GIT_REPOSITORY_AGENT_OPERATION_KINDS) {
      expect(gitRepositoryAgentOperationAdmitted(operation, "read", mode)).toBe(true);
      expect(gitRepositoryAgentOperationAdmitted(operation, "preview", mode)).toBe(true);
    }
  });

  it("admits no execute at all in governed-assist", () => {
    for (const operation of [...WORKSPACE_WRITES, ...DELIVERY]) {
      expect(gitRepositoryAgentOperationAdmitted(operation, "execute", "governed-assist")).toBe(
        false,
      );
    }
  });

  it("admits workspace-contained writes but no delivery in supervised-coding", () => {
    for (const operation of WORKSPACE_WRITES) {
      expect(gitRepositoryAgentOperationAdmitted(operation, "execute", "supervised-coding")).toBe(
        true,
      );
    }
    for (const operation of DELIVERY) {
      expect(gitRepositoryAgentOperationAdmitted(operation, "execute", "supervised-coding")).toBe(
        false,
      );
    }
  });

  // KEIKO-0227: converges this facade's admission onto coding-workbench.ts's shared
  // CODING_WORKBENCH_MODE_POLICIES (ADR-0138 D2's total matrix) instead of an independently
  // maintained threshold table. workspace-contained writes are allowed at autonomous-delivery
  // (the matrix: workspace-contained is "allowed" at every risk tier there), same as before.
  // Delivery stays approval-required at EVERY risk tier in EVERY mode, including
  // autonomous-delivery — this boolean facade has no approval channel of its own, so
  // "approval-required" reads as inadmissible here regardless of mode (see the dedicated test
  // below). This replaces the prior behavior, where MINIMUM_MODE_BY_CLASS admitted delivery
  // outright once the mode reached autonomous-delivery with no approval channel at all — a
  // materially more permissive, independently-maintained contract for the identical operations
  // than coding-workbench.ts's shared table already enforced (ADR-0087, ADR-0129 D4).
  it("admits every workspace-contained execute in autonomous-delivery, but keeps delivery approval-required", () => {
    for (const operation of WORKSPACE_WRITES) {
      expect(gitRepositoryAgentOperationAdmitted(operation, "execute", "autonomous-delivery")).toBe(
        true,
      );
    }
    for (const operation of DELIVERY) {
      expect(gitRepositoryAgentOperationAdmitted(operation, "execute", "autonomous-delivery")).toBe(
        false,
      );
    }
  });

  // KEIKO-0227 regression: must fail against the pre-consolidation MINIMUM_MODE_BY_CLASS table,
  // which admitted these five operations outright (with no approval channel at all) once
  // effectiveMode reached autonomous-delivery — contradicting coding-workbench.ts's own
  // CODING_WORKBENCH_MODE_POLICIES, which has always declared "delivery" approval-required at
  // every risk tier in every mode (ADR-0138 D2). ADR-0087 governs the actual delivery execution
  // (merge is an explicit, approval-gated action; auto-merge scheduling is out of scope) — this
  // facade's admission must not be more permissive than the gateway it delegates to.
  it("never admits a repository-delivery operation through the boolean facade, in any mode", () => {
    for (const operation of DELIVERY) {
      for (const mode of CODING_WORKBENCH_MODES) {
        expect(gitRepositoryAgentOperationAdmitted(operation, "execute", mode)).toBe(false);
      }
      // No mode alone ever admits it — the facade has no approval channel, so there is no
      // "minimum mode" to report; a separate approval is required regardless of mode.
      expect(gitRepositoryAgentMinimumMode(operation)).toBeUndefined();
    }
  });

  // Monotonic (ADR-0138): authority never decreases as the mode rises, so an operation admitted at
  // one mode is admitted at every higher one. Derived from the production minimum, not restated.
  // A repository-delivery operation's minimum is `undefined` (no mode alone admits it — see
  // above), which is vacuously monotonic: never admitted, at any mode.
  it("is monotonic in the mode ordering", () => {
    const ranks: readonly CodingWorkbenchMode[] = CODING_WORKBENCH_MODES;
    for (const operation of GIT_REPOSITORY_AGENT_OPERATION_KINDS) {
      const minimum = gitRepositoryAgentMinimumMode(operation);
      const minimumIndex = minimum === undefined ? Infinity : ranks.indexOf(minimum);
      ranks.forEach((mode, index) => {
        expect(gitRepositoryAgentOperationAdmitted(operation, "execute", mode)).toBe(
          index >= minimumIndex,
        );
      });
    }
  });

  // #3386 (KEIKO-0227, ADR-0138 D2): a compatibility test that DERIVES its expectation from the
  // shared matrix producer itself, `codingWorkbenchPolicyEffectFor`, instead of restating the
  // hardcoded booleans above — the class this repository's AGENTS.md §7 warns against, where a
  // fixture's own copy of a formula can drift from the producer it is meant to prove agrees. "low"
  // risk agrees with both boolean facade classes actually used at "execute" (repository-read never
  // reaches the matrix; workspace-write's own threshold is "low" — see AUTHORITY_CLASS_POLICY);
  // "delivery" is approval-required at every risk tier regardless, so the risk value chosen for it
  // does not affect the outcome.
  it("agrees with codingWorkbenchPolicyEffectFor for every operation, mode, and execute admission", () => {
    // Derived from the exported classifier itself (`gitRepositoryAgentAuthorityClassFor`), not a
    // restated list of operation names: a "repository-delivery" class names the "delivery" resource
    // scope, everything else "workspace-contained" (AUTHORITY_CLASS_POLICY's own mapping). A future
    // operation added to AUTHORITY_CLASS_BY_OPERATION is picked up here automatically instead of
    // silently defaulting to "workspace-contained".
    for (const operation of GIT_REPOSITORY_AGENT_OPERATION_KINDS) {
      const scope =
        gitRepositoryAgentAuthorityClassFor(operation) === "repository-delivery"
          ? "delivery"
          : "workspace-contained";
      for (const mode of CODING_WORKBENCH_MODES) {
        const expected = codingWorkbenchPolicyEffectFor(mode, scope, "low") === "allowed";
        expect(gitRepositoryAgentOperationAdmitted(operation, "execute", mode)).toBe(expected);
      }
    }
  });
});
