import type { GitRepositoryAgentOperationKind } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { gitOperationRequirement } from "./gitOperationRequirements.js";

/**
 * This table is the authority-to-operation contract of every mounted Git-delivery route:
 * `authorizeGitDelivery` reads it to decide which action classes, connector scopes and network
 * permission an operation demands. Weakening one row silently widens what a run may do.
 *
 * It had no test of its own. The only coverage was indirect, through
 * `autonomousDeliveryPolicy.test.ts`, and #2958 deleted that file with the unmounted scaffolding it
 * belonged to — so the pin lapsed rather than moving, contrary to what that change claimed.
 * Verified by mutation: replacing `COMMIT_REQUIREMENT` with `requirement([], [], false)` left the
 * entire suite green while `commitRoutes.ts` would have admitted a commit carrying neither
 * `delivery-substrate` nor `source-control.write`.
 *
 * Every row is asserted exactly, so a removal, an addition and a substitution all fail.
 */
const EXPECTED: Readonly<
  Record<
    GitRepositoryAgentOperationKind,
    {
      readonly actionClasses: readonly string[];
      readonly connectorScopes: readonly string[];
      readonly needsNetwork: boolean;
    }
  >
> = {
  status: {
    actionClasses: ["workspace-read"],
    connectorScopes: ["source-control.read"],
    needsNetwork: false,
  },
  diff: {
    actionClasses: ["workspace-read"],
    connectorScopes: ["source-control.read"],
    needsNetwork: false,
  },
  "branch-list": {
    actionClasses: ["workspace-read"],
    connectorScopes: ["source-control.read"],
    needsNetwork: false,
  },
  "branch-create": {
    actionClasses: ["workspace-write"],
    connectorScopes: ["source-control.write"],
    needsNetwork: false,
  },
  "branch-switch": {
    actionClasses: ["workspace-write"],
    connectorScopes: ["source-control.write"],
    needsNetwork: false,
  },
  stage: {
    actionClasses: ["workspace-write"],
    connectorScopes: ["source-control.write"],
    needsNetwork: false,
  },
  unstage: {
    actionClasses: ["workspace-write"],
    connectorScopes: ["source-control.write"],
    needsNetwork: false,
  },
  commit: {
    actionClasses: ["delivery-substrate"],
    connectorScopes: ["source-control.write"],
    needsNetwork: false,
  },
  fetch: {
    actionClasses: ["delivery-substrate", "network-egress"],
    connectorScopes: ["source-control.read"],
    needsNetwork: true,
  },
  pull: {
    actionClasses: ["delivery-substrate", "network-egress"],
    connectorScopes: ["source-control.write"],
    needsNetwork: true,
  },
  push: {
    actionClasses: ["delivery-substrate", "network-egress"],
    connectorScopes: ["source-control.write"],
    needsNetwork: true,
  },
  "pull-request": {
    actionClasses: ["delivery-substrate", "network-egress"],
    connectorScopes: ["source-control.write"],
    needsNetwork: true,
  },
  merge: {
    actionClasses: ["delivery-substrate", "network-egress"],
    connectorScopes: ["source-control.write"],
    needsNetwork: true,
  },
};

describe("git operation requirements (#2958 relocated pin)", () => {
  it.each(Object.keys(EXPECTED) as GitRepositoryAgentOperationKind[])(
    "demands the exact authority recorded for %s",
    (operation) => {
      expect(gitOperationRequirement(operation)).toEqual(EXPECTED[operation]);
    },
  );

  // The properties that matter independently of the exact table, so a future row cannot quietly
  // drop a class the boundary depends on.
  it("never admits an operation with no authority requirement at all", () => {
    for (const operation of Object.keys(EXPECTED) as GitRepositoryAgentOperationKind[]) {
      const requirement = gitOperationRequirement(operation);
      expect(requirement.actionClasses.length, operation).toBeGreaterThan(0);
      expect(requirement.connectorScopes.length, operation).toBeGreaterThan(0);
    }
  });

  it("requires delivery-substrate for every operation that writes history or a remote", () => {
    for (const operation of ["commit", "fetch", "pull", "push", "pull-request", "merge"] as const) {
      expect(gitOperationRequirement(operation).actionClasses, operation).toContain(
        "delivery-substrate",
      );
    }
  });

  it("requires network-egress exactly for the operations that reach a remote", () => {
    for (const operation of Object.keys(EXPECTED) as GitRepositoryAgentOperationKind[]) {
      const requirement = gitOperationRequirement(operation);
      expect(requirement.actionClasses.includes("network-egress"), operation).toBe(
        requirement.needsNetwork,
      );
    }
  });

  it("never lets a read operation carry a write scope", () => {
    for (const operation of ["status", "diff", "branch-list", "fetch"] as const) {
      expect(gitOperationRequirement(operation).connectorScopes, operation).not.toContain(
        "source-control.write",
      );
    }
  });
});
