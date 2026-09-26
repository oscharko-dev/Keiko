// Focused export-surface coverage for prMarkReadyExecution.ts (owner audit finding b2-18).
//
// `GIT_DELIVERY_PR_MARK_READY_ROUTE_GROUP` was a singleton built once at module load and exported
// alongside `createGitDeliveryPrMarkReadyRouteGroup`, but the mounted production route table
// (prRoutes.ts) calls the factory a SECOND time with its own options rather than importing the
// singleton — so the singleton was dead: never imported anywhere, and (being built at module load
// with no options) not even the same route group instance the product actually serves. A
// `*_ROUTE_GROUP` name that isn't the mounted route group is worse than no name at all, so this
// pins the export surface directly rather than only asserting behaviour.

import { describe, expect, it } from "vitest";
// Keep this as the first non-Vitest import: importing the server first would mask the original
// ESM ordering failure through requestPreparation/routes/agentOperationsRoutes/prRoutes.
import * as prMarkReadyExecution from "./prMarkReadyExecution.js";

describe("prMarkReadyExecution.ts export surface (b2-18)", () => {
  it("exports no unused GIT_DELIVERY_PR_MARK_READY_ROUTE_GROUP singleton", () => {
    expect(Object.hasOwn(prMarkReadyExecution, "GIT_DELIVERY_PR_MARK_READY_ROUTE_GROUP")).toBe(
      false,
    );
  });

  it("still exports the factory the production route table actually calls", () => {
    const group = prMarkReadyExecution.createGitDeliveryPrMarkReadyRouteGroup();
    expect(group.map((route) => `${route.method} ${route.pattern}`)).toEqual([
      "POST /api/git-delivery/pr/mark-ready/approve",
      "POST /api/git-delivery/pr/mark-ready/execute",
    ]);
  });
});
