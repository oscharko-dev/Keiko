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
// `../server.js` first, exactly like the sibling prRoutes.test.ts: several gitDelivery route
// modules (this one included) eagerly build a module-scope route-group constant at import time
// (`export const X_ROUTE_GROUP = createXRouteGroup()`), and those modules also form an import
// cycle with each other through routes.ts/agentOperationsRoutes.ts. Loading prMarkReadyExecution.ts
// as the cold entry point (rather than through the server's own real load order) hits that
// pre-existing circular-import ordering hazard — unrelated to this finding; see the b2-18
// disposition notes.
import "../server.js";
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
