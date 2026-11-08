import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { JiraHumanInputCustodyError, type JiraHumanInputCustody } from "./jira-human-input-custody.js";
import type { JiraHumanInputBinding } from "./jira-human-input-values.js";

/** Server-internal descriptor, never model args/approval facts. The HTTP closure alone claims it. */
export interface JiraHumanInputSelection {
  readonly requestId: string;
  readonly revision: string;
  readonly binding: JiraHumanInputBinding;
}
/** Existing Chat/Coding held call owns persistence and cancellation; this creates no new task. */
export async function prepareJiraHumanInput(
  custody: JiraHumanInputCustody,
  binding: JiraHumanInputBinding,
  publish: (view: JiraHumanInputView) => void | Promise<void>,
  signal: AbortSignal,
  cleanupFailed: (error: unknown) => void,
): Promise<JiraHumanInputSelection> {
  const prepared = custody.prepare(binding);
  try {
    await publish(prepared);
    if (signal.aborted) throw new JiraHumanInputCustodyError("cancelled");
    const current = prepared.state === "awaiting-input"
      ? await custody.wait(prepared.requestId, binding, signal)
      : custody.inspect(prepared.requestId, binding);
    if (current === undefined) throw new JiraHumanInputCustodyError("not-ready");
    if (current.state !== prepared.state || current.revision !== prepared.revision) await publish(current);
    if (signal.aborted) throw new JiraHumanInputCustodyError("cancelled");
    if (current.state !== "ready")
      throw new JiraHumanInputCustodyError(current.state === "expired" || current.state === "cancelled" ? current.state : "not-ready");
    const original = custody.bindingFor(current.requestId, binding.principalDigest);
    if (original === undefined) throw new JiraHumanInputCustodyError("binding-changed");
    return { requestId: current.requestId, revision: current.revision, binding: original };
  } catch (error) {
    try { custody.cancel(prepared.requestId, binding); }
    catch (cleanupError) { cleanupFailed(cleanupError); }
    throw error;
  }
}
