import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  codingWorkbenchPolicyEffectFor,
  decideCodingWorkbenchActionForMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { describe, expect, it } from "vitest";

describe("coding autonomy closeout QA matrix", () => {
  it("keeps class admission separate from the three scope and risk policies", () => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"] as const) {
      expect(
        CODING_WORKBENCH_ACTION_CLASSES.every(
          (actionClass) => decideCodingWorkbenchActionForMode(mode, actionClass).allowed,
        ),
      ).toBe(true);
    }

    expect(
      codingWorkbenchPolicyEffectFor("governed-assist", "workspace-contained", "critical"),
    ).toBe("approval-required");
    expect(codingWorkbenchPolicyEffectFor("governed-assist", "external-file", "low")).toBe(
      "approval-required",
    );
    expect(codingWorkbenchPolicyEffectFor("governed-assist", "internet", "low")).toBe(
      "approval-required",
    );
    expect(codingWorkbenchPolicyEffectFor("supervised-coding", "external-file", "medium")).toBe(
      "approval-required",
    );
    expect(codingWorkbenchPolicyEffectFor("supervised-coding", "internet", "high")).toBe(
      "approval-required",
    );
    expect(codingWorkbenchPolicyEffectFor("autonomous-delivery", "internet", "critical")).toBe(
      "allowed",
    );
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"] as const) {
      expect(codingWorkbenchPolicyEffectFor(mode, "delivery", "low")).toBe("approval-required");
    }
  });

  it.each([
    [
      "portable sidecar launch from managed install",
      "packages/keiko-server/src/coding-runtime/codingRuntimeManager.test.ts",
      "resolves launch paths from a verified portable sidecar payload",
    ],
    [
      "Model Gateway fake-provider sidecar routing",
      "packages/keiko-server/src/coding-sidecar-gateway.test.ts",
      "fails closed when a runtime gateway route has no capability authenticator",
    ],
    [
      "ChatGPT/Codex subscription isolation",
      "packages/keiko-server/src/coding-codex-subscription.test.ts",
      "rejects access-token setup bodies that try to send the token to Keiko",
    ],
    [
      "Autonomous Delivery UI/a11y closeout",
      "tests/e2e/coding-workbench-1994.spec.ts",
      "autonomous closeout narrow viewport has no horizontal overflow",
    ],
    [
      "operator runbook three-mode policy",
      "docs/qa/coding-workbench-operator-runbook.md",
      "| **Ask for approval** | `governed-assist`",
    ],
    [
      "operator runbook delivery boundary",
      "docs/qa/coding-workbench-operator-runbook.md",
      "require separate explicit human approval in all three modes",
    ],
    // #2958 (KEIKO-0115/KEIKO-0135) deleted the unmounted `autonomousDeliveryPolicy.ts` this file
    // used to assert against, and the boundaries it covered moved to the layer that admits the
    // mounted Git-delivery routes.
    //
    // Every anchor below is a CASE TITLE, never a comment or an identifier. An earlier revision of
    // this ledger pointed at a comment ("relocated from codingAutonomyQaMatrix.test.ts"), which
    // survives deleting every case it described — the row stayed green over coverage that had
    // vanished, which is precisely the failure this ledger exists to prevent.
    [
      "per-operation delivery admission",
      "packages/keiko-server/src/gitDelivery/runBoundAuthority.test.ts",
      "denies %s when the envelope lacks the classes or scopes it requires",
    ],
    [
      "network-bound operations refused without network authority",
      "packages/keiko-server/src/gitDelivery/runBoundAuthority.test.ts",
      "denies %s under a deny-all network policy, because it reaches a remote",
    ],
    [
      "authority-to-operation requirement table",
      "packages/keiko-server/src/coding-runtime/gitOperationRequirements.test.ts",
      "demands the exact authority recorded for %s",
    ],
    [
      "delivery-substrate required for history and remote writes",
      "packages/keiko-server/src/coding-runtime/gitOperationRequirements.test.ts",
      "requires delivery-substrate for every operation that writes history or a remote",
    ],
    [
      "one-use approval replay, expiry, and envelope binding",
      "packages/keiko-server/src/gitDelivery/approvalStore.test.ts",
      "rejects a claim replayed under a different runtime Authority Envelope",
    ],
  ] as const)("keeps %s proof wired into the closeout ledger", (_label, filePath, expectedText) => {
    const absolutePath = resolve(process.cwd(), filePath);
    expect(existsSync(absolutePath), filePath).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toContain(expectedText);
  });
});
