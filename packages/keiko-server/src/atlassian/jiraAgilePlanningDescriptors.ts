import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraFieldIdSchema as FIELD } from "./jiraScopedDirectoryDescriptors.js";
import {
  jiraNativeDeclaration,
  jiraNativeProjectSchema as KEY,
  jiraNativeIdentitySchema as ID,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const NUMERIC_ID = {
  ...ID,
  maxLength: 16,
  description:
    "Positive canonical decimal string no greater than 9007199254740991; the native request body uses an exact JSON integer.",
};
const nullable = (value: CatalogJsonObject): CatalogJsonObject => ({
  anyOf: [value, { type: "null" }],
});
const RANK = nullable({ ...text(2048), minLength: 1 });
const NATIVE_VALUE = {
  anyOf: [
    { type: "number", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    text(2048),
    { type: "null" },
  ],
};
const DECIMAL = {
  ...text(22),
  minLength: 1,
  description:
    "Nonnegative decimal text with up to 15 integer and 6 fractional digits, exact bounded coefficient. Numeric original-estimate input is minutes, not seconds; the adapter requires an exact whole-second result.",
};
const DIRECTION = { type: "string", enum: ["before", "after"] };
const IDS = { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: ID };
const KEYS = { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: KEY };
const ACTOR = { expectedActorKey: NAME };
const BOARD = { ...ACTOR, boardId: NUMERIC_ID, expectedBoardName: NAME };
const RANK_INPUT = {
  ...BOARD,
  rankCustomFieldId: NUMERIC_ID,
  direction: DIRECTION,
  expectedAnchorRank: RANK,
};
const RANK_REQUIRED = [
  "expectedActorKey",
  "boardId",
  "expectedBoardName",
  "rankCustomFieldId",
  "direction",
  "expectedAnchorRank",
];
const RANK_RECEIPT = {
  userKey: NAME,
  boardId: NUMERIC_ID,
  fieldId: FIELD,
  issueIds: IDS,
  issueKeys: KEYS,
  anchorIssueId: ID,
  anchorIssueKey: KEY,
  rankDirection: DIRECTION,
};
const COMMON =
  "One high-risk fixed native effect through the existing authority/journal and bounded Agile phase owners. The connected actor and every selected native identity are independently bound. Explicit reviewed values can become stale: native Jira remains the permission/constraint authority and this is not atomic compare-and-swap. Saved formal edit rules apply before effects; missing or unprovable affected field values never satisfy required/parent rules. An acknowledged or uncertain result must not be replayed. No caller URL, raw headers, arbitrary fields or methods are accepted.";
function write(
  description: string,
  input: CatalogJsonObject,
  fields: CatalogJsonObject,
): JiraNativeDefinition {
  return {
    description: `${description} ${COMMON}`,
    input,
    result: jiraNativeWriteResult(fields),
    risk: "write",
    maxResultCount: 1,
  };
}
export const JIRA_AGILE_PLANNING_WRITE_DEFINITIONS = {
  "jira.epic-remove-issues": write(
    "Remove up to 50 selected issues from their reviewed epics. Each expectedEpic is an explicitly observed {id,key} or null, never inferred from missing native fields. Bind both direct issue Epic Link and Agile epic membership, and independently bind non-null epics. Set the exact native Epic Link field to absent in saved formal admission. POST /epic/none/issue once; confirmation requires a fresh explicit null relationship and Epic Link for every selected issue. Already-null selections are unchanged without a write. The receipt epicPresent=false describes the requested target until confirmation.",
    object(
      {
        ...ACTOR,
        issues: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: object(
            {
              issueIdOrKey: KEY,
              expectedEpic: nullable(object({ id: ID, key: KEY }, ["id", "key"])),
            },
            ["issueIdOrKey", "expectedEpic"],
          ),
        },
      },
      ["expectedActorKey", "issues"],
    ),
    {
      userKey: NAME,
      issueIds: IDS,
      issueKeys: KEYS,
      epicPresent: { type: "boolean", enum: [false] },
    },
  ),
  "jira.rank-epic": write(
    "Rank one independently bound epic before or after another epic using the exact reviewed board rank field. expectedRank and expectedAnchorRank are opaque native current values, including explicitly observed null. Both issues must be visible in the queried board subset, which is not an entire population. The anchor may itself enter the global rank index; formal field admission covers both. After one PUT, fresh identities and rank fields are read, but global absolute order is not independently proven: retain the receipt as unconfirmed, never infer success/no-op from visible relative order or lexical rank strings.",
    object({ ...RANK_INPUT, epicIdOrKey: KEY, expectedRank: RANK, anchorEpicIdOrKey: KEY }, [
      ...RANK_REQUIRED,
      "epicIdOrKey",
      "expectedRank",
      "anchorEpicIdOrKey",
    ]),
    RANK_RECEIPT,
  ),
  "jira.rank-issues": write(
    "Rank an ordered group of up to 50 distinct issues before or after a distinct anchor, using the reviewed board's explicit native rank field. Bind each current opaque rank and the anchor, prove only their visible board subset, and apply formal rules to all potentially affected identities. Native HTTP 207 can mean partial per-issue effects and is never treated as a no-effect rejection or blanket success. Exactly one PUT; independent reads retain known identities, while global rank outcome remains unconfirmed. No automatic retry.",
    object(
      {
        ...RANK_INPUT,
        anchorIssueIdOrKey: KEY,
        issues: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: object({ issueIdOrKey: KEY, expectedRank: RANK }, [
            "issueIdOrKey",
            "expectedRank",
          ]),
        },
      },
      [...RANK_REQUIRED, "anchorIssueIdOrKey", "issues"],
    ),
    RANK_RECEIPT,
  ),
  "jira.set-issue-estimation": write(
    "Set one issue's numeric board estimation using an explicit native fieldId, current expectedValue and unit. Read the exact board configuration, native numeric field definition, direct issue field and board estimation; omitted values are unavailable, observed null and zero are distinct. unit=minutes is accepted only for timeoriginalestimate and is converted for verification to native whole seconds; board-number claims no points/unit semantics. value is native decimal STRING text. Clearing with null or duration text with configured day/week lengths is not implemented. Native original-estimate effects on remaining estimate/timetracking are unknown to formal admission. One PUT with boardId; confirm only from fresh matching board/field/issue and exact native numeric value. Receipt value/unit remain requested target facts until confirmed.",
    object(
      {
        ...BOARD,
        issueIdOrKey: KEY,
        fieldId: FIELD,
        expectedValue: NATIVE_VALUE,
        unit: { type: "string", enum: ["minutes", "board-number"] },
        value: DECIMAL,
      },
      [
        "expectedActorKey",
        "boardId",
        "expectedBoardName",
        "issueIdOrKey",
        "fieldId",
        "expectedValue",
        "unit",
        "value",
      ],
    ),
    {
      userKey: NAME,
      boardId: NUMERIC_ID,
      fieldId: FIELD,
      issueId: ID,
      issueKey: KEY,
      estimationValue: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      estimationUnit: { type: "string", enum: ["seconds", "board-number"] },
    },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraAgilePlanningDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_AGILE_PLANNING_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
