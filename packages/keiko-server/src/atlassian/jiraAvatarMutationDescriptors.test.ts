import { describe, expect, it } from "vitest";
import { JIRA_AVATAR_MUTATIONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { isBoundedExternalJsonSchema } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { AVATAR_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-avatar-mutation-fixture.js";
import {
  JIRA_AVATAR_WRITE_DEFINITIONS,
  jiraAvatarMutationDeclarationForTool as declaration,
} from "./jiraAvatarMutationDescriptors.js";

describe("closed native avatar declarations", () => {
  it("declares exactly the canonical fixed family", () => {
    expect(Object.keys(JIRA_AVATAR_WRITE_DEFINITIONS)).toEqual([...JIRA_AVATAR_MUTATIONS]);
    expect(AVATAR_MUTATION_FIXTURE_CASES.map((item) => item.name)).toEqual([
      ...JIRA_AVATAR_MUTATIONS,
    ]);
  });
  it.each(AVATAR_MUTATION_FIXTURE_CASES)(
    "admits exact reviewed arguments for $name without a generic image or session port",
    ({ name, args }) => {
      const tool = declaration(name);
      if (tool === undefined) throw new TypeError("Missing avatar declaration");
      expect(tool.risk).toBe("write");
      expect(tool.descriptor.description).toContain("issue-tracker.admin");
      expect(isBoundedExternalJsonSchema(tool.descriptor.inputSchema)).toBe(true);
      expect(isBoundedExternalJsonSchema(tool.descriptor.resultSchema)).toBe(true);
      expect(describeCatalogSchemaMismatch(tool.descriptor.inputSchema, args)).toBeUndefined();
      for (const field of ["url", "bytes", "cookie", "sessionId", "Authorization", "headers"]) {
        expect(
          describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
            ...args,
            [field]: "untrusted",
          }),
        ).toBeDefined();
      }
    },
  );
  it("requires actual selected booleans and exact target kinds", () => {
    const tool = declaration("jira.set-project-avatar");
    if (tool === undefined) throw new TypeError("Missing declaration");
    const args = AVATAR_MUTATION_FIXTURE_CASES[6].args;
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...args,
        expectedAvatars: [{ id: "42", category: "custom" }],
      }),
    ).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(tool.descriptor.inputSchema, {
        ...args,
        target: { kind: "user", key: "a", name: "b" },
      }),
    ).toBeDefined();
  });
  it("does not describe legacy temporary crop as final image selection", () => {
    expect(declaration("jira.crop-temporary-avatar")?.descriptor.description).toContain(
      "not final-avatar creation",
    );
    expect(declaration("jira.upload-temporary-avatar")?.descriptor.description).toContain(
      "absent from pinned11.3",
    );
  });
  it("offers no arbitrary binary upload or session-management tool", () => {
    for (const name of [
      "jira.upload-image",
      "jira.avatar-http",
      "jira.cookie-session",
      "jira.avatar-url",
    ])
      expect(declaration(name)).toBeUndefined();
  });
});
