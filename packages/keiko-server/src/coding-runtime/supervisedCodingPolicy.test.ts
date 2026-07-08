import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateCodingWorkbenchEvidenceRecord } from "@oscharko-dev/keiko-contracts";

import {
  decideSupervisedFileEdit,
  decideSupervisedMutation,
  decideSupervisedVerificationCommand,
  type SupervisedCodingCommandRequest,
  type SupervisedCodingFileEditRequest,
  type SupervisedCodingMutationRequest,
} from "./supervisedCodingPolicy.js";
import {
  createInMemorySupervisedCodingApprovalStore,
  supervisedCodingApprovalScopeDigest,
  type SupervisedCodingApprovalBinding,
  type SupervisedCodingApprovalClaim,
  type SupervisedCodingConsumedApproval,
} from "./supervisedCodingApprovalStore.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function common(): Pick<
  SupervisedCodingFileEditRequest,
  "recordId" | "runId" | "occurredAt" | "effectiveMode" | "runtimeSource" | "modelSource"
> {
  return {
    recordId: "ev-1992",
    runId: "run-1992",
    occurredAt: "2026-07-07T22:00:00.000Z",
    effectiveMode: "supervised-coding",
    runtimeSource: "codex-cli-adapter",
    modelSource: "chatgpt-codex-subscription-profile",
  } as const;
}

