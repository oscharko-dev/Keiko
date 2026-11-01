import { describe, expect, it } from "vitest";
import type { JiraFieldMetadata } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { dispatchFailure, nameJiraFieldErrors } from "./jira-mutation-failure.js";

function metadata(id: string, name: string): JiraFieldMetadata {
  return {
    id,
    name,
    required: false,
    hasDefaultValue: false,
    kind: "text",
    richText: false,
    operations: ["set"],
  };
}

const FIELDS = [metadata("customfield_10000", "Risk class"), metadata("summary", "Summary")];

describe("naming the fields Jira refused (#4176)", () => {
  it("adds the display name the request's metadata knows, beside Jira's id and message", () => {
    const detail = nameJiraFieldErrors(
      {
        fieldErrors: [
          { fieldId: "customfield_10000", message: "Option is not valid." },
          { fieldId: "customfield_99999", message: "Field cannot be set." },
        ],
        messages: ["Issue could not be created."],
      },
      FIELDS,
    );

    expect(detail).toEqual({
      fieldErrors: [
        { fieldId: "customfield_10000", fieldName: "Risk class", message: "Option is not valid." },
        { fieldId: "customfield_99999", message: "Field cannot be set." },
      ],
      messages: ["Issue could not be created."],
    });
  });

  it("leaves a detail without field errors or without metadata as it is", () => {
    const messagesOnly = { messages: ["Comment is invalid."] };
    const unnamed = { fieldErrors: [{ fieldId: "summary", message: "Too long." }] };

    expect(nameJiraFieldErrors(messagesOnly, FIELDS)).toBe(messagesOnly);
    expect(nameJiraFieldErrors(unnamed, [])).toBe(unnamed);
    expect(nameJiraFieldErrors(undefined, FIELDS)).toBeUndefined();
  });

  it("bounds a long field name like any other text Jira's metadata supplies", () => {
    const detail = nameJiraFieldErrors(
      { fieldErrors: [{ fieldId: "summary", message: "Too long." }] },
      [metadata("summary", `${"N".repeat(400)}\nline`)],
    );

    const name = detail?.fieldErrors?.[0]?.fieldName ?? "";
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name).not.toContain("\n");
  });

  it("carries the named detail on the dispatch failure", () => {
    expect(
      dispatchFailure(
        {
          ok: false,
          reason: "field-validation",
          httpStatus: 400,
          remote: { fieldErrors: [{ fieldId: "summary", message: "Too long." }] },
        },
        FIELDS,
      ),
    ).toEqual({
      ok: false,
      reason: "field-validation",
      detail: { fieldErrors: [{ fieldId: "summary", fieldName: "Summary", message: "Too long." }] },
    });
  });
});
