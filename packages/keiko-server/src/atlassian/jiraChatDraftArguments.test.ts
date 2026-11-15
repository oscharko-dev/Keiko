import { describe, expect, it } from "vitest";
import { JIRA_DRAFT_PROBLEMS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  draftProblemData,
  draftRefusalData,
  jiraDraftProblemGuidance,
  readableChatDraft,
} from "./jiraChatDraftArguments.js";
import { jiraMutationDeclarations } from "./jiraManagedMutationDescriptors.js";

const ITEM = { ref: "a", projectId: "10000", issueTypeId: "10001", fields: { summary: "S" } };

function refusal(args: Record<string, unknown>): Record<string, unknown> {
  const checked = readableChatDraft(undefined, "chat-1", args);
  if (checked.ok) throw new TypeError("The draft was expected to be refused");
  return draftRefusalData(checked);
}

describe("the closed problem a refused draft reports (#4355)", () => {
  it.each(JIRA_DRAFT_PROBLEMS)(
    "%s carries its code, the model guidance and no draft content",
    (problem) => {
      const data = draftProblemData(problem, 2);
      expect(data).toEqual({
        guidance: jiraDraftProblemGuidance(problem, 2),
        draftProblem: problem,
        draftItem: 2,
      });
      expect(draftProblemData(problem, undefined)).not.toHaveProperty("draftItem");
    },
  );

  it("names the problem of a draft without items", () => {
    expect(refusal({})).toMatchObject({
      outcome: "rejected",
      reason: "field-validation",
      draftRefusal: "draft-invalid",
      draftProblem: "items-missing",
      items: [],
    });
    expect(refusal({})).not.toHaveProperty("draftItem");
  });

  it("names the problem and the place of the item that is at fault", () => {
    expect(refusal({ items: [ITEM, ITEM] })).toMatchObject({ draftProblem: "ref-duplicate" });
    expect(refusal({ items: [{ ...ITEM, fields: {} }] })).toMatchObject({
      draftProblem: "item-fields",
      draftItem: 1,
    });
  });

  it("declares both members in the draft result schema", () => {
    const draft = jiraMutationDeclarations().find(
      (declaration) => declaration.descriptor.toolRef.canonicalId === "keiko.jira.draft",
    );
    const properties = JSON.stringify(draft?.descriptor.resultSchema);
    expect(properties).toContain("draftProblem");
    expect(properties).toContain("draftItem");
  });
});
