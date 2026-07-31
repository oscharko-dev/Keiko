import { describe, expect, it } from "vitest";
import { CODING_WORKBENCH_MODES, type CodingWorkbenchMode } from "./coding-workbench.js";
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
  const WORKSPACE_WRITES = [
    "branch-create",
    "branch-switch",
    "stage",
    "unstage",
    "commit",
  ] as const;
  const DELIVERY = ["fetch", "pull", "push", "pull-request", "merge"] as const;

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

  it("admits every execute in autonomous-delivery", () => {
    for (const operation of GIT_REPOSITORY_AGENT_OPERATION_KINDS) {
      expect(gitRepositoryAgentOperationAdmitted(operation, "execute", "autonomous-delivery")).toBe(
        true,
      );
    }
  });

  // Monotonic (ADR-0138): authority never decreases as the mode rises, so an operation admitted at
  // one mode is admitted at every higher one. Derived from the production minimum, not restated.
  it("is monotonic in the mode ordering", () => {
    const ranks: readonly CodingWorkbenchMode[] = CODING_WORKBENCH_MODES;
    for (const operation of GIT_REPOSITORY_AGENT_OPERATION_KINDS) {
      const minimum = gitRepositoryAgentMinimumMode(operation);
      const minimumIndex = ranks.indexOf(minimum);
      ranks.forEach((mode, index) => {
        expect(gitRepositoryAgentOperationAdmitted(operation, "execute", mode)).toBe(
          index >= minimumIndex,
        );
      });
    }
  });
});
