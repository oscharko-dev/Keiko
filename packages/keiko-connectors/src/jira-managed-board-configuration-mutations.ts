import {
  JIRA_BOARD_CONFIGURATION_MUTATIONS,
  type JiraBoardConfigurationMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { agileBoardConfiguration, agileId } from "./jira-agile-projection.js";
import type { JiraAgileRequests } from "./jira-agile-request.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor, savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

const OPERATIONS = JIRA_BOARD_CONFIGURATION_MUTATIONS;
type Operation = JiraBoardConfigurationMutation;
export interface JiraBoardConfigurationReceipt extends JiraMutationReceipt {
  /** Requested target until independently confirmed; board deletion cannot prove full absence. */
  readonly boardPresent?: boolean;
  readonly refinedVelocityEnabled?: boolean;
}
type Failure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & {
  readonly receipt?: JiraBoardConfigurationReceipt;
};
export type JiraBoardConfigurationAttempt =
  | Failure
  | {
      readonly ok: true;
      readonly receipt: JiraBoardConfigurationReceipt;
    };
interface Selection {
  readonly boardId: string;
  readonly actorKey: string;
  readonly name: string;
  readonly type: "scrum" | "kanban";
  readonly filterId: string;
}
const COMMON_FIELDS = [
  "boardId",
  "expectedActorKey",
  "expectedBoardName",
  "expectedBoardType",
  "expectedFilterId",
];
const DELETE_FIELDS = new Set(COMMON_FIELDS);
const SETTING_FIELDS = new Set([...COMMON_FIELDS, "expectedValue", "value"]);
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
function invalid(message: string): Failure {
  return { ok: false, reason: "field-validation", detail: { messages: [message] } };
}
function boardIdentities(
  args: CatalogJsonObject,
): Pick<Selection, "boardId" | "filterId"> | undefined {
  if (typeof args.boardId !== "string" || typeof args.expectedFilterId !== "string")
    return undefined;
  const boardId = agileId(args.boardId);
  const filterId = agileId(args.expectedFilterId);
  return boardId === undefined || filterId === undefined ? undefined : { boardId, filterId };
}
function selection(operation: Operation, args: CatalogJsonObject): Selection | undefined {
  if (!savedExactKeys(args, operation === "jira.delete-board" ? DELETE_FIELDS : SETTING_FIELDS))
    return undefined;
  const ids = boardIdentities(args);
  if (ids === undefined) return undefined;
  if (!savedText(args.expectedActorKey, 255) || !savedText(args.expectedBoardName, 255))
    return undefined;
  if (args.expectedBoardType !== "scrum" && args.expectedBoardType !== "kanban") return undefined;
  return {
    ...ids,
    actorKey: args.expectedActorKey,
    name: args.expectedBoardName,
    type: args.expectedBoardType,
  };
}
async function bindBoard(
  selected: Selection,
  requests: Pick<JiraAgileRequests, "agile" | "issue">,
): Promise<Failure | { readonly ok: true }> {
  const actor = await readSavedActor(requests.issue, selected.actorKey);
  if (!actor.ok) return actor;
  const response = await requests.agile(
    `board/${selected.boardId}/configuration`,
    "GET",
    undefined,
    "json",
  );
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return MALFORMED;
  const board = agileBoardConfiguration(response.body);
  if (board === undefined) return MALFORMED;
  return board.id === selected.boardId &&
    board.name === selected.name &&
    board.type === selected.type &&
    board.filterId === selected.filterId
    ? { ok: true }
    : {
        ok: false,
        reason: "conflict",
        detail: {
          messages: [
            "The reviewed board identity, name, type or filter changed. Review its current configuration before requesting this change. Nothing was written.",
          ],
        },
      };
}
async function readSetting(
  request: JiraMutationRequest,
  boardId: string,
): Promise<Failure | { readonly ok: true; readonly value: boolean }> {
  const response = await request(
    `board/${boardId}/settings/refined-velocity`,
    "GET",
    undefined,
    "json",
  );
  if (!response.ok) return dispatchFailure(response);
  return response.status === 200 && typeof response.body?.value === "boolean"
    ? { ok: true, value: response.body.value }
    : MALFORMED;
}
function unconfirmed(message: string, receipt: JiraBoardConfigurationReceipt): Failure {
  return { ok: false, reason: "unavailable", detail: { messages: [message] }, receipt };
}
function acknowledgedRefusal(failure: Failure, receipt: JiraBoardConfigurationReceipt): Failure {
  return {
    ...failure,
    receipt,
    detail: {
      messages: [
        "Jira acknowledged the board change, but its actor, configuration or requested state could not be independently confirmed. The known board/filter IDs and requested state are retained. Do not replay the write.",
      ],
    },
  };
}
async function confirmSetting(
  selected: Selection,
  value: boolean,
  requests: JiraAgileRequests,
  receipt: JiraBoardConfigurationReceipt,
): Promise<JiraBoardConfigurationAttempt> {
  try {
    const phase = requests.readback();
    const board = await bindBoard(selected, phase);
    if (!board.ok) return acknowledgedRefusal(board, receipt);
    const observed = await readSetting(phase.agile, selected.boardId);
    if (!observed.ok) return acknowledgedRefusal(observed, receipt);
    return observed.value === value
      ? { ok: true, receipt }
      : unconfirmed(
          "The independent native board setting does not match the requested value. Keep the known board ID and do not replay this change.",
          receipt,
        );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
async function removeBoard(
  selected: Selection,
  requests: JiraAgileRequests,
  check: boolean,
): Promise<JiraBoardConfigurationAttempt> {
  const receipt: JiraBoardConfigurationReceipt = {
    boardId: selected.boardId,
    filterId: selected.filterId,
    userKey: selected.actorKey,
    boardPresent: false,
  };
  if (check) return { ok: true, receipt: {} };
  const response = await requests.agile(`board/${selected.boardId}`, "DELETE", undefined, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt };
  try {
    const phase = requests.readback();
    const actor = await readSavedActor(phase.issue, selected.actorKey);
    if (!actor.ok) return acknowledgedRefusal(actor, receipt);
    // A visible-board collection is permission-filtered and has no independently readable parent.
    // Neither a selected404 nor list omission proves that this board was actually removed.
    await phase.agile(`board/${selected.boardId}`, "GET", undefined, "json");
    return unconfirmed(
      "Jira acknowledged board deletion. This API cannot independently prove board absence: selected404 and visible-list omissions can also mean permission loss. The reviewed board/filter IDs remain known; boardPresent:false is only the requested target. Do not replay deletion.",
      receipt,
    );
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
async function changeSetting(
  selected: Selection,
  args: CatalogJsonObject,
  requests: JiraAgileRequests,
  check: boolean,
): Promise<JiraBoardConfigurationAttempt> {
  if (typeof args.expectedValue !== "boolean" || typeof args.value !== "boolean")
    return invalid(
      "Review the native current refined-velocity boolean and the requested boolean. Nothing was written.",
    );
  const current = await readSetting(requests.agile, selected.boardId);
  if (!current.ok) return current;
  if (current.value !== args.expectedValue)
    return {
      ok: false,
      reason: "conflict",
      detail: { messages: ["The native board setting changed after review. Nothing was written."] },
    };
  const receipt: JiraBoardConfigurationReceipt = {
    boardId: selected.boardId,
    filterId: selected.filterId,
    userKey: selected.actorKey,
    refinedVelocityEnabled: args.value,
  };
  if (current.value === args.value)
    return {
      ok: false,
      reason: "conflict",
      detail: {
        unchanged: true,
        messages: [
          "The board already has the requested refined-velocity setting. Nothing was written.",
        ],
      },
      receipt,
    };
  if (check) return { ok: true, receipt: {} };
  const response = await requests.agile(
    `board/${selected.boardId}/settings/refined-velocity`,
    "PUT",
    { value: args.value },
    "none",
  );
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt };
  return confirmSetting(selected, args.value, requests, receipt);
}
export { isJiraBoardConfigurationMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
/** Two fixed native board effects; no filter mutation, arbitrary setting key, URL or replay. */
export async function executeJiraBoardConfigurationMutation(
  operation: Operation,
  args: CatalogJsonObject,
  requests: JiraAgileRequests,
  check = false,
): Promise<JiraBoardConfigurationAttempt> {
  const selected = selection(operation, args);
  if (selected === undefined)
    return invalid(
      "Review the connected actor, exact board ID/name/type and native filter ID. Only the selected board and the one supported boolean setting may change.",
    );
  const board = await bindBoard(selected, requests);
  if (!board.ok) return board;
  return operation === "jira.delete-board"
    ? removeBoard(selected, requests, check)
    : changeSetting(selected, args, requests, check);
}
