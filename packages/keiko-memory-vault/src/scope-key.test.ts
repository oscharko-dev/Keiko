import { describe, expect, it } from "vitest";
import type {
  MemoryScope,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { scopeCoordinateOf, scopeKindOf } from "./scope-key.js";

const userScope: MemoryScope = { kind: "user", userId: "u-1" as UserId };
const workspaceScope: MemoryScope = {
  kind: "workspace",
  workspaceId: "u-1" as WorkspaceId,
};
const projectScope: MemoryScope = { kind: "project", projectId: "p-1" as ProjectId };
const workflowScope: MemoryScope = {
  kind: "workflow",
  workflowDefinitionId: "wf-1" as WorkflowDefinitionId,
};
const globalScope: MemoryScope = { kind: "global" };

describe("scopeKindOf", () => {
  it("returns the discriminator", () => {
    expect(scopeKindOf(userScope)).toBe("user");
    expect(scopeKindOf(workspaceScope)).toBe("workspace");
    expect(scopeKindOf(projectScope)).toBe("project");
    expect(scopeKindOf(workflowScope)).toBe("workflow");
    expect(scopeKindOf(globalScope)).toBe("global");
  });
});

describe("scopeCoordinateOf", () => {
  it("returns the kind-specific id verbatim", () => {
    expect(scopeCoordinateOf(userScope)).toBe("u-1");
    expect(scopeCoordinateOf(workspaceScope)).toBe("u-1");
    expect(scopeCoordinateOf(projectScope)).toBe("p-1");
    expect(scopeCoordinateOf(workflowScope)).toBe("wf-1");
  });

  it("returns the empty string for global", () => {
    expect(scopeCoordinateOf(globalScope)).toBe("");
  });

  it("does NOT prefix with kind so the SQL filter must use both columns", () => {
    // Regression guard: two scopes that share a coordinate value at different kinds must
    // produce identical coordinate strings. Kind disjointness is the storage layer's job,
    // not the encoder's. Collapsing kind into the encoded string would hide the bug class
    // we are protecting against (kind:user, id:u-1) vs (kind:workspace, id:u-1).
    expect(scopeCoordinateOf(userScope)).toBe(scopeCoordinateOf(workspaceScope));
    expect(scopeKindOf(userScope)).not.toBe(scopeKindOf(workspaceScope));
  });
});
