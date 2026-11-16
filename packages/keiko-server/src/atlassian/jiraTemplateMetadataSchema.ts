import { JIRA_ISSUE_TEMPLATE_LIMITS as LIMITS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";

const COUNT = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
function strings(length: number): CatalogJsonObject {
  return { type: "array", maxItems: LIMITS.listItems, items: text(length) };
}

/** Parsed rule facts are ordinary tool metadata, never another selected skill instruction. */
export const JIRA_APPLICABLE_TEMPLATES_SCHEMA = object(
  {
    items: {
      type: "array",
      maxItems: 8,
      items: object(
        {
          project: text(LIMITS.keyChars),
          issueType: text(LIMITS.keyChars),
          operation: { type: "string", enum: ["create"] },
          source: object(
            { id: text(128), revision: COUNT, digest: { ...text(64), pattern: "^[a-f0-9]{64}$" } },
            ["id", "revision", "digest"],
          ),
          summary: object({
            minLength: COUNT,
            maxLength: COUNT,
            pattern: text(LIMITS.patternChars),
          }),
          requiredFields: strings(LIMITS.textChars),
          requiredSections: strings(LIMITS.textChars),
          labels: object(
            {
              required: strings(LIMITS.labelChars),
              minCount: COUNT,
              pattern: text(LIMITS.patternChars),
            },
            ["required"],
          ),
          parent: object({
            field: text(LIMITS.textChars),
            link: text(LIMITS.textChars),
            issueTypes: strings(LIMITS.textChars),
          }),
        },
        [
          "project",
          "issueType",
          "operation",
          "source",
          "summary",
          "requiredFields",
          "requiredSections",
          "labels",
          "parent",
        ],
      ),
    },
    matchedCount: COUNT,
    omittedCount: COUNT,
    unreadableCount: COUNT,
    complete: { type: "boolean" },
  },
  ["items", "matchedCount", "omittedCount", "unreadableCount", "complete"],
);
