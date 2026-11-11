import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const ID = {
  ...text(16),
  minLength: 1,
  allOf: [{ pattern: "^[1-9]" }, { pattern: "^[0-9]{1,16}$" }],
  description:
    "Canonical positive decimal string no greater than 9007199254740991; native bodies use exact JSON integers.",
};
const NAME = { ...text(255), minLength: 1 };
const DATE = {
  ...text(40),
  minLength: 1,
  description: "A real ISO timestamp including Z or an explicit UTC offset.",
};
const BOOL = { type: "boolean" };
const STATE = { type: "string", enum: ["future", "active", "closed"] };
const nullable = (schema: CatalogJsonObject): CatalogJsonObject => ({
  anyOf: [schema, { type: "null" }],
});
const FIELDS = {
  name: NAME,
  state: STATE,
  startDate: nullable(DATE),
  endDate: nullable(DATE),
  goal: nullable(text(2048)),
  autoStartStop: BOOL,
  incompleteIssuesDestinationId: nullable(ID),
};
const SNAPSHOT = object(
  {
    id: ID,
    originBoardId: ID,
    ...FIELDS,
    synced: BOOL,
    activatedDate: nullable(DATE),
    completeDate: nullable(DATE),
  },
  ["id", "originBoardId", "name", "state"],
);
export { SNAPSHOT as jiraSprintLifecycleSnapshotSchema };
const REPLACEMENT = object(FIELDS, [
  "name",
  "state",
  "startDate",
  "endDate",
  "goal",
  "autoStartStop",
  "incompleteIssuesDestinationId",
]);
const SELECTED = { expectedActorKey: NAME, sprintId: ID, expectedSprint: SNAPSHOT };
const REQUIRED = ["expectedActorKey", "sprintId", "expectedSprint"];
const IDS = { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: ID };
const SAMPLE = { type: "array", minItems: 1, maxItems: 50, items: SNAPSHOT };
const COMMON =
  "One high-risk native effect in the existing governed Jira journal. Bind the current actor, exact sprint identities, complete reviewed native metadata and each accessible Scrum origin board before writing; recheck after admission. Optional snapshot fields retain observed omission versus explicit null. Missing flags/dates never become false/null. Jira enforces native permissions; a pre-read is not atomic compare-and-swap. An acknowledged or uncertain operation is never automatically replayed. Visible board/issue lists do not prove an actor-independent population. Saved formal edit rules governing implicit sprint-field changes refuse before bulk membership effects when complete issue post-state cannot be proven.";
function write(
  description: string,
  input: CatalogJsonObject,
  receipt: CatalogJsonObject,
): JiraNativeDefinition {
  return {
    description: `${description} ${COMMON}`,
    input,
    result: jiraNativeWriteResult({ userKey: NAME, ...receipt }),
    risk: "write",
    maxResultCount: 1,
  };
}
export const JIRA_SPRINT_LIFECYCLE_WRITE_DEFINITIONS = {
  "jira.replace-sprint": write(
    "Fully replace a sprint with native PUT. All replacement fields are explicit: null clears nullable dates/goal/destination; unlike POST partial update nothing is silently preserved. id, originBoardId and observed synced are preserved from the bound sprint. completeDate/activatedDate are native lifecycle observations and are never model-written. Closed sprints cannot change. Starting requires future state and valid start/end; closing requires active state and may move issues, therefore remains unconfirmed even if visible fields match. Native incomplete-subtask rules still apply. Synced date changes are refused on this ordinary-write route. A non-null incomplete destination requires its exact expectedDestination snapshot. autoStartStop may cause later membership effects and is never claimed fully confirmed.",
    object({ ...SELECTED, replacement: REPLACEMENT, expectedDestination: SNAPSHOT }, [
      ...REQUIRED,
      "replacement",
    ]),
    { sprintId: ID, originBoardId: ID, sprintPresent: BOOL },
  ),
  "jira.delete-sprint": write(
    "Delete a future native sprint only when its observed synced flag is false. Jira moves all issues to backlog; no visible issue count is treated as complete. Even a subsequent 404 and absence from the complete actor-visible board list do not prove all deletion/reassignment effects, so retain known identities as unconfirmed after acknowledgement.",
    object(SELECTED, REQUIRED),
    { sprintId: ID, originBoardId: ID, sprintPresent: BOOL },
  ),
  "jira.swap-sprints": write(
    "Swap the native positions of two reviewed sprints from the same origin board. expectedVisibleSprintIds is the complete ordered list returned to this actor, not all hidden sprints. Native listing is grouped by state then backlog position. Independently rebind both snapshots and read the entire visible order after one POST; even a visible relative swap remains unconfirmed because hidden absolute native positions are not exposed.",
    object(
      {
        ...SELECTED,
        swapSprintId: ID,
        expectedSwapSprint: SNAPSHOT,
        expectedVisibleSprintIds: {
          type: "array",
          minItems: 2,
          maxItems: 1000,
          uniqueItems: true,
          items: ID,
        },
      },
      [...REQUIRED, "swapSprintId", "expectedSwapSprint", "expectedVisibleSprintIds"],
    ),
    { sprintId: ID, originBoardId: ID, swapSprintId: ID },
  ),
  "jira.unmap-sprints": write(
    "Experimental: set synced=false for the exact reviewed sprint IDs with one PUT /sprint/unmap. This changes synchronization only, not issue membership or board assignment. The server must supply the fixed experimental opt-in. Every sprint needs an observed boolean synced flag; already-false selections are unchanged without an effect. Confirmation requires a fresh independent false flag and unchanged other metadata for every selected sprint.",
    object({ expectedActorKey: NAME, expectedSprints: SAMPLE }, [
      "expectedActorKey",
      "expectedSprints",
    ]),
    { sprintIds: IDS, sprintSynced: BOOL },
  ),
  "jira.unmap-all-sprints": write(
    "Experimental irreversible INSTANCE-WIDE cleanup, requiring explicit issue-tracker.admin authority: set synced=false for all sprints in this Jira instance. confirmInstanceWide must be true. expectedSprints is only a reviewed sample, never a complete population or a write restriction. Do not infer no-op from that sample. After one fixed PUT /sprint/unmap-all, observe those same sample flags independently but keep the overall instance result unconfirmed. No membership effect is invented.",
    object(
      {
        expectedActorKey: NAME,
        expectedSprints: SAMPLE,
        confirmInstanceWide: { type: "boolean", enum: [true] },
      },
      ["expectedActorKey", "expectedSprints", "confirmInstanceWide"],
    ),
    { sprintIds: IDS, sprintSynced: BOOL, allSprints: { type: "boolean", enum: [true] } },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraSprintLifecycleDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_SPRINT_LIFECYCLE_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
