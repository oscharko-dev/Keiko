import { describe, expect, it } from "vitest";
import {
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
