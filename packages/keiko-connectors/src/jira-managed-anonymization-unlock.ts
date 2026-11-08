import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraPrivateIdentityPorts } from "./jira-private-identity-ports.js";
import { projectJiraAnonymizationTaskSnapshot } from "./jira-managed-anonymization-reads.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import {
  anonymizationUnlockInput,
  type UnlockFailure as Failure,
  type UnlockInput,
  type UnlockAttempt,
  type JiraAnonymizationUnlockReceipt,
} from "./jira-anonymization-unlock-values.js";
export { isJiraAnonymizationUnlock } from "./jira-anonymization-unlock-values.js";

const refused = (
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
): Failure => ({ ok: false, reason, detail: { messages: [message] } });
function knownReceipt(input: UnlockInput): JiraAnonymizationUnlockReceipt | undefined {
  const task = input.expectedTask;
  return typeof task.userKey === "string" &&
    typeof task.executingNode === "string" &&
    typeof task.submittedTime === "string"
    ? Object.freeze({
        actorUserKey: input.actor,
        userKey: task.userKey,
        executingNode: task.executingNode,
        anonymizationSubmittedTime: task.submittedTime,
      })
    : undefined;
}
async function admit(
  input: UnlockInput,
  request: JiraMutationRequest,
): Promise<Failure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return { ok: false, reason: actor.reason };
  // Unlock is global. A historical taskId selector could verify the wrong task and is never used.
  const response = await request("user/anonymization/progress", "GET", undefined, "json");
  if (!response.ok) return { ok: false, reason: response.reason };
  const snapshot =
    response.status === 200 ? projectJiraAnonymizationTaskSnapshot(response.body) : undefined;
  if (snapshot === undefined)
    return refused(
      "Jira did not supply a complete readable current anonymization task and executing node. Read current progress again; missing facts and cluster OFFLINE are not evidence of process shutdown.",
      "unavailable",
    );
  return canonicalise(snapshot) === canonicalise(input.expectedTask)
    ? undefined
    : refused(
        "The current native anonymization task, owner node or observed progress changed. Review the full current task again; an earlier shutdown statement cannot authorize a different task.",
        "conflict",
      );
}
async function unlock(
  ports: JiraPrivateIdentityPorts,
  input: UnlockInput,
  receipt: JiraAnonymizationUnlockReceipt,
): Promise<AtlassianWriteHttpOutcome> {
  try {
    return await ports.unlock(input.actor);
  } catch (error) {
    // Preserve the reviewed native task identity; the port's actor alone is not its target.
    if (error instanceof JiraAcknowledgedMutationError)
      throw new JiraAcknowledgedMutationError(error, receipt);
    throw error;
  }
}
function unlockOutcome(
  response: AtlassianWriteHttpOutcome,
  receipt: JiraAnonymizationUnlockReceipt,
): UnlockAttempt {
  const status = response.ok ? response.status : response.httpStatus;
  if (status !== undefined && status >= 200 && status < 300)
    return {
      ...refused(
        "Jira acknowledged the global stale-task unlock request. The shutdown statement was human-supplied, not an independently verified process state. Native unlock has no atomic task binding, so task removal, another task's state and global consequences remain unconfirmed. Do not replay this request.",
        "unavailable",
      ),
      receipt,
    };
  return response.ok
    ? { ok: false, reason: "malformed-payload", receipt }
    : { ok: false, reason: response.reason, receipt };
}
/** DELETE has no task selector or compare-and-swap. Human attestation supplies external shutdown
 * information, not independent process evidence; every acknowledged effect remains unconfirmed. */
export async function executeJiraAnonymizationUnlock(
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  ports: JiraPrivateIdentityPorts | undefined,
  check = false,
): Promise<UnlockAttempt> {
  const input = anonymizationUnlockInput(args);
  if (input === undefined)
    return refused(
      "Review the complete current native task snapshot and exact connected actor. Shutdown confirmation must come from the protected human-input surface, never a model Boolean, node-state guess or tool argument.",
    );
  const receipt = knownReceipt(input);
  if (receipt === undefined)
    return refused("The reviewed task has no complete native owner/identity context.");
  const initial = await admit(input, request);
  if (initial !== undefined) return initial;
  if (check) return { ok: true, receipt };
  if (ports === undefined)
    return refused(
      "A human must explicitly confirm shutdown of the exact observed executing node through the protected input for this task and authority. No protected one-use input port is available.",
      "unavailable",
    );
  // Last native task observation immediately precedes the private callback. The private HTTP
  // owner separately rechecks actor, input revision, current authority and one-use custody.
  const current = await admit(input, request);
  if (current !== undefined) return current;
  const response = await unlock(ports, input, receipt);
  return unlockOutcome(response, receipt);
}
