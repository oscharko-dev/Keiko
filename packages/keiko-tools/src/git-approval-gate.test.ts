// KEIKO-0147 — semantics of the shared required-approver membership check.
//
// The four governed delivery gates (merge, publish, PR, local mutation) each call this one
// predicate. The per-gateway tests prove each gate is wired to it; this file pins the SEMANTICS
// once, so a future change to the rule cannot silently alter what "authorized" means on all four
// surfaces at the same time.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  GitDeliveryApprovalRequirement,
  GitDeliveryPolicyDecision,
} from "@oscharko-dev/keiko-contracts";
import { approverIsNotAuthorized } from "./git-approval-gate.js";

const grantedBy = (approvedByUserId: string): GitDeliveryApprovalRequirement => ({
  required: true,
  approvalTokenHash: "a".repeat(64),
  approvedByUserId,
  approvedAtMs: 1,
});

const NOT_REQUIRED: GitDeliveryApprovalRequirement = { required: false };

const gatedOn = (requiredApprovers: readonly string[]): GitDeliveryPolicyDecision => ({
  outcome: "approval-gated",
  requiredApprovers,
});

describe("approverIsNotAuthorized (KEIKO-0147)", () => {
  it("blocks an approval granted by someone outside the required set", () => {
    expect(approverIsNotAuthorized(gatedOn(["alice"]), grantedBy("bob"))).toBe(true);
  });

  it("admits an approval granted by a member of the required set", () => {
    expect(approverIsNotAuthorized(gatedOn(["alice", "carol"]), grantedBy("carol"))).toBe(false);
  });

  // ADR-0080 D5: an EMPTY required-approver array means "any authenticated approval". Turning
  // that into "nobody may approve" would break every deployment using the default policy pack;
  // turning it into a no-op check is the bug this finding was raised against. Both directions
  // are pinned here.
  it("treats an empty required-approver set as 'any authenticated approval'", () => {
    expect(approverIsNotAuthorized(gatedOn([]), grantedBy("anyone"))).toBe(false);
  });

  it("never blocks when the decision does not require approval at all", () => {
    const allowed: GitDeliveryPolicyDecision = { outcome: "allowed" };
    expect(approverIsNotAuthorized(allowed, grantedBy("bob"))).toBe(false);
  });

  // `approvedByUserId` exists only on the `required: true` branch of the union, so a
  // not-required approval carries no identity to match and must never be blocked here.
  it("never blocks a not-required approval", () => {
    expect(approverIsNotAuthorized(gatedOn(["alice"]), NOT_REQUIRED)).toBe(false);
  });

  it("matches the identity exactly rather than by substring", () => {
    // "ali" must not satisfy a requirement for "alice", and vice versa.
    expect(approverIsNotAuthorized(gatedOn(["alice"]), grantedBy("ali"))).toBe(true);
    expect(approverIsNotAuthorized(gatedOn(["ali"]), grantedBy("alice"))).toBe(true);
  });
});

// KEIKO-0535 — structural pin: the wider approval-gate resolution (valid/expired/absent, not just
// the identity check above) used to be reimplemented independently in all four governed delivery
// gateways instead of calling one shared resolver. A behavioral test cannot catch a REintroduced
// local copy — the four copies were, by construction, behaviorally consistent with each other, so
// a fifth consistent copy would pass every existing test while reproducing exactly the divergence
// risk this finding warns about. Read each gateway file's own source text instead: fails today
// (each file defines its own approvalState/approvalIsValid) before the extraction, passes once
// every gateway imports resolveGitDeliveryApprovalGate and none defines a local copy.
describe("approval-gate resolution is not reimplemented per-gateway (KEIKO-0535)", () => {
  const GATEWAY_FILES = [
    "git-mutation-orchestrator.ts",
    "git-merge-gateway.ts",
    "git-publish-gateway.ts",
    "git-pr-gateway.ts",
  ];

  const IMPORTS_SHARED_RESOLVER =
    /import\s*\{[^}]*\bresolveGitDeliveryApprovalGate\b[^}]*\}\s*from\s*["']\.\/git-approval-gate\.js["']/;
  const LOCAL_STATE_FUNCTION = /function\s+(approvalState|approvalIsValid)\s*\(/;

  it.each(GATEWAY_FILES)("%s imports the shared approval-gate resolver", (file) => {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    expect(source).toMatch(IMPORTS_SHARED_RESOLVER);
  });

  it.each(GATEWAY_FILES)(
    "%s does not define its own local approvalState/approvalIsValid",
    (file) => {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(source).not.toMatch(LOCAL_STATE_FUNCTION);
    },
  );
});
