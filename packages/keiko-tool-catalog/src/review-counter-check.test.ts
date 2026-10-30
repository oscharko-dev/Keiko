import { describe, expect, it } from "vitest";

import { childRegistrationSet } from "./child.js";
import { createKeikoToolCatalog } from "./composer.js";
import { gatewayToolDefinitions } from "./projection.js";
import {
  REVIEW_COUNTER_CHECK_PROFILE,
  REVIEW_COUNTER_CHECK_TOOL_ALIASES,
  reviewCounterCheckRegistrationSet,
} from "./review-counter-check.js";

describe("review-counter-check registration set (ADR-0182 D5, #4136)", () => {
  it("offers exactly the three read tools and the verdict tool, all workspace-read", () => {
    const catalog = createKeikoToolCatalog([reviewCounterCheckRegistrationSet()]);
    const tools = gatewayToolDefinitions(catalog, REVIEW_COUNTER_CHECK_PROFILE);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      Object.values(REVIEW_COUNTER_CHECK_TOOL_ALIASES).sort(),
    );
    for (const entry of reviewCounterCheckRegistrationSet().entries) {
      expect(entry.descriptor.effects).toEqual(["workspace-read"]);
    }
  });

  it("composes beside the reserved child profile without sharing an alias", () => {
    const catalog = createKeikoToolCatalog([
      childRegistrationSet(),
      reviewCounterCheckRegistrationSet(),
    ]);
    const child = gatewayToolDefinitions(catalog, { id: "child", version: 1 });
    expect(child.map((tool) => tool.name)).toEqual(["keiko_child_workspace_read"]);
    const counter = gatewayToolDefinitions(catalog, REVIEW_COUNTER_CHECK_PROFILE);
    expect(counter.map((tool) => tool.name)).not.toContain("keiko_child_workspace_read");
  });
});
