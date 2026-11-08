import { isJiraHumanInputView, type JiraHumanInputSubmission, type JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { bffFetchJson } from "./http";
import { ApiError } from "./api";
function path(requestId: string): string {
  if (!/^jhi_[a-f0-9]{64}$/u.test(requestId)) throw new TypeError("Invalid private input request");
  return `/api/atlassian-connectors/human-inputs/${requestId}`;
}
function request(requestId: string, init: RequestInit): Promise<JiraHumanInputView> {
  return bffFetchJson(path(requestId), { ...init, cache: "no-store" }, {
    validator: (_path, value) => {
      if (!isJiraHumanInputView(value) || value.requestId !== requestId)
        throw new ApiError("CONTRACT_VALIDATION_FAILED", "The private input response could not be verified.", 502);
      return value;
    },
  });
}
export function getJiraHumanInput(requestId: string, signal?: AbortSignal): Promise<JiraHumanInputView> {
  return request(requestId, { method: "GET", ...(signal === undefined ? {} : { signal }) });
}
/** Single write, never retried. Only a state read may reconcile an uncertain response. */
export function submitJiraHumanInput(requestId: string, input: JiraHumanInputSubmission): Promise<JiraHumanInputView> {
  return request(requestId, { method: "POST", body: JSON.stringify(input) });
}
export function cancelJiraHumanInput(requestId: string): Promise<JiraHumanInputView> {
  return request(requestId, { method: "DELETE" });
}