function workspaceFixture(): { readonly root: string; readonly outside: string } {
  const root = tempDir("keiko-supervised-root-");
  const outside = tempDir("keiko-supervised-outside-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "allowed.ts"), "export const allowed = true;\n", "utf8");
  writeFileSync(join(outside, "secret.ts"), "export const secret = true;\n", "utf8");
  symlinkSync(join(outside, "secret.ts"), join(root, "src", "escape.ts"));
  return { root, outside };
}

function fileRequest(root: string, targetPath: string): SupervisedCodingFileEditRequest {
  return {
    ...common(),
    workspaceRoot: root,
    allowedRelativePaths: ["src"],
    targetPath,
    fileCount: 1,
    addedLines: 2,
    deletedLines: 1,
  };
}

function commandRequest(
  executable: string,
  args: readonly string[],
): SupervisedCodingCommandRequest {
  return {
    ...common(),
    executable,
    args,
    passedCount: 12,
    failedCount: 0,
    skippedCount: 1,
  };
}

function mutationRequest(
  patch: Partial<SupervisedCodingMutationRequest> = {},
): SupervisedCodingMutationRequest {
  return {
    ...common(),
    actionKind: "push",
    requestId: "perm-1992",
    scopeDigest: "a".repeat(64),
    expiresAt: "2026-07-07T22:10:00.000Z",
    nowIso: "2026-07-07T22:05:00.000Z",
    ...patch,
  };
}

function consumedApproval(
  patch: Partial<SupervisedCodingConsumedApproval> = {},
): SupervisedCodingConsumedApproval {
  return {
    approvalDigest: "c".repeat(64),
    approvedByUserId: "operator",
    approvedAtMs: 1_000,
    expiresAtMs: 2_000,
    ...patch,
  };
}

function approvalBinding(
  patch: Partial<SupervisedCodingApprovalBinding> = {},
): SupervisedCodingApprovalBinding {
  const base = {
    runId: "run-1992",
    requestId: "perm-1992",
    actionKind: "push",
    connectorScopes: [],
  } as const;
  const scoped = { ...base, ...patch };
  return {
    ...scoped,
    scopeDigest:
      patch.scopeDigest ??
      supervisedCodingApprovalScopeDigest({
        runId: scoped.runId,
        requestId: scoped.requestId,
        actionKind: scoped.actionKind,
        connectorScopes: scoped.connectorScopes,
      }),
  };
}

describe("supervised coding policy", () => {
  it("allows scoped file edits inside the selected worktree and allowed path scope", () => {
    const { root } = workspaceFixture();

    const result = decideSupervisedFileEdit(fileRequest(root, "src/allowed.ts"));

    expect(result.status).toBe("allowed");
    expect(result.reason).toBe("scoped-file-edit");
    expect(result.evidence).toMatchObject({
      kind: "diff",
      safeSummary: "scoped-file-edit",
      fileCount: 1,
      addedLines: 2,
      deletedLines: 1,
      denied: false,
    });
    expect(validateCodingWorkbenchEvidenceRecord(result.evidence).ok).toBe(true);
  });

  it("fails closed for file edits outside the worktree, scope, or through escaping symlinks", () => {
    const { root, outside } = workspaceFixture();

    const cases = ["../outside.ts", join(outside, "secret.ts"), "src/escape.ts", "package.json"];

    for (const targetPath of cases) {
      const result = decideSupervisedFileEdit(fileRequest(root, targetPath));
      expect(result.status).toBe("denied");
      expect(result.reason).toBe("out-of-scope-file-edit");
      expect(result.evidence.safeSummary).toBe("out-of-scope-file-edit");
    }
  });

  it("allows configured verification commands and persists only counts", () => {
    const result = decideSupervisedVerificationCommand(commandRequest("npm", ["run", "typecheck"]));

    expect(result.status).toBe("allowed");
    expect(result.reason).toBe("allowlisted-verification-command");
    expect(result.evidence).toMatchObject({
      kind: "verification",
      safeSummary: "allowlisted-verification-command",
      passedCount: 12,
      failedCount: 0,
      skippedCount: 1,
      denied: false,
    });
    expect(JSON.stringify(result.evidence)).not.toMatch(/stdout|stderr|npm run typecheck|secret/u);
  });

  it("denies unknown or mutating commands before execution", () => {
    expect(
      decideSupervisedVerificationCommand(commandRequest("npm", ["run", "build"])),
    ).toMatchObject({ status: "denied", reason: "unknown-command-denied" });
    expect(
      decideSupervisedVerificationCommand(commandRequest("git", ["commit", "-m", "x"])),
    ).toMatchObject({ status: "denied", reason: "mutating-command-denied" });
    expect(
      decideSupervisedVerificationCommand(commandRequest("gh", ["pr", "create"])),
    ).toMatchObject({ status: "denied", reason: "mutating-command-denied" });
  });

  it("requires consumed server-side approval for delivery and external mutations", () => {
    const missing = decideSupervisedMutation(mutationRequest());
    const valid = decideSupervisedMutation(mutationRequest({ approval: consumedApproval() }));
    const external = decideSupervisedMutation(mutationRequest({ actionKind: "external-write" }));

    expect(missing.status).toBe("approval-required");
    expect(missing.permissionRequest).toMatchObject({
      actionKind: "push",
      kind: "delivery-substrate",
      risk: "high",
      policyReason: "approval-required",
      scopeLabel: "workspace-scope",
    });
    expect(valid).toMatchObject({ status: "allowed", reason: "approval-proof-accepted" });
    expect(valid.evidence.digest).toBe("c".repeat(64));
    expect(external.permissionRequest).toMatchObject({
      actionKind: "external-write",
      kind: "connector-access",
      connectorScopes: ["issue-tracker.write"],
    });
  });

  it("lets the operator stop before or during approval without executing the mutation", () => {
    const result = decideSupervisedMutation(
      mutationRequest({ approval: consumedApproval(), operatorStopped: true }),
    );

    expect(result).toMatchObject({ status: "denied", reason: "operator-stopped" });
    expect(result.evidence).toMatchObject({
      kind: "failure",
      safeSummary: "operator-stopped",
      denied: true,
    });
  });

  it("rejects forged approval claims and consumes valid claims only once", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const binding = approvalBinding();
    const issued = store.issue({
      binding,
      approvedByUserId: "operator",
      nowMs: 1_000,
      ttlMs: 1_000,
    });
    const forged: SupervisedCodingApprovalClaim = {
      approvalId: issued.approval.approvalId,
      approvalToken: "f".repeat(64),
    };

    expect(store.consume({ approval: forged, binding, nowMs: 1_001 })).toBeUndefined();
    const consumed = store.consume({ approval: issued.approval, binding, nowMs: 1_001 });
    expect(consumed).toMatchObject({
      approvalDigest: issued.approvalDigest,
      approvedByUserId: "operator",
      approvedAtMs: 1_000,
      expiresAtMs: 2_000,
    });
    expect(store.consume({ approval: issued.approval, binding, nowMs: 1_002 })).toBeUndefined();
    expect(JSON.stringify(consumed)).not.toContain(issued.approval.approvalToken);
  });

  it("binds approval claims to request, action, scope digest, and connector scopes", () => {
    const cases: readonly SupervisedCodingApprovalBinding[] = [
      approvalBinding({ requestId: "perm-1992-other" }),
      approvalBinding({ actionKind: "merge" }),
      approvalBinding({ scopeDigest: "d".repeat(64) }),
      approvalBinding({ connectorScopes: ["source-control.write"] }),
    ];

    cases.forEach((mismatch, index) => {
      const store = createInMemorySupervisedCodingApprovalStore();
      const issued = store.issue({
        binding: approvalBinding({ connectorScopes: ["issue-tracker.write"] }),
        approvedByUserId: "operator",
        nowMs: 1_000 + index,
      });

      expect(
        store.consume({
          approval: issued.approval,
          binding: mismatch,
          nowMs: 1_001 + index,
        }),
      ).toBeUndefined();
    });
  });

  it("expires approval claims without exposing token material", () => {
    const store = createInMemorySupervisedCodingApprovalStore();
    const binding = approvalBinding();
    const issued = store.issue({
      binding,
      approvedByUserId: "operator",
      nowMs: 1_000,
      ttlMs: 100,
    });

    expect(store.consume({ approval: issued.approval, binding, nowMs: 1_101 })).toBeUndefined();
    expect(JSON.stringify(issued)).not.toContain(`"tokenDigest"`);
  });
});
