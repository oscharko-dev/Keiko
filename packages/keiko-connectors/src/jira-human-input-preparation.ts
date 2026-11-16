import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  JiraHumanInputCustodyError,
  type JiraHumanInputCustody,
} from "./jira-human-input-custody.js";
import type { JiraHumanInputBinding } from "./jira-human-input-values.js";

/** Server-internal descriptor, never model args/approval facts. The HTTP closure alone claims it. */
export interface JiraHumanInputSelection {
  readonly requestId: string;
  readonly revision: string;
  readonly binding: JiraHumanInputBinding;
}
function requireActiveInput(signal: AbortSignal): void {
  if (signal.aborted) throw new JiraHumanInputCustodyError("cancelled");
}
function readySelection(
  custody: JiraHumanInputCustody,
  current: JiraHumanInputView,
  binding: JiraHumanInputBinding,
): JiraHumanInputSelection {
  if (current.state !== "ready")
    throw new JiraHumanInputCustodyError(
      current.state === "expired" || current.state === "cancelled" ? current.state : "not-ready",
    );
  const original = custody.bindingFor(current.requestId, binding.principalDigest);
  if (original === undefined) throw new JiraHumanInputCustodyError("binding-changed");
  return { requestId: current.requestId, revision: current.revision, binding: original };
}
/** Existing Chat/Coding held call owns persistence and cancellation; this creates no new task. */
export async function prepareJiraHumanInput(
  custody: JiraHumanInputCustody,
  binding: JiraHumanInputBinding,
  publish: (view: JiraHumanInputView) => void | Promise<void>,
  signal: AbortSignal,
  /** The composing diagnostic owner is body-free and does not throw. */
  reportCleanupFailure: (error: unknown) => void,
): Promise<JiraHumanInputSelection> {
  const prepared = custody.prepare(binding);
  try {
    await publish(prepared);
    requireActiveInput(signal);
    const current = await custody.wait(prepared.requestId, binding, signal, reportCleanupFailure);
    if (current === undefined) throw new JiraHumanInputCustodyError("not-ready");
    if (current.state !== prepared.state || current.revision !== prepared.revision)
      await publish(current);
    requireActiveInput(signal);
    return readySelection(custody, current, binding);
  } catch (error) {
    try {
      custody.cancel(prepared.requestId, binding);
    } catch (cleanupError) {
      reportCleanupFailure(cleanupError);
    }
    throw error;
  }
}
