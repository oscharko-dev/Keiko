import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraPrivateIdentityPorts } from "../../packages/keiko-connectors/src/jira-private-identity-ports.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";

export const ANONYMIZATION_UNLOCK_PROGRESS = {
  executingNode: "native-owner-node", userKey: "anonymized-target", submittedTime: "2026-11-08T12:00:00.000+0000",
  status: "RUNNING", operations: ["NATIVE_HANDLER"], isRerun: false, currentProgress: 0,
  userName: null, fullName: "Observed target", currentSubTask: "", startTime: null, finishTime: null,
  errors: {}, warnings: {}, progressUrl: "https://jira.example.invalid/context/rest/api/2/user/anonymization/progress?taskId=37",
};
export const ANONYMIZATION_UNLOCK_TASK = {
  executingNode: "native-owner-node", userKey: "anonymized-target", submittedTime: "2026-11-08T12:00:00.000+0000",
  status: "RUNNING", operations: ["NATIVE_HANDLER"], isRerun: false, currentProgress: 0,
  userName: null, fullName: "Observed target", currentSubTask: "", startTime: null, finishTime: null,
  errors: [], warnings: [],
} as const;
export const ANONYMIZATION_UNLOCK_CASE = {
  name: "jira.unlock-user-anonymization", apiRoot: "/rest/api/2", method: "DELETE", path: "/user/anonymization/unlock",
  args: { expectedActorKey: "native-actor", expectedTask: ANONYMIZATION_UNLOCK_TASK },
  receipt: { actorUserKey: "native-actor", userKey: "anonymized-target", executingNode: "native-owner-node",
    anonymizationSubmittedTime: "2026-11-08T12:00:00.000+0000" },
} as const;
/** Human attestation is supplied only by the composing private port, never args or this task DTO. */
export function anonymizationUnlockFixture() {
  let outcome: AtlassianWriteHttpOutcome = { ok: true, status: 204, body: undefined };
  let beforeProgress: ((index: number) => void) | undefined;
  let progressReads = 0;
  const progress: Record<string, unknown> = structuredClone(ANONYMIZATION_UNLOCK_PROGRESS);
  const actor: Record<string, unknown> = { key: "native-actor", name: "Native Actor" };
  const reads: string[] = []; const effects: string[] = [];
  const request: JiraMutationRequest = async (path, method) => {
    if (method !== "GET") throw new TypeError("Only private port may dispatch unlock");
    reads.push(path);
    if (path === "myself") return { ok: true, status: 200, body: { ...actor } };
    if (path !== "user/anonymization/progress") throw new TypeError("Unexpected task selector or route");
    beforeProgress?.(++progressReads);
    return { ok: true, status: 200, body: structuredClone(progress) };
  };
  const ports: JiraPrivateIdentityPorts = {
    perform: async () => { throw new TypeError("No password operation"); },
    session: async () => { throw new TypeError("No session mutation"); },
    unlock: async (expectedActorKey) => { effects.push(expectedActorKey); return outcome; },
  };
  return { request, ports, reads, effects, progress, actor,
    args: structuredClone(ANONYMIZATION_UNLOCK_CASE.args) satisfies CatalogJsonObject,
    setOutcome(value: AtlassianWriteHttpOutcome) { outcome = value; },
    onProgress(callback: (index: number) => void) { beforeProgress = callback; } };
}
