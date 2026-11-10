import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraAgileRequests, JiraAgileRequestPhase } from "./jira-agile-request.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  bindLifecycleBoard,
  bindLifecycleSelection,
  lifecycleConstraints,
  lifecycleMembershipGate,
  readLifecycleSprint,
  readVisibleSprintOrder,
} from "./jira-sprint-lifecycle-admission.js";
import {
  parseSprintLifecycleInput,
  sameSprintValue,
  sprintRefusal,
  SPRINT_MALFORMED,
  type JiraSprintLifecycleAttempt,
  type JiraSprintLifecycleReceipt,
  type SprintLifecycleInput,
  type SprintFailure,
  type SprintSnapshot,
} from "./jira-sprint-lifecycle-values.js";
export {
  JIRA_SPRINT_LIFECYCLE_MUTATIONS,
  isJiraSprintLifecycleMutation,
  type JiraSprintLifecycleMutation,
} from "./jira-sprint-lifecycle-values.js";

export interface JiraSprintLifecyclePorts {
  readonly requests: JiraAgileRequests;
  readonly templates?: JiraIssueTemplateSource;
  /** Same bounded Agile transport/custody, with server-owned X-ExperimentalApi:true only for
   * the two fixed unmap PUTs. No model headers; absence refuses before any effect. */
  readonly experimentalAgile?: JiraMutationRequest;
}
function receiptFor(input: SprintLifecycleInput): JiraSprintLifecycleReceipt {
  if (input.operation === "jira.unmap-sprints" || input.operation === "jira.unmap-all-sprints")
    return Object.freeze({
      userKey: input.expectedActorKey,
      sprintIds: Object.freeze(input.sprints.map(({ id }) => id)),
      sprintSynced: false,
      ...(input.operation === "jira.unmap-all-sprints" ? { allSprints: true as const } : {}),
    });
  const first = input.sprints[0];
  if (first === undefined)
    throw new TypeError("A parsed sprint lifecycle selection must contain a sprint");
  const base = {
    userKey: input.expectedActorKey,
    sprintId: first.id,
    originBoardId: first.originBoardId,
  };
  if (input.operation !== "jira.swap-sprints")
    return Object.freeze({ ...base, sprintPresent: input.operation !== "jira.delete-sprint" });
  const second = input.sprints[1];
  if (second === undefined) throw new TypeError("A parsed sprint swap must contain two sprints");
  return Object.freeze({ ...base, swapSprintId: second.id });
}
function unchanged(input: SprintLifecycleInput): boolean {
  if (input.operation === "jira.unmap-sprints")
    return input.sprints.every((sprint) => sprint.synced === false);
  if (input.operation !== "jira.replace-sprint" || input.replacement === undefined) return false;
  const first = input.sprints[0];
  return (
    first !== undefined &&
    Object.entries(input.replacement).every(([key, value]) => sameSprintValue(first[key], value))
  );
}
async function reviewedOrder(
  requests: JiraAgileRequestPhase,
  input: SprintLifecycleInput,
): Promise<SprintFailure | undefined> {
  if (input.operation !== "jira.swap-sprints") return undefined;
  const boardId = input.sprints[0]?.originBoardId;
  if (boardId === undefined) return SPRINT_MALFORMED;
  const observed = await readVisibleSprintOrder(requests, boardId);
  if (!observed.ok) return observed;
  return sameSprintValue(observed.value, input.expectedVisibleSprintIds)
    ? undefined
    : sprintRefusal(
        "The actor-visible board sprint order changed. Review the complete returned order again.",
        "conflict",
      );
}
interface NativeEffect {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body?: CatalogJsonObject;
}
function replaceEffect(
  input: SprintLifecycleInput,
  first: SprintLifecycleInput["sprints"][number],
): NativeEffect | undefined {
  if (input.replacement === undefined || typeof first.synced !== "boolean") return undefined;
  return {
    path: `sprint/${first.id}`,
    method: "PUT",
    body: {
      ...input.replacement,
      id: Number(first.id),
      originBoardId: Number(first.originBoardId),
      synced: first.synced,
      incompleteIssuesDestinationId:
        input.replacement.incompleteIssuesDestinationId === null
          ? null
          : Number(input.replacement.incompleteIssuesDestinationId),
    },
  };
}
function nativeEffect(input: SprintLifecycleInput): NativeEffect | undefined {
  const first = input.sprints[0];
  if (first === undefined) return undefined;
  switch (input.operation) {
    case "jira.replace-sprint":
      return replaceEffect(input, first);
    case "jira.delete-sprint":
      return { path: `sprint/${first.id}`, method: "DELETE" };
    case "jira.swap-sprints":
      return input.sprints[1] === undefined
        ? undefined
        : {
            path: `sprint/${first.id}/swap`,
            method: "POST",
            body: { sprintToSwapWith: Number(input.sprints[1].id) },
          };
    case "jira.unmap-sprints":
      return {
        path: "sprint/unmap",
        method: "PUT",
        body: { sprintIds: input.sprints.map(({ id }) => Number(id)) },
      };
    case "jira.unmap-all-sprints":
      return { path: "sprint/unmap-all", method: "PUT" };
  }
}
function unconfirmed(message: string, receipt: JiraSprintLifecycleReceipt): SprintFailure {
  return sprintRefusal(message, "unavailable", receipt);
}
async function confirmReplacement(
  requests: JiraAgileRequestPhase,
  input: SprintLifecycleInput,
  receipt: JiraSprintLifecycleReceipt,
): Promise<JiraSprintLifecycleAttempt> {
  const first = input.sprints[0];
  if (first === undefined || input.replacement === undefined)
    return { ...SPRINT_MALFORMED, receipt };
  const current = await readLifecycleSprint(requests, first.id);
  if (!current.ok) return { ...current, receipt };
  const board = await bindLifecycleBoard(requests, first.originBoardId);
  if (!board.ok) return { ...board, receipt };
  const desired = {
    ...input.replacement,
    id: first.id,
    originBoardId: first.originBoardId,
    synced: first.synced,
  };
  if (!Object.entries(desired).every(([key, value]) => sameSprintValue(current.value[key], value)))
    return sprintRefusal(
      "The independently read sprint does not prove every explicit replacement field. Missing fields are unknown, not a successful clear.",
      "conflict",
      receipt,
    );
  if (input.replacement.state === "closed" || input.replacement.autoStartStop)
    return unconfirmed(
      "The sprint fields match, but the complete implicit issue-membership effects are not proven by actor-visible issue lists. Do not repeat this acknowledged replacement.",
      receipt,
    );
  return { ok: true, receipt };
}
async function confirmDeletion(
  requests: JiraAgileRequestPhase,
  input: SprintLifecycleInput,
  receipt: JiraSprintLifecycleReceipt,
): Promise<JiraSprintLifecycleAttempt> {
  const first = input.sprints[0];
  if (first === undefined) return { ...SPRINT_MALFORMED, receipt };
  const current = await readLifecycleSprint(requests, first.id);
  if (current.ok)
    return sprintRefusal(
      "The acknowledged deletion still has a readable sprint.",
      "conflict",
      receipt,
    );
  if (current.reason !== "not-found") return { ...current, receipt };
  const board = await bindLifecycleBoard(requests, first.originBoardId);
  if (!board.ok) return { ...board, receipt };
  const order = await readVisibleSprintOrder(requests, first.originBoardId);
  if (!order.ok) return { ...order, receipt };
  if (order.value.includes(first.id))
    return sprintRefusal("The sprint is still in the visible board list.", "conflict", receipt);
  return unconfirmed(
    "The acknowledged sprint is no longer readable or in the visible board list. These scoped observations do not prove deletion or the backlog reassignment of every issue. Do not repeat the deletion.",
    receipt,
  );
}
async function confirmSwap(
  requests: JiraAgileRequestPhase,
  input: SprintLifecycleInput,
  receipt: JiraSprintLifecycleReceipt,
): Promise<JiraSprintLifecycleAttempt> {
  const bound = await bindLifecycleSelection(requests, input);
  if (!bound.ok) return { ...bound, receipt };
  const first = input.sprints[0];
  const second = input.sprints[1];
  if (first === undefined || second === undefined || input.expectedVisibleSprintIds === undefined)
    return { ...SPRINT_MALFORMED, receipt };
  const order = await readVisibleSprintOrder(requests, first.originBoardId);
  if (!order.ok) return { ...order, receipt };
  const expected = input.expectedVisibleSprintIds.map((id) => {
    if (id === first.id) {
      return second.id;
    }
    if (id === second.id) {
      return first.id;
    }
    return id;
  });
  if (!sameSprintValue(order.value, expected))
    return sprintRefusal(
      "The independently read visible board order does not show the reviewed swap. State-group ordering can also hide native position changes.",
      "conflict",
      receipt,
    );
  return unconfirmed(
    "The selected relative order is observed in this actor's complete visible board list. The API exposes no actor-independent positions for hidden sprints, so the exact native position swap remains unconfirmed. Do not repeat it.",
    receipt,
  );
}
async function confirmUnmap(
  requests: JiraAgileRequestPhase,
  input: SprintLifecycleInput,
  receipt: JiraSprintLifecycleReceipt,
): Promise<JiraSprintLifecycleAttempt> {
  const sprints = input.sprints.map((sprint): SprintSnapshot => ({ ...sprint, synced: false }));
  const bound = await bindLifecycleSelection(requests, { ...input, sprints });
  if (!bound.ok) return { ...bound, receipt };
  return input.operation === "jira.unmap-all-sprints"
    ? unconfirmed(
        "Every reviewed sprint now exposes synced=false. The reviewed sample is not a complete instance population; the irreversible instance-wide result remains unconfirmed and must not be replayed.",
        receipt,
      )
    : { ok: true, receipt };
}
async function confirm(
  requests: JiraAgileRequestPhase,
  input: SprintLifecycleInput,
  receipt: JiraSprintLifecycleReceipt,
): Promise<JiraSprintLifecycleAttempt> {
  const actor = await readSavedActor(requests.issue, input.expectedActorKey);
  if (!actor.ok) return { ...actor, receipt };
  switch (input.operation) {
    case "jira.replace-sprint":
      return confirmReplacement(requests, input, receipt);
    case "jira.delete-sprint":
      return confirmDeletion(requests, input, receipt);
    case "jira.swap-sprints":
      return confirmSwap(requests, input, receipt);
    case "jira.unmap-sprints":
    case "jira.unmap-all-sprints":
      return confirmUnmap(requests, input, receipt);
  }
}
async function writeOnce(
  ports: JiraSprintLifecyclePorts,
  input: SprintLifecycleInput,
  request: JiraMutationRequest,
): Promise<JiraSprintLifecycleAttempt> {
  const effect = nativeEffect(input);
  if (effect === undefined) return SPRINT_MALFORMED;
  const receipt = receiptFor(input);
  const response = await request(effect.path, effect.method, effect.body, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...SPRINT_MALFORMED, receipt };
  const phase = ports.requests.readback();
  try {
    return await confirm(phase, input, receipt);
  } catch (error) {
    if (phase.signal.aborted && error === phase.signal.reason)
      return { ok: false, reason: "timeout", receipt };
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
/** Fixed native effects over the existing Agile request and journal owners. Never replay ACKs. */
async function admission(
  ports: JiraSprintLifecyclePorts,
  input: SprintLifecycleInput,
): Promise<SprintFailure | undefined> {
  const constraint = lifecycleConstraints(input);
  if (constraint !== undefined) return constraint;
  const bound = await bindLifecycleSelection(ports.requests, input);
  if (!bound.ok) return bound;
  const order = await reviewedOrder(ports.requests, input);
  if (order !== undefined) return order;
  const gate = await lifecycleMembershipGate(ports.requests, input, ports.templates);
  if (!gate.ok) return gate;
  return unchanged(input)
    ? {
        ...sprintRefusal(
          "The reviewed target is already present; no request was sent.",
          "conflict",
          receiptFor(input),
        ),
        detail: {
          unchanged: true,
          messages: ["The reviewed target is already present; no request was sent."],
        },
      }
    : undefined;
}
export async function executeJiraSprintLifecycleMutation(
  operation: string,
  args: CatalogJsonObject,
  ports: JiraSprintLifecyclePorts,
  check = false,
): Promise<JiraSprintLifecycleAttempt> {
  const input = parseSprintLifecycleInput(operation, args);
  if (input === undefined)
    return sprintRefusal(
      "Use the closed sprint operation arguments and exact reviewed native snapshots. IDs must be canonical safe-integer strings; do not infer missing dates, flags or membership.",
    );
  const experimental =
    input.operation === "jira.unmap-sprints" || input.operation === "jira.unmap-all-sprints";
  const request = experimental ? ports.experimentalAgile : ports.requests.agile;
  if (request === undefined)
    return sprintRefusal(
      "The server has not admitted this documented experimental sprint operation.",
      "unavailable",
    );
  const refused = await admission(ports, input);
  if (refused !== undefined) return refused;
  if (check) return { ok: true, receipt: {} };
  const current = await bindLifecycleSelection(ports.requests, input);
  if (!current.ok) return current;
  const currentOrder = await reviewedOrder(ports.requests, input);
  return currentOrder ?? writeOnce(ports, input, request);
}
